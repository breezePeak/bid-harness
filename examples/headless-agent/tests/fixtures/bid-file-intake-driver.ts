/** 真实源码 Loader 将损坏 DOCX 接入结算为 S1 失败，并接受下一批上传。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  BID_INITIAL_TASK_STATE, BidWorkspace, getBidClientProjection, readBidProjectState, reduceBidTaskState,
} from '@deepseek-ai/dsh-bid'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** S1 接入由程序执行；主 Agent 的阻断说明固定外部模型回复。 */
class FileIntakeAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DOCX 解析失败，请重新上传可正常打开的招标文件。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S1 文件接入回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-file-intake-snapshot', configPath)
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], new FileIntakeAdapter()))
  const initialized = Promise.withResolvers<undefined>()
  const sessionId = SessionId('s1-parse-failure')
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'bid.project.resumed') initialized.resolve(undefined)
  }, { global: true })
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  await initialized.promise
  off()
  const host = ctx.bid as unknown as { readonly inFlight: Map<string, { done: Promise<void> }> }
  await Promise.all([...host.inFlight.values()].map(operation => operation.done))
  const session = handle.agent.session
  const bytes = Buffer.from('not a zip archive', 'utf8')
  const outcomes = []
  const locksReleased = []
  const actions = []
  for (const name of ['broken.docx', 'retry.docx']) {
    const replied = Promise.withResolvers<undefined>()
    const stop = ctx.on('session/event', (current, event) => {
      if (current === session && event.type === 'turn/end') replied.resolve(undefined)
    }, { global: true })
    outcomes.push(await ctx.bid.uploadFiles(session, [{
      name, role: 'tender', size: bytes.byteLength, data: bytes.toString('base64'),
    }]))
    await replied.promise
    stop()
    await handle.agent.whenIdle()
    locksReleased.push(host.inFlight.size === 0)
    actions.push(getBidClientProjection(session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)).allowedActions)
  }
  await ctx.sessions.flush(session)
  const starts = session.events.filter(event => event.type === 'bid.run.started')
  const workspace = new BidWorkspace(process.cwd())
  const saved = await readBidProjectState(workspace)
  process.stdout.write(`${JSON.stringify({
    outcomes, locksReleased, actions,
    runs: {
      count: starts.length,
      distinct: new Set(starts.map(event => event.data.run.runId)).size === starts.length,
      stages: starts.map(event => event.data.run.work.stage),
      kinds: starts.map(event => event.data.run.work.kind),
    },
    failures: session.events.flatMap(event => event.type === 'bid.task.changed' && event.data.state.status === 'failed'
      ? [event.data.state] : []),
    notices: session.events.filter(event => event.type === 'bid.run.notice').map(event => ({
      stage: event.data.stage, kind: event.data.kind, severity: event.data.severity, message: event.data.message,
    })),
    task: session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
    durableTask: saved === undefined ? null : { stage: saved.stage, status: saved.status, run: saved.run },
    files: (await workspace.readManifest()).files.map(file => ({
      name: file.originalName, role: file.role, parseStatus: file.parseStatus, parseError: file.parseError,
      inputPath: file.inputPath, documentPath: file.documentPath, chunkIndexPath: file.chunkIndexPath,
    })),
    replies: session.events.filter(event => event.type === 'assistant/message')
      .map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')),
  })}\n`)
} finally { await ctx?.fiber.dispose() }
