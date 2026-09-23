/** 源码 Loader 下的同会话 Goal Round 与 Bid 恢复工具回放。 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { BidHostRuntime, BidWorkspace, BidRunCoordinator, buildBidStageTask, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { safeRecoverableBidFailure } from '../../../../packages/bid/bid/src/bid-recovery.ts'

interface Operation { runs: BidRunCoordinator }
interface HostInternals {
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
  runId = ''
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
    if (this.requests.length === 1) yield* tool('bid_stage_inspect', { view: 'recovery' })
    else if (this.requests.length === 2) yield* tool('bid_recover_task', {
      target: 'run', run_id: this.runId, instruction: '核对原文来源并补齐缺失的项目字段。',
    })
    else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已按当前失败单元提交恢复。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 Bid Goal 回放配置')
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
  const failed = await operation.runs.start(work)
  adapter.runId = failed.runId
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(work, new Error('missing submission'), [{
    code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
  }]))
  const accepted = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'bid.goal.recovery.requested') accepted.resolve(undefined)
  }, { global: true })
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error('Goal 未提交恢复工具')), 10_000)
  try {
    await host.finishOperation(agent.session, operation)
    await Promise.race([accepted.promise, timeout.promise])
    await agent.whenIdle()
  } finally { clearTimeout(timer); off() }
  const bound = agent.session.events.find(event => event.type === 'bid.goal.bound')
  const events = agent.session.events
  const toolCalls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
  process.stdout.write(`${JSON.stringify({
    boundToInitialS2: bound?.type === 'bid.goal.bound' && bound.data.initialS2WorkId === work.workId,
    rounds: ctx.goals.get(agent)?.roundsStarted,
    goalPrompt: adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('<goal_round>'))),
    recoveryPrompt: adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('bid_stage_inspect(view="recovery")'))),
    calls: toolCalls.filter(name => name === 'bid_stage_inspect' || name === 'bid_recover_task'),
    acceptedEvents: events.filter(event => event.type === 'bid.goal.recovery.requested').length,
    startedRuns: events.filter(event => event.type === 'bid.run.started').length,
  })}\n`)
} finally { await ctx?.fiber.dispose() }
