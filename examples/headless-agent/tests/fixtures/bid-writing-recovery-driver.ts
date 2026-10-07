/** 无密钥 Loader 应用回放：真实 Host 执行职责冲突恢复与损坏格式结算。 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  BidWorkspace, buildBidStageTask, checkpointBidProjectState, createTestBidRunContext,
  executeChapterWriting, parseWritingPlan, readBidProjectState,
} from '@deepseek-ai/dsh-bid'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chapterContentSha256 } from '../../../../packages/bid/bid/src/chapter-revision.ts'
import { ChapterAdapter } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-adapter.ts'
import { writeInputs } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-inputs.ts'
import { registerIntegrationTools } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { scriptedVerificationCall } from '../../../../packages/bid/bid/tests/fixtures/task-verifier.ts'
import type { WritingRequest } from '../../../../packages/bid/bid/src/writing-requirements.ts'

function tool(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

class WritingRecoveryAdapter extends LlmAdapter {
  readonly chapter = new ChapterAdapter()
  readonly mainRequests: GenerateOptions[] = []
  constructor(private readonly mainId: SessionId, private readonly scenario: string) { super() }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const verification = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('核验输入：'))
    if (verification?.type === 'text') {
      const input = JSON.parse(verification.text.slice(verification.text.indexOf('核验输入：') + '核验输入：'.length)) as Parameters<typeof scriptedVerificationCall>[0]
      const call = scriptedVerificationCall(input, options.messages)
      yield* tool(call.name, call.args).map(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
        ? { ...chunk, block: { ...chunk.block, id: CallId('verification') } } : chunk)
      return
    }
    if (options.sessionId !== this.mainId) {
      const prompt = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (prompt.includes('Relation Planning') || prompt.includes('Document Global Compliance Review') || prompt.includes('Final Document Review')) {
        if (!prompt.includes('Relation Planning')) this.chapter.requests.set('parent', { role: 'plan', tools: [], steps: 2 })
        yield* this.chapter.stream({ ...options, sessionId: SessionId('parent') })
      } else yield* this.chapter.stream(options)
      return
    }
    this.mainRequests.push(options)
    const last = options.messages.at(-1)?.source
    if (this.scenario.startsWith('saved-')) {
      if (this.mainRequests.length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: this.scenario.slice('saved-'.length), message: '暂态计划请求故障' } } }
      } else if (this.mainRequests.length === 2) {
        yield* tool('bid_recover_task', { target: 'writing_plan', instruction: '复用已保存的实施要求，重新提交失败的计划步骤。' })
      } else if (this.mainRequests.length === 3) {
        yield* tool('bid_stage_inspect', { view: 'task_contract_context' })
      } else if (this.mainRequests.length === 4) {
        const result = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result' && block.toolCallId === 'bid_stage_inspect')
        if (result?.type !== 'tool-result') throw new Error('保存要求恢复缺少实际计划上下文')
        const content = result.content.find(block => block.type === 'text')
        if (content?.type !== 'text') throw new Error('保存要求恢复缺少实际对象表')
        const input = JSON.parse(content.text) as { objects: { sections: { position: number; label: string }[] }
          task_contract_context: { blueprint: { sections: { title: string; writable: boolean }[] } } }
        yield* tool('bid_confirm_writing_plan', { update_kind: 'initial', user_message_positions: [],
          global_instructions: ['重点说明实施步骤。'], document_acceptance: [],
          sections: input.task_contract_context.blueprint.sections.filter(section => section.writable).map(section => ({
            section_position: input.objects.sections.find(item => item.label === section.title)!.position,
            task: `编写 ${section.title}`, user_message_positions: [], writing_instructions: ['重点说明实施步骤。'], acceptance_criteria: [],
          })) })
      } else yield* answer('已保存的实施要求已用于实际写作计划。')
    } else if (this.scenario === 'corrupt-format') {
      yield* answer('格式配置已损坏，页数核验被阻断；需要修复该配置后再继续。')
    } else if (this.mainRequests.length === 1) {
      yield* answer('我已看到职责冲突。')
    } else if (this.mainRequests.length === 2) {
      yield* tool('bid_stage_inspect', { view: 'recovery' })
    } else if (this.mainRequests.length === 3) {
      delete this.chapter.reviewSummary
      yield* tool('bid_recover_task', { target: 'run', instruction: '保留已确认职责，重新核验原候选的职责分配及审批意见。' })
    } else if (last?.kind === 'plugin' && last.form === 'notice' && last.summary?.startsWith('bid-result:')) {
      yield* answer('已读取正式结果；原审批意见已核验完成。')
    } else yield* answer('Host 已接纳恢复，等待实际核验结果。')
  }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 25_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`)
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 Bid 写作恢复回放配置')
const scenario = process.env.DSH_BID_WRITING_RECOVERY_SCENARIO ?? 'assignment-conflict'
let ctx: Context | undefined
try {
  ctx = await boot('bid-writing-recovery-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  const outline = await writeInputs(workspace)
  await workspace.import([{ name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('已核验的项目实施参考资料。') }])
  registerIntegrationTools(ctx, process.cwd(), [])
  const savedRequirements = scenario.startsWith('saved-')
  if (savedRequirements) await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'))
  else {
    const seed = new ChapterAdapter()
    ctx.effect(() => ctx!.llm.registerAdapter(['seed'], seed))
    const seedAgent = ctx.agentLoop.create(SessionId('parent'), { provider: 'seed', model: 'mock' }, { cwd: process.cwd() })
    await executeChapterWriting(seedAgent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1, maxConcurrency: 1, run: createTestBidRunContext(),
    })
  }
  const bodyPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const beforeBody = savedRequirements ? '' : await readFile(bodyPath, 'utf8')
  const manifestPath = join(workspace.projectRoot, 'chapters/manifest.json')
  const beforeManifest = savedRequirements ? '' : await readFile(manifestPath, 'utf8')
  if (scenario === 'corrupt-format') {
    const planPath = join(workspace.projectRoot, 'chapters/writing-plan.json')
    const plan = parseWritingPlan(JSON.parse(await readFile(planPath, 'utf8')))
    await writeFile(planPath, JSON.stringify({ ...plan, document_acceptance: [{ id: 'AC-000005', scope: { kind: 'document' },
      description: '必须得到有效页数', priority: 'required', evaluator: { kind: 'deterministic', metric: 'estimated_pages', min: 0, max: null } }] }))
    await mkdir(join(workspace.projectRoot, 'word-export'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'word-export/default.config.json'), '{损坏')
  }
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: savedRequirements ? 'waiting_user' : 'completed', run: null })
  const mainId = SessionId('bid-writing-recovery-main')
  const adapter = new WritingRecoveryAdapter(mainId, scenario)
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], adapter))
  let questions = 0
  ctx.effect(() => ctx!.userQuestions.registerProvider({ ask: async ({ questions: items }) => {
    questions++
    if (!savedRequirements) throw new Error('执行故障不应创建用户问题')
    return { answers: [{ id: items[0]!.id, selected: [], custom: '重点说明实施步骤。' }] }
  } }))
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: mainId, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  const host = ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }>; recoveryTasks: Set<Promise<unknown>> }
  await until(() => agent.session.events.some(event => event.type === 'bid.project.resumed') && host.inFlight.size === 0, '项目恢复并释放操作锁')
  if (savedRequirements) {
    await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
    const requestPath = join(workspace.projectRoot, 'chapters/writing-request.json')
    await until(async () => (JSON.parse(await readFile(requestPath, 'utf8')) as WritingRequest).state === 'consumed', '原回答生成计划')
    await until(() => host.inFlight.size === 0 && host.recoveryTasks.size === 0, '实际写作结算')
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const request = JSON.parse(await readFile(requestPath, 'utf8')) as WritingRequest
    await writeFile(join(process.cwd(), 'recovery-snapshot.json'), JSON.stringify({ mainId, reviewerIds: [] }))
    process.stdout.write(`${JSON.stringify({ questions, noGoal: ctx.get('goals') === undefined,
      requestState: request.state, answer: request.answer?.custom,
      planIncludesAnswer: (await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')).includes('重点说明实施步骤。'),
      originalFailure: agent.session.events.some(event => event.type === 'bid.writing_entry.changed' && event.data.view.error?.code === scenario.slice('saved-'.length)),
      recoveryRequests: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      confirmCalls: agent.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'bid_confirm_writing_plan').length,
      startedRuns: agent.session.events.filter(event => event.type === 'bid.run.started').length,
      roundStates: agent.session.events.filter(event => event.type === 'bid.recovery.round').map(event => event.data.state),
      planVersion: parseWritingPlan(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8'))).plan_version,
      finalStatus: (await readBidProjectState(workspace))?.status,
    })}\n`)
  } else {
    const instruction = scenario === 'corrupt-format' ? '重新审核整书页数。' : '核对本章职责并改进措辞。'
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: instruction }] })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const authorization = { session_id: String(agent.id), message_id: String(message.id) }
    let failed: { status: string; failure?: unknown }
    if (scenario === 'assignment-conflict') {
      const added = await ctx.bid.addRevisionIssue(agent.session, { section_id: 'SEC-1', scope: 'chapter',
        reference: { scope: 'chapter', base_content_sha256: chapterContentSha256(beforeBody) }, instruction, suggestion: null })
      if (!added.ok) throw new Error(JSON.stringify(added))
      const issue = added.value.issues[0]!
      adapter.chapter.reviewSummary = { assignment_conflicts: [{ task: '职责重复', basis: '当前任务与第二章职责重叠',
        related_section_positions: [outline.sections.findIndex(section => section.id === 'SEC-2')] }] }
      failed = await ctx.bid.runCapabilityTask(agent, { goal: instruction, issue_ids: [issue.issue_id],
        scope: { kind: 'sections', section_ids: ['SEC-1'] }, steps: [{ description: '修订当前章', scope: { source: 'task' },
          call: { capability: 'chapter.revision_batch', input: { issue_ids: [issue.issue_id], tasks: [{
            task_id: 'task-1', section_id: 'SEC-1', issue_ids: [issue.issue_id], depends_on: [],
          }] } } }] }, authorization, ['chapters/execution-log.json'])
    } else {
      failed = await ctx.bid.runCapabilityTask(agent, { goal: instruction, scope: { kind: 'project' }, steps: [{
        description: instruction, scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: instruction } },
      }] }, authorization, ['chapters/execution-log.json'])
    }
    const bodyPreservedAtFailure = await readFile(bodyPath, 'utf8') === beforeBody
    await until(() => agent.session.events.some(event => event.type === 'bid.recovery.round'
    && event.data.state === (scenario === 'assignment-conflict' ? 'recovered' : 'blocked')), '恢复结算')
    await agent.whenIdle()
    await until(() => host.inFlight.size === 0 && host.recoveryTasks.size === 0, 'Host 释放')
    await ctx.sessions.flush(agent.session)
    const starts = agent.session.events.filter(event => event.type === 'bid.run.started')
    const first = starts[0]!, last = starts.at(-1)!
    const rounds = agent.session.events.filter(event => event.type === 'bid.recovery.round')
    const reviewerIds = [...adapter.chapter.requests.entries()].filter(([, value]) => value.role === 'review').map(([id]) => id)
    await writeFile(join(process.cwd(), 'recovery-snapshot.json'), JSON.stringify({ mainId, reviewerIds }))
    process.stdout.write(`${JSON.stringify({
      initial: failed, questions, noGoal: ctx.get('goals') === undefined, bodyPreservedAtFailure,
      finalStatus: (await readBidProjectState(workspace))?.status,
      bodyPreservedAfterSettlement: await readFile(bodyPath, 'utf8') === beforeBody,
      manifestPreservedAfterSettlement: await readFile(manifestPath, 'utf8') === beforeManifest,
      startedRuns: starts.length, sameWork: last.data.run.work.workId === first.data.run.work.workId,
      resumedOriginal: last.data.run.resumeOf?.runId === first.data.run.runId,
      rounds: rounds.map(event => [event.data.round, event.data.state]),
      calls: agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      recoveryRequests: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      completedNotices: agent.session.events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed').length,
      revisionStatuses: scenario === 'assignment-conflict' ? (await ctx.bid.getRevisionQueue(agent.session)).issues.map(issue => issue.status) : [],
    })}\n`)
  }
} finally { await ctx?.fiber.dispose() }
