/** 在原始 DOCX 包内填充可编辑表格区域并插入正文，未识别区域保持原结构。 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { js2xml, xml2js } from 'xml-js'
import type { DocxFormatInterpretation, FormatValues } from './docx-format-contract.ts'
import type { BidWorkspace } from './index.ts'
import { renderDocx } from './docx-render.ts'
import { readDocxXml } from './docx-template.ts'

interface XmlNode {
  type?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
  elements?: XmlNode[]
}

/** DOCX 模板可供程序填充的正文锚点与逻辑表格列。 */
export interface DocxTemplateStructure {
  bodyAnchor: 'content-control' | 'bookmark' | 'placeholder' | 'document-end'
  tables: Array<{
    gridColumns: number
    headers: string[]
    editableColumns: Array<{ header: string; gridStart: number; gridSpan: number }>
  }>
}

const local = (name = ''): string => name.slice(name.lastIndexOf(':') + 1)
const children = (node: XmlNode, name: string): XmlNode[] => (node.elements ?? []).filter(item => local(item.name) === name)
const child = (node: XmlNode, name: string): XmlNode | undefined => children(node, name)[0]
const descendants = (node: XmlNode, name: string): XmlNode[] => (node.elements ?? []).flatMap(item => [
  ...(local(item.name) === name ? [item] : []), ...descendants(item, name),
])
const attr = (node: XmlNode, name: string): string | undefined => Object.entries(node.attributes ?? {})
  .find(([key]) => local(key) === name)?.[1]
const text = (node: XmlNode): string => node.type === 'text' ? node.text ?? '' : (node.elements ?? []).map(text).join('')
const normalized = (value: string): string => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
const clone = <T>(value: T): T => structuredClone(value)

function parseXml(source: string, path: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error(`DOCX XML 不允许 DTD 或实体声明：${path}`)
  try { return xml2js(source, { compact: false }) as XmlNode } catch { throw new Error(`DOCX XML 无效：${path}`) }
}

async function xmlPart(zip: JSZip, path: string): Promise<XmlNode> {
  const source = await zip.file(path)?.async('string')
  if (source === undefined) throw new Error(`DOCX 缺少部件：${path}`)
  return parseXml(source, path)
}

function documentBody(document: XmlNode): XmlNode {
  const bodies = descendants(document, 'body')
  if (bodies.length !== 1) throw new Error('DOCX 正文结构无效。')
  return bodies[0] as XmlNode
}

function semanticHeader(value: string): string {
  const header = normalized(value)
  if (['投标响应内容', '响应内容', '响应情况', '应答内容', '投标响应', '技术响应'].includes(header)) return 'response'
  if (['招标技术要求', '技术条款', '招标要求', '技术要求'].includes(header)) return 'requirement'
  if (['偏离程度', '偏离说明', '偏差说明'].includes(header)) return 'deviation'
  if (['序号', '编号'].includes(header)) return 'index'
  if (['标的名称', '项目名称', '标的'].includes(header)) return 'subject'
  if (['备注', '说明'].includes(header)) return 'remark'
  return header
}

function controlNames(node: XmlNode): string[] {
  return descendants(node, 'sdtPr').flatMap(properties => ['tag', 'alias'].flatMap((name) => {
    const value = attr(child(properties, name) ?? {}, 'val')
    return value === undefined ? [] : [normalized(value)]
  }))
}

function isEditable(node: XmlNode): boolean {
  return controlNames(node).some(value => value.includes('editable') || value.includes('可编辑')
    || value.includes('填写') || value.startsWith('dshfill'))
}

function isBodyName(value: string): boolean {
  return ['body', 'dshbody', '正文', '正文插入位置', '投标正文', '技术标正文'].includes(normalized(value))
}

interface LogicalCell {
  node: XmlNode
  start: number
  span: number
  value: string
  semantic: string
}

function logicalCells(row: XmlNode, gridColumns: number): LogicalCell[] {
  let start = 0
  return children(row, 'tc').map((node) => {
    const raw = Number(attr(child(child(node, 'tcPr') ?? {}, 'gridSpan') ?? {}, 'val') ?? 1)
    const span = Number.isInteger(raw) && raw > 0 ? raw : 1
    const result = { node, start, span, value: text(node).trim(), semantic: semanticHeader(text(node)) }
    start += span
    if (gridColumns > 0 && start > gridColumns) throw new Error('DOCX 表格单元格超出 tblGrid。')
    return result
  })
}

