/** 真实 Loader 回放挂起 S5 的视觉策略命令与 work 日志。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, checkpointBidProjectState, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readBidChapterCommandJournal } from '../../../../packages/bid/bid/src/chapter-command-journal.ts'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S5 策略回放配置')
class PolicyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private called = false

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (!this.called) {
      this.called = true
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('snapshot-s5-skip'),
        name: 'bid_set_flowchart_visual_review', argumentsDelta: '{"policy":"skip"}',
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: '当前 S5 work 已设置跳过后续流程图视觉检查。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let ctx: Context | undefined
try {
  ctx = await boot('bid-flowchart-policy-snapshot', configPath)
  const adapter = new PolicyAdapter()
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], adapter))
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  const work = await persistBidWorkRequest(workspace, 'stage_execution', 'chapter_writing', { stage: 'chapter_writing' }, {})
  await checkpointBidProjectState(workspace, {
    stage: 'chapter_writing', status: 'suspended',
    run: {
      runId: 'snapshot-s5-run', epoch: 1, baseProjectRevision: 0, work,
      startedAt: 0, updatedAt: 0, cause: 'executor_error', error: { message: '等待恢复' },
    },
  })
  const resumed = Promise.withResolvers<void>()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === 's5-policy-session' && event.type === 'bid.project.resumed') resumed.resolve()
  }, { global: true })
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('s5-policy-session'),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: workspace.root, agentPreset: 'bid' },
  })
  try {
    await resumed.promise
  } finally { off() }
  const agent = handle.agent
  const tool = ctx.tools.schemas(agent).find(item => item.name === 'bid_set_flowchart_visual_review')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '继续，不用视觉检查' }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const journal = await readBidChapterCommandJournal(workspace, work.workId)
  const saved = await readBidProjectState(workspace)
  process.stdout.write(`${JSON.stringify({
    parameters: tool?.parameters,
    modelSawTool: adapter.requests.some(request => request.tools?.some(item => item.name === 'bid_set_flowchart_visual_review')),
    modelSawRule: adapter.requests.some(request => request.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('先调用 bid_set_flowchart_visual_review')))),
    toolCallLogged: agent.session.events.some(event => event.type === 'tool/call'
      && event.data.name === 'bid_set_flowchart_visual_review'),
    command: journal[0] === undefined ? null : { status: journal[0].status, command: journal[0].command },
    sameWork: saved?.run?.work.workId === work.workId,
    stillSuspended: saved?.status === 'suspended',
  })}\n`)
} finally { await ctx?.fiber.dispose() }
