/** 仅在导出层按确认目录顺序生成编号文字，避免源标题与 Word 编号叠加。 */
import type { FormatValues } from './docx-format-contract.ts'
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
 * 创建当前导出独占的计数器；调用顺序必须等于确认目录顺序。
 * @param values 生效编号格式。
 * @returns 接受确认目录序号并返回显示文字的函数。
 */
export function createHeadingNumberer(values: FormatValues): (source: string) => string {
  const counts = [0, 0, 0, 0, 0, 0]
  return (source) => {
    if (values['numbering.mode'] === 'none')
      return ''
    if (values['numbering.mode'] === 'decimal')
      return source
    const level = source.split('.').length
    if (level > 6)
      throw new Error('标题编号最多支持六级。')
    counts[level - 1] = (counts[level - 1] as number) ? (counts[level - 1] as number) + 1 : Number(values[`numbering.${level}.start`])
    for (let child = level + 1; child <= 6; child++)
      if (values[`numbering.${child}.restart`])
        counts[child - 1] = 0
    return String(values[`numbering.${level}.text`]).replace(/%([1-6])/gu,
      (_,
        digit: string) => numeral((counts[Number(digit) - 1] as number),
        String(values[`numbering.${digit}.format`])))
  }
}
