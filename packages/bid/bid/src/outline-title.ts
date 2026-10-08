/** 只清理输出章节名称的明确编号前缀，保留名称内部字符及业务数字。 */
const chapterPrefix = new RegExp(
  String.raw`^(?:第[零〇一二三四五六七八九十百千万两\d０-９]+[章节篇部卷]\s*|`
  + String.raw`[（(][零〇一二三四五六七八九十百千万两\d０-９]+[）)]\s*|`
  + String.raw`[零〇一二三四五六七八九十百千万两]+[、.．]\s*|[\d０-９]+、\s*|`
  + String.raw`[\d０-９]+(?:[.．][\d０-９]+)*(?:[.．](?![\d０-９])\s*|\s+(?=\S|$)))`,
  'u',
)

/**
 * 逐层移除章节编号；四位以上整数加空格保留为可能的年份。
 * @param title 输出章节标题，不适用于来源标题或业务编号。
 * @returns 净名称；只有编号时返回空字符串，读取旧标题时由调用方回退原文。
 */
export function normalizeOutlineSectionTitle(title: string): string {
  let name = title.trim()
  for (;;) {
    const prefix = name.match(chapterPrefix)?.[0]
    if (prefix === undefined || /^[\d０-９]{4,}\s+$/u.test(prefix)) return name
    name = name.slice(prefix.length).trimStart()
  }
}
