/** 原始 WordprocessingML 的按需对象索引；重复文字仍由部件、节点路径及版本唯一定位。 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { promptFileRefSchema, type PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { readDocxXml } from './docx-template.ts'

/** 保留 XML 层级、属性和非文本节点的解析对象。 */
export type DocxXmlNode = Awaited<ReturnType<typeof readDocxXml>>[string]
/** 程序绑定的原稿节点；模型只选择 inspect 给出的块位置。 */
export const docxBlockRefSchema = z.object({ file_ref: promptFileRefSchema,
  part: z.string().regex(/^word\/(?:document|header\d+|footer\d+)\.xml$/u),
  node_path: z.array(z.number().int().nonnegative()).min(1),
  node_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
/** 带文件版本的不可变 XML 锚点。 */
export type DocxBlockRef = z.infer<typeof docxBlockRefSchema>
/** 模型可理解的文档对象及程序保留的精确锚点。 */
export interface DocxDocumentBlock {
  readonly ref: DocxBlockRef
  readonly kind: 'paragraph' | 'table' | 'image' | 'section'
  readonly text: string
  readonly heading_path: readonly string[]
  readonly context: { readonly before: string; readonly after: string }
  readonly location: string
  readonly style: string | null
  readonly writable: boolean
  readonly limitations: readonly string[]
  readonly available_width_twips: number | null
}
/** 一次原件读取产生的索引；不作为第二份文档存储。 */
export interface DocxDocumentIndex {
  readonly file_ref: PromptFileRef
  readonly blocks: readonly DocxDocumentBlock[]
}

/**
 * 读取命名空间前缀之外的 XML 名称。
 * @param node XML 节点。
 * @returns 本地节点名，非元素节点返回空串。
 */
export function docxNodeName(node: DocxXmlNode): string { return (node.name ?? '').split(':').at(-1) ?? '' }
/**
 * 按本地属性名读取 OOXML 属性。
 * @param node XML 节点。
 * @param name 不含前缀的属性名。
 * @returns 属性值或 undefined。
 */
export function docxAttribute(node: DocxXmlNode | undefined, name: string): string | undefined {
  return Object.entries(node?.attributes ?? {}).find(([key]) => key.split(':').at(-1) === name)?.[1]
}
/**
 * 获取直接子元素，保持文档顺序。
 * @param node XML 父节点。
 * @param name 本地节点名。
 * @returns 匹配的子节点。
 */
export function docxChildren(node: DocxXmlNode, name: string): DocxXmlNode[] {
  return (node.elements ?? []).filter(item => docxNodeName(item) === name)
}
/**
 * 深度优先读取后代元素。
 * @param node XML 根节点。
 * @param name 本地节点名。
 * @returns 文档顺序的后代。
 */
export function docxDescendants(node: DocxXmlNode, name: string): DocxXmlNode[] {
  return (node.elements ?? []).flatMap(item => [...(docxNodeName(item) === name ? [item] : []), ...docxDescendants(item, name)])
}
/**
 * 只提取正文文本和可见的制表、换行；字段指令不作为正文。
 * @param node 文档对象。
 * @returns 可见文字。
 */
export function docxNodeText(node: DocxXmlNode): string {
  const name = docxNodeName(node)
  if (name === 't') return (node.elements ?? []).map(item => item.text ?? '').join('')
  if (name === 'tab') return '\t'
  if (name === 'br' || name === 'cr') return '\n'
  return (node.elements ?? []).map(docxNodeText).join('')
}
/**
 * 计算当前节点的结构摘要。
 * @param node 实际解析节点。
 * @returns SHA-256。
 */
export function docxNodeHash(node: DocxXmlNode): string { return createHash('sha256').update(JSON.stringify(node)).digest('hex') }
/**
 * 按程序绑定路径读取节点，拒绝旧版本或漂移的内容。
 * @param part 原始 XML 部件根。
 * @param ref 当前基线的精确锚点。
 * @returns 同一节点及父节点，便于安全应用插入和删除。
 */
export function resolveDocxBlock(part: DocxXmlNode, ref: DocxBlockRef): { node: DocxXmlNode; parent: DocxXmlNode; index: number } {
  let parent = part
  for (const index of ref.node_path.slice(0, -1)) {
    const next = parent.elements?.[index]
    if (next === undefined) throw new Error('BID_DOCX_BLOCK_PATH_INVALID')
    parent = next
  }
  const index = ref.node_path.at(-1)
  assert(index !== undefined)
  const node = parent.elements?.[index]
  if (node === undefined || docxNodeHash(node) !== ref.node_sha256) throw new Error('BID_DOCX_BLOCK_CHANGED')
  return { node, parent, index }
}

const child = (node: DocxXmlNode, name: string) => docxChildren(node, name)[0]
const number = (node: DocxXmlNode | undefined, key: string): number | undefined => {
  const text = docxAttribute(node, key)
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}
function sectionWidth(section: DocxXmlNode | undefined): number | null {
  if (section === undefined) return null
  const size = child(section, 'pgSz')
  const margins = child(section, 'pgMar')
  const width = number(size, 'w')
  const left = number(margins, 'left')
  const right = number(margins, 'right')
  if (width === undefined || left === undefined || right === undefined) return null
  const usable = width - left - right - (number(margins, 'gutter') ?? 0)
  const columns = child(section, 'cols')
  const explicit = columns === undefined ? [] : docxChildren(columns, 'col').map(column => number(column, 'w'))
  const count = number(columns, 'num') ?? 1
  const result = explicit.length > 0 && explicit.every(value => value !== undefined)
    ? Math.min(...explicit) : (usable - Math.max(0, count - 1) * (number(columns, 'space') ?? 720)) / count
  return Number.isFinite(result) && result > 0 ? Math.floor(result) : null
}

function targetWidth(body: DocxXmlNode, topIndex: number, ancestors: readonly DocxXmlNode[]): number | null {
  const section = (body.elements ?? []).slice(topIndex).flatMap(node => docxNodeName(node) === 'sectPr'
    ? [node] : docxNodeName(node) === 'p' ? docxDescendants(node, 'sectPr') : [])[0]
  let width = sectionWidth(section)
  if (width === null) return null
  for (const [index, node] of ancestors.entries()) {
    if (docxNodeName(node) !== 'tc') continue
    const props = child(node, 'tcPr')
    const cellWidth = props === undefined ? undefined : child(props, 'tcW')
    const value = number(cellWidth, 'w')
    const type = docxAttribute(cellWidth, 'type')
    let cell = value !== undefined && type === 'dxa' ? value
      : value !== undefined && type === 'pct' ? width * value / 5000 : undefined
    if (cell === undefined) {
      const table = ancestors.slice(0, index).findLast(item => docxNodeName(item) === 'tbl')
      const row = ancestors[index - 1]
      const grid = table === undefined ? undefined : child(table, 'tblGrid')
      if (grid === undefined || row === undefined || docxNodeName(row) !== 'tr') return null
      const cells = docxChildren(row, 'tc')
      const position = cells.indexOf(node)
      const span = (cell: DocxXmlNode) => number(child(child(cell, 'tcPr') ?? {}, 'gridSpan'), 'val') ?? 1
      const start = cells.slice(0, position).reduce((total, cell) => total + span(cell), 0)
      const columns = docxChildren(grid, 'gridCol').slice(start, start + span(node)).map(col => number(col, 'w'))
      if (columns.length !== span(node) || columns.some(value => value === undefined)) return null
      cell = 0
      for (const value of columns) {
        if (value === undefined) return null
        cell += value
      }
    }
    const margins = props === undefined ? undefined : child(props, 'tcMar')
    const table = ancestors.slice(0, index).findLast(item => docxNodeName(item) === 'tbl')
    const tableMargins = table === undefined ? undefined : child(child(table, 'tblPr') ?? {}, 'tblCellMar')
    const margin = (side: string) => number(child(margins ?? {}, side) ?? child(tableMargins ?? {}, side), 'w') ?? 108
    width = Math.min(width, cell - margin('left') - margin('right'))
    if (width <= 0) return null
  }
  return width
}

/**
 * 从原始 DOCX 按需索引正文、表格段落、图片实例、分节及只读页眉页脚。
 * @param bytes 原始文件的完整 ZIP 字节。
 * @param ref Host 已验证的原件版本。
 * @returns 含上下文及精确锚点的对象表；未实现的部件明确只读。
 */
export async function indexDocxDocument(bytes: Uint8Array, ref: PromptFileRef): Promise<DocxDocumentIndex> {
  promptFileRefSchema.parse(ref)
  if (createHash('sha256').update(bytes).digest('hex') !== ref.version) throw new Error('BID_DOCX_VERSION_CHANGED')
  const parts = await readDocxXml(bytes)
  const styles = new Map(docxDescendants(parts['word/styles.xml'] ?? {}, 'style')
    .map(node => [docxAttribute(node, 'styleId'), node]))
  const blocks: DocxDocumentBlock[] = []
  for (const [part, root] of Object.entries(parts)) {
    if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/u.test(part)) continue
    const body = docxDescendants(root, 'body')[0]
    const headings: string[] = []
    const partBlocks: DocxDocumentBlock[] = []
    const visit = (node: DocxXmlNode, path: number[], ancestors: DocxXmlNode[]): void => {
      const name = docxNodeName(node)
      const props = child(node, 'pPr')
      const styleId = docxAttribute(child(props ?? {}, 'pStyle'), 'val')
      const style = styles.get(styleId)
      const text = docxNodeText(node)
      const namedLevel = /^heading\s*([1-9])$/iu.exec(docxAttribute(child(style ?? {}, 'name'), 'val') ?? styleId ?? '')?.[1]
      const level = number(child(props ?? {}, 'outlineLvl'), 'val')
        ?? number(child(child(style ?? {}, 'pPr') ?? {}, 'outlineLvl'), 'val')
        ?? (namedLevel === undefined ? undefined : Number(namedLevel) - 1)
      if (name === 'p' && level !== undefined && level < 9) { headings.length = level; headings.push(text) }
      const kind = name === 'p' ? 'paragraph' : name === 'tbl' ? 'table'
        : name === 'drawing' || name === 'pict' ? 'image' : name === 'sectPr' ? 'section' : undefined
      if (kind !== undefined) {
        const bodyIndex = body === undefined ? -1 : ancestors.indexOf(body)
        const top = body === undefined || bodyIndex < 0 ? -1 : (body.elements ?? []).indexOf(ancestors[bodyIndex + 1] ?? node)
        const cell = ancestors.filter(item => docxNodeName(item) === 'tc').length
        const limitations: string[] = part !== 'word/document.xml' ? ['页眉页脚只读，不能回落到正文相同文字。'] : []
        if (kind === 'table' || kind === 'section') limitations.push('此对象用于结构定位，不提供表格重组或分节修改。')
        if (kind === 'paragraph' && ['fldChar', 'instrText', 'fldSimple', 'hyperlink', 'sdt'].some(name => docxDescendants(node, name).length > 0)) {
          limitations.push('复杂字段、超链接或内容控件文字不能整段替换；仍可在段落旁插图或新增普通段落。')
        }
        partBlocks.push({ ref: { file_ref: ref, part, node_path: path, node_sha256: docxNodeHash(node) },
          kind, text, heading_path: [...headings], context: { before: '', after: '' },
          location: `${part} / ${cell === 0 ? '正文' : `表格单元格（嵌套 ${String(cell)} 层）`} / 对象 ${String(partBlocks.length + 1)}`,
          style: styleId ?? null, writable: part === 'word/document.xml' && (kind === 'paragraph' || kind === 'image'), limitations,
          available_width_twips: body === undefined || top < 0 ? null : targetWidth(body, top, ancestors),
        })
      }
      for (const [index, child] of (node.elements ?? []).entries()) visit(child, [...path, index], [...ancestors, node])
    }
    visit(root, [], [])
    for (const [index, block] of partBlocks.entries()) blocks.push({ ...block, context: {
      before: partBlocks.slice(0, index).findLast(item => item.kind === 'paragraph')?.text.slice(-240) ?? '',
      after: partBlocks.slice(index + 1).find(item => item.kind === 'paragraph')?.text.slice(0, 240) ?? '',
    } })
  }
  return { file_ref: ref, blocks }
}
