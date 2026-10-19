/** 使用真实视觉模型检查固定 PDF 页面及其实际输出预算。 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { createDocxVisualReviewer } from '../../../packages/bid/bid/src/docx-visual-review.ts'
import { renderPdfReviewPages } from '../../../packages/bid/bid/src/pdf-page-render.ts'

const enabled = !!process.env.DSH_BID_EVAL_PROVIDER
  || !!process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_VISION_E2E === '1'

it.skipIf(!enabled)('真实视觉模型沿用模型预算完成 Word 页面复核', { timeout: 180_000, retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bid-docx-visual-real-'))
  const ctx = new Context()
  try {
    const home = process.env.DSH_BID_EVAL_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { dshHome: home, watch: false })
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
    const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'
    const model = process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash-vision-exp'
    await ctx.plugin(provider === 'deepseek-official' ? DeepSeek : PiAi, {})
    await ctx.plugin(SessionStore)
    await ctx.plugin(AttachmentLocal, { dshHome: join(root, '.dsh') })
    const session = ctx.sessions.create()
    session.append('request/header', { header: { config: { provider, model } }, reason: 'initial' })
    const reviewer = createDocxVisualReviewer(ctx, session)
    const pdf = await readFile(new URL('../../../packages/bid/bid/tests/fixtures/table-page-anchors.pdf', import.meta.url))
    const anchor = ['复核关闭', '首接与分', '响应处理', '项目内容', '一般协调', '驻场登记', '升级路径', '内容']
    const signal = AbortSignal.timeout(150_000)
    const pages = await renderPdfReviewPages(pdf, anchor, 0, 1, reviewer.imageLimits, signal)
    const decision = await reviewer.review({ block: { blockId: 'table-real-budget', kind: 'table', anchor,
      inputHash: `sha256:${createHash('sha256').update(pdf).digest('hex')}`, boundary: 'within-page' }, pages })
    expect(['pass', 'adjust']).toContain(decision.status)
    const request = session.events.findLast(event => event.type === 'bid.visual-review.request')!
    expect(request.data.maxTokens).toBeGreaterThan(512)
    await writeFile(join(root, '验收记录.json'), JSON.stringify({ provider, model, maxTokens: request.data.maxTokens,
      pages: pages.map(page => page.page), decision, status: 'passed' }, null, 2) + '\n')
  } finally { await ctx.fiber.dispose() }
})
