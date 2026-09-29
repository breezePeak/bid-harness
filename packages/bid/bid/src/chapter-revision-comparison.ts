/** S5 批量修订前后正文的持久化快照。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import type { RevisionQueueWorkspace } from './chapter-revision-queue.ts'

/** comparison artifact 的记录版本。 */
export const REVISION_COMPARISON_SCHEMA_VERSION = 1 as const
/** comparison artifact 的项目内目录。 */
export const REVISION_COMPARISONS_PATH = 'chapters/revisions/comparisons'

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

/** 一次 batch task 成功提交的完整章节快照。 */
export const revisionComparisonArtifactSchema = z.object({
  schema_version: recordOnlySchemaVersion(REVISION_COMPARISON_SCHEMA_VERSION),
  batch_id: idSchema,
  task_id: idSchema,
  section_id: z.string().min(1),
  issue_ids: z.array(z.string().min(1)).min(1),
  before_markdown: z.string(),
  after_markdown: z.string(),
  before_sha256: sha256Schema,
  after_sha256: sha256Schema,
  created_at: z.number().int().nonnegative(),
}).strict()

/** 一次批次修订提交前后正文及其摘要的持久化记录。 */
export type RevisionComparisonArtifact = z.infer<typeof revisionComparisonArtifactSchema>

function markdownSha256(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

/**
 * 构造由 Host 身份字段决定的 comparison 相对路径。
 * @param batchId 批次身份。
 * @param taskId 批次任务身份。
 * @returns 项目内 comparison artifact 路径。
 */
export function buildRevisionComparisonPath(batchId: string, taskId: string): string {
  return `${REVISION_COMPARISONS_PATH}/${idSchema.parse(batchId)}/${idSchema.parse(taskId)}.json`
}

/**
 * 解析并校验 comparison 内容及正文摘要。
 * @param value 已解码的 JSON 值。
 * @returns 摘要与正文一致的 comparison artifact。
 */
export function parseRevisionComparisonArtifact(value: unknown): RevisionComparisonArtifact {
  const artifact = revisionComparisonArtifactSchema.parse(value)
  if (artifact.before_sha256 !== markdownSha256(artifact.before_markdown)
    || artifact.after_sha256 !== markdownSha256(artifact.after_markdown)) {
    throw new Error('BID_REVISION_COMPARISON_CORRUPT')
  }
  return artifact
}

/**
 * 创建一次成功 batch task 的 comparison artifact。
 * @param input 批次任务身份、章节、意见及前后正文。
 * @returns 带可校验正文摘要的比较记录。
 */
export function createRevisionComparisonArtifact(input: {
  readonly batchId: string
  readonly taskId: string
  readonly sectionId: string
  readonly issueIds: readonly string[]
  readonly beforeMarkdown: string
  readonly afterMarkdown: string
  readonly createdAt: number
}): RevisionComparisonArtifact {
  return parseRevisionComparisonArtifact({
    schema_version: REVISION_COMPARISON_SCHEMA_VERSION,
    batch_id: input.batchId,
    task_id: input.taskId,
    section_id: input.sectionId,
    issue_ids: [...input.issueIds],
    before_markdown: input.beforeMarkdown,
    after_markdown: input.afterMarkdown,
    before_sha256: markdownSha256(input.beforeMarkdown),
    after_sha256: markdownSha256(input.afterMarkdown),
    created_at: input.createdAt,
  })
}

/**
 * 读取指定 batch task 的 comparison；文件不存在时返回 null。
 * @param workspace 持有比较记录的项目工作区。
 * @param batchId 批次身份。
 * @param taskId 批次内任务身份。
 * @returns 已校验的比较记录；文件不存在时为 null。
 */
export async function readRevisionComparison(
  workspace: RevisionQueueWorkspace,
  batchId: string,
  taskId: string,
): Promise<RevisionComparisonArtifact | null> {
  const absolute = within(workspace.projectRoot, buildRevisionComparisonPath(batchId, taskId))
  try {
    await assertNoLinkedPath(workspace.root, absolute)
    return parseRevisionComparisonArtifact(JSON.parse(await readFile(absolute, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 拒绝同一 batch task 被不同正文或身份覆盖。
 * @param existing 已提交的比较记录。
 * @param expected 本次拟提交的同一任务记录。
 */
export function assertRevisionComparisonEquivalent(
  existing: RevisionComparisonArtifact,
  expected: RevisionComparisonArtifact,
): void {
  if (existing.batch_id !== expected.batch_id
    || existing.task_id !== expected.task_id
    || existing.section_id !== expected.section_id
    || existing.before_sha256 !== expected.before_sha256
    || existing.after_sha256 !== expected.after_sha256
    || JSON.stringify(existing.issue_ids) !== JSON.stringify(expected.issue_ids)) {
    throw new Error('BID_REVISION_COMPARISON_CONFLICT')
  }
}
