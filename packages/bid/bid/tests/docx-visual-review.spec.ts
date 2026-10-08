import { createHash } from 'node:crypto'
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
  type VisualReviewState,
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
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

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

  it('同版 Word 的多个视觉块共用一次 PDF 转换，每个块仍定位页面并审核', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}\n\n${flowchart('FLOW-B', '流程 B')}\n\n| 项 | 值 |\n| --- | --- |\n| C | 1 |`
    const model = reviewer()
    const renderedPdf = new Uint8Array([9])
    const convert = vi.fn(async () => renderedPdf)
    const locate = vi.fn(async (_bytes: Uint8Array) => pages())
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, render(), signal, {
      renderPdf: convert, renderPages: locate,
    })
    expect(convert).toHaveBeenCalledOnce()
    expect(locate).toHaveBeenCalledTimes(3)
    expect(model.review).toHaveBeenCalledTimes(3)
    expect(locate.mock.calls.map(call => call[0])).toEqual([renderedPdf, renderedPdf, renderedPdf])
  })

  it('首次流程图保存 PASS，第二次渲染页面相同才复用模型结论', async () => {
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
    const convert = vi.fn(pdf)
    const locate = vi.fn(pages)
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', second, render(), signal, {
      renderPdf: convert,
      renderPages: locate,
    })
    expect(second.review).not.toHaveBeenCalled()
    expect(convert).toHaveBeenCalledOnce()
    expect(locate).toHaveBeenCalledOnce()
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
    await writeFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH), JSON.stringify({ version: 2, entries: [{
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
    const convert = vi.fn(async (bytes: Buffer) => new Uint8Array(bytes))
    const locate = vi.fn(async (bytes: Uint8Array) => [{ page: 1, pageCount: 1, data: bytes }])
    const result = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, build, signal, {
      renderPdf: convert, renderPages: locate,
    })
    expect(model.review).toHaveBeenCalledTimes(5)
    expect(build).toHaveBeenCalledTimes(3)
    expect(convert).toHaveBeenCalledTimes(3)
    expect(locate.mock.calls.map(call => Buffer.from(call[0]).toString('utf8'))).toEqual([
      JSON.stringify({}),
      JSON.stringify({ [model.review.mock.calls[0]![0].block.blockId]: { fontScale: 0.9 } }),
      JSON.stringify({ [model.review.mock.calls[0]![0].block.blockId]: { fontScale: 0.9 } }),
      JSON.stringify(result.adjustments),
      JSON.stringify(result.adjustments),
    ])
    expect(Object.values(result.adjustments)).toEqual(expect.arrayContaining([{ fontScale: 0.9 }, { scale: 0.8 }]))
  })

  it('一个流程图变化而其他块最终页面仍相同时复用其他块结论', async () => {
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

  it('图表前正文变化使当前页面变化时不能复用该块 PASS', async () => {
    const workspace = await fixture()
    const before = `# 方案\n\n短正文。\n\n${flowchart('FLOW-A', '流程 A')}`
    const after = before.replace('短正文。', '扩展正文。'.repeat(100))
    const convert = async (bytes: Buffer) => new Uint8Array(bytes)
    // 这里只验证缓存和分页调度；页面字节由确定性替身提供，不代表视觉效果验收。
    const locate = async (bytes: Uint8Array) => [{ page: bytes.length > 500 ? 2 : 1, pageCount: 2, data: bytes }]
    await reviewDocxVisualBlocks(workspace, before, values, 'template-a', reviewer(), async () => Buffer.from(before), signal, {
      renderPdf: convert, renderPages: locate,
    })
    const second = reviewer()
    await reviewDocxVisualBlocks(workspace, after, values, 'template-a', second, async () => Buffer.from(after), signal, {
      renderPdf: convert, renderPages: locate,
    })
    expect(second.review).toHaveBeenCalledOnce()
    expect(second.review.mock.calls[0]?.[0].pages[0]?.page).toBe(2)
  })

  it('修改 A 推动 B 换页时同时复核 B', async () => {
    const workspace = await fixture()
    const before = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}\n\n${flowchart('FLOW-B', '流程 B')}`
    const after = before.replace('流程 A', '流程 A 扩展')
    const convert = async (bytes: Buffer) => new Uint8Array(bytes)
    const locate = async (bytes: Uint8Array, _anchor: unknown, index: number) => [{
      page: index === 1 && Buffer.from(bytes).toString('utf8').includes('扩展') ? 2 : 1,
      pageCount: 2, data: bytes,
    }]
    await reviewDocxVisualBlocks(workspace, before, values, 'template-a', reviewer(), async () => Buffer.from(before), signal, {
      renderPdf: convert, renderPages: locate,
    })
    const second = reviewer()
    await reviewDocxVisualBlocks(workspace, after, values, 'template-a', second, async () => Buffer.from(after), signal, {
      renderPdf: convert, renderPages: locate,
    })
    expect(second.review.mock.calls.map(call => call[0].block.blockId)).toEqual(['flowchart_FLOW-A', 'flowchart_FLOW-B'])
    expect(second.review.mock.calls[1]?.[0].pages[0]?.page).toBe(2)
  })

  it('后检查块修正改变先检查块页面时回到先块复核', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}\n\n${flowchart('FLOW-B', '流程 B')}`
    const model = reviewer(
      { status: 'pass' },
      { status: 'adjust', reason: '流程 B 过宽', adjustment: { scale: 0.8 } },
      { status: 'pass' },
      { status: 'pass' },
    )
    const result = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, render(), signal, {
      renderPdf: async bytes => new Uint8Array(bytes),
      renderPages: async bytes => [{ page: 1, pageCount: 1, data: bytes }],
    })
    expect(model.review.mock.calls.map(call => call[0].block.blockId)).toEqual([
      'flowchart_FLOW-A', 'flowchart_FLOW-B', 'flowchart_FLOW-A', 'flowchart_FLOW-B',
    ])
    expect(Buffer.from(model.review.mock.calls[2]![0].pages[0]!.data)).toEqual(result.bytes)
    expect(result.outputHash).toBe(hash(result.bytes))
    expect(result.reviews).toHaveLength(2)
    const cache = JSON.parse(await readFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH), 'utf8')) as { entries: VisualReviewState[] }
    for (const review of result.reviews) {
      expect(review.status).toBe('passed')
      expect(review.documentHash).toBe(result.outputHash)
      expect(review.outputHash).toMatch(/^sha256:[a-f\d]{64}$/u)
      expect(cache.entries.find(entry => entry.blockId === review.blockId)).toEqual(review)
    }
  })

  it('DOCX 字节变化但视觉输入真正相同时复用结论并绑定新字节摘要', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}`
    const first = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', reviewer(), async () => Buffer.from('docx-metadata-a'), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    const secondModel = reviewer()
    const second = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', secondModel, async () => Buffer.from('docx-metadata-b'), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    expect(secondModel.review).not.toHaveBeenCalled()
    expect(second.outputHash).not.toBe(first.outputHash)
    expect(second.outputHash).toBe(hash(second.bytes))
    expect(second.reviews[0]?.outputHash).toBe(first.reviews[0]?.outputHash)
    expect(second.reviews[0]?.documentHash).toBe(second.outputHash)
  })

  it.each([{ page: 2, pageCount: 2 }, { page: 1, pageCount: 2 }])('相同 PNG 的页码或总页数变化也使结论失效：%j', async (changed) => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}`
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', reviewer(), render(), signal, {
      renderPdf: pdf, renderPages: pages,
    })
    const model = reviewer()
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, render(), signal, {
      renderPdf: pdf, renderPages: async () => [{ ...changed, data: new Uint8Array([1, 2, 3]) }],
    })
    expect(model.review).toHaveBeenCalledOnce()
  })

  it('相同页面图片仍按模板、表格样式和页面几何变化重新审核', async () => {
    const workspace = await fixture()
    const markdown = '# 方案\n\n| 项 | 值 |\n| --- | --- |\n| A | B |'
    const model = reviewer()
    const options = { renderPdf: pdf, renderPages: pages }
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, render(), signal, options)
    await reviewDocxVisualBlocks(workspace, markdown, values, 'template-b', model, render(), signal, options)
    await reviewDocxVisualBlocks(workspace, markdown, { ...values, 'table.width': 90 }, 'template-b', model, render(), signal, options)
    await reviewDocxVisualBlocks(workspace, markdown, { ...values, 'table.width': 90, 'page.left': Number(values['page.left']) + 1 }, 'template-b', model, render(), signal, options)
    expect(model.review).toHaveBeenCalledTimes(4)
  })

  it('历史调整只在当前调整后的页面相同时复用', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}`
    const model = reviewer({ status: 'adjust', reason: '图片过宽', adjustment: { scale: 0.8 } }, { status: 'pass' })
    const options = {
      renderPdf: async (bytes: Buffer) => new Uint8Array(bytes),
      renderPages: async (bytes: Uint8Array) => [{ page: 1, pageCount: 1, data: bytes }],
    }
    const first = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, render(), signal, options)
    const secondModel = reviewer()
    const secondBuild = render()
    const second = await reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', secondModel, secondBuild, signal, options)
    expect(secondBuild).toHaveBeenCalledOnce()
    expect(secondBuild).toHaveBeenCalledWith(first.adjustments)
    expect(secondModel.review).not.toHaveBeenCalled()
    expect(second.outputHash).toBe(first.outputHash)
  })

  it('跨块修正往返累计各块预算，耗尽时拒绝最终导出', async () => {
    const workspace = await fixture()
    const markdown = `# 方案\n\n${flowchart('FLOW-A', '流程 A')}\n\n${flowchart('FLOW-B', '流程 B')}`
    let lastBytes = Buffer.alloc(0)
    const build = vi.fn(async (adjustments: VisualReviewAdjustments) => {
      lastBytes = Buffer.from(JSON.stringify(adjustments))
      return lastBytes
    })
    const review = vi.fn<VisualReviewModel['review']>(async (input) => {
      const applied = JSON.parse(Buffer.from(input.pages[0]!.data).toString('utf8')) as Record<string, { scale: number }>
      const a = applied['flowchart_FLOW-A']?.scale
      const b = applied['flowchart_FLOW-B']?.scale
      if (input.block.blockId === 'flowchart_FLOW-A') {
        return b === undefined || a === b
          ? { status: 'pass' }
          : { status: 'adjust', reason: 'B 调整影响 A 页面', adjustment: { scale: b } }
      }
      return { status: 'adjust', reason: 'B 仍需缩小', adjustment: { scale: b === undefined ? 0.9 : b - 0.1 } }
    })
    const model = { imageLimits: limits, review } satisfies VisualReviewModel
    await expect(reviewDocxVisualBlocks(workspace, markdown, values, 'template-a', model, build, signal, {
      renderPdf: async bytes => new Uint8Array(bytes),
      renderPages: async bytes => [{ page: 1, pageCount: 1, data: bytes }],
    })).rejects.toThrow('DOCX_VISUAL_REVIEW_FAILED:flowchart_FLOW-B')
    expect(build).toHaveBeenCalledTimes(5)
    expect(review).toHaveBeenCalledTimes(8)
    const cache = JSON.parse(await readFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH), 'utf8')) as { entries: VisualReviewState[] }
    const failed = cache.entries.find(entry => entry.blockId === 'flowchart_FLOW-B')
    expect(failed?.status).toBe('failed')
    expect(failed?.adjustment).toEqual({ scale: 0.8 })
    expect(failed?.documentHash).toBe(hash(lastBytes))
  })

  it('审核中取消不保存通过结论，也不返回可交付结果', async () => {
    const workspace = await fixture()
    const controller = new AbortController()
    const model = { imageLimits: limits, review: async (): Promise<VisualReviewDecision> => {
      controller.abort(new Error('用户停止导出'))
      return { status: 'pass' }
    } } satisfies VisualReviewModel
    await expect(reviewDocxVisualBlocks(workspace, `# 方案\n\n${flowchart('FLOW-A', '流程 A')}`, values, 'template-a', model,
      render(), controller.signal, { renderPdf: pdf, renderPages: pages })).rejects.toThrow('用户停止导出')
    await expect(readFile(join(workspace.projectRoot, DOCX_VISUAL_REVIEW_CACHE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
