/** 原稿精确补丁：先绑定全部节点，再修改副本；未涉及的 ZIP entry 保持原字节。 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, ImageRun } from 'docx'
import { js2xml, xml2js } from 'xml-js'
import type { PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { readDocxXml } from './docx-template.ts'
import { mergeBodyRelationships } from './docx-compose.ts'
import { docxImageDimensions } from './docx-image.ts'
import { docxAttribute, docxChildren, docxDescendants, docxNodeHash, docxNodeName, docxNodeText,
  indexDocxDocument, resolveDocxBlock, type DocxBlockRef, type DocxXmlNode } from './docx-document-index.ts'

/** 已绑定真实节点及图字节的最小原稿修改操作。 */
export type DocumentPatchOperation = { readonly block_ref: DocxBlockRef } & (
  | { readonly type: 'insert_figure'
    readonly placement: 'before' | 'after'
    readonly image: Uint8Array
    readonly title: string
    readonly caption?: string | undefined }
  | { readonly type: 'replace_figure'; readonly image: Uint8Array; readonly title: string }
  | { readonly type: 'replace_block_text'; readonly text: string }
  | { readonly type: 'insert_paragraph'; readonly placement: 'before' | 'after'; readonly text: string }
  | { readonly type: 'delete_object' })

/** 新版本中仍可追溯到原授权节点的锚点；新插入内容继承该锚点的局部权限。 */
export interface DocumentPatchAnchor {
  readonly source: DocxBlockRef
  readonly node_path: readonly number[]
  readonly node_sha256: string
  readonly kind: 'retained' | 'inserted'
}
/** 真实补丁及结构保留检查结果。 */
export interface DocumentPatchResult {
  readonly bytes: Buffer
  readonly changes: readonly { operation: number; type: DocumentPatchOperation['type']; source: DocxBlockRef }[]
  readonly anchors: readonly DocumentPatchAnchor[]
  readonly unchanged_parts: readonly { path: string; sha256: string }[]
}

const element = (name: string, attributes: Record<string, string> = {}, elements: DocxXmlNode[] = []): DocxXmlNode =>
  ({ type: 'element', name, attributes, elements })
const word = (name: string, attributes: Record<string, string> = {}, elements: DocxXmlNode[] = []) => element(`w:${name}`, attributes, elements)
const textRun = (text: string, properties?: DocxXmlNode): DocxXmlNode => word('r', {}, [
  ...properties === undefined ? [] : [structuredClone(properties)],
  word('t', { 'xml:space': 'preserve' }, [{ type: 'text', text }]),
])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const key = (ref: DocxBlockRef) => JSON.stringify([ref.part, ref.node_path, ref.node_sha256])
const plainText = (text: string) => {
  if (text.length === 0 || text.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new Error('BID_DOCX_TEXT_INVALID')
  }
}

function setAttribute(node: DocxXmlNode, local: string, value: string, fallback: string): void {
  const name = Object.keys(node.attributes ?? {}).find(name => name.split(':').at(-1) === local) ?? fallback
  node.attributes = { ...node.attributes, [name]: value }
}
function paragraphProperties(node: DocxXmlNode, keepNext = false): DocxXmlNode {
  const original = docxChildren(node, 'pPr')[0]
  const allowed = new Set(['pStyle', 'rPr', 'spacing', 'jc'])
  return word('pPr', {}, [...(original?.elements ?? []).filter(item => allowed.has(docxNodeName(item))).map(item => structuredClone(item)),
    word('keepLines'), ...keepNext ? [word('keepNext')] : []])
}
function safeTextParagraph(node: DocxXmlNode): void {
  if (docxNodeName(node) !== 'p' || docxDescendants(node, 'sectPr').length > 0
    || (node.elements ?? []).some(item => item.type === 'element' && !['pPr', 'r', 'bookmarkStart', 'bookmarkEnd', 'proofErr'].includes(docxNodeName(item)))
    || docxChildren(node, 'r').some(run => (run.elements ?? []).some(item => item.type === 'element'
      && !['rPr', 't', 'tab', 'br', 'cr'].includes(docxNodeName(item))))) {
    throw new Error('BID_DOCX_COMPLEX_TEXT_UNSUPPORTED: 该段落含字段、超链接、图形、内容控件或分节；不能整段替换或删除。可在段落旁插入。')
  }
}
function nodePaths(root: DocxXmlNode): Map<DocxXmlNode, number[]> {
  const paths = new Map<DocxXmlNode, number[]>()
  const visit = (node: DocxXmlNode, path: number[]) => {
    paths.set(node, path)
    for (const [index, child] of (node.elements ?? []).entries()) visit(child, [...path, index])
  }
  visit(root, [])
  return paths
}