interface TableInfo {
  node: XmlNode
  gridColumns: number
  header: LogicalCell[]
  rows: XmlNode[]
  editable: LogicalCell[]
}

interface FilledTemplateTables {
  consumed: Map<XmlNode, XmlNode>
  movedCaptions: XmlNode[]
}

function tableInfo(node: XmlNode): TableInfo | undefined {
  const rows = children(node, 'tr')
  if (rows.length === 0) return undefined
  const declaredColumns = children(child(node, 'tblGrid') ?? {}, 'gridCol').length
  const gridColumns = Math.max(declaredColumns, ...rows.map(row => logicalCells(row, 0)
    .reduce((end, cell) => Math.max(end, cell.start + cell.span), 0)))
  const header = logicalCells(rows[0] as XmlNode, gridColumns)
  const editable = header.filter(cell => isEditable(cell.node) || cell.semantic === 'response'
    || rows.slice(1).some(row => logicalCells(row, gridColumns)
      .some(candidate => candidate.start === cell.start && isEditable(candidate.node))))
  return { node, gridColumns, header, rows: rows.slice(1), editable }
}

function bodyAnchor(body: XmlNode): DocxTemplateStructure['bodyAnchor'] {
  if (descendants(body, 'sdt').some(node => controlNames(node).some(isBodyName))) return 'content-control'
  if (descendants(body, 'bookmarkStart').some(node => isBodyName(attr(node, 'name') ?? ''))) return 'bookmark'
  if (descendants(body, 'p').some(node => isBodyName(text(node)))) return 'placeholder'
  return 'document-end'
}

/**
 * 只读取模板可填写结构，不解释正文内容或修改 DOCX。
 * @param bytes 已通过上传边界保存的原始 DOCX。
 * @returns 正文锚点及按 tblGrid 展开的可编辑表格列。
 */
