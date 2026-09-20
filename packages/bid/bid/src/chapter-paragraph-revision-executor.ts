/** paragraph-only 批次任务的局部 Writer、Delta Reviewer、调度与原子 publication。 */
import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BidCustomerTextContext } from './customer-facing-prose.ts'
import { findBidInternalIdentifiers } from './customer-facing-prose.ts'
import type { BidWorkspace } from './index.ts'
import type { RevisionBatchTaskExecution } from './chapter-revision-batch.ts'
import { assertChapterRevisionBatchScope, type BatchRevisionScope } from './chapter-revision.ts'
import {
  applyParagraphRevisionReplacements,
  buildParagraphRevisionSegments,
  type ParagraphRevisionReplacement,
} from './chapter-paragraph-revision.ts'
import {
  createParagraphRevisionWriterChild,
  paragraphRevisionWriterOutputSchema,
  renderParagraphRevisionRepairTask,
  renderParagraphRevisionWriterTask,
} from './chapter-paragraph-revision-child.ts'
import {
  createParagraphRevisionReviewerChild,
  paragraphRevisionReviewSchema,
  renderParagraphRevisionReviewerTask,
} from './chapter-paragraph-revision-review.ts'
import {
  buildParagraphRevisionReviewPath,
  createParagraphRevisionReviewArtifact,
} from './chapter-paragraph-revision-artifacts.ts'
import {
  assertRevisionComparisonEquivalent,
  buildRevisionComparisonPath,
  createRevisionComparisonArtifact,
  readRevisionComparison,
} from './chapter-revision-comparison.ts'
import {
  appendSemanticRevision,
  buildChapterRevisionLineagePath,
  readChapterRevisionLineage,
} from './chapter-revision-lineage.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { chapterCandidateSha256, parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { validateChapterHeadings } from './chapter-headings.ts'
import { validateFlowchartAnchors } from './flowchart.ts'
import { missingTableCaptionLines } from './docx-numbering.ts'
import { publishBidBatch } from './publication-batch.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** 首次局部提交后允许的最大语义修复轮数。 */
export const MAX_PARAGRAPH_REVISION_REPAIR_ROUNDS = 1

