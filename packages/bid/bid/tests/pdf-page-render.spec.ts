import { readFile } from 'node:fs/promises'
import { beforeAll, expect, it } from 'vitest'
import { renderPdfReviewPages } from '../src/pdf-page-render.ts'

const limits = { maxImageBytes: 100_000, maxImagesPerMessage: 3, maxMessageImageBytes: 300_000,
  maxImagePixels: 40_000, maxImageDimension: 200, mediaTypes: ['image/png'] as const }
const signal = new AbortController().signal
let pdf: Uint8Array
beforeAll(async () => {
  pdf = new Uint8Array(await readFile(new URL('./fixtures/table-page-anchors.pdf', import.meta.url)))
})

it('表格列文字读取顺序不同且有换行时，按多个独立片段定位实际页面', async () => {
  const pages = await renderPdfReviewPages(pdf, ['首接与分析', '响应处理', '复核关闭', '一般协调'], 0, 100, limits, signal)
  expect(pages.map(page => page.page)).toEqual([3, 4, 5])
})

it('重复表头时以目标行片段最多的页面定位，而不选前一张同表头表格', async () => {
  const pages = await renderPdfReviewPages(pdf, ['项目', '内容', '负责人', '驻场登记', '升级路径'], 0, 100, limits, signal)
  expect(pages.map(page => page.page)).toEqual([3, 4, 5])
})

it('目标表未找到时拒绝猜页，不把其他表交给模型', async () => {
  await expect(renderPdfReviewPages(pdf, ['问题等级', '不存在的首接分析', '不存在的升级路径'], 1, 3, limits, signal))
    .rejects.toThrow('PDF_VISUAL_TABLE_ANCHOR_NOT_FOUND')
})

it('普通文字锚点仍定位连续文字，找不到时保留顺序定位', async () => {
  expect((await renderPdfReviewPages(pdf, '前一节流程图', 0, 10, limits, signal)).map(page => page.page)).toEqual([2, 3, 4])
  expect((await renderPdfReviewPages(pdf, '无文本图片', 2, 5, limits, signal)).map(page => page.page)).toEqual([2, 3, 4])
})
