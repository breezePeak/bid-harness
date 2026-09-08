/** 直接读取 DOCX 的 XML 样式与段落变体；旧正文只保留限长候选样本。 */
import JSZip from 'jszip'
import { xml2js } from 'xml-js'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DocxFormatState, FormatCandidate, FormatValues } from './docx-format-contract.ts'
interface XmlNode {
  type?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
  elements?: XmlNode[]
}
const local = (name = ''): string => name.slice(name.lastIndexOf(':') + 1)
const children = (node: XmlNode, name: string): XmlNode[] => (node.elements ?? []).filter(item => local(item.name) === name)
const child = (node: XmlNode, name: string): XmlNode => children(node, name)[0] ?? {}
const attr = (node: XmlNode,
  name: string): string | undefined => Object.entries(node.attributes ?? {}).find(([key]) => local(key) === name)?.[1]
const val = (node: XmlNode, name: string): string | undefined => attr(child(node, name), 'val')
function descendants(node: XmlNode,
  name: string): XmlNode[] { return (node.elements ?? []).flatMap(item => [...(local(item.name) === name ? [item] : []),
  ...descendants(item,
    name)]) }
function text(node: XmlNode): string { return node.type === 'text' ? node.text ?? '' : (node.elements ?? []).map(text).join('') }
/**
 * 读取有界 DOCX XML，不解压到磁盘、不访问外部关系。
 * @param bytes 原始 ZIP 字节，最多 10 MiB。
 * @returns XML 部件；无效 ZIP、活动内容及解压超限均拒绝。
 */
export async function readDocxXml(bytes: Uint8Array): Promise<Record<string, XmlNode>> {
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024)
    throw new Error('DOCX 文件必须小于 10 MiB 且不能为空。')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  }
  catch {
    throw new Error('文件不是有效的 DOCX ZIP。')
  }
  const entries = Object.values(zip.files)
  if (entries.length > 2000)
    throw new Error('DOCX 部件数量超过限制。')
  let total = 0
  const result: Record<string, XmlNode> = {}
  for (const entry of entries) {
    if (entry.dir)
      continue
    if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name
            || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..'))
      throw new Error('DOCX 包含不安全路径。')
    if (/vbaProject|activeX|embeddings\//iu.test(entry.name))
      throw new Error('不支持包含宏、活动控件或嵌入文件的模板。')
    const chunks: Buffer[] = []
    for await (const chunk of new Readable().wrap(entry.nodeStream('nodebuffer'))) {
      const buffer = Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > 32 * 1024 * 1024)
        throw new Error('DOCX 解压后超过 32 MiB 限制。')
      if (/\.(xml|rels)$/u.test(entry.name))
        chunks.push(buffer)
    }
    if (!/\.(xml|rels)$/u.test(entry.name))
      continue
    const xml = Buffer.concat(chunks).toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
      throw new Error('DOCX XML 不允许 DTD 或实体声明。')
    try {
      result[entry.name] = xml2js(xml, { compact: false }) as XmlNode
    }
    catch {
      throw new Error(`DOCX XML 无效：${entry.name}`)
    }
  }
  const document = result['word/document.xml'] ? descendants(result['word/document.xml'], 'document') : []
  const root = document[0]
  const prefix = root?.name?.includes(':') ? `:${root.name.split(':')[0]}` : ''
  const namespace = root?.attributes?.[`xmlns${prefix}`]
  const mainType = descendants(result['[Content_Types].xml'] ?? {},
    'Override').find(node => attr(node,
    'PartName') === '/word/document.xml')
  if (document.length !== 1 || !['http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main'].includes(namespace ?? '') || attr(mainType ?? {},
    'ContentType') !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    throw new Error('缺少有效的 Word 文档结构。')
  return result
}
function paragraphFormat(node: XmlNode): FormatValues {
  const p = child(node, 'pPr'), r = child(node, 'rPr')
  const values: FormatValues = {}
  const number = (key: string, raw: string | undefined, divisor: number): void => { if (raw !== undefined && Number.isFinite(Number(raw)))
    values[key] = Number(raw) / divisor }
  const fonts = child(r, 'rFonts')
  const eastAsia = attr(fonts, 'eastAsia')
  if (eastAsia)
    values.font = eastAsia
  const ascii = attr(fonts, 'ascii')
  if (ascii)
    values.latinFont = ascii
  number('size', val(r, 'sz'), 2)
  for (const [key,
    owner,
    tag] of [['bold',
      r,
      'b'],
    ['pageBreak',
      p,
      'pageBreakBefore'],
    ['keepNext',
      p,
      'keepNext'],
    ['keepLines',
      p,
      'keepLines']] as const) {
    if (children(owner, tag).length)
      values[key] = !['0', 'false', 'off'].includes(val(owner, tag) ?? '1')
  }
  const alignment = val(p, 'jc')
  if (alignment && ['left', 'center', 'right', 'both'].includes(alignment))
    values.alignment = alignment
  number('firstLine', attr(child(p, 'ind'), 'firstLine'), 1440 / 25.4)
  const spacing = child(p, 'spacing')
  const rule = attr(spacing, 'lineRule') ?? 'auto'
  if (attr(spacing, 'line')) {
    values.lineRule = rule
    number('line', attr(spacing, 'line'), rule === 'auto' ? 240 : 20)
  }
  number('before', attr(spacing, 'before'), 20)
  number('after', attr(spacing, 'after'), 20)
  return values
}
/**
 * 从继承样式与直接格式生成候选；同角色多个变体必须由用户映射。
 * @param bytes 原始 DOCX。
 * @param name 浏览器显示名称，不参与路径选择。
 * @returns 可保存的模板解析结果。
 */
