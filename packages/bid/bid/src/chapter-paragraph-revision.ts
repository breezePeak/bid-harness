/** 段落选区修订的授权分段与 Host 精确替换。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { RevisionBatchTaskExecution } from './chapter-revision-batch.ts'
import { mergeParagraphRanges } from './chapter-revision.ts'

/** 每侧相邻只读块进入 Writer Prompt 的字符上限。 */
export const MAX_NEIGHBOR_CONTEXT_CHARS = 1_200

/** 一条授权选区关联的用户审批意见。 */
export interface ParagraphRevisionInstruction {
  issue_id: string
  instruction: string
  suggestion: string | null
}

/** 合并后的连续授权范围及其只读相邻上下文。 */
export interface ParagraphRevisionSegment {
  segment_id: string
  start: number
  end: number
  original_text: string
  readonly_before: string
  readonly_after: string
  issues: ParagraphRevisionInstruction[]
}

/** Writer 为一个授权分段提交的替换文本。 */
export interface ParagraphRevisionReplacement {
  segment_id: string
  markdown: string
}

/**
 * 将 paragraph-only task 变成稳定、有界的局部修订分段。
 * @param markdown 当前章节原文。
 * @param task 已解析审批意见的批次任务。
 * @returns 按正文偏移升序排列的合并分段。
 */
export function buildParagraphRevisionSegments(
  markdown: string,
  task: RevisionBatchTaskExecution,
): ParagraphRevisionSegment[] {
  if (task.issues.some(issue => issue.scope !== 'paragraphs')) {
    throw new Error('BID_PARAGRAPH_REVISION_SCOPE_INVALID')
  }
  const ranges = task.issues.map((issue) => {
    if (issue.start === null || issue.end === null || issue.reference_text === null
      || markdown.slice(issue.start, issue.end) !== issue.reference_text) {
      throw new Error('BID_CHAPTER_REVISION_SELECTION_INVALID')
    }
    return { start: issue.start, end: issue.end }
  })
  const nodes = fromMarkdown(markdown).children
  return mergeParagraphRanges(ranges).map((range, index) => {
    const before = nodes.filter(node => (node.position?.end.offset ?? -1) <= range.start).at(-1)
    const after = nodes.find(node => (node.position?.start.offset ?? Number.POSITIVE_INFINITY) >= range.end)
    const beforeText = before?.position === undefined
      ? ''
      : markdown.slice(before.position.start.offset, before.position.end.offset)
    const afterText = after?.position === undefined
      ? ''
      : markdown.slice(after.position.start.offset, after.position.end.offset)
    return {
      segment_id: `SEG-${String(index + 1).padStart(3, '0')}`,
      start: range.start,
      end: range.end,
      original_text: markdown.slice(range.start, range.end),
      readonly_before: beforeText.slice(-MAX_NEIGHBOR_CONTEXT_CHARS),
      readonly_after: afterText.slice(0, MAX_NEIGHBOR_CONTEXT_CHARS),
      issues: task.issues.filter(issue => issue.start !== null && issue.end !== null
        && issue.start < range.end && issue.end > range.start).map(issue => ({
        issue_id: issue.issue_id,
        instruction: issue.instruction,
        suggestion: issue.suggestion,
      })),
    }
  })
}

/**
 * 只在授权偏移内应用一一对应的 replacement。
 * @param original 当前章节原文。
 * @param segments Host 授权的合并分段。
 * @param replacements Writer 提交的替换文本。
 * @returns 仅替换授权范围后的完整章节正文。
 */
export function applyParagraphRevisionReplacements(
  original: string,
  segments: readonly ParagraphRevisionSegment[],
  replacements: readonly ParagraphRevisionReplacement[],
): string {
  if (replacements.length !== segments.length) throw new Error('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
  const byId = new Map<string, ParagraphRevisionReplacement>()
  for (const replacement of replacements) {
    if (byId.has(replacement.segment_id)) throw new Error('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
    byId.set(replacement.segment_id, replacement)
  }
  const known = new Set(segments.map(segment => segment.segment_id))
  if ([...byId.keys()].some(id => !known.has(id)) || segments.some(segment => !byId.has(segment.segment_id))) {
    throw new Error('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
  }
  let result = original
  for (const segment of [...segments].sort((left, right) => right.start - left.start)) {
    const replacement = byId.get(segment.segment_id)
    if (replacement === undefined) throw new Error('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
    result = result.slice(0, segment.start) + replacement.markdown + result.slice(segment.end)
  }
  return result
}