/** 一个局部任务在发布、升级或停止后的结果。 */
export type ParagraphRevisionTaskResult =
  | { readonly status: 'completed' }
  | { readonly status: 'full_review' }
  | { readonly status: 'needs_input' }
  | { readonly status: 'blocked'; readonly code: string; readonly message: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** 执行一个局部任务所需的 Host 权威输入。 */
export interface ExecuteParagraphRevisionTaskInput {
  readonly parent: Agent
  readonly workspace: BidWorkspace
  readonly batchId: string
  readonly task: RevisionBatchTaskExecution
  readonly serial: string
  readonly title: string
  readonly writerId: string
  readonly signal: AbortSignal
  readonly customerTextContext: BidCustomerTextContext
  readonly onPhase?: (phase: 'running' | 'reviewing' | 'repairing') => Promise<void>
}

/**
 * 判断修订任务是否只能进入段落 Fast Path。
 * @param task 待路由任务。
 * @returns 任务是否非空且全部为 paragraph scope。
 */
export function isParagraphOnlyRevisionTask(task: RevisionBatchTaskExecution): boolean {
  return task.issues.length > 0 && task.issues.every(issue => issue.scope === 'paragraphs')
}

function hostValidationIssues(
  input: ExecuteParagraphRevisionTaskInput,
  markdown: string,
  metadata: ReturnType<typeof parseChapterMetadata>,
): string[] {
  return [
    ...(markdown.trim().length === 0 ? ['markdown 不能为空。'] : []),
    ...validateChapterHeadings(markdown, input.title, input.task.section_id),
    ...validateFlowchartAnchors(markdown, metadata.flowcharts),
    ...missingTableCaptionLines(markdown).map(line => `正文第 ${line || '?'} 行的表格缺少紧邻上方的表题。`),
    ...findBidInternalIdentifiers(markdown, input.customerTextContext).map(id => `正文包含系统内部编号 ${id}。`),
  ]
}

/**
 * 执行一个 paragraph-only task；accept 前不写任何章节产物。
 * @param input 当前任务、章节身份、原 Writer 与 Host 校验上下文。
 * @returns 发布、升级、等待输入或失败结果。
 */
export async function executeParagraphRevisionTask(
  input: ExecuteParagraphRevisionTaskInput,
): Promise<ParagraphRevisionTaskResult> {
  const contentPath = within(input.workspace.projectRoot, `chapters/sections/${input.serial}.md`)
  const metadataPath = within(input.workspace.projectRoot, `chapters/meta/${input.serial}.json`)
  const reviewPath = within(input.workspace.projectRoot, `chapters/reviews/${input.serial}.json`)
  const manifestPath = within(input.workspace.projectRoot, 'chapters/manifest.json')
  await Promise.all([contentPath, metadataPath, reviewPath, manifestPath].map(path => assertNoLinkedPath(input.workspace.root, path)))
  const [original, metadataRaw, reviewRaw, manifestRaw] = await Promise.all([
    readFile(contentPath, 'utf8'), readFile(metadataPath), readFile(reviewPath, 'utf8'), readFile(manifestPath, 'utf8'),
  ])
  const metadata = parseChapterMetadata(JSON.parse(metadataRaw.toString('utf8')))
  const baseReview = parseChapterReviewArtifact(JSON.parse(reviewRaw))
  const manifest = parseChapterWritingManifest(JSON.parse(manifestRaw))
  const segments = buildParagraphRevisionSegments(original, input.task)
  const scopes: BatchRevisionScope[] = input.task.issues.map(issue => ({
    scope: issue.scope,
    ...(issue.start === null || issue.end === null ? {} : { start: issue.start, end: issue.end }),
  }))
  const writer = createParagraphRevisionWriterChild(
    input.parent, input.title, SessionId(input.writerId), input.signal,
  )
  const reviewer = createParagraphRevisionReviewerChild(
    input.parent, `${input.title} · 局部复审`, input.task.issue_ids, segments.map(segment => segment.segment_id), input.signal,
  )
  let replacements: ParagraphRevisionReplacement[] = []
  let repairInstructions: Array<{ segment_id: string; instruction: string }> = []
  let validationIssues: string[] | undefined
  try {
    for (let round = 0; round <= MAX_PARAGRAPH_REVISION_REPAIR_ROUNDS; round++) {
      await input.onPhase?.(round === 0 ? 'running' : 'repairing')
      const writerPrompt = round === 0
        ? renderParagraphRevisionWriterTask({ sectionId: input.task.section_id, title: input.title, segments })
        : renderParagraphRevisionRepairTask({
          segments, replacements, instructions: repairInstructions,
          ...(validationIssues === undefined ? {} : { validationIssues }),
        })
      const writerResult = await writer.run(writerPrompt)
      if (writerResult.stopReason !== 'completed' || writerResult.structured === undefined) {
        return { status: 'failed', code: 'PARAGRAPH_REVISION_WRITER_FAILED', message: '局部 Writer 未正常提交 replacement。' }
      }
      const submitted = paragraphRevisionWriterOutputSchema.parse(writerResult.structured)
      replacements = submitted.replacements
      const afterMarkdown = applyParagraphRevisionReplacements(original, segments, replacements)
      assertChapterRevisionBatchScope(scopes, original, afterMarkdown)
      validationIssues = hostValidationIssues(input, afterMarkdown, metadata)
      if (validationIssues.length > 0) {
        repairInstructions = segments.map(segment => ({
          segment_id: segment.segment_id,
          instruction: `修复 Host 校验错误，同时保持修改仅限当前 SEG：${validationIssues?.join('；')}`,
        }))
        if (round === MAX_PARAGRAPH_REVISION_REPAIR_ROUNDS) {
          return { status: 'failed', code: 'PARAGRAPH_REVISION_HOST_VALIDATION_FAILED', message: validationIssues.join('；') }
        }
        continue
      }
      await input.onPhase?.('reviewing')
      const reviewResult = await reviewer.run(renderParagraphRevisionReviewerTask({
        title: input.title, segments, replacements,
      }))
      if (reviewResult.stopReason !== 'completed' || reviewResult.structured === undefined) {
        return { status: 'failed', code: 'PARAGRAPH_REVISION_REVIEW_FAILED', message: 'Delta Reviewer 未正常提交结论。' }
      }
      const review = paragraphRevisionReviewSchema.parse(reviewResult.structured)
      if (review.decision === 'full_review') return { status: 'full_review' }
      if (review.decision === 'needs_input') return { status: 'needs_input' }
      if (review.decision === 'repair') {
        repairInstructions = review.repair_instructions
        validationIssues = undefined
        if (round === MAX_PARAGRAPH_REVISION_REPAIR_ROUNDS) {
          return { status: 'failed', code: 'PARAGRAPH_REVISION_NOT_SATISFIED', message: review.reason }
        }
        continue
      }

      const createdAt = Date.now()
      const comparison = createRevisionComparisonArtifact({
        batchId: input.batchId, taskId: input.task.task_id, sectionId: input.task.section_id,
        issueIds: input.task.issue_ids, beforeMarkdown: original, afterMarkdown, createdAt,
      })
      const existingComparison = await readRevisionComparison(input.workspace, input.batchId, input.task.task_id)
      if (existingComparison !== null) assertRevisionComparisonEquivalent(existingComparison, comparison)
      const revisionReview = createParagraphRevisionReviewArtifact({
        batch_id: input.batchId,
        task_id: input.task.task_id,
        section_id: input.task.section_id,
        issue_ids: [...input.task.issue_ids],
        before_sha256: comparison.before_sha256,
        after_sha256: comparison.after_sha256,
        writer_child_session_id: String(writer.id),
        reviewer_child_session_id: String(reviewer.id),
        issue_checks: review.issue_checks.map(item => ({
          issue_id: item.issue_id, status: 'satisfied' as const, reason: item.reason,
        })),
        created_at: createdAt,
      })
      const currentLineage = await readChapterRevisionLineage(input.workspace, input.serial)
      const lineage = appendSemanticRevision(currentLineage, {
        sectionId: input.task.section_id,
        baseReviewCandidateSha256: baseReview.candidate_sha256,
        batchId: input.batchId,
        taskId: input.task.task_id,
        beforeSha256: comparison.before_sha256,
        afterSha256: comparison.after_sha256,
      })
      const chapter = manifest.chapters.find(item => item.section_id === input.task.section_id)
      if (chapter === undefined) throw new Error('BID_PARAGRAPH_REVISION_MANIFEST_SECTION_MISSING')
      const nextManifest = {
        ...manifest,
        chapters: manifest.chapters.map(item => item === chapter
          ? { ...item, review_sha256: chapterCandidateSha256(afterMarkdown) }
          : item),
      }
      await publishBidBatch(input.workspace.root, input.workspace.projectRoot, async (lease) => {
        await lease.writeText(contentPath, afterMarkdown)
        const comparisonPath = buildRevisionComparisonPath(input.batchId, input.task.task_id)
        const deltaReviewPath = buildParagraphRevisionReviewPath(input.batchId, input.task.task_id)
        await lease.writeJson(within(input.workspace.projectRoot, comparisonPath), comparison)
        await lease.writeJson(within(input.workspace.projectRoot, deltaReviewPath), revisionReview)
        await lease.writeJson(within(input.workspace.projectRoot, buildChapterRevisionLineagePath(input.serial)), lineage)
        await lease.writeJson(manifestPath, nextManifest)
      })
      return { status: 'completed' }
    }
    return { status: 'failed', code: 'PARAGRAPH_REVISION_NOT_SATISFIED', message: '局部修订未满足审批意见。' }
  } finally {
    await Promise.all([writer.dispose(), reviewer.dispose()])
  }
}

/** 调度器携带的任务及调用方私有值。 */
export interface ParagraphRevisionScheduledTask<T> {
  readonly task: RevisionBatchTaskExecution
  readonly value: T
}

/**
 * 小型依赖调度器；full_review 在当前并发 wave settle 后独占 fallback。
 * @param input 任务、并发上限、局部执行器和完整 fallback。
 * @returns 以 task_id 索引的终态结果。
 */
export async function runParagraphRevisionScheduler<T>(input: {
  readonly tasks: readonly ParagraphRevisionScheduledTask<T>[]
  readonly maxConcurrency: number
  readonly run: (task: ParagraphRevisionScheduledTask<T>) => Promise<ParagraphRevisionTaskResult>
  readonly fallback: (task: ParagraphRevisionScheduledTask<T>) => Promise<ParagraphRevisionTaskResult>
}): Promise<Map<string, ParagraphRevisionTaskResult>> {
  const results = new Map<string, ParagraphRevisionTaskResult>()
  const pending = new Map(input.tasks.map(task => [task.task.task_id, task]))
  while (pending.size > 0) {
    let changed = false
    for (const [id, item] of [...pending]) {
      if (item.task.depends_on.some(dep => results.has(dep) && results.get(dep)?.status !== 'completed')) {
        results.set(id, { status: 'blocked', code: 'DEPENDENCY_BLOCKED', message: '依赖任务未完成。' })
        pending.delete(id)
        changed = true
      }
    }
    const ready = [...pending.values()].filter(item => item.task.depends_on.every(dep => results.get(dep)?.status === 'completed'))
      .slice(0, Math.max(1, input.maxConcurrency))
    if (ready.length === 0) {
      if (!changed) for (const [id] of pending) {
        results.set(id, { status: 'blocked', code: 'DEPENDENCY_BLOCKED', message: '任务依赖无法满足。' })
        pending.delete(id)
      }
      continue
    }
    const wave = await Promise.all(ready.map(async item => ({ item, result: await input.run(item) })))
    for (const { item, result } of wave) {
      pending.delete(item.task.task_id)
      if (result.status === 'full_review') results.set(item.task.task_id, await input.fallback(item))
      else results.set(item.task.task_id, result)
    }
  }
  return results
}
