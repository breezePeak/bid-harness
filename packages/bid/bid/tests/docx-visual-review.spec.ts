import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BidWorkspace, DEFAULT_BID_CONFIG } from '../src/index.ts'
import { defaultDocxFormatState, formatFields } from '../src/docx-format.ts'
import {
  collectVisualSensitiveBlocks,
  DOCX_VISUAL_REVIEW_CACHE_PATH,
  reviewDocxVisualBlocks,
  type VisualReviewDecision,
  type VisualReviewModel,
  type VisualReviewAdjustments,
} from '../src/docx-visual-review.ts'

const values = defaultDocxFormatState(formatFields({ font: '宋体', bodySize: 24, headingSize: 32 })).resolved
const limits = {
  maxImageBytes: 10_000_000,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 20_000_000,
  maxImagePixels: 4_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png'] as const,
}
const signal = new AbortController().signal
const pages = async () => [{ page: 1, pageCount: 1, data: new Uint8Array([1, 2, 3]) }]
const pdf = async () => new Uint8Array([9])

async function fixture(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-visual-review-'))
  const workspace = new BidWorkspace(root, DEFAULT_BID_CONFIG)
  await mkdir(workspace.projectRoot, { recursive: true })
  return workspace
}

function reviewer(...decisions: VisualReviewDecision[]) {
  const review = vi.fn<VisualReviewModel['review']>(async () => decisions.shift() ?? { status: 'pass' as const })
  return { imageLimits: limits, review } satisfies VisualReviewModel
}

function render() {
  return vi.fn(async (adjustments: VisualReviewAdjustments) => Buffer.from(JSON.stringify(adjustments)))
}

const flowchart = (id: string, title: string) => `\`\`\`flowchart\n${JSON.stringify({
  type: 'flowchart', schema_version: 1, id, title, direction: 'TB',
  nodes: [{ id: 'N1', type: 'start', text: '开始' }, { id: 'N2', type: 'end', text: '结束' }],
  edges: [{ from: 'N1', to: 'N2' }],
})}\n\`\`\``

describe('S6 视觉敏感块审核缓存', () => {
  it('普通文字只渲染 Word，不进入页面或模型审核', async () => {
    const workspace = await fixture()
    const model = reviewer()
    const build = render()
    await reviewDocxVisualBlocks(workspace, '# 标题\n\n正文。', values, 'template-a', model, build, signal, {
      renderPdf: pdf,
      renderPages: pages,
    })
    expect(build).toHaveBeenCalledOnce()
    expect(model.review).not.toHaveBeenCalled()
  })

  it('首次流程图保存 PASS，同一联合输入第二次直接复用', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-1', '审批流程')}`
    const first = reviewer({ status: 'pass' })
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', first, render(), signal, {
      renderPdf: pdf,
      renderPages: pages,
      now: () => '2026-09-21T00:00:00.000Z',
    })
    expect(first.review).toHaveBeenCalledOnce()
    const second = reviewer()
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', second, render(), signal, {
      renderPdf: pdf,
      renderPages: pages,
    })
    expect(second.review).not.toHaveBeenCalled()
    const cache = JSON.parse(await readFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH), 'utf8')) as { entries: unknown[] }
    expect(cache.entries).toHaveLength(1)
  })

  it('内容、页面、模板或 reviewVersion 变化都不会复用旧 PASS', async () => {
    const workspace = await fixture()
    const original = `# 方案\n\n${flowchart('FLOW-1', '审批流程')}`
    await reviewDocxVisualBlocks(workspace, original, values, 'template-a', reviewer({ status: 'pass' }), render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    const changedContent = reviewer({ status: 'pass' })
    await reviewDocxVisualBlocks(workspace, `# 方案\n\n${flowchart('FLOW-1', '变更流程')}`, values, 'template-a', changedContent, render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(changedContent.review).toHaveBeenCalledOnce()
    const changedTemplate = reviewer({ status: 'pass' })
    await reviewDocxVisualBlocks(workspace, original, values, 'template-b', changedTemplate, render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(changedTemplate.review).toHaveBeenCalledOnce()

    const portrait = await collectVisualSensitiveBlocks(workspace, original, values, 'template-a')
    const landscape = await collectVisualSensitiveBlocks(workspace, original, {
      ...values,
      'page.orientation': 'landscape',
      'page.left': Number(values['page.left']) + 1,
    }, 'template-a')
    expect(landscape[0]?.inputHash).not.toBe(portrait[0]?.inputHash)

    const block = portrait[0]!
    await writeFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH), JSON.stringify({ version: 1, entries: [{
      blockId: block.blockId,
      kind: block.kind,
      inputHash: block.inputHash,
      status: 'passed',
      reviewVersion: 'visual-review-v0',
    }] }))
    const changedReview = reviewer({ status: 'pass' })
    await reviewDocxVisualBlocks(workspace, original, values, 'template-a', changedReview, render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(changedReview.review).toHaveBeenCalledOnce()
  })

  it('表格和图片只接受各自白名单调整，并在调整后重新渲染复核', async () => {
    const workspace = await fixture()
    const png = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.writeUInt32BE(1000, 16)
    png.writeUInt32BE(500, 20)
    await writeFile(join(workspace.projectRoot, 'diagram.png'), png)
    const markdown = '# 方案\n\n| 名称 | 说明 |\n| --- | --- |\n| A | B |\n\n![架构图](diagram.png)'
    const model = reviewer(
      { status: 'adjust', reason: '表格文字拥挤', adjustment: { fontScale: 0.9 } },
      { status: 'pass' },
      { status: 'adjust', reason: '图片过宽', adjustment: { scale: 0.8 } },
      { status: 'pass' },
    )
    const build = render()
    const result = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, build, signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(model.review).toHaveBeenCalledTimes(4)
    expect(build).toHaveBeenCalledTimes(3)
    expect(Object.values(result.adjustments)).toEqual(expect.arrayContaining([{ fontScale: 0.9 }, { scale: 0.8 }]))
  })

  it('一个流程图变化只重新审核该块', async () => {
    const workspace = await fixture()
    const before = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}\n\n${flowchart('FLOW-B', '流程 B')}\n\n| 项 | 值 |\n| --- | --- |\n| C | 1 |`
    const first = reviewer({ status: 'pass' }, { status: 'pass' }, { status: 'pass' })
    await reviewDocxVisualBlocks(workspace, before, values, 'template-a', first, render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(first.review).toHaveBeenCalledTimes(3)
    const second = reviewer({ status: 'pass' })
    const after = before.replace('流程 A', '流程 A 已修改')
    await reviewDocxVisualBlocks(workspace, after, values, 'template-a', second, render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(second.review).toHaveBeenCalledOnce()
    expect(second.review.mock.calls[0]?.[0].block.blockId).toBe('flowchart_FLOW-A')
  })
})