export async function parseDocxTemplate(bytes: Uint8Array, name: string): Promise<NonNullable<DocxFormatState['template']>> {
  const files = await readDocxXml(bytes)
  const styles = files['word/styles.xml'] ?? {}
  const doc = files['word/document.xml'] as XmlNode
  const defaults = descendants(styles, 'docDefaults')[0] ?? {}
  const defaultFormat = paragraphFormat({ elements: [...descendants(defaults, 'pPr'), ...descendants(defaults, 'rPr')] })
  const styleNodes = new Map(descendants(styles, 'style').map(node => [attr(node, 'styleId') ?? '', node]))
  const resolved = new Map<string, FormatValues>()
  const resolveStyle = (id: string, visiting = new Set<string>()): FormatValues => {
    const cached = resolved.get(id)
    if (cached)
      return cached
    if (visiting.has(id))
      throw new Error('模板样式存在循环继承。')
    const node = styleNodes.get(id)
    if (!node)
      throw new Error(`模板引用不存在的样式：${id}`)
    visiting.add(id)
    const base = val(node, 'basedOn')
    const value = { ...(base ? resolveStyle(base, visiting) : defaultFormat), ...paragraphFormat(node) }
    visiting.delete(id)
    resolved.set(id, value)
    return value
  }
  const candidates: FormatCandidate[] = []
  const roleOf = (id: string, visiting = new Set<string>()): string | undefined => {
    if (visiting.has(id))
      return undefined
    visiting.add(id)
    const node = styleNodes.get(id) ?? {}
    const level = val(child(node, 'pPr'), 'outlineLvl')
    if (level !== undefined && Number(level) < 6)
      return `heading${Number(level) + 1}`
    const styleName = (val(node, 'name') ?? id).toLowerCase().replaceAll(' ', '')
    if (/^(title|标题)$/u.test(styleName))
      return 'title'
    if (/^(normal|正文|bodytext)$/u.test(styleName))
      return 'body'
    const heading = /^(?:heading|标题)([1-6])$/u.exec(styleName)
    if (heading)
      return `heading${heading[1]}`
    const base = val(node, 'basedOn')
    const inheritedRole = base ? roleOf(base, visiting) : undefined
    return inheritedRole?.startsWith('heading') ? inheritedRole : undefined
  }
  for (const [id, node] of styleNodes) {
    if (attr(node, 'type') !== 'paragraph')
      continue
    candidates.push({ id,
      name: val(node,
        'name') ?? id,
      sample: '',
      values: resolveStyle(id),
      ...(roleOf(id) ? { role: roleOf(id) } : {}) })
  }
  const defaultStyle = [...styleNodes].find(([, node]) => attr(node, 'type') === 'paragraph' && attr(node, 'default') === '1')?.[0]
  for (const p of descendants(doc, 'p')) {
    const id = val(child(p, 'pPr'), 'pStyle') ?? defaultStyle
    const base = id ? resolveStyle(id) : defaultFormat
    const runs = children(p, 'r')
    const variants = runs.map((run) => {
      const characterStyle = val(child(run, 'rPr'), 'rStyle')
      return { ...base, ...(characterStyle ? resolveStyle(characterStyle) : {}), ...paragraphFormat(p), ...paragraphFormat(run) }
    })
    if (!variants.length)
      variants.push({ ...base, ...paragraphFormat(p) })
    for (const values of variants) {
      const signature = JSON.stringify(values)
      const found = candidates.find(item => JSON.stringify(item.values) === signature && item.role === (id ? roleOf(id) : undefined))
      if (found) {
        if (!found.sample)
          found.sample = text(p).slice(0, 160)
        continue
      }
      const candidateId = `direct-${createHash('sha256').update(`${id ?? ''}:${signature}`).digest('hex').slice(0, 16)}`
      if (!candidates.some(item => item.id === candidateId))
        candidates.push({ id: candidateId,
          name: `${id ?? '手动排版'}（直接格式）`,
          sample: text(p).slice(0,
            160),
          values,
          ...(id && roleOf(id) ? { role: roleOf(id) } : {}) })
    }
    if (candidates.length > 200)
      throw new Error('模板格式变体超过 200 个，请使用精简样式模板。')
  }
  const values: FormatValues = {}
  const warnings: string[] = []
  const sections = descendants(doc, 'sectPr')
  const section = sections.at(-1) ?? {}
  const size = child(section, 'pgSz')
  const width = Number(attr(size, 'w')), height = Number(attr(size, 'h'))
  const short = Math.min(width, height), long = Math.max(width, height)
  if (Math.abs(short - 11906) < 40 && Math.abs(long - 16838) < 40)
    values['page.paper'] = 'A4'
  else if (Math.abs(short - 16838) < 40 && Math.abs(long - 23811) < 40)
    values['page.paper'] = 'A3'
  else if (Math.abs(short - 12240) < 40 && Math.abs(long - 15840) < 40)
    values['page.paper'] = 'Letter'
  else
    warnings.push('纸张尺寸未识别，请手动选择；默认补充 A4。')
  if (width && height)
    values['page.orientation'] = width > height ? 'landscape' : 'portrait'
  for (const key of ['top', 'bottom', 'left', 'right', 'header', 'footer']) {
    const raw = attr(child(section, 'pgMar'), key)
    if (raw !== undefined)
      values[`page.${key}`] = Math.round(Number(raw) / (1440 / 25.4) * 100) / 100
  }
  const paragraphCandidates = (part: XmlNode, role: string, label: string): void => {
    for (const p of descendants(part, 'p')) {
      const id = val(child(p, 'pPr'), 'pStyle') ?? defaultStyle
      const firstRun = children(p, 'r')[0] ?? {}
      const actual = { ...(id ? resolveStyle(id) : defaultFormat), ...paragraphFormat(p), ...paragraphFormat(firstRun) }
      const candidateId = `${role}-${createHash('sha256').update(JSON.stringify(actual)).digest('hex').slice(0, 16)}`
      if (!candidates.some(item => item.id === candidateId))
        candidates.push({ id: candidateId, name: label, sample: text(p).slice(0, 160), values: actual, role })
    }
  }
  for (const [path, part] of Object.entries(files)) {
    if (/^word\/header\d*\.xml$/u.test(path))
      paragraphCandidates(part, 'header', '页眉格式（文字不复制）')
    if (/^word\/footer\d*\.xml$/u.test(path)) {
      paragraphCandidates(part, 'footer', '页脚格式（文字不复制）')
      const instructions = descendants(part, 'instrText').map(text).join(' ')
      const fields = descendants(part, 'fldSimple').map(node => attr(node, 'instr') ?? '').join(' ')
      if (/\bNUMPAGES\b/u.test(instructions + fields))
        values['footer.pageNumber'] = 'total'
      else if (/\bPAGE\b/u.test(instructions + fields))
        values['footer.pageNumber'] = 'current'
    }
  }
  for (const [id, node] of styleNodes) {
    const name = val(node, 'name') ?? id
    const role = /^(?:figurecaption|图题|图片题注)$/iu.test(name.replaceAll(' ',
      '')) ? 'figureCaption' : /^(?:tablecaption|表题|表格题注)$/iu.test(name.replaceAll(' ',
        '')) ? 'tableCaption' : undefined
    if (role) {
      const candidate = candidates.find(item => item.id === id)
      if (candidate)
        candidate.role = role
    }
  }
  const tables = descendants(doc, 'tbl')
  const tableFormats: FormatValues[] = []
  for (const table of tables) {
    const styleId = val(child(table, 'tblPr'), 'tblStyle')
    const style = styleId ? styleNodes.get(styleId) : undefined
    if (styleId && !style)
      throw new Error(`表格引用不存在的样式：${styleId}`)
    const properties = child(table, 'tblPr')
    const border = child(child(properties,
      'tblBorders'),
    'top').name ? child(child(properties,
        'tblBorders'),
      'top') : child(child(child(style ?? {},
        'tblPr'),
      'tblBorders'),
      'top')
    const format: FormatValues = {}
    const borderStyle = attr(border, 'val')
    if (borderStyle && ['single', 'nil', 'double', 'dashed'].includes(borderStyle))
      format['table.border'] = borderStyle
    if (attr(border, 'sz'))
      format['table.borderSize'] = Number(attr(border, 'sz')) / 8
    const tableWidth = child(properties, 'tblW')
    if (attr(tableWidth, 'type') === 'pct')
      format['table.width'] = Number(attr(tableWidth, 'w')) / 50
    else if (attr(tableWidth, 'type') === 'dxa' && width)
      format['table.width'] = Math.min(100,
        Number(attr(tableWidth,
          'w')) / (width - Number(attr(child(section,
          'pgMar'),
        'left') ?? 0) - Number(attr(child(section,
          'pgMar'),
        'right') ?? 0)) * 100)
    else
      warnings.push('表格自动宽度无法精确投影，使用可编辑的页面百分比宽度。')
    const rows = children(table, 'tr')
    for (const [index, row] of rows.entries()) {
      const look = child(properties, 'tblLook')
      const isHeader = children(child(row,
        'trPr'),
      'tblHeader').length > 0 || index === 0 && (attr(look,
        'firstRow') === '1' || (parseInt(attr(look,
        'val') ?? '0',
      16) & 32) !== 0)
      const role = isHeader ? 'tableHeader' : 'tableCell'
      const region = descendants(style ?? {}, 'tblStylePr').find(item => attr(item, 'type') === (isHeader ? 'firstRow' : 'wholeTable'))
      const inherited = styleId ? resolveStyle(styleId) : defaultFormat
      for (const cell of children(row, 'tc')) {
        const shading = child(child(cell, 'tcPr'), 'shd')
        const fill = attr(shading, 'fill') ?? attr(child(child(region ?? {}, 'tcPr'), 'shd'), 'fill')
        if (isHeader && fill && /^[a-f\d]{6}$/iu.test(fill))
          format['table.fill'] = fill
        for (const p of children(cell, 'p')) {
          const actual = { ...inherited,
            ...paragraphFormat(region ?? {}),
            ...paragraphFormat(p),
            ...paragraphFormat(children(p,
              'r')[0] ?? {}) }
          const candidateId = `${role}-${createHash('sha256').update(JSON.stringify(actual)).digest('hex').slice(0, 16)}`
          if (!candidates.some(item => item.id === candidateId))
            candidates.push({ id: candidateId, name: isHeader ? '表头文字' : '单元格文字', role, sample: text(p).slice(0, 160), values: actual })
        }
      }
    }
    tableFormats.push(format)
  }
  if (tableFormats.length && tableFormats.every(item => JSON.stringify(item) === JSON.stringify(tableFormats[0])))
    Object.assign(values, tableFormats[0])
  else if (tableFormats.length)
    warnings.push('多个表格的边框、底色或宽度不同，待确认：请手动设置统一表格格式。')
  const numbering = files['word/numbering.xml'] ?? {}
  const abstractNums = descendants(numbering, 'abstractNum')
  const nums = descendants(numbering, 'num')
  for (const abstract of abstractNums) {
    for (const level of children(abstract, 'lvl')) {
      const styleId = val(level, 'pStyle')
      const levelIndex = Number(attr(level, 'ilvl'))
      const actualParagraph = descendants(doc, 'p').find((p) => {
        const numPr = child(child(p, 'pPr'), 'numPr')
        const num = nums.find(item => attr(item, 'numId') === val(numPr, 'numId'))
        return num && val(num, 'abstractNumId') === attr(abstract, 'abstractNumId') && Number(val(numPr, 'ilvl') ?? 0) === levelIndex
      })
      const paragraphStyle = actualParagraph ? val(child(actualParagraph, 'pPr'), 'pStyle') : undefined
      const linkedStyle = [...styleNodes].find(([, node]) => {
        const numPr = child(child(node, 'pPr'), 'numPr')
        const num = nums.find(item => attr(item, 'numId') === val(numPr, 'numId'))
        return num && val(num, 'abstractNumId') === attr(abstract, 'abstractNumId') && Number(val(numPr, 'ilvl') ?? 0) === levelIndex
      })?.[0]
      const role = styleId ? roleOf(styleId) : paragraphStyle ? roleOf(paragraphStyle) : linkedStyle ? roleOf(linkedStyle) : undefined
      if (!role?.startsWith('heading'))
        continue
      const depth = Number(role.slice(7))
      const format = val(level, 'numFmt'), pattern = val(level, 'lvlText')
      if (!format || !['decimal',
        'upperRoman',
        'lowerRoman',
        'upperLetter',
        'lowerLetter',
        'chineseCounting'].includes(format) || !pattern || depth !== levelIndex + 1) {
        warnings.push(`${role} 模板编号不受支持，请手动设置编号结构。`)
        continue
      }
      if (values[`numbering.${depth}.text`] && values[`numbering.${depth}.text`] !== pattern) {
        warnings.push(`${role} 存在多个编号变体，待确认：请手动选择编号。`)
        continue
      }
      values['numbering.mode'] = 'template'
      values[`numbering.${depth}.format`] = format
      values[`numbering.${depth}.text`] = pattern
      values[`numbering.${depth}.start`] = Number(val(level, 'start') ?? 1)
      values[`numbering.${depth}.restart`] = val(level, 'lvlRestart') !== '0'
    }
  }
  if (descendants(numbering, 'lvlOverride').length) warnings.push('检测到局部编号覆盖，未自动套用；请核对各级起始序号和重新编号设置。')
  if (descendants(doc, 'sdt').length) warnings.push('检测到内容控件或占位符：仅提取格式，不执行完整套版。')
  if (descendants(doc, 'gridSpan').length || descendants(doc, 'vMerge').length) warnings.push('模板合并单元格不复制；输出表格结构由当前正文决定。')
  if (descendants(styles, 'rFonts').some(node => Object.keys(node.attributes ?? {}).some(key => /Theme$/iu.test(key)))) warnings.push('检测到主题字体引用：未解析的字体使用默认补充，请核对中英文字体。')
  if (sections.length > 1)
    warnings.push('检测到多分节：仅应用末节页面样式，不复刻多分节版式。')
  for (const tag of ['txbxContent', 'anchor', 'pict', 'drawing'])
    if (descendants(doc, tag).length)
      warnings.push(`检测到 ${tag} 对象：模板封面、Logo、浮动对象和图片不复制到输出。`)
  if (files['word/numbering.xml'])
    warnings.push('编号只在导出层显示一次，按确认目录顺序生成；未关联标题用途的编号不自动映射。')
  if (candidates.length > 200)
    throw new Error('模板格式变体超过 200 个，请使用精简样式模板。')
  warnings.push('仅套用格式；旧正文、目录、批注和页眉页脚文字均不复制。')
  return { hash: createHash('sha256').update(bytes).digest('hex'), name, candidates, values, warnings }
}
