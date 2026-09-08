/** Word 样式字段与合并；DOCX 和浏览器预览读取同一组生效值。 */
import { z } from 'zod'
import type { DocxFormatState, DocxFormatView, FormatField, FormatValues, FormatSource } from './docx-format-contract.ts'
/** 当前标书内容可映射的独立格式角色。 */
export const FORMAT_ROLES = ['title',
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
/**
 * 建立导出支持的字段与默认值。
 * @param defaults 项目原有字体及半磅字号配置。
 * @returns 可编辑字段，字号使用磅，距离使用毫米。
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
    add(`${role}.alignment`,
      group,
      `${label}对齐`,
      role === 'title' || role === 'footer' ? 'center' : 'left',
      ['left',
        'center',
        'right',
        'both'])
    add(`${role}.firstLine`, group, `${label}首行缩进（毫米）`, 0, undefined, 0, 100)
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
  const schemas = Object.fromEntries(fields.map(field => [field.key,
    typeof field.value === 'number' ? z.number().min(field.min ?? 0).max(field.max ?? 1000).optional()
      : typeof field.value === 'boolean' ? z.boolean().optional()
        : (field.options ? z.enum(field.options as [
          string,
          ...string[],
        ]) : z.string().max(200)).optional(),
  ]))
  const parsed = z.strictObject(schemas).safeParse(values)
  if (!parsed.success)
    throw new Error(`格式配置无效：${parsed.error.issues.map(issue => issue.path.join('.')).join('、')}`)
  const result = parsed.data as FormatValues
  for (const [key, value] of Object.entries(result))
    if (/\.(?:font|latinFont)$/u.test(key) && !/^[^<>;"{}\\\r\n]{1,100}$/u.test(String(value)))
      throw new Error('字体名称不能为空或包含控制字符、样式语句。')
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
/**
 * 合并默认、模板映射和用户覆盖，保留每个字段的来源。
 * @param state 保存的项目配置。
 * @param fields 可用字段。
 * @returns 生效值、来源和支持范围提示。
 */
export function resolveFormat(state: DocxFormatState, fields: FormatField[]): DocxFormatView {
  const values = Object.fromEntries(fields.map(field => [field.key, field.value]))
  const sources: Record<string, FormatSource> = Object.fromEntries(fields.map(field => [field.key, '默认补充']))
  const apply = (next: FormatValues, source: FormatSource): void => {
    for (const [key, value] of Object.entries(validateFormatValues(next, fields))) {
      values[key] = value
      sources[key] = source
    }
  }
  const warnings = ['样式预览，分页以 Word 为准；浏览器和 Word 的字体可用性可能不同。', '仅比较明确的正文字号及字体要求，其余招标格式条款需人工核对。']
  if (state.source === 'template' && state.template) {
    apply(state.template.values, '模板提取')
    warnings.push(...state.template.warnings)
    for (const role of FORMAT_ROLES) {
      const candidate = state.template.candidates.find(item => item.id === state.mapping[role])
      if (!candidate) {
        const ambiguous = state.mapping[role] !== '__default__' && state.template.candidates.filter(item => item.role === role).length > 1
        if (ambiguous)
          for (const field of fields.filter(item => item.key.startsWith(`${role}.`)))
            sources[field.key] = '待确认'
        warnings.push(`${roleLabels[FORMAT_ROLES.indexOf(role)]}${ambiguous ? '有多个格式变体，待确认：请选择候选或明确使用默认方案。' : '使用默认方案，可手动修改。'}`)
        continue
      }
      apply(Object.fromEntries(Object.entries(candidate.values).map(([key, value]) => [`${role}.${key}`, value])), '模板提取')
    }
  }
  apply(state.overrides, '用户修改')
  const shortEdge = values['page.paper'] === 'A3' ? 297 : values['page.paper'] === 'Letter' ? 215.9 : 210
  const longEdge = values['page.paper'] === 'A3' ? 420 : values['page.paper'] === 'Letter' ? 279.4 : 297
  const pageWidth = values['page.orientation'] === 'landscape' ? longEdge : shortEdge
  if (Number(values['page.left']) + Number(values['page.right']) >= pageWidth)
    throw new Error('左右页边距过大，请缩小边距。')
  return { state, fields, values, sources, warnings }
}
