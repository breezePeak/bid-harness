/** 源码 Loader 下验证默认失败与显式 Goal 的公共工具调用。 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { BidHostRuntime, BidWorkspace, BidRunCoordinator, buildBidStageTask, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { bidRunRecoveryEligibility, safeRecoverableBidFailure } from '../../../../packages/bid/bid/src/bid-recovery.ts'
import { BidStageExecutionError } from '../../../../packages/bid/bid/src/control-plane-contract.ts'

interface Operation { runs: BidRunCoordinator }
interface HostInternals {
  executeStageInteraction(agent: Agent, input: unknown, signal: AbortSignal): Promise<unknown>
  recoveryTasks: Set<Promise<unknown>>
  recoveryDriver: { request(agent: Agent): Promise<void> }
  beginOperation(session: Session): Operation
  prepareOperation(operation: Operation): Promise<unknown>
  finishOperation(session: Session, operation: Operation): Promise<void>
}

function tool(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

class GoalRecoveryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  goalEnabled = false
  runId = ''
  goalInspected = false
  goalCompleted = false
  goalRead = false
  explicitContinuation = false
  continueEnabled = false
  continueInspected = false
  continueStarted = false
  nativeContinuation = false
  continueAsked = false
  clarify = false
  constructor(private readonly parentId: SessionId) { super() }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.parentId) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(options)
    if (this.explicitContinuation) {
      if (this.continueEnabled && this.nativeContinuation && !this.continueAsked) {
        this.continueAsked = true
        yield* tool('ask_user_question', { questions: [{ id: 'demo', question: '在线演示还没准备好，本次标书先怎样处理？' }] })
      } else if (this.continueEnabled && !this.continueInspected) {
        this.continueInspected = true
        yield* tool('bid_stage_inspect', { view: 'recovery' })
      } else if (this.continueEnabled && !this.continueStarted) {
        this.continueStarted = true
        yield* tool('bid_resume_current_run', {})
      } else yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (this.goalEnabled && !this.goalInspected) {
      this.goalInspected = true
      yield* tool('bid_stage_inspect', { view: 'summary' })
    } else if (this.goalEnabled && !this.goalRead) {
      this.goalRead = true
      yield* tool('get_goal', {})
    } else if (this.goalEnabled && !this.goalCompleted) {
      const result = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result' && block.toolCallId === 'get_goal')
      if (result?.type !== 'tool-result') throw new Error('显式 Goal 缺少当前身份读取结果')
      const content = result.content.find(block => block.type === 'text')
      if (content?.type !== 'text') throw new Error('显式 Goal 缺少当前状态')
      const current = JSON.parse(content.text) as { goal: { id: string; revision: number } }
      this.goalCompleted = true
      yield* tool('update_goal', { action: 'complete', goal_id: current.goal.id, revision: current.goal.revision })
    } else if (this.requests.length === 1) yield* tool('bid_stage_inspect', { view: 'recovery' })
    else if (this.clarify && this.requests.length === 2) yield* tool('ask_user_question', {
      questions: [{ id: 'demo', question: '在线演示尚未准备，本次标书先怎样处理？',
        options: [{ label: '先写技术方案并配示意图，演示后续准备' }, { label: '先补齐演示资料' }] }],
    })
    else if (this.requests.length === (this.clarify ? 3 : 2)) {
      const result = options.messages.flatMap(message => message.content).findLast(block =>
        block.type === 'tool-result' && block.toolCallId === 'ask_user_question')
      const reply = result?.type === 'tool-result' ? result.content.find(block => block.type === 'text') : undefined
      const answer = reply?.type === 'text' ? JSON.parse(reply.text) as { answers: Array<{ selected: string[]; custom?: string }> } : undefined
      yield* tool('bid_recover_task', { target: 'run', instruction: this.clarify
        ? `按用户回答${answer?.answers.map(item => item.custom ?? item.selected.join('；')).join('；') ?? '缺少回答'}；保留演示方式要求。`
        : '核对原文来源，针对当前失败单元补齐缺失内容。' })
    }
    else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已确认当前失败状态。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 Bid Goal 回放配置')
const stale = process.argv[3] === 'stale'
const nativeContinuation = process.argv[3] === 'native-continue'
const explicitContinuation = process.argv[3] === 'continue' || nativeContinuation
const clarify = process.argv[3] === 'clarify'
let ctx: Context | undefined
try {
  ctx = await boot('bid-goal-recovery-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await checkpointBidProjectState(workspace, { workflow: { kind: 'full_bid' as const, stage: 'tender_analysis' }, status: 'ready', run: null })
  const sessionId = SessionId('bid-goal-recovery')
  const adapter = new GoalRecoveryAdapter(sessionId)
  adapter.explicitContinuation = explicitContinuation
  adapter.nativeContinuation = nativeContinuation
  adapter.clarify = clarify
  ctx.llm.registerAdapter(['mock'], adapter)
  const asked = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>()
  let questionCount = 0
  if (clarify || nativeContinuation) ctx.userQuestions.registerProvider({ ask: () => {
    questionCount++
    asked.resolve(undefined)
    return answer.promise
  } })
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  await ctx.plugin(BidHostRuntime)
  const host = ctx.bid as unknown as HostInternals
  const payload = { stage: 'tender_analysis' }
  const inputs = buildBidStageTask('tender_analysis').inputs.map(path => ({ path, sha256: null }))
  const work = await persistBidWorkRequest(workspace, { kind: 'stage_execution', stage: 'tender_analysis' }, payload,
    { stage: 'tender_analysis', inputs, payload })
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const initial = await operation.runs.start(work)
  let failed = initial
  if (process.env.DSH_BID_RECOVERY_STAGE === 'outline_generation'
    || process.env.DSH_BID_RECOVERY_STAGE === 'evidence_mapping') {
    await operation.runs.complete(initial, () => {
      agent.session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    })
    const payload = { stage: 'outline_generation' }
    const inputs = buildBidStageTask('outline_generation').inputs.map(path => ({ path, sha256: null }))
    const outlineWork = await persistBidWorkRequest(workspace, { kind: 'stage_execution', stage: 'outline_generation' }, payload,
      { stage: 'outline_generation', inputs, payload })
    failed = await operation.runs.start(outlineWork)
    if (process.env.DSH_BID_RECOVERY_STAGE === 'evidence_mapping') {
      await operation.runs.complete(failed, () => {
        agent.session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
      })
      const payload = { stage: 'evidence_mapping' }
      const inputs = buildBidStageTask('evidence_mapping').inputs.map(path => ({ path, sha256: null }))
      const mappingWork = await persistBidWorkRequest(workspace, { kind: 'stage_execution', stage: 'evidence_mapping' }, payload,
        { stage: 'evidence_mapping', inputs, payload })
      failed = await operation.runs.start(mappingWork)
    }
  }
  const issues = (failed.work.kind === 'capability_task' ? null : failed.work.stage) === 'evidence_mapping' ? [{
    code: 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING', artifact: 'MAP-REPAIR-S2.1',
    message: 'Mapping Subagent 未成功调用 finish_mapping_task 完成当前任务。',
  }] : (failed.work.kind === 'capability_task' ? null : failed.work.stage) === 'outline_generation' ? [
    { code: 'OUTLINE_SHARED_WRITABLE_NOT_LEAF', artifact: 'outline/outline.json', message: '父章节不能直接写作' },
    { code: 'OUTLINE_SHARED_RESPONSE_POINT_MISSING', artifact: 'outline/outline.json', message: '叶子章节缺失响应点' },
  ] : [{
    code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
  }]
  if (stale) issues.push({ code: 'EVIDENCE_MAPPING_OUTLINE_SCOPE_STALE', artifact: 'outline/outline.json', message: '目录范围已过期。' })
  adapter.runId = failed.runId
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(failed.work, new BidStageExecutionError(issues)))
  await host.finishOperation(agent.session, operation)
  let waiting: { round: number | undefined; recoveries: number; startedRuns: number } | undefined
  if (clarify) {
    await asked.promise
    await host.recoveryDriver.request(agent)
    waiting = {
      round: agent.session.events.findLast(event => event.type === 'bid.recovery.round')?.data.round,
      recoveries: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      startedRuns: agent.session.events.filter(event => event.type === 'bid.run.started').length,
    }
    answer.resolve({ answers: [{ id: 'demo', selected: ['先写技术方案并配示意图，演示后续准备'] }] })
  }
  await agent.whenIdle()
  await Promise.allSettled(host.recoveryTasks)
  await agent.whenIdle()
  if (!stale) {
    const deadline = Date.now() + 10_000
    while (!agent.session.events.some(event => event.type === 'bid.recovery.round' && ['blocked', 'recovered', 'waiting_input'].includes(event.data.state))) {
      if (Date.now() > deadline) throw new Error('默认 Bid 纠正轮未结算')
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    await agent.whenIdle()
  }
  if (clarify) {
    const events = agent.session.events
    process.stdout.write(JSON.stringify({
      waiting, questionCount,
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      instruction: events.find(event => event.type === 'bid.recovery.requested')?.data.instruction,
      answerRecorded: events.some(event => event.type === 'user/message' && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text.includes('用户回答：先写技术方案并配示意图，演示后续准备'))),
      answerVisible: adapter.requests.some(request => request.messages.some(message => message.content.some(
        block => block.type === 'tool-result' && block.toolCallId === 'ask_user_question'
          && JSON.stringify(block.content).includes('先写技术方案并配示意图，演示后续准备')))),
      clarificationGuidance: adapter.requests.some(request => request.messages.some(message => message.content.some(
        block => block.type === 'text' && block.text.includes('先检查用户已有回答；缺少业务选择或资料时，用 ask_user_question')))),
      stageGuidance: adapter.requests.some(request => request.messages.some(message => message.content.some(
        block => block.type === 'text' && block.text.includes('不重复询问，也不只生成独立附件后把原任务留在失败状态')))),
    }) + '\n')
  } else if (explicitContinuation) {
    adapter.continueEnabled = true
    agent.followup(createUserMessage({ content: [{ type: 'text', text: nativeContinuation ? '请澄清原失败任务的业务选择。' : '继续' }],
      source: nativeContinuation ? { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice', summary: '澄清原任务业务选择' }
        : { kind: 'user' } }))
    if (nativeContinuation) {
      await asked.promise
      answer.resolve({ answers: [{ id: 'demo', selected: [], custom: '可以先生成几张图就行，后续演示这种再说了' }] })
    }
    await agent.whenIdle()
    await Promise.allSettled(host.recoveryTasks)
    await agent.whenIdle()
    await host.recoveryDriver.request(agent)
    await agent.whenIdle()
    await host.recoveryDriver.request(agent)
    await agent.whenIdle()
    const events = agent.session.events
    const runs = events.filter(event => event.type === 'bid.run.started')
    const decision = bidRunRecoveryEligibility(agent.session)
    const terminal = events.findLast(event => event.type === 'bid.recovery.round' && event.data.state === 'blocked')
    process.stdout.write(JSON.stringify({
      startedRuns: runs.length, sameWork: runs.every(event => event.data.run.work.workId === failed.work.workId),
      ...(nativeContinuation ? { questionCount, nativeAnswerAccepted: events.some(event => event.type === 'bid.recovery.requested'
        && event.data.instruction.includes('可以先生成几张图就行，后续演示这种再说了')) } : {}),
      resumeOfOriginal: runs[1]?.data.run.resumeOf?.runId === failed.runId,
      automaticEligible: decision.eligible, attempts: decision.attempts,
      automaticRound: events.findLast(event => event.type === 'bid.recovery.round')?.data.round,
      automaticBudget: events.findLast(event => event.type === 'bid.recovery.round')?.data.budget,
      currentRunReportedOnce: terminal?.type === 'bid.recovery.round' && terminal.data.target.kind === 'run'
        && terminal.data.target.runId === runs.at(-1)?.data.run.runId
        && events.filter(event => event.type === 'user/message' && String(event.data.id) === terminal.data.messageId).length === 1,
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      userMessages: events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
        ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []),
      continuationGuidance: adapter.requests.flatMap(request => request.messages.flatMap(message => message.content
        .flatMap(block => block.type === 'text' ? block.text.split('\n') : [])))
        .find(line => line.includes('新的直接用户消息明确要求继续')),
    }) + '\n')
  } else if (stale) {
    const rejected: boolean[] = []
    for (const instruction of ['重试当前任务', '换一种方法修复', '再次检查后继续']) {
      let denial: unknown
      try {
        await host.executeStageInteraction(agent, {
          action: 'bid_recover_task', target: 'run', run_id: failed.runId, instruction,
        }, new AbortController().signal)
      } catch (error) { denial = error }
      rejected.push(denial instanceof Error && denial.message.includes('目录范围已过期'))
    }
    process.stdout.write(`${JSON.stringify({ rejected,
      toolAvailable: ctx.tools.schemas(agent).some(tool => tool.name === 'bid_recover_task'),
      acceptedEvents: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      startedRuns: agent.session.events.filter(event => event.type === 'bid.run.started').length,
    })}\n`)
  } else {
    const noAutomaticGoal = ctx.goals.get(agent) === undefined
    const decision = agent.session.events.some(event => event.type === 'bid.run.decision.required')
    const completed = Promise.withResolvers<undefined>()
    const off = ctx.on('goal/changed', ({ agent: changed }) => {
      if (changed === agent && ctx!.goals.get(agent)?.phase === 'complete') completed.resolve(undefined)
    }, { global: true })
    adapter.goalEnabled = true
    const command = await ctx.commands.execute(agent, '/goal 确认当前 Bid 阶段的失败状态', [], new AbortController().signal)
    if (command === undefined) throw new Error('原生 /goal 命令未注册')
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(() =>{  timeout.reject(new Error('显式 Goal 未完成')) }, 10_000)
    try {
      await Promise.race([completed.promise, timeout.promise])
      await agent.whenIdle()
    } finally { clearTimeout(timer); off() }
    const events = agent.session.events
    process.stdout.write(`${JSON.stringify({
      noAutomaticGoal, decision, phase: ctx.goals.get(agent)?.phase, rounds: ctx.goals.get(agent)?.roundsStarted,
      goalPrompt: adapter.requests.some(request => request.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('<goal_round>')))),
      stagePrompt: adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text'
        && block.text.includes('同一目标的继续或修复使用 bid_recover_task'))),
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      recoveryEvents: events.filter(event => event.type === 'bid.recovery.requested').length,
      legacyEvents: events.filter(event => event.type === 'bid.goal.bound' || event.type === 'bid.goal.recovery.requested').length,
      createGoalVisible: adapter.requests.some(request => request.tools?.some(tool => tool.name === 'create_goal')),
      startedRuns: events.filter(event => event.type === 'bid.run.started').length,
    })}\n`)
  }
} finally { await ctx?.fiber.dispose() }
