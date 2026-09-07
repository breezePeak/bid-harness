/** 确认目录拥有章节标题；叶节正文不能另外创建目录层级。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Heading, Nodes } from 'mdast'

function headingText(markdown: string, node: Heading): string {
  const first = node.children[0]?.position?.start.offset
  const last = node.children.at(-1)?.position?.end.offset
  return first === undefined || last === undefined ? '' : markdown.slice(first, last)
}

function isChapterTitle(markdown: string, node: Nodes, title: string, sectionId: string): boolean {
  if (node.type !== 'heading') return false
  const text = headingText(markdown, node)
  const label = text.replace(/^(?:\d+(?:\.\d+)*(?:[.、．]\s*|\s+)|[一二三四五六七八九十百]+[、．.]\s*)/u, '')
  return label === title || label === sectionId
}

/**
 * 校验模型提交的叶节正文，仅允许开头的当前章节标题，代码块内的标题文本不参与校验。
 * @param markdown 模型提交的正文。
 * @param title 确认目录中的章节标题。
 * @param sectionId 当前章节身份，也可作为模型返回的根标题。
 * @returns 每个额外标题的具体问题；ATX、Setext 及引用或列表内的标题同样拒绝。
 */
export function validateChapterHeadings(markdown: string, title: string, sectionId: string): string[] {
  const root = fromMarkdown(markdown)
  const issues: string[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'heading' && (node !== root.children[0] || !isChapterTitle(markdown, node, title, sectionId))) {
      issues.push(`章节“${title}”是确认目录中的可写叶节，正文不能新增目录标题“${headingText(markdown, node)}”。目录深化须在 S4 确认；本节细节请用段落、列表或表格表达。`)
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(root)
  return issues
}

/**
 * 按确认目录补齐唯一根标题；已有正文的其他标题保留原文，不新增子编号。
 * @param markdown 当前章节正文，旧正文也可用于预览或导出。
 * @param title 确认目录中的章节标题。
 * @param sectionId 章节稳定身份，用于识别 Writer 重复输出的根标题。
 * @param number 确认目录树生成的章节编号。
 * @returns 以当前章节标题开头的正文，重复调用保持结果不变。
 */
export function normalizeChapterHeadings(markdown: string, title: string, sectionId: string, number: string): string {
  const first = fromMarkdown(markdown).children[0]
  if (first !== undefined && isChapterTitle(markdown, first, title, sectionId)) {
    const end = first.position?.end.offset
    if (end === undefined) throw new Error('Markdown 标题缺少源码位置。')
    markdown = markdown.slice(end)
  }
  return `# ${number} ${title}\n\n${markdown.trim()}`.trim()
}
