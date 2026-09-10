/** DOCX 导出与页数估算共用的 Markdown 正文规范化。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { normalizeChapterHeadings } from './chapter-headings.ts'

/**
 * 将叶节正文整理为导出标题之后的内容。
 * @param markdown 已保存的叶节正文。
 * @param title 确认目录标题。
 * @param sectionId 叶节稳定身份。
 * @param number 确认目录编号。
 * @param depth 该节导出标题深度。
 * @returns 不重复当前章节标题的 Markdown 正文。
 */
export function collectDocxChapterBody(markdown: string, title: string, sectionId: string, number: string, depth: number): string {
  markdown = normalizeChapterHeadings(markdown, title, sectionId, number)
  const nodes = fromMarkdown(markdown).children
  for (const node of [...nodes].reverse()) {
    if (node.type !== 'heading') continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('Markdown 标题缺少源码位置。')
    const first = node.children[0]?.position?.start.offset
    const last = node.children.at(-1)?.position?.end.offset
    const inline = first === undefined || last === undefined ? '' : markdown.slice(first, last)
    const text = node === nodes[0]
      ? '' : `${'#'.repeat(Math.min(6, depth + node.depth - 1))} ${inline}`
    markdown = markdown.slice(0, start) + text + markdown.slice(end)
  }
  return markdown.trim()
}
