/** 真实 Loader 回放固定 Word 页面中的表格定位与视觉模型输入。 */
import { readFile } from 'node:fs/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readDocxFormat } from '../../../../packages/bid/bid/src/docx-format-store.ts'
import { collectVisualSensitiveBlocks, createDocxVisualReviewer } from '../../../../packages/bid/bid/src/docx-visual-review.ts'
import { renderPdfReviewPages } from '../../../../packages/bid/bid/src/pdf-page-render.ts'
import { seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const provider = 'visual-snapshot'
class VisualAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.messages.flatMap(message => message.content).filter(block => block.type === 'image').length !== 3) {
      throw new Error('表格视觉审核没有取得目标页及相邻页')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"status":"pass"}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = await boot('bid-docx-visual-snapshot', process.argv[2]!)
try {
  await ctx.plugin(LocalAttachmentStore)
  ctx.effect(() => ctx.llm.registerAdapter([provider], new VisualAdapter()))
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
  const ready = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === 'visual-review' && event.type === 'bid.project.resumed') ready.resolve(undefined)
  }, { global: true })
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('visual-review'),
    agentOptions: { provider, model: provider }, meta: { cwd: process.cwd(), agentPreset: 'bid' } })
  await ready.promise
  off()
  const session = handle.agent.session
  session.append('request/header', { header: { config: { provider, model: provider } }, reason: 'initial' })
  const markdown = '# 目标表\n\n| 复核、关闭条件 | 首接与分析 | 响应、处理与阶段反馈口径 | 项目 内容 负责人 |\n'
    + '| --- | --- | --- | --- |\n| 一般协调问题 | 驻场登记 | 升级路径 | 内容 |\n'
  const view = await readDocxFormat(workspace, null)
  const [block] = await collectVisualSensitiveBlocks(workspace, markdown, view.values, '固定页面模板')
  if (block === undefined) throw new Error('未识别固定页面中的目标表')
  const reviewer = createDocxVisualReviewer(ctx, session)
  const pdf = new Uint8Array(await readFile(new URL('../../../../packages/bid/bid/tests/fixtures/table-page-anchors.pdf', import.meta.url)))
  const pages = await renderPdfReviewPages(pdf, block.anchor, 0, 1, reviewer.imageLimits, new AbortController().signal)
  const decision = await reviewer.review({ block, pages })
  const request = session.events.findLast(event => event.type === 'bid.visual-review.request')
  if (request?.type !== 'bid.visual-review.request') throw new Error('视觉模型输入没有持久事件')
  const text = request.data.messages[0]?.content.find(item => item.type === 'text')
  await ctx.sessions.flush(session)
  process.stdout.write(`${JSON.stringify({ decision, kind: block.kind, anchor: block.anchor,
    pages: pages.map(page => page.page), pageCount: pages[0]?.pageCount,
    prompt: text?.type === 'text' ? text.text : null,
    imageCount: request.data.messages.flatMap(message => message.content).filter(item => item.type === 'image').length,
    loggedRequest: true,
  })}\n`)
} finally { await ctx.fiber.dispose() }