function captionSequence(document: DocxXmlNode): { name: string; paragraph: DocxXmlNode; prefix: string } | undefined {
  for (const paragraph of docxDescendants(document, 'p')) {
    const instruction = docxDescendants(paragraph, 'fldSimple').map(node => docxAttribute(node, 'instr') ?? '').join(' ')
      + docxDescendants(paragraph, 'instrText').map(node => (node.elements ?? []).map(child => child.text ?? '').join('')).join('')
    const name = /\bSEQ\s+(图|Figure|figure)\b/u.exec(instruction)?.[1] ?? /\bSEQ\s+(图)(?=\s|$)/u.exec(instruction)?.[1]
    if (name !== undefined) return { name, paragraph,
      prefix: /^图\s*\d/u.test(docxNodeText(paragraph)) || name === '图' ? '图 ' : 'Figure ' }
  }
  return undefined
}

function numberCaptionFields(document: DocxXmlNode, sequence: string): void {
  let count = 0
  for (const paragraph of docxDescendants(document, 'p')) {
    const simple = docxDescendants(paragraph, 'fldSimple').filter(node =>
      (docxAttribute(node, 'instr') ?? '').trim().split(/\s+/u).slice(0, 2).join(' ') === `SEQ ${sequence}`)
    for (const field of simple) {
      const texts = docxDescendants(field, 't')
      const first = texts[0]
      if (first === undefined) throw new Error('BID_DOCX_CAPTION_FIELD_UNSUPPORTED')
      first.elements = [{ type: 'text', text: String(++count) }]
      for (const text of texts.slice(1)) text.elements = []
    }
    const instructions = docxDescendants(paragraph, 'instrText').map(node => (node.elements ?? []).map(child => child.text ?? '').join('')).join('')
    if (!instructions.trim().startsWith(`SEQ ${sequence} `) && instructions.trim() !== `SEQ ${sequence}`) continue
    let result = false
    const texts: DocxXmlNode[] = []
    for (const run of docxChildren(paragraph, 'r')) for (const node of run.elements ?? []) {
      if (docxNodeName(node) === 'fldChar') {
        const kind = docxAttribute(node, 'fldCharType')
        if (kind === 'separate') result = true
        if (kind === 'end') result = false
      } else if (result && docxNodeName(node) === 't') texts.push(node)
    }
    const first = texts[0]
    if (first === undefined) throw new Error('BID_DOCX_CAPTION_FIELD_UNSUPPORTED')
    first.elements = [{ type: 'text', text: String(++count) }]
    for (const text of texts.slice(1)) text.elements = []
  }
}

/**
 * 在原生 DOCX 中应用五类局部操作；所有锚点来自同一基线，插入不会使后续选择漂移。
 * @param bytes 原始 DOCX 字节。
 * @param ref 已授权的准确文件版本。
 * @param operations 程序绑定的操作与已通过内容检查的图片。
 * @returns 新 DOCX、逐项变更及未改动部件摘要；原件不写回。
 */
