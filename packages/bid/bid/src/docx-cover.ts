/** 通过稳定内容控件标签填充技术标封面，不依赖模板中的物理位置。 */
import JSZip from 'jszip'
import { js2xml, xml2js } from 'xml-js'
import { readDocxXml } from './docx-template.ts'

interface XmlNode {
  type?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
  elements?: XmlNode[]
}

/** 程序可确认的封面字段；缺失值保持为空。 */
export interface BidCoverData {
  projectName?: string
  projectCode?: string
  bidderName?: string
  date?: string
}

const local = (name = ''): string => name.slice(name.lastIndexOf(':') + 1)
const children = (node: XmlNode, name: string): XmlNode[] => (node.elements ?? []).filter(item => local(item.name) === name)
const child = (node: XmlNode, name: string): XmlNode | undefined => children(node, name)[0]
const descendants = (node: XmlNode, name: string): XmlNode[] => (node.elements ?? []).flatMap(item => [
  ...(local(item.name) === name ? [item] : []), ...descendants(item, name),
])
const attr = (node: XmlNode, name: string): string | undefined => Object.entries(node.attributes ?? {})
  .find(([key]) => local(key) === name)?.[1]

function parseXml(source: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error('DOCX XML 不允许 DTD 或实体声明。')
  try { return xml2js(source, { compact: false }) as XmlNode } catch { throw new Error('DOCX document.xml 无效。') }
}

function taggedControl(document: XmlNode, tag: string): XmlNode | undefined {
  return descendants(document, 'sdt').find((control) => {
    const properties = child(control, 'sdtPr')
    return properties !== undefined && attr(child(properties, 'tag') ?? {}, 'val') === tag
  })
}

function setControlText(document: XmlNode, tag: string, value: string): void {
  const content = child(taggedControl(document, tag) ?? {}, 'sdtContent')
  if (content === undefined) return
  const texts = descendants(content, 't')
  if (texts.length === 0) throw new Error(`DOCX 封面锚点没有可填写文字：${tag}`)
  const first = texts[0] as XmlNode
  first.attributes = { ...(first.attributes ?? {}), 'xml:space': 'preserve' }
  first.elements = value === '' ? [] : [{ type: 'text', text: value }]
  for (const remaining of texts.slice(1)) remaining.elements = []
}

/**
 * 填充默认模板封面中的稳定内容控件。
 * @param bytes DOCX 模板字节。
 * @param data 已确认的项目和导出信息。
 * @returns 保留模板其余 OOXML 的 DOCX 字节。
 */
export async function fillBidCover(bytes: Uint8Array, data: BidCoverData): Promise<Buffer> {
  await readDocxXml(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const source = await zip.file('word/document.xml')?.async('string')
  if (source === undefined) throw new Error('DOCX 缺少部件：word/document.xml')
  const document = parseXml(source)
  setControlText(document, 'dsh-cover-project-name', data.projectName?.trim() ?? '')
  setControlText(document, 'dsh-cover-project-code', `项目编号：${data.projectCode?.trim() ?? ''}`)
  setControlText(document, 'dsh-cover-bidder-name', `投标人：${data.bidderName?.trim() ?? ''}`)
  setControlText(document, 'dsh-cover-date', `日期：${data.date?.trim() ?? ''}`)
  zip.file('word/document.xml', js2xml(document, { compact: false }))
  const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await readDocxXml(result)
  return result
}
