/** 同一 Markdown 遍历生成 DOCX 与样式预览；遇到不支持的节点拒绝输出。 */
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { Document,
  Footer,
  Header,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  ImageRun,
  ExternalHyperlink,
  WidthType,
  type ParagraphChild,
  type IParagraphOptions,
  type IRunOptions } from 'docx'
import type { FormatValues } from './docx-format-contract.ts'
import type { BidWorkspace } from './index.ts'
import { within, assertNoLinkedPath } from './workspace-path.ts'
import { applyHeadingRestartRules, createHeadingNumberer, resolveHeadingNumbering } from './docx-numbering.ts'
type Node = {
  type: string
  value?: string | undefined
  url?: string
  alt?: string | null | undefined
  identifier?: string
  depth?: number
  ordered?: boolean | null | undefined
  start?: number | null | undefined
  checked?: boolean | null | undefined
  children?: Node[]
  position?: {
    start: {
      line: number
    }
  } | undefined
}
const escape = (value: string): string => value.replaceAll('&',
  '&amp;').replaceAll('<',
  '&lt;').replaceAll('>',
  '&gt;').replaceAll('"',
  '&quot;').replaceAll("'",
  '&#39;')
const content = (node: Node): string => node.value ?? (node.children ?? []).map(content).join('')
const mm = (value: number): number => Math.round(value * 1440 / 25.4)
function withoutHeadingNumber(nodes: Node[]): Node[] {
  let remaining = /^\d+(?:\.\d+)*\s+/u.exec(nodes.map(content).join(''))?.[0].length ?? 0
  const visit = (items: Node[]): Node[] => items.map((node) => {
    if (!remaining) return node
    if (node.value !== undefined) {
      const length = Math.min(remaining, node.value.length)
      remaining -= length
      return { ...node, value: node.value.slice(length) }
    }
    return { ...node, children: visit(node.children ?? []) }
  })
  return visit(nodes)
}

/**
 * 读取导出支持的图片像素尺寸；正文渲染和页数估算使用同一缩放依据。
 * @param data 已验证的项目内图片字节。
 * @returns 图片格式及原始像素尺寸。
 */
export function docxImageDimensions(data: Buffer): { type: 'png' | 'jpg'; width: number; height: number } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data[0] !== 255 || data[1] !== 216) throw new Error('仅支持有效 PNG 或 JPEG。')
  let offset = 2
  while (offset + 9 < data.length) {
    const marker = data.readUInt8(offset + 1), length = data.readUInt16BE(offset + 2)
    if ([192, 193, 194].includes(marker)) {
      const height = data.readUInt16BE(offset + 5), width = data.readUInt16BE(offset + 7)
      if (width && height) return { type: 'jpg', width, height }
      break
    }
    if (length < 2) break
    offset += length + 2
  }
  throw new Error('无法读取图片尺寸。')
}
async function readAssets(workspace: BidWorkspace, root: Node): Promise<Map<string, Buffer>> {
  const definitions = new Map((root.children ?? []).filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
  const assets = new Map<string, Buffer>()
  let total = 0
  const visit = async (node: Node): Promise<void> => {
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.url ?? definitions.get(node.identifier) ?? ''
      if (assets.has(url))
        return
      if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(url))
        throw new Error(`正文第 ${node.position?.start.line ?? '?'} 行图片必须保存到项目内，不自动访问外部资源。`)
      let path: string
      try { path = within(workspace.projectRoot, decodeURIComponent(url)) } catch {
        throw new Error(`正文第 ${node.position?.start.line ?? '?'} 行图片路径无效，必须位于项目内。`)
      }
      await assertNoLinkedPath(workspace.root, path)
      const info = await stat(path).catch(() => {
        throw new Error(`正文第 ${node.position?.start.line ?? '?'} 行图片不存在或无法读取：${url}`)
      })
      total += info.size
      if (!info.isFile() || total > 20 * 1024 * 1024)
        throw new Error('正文图片必须为普通文件，总大小不能超过 20 MiB。')
      assets.set(url, await readFile(path).catch(() => {
        throw new Error(`正文图片读取失败，请检查文件是否可用：${url}`)
      }))
    }
    for (const child of node.children ?? [])
      await visit(child)
  }
  await visit(root)
  return assets
}
function hashAssets(assets: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const [url, data] of assets)
    hash.update(url).update(data)
  return hash.digest('hex')
}
/**
 * 读取图片摘要用于检测外部文件变化，不生成预览或 Word。
 * @param workspace 图片所属项目。
 * @param markdown 正文快照。
 * @returns 按文档顺序计算的图片摘要。
 */
