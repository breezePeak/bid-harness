/** Word 原生多级标题编号及浏览器预览计数，共用生效编号规则。 */
import JSZip from 'jszip'
import type { ILevelsOptions } from 'docx'
import type { FormatValues } from './docx-format-contract.ts'
/**
 * 解析六级标题的原生编号定义；十进制模式固定从 1 开始逐级编号。
 * @param values 生效编号配置。
 * @returns 关联 Word 标题样式的各级定义；无编号模式返回空数组。
 */
export function resolveHeadingNumbering(values: FormatValues): (ILevelsOptions & { restart: boolean })[] {
  if (values['numbering.mode'] === 'none') return []
  const template = values['numbering.mode'] === 'template'
  return Array.from({ length: 6 }, (_, level) => ({
    level,
    format: template ? String(values[`numbering.${level + 1}.format`]) as NonNullable<ILevelsOptions['format']> : 'decimal',
    text: template ? String(values[`numbering.${level + 1}.text`]) : Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.'),
    start: template ? Number(values[`numbering.${level + 1}.start`]) : 1,
    restart: !template || Boolean(values[`numbering.${level + 1}.restart`]),
    suffix: 'space',
    alignment: 'left',
    style: { style: `Heading${level + 1}` },
  }))
}
/**
 * 为原生编号补入跨父级连续计数规则；docx 的级别配置未暴露 lvlRestart。
 * @param bytes 生成器已经打包的 DOCX。
 * @param values 生效编号配置。
 * @returns 保留所有部件并补齐标题重新编号规则的 DOCX。
 */
export async function applyHeadingRestartRules(bytes: Buffer, values: FormatValues): Promise<Buffer> {
  const levels = resolveHeadingNumbering(values)
  if (!levels.some(level => !level.restart)) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const part = zip.file('word/numbering.xml')
  if (!part) throw new Error('生成的 Word 缺少编号定义。')
  const xml = await part.async('string')
  zip.file('word/numbering.xml', xml.replace(/<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/gu, (level) => {
    const heading = /<w:pStyle w:val="Heading([1-6])"\s*\/>/u.exec(level)
    if (!heading || levels[Number(heading[1]) - 1]?.restart !== false) return level
    return level.replace(/(<w:numFmt\b[^>]*\/>)/u, '$1<w:lvlRestart w:val="0"/>')
  }))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
function numeral(value: number, format: string): string {
  if (format === 'decimal')
    return String(value)
  if (format === 'upperLetter' || format === 'lowerLetter') {
    let result = '', n = value
    while (n > 0) {
      n--
      result = String.fromCharCode(65 + n % 26) + result
      n = Math.floor(n / 26)
    }
    return format === 'lowerLetter' ? result.toLowerCase() : result
  }
  if (format === 'upperRoman' || format === 'lowerRoman') {
    let result = '', n = value
    for (const [amount,
      symbol] of [[1000,
        'M'],
      [900,
        'CM'],
      [500,
        'D'],
      [400,
        'CD'],
      [100,
        'C'],
      [90,
        'XC'],
      [50,
        'L'],
      [40,
        'XL'],
      [10,
        'X'],
      [9,
        'IX'],
      [5,
        'V'],
      [4,
        'IV'],
      [1,
        'I']] as const)
      while (n >= amount) {
        result += symbol
        n -= amount
      }
    return format === 'lowerRoman' ? result.toLowerCase() : result
  }
  if (value >= 10000)
    throw new Error('中文编号仅支持小于一万的章节序号。')
  const digits = '零一二三四五六七八九', units = ' 十百千'
  let result = '', zero = false
  for (let i = 3; i >= 0; i--) {
    const digit = Math.floor(value / 10 ** i) % 10
    if (!digit) {
      if (result)
        zero = true
      continue
    }
    if (zero)
      result += '零'
    result += digits.charAt(digit) + units.charAt(i).trim()
    zero = false
  }
  return result.replace(/^一十/u, '十')
}
/**
 * 解析图题和表题的独立原生编号定义。
 * @param values 生效的 resolved 格式。
 * @returns 可直接加入 DOCX numbering 配置的两个单级列表。
 */
export function resolveCaptionNumbering(values: FormatValues): Array<{
  role: 'figureCaption' | 'tableCaption'
  reference: string
  level: ILevelsOptions
}> {
  return (['figureCaption', 'tableCaption'] as const).map(role => ({
    role,
    reference: `dsh-${role}`,
    level: {
      level: 0,
      format: String(values[`${role}.numbering.format`]) as NonNullable<ILevelsOptions['format']>,
      text: `${String(values[`${role}.numbering.prefix`])}${String(values[`${role}.numbering.prefixIndexSeparator`])}%1${String(values[`${role}.numbering.indexTitleSeparator`])}`,
      start: 1,
      suffix: 'nothing',
      alignment: 'left',
    },
  }))
}

/**
 * 创建图题和表题预览计数器；DOCX 由两个原生列表独立计数。
 * @param values 生效的 resolved 格式。
 * @returns 接受题注角色并返回前缀、序号及标题分隔符的函数。
 */
export function createCaptionNumberer(values: FormatValues): (role: 'figureCaption' | 'tableCaption') => string {
  const counts = { figureCaption: 0, tableCaption: 0 }
  return (role) => {
    counts[role]++
    return `${String(values[`${role}.numbering.prefix`])}${String(values[`${role}.numbering.prefixIndexSeparator`])}${numeral(counts[role], String(values[`${role}.numbering.format`]))}${String(values[`${role}.numbering.indexTitleSeparator`])}`
  }
}
/**
 * 创建浏览器预览独占的计数器；Word 文件由原生编号自行计数。
 * @param values 生效编号格式。
 * @returns 接受标题级别及可选的目录各级序号，返回显示文字的函数。
 */
export function createHeadingNumberer(values: FormatValues): (level: number, ordinals?: readonly number[]) => string {
  const counts = [0, 0, 0, 0, 0, 0]
  const levels = resolveHeadingNumbering(values)
  return (level, ordinals) => {
    if (!levels.length)
      return ''
    if (level > 6)
      throw new Error('标题编号最多支持六级。')
    for (let parent = 0; parent < level - 1; parent++)
      if (!counts[parent]) counts[parent] = levels[parent]?.start ?? 1
    counts[level - 1] = (counts[level - 1] as number) ? (counts[level - 1] as number) + 1 : levels[level - 1]?.start ?? 1
    if (ordinals) counts.splice(0, level, ...ordinals)
    for (let child = level + 1; child <= 6; child++)
      if (levels[child - 1]?.restart)
        counts[child - 1] = 0
    return String(levels[level - 1]?.text).replace(/%([1-6])/gu,
      (_,
        digit: string) => numeral((counts[Number(digit) - 1] as number),
        String(levels[Number(digit) - 1]?.format)))
  }
}
