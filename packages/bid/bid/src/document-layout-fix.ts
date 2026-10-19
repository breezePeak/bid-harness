/** 页面检查只允许缩放本任务的图和保持相邻图文，不改业务文字或原稿模板。 */
import JSZip from 'jszip'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { js2xml } from 'xml-js'
import { z } from 'zod'
import type { BidDocumentRecord } from './document-assets.ts'
import { documentIndexFileRef } from './document-assets.ts'
import { docxAttribute, docxChildren, docxDescendants, docxNodeName, resolveDocxBlock, indexDocxDocument } from './docx-document-index.ts'
import { readDocxXml } from './docx-template.ts'

/** 模型只能选择 Host 列出的可调整对象位置与有界视觉比例。 */
export const documentLayoutFixSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scale_figure'), block_position: z.number().int().nonnegative(), scale: z.number().min(0.5).max(0.95) }).strict(),
  z.object({ kind: z.literal('keep_with_next'), block_position: z.number().int().nonnegative() }).strict(),
])

/**
 * 从真实补丁记录收集新增图文和明确替换的图片实例。
 * @param record 当前文档的补丁来源。
 * @returns 保持原顺序的精确局部调整对象。
 */
export function documentLayoutTargets(record: BidDocumentRecord): BidDocumentRecord['anchors'] {
  return record.anchors.filter(anchor => anchor.kind === 'inserted' || record.changes.some(change =>
    change.type === 'replace_figure' && JSON.stringify(change.source) === JSON.stringify(anchor.source)))
}

/**
 * 将页面模型提出的局部调整绑定到当前文档真实节点，保留所有其他 ZIP 部件。
 * @param bytes 当前候选 DOCX。
 * @param record 当前文档来源和锚点。
 * @param fixes 模型选择的有界局部调整。
 * @returns 新字节及同源、同位置重新绑定的锚点。
 */
export async function fixDocumentLayout(bytes: Buffer, record: BidDocumentRecord,
  fixes: readonly z.infer<typeof documentLayoutFixSchema>[]): Promise<{ bytes: Buffer; anchors: BidDocumentRecord['anchors'] }> {
  const parts = await readDocxXml(bytes)
  const document = parts['word/document.xml']
  if (document === undefined) throw new Error('BID_DOCX_BODY_REQUIRED')
  const ref = documentIndexFileRef(record.ref)
  const nodes = record.anchors.map(anchor => resolveDocxBlock(document, { ...anchor.source, file_ref: ref,
    node_path: [...anchor.node_path], node_sha256: anchor.node_sha256 }).node)
  const targets = documentLayoutTargets(record)
  const seen = new Set<number>()
  for (const raw of fixes) {
    const fix = documentLayoutFixSchema.parse(raw)
    const anchor = targets[fix.block_position]
    if (anchor === undefined || seen.has(fix.block_position)) throw new Error('BID_DOCUMENT_LAYOUT_TARGET_INVALID')
    seen.add(fix.block_position)
    const node = nodes[record.anchors.indexOf(anchor)]
    assert(node !== undefined)
    if (fix.kind === 'scale_figure') {
      if (docxNodeName(node) !== 'drawing') throw new Error('BID_DOCUMENT_LAYOUT_IMAGE_REQUIRED')
      for (const extent of [...docxDescendants(node, 'extent'), ...docxDescendants(node, 'ext')]) {
        const width = Number(docxAttribute(extent, 'cx')), height = Number(docxAttribute(extent, 'cy'))
        if (!(width > 0) || !(height > 0)) throw new Error('BID_DOCUMENT_LAYOUT_SIZE_INVALID')
        extent.attributes = { ...extent.attributes, cx: String(Math.round(width * fix.scale)), cy: String(Math.round(height * fix.scale)) }
      }
    } else {
      if (docxNodeName(node) !== 'p') throw new Error('BID_DOCUMENT_LAYOUT_PARAGRAPH_REQUIRED')
      let properties = docxChildren(node, 'pPr')[0]
      if (properties === undefined) {
        properties = { type: 'element', name: 'w:pPr', elements: [] }
        node.elements = [properties, ...node.elements ?? []]
      }
      properties.elements = [...(properties.elements ?? []).filter(child => !['keepNext', 'keepLines'].includes(docxNodeName(child))),
        { type: 'element', name: 'w:keepNext' }, { type: 'element', name: 'w:keepLines' }]
    }
  }
  const zip = await JSZip.loadAsync(bytes)
  const paths = new Map<typeof document, number[]>()
  const visit = (node: typeof document, path: number[]): void => {
    paths.set(node, path)
    for (const [index, child] of (node.elements ?? []).entries()) visit(child, [...path, index])
  }
  visit(document, [])
  zip.file('word/document.xml', js2xml(document, { compact: false }))
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const actual = await indexDocxDocument(output, { ...ref, version: createHash('sha256').update(output).digest('hex') })
  return { bytes: output, anchors: record.anchors.map((anchor, index) => {
    const node = nodes[index]
    assert(node !== undefined)
    const path = paths.get(node)
    assert(path !== undefined)
    const block = actual.blocks.find(block => block.ref.part === 'word/document.xml' && JSON.stringify(block.ref.node_path) === JSON.stringify(path))
    if (block === undefined) throw new Error('BID_DOCUMENT_LAYOUT_ANCHOR_MISSING')
    return { ...anchor, node_path: block.ref.node_path, node_sha256: block.ref.node_sha256 }
  }) }
}
