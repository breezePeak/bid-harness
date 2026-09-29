/** 源码装配下验证后台执行提问由主 Agent 接管。 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { BidHostRuntime, BidWorkspace, checkpointBidProjectState, type BidRunCoordinator } from '@deepseek-ai/dsh-bid'

interface Operation { readonly session: Session; readonly runs: BidRunCoordinator }
interface HostInternals {
  beginOperation(session: Session): Operation
  prepareOperation(operation: Operation): Promise<unknown>
  executionAgent(operation: Operation, stage: 'evidence_mapping'): Promise<Agent>
  finishOperation(session: Session, operation: Operation): Promise<void>
}

class QuestionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly mainId: SessionId) { super() }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.mainId) throw new Error('后台 Agent 不应等待模型请求')
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '我会先判断是否真的需要用户确认。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 Bid 回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-execution-question-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'ready', run: null })
  const mainId = SessionId('bid-execution-question-main')
  const adapter = new QuestionAdapter(mainId)
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent: main } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: mainId, agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  await ctx.plugin(BidHostRuntime)
  const host = ctx.bid as unknown as HostInternals
  const operation = host.beginOperation(main.session)
  await host.prepareOperation(operation)
  const execution = await host.executionAgent(operation, 'evidence_mapping')
  await operation.runs.start({ kind: 'stage_execution', workId: 'execution-question-work',
    stage: 'evidence_mapping', requestRef: 'requests/execution-question-work.json',
    requestSha256: '0'.repeat(64), inputFingerprint: '0'.repeat(64) })
  let providerCalls = 0
  ctx.userQuestions.registerProvider({
    async ask() { providerCalls += 1; return { answers: [] } },
  })
  const result = await ctx.tools.execute({
    agent: execution, name: 'ask_user_question',
    arguments: { questions: [{ id: 'directory_restructure', question: '是否现在启动目录编辑任务？' }] },
    callId: CallId('execution-question'), signal: new AbortController().signal,
  })
  await host.finishOperation(main.session, operation)
  await main.whenIdle()
  const notices = main.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin' && event.data.source.form === 'notice'
    && event.data.source.summary === 'Bid 执行失败，交由主 Agent 处理')
  const suspended = main.session.events.findLast(event => event.type === 'bid.run.suspended')
  process.stdout.write(`${JSON.stringify({
    denied: result.isError && JSON.stringify(result).includes('BID_EXECUTION_QUESTION_REQUIRES_MAIN_AGENT'),
    providerCalls,
    notices: notices.length,
    runSuspended: suspended?.type === 'bid.run.suspended' && suspended.data.run.cause === 'executor_error',
    questionSaved: suspended?.type === 'bid.run.suspended' && suspended.data.run.error?.issues?.some(issue =>
      issue.code === 'BID_EXECUTION_QUESTION_REQUIRES_MAIN_AGENT' && issue.message.includes('是否现在启动目录编辑任务？')),
    mainSawQuestion: adapter.requests.some(request => request.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('是否现在启动目录编辑任务？')))),
    mainReplied: main.session.deriveMessages().some(message => message.role === 'assistant'
      && message.content.some(block => block.type === 'text' && block.text.includes('我会先判断'))),
  })}\n`)
} finally { await ctx?.fiber.dispose() }
