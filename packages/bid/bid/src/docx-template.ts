/** 直接读取 DOCX 的 XML 样式与段落变体；旧正文只保留限长候选样本。 */
import JSZip from 'jszip'
import { xml2js } from 'xml-js'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { DOCX_TEMPLATE_MAX_BYTES, DOCX_TEMPLATE_PARSER_VERSION } from './docx-format-contract.ts'
import type { FormatCandidate, FormatEvidence, FormatEvidenceSource, FormatRole, FormatValues, ParsedDocxTemplate } from './docx-format-contract.ts'
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
const isFormatXmlPart = (name: string): boolean => name === '[Content_Types].xml'
  || /^word\/(?:document|styles|numbering|header\d+|footer\d+)\.xml$/u.test(name)
  || /^word\/theme\/theme\d*\.xml$/u.test(name)
function descendants(node: XmlNode,
  name: string): XmlNode[] { return (node.elements ?? []).flatMap(item => [...(local(item.name) === name ? [item] : []),
  ...descendants(item,
    name)]) }
function text(node: XmlNode): string { return node.type === 'text' ? node.text ?? '' : (node.elements ?? []).map(text).join('') }
/**
 * 读取有界 DOCX XML，不解压到磁盘、不访问外部关系。
 * @param bytes 原始 ZIP 字节。
 * @param maxBytes 当前部署允许的原始字节数。
 * @returns 格式解析所需 XML 部件；宏、控件、嵌入对象和图片不执行或解压，无效 ZIP、不安全路径及格式 XML 解压超限均拒绝。
 */
