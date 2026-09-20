/** 完整 Chapter Review 与语义保持段落修订之间的可验证链。 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { RevisionQueueWorkspace } from './chapter-revision-queue.ts'
import { buildRevisionComparisonPath, readRevisionComparison } from './chapter-revision-comparison.ts'
import { buildParagraphRevisionReviewPath, readParagraphRevisionReview } from './chapter-paragraph-revision-artifacts.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** semantic lineage 的当前 schema 版本。 */
export const CHAPTER_REVISION_LINEAGE_SCHEMA_VERSION = 1 as const
/** semantic lineage 的项目内根路径。 */
export const CHAPTER_REVISION_LINEAGE_PATH = 'chapters/revisions/lineage'
const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const entrySchema = z.object({
  batch_id: z.string().min(1), task_id: z.string().min(1), before_sha256: sha, after_sha256: sha,
  comparison_path: z.string().min(1), revision_review_path: z.string().min(1),
}).strict()
/** 一个章节完整审核基线及连续局部修订链。 */
export const chapterRevisionLineageSchema = z.object({
  schema_version: recordOnlySchemaVersion(CHAPTER_REVISION_LINEAGE_SCHEMA_VERSION),
  section_id: z.string().min(1),
  base_review_candidate_sha256: sha,
  revisions: z.array(entrySchema),
}).strict()
/** 已持久化的章节 semantic lineage。 */
export type ChapterRevisionLineage = z.infer<typeof chapterRevisionLineageSchema>
/** lineage 中一条绑定 comparison 与 Delta Review 的边。 */
export type ChapterRevisionLineageEntry = z.infer<typeof entrySchema>

/**
 * 构造章节 semantic lineage 的项目内路径。
 * @param serial 章节四位序号。
 * @returns 项目内 lineage 路径。
 */
export function buildChapterRevisionLineagePath(serial: string): string {
  if (!/^\d{4}$/u.test(serial)) throw new Error('BID_PARAGRAPH_REVISION_LINEAGE_SERIAL_INVALID')
  return `${CHAPTER_REVISION_LINEAGE_PATH}/${serial}.json`
}

/**
 * 读取并校验章节 semantic lineage。
 * @param workspace 项目工作区。
 * @param serial 章节序号。
 * @returns 已校验 lineage；不存在时为 null。
 */
export async function readChapterRevisionLineage(
  workspace: RevisionQueueWorkspace,
  serial: string,
): Promise<ChapterRevisionLineage | null> {
  const path = within(workspace.projectRoot, buildChapterRevisionLineagePath(serial))
  try {
    await assertNoLinkedPath(workspace.root, path)
    return chapterRevisionLineageSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 追加一条连续修订；新完整审核与当前正文一致时重置基线。
 * @param existing 当前 lineage 或 null。
 * @param input 新修订的身份及摘要。
 * @returns 已追加或已重置的严格 lineage。
 */
export function appendSemanticRevision(
  existing: ChapterRevisionLineage | null,
  input: {
    readonly sectionId: string
    readonly baseReviewCandidateSha256: string
    readonly batchId: string
    readonly taskId: string
    readonly beforeSha256: string
    readonly afterSha256: string
  },
): ChapterRevisionLineage {
  const base = existing === null || input.baseReviewCandidateSha256 === input.beforeSha256
    ? { schema_version: CHAPTER_REVISION_LINEAGE_SCHEMA_VERSION, section_id: input.sectionId,
      base_review_candidate_sha256: input.baseReviewCandidateSha256, revisions: [] }
    : existing
  if (base.section_id !== input.sectionId
    || (base.revisions.at(-1)?.after_sha256 ?? base.base_review_candidate_sha256) !== input.beforeSha256) {
    throw new Error('BID_PARAGRAPH_REVISION_LINEAGE_CONFLICT')
  }
  const entry: ChapterRevisionLineageEntry = {
    batch_id: input.batchId,
    task_id: input.taskId,
    before_sha256: input.beforeSha256,
    after_sha256: input.afterSha256,
    comparison_path: buildRevisionComparisonPath(input.batchId, input.taskId),
    revision_review_path: buildParagraphRevisionReviewPath(input.batchId, input.taskId),
  }
  const duplicate = base.revisions.find(item => item.batch_id === input.batchId && item.task_id === input.taskId)
  if (duplicate !== undefined) {
    if (JSON.stringify(duplicate) !== JSON.stringify(entry)) throw new Error('BID_PARAGRAPH_REVISION_LINEAGE_CONFLICT')
    return chapterRevisionLineageSchema.parse(base)
  }
  return chapterRevisionLineageSchema.parse({ ...base, revisions: [...base.revisions, entry] })
}

/**
 * 严格验证 from → to 的 comparison、Delta Review 身份、摘要和连续性。
 * @param workspace 项目工作区。
 * @param serial 章节序号。
 * @param sectionId 章节身份。
 * @param fromSha256 历史审核正文摘要。
 * @param toSha256 当前正文摘要。
 * @returns 有效性、历史起点正文和经过的 lineage 边。
 */
export async function resolveSemanticRevisionPath(
  workspace: RevisionQueueWorkspace,
  serial: string,
  sectionId: string,
  fromSha256: string,
  toSha256: string,
): Promise<{ valid: boolean; from_markdown?: string; entries: ChapterRevisionLineageEntry[] }> {
  if (fromSha256 === toSha256) return { valid: true, entries: [] }
  try {
    const lineage = await readChapterRevisionLineage(workspace, serial)
    if (lineage === null || lineage.section_id !== sectionId) return { valid: false, entries: [] }
    let chainSha = lineage.base_review_candidate_sha256
    for (const entry of lineage.revisions) {
      if (entry.before_sha256 !== chainSha) return { valid: false, entries: [] }
      chainSha = entry.after_sha256
    }
    const start = lineage.revisions.findIndex(item => item.before_sha256 === fromSha256)
    if (start < 0) return { valid: false, entries: [] }
    const entries: ChapterRevisionLineageEntry[] = []
    let expected = fromSha256
    let fromMarkdown: string | undefined
    for (const entry of lineage.revisions.slice(start)) {
      if (entry.before_sha256 !== expected
        || entry.comparison_path !== buildRevisionComparisonPath(entry.batch_id, entry.task_id)
        || entry.revision_review_path !== buildParagraphRevisionReviewPath(entry.batch_id, entry.task_id)) {
        return { valid: false, entries: [] }
      }
      const [comparison, review] = await Promise.all([
        readRevisionComparison(workspace, entry.batch_id, entry.task_id),
        readParagraphRevisionReview(workspace, entry.batch_id, entry.task_id),
      ])
      if (comparison === null || review === null
        || comparison.batch_id !== entry.batch_id || comparison.task_id !== entry.task_id
        || review.batch_id !== entry.batch_id || review.task_id !== entry.task_id
        || comparison.section_id !== sectionId || review.section_id !== sectionId
        || comparison.before_sha256 !== entry.before_sha256 || comparison.after_sha256 !== entry.after_sha256
        || review.before_sha256 !== entry.before_sha256 || review.after_sha256 !== entry.after_sha256
        || JSON.stringify(comparison.issue_ids) !== JSON.stringify(review.issue_ids)) {
        return { valid: false, entries: [] }
      }
      fromMarkdown ??= comparison.before_markdown
      entries.push(entry)
      expected = entry.after_sha256
      if (expected === toSha256) return { valid: true, from_markdown: fromMarkdown, entries }
    }
    return { valid: false, entries: [] }
  } catch {
    return { valid: false, entries: [] }
  }
}