export async function patchDocxDocument(bytes: Uint8Array, ref: PromptFileRef,
  operations: readonly DocumentPatchOperation[]): Promise<DocumentPatchResult> {
  if (operations.length === 0 || operations.length > 100) throw new Error('BID_DOCX_OPERATIONS_INVALID')
  const index = await indexDocxDocument(bytes, ref)
  const parts = await readDocxXml(bytes)
  if (docxDescendants(parts['word/settings.xml'] ?? {}, 'documentProtection')
    .some(node => !['0', 'false', 'off'].includes(docxAttribute(node, 'enforcement') ?? '1'))) {
    throw new Error('BID_DOCX_PROTECTED: 受保护原稿不能应用补丁。')
  }
  const document = parts['word/document.xml']
  if (document === undefined) throw new Error('BID_DOCX_BODY_REQUIRED')
  const root = docxDescendants(document, 'document')[0]
  if (root === undefined) throw new Error('BID_DOCX_BODY_REQUIRED')
  const namespace = Object.entries(root.attributes ?? {}).find(([name, value]) => name.startsWith('xmlns')
    && value.includes('wordprocessingml'))?.[1]
  if (namespace !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') {
    throw new Error('BID_DOCX_STRICT_UNSUPPORTED: 当前局部补丁只支持 Transitional WordprocessingML。')
  }
  const resolved = operations.map((operation) => {
    if (operation.block_ref.file_ref.attachmentId !== ref.attachmentId || operation.block_ref.file_ref.version !== ref.version
      || operation.block_ref.part !== 'word/document.xml') throw new Error('BID_DOCX_TARGET_VERSION_INVALID')
    const block = index.blocks.find(block => key(block.ref) === key(operation.block_ref))
    if (block === undefined || !block.writable) throw new Error('BID_DOCX_BLOCK_READ_ONLY')
    return { operation, block, ...resolveDocxBlock(document, operation.block_ref) }
  })
  for (const target of resolved.filter(target => ['delete_object', 'replace_block_text', 'replace_figure'].includes(target.operation.type))) {
    const path = target.operation.block_ref.node_path
    if (resolved.some(other => other !== target && path.length <= other.operation.block_ref.node_path.length
      && path.every((value, index) => other.operation.block_ref.node_path[index] === value))) {
      throw new Error('BID_DOCX_OPERATION_OVERLAP')
    }
  }
  const zip = await JSZip.loadAsync(bytes)
  const relations = parts['word/_rels/document.xml.rels'] ?? xml2js('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', { compact: false }) as DocxXmlNode
  const contentTypes = parts['[Content_Types].xml']
  if (contentTypes === undefined) throw new Error('BID_DOCX_CONTENT_TYPES_REQUIRED')
  const originalPartHashes = new Map(Object.entries(parts).map(([path, node]) => [path, docxNodeHash(node)]))
  const untouched = new Map<DocxXmlNode, { own: string; children: DocxXmlNode[] }>()
  const affected = new Set(resolved.map(item => item.node))
  const ownHash = (node: DocxXmlNode) => docxNodeHash({ ...node, elements: [] })
  const originalPaths = nodePaths(document)
  for (const node of originalPaths.keys()) if (!resolved.some((item) => {
    const target = originalPaths.get(item.node)
    const path = originalPaths.get(node)
    assert(target !== undefined && path !== undefined)
    return target.length <= path.length && target.every((value, index) => path[index] === value)
  })) untouched.set(node, { own: ownHash(node), children: (node.elements ?? []).filter(child => !affected.has(child)) })
  const anchors: Array<{ source: DocxBlockRef; node: DocxXmlNode; kind: 'retained' | 'inserted' }> = index.blocks
    .filter(block => block.ref.part === 'word/document.xml').map(block => ({ source: block.ref,
      node: resolveDocxBlock(document, block.ref).node, kind: 'retained' }))
  const afterCursor = new Map<DocxXmlNode, DocxXmlNode>()
  const sequence = captionSequence(document)
  let captionsAdded = false
  const usedDrawingIds = new Set(Object.values(parts).flatMap(part => docxDescendants(part, 'docPr').map(node => docxAttribute(node, 'id'))))
  let drawingId = 1
  const freshDrawingId = () => {
    while (usedDrawingIds.has(String(drawingId))) drawingId++
    usedDrawingIds.add(String(drawingId))
    return String(drawingId++)
  }
  let imageChanged = false
  for (const { operation, block, node, parent } of resolved) {
    if (operation.type === 'replace_block_text') {
      plainText(operation.text); safeTextParagraph(node)
      const firstRun = docxChildren(node, 'r')[0]
      const replacement = textRun(operation.text, firstRun === undefined ? undefined : docxChildren(firstRun, 'rPr')[0])
      const replaced = { inserted: false }
      node.elements = (node.elements ?? []).flatMap((child) => {
        if (docxNodeName(child) !== 'r') return [child]
        if (replaced.inserted) return []
        replaced.inserted = true; return [replacement]
      })
      if (!replaced.inserted) node.elements.push(replacement)
      continue
    }
    if (operation.type === 'delete_object') {
      if (block.kind === 'paragraph') {
        safeTextParagraph(node)
        if (docxDescendants(node, 'bookmarkStart').length || docxDescendants(node, 'bookmarkEnd').length) throw new Error('BID_DOCX_BOOKMARK_DELETE_UNSUPPORTED')
        if (docxNodeName(parent) === 'tc' && docxChildren(parent, 'p').length <= 1) throw new Error('BID_DOCX_LAST_CELL_PARAGRAPH')
      } else if (block.kind !== 'image') throw new Error('BID_DOCX_DELETE_UNSUPPORTED')
      assert(parent.elements !== undefined)
      parent.elements.splice(parent.elements.indexOf(node), 1)
      continue
    }
    let inserted: DocxXmlNode[]
    if (operation.type === 'insert_paragraph') {
      plainText(operation.text)
      if (block.kind !== 'paragraph') throw new Error('BID_DOCX_PARAGRAPH_ANCHOR_REQUIRED')
      inserted = [word('p', {}, [paragraphProperties(node), textRun(operation.text)])]
    } else {
      const dimensions = docxImageDimensions(Buffer.from(operation.image))
      if (dimensions.type !== 'png' || dimensions.width <= 0 || dimensions.height <= 0) throw new Error('BID_DOCX_IMAGE_SIZE_INVALID')
      if (block.available_width_twips === null) throw new Error('BID_DOCX_TARGET_WIDTH_UNRESOLVED')
      if (operation.type === 'insert_figure' && block.kind !== 'paragraph') throw new Error('BID_DOCX_PARAGRAPH_ANCHOR_REQUIRED')
      if (operation.type === 'replace_figure' && (block.kind !== 'image' || docxNodeName(node) !== 'drawing'
        || docxDescendants(node, 'blip').length !== 1)) throw new Error('BID_DOCX_IMAGE_INSTANCE_UNSUPPORTED')
      const existingWidth = operation.type === 'replace_figure' ? Number(docxAttribute(docxDescendants(node, 'extent')[0], 'cx')) / 9525 : Infinity
      const width = Math.max(1, Math.floor(Math.min(dimensions.width, block.available_width_twips / 15, existingWidth)))
      if (!Number.isFinite(width)) throw new Error('BID_DOCX_IMAGE_SIZE_INVALID')
      const height = Math.max(1, Math.round(width * dimensions.height / dimensions.width))
      const fragment = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({
        alignment: 'center', keepLines: true, keepNext: operation.type === 'insert_figure' && operation.caption !== undefined,
        children: [new ImageRun({ type: 'png', data: operation.image, transformation: { width: Math.round(width), height },
          altText: { name: operation.title, title: operation.title, description: operation.title } })],
      })] }] }))
      const sourceParts = await readDocxXml(fragment)
      const sourceDocument = sourceParts['word/document.xml']
      const sourceRelations = sourceParts['word/_rels/document.xml.rels']
      const sourceTypes = sourceParts['[Content_Types].xml']
      assert(sourceDocument !== undefined && sourceRelations !== undefined && sourceTypes !== undefined)
      const sourceBody = docxDescendants(sourceDocument, 'body')[0]
      assert(sourceBody !== undefined)
      const paragraph = docxChildren(sourceBody, 'p')[0]
      assert(paragraph !== undefined)
      inserted = [paragraph]
      await mergeBodyRelationships(zip, await JSZip.loadAsync(fragment), relations, sourceRelations,
        contentTypes, sourceTypes, inserted)
      for (const drawing of docxDescendants(paragraph, 'docPr')) setAttribute(drawing, 'id', freshDrawingId(), 'id')
      if (operation.type === 'replace_figure') {
        const next = docxDescendants(paragraph, 'drawing')[0]
        const blip = docxDescendants(node, 'blip')[0]
        assert(next !== undefined && blip !== undefined)
        const embed = docxAttribute(docxDescendants(next, 'blip')[0], 'embed')
        assert(embed !== undefined)
        setAttribute(blip, 'embed', embed, 'r:embed')
        blip.attributes = Object.fromEntries(Object.entries(blip.attributes ?? {}).filter(([name]) => name.split(':').at(-1) !== 'link'))
        for (const extent of [...docxDescendants(node, 'extent'), ...docxDescendants(node, 'ext')]) {
          setAttribute(extent, 'cx', String(Math.round(width * 9525)), 'cx'); setAttribute(extent, 'cy', String(height * 9525), 'cy')
        }
        for (const crop of docxDescendants(node, 'srcRect')) crop.attributes = {}
        imageChanged = true; continue
      }
      if (operation.caption !== undefined) {
        plainText(operation.caption)
        const title = operation.caption.replace(/^(?:图|figure)\s*\d+(?:[.-]\d+)*[\s:：、.．-]+/iu, '').trim()
        if (title.length === 0) throw new Error('BID_DOCX_CAPTION_TEXT_REQUIRED')
        const caption = word('p', {}, [paragraphProperties(sequence?.paragraph ?? node),
          ...sequence === undefined ? [textRun(`图：${title}`)] : [textRun(sequence.prefix),
            word('fldSimple', { 'w:instr': ` SEQ ${sequence.name} \\* ARABIC ` }, [textRun('0')]), textRun(` ${title}`)],
        ])
        inserted.push(caption)
        captionsAdded = true
      }
      imageChanged = true
    }
    const placement = operation.placement
    const cursor = placement === 'after' ? afterCursor.get(node) ?? node : node
    assert(parent.elements !== undefined)
    const at = parent.elements.indexOf(cursor)
    if (at < 0) throw new Error('BID_DOCX_ANCHOR_REMOVED')
    parent.elements.splice(at + (placement === 'after' ? 1 : 0), 0, ...inserted)
    const last = inserted.at(-1)
    assert(last !== undefined)
    if (placement === 'after') afterCursor.set(node, last)
    for (const added of inserted) {
      anchors.push({ source: operation.block_ref, node: added, kind: 'inserted' })
      for (const drawing of docxDescendants(added, 'drawing')) anchors.push({ source: operation.block_ref, node: drawing, kind: 'inserted' })
    }
  }
  const finalPaths = nodePaths(document)
  for (const [node, expected] of untouched) {
    const children = (node.elements ?? []).filter(child => originalPaths.has(child) && !affected.has(child))
    if (!finalPaths.has(node) || ownHash(node) !== expected.own || children.length !== expected.children.length
      || children.some((child, index) => child !== expected.children[index])) throw new Error('BID_DOCX_OUTSIDE_SCOPE_CHANGED')
  }
  if (captionsAdded && sequence !== undefined) numberCaptionFields(document, sequence.name)
  root.attributes = { ...root.attributes, 'xmlns:w': namespace }
  if (imageChanged) {
    const namespaces = { r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
      a: 'http://schemas.openxmlformats.org/drawingml/2006/main', pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture' }
    for (const [prefix, value] of Object.entries(namespaces)) {
      if (root.attributes[`xmlns:${prefix}`] !== undefined && root.attributes[`xmlns:${prefix}`] !== value) throw new Error('BID_DOCX_NAMESPACE_CONFLICT')
      root.attributes[`xmlns:${prefix}`] = value
    }
  }
  zip.file('word/document.xml', js2xml(document, { compact: false }))
  if (imageChanged) {
    if (docxNodeHash(relations) !== originalPartHashes.get('word/_rels/document.xml.rels')) zip.file('word/_rels/document.xml.rels', js2xml(relations, { compact: false }))
    if (docxNodeHash(contentTypes) !== originalPartHashes.get('[Content_Types].xml')) zip.file('[Content_Types].xml', js2xml(contentTypes, { compact: false }))
  }
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const serializedIndex = await indexDocxDocument(output, { ...ref, version: sha(output) })
  const original = await JSZip.loadAsync(bytes)
  const unchanged: Array<{ path: string; sha256: string }> = []
  for (const entry of Object.values(original.files).filter(entry => !entry.dir)) {
    if (entry.name === 'word/document.xml' || imageChanged && ['word/_rels/document.xml.rels', '[Content_Types].xml'].includes(entry.name)) continue
    const before = await entry.async('nodebuffer')
    const after = await zip.file(entry.name)?.async('nodebuffer')
    if (after === undefined || !before.equals(after)) throw new Error(`BID_DOCX_UNRELATED_PART_CHANGED: ${entry.name}`)
    unchanged.push({ path: entry.name, sha256: sha(before) })
  }
  return { bytes: output,
    changes: operations.map((operation, index) => ({ operation: index, type: operation.type, source: operation.block_ref })),
    anchors: anchors.flatMap((anchor) => {
      const path = finalPaths.get(anchor.node)
      if (path === undefined) return []
      const actual = serializedIndex.blocks.find(block => block.ref.part === 'word/document.xml'
        && JSON.stringify(block.ref.node_path) === JSON.stringify(path))
      if (actual === undefined) throw new Error('BID_DOCX_OUTPUT_ANCHOR_MISSING')
      return [{ source: anchor.source, node_path: actual.ref.node_path, node_sha256: actual.ref.node_sha256, kind: anchor.kind }]
    }), unchanged_parts: unchanged }
}
