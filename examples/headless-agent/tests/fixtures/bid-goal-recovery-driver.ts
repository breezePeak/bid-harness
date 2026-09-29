/** 源码 Loader 下验证默认失败与显式 Goal 的公共工具调用。 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { BidHostRuntime, BidWorkspace, BidRunCoordinator, buildBidStageTask, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { safeRecoverableBidFailure } from '../../../../packages/bid/bid/src/bid-recovery.ts'
import { BidStageExecutionError } from '../../../../packages/bid/bid/src/control-plane-contract.ts'

interface Operation { runs: BidRunCoordinator }
interface HostInternals {
  executeStageInteraction(agent: Agent, input: unknown, signal: AbortSignal): Promise<unknown>
  recoveryTasks: Set<Promise<unknown>>
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
  goalRef: { id: string; revision: number } | undefined
  runId = ''
  goalInspected = false
  goalCompleted = false
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
    if (this.goalRef !== undefined && !this.goalInspected) {
      this.goalInspected = true
      yield* tool('bid_stage_inspect', { view: 'summary' })
    } else if (this.goalRef !== undefined && !this.goalCompleted) {
      this.goalCompleted = true
      yield* tool('update_goal', { action: 'complete', goal_id: this.goalRef.id, revision: this.goalRef.revision })
    } else if (this.requests.length === 1) yield* tool('bid_stage_inspect', { view: 'recovery' })
    else if (this.requests.length === 2) yield* tool('bid_recover_task', {
      target: 'run', run_id: this.runId, instruction: '核对原文来源，针对当前失败单元补齐缺失内容。',
    })
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
let ctx: Context | undefined
try {
  ctx = await boot('bid-goal-recovery-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'ready', run: null })
  const sessionId = SessionId('bid-goal-recovery')
  const adapter = new GoalRecoveryAdapter(sessionId)
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  await ctx.plugin(BidHostRuntime)
  const host = ctx.bid as unknown as HostInternals
  const payload = { stage: 'tender_analysis' }
  const inputs = buildBidStageTask('tender_analysis').inputs.map(path => ({ path, sha256: null }))
  const work = await persistBidWorkRequest(workspace, 'stage_execution', 'tender_analysis', payload,
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
    const outlineWork = await persistBidWorkRequest(workspace, 'stage_execution', 'outline_generation', payload,
      { stage: 'outline_generation', inputs, payload })
    failed = await operation.runs.start(outlineWork)
    if (process.env.DSH_BID_RECOVERY_STAGE === 'evidence_mapping') {
      await operation.runs.complete(failed, () => {
        agent.session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
      })
      const payload = { stage: 'evidence_mapping' }
      const inputs = buildBidStageTask('evidence_mapping').inputs.map(path => ({ path, sha256: null }))
      const mappingWork = await persistBidWorkRequest(workspace, 'stage_execution', 'evidence_mapping', payload,
        { stage: 'evidence_mapping', inputs, payload })
      failed = await operation.runs.start(mappingWork)
    }
  }
  const issues = failed.work.stage === 'evidence_mapping' ? [{
    code: 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING', artifact: 'MAP-REPAIR-S2.1',
    message: 'Mapping Subagent 未成功调用 finish_mapping_task 完成当前任务。',
  }] : failed.work.stage === 'outline_generation' ? [
    { code: 'OUTLINE_SHARED_WRITABLE_NOT_LEAF', artifact: 'outline/outline.json', message: '父章节不能直接写作' },
    { code: 'OUTLINE_SHARED_RESPONSE_POINT_MISSING', artifact: 'outline/outline.json', message: '叶子章节缺失响应点' },
  ] : [{
    code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
  }]
  if (stale) issues.push({ code: 'EVIDENCE_MAPPING_OUTLINE_SCOPE_STALE', artifact: 'outline/outline.json', message: '目录范围已过期。' })
  adapter.runId = failed.runId
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(failed.work, new BidStageExecutionError(issues)))
  await host.finishOperation(agent.session, operation)
  await agent.whenIdle()
  await Promise.allSettled(host.recoveryTasks)
  await agent.whenIdle()
  if (stale) {
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
    const command = await ctx.commands.execute(agent, '/goal 确认当前 Bid 阶段的失败状态', [], new AbortController().signal)
    if (command === undefined) throw new Error('原生 /goal 命令未注册')
    adapter.goalRef = ctx.goals.get(agent)
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
      stagePrompt: adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('真实失败状态'))),
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      recoveryEvents: events.filter(event => event.type === 'bid.recovery.requested').length,
      legacyEvents: events.filter(event => event.type === 'bid.goal.bound' || event.type === 'bid.goal.recovery.requested').length,
      createGoalVisible: adapter.requests.some(request => request.tools?.some(tool => tool.name === 'create_goal')),
      startedRuns: events.filter(event => event.type === 'bid.run.started').length,
    })}\n`)
  }
} finally { await ctx?.fiber.dispose() }