export async function inspectDocxTemplateStructure(bytes: Uint8Array): Promise<DocxTemplateStructure> {
  await readDocxXml(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const body = documentBody(await xmlPart(zip, 'word/document.xml'))
  return {
    bodyAnchor: bodyAnchor(body),
    tables: descendants(body, 'tbl').flatMap((table) => {
      const info = tableInfo(table)
      return info === undefined ? [] : [{
        gridColumns: info.gridColumns,
        headers: info.header.map(cell => cell.value),
        editableColumns: info.editable.map(cell => ({ header: cell.value, gridStart: cell.start, gridSpan: cell.span })),
      }]
    }),
  }
}

function cellAt(row: XmlNode, gridColumns: number, position: number): LogicalCell | undefined {
  return logicalCells(row, gridColumns).find(cell => cell.start <= position && position < cell.start + cell.span)
}

function verticalMergeContinues(cell: XmlNode): boolean {
  const merge = child(child(cell, 'tcPr') ?? {}, 'vMerge')
  return merge !== undefined && !['restart'].includes(attr(merge, 'val') ?? 'continue')
}

function textParagraph(cell: XmlNode, value: string): XmlNode[] {
  const current = descendants(cell, 'p')[0]
  const prefix = current?.name?.includes(':') ? current.name.slice(0, current.name.indexOf(':') + 1) : 'w:'
  const paragraphProperties = current === undefined ? undefined : child(current, 'pPr')
  const runProperties = current === undefined ? undefined : child(descendants(current, 'r')[0] ?? {}, 'rPr')
  return value.split(/\r?\n/u).map(line => ({
    type: 'element', name: `${prefix}p`, elements: [
      ...(paragraphProperties === undefined ? [] : [clone(paragraphProperties)]),
      ...line === '' ? [] : [{ type: 'element', name: `${prefix}r`, elements: [
        ...(runProperties === undefined ? [] : [clone(runProperties)]),
        { type: 'element', name: `${prefix}t`, attributes: { 'xml:space': 'preserve' }, elements: [{ type: 'text', text: line }] },
      ] }],
    ],
  }))
}

function textRuns(cell: XmlNode, value: string): XmlNode[] {
  const current = descendants(cell, 'r')[0]
  const prefix = current?.name?.includes(':') ? current.name.slice(0, current.name.indexOf(':') + 1) : 'w:'
  const properties = current === undefined ? undefined : child(current, 'rPr')
  const contents = value.split(/\r?\n/u).flatMap((line, index): XmlNode[] => [
    ...(index === 0 ? [] : [{ type: 'element', name: `${prefix}br` }]),
    { type: 'element', name: `${prefix}t`, attributes: { 'xml:space': 'preserve' }, elements: [{ type: 'text', text: line }] },
  ])
  return [{ type: 'element', name: `${prefix}r`, elements: [
    ...(properties === undefined ? [] : [clone(properties)]), ...contents,
  ] }]
}

function setCellText(cell: XmlNode, value: string): void {
  const content = descendants(cell, 'sdt').find(isEditable)
  const controlled = content === undefined ? undefined : child(content, 'sdtContent')
  if (controlled !== undefined) {
    controlled.elements = children(controlled, 'p').length || children(controlled, 'tbl').length
      ? textParagraph(cell, value) : textRuns(cell, value)
    return
  }
  const properties = child(cell, 'tcPr')
  cell.elements = [...(properties === undefined ? [] : [properties]), ...textParagraph(cell, value)]
}

function clearTableParagraphFirstLineIndent(body: XmlNode): void {
  for (const table of descendants(body, 'tbl')) {
    for (const paragraph of descendants(table, 'p')) {
      const prefix = paragraph.name?.includes(':') ? paragraph.name.slice(0, paragraph.name.indexOf(':') + 1) : 'w:'
      let properties = child(paragraph, 'pPr')
      if (properties === undefined) {
        properties = { type: 'element', name: `${prefix}pPr`, elements: [] }
        paragraph.elements = [properties, ...(paragraph.elements ?? [])]
      }
      let indent = child(properties, 'ind')
      if (indent === undefined) {
        indent = { type: 'element', name: `${prefix}ind`, attributes: {} }
        properties.elements = [...(properties.elements ?? []), indent]
      }
      const attributes = indent.attributes ?? {}
      const firstLine = Object.keys(attributes).find(name => local(name) === 'firstLine') ?? `${prefix}firstLine`
      const firstLineChars = Object.keys(attributes).find(name => local(name) === 'firstLineChars') ?? `${prefix}firstLineChars`
      indent.attributes = { ...attributes, [firstLine]: '0', [firstLineChars]: '0' }
    }
  }
}

function rowValues(info: TableInfo, row: XmlNode): Map<string, string> {
  return new Map(info.header.map(header => [header.semantic, cellAt(row, info.gridColumns, header.start)?.value.trim() ?? '']))
}

function matchingSourceRow(target: TableInfo, row: XmlNode, source: TableInfo, unused: Set<XmlNode>): XmlNode | undefined {
  const targetValues = rowValues(target, row)
  let best: { row: XmlNode; score: number } | undefined
  for (const candidate of unused) {
    const sourceValues = rowValues(source, candidate)
    const score = [...targetValues].filter(([semantic, value]) => semantic !== 'response' && normalized(value) !== ''
      && normalized(value) === normalized(sourceValues.get(semantic) ?? '')).length
    if (best === undefined || score > best.score) best = { row: candidate, score }
  }
  return best?.score ? best.row : undefined
}

function tableScore(target: TableInfo, source: TableInfo): number {
  if (target.editable.length === 0) return -1
  const sourceSemantics = new Set(source.header.map(cell => cell.semantic))
  const editableMatches = target.editable.filter(cell => sourceSemantics.has(cell.semantic)).length
  const shared = target.header.filter(cell => sourceSemantics.has(cell.semantic)).length
  return editableMatches === 0 ? -1 : editableMatches * 10 + shared
}

function siblingLocation(root: XmlNode, target: XmlNode): { parent: XmlNode; index: number } | undefined {
  const elements = root.elements ?? []
  const index = elements.indexOf(target)
  if (index >= 0) return { parent: root, index }
  for (const element of elements) {
    const found = siblingLocation(element, target)
    if (found !== undefined) return found
  }
  return undefined
}

function previousSibling(root: XmlNode, target: XmlNode): XmlNode | undefined {
  const location = siblingLocation(root, target)
  return location === undefined || location.index === 0 ? undefined : location.parent.elements?.[location.index - 1]
}

function insertBefore(root: XmlNode, target: XmlNode, value: XmlNode): void {
  const location = siblingLocation(root, target)
  if (location === undefined) throw new Error('DOCX 模板表格不在正文结构中。')
  location.parent.elements = [...(location.parent.elements ?? []).slice(0, location.index), value,
    ...(location.parent.elements ?? []).slice(location.index)]
}

function paragraphStyleIds(node: XmlNode): string[] {
  return children(child(node, 'pPr') ?? {}, 'pStyle').flatMap((style) => {
    const value = attr(style, 'val')
    return value === undefined ? [] : [value]
  })
}

function isTableCaptionParagraph(node: XmlNode | undefined, mapping: DocxFormatInterpretation['mapping']): node is XmlNode {
  if (node === undefined || local(node.name) !== 'p' || text(node).trim() === '') return false
  const tableCaptionStyle = mapping.tableCaption
  return paragraphStyleIds(node).some(style => style === 'DshTableCaption' || style === tableCaptionStyle)
}

function fillTemplateTables(
  templateBody: XmlNode,
  sourceElements: XmlNode[],
  mapping: DocxFormatInterpretation['mapping'],
): FilledTemplateTables {
  const targets = descendants(templateBody, 'tbl').map(tableInfo).filter((item): item is TableInfo => item !== undefined)
  const sources = sourceElements.flatMap(element => descendants({ elements: [element] }, 'tbl'))
    .map(tableInfo).filter((item): item is TableInfo => item !== undefined)
  const unusedSources = new Set(sources)
  const consumed = new Map<XmlNode, XmlNode>()
  const movedCaptions: XmlNode[] = []
  for (const target of targets) {
    const source = [...unusedSources].map(candidate => ({ candidate, score: tableScore(target, candidate) }))
      .sort((left, right) => right.score - left.score)[0]
    if (source === undefined || source.score < 0) continue
    const sourceRows = new Set(source.candidate.rows)
    for (const [index, targetRow] of target.rows.entries()) {
      const sourceRow = matchingSourceRow(target, targetRow, source.candidate, sourceRows)
        ?? source.candidate.rows[index]
      if (sourceRow === undefined || !sourceRows.has(sourceRow)) continue
      sourceRows.delete(sourceRow)
      for (const editable of target.editable) {
        const sourceHeader = source.candidate.header.find(header => header.semantic === editable.semantic)
        const targetCell = cellAt(targetRow, target.gridColumns, editable.start)
        const sourceCell = sourceHeader === undefined ? undefined
          : cellAt(sourceRow, source.candidate.gridColumns, sourceHeader.start)
        if (targetCell !== undefined && sourceCell !== undefined && !verticalMergeContinues(targetCell.node)) {
          setCellText(targetCell.node, sourceCell.value)
        }
      }
    }
    unusedSources.delete(source.candidate)
    if (sourceRows.size === 0) {
      consumed.set(source.candidate.node, target.node)
      const sourceIndex = sourceElements.indexOf(source.candidate.node)
      const sourceCaption = sourceIndex <= 0 ? undefined : sourceElements[sourceIndex - 1]
      if (isTableCaptionParagraph(sourceCaption, { tableCaption: 'DshTableCaption' })) {
        if (!isTableCaptionParagraph(previousSibling(templateBody, target.node), mapping)) {
          insertBefore(templateBody, target.node, sourceCaption)
          movedCaptions.push(sourceCaption)
        }
      }
    }
  }
  return { consumed, movedCaptions }
}

function removeConsumedBlocks(elements: XmlNode[], consumed: Map<XmlNode, XmlNode>): XmlNode[] {
  const omitted = new Set<number>()
  for (const table of consumed.keys()) {
    const index = elements.indexOf(table)
    if (index < 0) continue
    omitted.add(index)
    const caption = elements[index - 1]
    if (caption !== undefined && local(caption.name) === 'p' && children(child(caption, 'pPr') ?? {}, 'pStyle')
      .some(style => attr(style, 'val') === 'DshTableCaption')) omitted.add(index - 1)
  }
  return elements.filter((_, index) => !omitted.has(index))
}

function styleIds(styles: XmlNode): Set<string> {
  return new Set(descendants(styles, 'style').map(node => attr(node, 'styleId')).filter((value): value is string => value !== undefined))
}

function mappedStyle(value: string, mapping: DocxFormatInterpretation['mapping'], available: Set<string>): string {
  const role = value === 'Title' ? 'title' : value === 'Normal' ? 'body'
    : value === 'DshFigureCaption' ? 'figureCaption'
      : value === 'DshTableCaption' ? 'tableCaption'
        : /^Heading[1-6]$/u.test(value) ? `heading${value.slice(7)}` as keyof typeof mapping : undefined
  const candidate = role === undefined ? undefined : mapping[role]
  return candidate !== undefined && available.has(candidate) ? candidate : value
}

function remapStyles(node: XmlNode, mapping: DocxFormatInterpretation['mapping'], available: Set<string>): void {
  for (const style of descendants(node, 'pStyle')) {
    const attributes = style.attributes
    const key = Object.keys(attributes ?? {}).find(name => local(name) === 'val')
    if (attributes !== undefined && key !== undefined) attributes[key] = mappedStyle(attributes[key] ?? '', mapping, available)
  }
}

function addContentType(target: XmlNode, source: XmlNode, partName: string): void {
  const targetRoot = descendants(target, 'Types')[0]
  const sourceRoot = descendants(source, 'Types')[0]
  if (targetRoot === undefined || sourceRoot === undefined) throw new Error('DOCX Content Types 无效。')
  if (children(targetRoot, 'Override').some(node => attr(node, 'PartName') === partName)) return
  const item = children(sourceRoot, 'Override').find(node => attr(node, 'PartName') === partName)
  if (item !== undefined) targetRoot.elements = [...(targetRoot.elements ?? []), clone(item)]
}

function nextRelationshipId(relationships: XmlNode): string {
  const used = new Set(descendants(relationships, 'Relationship').map(node => attr(node, 'Id')))
  let index = 1
  while (used.has(`rId${String(index)}`)) index++
  return `rId${String(index)}`
}

function ensureDocumentRelationship(target: XmlNode, source: XmlNode, typeSuffix: string, targetPath: string): void {
  const targetRoot = descendants(target, 'Relationships')[0]
  const sourceItem = descendants(source, 'Relationship').find(node => (attr(node, 'Type') ?? '').endsWith(typeSuffix))
  if (targetRoot === undefined || sourceItem === undefined) return
  if (children(targetRoot, 'Relationship').some(node => (attr(node, 'Type') ?? '').endsWith(typeSuffix))) return
  const item = clone(sourceItem)
  const idKey = Object.keys(item.attributes ?? {}).find(name => local(name) === 'Id') ?? 'Id'
  const targetKey = Object.keys(item.attributes ?? {}).find(name => local(name) === 'Target') ?? 'Target'
  item.attributes = { ...(item.attributes ?? {}), [idKey]: nextRelationshipId(target), [targetKey]: targetPath }
  targetRoot.elements = [...(targetRoot.elements ?? []), item]
}

async function mergeStyles(
  targetZip: JSZip,
  sourceZip: JSZip,
  targetContentTypes: XmlNode,
  sourceContentTypes: XmlNode,
  targetRelationships: XmlNode,
  sourceRelationships: XmlNode,
  inserted: XmlNode[],
  mapping: DocxFormatInterpretation['mapping'],
): Promise<void> {
  const sourceStyles = await xmlPart(sourceZip, 'word/styles.xml')
  let targetStyles: XmlNode
  if (targetZip.file('word/styles.xml') === null) {
    targetStyles = clone(sourceStyles)
    addContentType(targetContentTypes, sourceContentTypes, '/word/styles.xml')
    ensureDocumentRelationship(targetRelationships, sourceRelationships, '/styles', 'styles.xml')
  } else targetStyles = await xmlPart(targetZip, 'word/styles.xml')
  const available = styleIds(targetStyles)
  for (const node of inserted) remapStyles(node, mapping, available)
  const referenced = new Set(inserted.flatMap(node => descendants(node, 'pStyle').map(item => attr(item, 'val')))
    .filter((value): value is string => value !== undefined))
  const targetRoot = descendants(targetStyles, 'styles')[0]
  for (const style of descendants(sourceStyles, 'style')) {
    const id = attr(style, 'styleId')
    if (targetRoot !== undefined && id !== undefined && referenced.has(id) && !available.has(id)) {
      targetRoot.elements = [...(targetRoot.elements ?? []), clone(style)]
      available.add(id)
    }
  }
  targetZip.file('word/styles.xml', js2xml(targetStyles, { compact: false }))
}

async function mergeNumbering(
  targetZip: JSZip,
  sourceZip: JSZip,
  targetContentTypes: XmlNode,
  sourceContentTypes: XmlNode,
  targetRelationships: XmlNode,
  sourceRelationships: XmlNode,
  inserted: XmlNode[],
): Promise<void> {
  const referenced = new Set(inserted.flatMap(node => descendants(node, 'numId').map(item => attr(item, 'val')))
    .filter((value): value is string => value !== undefined))
  if (referenced.size === 0) return
  const source = await xmlPart(sourceZip, 'word/numbering.xml')
  if (targetZip.file('word/numbering.xml') === null) {
    targetZip.file('word/numbering.xml', js2xml(source, { compact: false }))
    addContentType(targetContentTypes, sourceContentTypes, '/word/numbering.xml')
    ensureDocumentRelationship(targetRelationships, sourceRelationships, '/numbering', 'numbering.xml')
    return
  }
  const target = await xmlPart(targetZip, 'word/numbering.xml')
  const targetRoot = descendants(target, 'numbering')[0]
  if (targetRoot === undefined) throw new Error('DOCX numbering.xml 无效。')
  let nextAbstract = Math.max(-1, ...descendants(target, 'abstractNum').map(node => Number(attr(node, 'abstractNumId')))) + 1
  let nextNum = Math.max(0, ...descendants(target, 'num').map(node => Number(attr(node, 'numId')))) + 1
  const abstractMap = new Map<string, string>(), numMap = new Map<string, string>()
  for (const num of descendants(source, 'num').filter(node => referenced.has(attr(node, 'numId') ?? ''))) {
    const sourceNum = attr(num, 'numId') ?? ''
    const sourceAbstract = attr(child(num, 'abstractNumId') ?? {}, 'val') ?? ''
    let targetAbstract = abstractMap.get(sourceAbstract)
    if (targetAbstract === undefined) {
      const definition = descendants(source, 'abstractNum').find(node => attr(node, 'abstractNumId') === sourceAbstract)
      if (definition === undefined) throw new Error('DOCX 标题编号定义缺失。')
      targetAbstract = String(nextAbstract++)
      const copied = clone(definition)
      const key = Object.keys(copied.attributes ?? {}).find(name => local(name) === 'abstractNumId') ?? 'w:abstractNumId'
      copied.attributes = { ...(copied.attributes ?? {}), [key]: targetAbstract }
      targetRoot.elements = [...(targetRoot.elements ?? []), copied]
      abstractMap.set(sourceAbstract, targetAbstract)
    }
    const targetNum = String(nextNum++)
    const copied = clone(num)
    const numKey = Object.keys(copied.attributes ?? {}).find(name => local(name) === 'numId') ?? 'w:numId'
    copied.attributes = { ...(copied.attributes ?? {}), [numKey]: targetNum }
    const abstract = child(copied, 'abstractNumId')
    const abstractKey = Object.keys(abstract?.attributes ?? {}).find(name => local(name) === 'val') ?? 'w:val'
    if (abstract !== undefined) abstract.attributes = { ...(abstract.attributes ?? {}), [abstractKey]: targetAbstract }
    targetRoot.elements = [...(targetRoot.elements ?? []), copied]
    numMap.set(sourceNum, targetNum)
  }
  for (const node of inserted) for (const num of descendants(node, 'numId')) {
    const attributes = num.attributes
    const key = Object.keys(attributes ?? {}).find(name => local(name) === 'val')
    const mapped = attributes === undefined || key === undefined ? undefined : numMap.get(attributes[key] ?? '')
    if (attributes !== undefined && key !== undefined && mapped !== undefined) attributes[key] = mapped
  }
  targetZip.file('word/numbering.xml', js2xml(target, { compact: false }))
}

async function mergeBodyRelationships(
  targetZip: JSZip,
  sourceZip: JSZip,
  targetRelationships: XmlNode,
  sourceRelationships: XmlNode,
  targetContentTypes: XmlNode,
  sourceContentTypes: XmlNode,
  inserted: XmlNode[],
): Promise<void> {
  const references: Array<{ attributes: Record<string, string>; key: string; id: string }> = []
  const visit = (node: XmlNode): void => {
    const attributes = node.attributes
    for (const [key, value] of Object.entries(attributes ?? {}))
      if (attributes !== undefined && ['id', 'embed', 'link'].includes(local(key)) && /^rId\d+$/u.test(value)) references.push({ attributes, key, id: value })
    for (const nested of node.elements ?? []) visit(nested)
  }
  for (const node of inserted) visit(node)
  const targetRoot = descendants(targetRelationships, 'Relationships')[0]
  if (targetRoot === undefined) throw new Error('DOCX document.xml.rels 无效。')
  const remapped = new Map<string, string>()
  for (const reference of references) {
    let id = remapped.get(reference.id)
    if (id === undefined) {
      const relation = descendants(sourceRelationships, 'Relationship').find(node => attr(node, 'Id') === reference.id)
      if (relation === undefined) throw new Error(`DOCX 正文关系不存在：${reference.id}`)
      id = nextRelationshipId(targetRelationships)
      const copied = clone(relation)
      const idKey = Object.keys(copied.attributes ?? {}).find(name => local(name) === 'Id') ?? 'Id'
      copied.attributes = { ...(copied.attributes ?? {}), [idKey]: id }
      if (attr(copied, 'TargetMode') !== 'External') {
        const sourceTarget = attr(copied, 'Target') ?? ''
        const sourcePath = `word/${sourceTarget.replace(/^\.\//u, '')}`
        const bytes = await sourceZip.file(sourcePath)?.async('nodebuffer')
        if (bytes === undefined) throw new Error(`DOCX 正文关系部件不存在：${sourceTarget}`)
        const extension = sourceTarget.slice(sourceTarget.lastIndexOf('.') + 1).toLowerCase()
        const targetName = `media/dsh-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${extension}`
        targetZip.file(`word/${targetName}`, bytes)
        const targetKey = Object.keys(copied.attributes ?? {}).find(name => local(name) === 'Target') ?? 'Target'
        copied.attributes[targetKey] = targetName
        const targetTypes = descendants(targetContentTypes, 'Types')[0]
        const sourceDefault = descendants(sourceContentTypes, 'Default').find(node => attr(node, 'Extension')?.toLowerCase() === extension)
        if (targetTypes !== undefined && sourceDefault !== undefined
          && !children(targetTypes, 'Default').some(node => attr(node, 'Extension')?.toLowerCase() === extension)) {
          targetTypes.elements = [...(targetTypes.elements ?? []), clone(sourceDefault)]
        }
      }
      targetRoot.elements = [...(targetRoot.elements ?? []), copied]
      remapped.set(reference.id, id)
    }
    reference.attributes[reference.key] = id
  }
}

function insertBody(body: XmlNode, elements: XmlNode[]): void {
  const control = descendants(body, 'sdt').find(node => controlNames(node).some(isBodyName))
  const content = control === undefined ? undefined : child(control, 'sdtContent')
  if (control !== undefined && content !== undefined) {
    const top = body.elements ?? []
    if (children(content, 'p').length || children(content, 'tbl').length || top.includes(control)) {
      content.elements = elements
    } else {
      const container = top.find(node => descendants({ elements: [node] }, 'sdt').includes(control))
      if (container === undefined) throw new Error('DOCX 正文内容控件不在主文档正文中。')
      const index = top.indexOf(container)
      body.elements = [...top.slice(0, index), ...elements, ...top.slice(index + 1)]
    }
    return
  }
  const top = body.elements ?? []
  const bookmark = descendants(body, 'bookmarkStart').find(node => isBodyName(attr(node, 'name') ?? ''))
  const placeholder = top.find(node => local(node.name) === 'p' && isBodyName(text(node)))
  if (placeholder !== undefined) {
    const index = top.indexOf(placeholder)
    body.elements = [...top.slice(0, index), ...elements, ...top.slice(index + 1)]
    return
  }
  const bookmarked = bookmark === undefined ? undefined
    : top.find(node => descendants({ elements: [node] }, 'bookmarkStart').includes(bookmark))
  if (bookmarked !== undefined) {
    const index = top.indexOf(bookmarked)
    const replace = normalized(text(bookmarked)) === '' || isBodyName(text(bookmarked))
    body.elements = replace
      ? [...top.slice(0, index), ...elements, ...top.slice(index + 1)]
      : [...top.slice(0, index + 1), ...elements, ...top.slice(index + 1)]
    return
  }
  const section = top.findIndex(node => local(node.name) === 'sectPr')
  const index = section < 0 ? top.length : section
  body.elements = [...top.slice(0, index), ...elements, ...top.slice(index)]
}

/**
 * 把已渲染正文应用到原始模板包；调用方负责正文来源与格式解析。
 * @param templateBytes 用户上传的原始 DOCX。
 * @param contentBytes 单节 DOCX 正文，最终节属性不会进入模板。
 * @param mapping 模板样式角色映射。
 * @returns 以原模板为包骨架的 DOCX。
 */
export async function applyTemplateContent(
  templateBytes: Uint8Array,
  contentBytes: Uint8Array,
  mapping: DocxFormatInterpretation['mapping'] = {},
): Promise<Buffer> {
  await Promise.all([readDocxXml(templateBytes), readDocxXml(contentBytes)])
  const [targetZip, sourceZip] = await Promise.all([JSZip.loadAsync(templateBytes), JSZip.loadAsync(contentBytes)])
  const [targetDocument, sourceDocument, targetContentTypes, sourceContentTypes, sourceRelationships] = await Promise.all([
    xmlPart(targetZip, 'word/document.xml'),
    xmlPart(sourceZip, 'word/document.xml'),
    xmlPart(targetZip, '[Content_Types].xml'),
    xmlPart(sourceZip, '[Content_Types].xml'),
    xmlPart(sourceZip, 'word/_rels/document.xml.rels'),
  ])
  const targetRelationships = targetZip.file('word/_rels/document.xml.rels') === null
    ? parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'word/_rels/document.xml.rels')
    : await xmlPart(targetZip, 'word/_rels/document.xml.rels')
  const targetBody = documentBody(targetDocument)
  const sourceBody = documentBody(sourceDocument)
  const sourceElements = (sourceBody.elements ?? []).filter(node => local(node.name) !== 'sectPr')
  const filled = fillTemplateTables(targetBody, sourceElements, mapping)
  const inserted = removeConsumedBlocks(sourceElements, filled.consumed)
  const merged = [...inserted, ...filled.movedCaptions]
  await mergeStyles(targetZip, sourceZip, targetContentTypes, sourceContentTypes,
    targetRelationships, sourceRelationships, merged, mapping)
  await mergeNumbering(targetZip, sourceZip, targetContentTypes, sourceContentTypes,
    targetRelationships, sourceRelationships, merged)
  await mergeBodyRelationships(targetZip, sourceZip, targetRelationships, sourceRelationships,
    targetContentTypes, sourceContentTypes, merged)
  insertBody(targetBody, inserted)
  clearTableParagraphFirstLineIndent(targetBody)
  targetZip.file('word/document.xml', js2xml(targetDocument, { compact: false }))
  targetZip.file('[Content_Types].xml', js2xml(targetContentTypes, { compact: false }))
  targetZip.file('word/_rels/document.xml.rels', js2xml(targetRelationships, { compact: false }))
  const result = await targetZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await readDocxXml(result)
  return result
}

/**
 * 将 S5 Markdown 转为 OOXML 后填入用户选择的原始模板。
 * @param workspace 正文图片所属项目。
 * @param templateBytes 用户上传的原始 DOCX。
 * @param markdown S5 保存正文汇总出的 Markdown 快照。
 * @param values 模板提取并确认的正文排版值。
 * @param mapping 模板样式角色映射。
 * @param flowchartMode 流程图使用 SVG 预览或供 Word COM 替换的 marker。
 * @returns 合成 DOCX 与正文图片摘要。
 */
export async function composeDocxFromTemplate(
  workspace: BidWorkspace,
  templateBytes: Uint8Array,
  markdown: string,
  values: FormatValues,
  mapping: DocxFormatInterpretation['mapping'] = {},
  flowchartMode: 'svg' | 'visio-placeholder' = 'svg',
): Promise<{ bytes: Buffer; assetHash: string }> {
  const rendered = await renderDocx(workspace, markdown, values, false, 'a4', flowchartMode)
  return { bytes: await applyTemplateContent(templateBytes, rendered.bytes, mapping), assetHash: rendered.assetHash }
}
