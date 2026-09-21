/** PDF 页面文字定位与 PNG 渲染，供资料查看和 Word 视觉审核复用。 */
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

interface PdfCanvasSurface {
  canvas: { toBuffer(type: 'image/png'): Uint8Array }
  context: unknown
}

interface PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasSurface
  destroy(surface: PdfCanvasSurface): void
}

/** 一页 PDF 的模型输入图片。 */
export interface RenderedPdfPage {
  readonly page: number
  readonly pageCount: number
  readonly data: Uint8Array
}

async function openPdf(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const standardFontDataUrl = new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).href
  return pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl }).promise
}

/**
 * 把指定 PDF 页渲染为附件限制内的 PNG。
 * @param bytes PDF 字节。
 * @param pageNumber 一基页码。
 * @param limits 当前附件图片限制。
 * @param signal 取消信号。
 * @returns 页面 PNG 及总页数。
 */
export async function renderPdfPage(
  bytes: Uint8Array,
  pageNumber: number,
  limits: ImageAttachmentLimits,
  signal: AbortSignal,
): Promise<RenderedPdfPage> {
  signal.throwIfAborted()
  const pdf = await openPdf(bytes)
  try {
    if (pageNumber > pdf.numPages) throw new Error(`PDF 页码超出范围：该文件共 ${String(pdf.numPages)} 页。`)
    const page = await pdf.getPage(pageNumber)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(
      2,
      limits.maxImageDimension / Math.max(base.width, base.height),
      Math.sqrt(limits.maxImagePixels / (base.width * base.height)),
    )
    const viewport = page.getViewport({ scale })
    const canvasFactory = pdf.canvasFactory as unknown as PdfCanvasFactory
    const surface = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const task = page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport } as never)
    const cancel = (): void => { task.cancel() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await task.promise
      signal.throwIfAborted()
      return { data: new Uint8Array(surface.canvas.toBuffer('image/png')), page: pageNumber, pageCount: pdf.numPages }
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      page.cleanup()
      canvasFactory.destroy(surface)
    }
  } finally {
    await pdf.destroy()
  }
}

/**
 * 按页面文字查找视觉块，并返回目标页及相邻页；文字不可定位时按块顺序确定中心页。
 * @param bytes PDF 字节。
 * @param anchor 当前块的短文字锚点。
 * @param blockIndex 当前视觉块索引。
 * @param blockCount 视觉块总数。
 * @param limits 当前附件图片限制。
 * @param signal 取消信号。
 * @returns 至多三页 PNG。
 */
export async function renderPdfReviewPages(
  bytes: Uint8Array,
  anchor: string,
  blockIndex: number,
  blockCount: number,
  limits: ImageAttachmentLimits,
  signal: AbortSignal,
): Promise<RenderedPdfPage[]> {
  signal.throwIfAborted()
  const pdf = await openPdf(bytes)
  const pageCount = pdf.numPages
  let center = Math.min(pageCount, Math.max(1, Math.floor(blockIndex * pageCount / Math.max(1, blockCount)) + 1))
  const needle = anchor.normalize('NFKC').replace(/\s+/gu, '').slice(0, 48)
  try {
    if (needle !== '') {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        const page = await pdf.getPage(pageNumber)
        try {
          const text = (await page.getTextContent()).items
            .map(item => 'str' in item ? item.str : '')
            .join('')
            .normalize('NFKC')
            .replace(/\s+/gu, '')
          if (text.includes(needle)) { center = pageNumber; break }
        } finally { page.cleanup() }
      }
    }
  } finally { await pdf.destroy() }
  const pageNumbers = [...new Set([center - 1, center, center + 1])]
    .filter(page => page >= 1 && page <= pageCount)
    .slice(0, limits.maxImagesPerMessage)
  return Promise.all(pageNumbers.map(page => renderPdfPage(bytes, page, limits, signal)))
}