export async function readDocxXml(bytes: Uint8Array, maxBytes = DOCX_TEMPLATE_MAX_BYTES): Promise<Record<string, XmlNode>> {
  if (bytes.length === 0 || bytes.length > maxBytes)
    throw new Error(`DOCX 文件必须不超过 ${String(Math.floor(maxBytes / 1024 / 1024))} MiB 且不能为空。`)
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
    if (!isFormatXmlPart(entry.name))
      continue
    const chunks: Buffer[] = []
    for await (const chunk of new Readable().wrap(entry.nodeStream('nodebuffer'))) {
      const buffer = Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > 32 * 1024 * 1024)
        throw new Error('DOCX 格式 XML 解压后超过 32 MiB 限制。')
      chunks.push(buffer)
    }
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
type ThemeFonts = Partial<Record<'majorAscii' | 'majorEastAsia' | 'minorAscii' | 'minorEastAsia', string>>
function readThemeFonts(theme: XmlNode): ThemeFonts {
  const resolve = (family: 'majorFont' | 'minorFont', kind: 'ascii' | 'eastAsia'): string | undefined => {
    const group = descendants(theme, family)[0] ?? {}
    if (kind === 'ascii') return attr(child(group, 'latin'), 'typeface') || undefined
    return attr(child(group, 'ea'), 'typeface')
      || attr(descendants(group, 'font').find(node => ['Hans', 'Hant'].includes(attr(node, 'script') ?? '')) ?? {}, 'typeface')
      || undefined
  }
  return Object.fromEntries([
    ['majorAscii', resolve('majorFont', 'ascii')],
    ['majorEastAsia', resolve('majorFont', 'eastAsia')],
    ['minorAscii', resolve('minorFont', 'ascii')],
    ['minorEastAsia', resolve('minorFont', 'eastAsia')],
  ].filter((entry): entry is [keyof ThemeFonts, string] => entry[1] !== undefined))
}
function themeFont(theme: ThemeFonts, value: string | undefined): string | undefined {
  if (value === 'majorAscii' || value === 'majorHAnsi') return theme.majorAscii
  if (value === 'majorEastAsia') return theme.majorEastAsia
  if (value === 'minorAscii' || value === 'minorHAnsi') return theme.minorAscii
  if (value === 'minorEastAsia') return theme.minorEastAsia
  return undefined
}
function runFormat(r: XmlNode, theme: ThemeFonts): FormatValues {
  const values: FormatValues = {}
  const number = (key: string, raw: string | undefined, divisor: number): void => { if (raw !== undefined && Number.isFinite(Number(raw)))
    values[key] = Number(raw) / divisor }
  const fonts = child(r, 'rFonts')
  const eastAsia = attr(fonts, 'eastAsia') || themeFont(theme, attr(fonts, 'eastAsiaTheme'))
  if (eastAsia)
    values.font = eastAsia
  const ascii = attr(fonts, 'ascii') || attr(fonts, 'hAnsi')
    || themeFont(theme, attr(fonts, 'asciiTheme') ?? attr(fonts, 'hAnsiTheme'))
  if (ascii)
    values.latinFont = ascii
  number('size', val(r, 'sz'), 2)
  const color = val(r, 'color')
  if (color === 'auto') values.color = '000000'
  else if (color && /^[\da-f]{6}$/iu.test(color)) values.color = color
  for (const [key, tag] of [['bold', 'b'], ['italics', 'i']] as const)
    if (children(r, tag).length) values[key] = !['0', 'false', 'off'].includes(val(r, tag) ?? '1')
  return values
}
function paragraphFormat(node: XmlNode, theme: ThemeFonts): FormatValues {
  const p = child(node, 'pPr')
  const values: FormatValues = { ...runFormat(child(p, 'rPr'), theme), ...runFormat(child(node, 'rPr'), theme) }
  const number = (key: string, raw: string | undefined, divisor: number): void => { if (raw !== undefined && Number.isFinite(Number(raw)))
    values[key] = Number(raw) / divisor }
  for (const [key, tag] of [['pageBreak', 'pageBreakBefore'], ['keepNext', 'keepNext'], ['keepLines', 'keepLines']] as const)
    if (children(p, tag).length) values[key] = !['0', 'false', 'off'].includes(val(p, tag) ?? '1')
  const alignment = val(p, 'jc')
  if (alignment && ['left', 'center', 'right', 'both'].includes(alignment))
    values.alignment = alignment
  const indent = child(p, 'ind')
  const firstLineChars = attr(indent, 'firstLineChars')
  number('firstLine', firstLineChars ?? attr(indent, 'firstLine'), firstLineChars === undefined ? 1440 / 25.4 : 100)
  if (values.firstLine !== undefined)
    values.firstLineUnit = firstLineChars === undefined ? 'mm' : 'chars'
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
 * @param maxBytes 当前部署允许的原始字节数。
 * @returns 可保存的完整格式候选；输入受文件与格式 XML 字节上限约束，不按候选数量截断。
 */
export async function parseDocxTemplate(bytes: Uint8Array, name: string, maxBytes = DOCX_TEMPLATE_MAX_BYTES): Promise<ParsedDocxTemplate> {
  const files = await readDocxXml(bytes, maxBytes)
  const styles = files['word/styles.xml'] ?? {}
  const doc = files['word/document.xml'] as XmlNode
  const theme = readThemeFonts(Object.entries(files).find(([path]) => /^word\/theme\/theme\d*\.xml$/u.test(path))?.[1] ?? {})
  const paragraphs = descendants(doc, 'p')
  const tables = descendants(doc, 'tbl')
  const tableParagraphs = new Set(tables.flatMap(table => descendants(table, 'p')))
  const bodyParagraphs = paragraphs.filter(p => !tableParagraphs.has(p))
  const defaults = descendants(styles, 'docDefaults')[0] ?? {}
  const evidenceFor = (values: FormatValues, source: FormatEvidenceSource, sourceText: string): FormatEvidence[] =>
    Object.entries(values).map(([key, value]) => ({ key, value, source, text: sourceText }))
  const defaultFormat: FormatValues = { before: 0, after: 0, bold: false, italics: false, color: '000000',
    ...paragraphFormat({ elements: [...descendants(defaults, 'pPr'), ...descendants(defaults, 'rPr')] }, theme) }
  const defaultFonts = descendants(defaults, 'rFonts')
  const defaultEvidence = evidenceFor(defaultFormat, 'doc_defaults', 'docDefaults').map(item => ({ ...item,
    ...item.key === 'font' && defaultFonts.some(font => attr(font, 'eastAsiaTheme') !== undefined)
      || item.key === 'latinFont' && defaultFonts.some(font => attr(font, 'asciiTheme') !== undefined || attr(font, 'hAnsiTheme') !== undefined)
      ? { source: 'theme' as const, text: 'Word Theme 字体方案' }
      : {} }))
  const styleNodes = new Map(descendants(styles, 'style').map(node => [attr(node, 'styleId') ?? '', node]))
  const resolved = new Map<string, FormatValues>()
  const resolvedEvidence = new Map<string, FormatEvidence[]>()
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
    const inherited = base ? resolveStyle(base, visiting) : defaultFormat
    const own = paragraphFormat(node, theme)
    const value = { ...inherited, ...own }
    const evidence = new Map((base ? resolvedEvidence.get(base) ?? [] : defaultEvidence).map(item => [item.key, item]))
    for (const item of evidenceFor(own, 'named_style', val(node, 'name') ?? id)) evidence.set(item.key, item)
    visiting.delete(id)
    resolved.set(id, value)
    resolvedEvidence.set(id, [...evidence.values()])
    return value
  }
  const candidates: FormatCandidate[] = []
  const candidateById = new Map<string, FormatCandidate>()
  const candidateFormats = new Map<string, FormatCandidate>()
  const formatKey = (values: FormatValues, roles: FormatRole[]): string => JSON.stringify([
    roles.toSorted(), Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
  ])
  const addSample = (candidate: FormatCandidate, sample: string): void => {
    const value = sample.trim().slice(0, 160)
    if (value && !candidate.samples.includes(value) && candidate.samples.length < 8) candidate.samples.push(value)
  }
  const addCandidate = (candidate: FormatCandidate): void => {
    const current = candidateById.get(candidate.id)
    if (current) {
      for (const sample of candidate.samples) addSample(current, sample)
      current.roles = [...new Set([...current.roles, ...candidate.roles])]
      for (const item of candidate.evidence) {
        if (current.evidence.length >= 500) break
        if (!current.evidence.some(existing => existing.key === item.key && existing.source === item.source
          && existing.value === item.value && existing.text === item.text)) current.evidence.push(item)
      }
      candidateFormats.set(formatKey(current.values, current.roles), current)
      return
    }
    candidates.push(candidate)
    candidateById.set(candidate.id, candidate)
    const key = formatKey(candidate.values, candidate.roles)
    if (!candidateFormats.has(key))
      candidateFormats.set(key, candidate)
  }
  const rolesOf = (id: string, visiting = new Set<string>()): FormatRole[] => {
    if (visiting.has(id))
      return []
    visiting.add(id)
    const node = styleNodes.get(id) ?? {}
    const level = val(child(node, 'pPr'), 'outlineLvl')
    if (level !== undefined && Number(level) < 6)
      return [`heading${Number(level) + 1}` as FormatRole]
    const styleName = (val(node, 'name') ?? id).toLowerCase().replaceAll(' ', '')
    if (/^(title|标题)$/u.test(styleName))
      return ['title']
    if (/^(normal|正文|bodytext)$/u.test(styleName))
      return ['body']
    const heading = /^(?:heading|标题)([1-6])$/u.exec(styleName)
    if (heading)
      return [`heading${heading[1]}` as FormatRole]
    if (/^(?:caption|题注)$/iu.test(styleName)) return ['figureCaption', 'tableCaption']
    if (/^(?:figurecaption|图题|图片题注)$/iu.test(styleName)) return ['figureCaption']
    if (/^(?:tablecaption|表题|表格题注)$/iu.test(styleName)) return ['tableCaption']
    const base = val(node, 'basedOn')
    const inherited = base ? rolesOf(base, visiting) : []
    return inherited.filter(role => role.startsWith('heading'))
  }
  const paragraphRoles = (p: XmlNode, id: string | undefined): FormatRole[] => {
    const outlineLevel = val(child(p, 'pPr'), 'outlineLvl')
    const roles = outlineLevel !== undefined && /^[0-5]$/u.test(outlineLevel)
      ? [`heading${Number(outlineLevel) + 1}` as FormatRole]
      : id ? rolesOf(id) : []
    if (roles.includes('figureCaption') && roles.includes('tableCaption')) {
      const sample = text(p).trim()
      if (/^(?:图|figure)\s*[\d一二三四五六七八九十百]+/iu.test(sample)) return ['figureCaption']
      if (/^(?:表|table)\s*[\d一二三四五六七八九十百]+/iu.test(sample)) return ['tableCaption']
    }
    return roles
  }
  const defaultStyle = [...styleNodes].find(([, node]) => attr(node, 'type') === 'paragraph' && attr(node, 'default') === '1')?.[0]
  const usedStyles = new Set(bodyParagraphs.map(p => val(child(p, 'pPr'), 'pStyle') ?? defaultStyle))
  for (const [id, node] of styleNodes) {
    if (attr(node, 'type') !== 'paragraph' || !usedStyles.has(id))
      continue
    addCandidate({ id,
      name: val(node,
        'name') ?? id,
      values: resolveStyle(id),
      roles: rolesOf(id),
      samples: [],
      evidence: resolvedEvidence.get(id) ?? [] })
  }
  for (const p of bodyParagraphs) {
    const id = val(child(p, 'pPr'), 'pStyle') ?? defaultStyle
    const roles = paragraphRoles(p, id)
    const named = id === undefined ? undefined : candidateById.get(id)
    if (named) addSample(named, text(p))
    const base = id ? resolveStyle(id) : defaultFormat
    const baseEvidence = id ? resolvedEvidence.get(id) ?? [] : defaultEvidence
    const runs = children(p, 'r')
    const firstRun = runs.find(run => text(run).trim()) ?? runs[0]
    const directParagraph = paragraphFormat(p, theme)
    const variants = (firstRun ? [firstRun] : []).map((run) => {
      const characterStyle = val(child(run, 'rPr'), 'rStyle')
      const directRun = paragraphFormat(run, theme)
      const values = { ...base, ...(characterStyle ? resolveStyle(characterStyle) : {}), ...directParagraph, ...directRun }
      return { values, direct: { ...directParagraph, ...directRun } }
    })
    if (!variants.length)
      variants.push({ values: { ...base, ...directParagraph }, direct: directParagraph })
    for (const { values, direct } of variants) {
      if (Object.keys(direct).length === 0) continue
      const signature = JSON.stringify(values)
      const found = candidateFormats.get(formatKey(values, roles))
      if (found) {
        addSample(found, text(p))
        continue
      }
      const candidateId = `direct-${createHash('sha256').update(`${id ?? ''}:${signature}`).digest('hex').slice(0, 16)}`
      addCandidate({ id: candidateId,
        name: `${id ?? '手动排版'}（直接格式）`,
        values,
        roles,
        samples: [text(p).trim().slice(0, 160)].filter(Boolean),
        evidence: [...baseEvidence, ...evidenceFor(direct, 'direct_format', text(p).trim().slice(0, 160))] })
    }
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
  const paragraphCandidates = (part: XmlNode, role: FormatRole, label: string): void => {
    for (const p of descendants(part, 'p')) {
      const id = val(child(p, 'pPr'), 'pStyle') ?? defaultStyle
      const firstRun = children(p, 'r')[0] ?? {}
      const base = id ? resolveStyle(id) : defaultFormat
      const baseEvidence = id ? resolvedEvidence.get(id) ?? [] : defaultEvidence
      const direct = { ...paragraphFormat(p, theme), ...paragraphFormat(firstRun, theme) }
      const actual = { ...base, ...direct }
      const candidateId = `${role}-${createHash('sha256').update(JSON.stringify(actual)).digest('hex').slice(0, 16)}`
      addCandidate({ id: candidateId,
        name: label,
        samples: [text(p).trim().slice(0, 160)].filter(Boolean),
        values: actual,
        roles: [role],
        evidence: [...baseEvidence, ...evidenceFor(direct, 'direct_format', text(p).trim())] })
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
      const role: FormatRole = isHeader ? 'tableHeader' : 'tableCell'
      const region = descendants(style ?? {}, 'tblStylePr').find(item => attr(item, 'type') === (isHeader ? 'firstRow' : 'wholeTable'))
      const inherited = styleId ? resolveStyle(styleId) : defaultFormat
      const inheritedEvidence = styleId ? resolvedEvidence.get(styleId) ?? [] : defaultEvidence
      for (const cell of children(row, 'tc')) {
        const shading = child(child(cell, 'tcPr'), 'shd')
        const fill = attr(shading, 'fill') ?? attr(child(child(region ?? {}, 'tcPr'), 'shd'), 'fill')
        if (isHeader && fill && /^[a-f\d]{6}$/iu.test(fill))
          format['table.fill'] = fill
        for (const p of children(cell, 'p')) {
          const direct = { ...paragraphFormat(region ?? {}, theme),
            ...paragraphFormat(p, theme),
            ...paragraphFormat(children(p,
              'r')[0] ?? {}, theme) }
          const actual = { ...inherited, ...direct }
          const candidateId = `${role}-${createHash('sha256').update(JSON.stringify(actual)).digest('hex').slice(0, 16)}`
          addCandidate({ id: candidateId,
            name: isHeader ? '表头文字' : '单元格文字',
            roles: [role],
            samples: [text(p).trim().slice(0, 160)].filter(Boolean),
            values: actual,
            evidence: [...inheritedEvidence, ...evidenceFor(direct, 'direct_format', text(p).trim())] })
        }
      }
    }
    tableFormats.push(format)
  }
  if (tableFormats.length && tableFormats.every(item => JSON.stringify(item) === JSON.stringify(tableFormats[0])))
    Object.assign(values, tableFormats[0])
  else if (tableFormats.length)
    warnings.push('多个表格的边框、底色或宽度不同，待确认：请手动设置统一表格格式。')
  for (const [role, defaultPrefix] of [['figureCaption', '图'], ['tableCaption', '表']] as const) {
    const allSamples = candidates.filter(candidate => candidate.roles.includes(role)).flatMap(candidate => candidate.samples)
    const specificSamples = allSamples.filter(sample => sample.trim().startsWith(defaultPrefix))
    const samples = specificSamples.length ? specificSamples : allSamples
    const parsed = samples.flatMap((sample) => {
      const match = /^([^\d\s]{1,20})(\s*)(\d+)(\s*)/u.exec(sample.trim())
      return match ? [{ prefix: match[1] ?? defaultPrefix, prefixSeparator: match[2] ?? '', titleSeparator: match[4] ?? '' }] : []
    })
    const prefixes = [...new Set(parsed.map(item => item.prefix))]
    const prefixSeparators = [...new Set(parsed.map(item => item.prefixSeparator))]
    const titleSeparators = [...new Set(parsed.map(item => item.titleSeparator))]
    if (prefixes.length === 1) values[`${role}.numbering.prefix`] = prefixes[0] as string
    if (prefixSeparators.length === 1) values[`${role}.numbering.prefixIndexSeparator`] = prefixSeparators[0] as string
    if (titleSeparators.length === 1) values[`${role}.numbering.indexTitleSeparator`] = titleSeparators[0] as string
  }
  const numbering = files['word/numbering.xml'] ?? {}
  const abstractNums = descendants(numbering, 'abstractNum')
  const nums = descendants(numbering, 'num')
  const abstractByNum = new Map<string | undefined, string | undefined>()
  for (const num of nums) {
    const id = attr(num, 'numId')
    if (!abstractByNum.has(id)) abstractByNum.set(id, val(num, 'abstractNumId'))
  }
  const numberingKey = (node: XmlNode): string | undefined => {
    const numPr = child(child(node, 'pPr'), 'numPr')
    const numId = val(numPr, 'numId')
    if (!abstractByNum.has(numId)) return undefined
    return JSON.stringify([abstractByNum.get(numId), Number(val(numPr, 'ilvl') ?? 0)])
  }
  const numberedParagraphs = new Map<string, XmlNode>()
  for (const p of paragraphs) {
    const key = numberingKey(p)
    if (key !== undefined && !numberedParagraphs.has(key)) numberedParagraphs.set(key, p)
  }
  const numberedStyles = new Map<string, string>()
  for (const [id, node] of styleNodes) {
    const key = numberingKey(node)
    if (key !== undefined && !numberedStyles.has(key)) numberedStyles.set(key, id)
  }
  for (const abstract of abstractNums) {
    for (const level of children(abstract, 'lvl')) {
      const styleId = val(level, 'pStyle')
      const levelIndex = Number(attr(level, 'ilvl'))
      const key = JSON.stringify([attr(abstract, 'abstractNumId'), levelIndex])
      const actualParagraph = numberedParagraphs.get(key)
      const paragraphStyle = actualParagraph ? val(child(actualParagraph, 'pPr'), 'pStyle') : undefined
      const linkedStyle = numberedStyles.get(key)
      const role = (styleId ? rolesOf(styleId) : paragraphStyle ? rolesOf(paragraphStyle) : linkedStyle ? rolesOf(linkedStyle) : [])
        .find(item => item.startsWith('heading'))
      if (!role)
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
  if (sections.length > 1)
    warnings.push('检测到多分节：仅应用末节页面样式，不复刻多分节版式。')
  for (const tag of ['txbxContent', 'anchor', 'pict', 'drawing'])
    if (descendants(doc, tag).length)
      warnings.push(`检测到 ${tag} 对象：模板封面、Logo、浮动对象和图片不复制到输出。`)
  if (files['word/numbering.xml'])
    warnings.push('标题使用 Word 原生多级编号，按标题层级自动计数；未关联标题用途的模板编号不自动映射。')
  warnings.push('仅套用格式；旧正文、目录、批注和页眉页脚文字均不复制。')
  const paragraphTexts = bodyParagraphs.map(node => text(node).trim()).filter(Boolean)
  if (paragraphTexts.length > 2000) warnings.push('模板正文超过 2000 段；模型只读取前 2000 段格式说明。')
  return { parserVersion: DOCX_TEMPLATE_PARSER_VERSION,
    hash: createHash('sha256').update(bytes).digest('hex'),
    name,
    extracted: {
      candidates,
      values,
      paragraphs: paragraphTexts.slice(0, 2000).map(value => value.slice(0, 1000)),
      evidence: evidenceFor(values, 'direct_format', 'DOCX 页面、表格或编号属性'),
      warnings,
    } }
}
