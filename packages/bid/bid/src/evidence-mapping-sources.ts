/** S4 私有资料定位；范围来自 Markdown 位置，引用只在当前资料目录内解析。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { DocumentChunkEntry } from './document-chunk.ts'
import type { DocumentOutlineHeading } from './outline-framework.ts'

type Heading = Extract<ReturnType<typeof fromMarkdown>['children'][number], { type: 'heading' }>
function headingText(node: Heading | Heading['children'][number]): string {
  if ('value' in node) return node.value
  return 'children' in node ? node.children.map(headingText).join('') : ''
}

/** 标准化正文中的连续行范围；直接正文不包含子章节。 */
export interface SourceRange {
  start: number
  end: number
  heading_path: string[]
}

/**
 * 根据实际标题位置建立正文范围与分块交集，不使用分块的单一 heading_path 推断归属。
 * @param markdown 标准化正文。
 * @param chunks 现有分块索引。
 * @param outline 完整结构目录。
 * @returns 正文、实际标题、完整目录及真实分块覆盖范围。
 */
export function buildMappingSourceIndex(
  markdown: string, chunks: readonly DocumentChunkEntry[], outline: readonly DocumentOutlineHeading[],
): MappingSourceIndex {
  const lines = markdown.split('\n')
  const headings: Array<SourceRange & { title: string; level: number; body_start: number; full_end: number }> = []
  const stack: typeof headings = []
  for (const node of fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children) {
    if (node.type !== 'heading' || node.position === undefined) continue
    while ((stack.at(-1)?.level ?? 0) >= node.depth) stack.pop()
    const title = headingText(node).trim()
    const heading = { title, level: node.depth, start: node.position.start.line, body_start: node.position.end.line + 1,
      end: lines.length, full_end: lines.length, heading_path: [...stack.map(parent => parent.title), title] }
    headings.push(heading)
    stack.push(heading)
  }
  for (const [index, heading] of headings.entries()) {
    heading.end = (headings[index + 1]?.start ?? lines.length + 1) - 1
    heading.full_end = (headings.slice(index + 1).find(next => next.level <= heading.level)?.start ?? lines.length + 1) - 1
  }
  const regions: SourceRange[] = [{ start: 1, end: (headings[0]?.start ?? lines.length + 1) - 1, heading_path: [] }, ...headings]
    .filter(range => range.start <= range.end)
  // 重复路径只有两边出现次数一致时才能按出现顺序建立一一对应；否则保留完整目录但不猜位置。
  const key = (heading: { level: number; heading_path: readonly string[] }) => JSON.stringify([heading.level, heading.heading_path])
  const occurrences = new Map<string, number>()
  const directory = outline.map<MappingSourceIndex['directory'][number]>((heading) => {
    const identity = key(heading)
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    const matches = headings.filter(item => key(item) === identity)
    const matched = matches.length === outline.filter(item => key(item) === identity).length ? matches[occurrence] : undefined
    return { ...heading, location: matched === undefined ? '定位未确定' : '已定位', heading_index: matched === undefined ? null : headings.indexOf(matched) }
  })
  return { lines, headings, directory, chunks: chunks.map(chunk => ({ ...chunk,
    coverage: regions.filter(region => region.start <= chunk.source_line_end && region.end >= chunk.source_line_start)
      .map(region => ({ heading_path: region.heading_path,
        start: Math.max(region.start, chunk.source_line_start), end: Math.min(region.end, chunk.source_line_end) })),
  })) }
}

/** 只在 S4 运行内持有，不写入正式分块索引。 */
export interface MappingSourceIndex {
  lines: string[]
  headings: Array<SourceRange & { title: string; level: number; body_start: number; full_end: number }>
  directory: Array<DocumentOutlineHeading & { location: '定位未确定' | '已定位'; heading_index: number | null }>
  chunks: Array<DocumentChunkEntry & { coverage: SourceRange[] }>
}
