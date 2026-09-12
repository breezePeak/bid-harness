/** Word 样式字段与合并；DOCX 和浏览器预览读取同一组生效值。 */
import { z } from 'zod'
import { DOCX_TEMPLATE_MAX_BYTES } from './docx-format-contract.ts'
import type { DocxFormatState, DocxFormatView, FormatEvidence, FormatField, FormatRole, FormatValue, FormatValues } from './docx-format-contract.ts'
/** 当前标书内容可映射的独立格式角色。 */
export const FORMAT_ROLES: FormatRole[] = ['title',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'body',
  'tableHeader',
  'tableCell',
  'figureCaption',
  'tableCaption',
  'header',
  'footer'] as const
const roleLabels = ['文档标题', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题', '正文', '表头', '单元格', '图题', '表题', '页眉', '页脚']
const CHINESE_SIZE_PT: Readonly<Record<string, number>> = {
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
  小六: 6.5,
  七号: 5.5,
  八号: 5,
}
type FormatNumberUnit = 'pt' | 'mm' | 'chars' | 'multiple' | 'lines' | 'percent'
interface NormalizedFormatNumber {
  value: number
  unit?: FormatNumberUnit
}
const numericValue = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(pt|磅|mm|毫米|字符|字|倍|行|%)?$/iu
const formatValueSchemas = new WeakMap<FormatField[], z.ZodType>()

function normalizeFormatNumber(key: string, value: unknown): NormalizedFormatNumber | undefined {
  if (typeof value === 'number') return { value }
  if (typeof value !== 'string') return undefined
  const source = value.trim()
  if (key.endsWith('.size')) {
    const withoutSuffix = source.endsWith('字') ? source.slice(0, -1) : source
    const named = CHINESE_SIZE_PT[withoutSuffix] ?? CHINESE_SIZE_PT[withoutSuffix.endsWith('号') ? withoutSuffix.slice(0, -1) : withoutSuffix]
    if (named !== undefined) return { value: named, unit: 'pt' }
  }
  const match = numericValue.exec(source)
  if (!match) return undefined
  const number = Number(match[1])
  if (!Number.isFinite(number)) return undefined
  const unit = match[2]?.toLowerCase()
  if (unit === undefined) return { value: number }
  if ((unit === 'pt' || unit === '磅') && (key.endsWith('.size') || key.endsWith('.before')
    || key.endsWith('.after') || key === 'table.borderSize' || key.endsWith('.line')))
    return { value: number, unit: 'pt' }
  if ((unit === 'mm' || unit === '毫米') && (key.startsWith('page.') || key.endsWith('.firstLine')))
    return { value: number, unit: 'mm' }
  if ((unit === '字符' || unit === '字') && key.endsWith('.firstLine')) return { value: number, unit: 'chars' }
  if (unit === '倍' && key.endsWith('.line')) return { value: number, unit: 'multiple' }
  if (unit === '行' && key.endsWith('.line')) return { value: number, unit: 'lines' }
  if (unit === '行' && number === 0 && (key.endsWith('.before') || key.endsWith('.after'))) return { value: 0 }
  if (unit === '%' && key === 'table.width') return { value: number, unit: 'percent' }
  return undefined
}

/**
 * 把所有格式来源的数值表达转换为字段 Schema 使用的数值和单位枚举。
 * @param values 浏览器、模型、DOCX 提取结果或磁盘配置中的字段对象。
 * @param fields 当前部署的格式定义。
 * @returns 保留未知字段、但已转换已知数值字段的对象；严格校验仍由 validateFormatValues 完成。
 */
export function normalizeFormatValues(values: unknown, fields: FormatField[]): unknown {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return values
  const definitions = new Map(fields.map(field => [field.key, field]))
  const normalized: Record<string, unknown> = {}
  const inferred = new Map<string, string>()
  for (const [key, value] of Object.entries(values)) {
    const field = definitions.get(key)
    if (field === undefined || typeof field.value !== 'number') {
      normalized[key] = value
      continue
    }
    const number = normalizeFormatNumber(key, value)
    normalized[key] = number?.value ?? value
    if ((number?.unit === 'chars' || number?.unit === 'mm') && key.endsWith('.firstLine'))
      inferred.set(key.replace(/\.firstLine$/u, '.firstLineUnit'), number.unit)
    else if (number?.unit === 'pt') {
      if (key.endsWith('.line')) inferred.set(key.replace(/\.line$/u, '.lineRule'), 'exact')
    } else if (number?.unit === 'multiple' || number?.unit === 'lines') {
      inferred.set(key.replace(/\.line$/u, '.lineRule'), 'auto')
    }
  }
  for (const [key, value] of inferred) {
    if (normalized[key] === undefined) normalized[key] = value
    else if (normalized[key] !== value) throw new Error(`格式配置无效：${key}`)
  }
  return normalized
}
/**
 * 建立导出支持的字段与默认值。
 * @param defaults 项目原有字体及半磅字号配置。
 * @returns 可编辑字段，字号使用磅，首行缩进可选择字符或毫米，其他距离使用毫米。
 */
export function formatFields(defaults: {
  font: string
  bodySize: number
  headingSize: number
}): FormatField[] {
  const fields: FormatField[] = []
  const add = (key: string,
    group: string,
    label: string,
    value: string | number | boolean,
    options?: string[],
    min = 0,
    max = 1000): void => {
    fields.push({ key, group, label, value, ...(options ? { options } : {}), ...(typeof value === 'number' ? { min, max } : {}) })
  }
  add('page.paper', '页面设置', '纸张', 'A4', ['A4', 'A3', 'Letter'])
  add('page.orientation', '页面设置', '方向', 'portrait', ['portrait', 'landscape'])
  for (const [key,
    label,
    value] of [['top',
      '上边距',
      25.4],
    ['bottom',
      '下边距',
      25.4],
    ['left',
      '左边距',
      25.4],
    ['right',
      '右边距',
      25.4],
    ['header',
      '页眉距离',
      12.7],
    ['footer',
      '页脚距离',
      12.7]] as const)
    add(`page.${key}`, '页面设置', `${label}（毫米）`, value, undefined, 0, 100)
  FORMAT_ROLES.forEach((role, index) => {
    const label = roleLabels[index] as string
    const group = role === 'body' ? '正文' : role === 'header' || role === 'footer' ? '页眉页脚' : role.startsWith('table') || role === 'figureCaption' ? '表格与图表说明' : '标题'
    const title = role === 'title' || role.startsWith('heading')
    add(`${role}.font`, group, `${label}中文字体`, defaults.font)
    add(`${role}.latinFont`, group, `${label}西文字体`, 'Times New Roman')
    add(`${role}.size`, group, `${label}字号（磅）`, (title ? defaults.headingSize : defaults.bodySize) / 2, undefined, 5, 96)
    add(`${role}.bold`, group, `${label}加粗`, title || role === 'tableHeader')
    add(`${role}.italics`, group, `${label}斜体`, false)
    add(`${role}.color`, group, `${label}文字颜色（十六进制）`, '000000')
    add(`${role}.alignment`,
      group,
      `${label}对齐`,
      role === 'title' || role === 'footer' ? 'center' : 'left',
      ['left',
        'center',
        'right',
        'both'])
    add(`${role}.firstLineUnit`, group, `${label}首行缩进单位`, role === 'body' ? 'chars' : 'mm', ['mm', 'chars'])
    add(`${role}.firstLine`, group, `${label}首行缩进`, role === 'body' ? 2 : 0, undefined, 0, 100)
    add(`${role}.lineRule`, group, `${label}行距类型`, 'auto', ['auto', 'exact', 'atLeast'])
    add(`${role}.line`, group, `${label}行距（倍数或磅）`, 1.5, undefined, 0.5, 100)
    add(`${role}.before`, group, `${label}段前（磅）`, 0, undefined, 0, 100)
    add(`${role}.after`, group, `${label}段后（磅）`, 8, undefined, 0, 100)
    add(`${role}.pageBreak`, group, `${label}段前分页`, false)
    add(`${role}.keepNext`, group, `${label}与下段同页`, title)
    add(`${role}.keepLines`, group, `${label}段中不分页`, title)
  })
  add('numbering.mode', '标题编号', '编号形式（确认目录的层级和顺序）', 'decimal', ['decimal', 'template', 'none'])
  for (let level = 1; level <= 6; level++) {
    add(`numbering.${level}.format`,
      '标题编号',
      `${level} 级数字形式`,
      'decimal',
      ['decimal',
        'upperRoman',
        'lowerRoman',
        'upperLetter',
        'lowerLetter',
        'chineseCounting'])
    add(`numbering.${level}.text`,
      '标题编号',
      `${level} 级编号结构（%1 为一级序号）`,
      Array.from({ length: level },
        (_,
          index) => `%${index + 1}`).join('.'))
    add(`numbering.${level}.start`, '标题编号', `${level} 级起始序号`, 1, undefined, 1, 999)
    add(`numbering.${level}.restart`, '标题编号', `${level} 级随父级重新编号`, true)
  }
  add('table.border', '表格与图表说明', '边框', 'single', ['single', 'nil', 'double', 'dashed'])
  add('table.borderSize', '表格与图表说明', '边框粗细（磅）', 0.5, undefined, 0, 8)
  add('table.fill', '表格与图表说明', '表头底色（十六进制）', 'EEEEEE')
  add('table.width', '表格与图表说明', '表格宽度（页面百分比）', 100, undefined, 10, 100)
  for (const [role, label, prefix] of [['figureCaption', '图题', '图'], ['tableCaption', '表题', '表']] as const) {
    add(`${role}.numbering.prefix`, '表格与图表说明', `${label}编号前缀`, prefix)
    add(`${role}.numbering.format`, '表格与图表说明', `${label}编号形式`, 'decimal', ['decimal',
      'upperRoman',
      'lowerRoman',
      'upperLetter',
      'lowerLetter',
      'chineseCounting'])
    add(`${role}.numbering.prefixIndexSeparator`, '表格与图表说明', `${label}前缀与序号分隔符`, '')
    add(`${role}.numbering.indexTitleSeparator`, '表格与图表说明', `${label}序号与标题分隔符`, ' ')
  }
  add('header.text', '页眉页脚', '页眉文字（留空使用当前文档标题）', '')
  add('footer.text', '页眉页脚', '页脚文字', '')
  add('footer.pageNumber', '页眉页脚', '页码形式', 'current', ['none', 'current', 'total'])
  return fields
}
/**
 * 严格检查来自浏览器、模型建议或磁盘的格式覆盖。
 * @param values 未信任的字段对象。
 * @param fields 当前部署的格式定义。
 * @returns 合法字段；未知字段及越界值会抛出中文错误。
 */
export function validateFormatValues(values: unknown, fields: FormatField[]): FormatValues {
  let schema = formatValueSchemas.get(fields)
  if (schema === undefined) {
    const schemas = Object.fromEntries(fields.map(field => [field.key,
      typeof field.value === 'number' ? z.number().min(field.min ?? 0).max(field.max ?? 1000).optional()
        : typeof field.value === 'boolean' ? z.boolean().optional()
          : (field.options ? z.enum(field.options as [
            string,
            ...string[],
          ]) : z.string().max(200)).optional(),
    ]))
    schema = z.strictObject(schemas)
    formatValueSchemas.set(fields, schema)
  }
  const parsed = schema.safeParse(normalizeFormatValues(values, fields))
  if (!parsed.success)
    throw new Error(`格式配置无效：${parsed.error.issues.map(issue => issue.path.join('.')).join('、')}`)
  const result = parsed.data as FormatValues
  for (const [key, value] of Object.entries(result))
    if (/\.(?:font|latinFont)$/u.test(key) && !/^[^<>;"{}\\\r\n]{1,100}$/u.test(String(value)))
      throw new Error('字体名称不能为空或包含控制字符、样式语句。')
    else if (key.endsWith('.color') && !/^[\da-f]{6}$/iu.test(String(value)))
      throw new Error('文字颜色必须为六位十六进制颜色。')
  if (result['table.fill'] !== undefined && !/^[\da-f]{6}$/iu.test(String(result['table.fill'])))
    throw new Error('表头底色必须为六位十六进制颜色。')
  for (let level = 1; level <= 6; level++) {
    const pattern = result[`numbering.${level}.text`]
    if (pattern !== undefined && (String(pattern).length > 80 || !String(pattern).includes(`%${level}`) || /%(?![1-6])/u.test(String(pattern)) || [...String(pattern).matchAll(/%([1-6])/gu)].some(match => Number(match[1]) > level)))
      throw new Error(`${level} 级编号结构必须包含本级序号且不能引用下级。`)
    const start = result[`numbering.${level}.start`]
    if (start !== undefined && !Number.isInteger(start))
      throw new Error('起始序号必须为整数。')
  }
  return result
}
const evidencePriority: Record<FormatEvidence['source'], number> = {
  system_default: 0,
  doc_defaults: 1,
  theme: 2,
  named_style: 3,
  direct_format: 4,
  template_instruction: 5,
  user_requirement: 6,
  user_confirmed: 7,
}
const evidenceValue = (value: FormatValue): string => `${typeof value}:${String(value)}`

/**
 * 创建尚未上传模板的完整默认状态。
 * @param fields 当前部署的字段定义。
 * @returns 可直接供预览和导出读取的 resolved 状态。
 */
export function defaultDocxFormatState(fields: FormatField[]): DocxFormatState {
  return {
    version: 2,
    revision: 0,
    opened: false,
    extracted: { values: {}, candidates: [], paragraphs: [], evidence: [], warnings: [] },
    modelInterpreted: { values: {}, mapping: {}, evidence: [] },
    conflicts: [],
    resolved: Object.fromEntries(fields.map(field => [field.key, field.value])),
    userConfirmed: {},
  }
}

function normalizeEvidence(item: FormatEvidence, key: string, fields: FormatField[]): FormatEvidence {
  const value = validateFormatValues({ [key]: item.value }, fields)[key]
  if (value === undefined) throw new Error(`格式配置无效：${key}`)
  return { ...item, key, value }
}

function normalizeCandidate(candidate: DocxFormatState['extracted']['candidates'][number], fields: FormatField[]): DocxFormatState['extracted']['candidates'][number] {
  const role = candidate.roles[0] ?? 'body'
  const values = Object.fromEntries(Object.entries(validateFormatValues(Object.fromEntries(
    Object.entries(candidate.values).map(([key, value]) => [`${role}.${key}`, value]),
  ), fields)).map(([key, value]) => [key.slice(role.length + 1), value]))
  const evidence = candidate.evidence.map((item) => {
    const normalized = normalizeEvidence(item, `${role}.${item.key}`, fields)
    return { ...normalized, key: item.key }
  })
  return { ...candidate, values, evidence }
}

function candidateEvidence(candidate: DocxFormatState['extracted']['candidates'][number], role: FormatRole, fields: FormatField[]): FormatEvidence[] {
  const byKey = new Map<string, FormatEvidence[]>()
  for (const evidence of candidate.evidence) {
    const entries = byKey.get(evidence.key) ?? []
    entries.push(evidence)
    byKey.set(evidence.key, entries)
  }
  const values = validateFormatValues(Object.fromEntries(Object.entries(candidate.values).map(([key, value]) => [`${role}.${key}`, value])), fields)
  return Object.entries(values).flatMap(([fullKey, value]) => {
    const key = fullKey.slice(role.length + 1)
    const evidence = byKey.get(key)
    if (evidence?.length) return evidence.map(item => ({ ...normalizeEvidence(item, fullKey, fields), candidateId: candidate.id }))
    return [{ key: fullKey, value, source: 'named_style' as const, text: candidate.name, candidateId: candidate.id }]
  })
}

/**
 * 按证据优先级重建冲突和最终值。
 * @param state 已校验的提取、模型解释及用户确认。
 * @param fields 当前部署的字段定义。
 * @param templateMaxBytes 当前部署允许的模板原始字节数。
 * @returns 保存和展示使用的完整视图；values 与 state.resolved 是同一结果。
 */
export function resolveFormat(state: DocxFormatState, fields: FormatField[], templateMaxBytes = DOCX_TEMPLATE_MAX_BYTES): DocxFormatView {
  const evidence = new Map<string, FormatEvidence[]>()
  const add = (item: FormatEvidence): void => {
    const entries = evidence.get(item.key) ?? []
    entries.push(item)
    evidence.set(item.key, entries)
  }
  for (const field of fields) add({ key: field.key, value: field.value, source: 'system_default' })
  const extractedValues = validateFormatValues(state.extracted.values, fields)
  const extractedEvidence = state.extracted.evidence.map(item => normalizeEvidence(item, item.key, fields))
  const normalizedCandidates = state.extracted.candidates.map(candidate => normalizeCandidate(candidate, fields))
  for (const [key, value] of Object.entries(extractedValues))
    add(extractedEvidence.filter(item => item.key === key)
      .find(item => evidenceValue(item.value) === evidenceValue(value))
      ?? { key, value, source: 'direct_format' })
  for (const role of FORMAT_ROLES) {
    const mapped = state.modelInterpreted.mapping[role]
    const candidates = mapped
      ? normalizedCandidates.filter(candidate => candidate.id === mapped
        || candidate.id.startsWith('direct-') && candidate.roles.includes(role))
      : normalizedCandidates.filter(candidate => candidate.roles.includes(role))
    for (const candidate of candidates)
      for (const item of candidateEvidence(candidate, role, fields)) add(item)
  }
  const interpretedValues = validateFormatValues(state.modelInterpreted.values, fields)
  const interpretedEvidence = state.modelInterpreted.evidence.map(item => normalizeEvidence(item, item.key, fields))
  for (const [key, value] of Object.entries(interpretedValues))
    add(interpretedEvidence.filter(item => item.key === key)
      .find(item => evidenceValue(item.value) === evidenceValue(value))
      ?? { key, value, source: 'template_instruction' })
  const confirmed = validateFormatValues(state.userConfirmed, fields)
  for (const [key, value] of Object.entries(confirmed)) add({ key, value, source: 'user_confirmed' })

  const resolved: FormatValues = {}
  const conflicts = [...evidence].flatMap(([key, entries]) => {
    const ranked = entries.toSorted((left, right) => evidencePriority[right.source] - evidencePriority[left.source])
    const winner = ranked[0]
    if (!winner) return []
    resolved[key] = winner.value
    const meaningful = ranked.filter(item => !['system_default', 'doc_defaults', 'theme', 'user_confirmed'].includes(item.source))
    const values = new Set(meaningful.map(item => evidenceValue(item.value)))
    if (values.size < 2) return []
    return [{ key,
      resolvedValue: winner.value,
      status: key in confirmed ? 'confirmed' as const : 'conflict' as const,
      evidence: meaningful }]
  })
  validateFormatValues(resolved, fields)
  const shortEdge = resolved['page.paper'] === 'A3' ? 297 : resolved['page.paper'] === 'Letter' ? 215.9 : 210
  const longEdge = resolved['page.paper'] === 'A3' ? 420 : resolved['page.paper'] === 'Letter' ? 279.4 : 297
  const pageWidth = resolved['page.orientation'] === 'landscape' ? longEdge : shortEdge
  if (Number(resolved['page.left']) + Number(resolved['page.right']) >= pageWidth)
    throw new Error('左右页边距过大，请缩小边距。')
  const nextState = { ...state,
    extracted: { ...state.extracted, values: extractedValues, candidates: normalizedCandidates, evidence: extractedEvidence },
    modelInterpreted: { ...state.modelInterpreted, values: interpretedValues, evidence: interpretedEvidence },
    userConfirmed: confirmed,
    resolved,
    conflicts }
  return { state: nextState,
    templateMaxBytes,
    fields,
    values: nextState.resolved,
    warnings: ['样式预览，分页以 Word 为准；浏览器和 Word 的字体可用性可能不同。', ...state.extracted.warnings] }
}

/**
 * 从磁盘状态创建视图，不重新解释或合并模板。
 * @param state 已保存且完整校验的状态。
 * @param fields 当前部署的字段定义。
 * @param templateMaxBytes 当前部署允许的模板原始字节数。
 * @returns 仅投影 state.resolved 的视图。
 */
export function viewResolvedFormat(
  state: DocxFormatState,
  fields: FormatField[],
  templateMaxBytes = DOCX_TEMPLATE_MAX_BYTES,
): DocxFormatView {
  const resolved = validateFormatValues(state.resolved, fields)
  if (Object.keys(resolved).length !== fields.length)
    throw new Error('保存的 Word 格式缺少最终确认字段，请重新上传模板。')
  const nextState = { ...state, resolved }
  return { state: nextState, templateMaxBytes, fields, values: resolved,
    warnings: ['样式预览，分页以 Word 为准；浏览器和 Word 的字体可用性可能不同。', ...state.extracted.warnings] }
}