export async function docxAssetHash(workspace: BidWorkspace, markdown: string): Promise<string> {
  return hashAssets(await readAssets(workspace, fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })))
}
/**
 * 使用固定内容和配置渲染两种输出，不请求模型或下载外部图片。
 * @param workspace 图片只能读取当前项目内的普通文件。
 * @param markdown 已完成的正文快照。
 * @param values 经校验的生效格式。
 * @param preview 是否在浏览器预览末尾补充缺失内容的明确示例。
 * @returns 有效 DOCX 字节及安全的内嵌样式预览。
 */
export async function renderDocx(workspace: BidWorkspace, markdown: string, values: FormatValues, preview = false): Promise<{
  bytes: Buffer
  html: string
  assetHash: string
}> {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const assets = await readAssets(workspace, root)
  const numberHeading = createHeadingNumberer(values)
  const headingLevels = resolveHeadingNumbering(values)
  const headingReference = 'dsh-headings'
  const headingNumbering = (level: number): NonNullable<IParagraphOptions['numbering']> => ({ reference: headingReference, level })
  const definitions = new Map(root.children.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
  const num = (key: string): number => Number(values[key])
  const str = (key: string): string => String(values[key])
  const run = (role: string): IRunOptions => ({ font: { eastAsia: str(`${role}.font`),
    ascii: str(`${role}.latinFont`),
    hAnsi: str(`${role}.latinFont`) },
  size: num(`${role}.size`) * 2,
  color: str(`${role}.color`),
  italics: Boolean(values[`${role}.italics`]),
  bold: Boolean(values[`${role}.bold`]) })
  const paragraph = (role: string): IParagraphOptions => ({
    alignment: str(`${role}.alignment`) as 'left' | 'center' | 'right' | 'both',
    indent: values[`${role}.firstLineUnit`] === 'chars'
      ? { firstLineChars: Math.round(num(`${role}.firstLine`) * 100) }
      : { firstLine: mm(num(`${role}.firstLine`)) },
    spacing: { before: num(`${role}.before`) * 20,
      after: num(`${role}.after`) * 20,
      line: num(`${role}.line`) * (values[`${role}.lineRule`] === 'auto' ? 240 : 20),
      lineRule: str(`${role}.lineRule`) as 'auto' | 'exact' | 'atLeast' },
    pageBreakBefore: Boolean(values[`${role}.pageBreak`]),
    keepNext: Boolean(values[`${role}.keepNext`]),
    keepLines: Boolean(values[`${role}.keepLines`]),
  })
  const style = (role: string): string => escape(`font-family:"${str(`${role}.latinFont`).replaceAll('"', '')}","${str(`${role}.font`).replaceAll('"', '')}";font-size:${num(`${role}.size`)}pt;font-weight:${values[`${role}.bold`] ? 'bold' : 'normal'};font-style:${values[`${role}.italics`] ? 'italic' : 'normal'};color:#${str(`${role}.color`)};text-align:${values[`${role}.alignment`] === 'both' ? 'justify' : str(`${role}.alignment`)};text-indent:${num(`${role}.firstLine`)}${values[`${role}.firstLineUnit`] === 'chars' ? 'em' : 'mm'};line-height:${num(`${role}.line`)}${values[`${role}.lineRule`] === 'auto' ? '' : 'pt'};margin-top:${num(`${role}.before`)}pt;margin-bottom:${num(`${role}.after`)}pt;break-before:${values[`${role}.pageBreak`] ? 'page' : 'auto'};break-after:${values[`${role}.keepNext`] ? 'avoid' : 'auto'};break-inside:${values[`${role}.keepLines`] ? 'avoid' : 'auto'}`)
  const unsupported = (node: Node): never => { throw new Error(`正文第 ${node.position?.start.line ?? '?'} 行不支持 ${node.type}，请调整内容后重新生成。`) }
  async function inline(nodes: Node[], role: string, options: IRunOptions = {}): Promise<{
    runs: ParagraphChild[]
    html: string
  }> {
    const runs: ParagraphChild[] = [], html: string[] = []
    for (const node of nodes) {
      if (node.type === 'text' || node.type === 'inlineCode') {
        runs.push(new TextRun({ ...run(role), ...options, text: node.value ?? '' }))
        html.push(node.type === 'inlineCode' ? `<code>${escape(node.value ?? '')}</code>` : escape(node.value ?? ''))
        continue
      }
      if (node.type === 'break') {
        runs.push(new TextRun({ break: 1 }))
        html.push('<br>')
        continue
      }
      if (['strong', 'emphasis', 'delete'].includes(node.type)) {
        const tag = node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' : 's'
        const nested = await inline(node.children ?? [],
          role,
          { ...options,
            ...(node.type === 'strong' ? { bold: true } : node.type === 'emphasis' ? { italics: true } : { strike: true }) })
        runs.push(...nested.runs)
        html.push(`<${tag}>${nested.html}</${tag}>`)
        continue
      }
      if (node.type === 'link' || node.type === 'linkReference') {
        const url = node.url ?? definitions.get(node.identifier ?? '')
        if (!url || !/^(https?:|mailto:)/iu.test(url))
          throw new Error(`正文第 ${node.position?.start.line ?? '?'} 行链接协议不受支持。`)
        const nested = await inline(node.children ?? [], role, options)
        runs.push(new ExternalHyperlink({ link: url, children: nested.runs }))
        html.push(`<a href="${escape(url)}">${nested.html}</a>`)
        continue
      }
      if (node.type === 'image' || node.type === 'imageReference') {
        const url = node.url ?? definitions.get(node.identifier ?? '') ?? ''
        const data = assets.get(url) as Buffer
        let image: { type: 'png' | 'jpg'; width: number; height: number }
        try { image = docxImageDimensions(data) } catch (error) {
          if (error instanceof Error && error.message === '仅支持有效 PNG 或 JPEG。') throw new Error(`图片 ${url} 仅支持有效 PNG 或 JPEG。`)
          throw new Error(`无法读取图片尺寸：${url}`)
        }
        const { type, width, height } = image
        const ratio = Math.min(1, 500 / width, 700 / height)
        runs.push(new ImageRun({ data,
          type,
          transformation: { width: width * ratio,
            height: height * ratio },
          altText: { name: node.alt ?? '',
            title: node.alt ?? '',
            description: node.alt ?? '' } }))
        html.push(`<img src="data:image/${type};base64,${data.toString('base64')}" alt="${escape(node.alt ?? '')}" style="max-width:100%;height:auto">`)
        continue
      }
      unsupported(node)
    }
    return { runs, html: html.join('') }
  }
  async function blocks(nodes: Node[], level = 0, listPrefix = ''): Promise<{
    doc: (Paragraph | Table)[]
    html: string
  }> {
    const doc: (Paragraph | Table)[] = [], html: string[] = []
    for (const [index, node] of nodes.entries()) {
      if (node.type === 'definition')
        continue
      if (node.type === 'heading' || node.type === 'paragraph' || node.type === 'code') {
        const role = node.type === 'heading' ? node.depth === 1 && node === root.children[0] ? 'title' : `heading${node.depth ?? 1}` : /^图\s*\d/u.test(content(node)) ? 'figureCaption' : /^表\s*\d/u.test(content(node)) ? 'tableCaption' : 'body'
        let contents: Node[] = node.type === 'code' ? [{ type: 'text', value: node.value ?? '' }] : node.children ?? []
        const numberedHeading = node.type === 'heading' && role !== 'title'
        if (numberedHeading)
          contents = withoutHeadingNumber(contents)
        const rendered = await inline(contents, role)
        const prefix = index === 0 ? listPrefix : ''
        doc.push(new Paragraph({ ...paragraph(role),
          ...(level > 0 ? { indent: { left: mm(level * 6) } } : {}),
          ...(node.type === 'heading' ? { heading: role === 'title' ? 'Title' : `Heading${role.slice(7)}` as 'Heading1' } : {}),
          ...(numberedHeading && headingLevels.length ? { numbering: headingNumbering((node.depth ?? 1) - 1) } : {}),
          children: [...(prefix ? [new TextRun({ ...run(role),
            text: prefix })] : []),
          ...rendered.runs] }))
        const tag = role === 'title' ? 'h1' : node.type === 'heading' ? `h${Math.min(6, Number(role.slice(7)) + 1)}` : node.type === 'code' ? 'pre' : 'p'
        const headingPrefix = numberedHeading ? numberHeading(node.depth ?? 1) : ''
        html.push(`<${tag} style="${style(role)}">${escape(prefix)}${headingPrefix ? `${escape(headingPrefix)} ` : ''}${rendered.html}</${tag}>`)
        continue
      }
      if (node.type === 'list') {
        for (const [itemIndex, item] of (node.children ?? []).entries()) {
          const prefix = item.checked != null ? `${item.checked ? '☑' : '☐'} ` : node.ordered ? `${(node.start ?? 1) + itemIndex}. ` : '• '
          const nested = await blocks(item.children ?? [], level + 1, prefix)
          doc.push(...nested.doc)
          html.push(`<div style="margin-left:6mm">${nested.html}</div>`)
        }
        continue
      }
      if (node.type === 'blockquote') {
        const nested = await blocks(node.children ?? [], level + 1)
        doc.push(...nested.doc)
        html.push(`<blockquote>${nested.html}</blockquote>`)
        continue
      }
      if (node.type === 'thematicBreak') {
        doc.push(new Paragraph({ thematicBreak: true }))
        html.push('<hr>')
        continue
      }
      if (node.type === 'table') {
        const rows: TableRow[] = [], htmlRows: string[] = []
        for (const [rowIndex, row] of (node.children ?? []).entries()) {
          const cells: TableCell[] = [], htmlCells: string[] = []
          const role = rowIndex === 0 ? 'tableHeader' : 'tableCell'
          for (const cell of row.children ?? []) {
            const rendered = await inline(cell.children ?? [], role)
            cells.push(new TableCell({ ...(rowIndex === 0 ? { shading: { fill: str('table.fill') } } : {}),
              children: [new Paragraph({ ...paragraph(role),
                children: rendered.runs })] }))
            htmlCells.push(`<${rowIndex === 0 ? 'th' : 'td'} style="${style(role)};${rowIndex === 0 ? `background:#${str('table.fill')};` : ''}border:${num('table.borderSize')}pt ${values['table.border'] === 'nil' ? 'none' : values['table.border'] === 'single' ? 'solid' : str('table.border')}">${rendered.html}</${rowIndex === 0 ? 'th' : 'td'}>`)
          }
          rows.push(new TableRow({ tableHeader: rowIndex === 0, children: cells }))
          htmlRows.push(`<tr>${htmlCells.join('')}</tr>`)
        }
        const border = { style: str('table.border') as 'single', size: num('table.borderSize') * 8 }
        doc.push(new Table({ width: { size: num('table.width'),
          type: WidthType.PERCENTAGE },
        borders: { top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border },
        rows }))
        html.push(`<table style="border-collapse:collapse;width:${num('table.width')}%">${htmlRows.join('')}</table>`)
        continue
      }
      unsupported(node)
    }
    return { doc, html: html.join('') }
  }
  const body = await blocks(root.children)
  if (preview) {
    const all: Node[] = []
    const visit = (node: Node): void => { all.push(node); for (const nested of node.children ?? [])
      visit(nested) }
    visit(root)
    const samples: Node[] = []
    for (let level = 1; level <= 6; level++)
      if (!all.some(node => node !== root.children[0] && node.type === 'heading' && node.depth === level))
        samples.push({ type: 'heading', depth: level, children: [{ type: 'text', value: `${level} 级标题排版示例（非正文）` }] })
    if (!all.some(node => node.type === 'paragraph'))
      samples.push({ type: 'paragraph', children: [{ type: 'text', value: '正文排版示例（非正文）：此处展示字体、字号、行距和段落间距。' }] })
    if (!all.some(node => node.type === 'list'))
      samples.push(...fromMarkdown('- 列表样例（非正文）\n  - 嵌套列表样例').children)
    if (!all.some(node => node.type === 'table'))
      samples.push(...fromMarkdown('| 表头示例 | 说明 |\n| --- | --- |\n| 单元格样例 | 非正文 |',
        { extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()] }).children)
    if (!all.some(node => /^图\s*\d/u.test(content(node))))
      samples.push({ type: 'paragraph', children: [{ type: 'text', value: '图 1 图题排版示例（非正文）' }] })
    if (!all.some(node => /^表\s*\d/u.test(content(node))))
      samples.push({ type: 'paragraph', children: [{ type: 'text', value: '表 1 表题排版示例（非正文）' }] })
    const sample = await blocks(samples)
    const imageSample = all.some(node => node.type === 'image' || node.type === 'imageReference') ? '' : '<figure><svg role="img" aria-label="图片占位示例，非正文" width="320" height="100" viewBox="0 0 320 100" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="318" height="98" fill="none" stroke="currentColor"/><text x="35" y="55">图片占位示例（非正文）</text></svg></figure>'
    if (samples.length || imageSample)
      body.html += `<hr><p>以下为缺失内容的排版样例，不写入正文或导出文件。</p>${sample.html}${imageSample}`
  }
  const title = root.children[0]?.type === 'heading' ? content(root.children[0]) : ''
  const headerText = str('header.text') || title, footerText = str('footer.text')
  const pageNumber = str('footer.pageNumber')
  const page = values['page.paper'] === 'A3' ? [297, 420] : values['page.paper'] === 'Letter' ? [215.9, 279.4] : [210, 297]
  const document = new Document({ numbering: { config: headingLevels.length ? [{ reference: headingReference,
    levels: headingLevels.map(level => ({ ...level, style: { ...level.style, run: run(`heading${level.level + 1}`) } })),
  }] : [] }, styles: { default: {
    document: { run: run('body') },
    ...Object.fromEntries(['title', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6']
      .map(role => [role, { basedOn: 'DshHeadingBase', run: run(role), paragraph: { ...paragraph(role),
        ...(role === 'title' ? {} : { outlineLevel: Number(role.slice(7)) - 1,
          ...(headingLevels.length ? { numbering: headingNumbering(Number(role.slice(7)) - 1) } : {}) }),
      } }])),
  }, paragraphStyles: [
    { id: 'Normal', name: 'Normal', run: run('body'), paragraph: paragraph('body') },
    { id: 'DshHeadingBase', name: '标题基准', run: run('body') },
  ] }, sections: [{
    properties: { page: { size: { width: mm(page[0] as number),
      height: mm(page[1] as number),
      orientation: str('page.orientation') as 'portrait' | 'landscape' },
    margin: Object.fromEntries(['top',
      'bottom',
      'left',
      'right',
      'header',
      'footer'].map(key => [key,
      mm(num(`page.${key}`))])) } },
    headers: { default: new Header({ children: [new Paragraph({ ...paragraph('header'),
      children: [new TextRun({ ...run('header'),
        text: headerText })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ ...paragraph('footer'),
      children: [new TextRun({ ...run('footer'),
        text: footerText }),
      ...(pageNumber === 'none' ? [] : [new TextRun({ ...run('footer'),
        children: [' 第 ',
          PageNumber.CURRENT,
          ...(pageNumber === 'total' ? [' / ',
            PageNumber.TOTAL_PAGES] : []),
          ' 页'] })])] })] }) },
    children: body.doc,
  }] })
  return { bytes: await applyHeadingRestartRules(await Packer.toBuffer(document), values),
    assetHash: hashAssets(assets),
    html: `<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><body style="margin:0;padding:${num('page.top')}mm ${num('page.right')}mm ${num('page.bottom')}mm ${num('page.left')}mm;background:white;color:black"><header style="${style('header')}">${escape(headerText)}</header>${body.html}<footer style="${style('footer')}">${escape(footerText)}${pageNumber === 'none' ? '' : ' 第 1 页（示例页码）'}</footer></body></html>` }
}
