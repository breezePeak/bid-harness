/** 章节标题编号由确认目录及 Markdown 标题层级决定。 */
import { fromMarkdown } from 'mdast-util-from-markdown'

function withoutNumber(text: string): string {
  return text.replace(/^(?:\d+(?:\.\d+)*(?:[.、．]\s*|\s+)|[一二三四五六七八九十百]+[、．.]\s*)/u, '')
}

/**
 * 生成唯一章节标题和连续的节内编号；列表、代码块及正文数字保持原文。
 * @param markdown Writer 提交的章节正文。
 * @param title 确认目录中的章节标题。
 * @param sectionId 章节稳定身份，用于识别 Writer 重复输出的根标题。
 * @param number 确认目录树生成的章节编号。
 * @returns 以一级章节标题开头的规范正文，重复调用保持结果不变。
 */
export function normalizeChapterHeadings(markdown: string, title: string, sectionId: string, number: string): string {
  const nodes = fromMarkdown(markdown).children
  const edits: Array<{ start: number; end: number; text: string }> = []
  const levels: Array<{ depth: number; index: number }> = []
  for (const node of nodes) {
    if (node.type !== 'heading') continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('Markdown 标题缺少源码位置。')
    const first = node.children[0]?.position?.start.offset
    const last = node.children.at(-1)?.position?.end.offset
    const inline = first === undefined || last === undefined ? '' : markdown.slice(first, last)
    const label = withoutNumber(inline)
    if (node === nodes[0] && (label === title || inline === sectionId || label === sectionId)) {
      edits.push({ start, end, text: '' })
      continue
    }
    while ((levels.at(-1)?.depth ?? 0) > node.depth) {
      levels.pop()
    }
    const sibling = levels.at(-1)
    if (sibling !== undefined && (sibling.depth === node.depth || levels.length === 5)) sibling.index++
    else levels.push({ depth: node.depth, index: 1 })
    edits.push({ start, end, text: `${'#'.repeat(Math.min(6, levels.length + 1))} ${number}.${levels.map(level => level.index).join('.')} ${label}` })
  }
  for (const { start, end, text } of edits.reverse()) markdown = markdown.slice(0, start) + text + markdown.slice(end)
  return `# ${number} ${title}\n\n${markdown.trim()}`.trim()
}
