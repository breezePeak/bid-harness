/** 成功的段落修订 Delta Review artifact。 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { RevisionQueueWorkspace } from './chapter-revision-queue.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** Delta Review artifact 的当前 schema 版本。 */
export const PARAGRAPH_REVISION_REVIEW_SCHEMA_VERSION = 1 as const
/** Delta Review artifact 的项目内根路径。 */
export const PARAGRAPH_REVISION_REVIEWS_PATH = 'chapters/revisions/reviews'
const id = z.string().regex(/^[A-Za-z0-9._-]+$/u)
const sha = z.string().regex(/^[a-f0-9]{64}$/u)

/** 只接受语义保持且全部意见满足的成功 artifact。 */
export const paragraphRevisionReviewArtifactSchema = z.object({
  schema_version: recordOnlySchemaVersion(PARAGRAPH_REVISION_REVIEW_SCHEMA_VERSION),
  batch_id: id,
  task_id: id,
  section_id: z.string().min(1),
  issue_ids: z.array(z.string().min(1)).min(1),
  before_sha256: sha,
  after_sha256: sha,
  writer_child_session_id: z.string().min(1),
  reviewer_child_session_id: z.string().min(1),
  semantic_preserved: z.literal(true),
  issue_checks: z.array(z.object({
    issue_id: z.string().min(1), status: z.literal('satisfied'), reason: z.string().min(1),
  }).strict()).min(1),
  created_at: z.number().int().nonnegative(),
}).strict().superRefine((artifact, context) => {
  const issueIds = new Set(artifact.issue_ids)
  const checkIds = new Set(artifact.issue_checks.map(item => item.issue_id))
  if (issueIds.size !== artifact.issue_ids.length || checkIds.size !== artifact.issue_checks.length
    || issueIds.size !== checkIds.size || [...issueIds].some(id => !checkIds.has(id))) {
    context.addIssue({ code: 'custom', message: 'issue_ids and issue_checks must match one-to-one' })
  }
})

/** 已持久化的成功 Delta Review。 */
export type ParagraphRevisionReviewArtifact = z.infer<typeof paragraphRevisionReviewArtifactSchema>

/**
 * 构造段落修订审核 artifact 的项目内路径。
 * @param batchId 批次身份。
 * @param taskId 任务身份。
 * @returns 项目内 artifact 路径。
 */
export function buildParagraphRevisionReviewPath(batchId: string, taskId: string): string {
  return `${PARAGRAPH_REVISION_REVIEWS_PATH}/${id.parse(batchId)}/${id.parse(taskId)}.json`
}

/**
 * 创建由 Host 绑定身份和摘要的成功审核 artifact。
 * @param input Host 绑定的成功审核字段。
 * @returns 严格成功 artifact。
 */
export function createParagraphRevisionReviewArtifact(
  input: Omit<ParagraphRevisionReviewArtifact, 'schema_version' | 'semantic_preserved'>,
): ParagraphRevisionReviewArtifact {
  return paragraphRevisionReviewArtifactSchema.parse({
    schema_version: PARAGRAPH_REVISION_REVIEW_SCHEMA_VERSION,
    semantic_preserved: true,
    ...input,
  })
}

/**
 * 读取并校验段落修订审核 artifact。
 * @param workspace 项目工作区。
 * @param batchId 批次身份。
 * @param taskId 任务身份。
 * @returns 已校验 artifact；文件不存在时为 null。
 */
export async function readParagraphRevisionReview(
  workspace: RevisionQueueWorkspace,
  batchId: string,
  taskId: string,
): Promise<ParagraphRevisionReviewArtifact | null> {
  const path = within(workspace.projectRoot, buildParagraphRevisionReviewPath(batchId, taskId))
  try {
    await assertNoLinkedPath(workspace.root, path)
    return paragraphRevisionReviewArtifactSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
