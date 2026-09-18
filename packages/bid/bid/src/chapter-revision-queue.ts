/** S5 批量审批意见队列的持久化契约与确定性 CRUD；不启动任何 Writer。 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { publishBidBatch } from './publication-batch.ts'
import { chapterContentSha256, validateChapterParagraphReference } from './chapter-revision.ts'

/** `queue.json` 的 schema 版本；仅用于记录，不阻断业务读取。 */
export const REVISION_QUEUE_SCHEMA_VERSION = 1 as const

/** `queue.json` 在项目内的相对路径。 */
export const REVISION_QUEUE_PATH = 'chapters/revisions/queue.json'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

/** 审批意见的确定性状态；只有 `pending` 允许浏览器直接编辑或删除。 */
export const revisionIssueStatusSchema = z.enum([
  'pending', 'scheduled', 'running', 'completed', 'needs_input', 'conflict', 'failed',
])

/** 章节或连续段落的引用；`base_content_sha256` 必须等于保存时的当前正文。 */
const revisionIssueReferenceSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('chapter'),
    base_content_sha256: sha256Schema,
  }).strict(),
  z.object({
    scope: z.literal('paragraphs'),
    base_content_sha256: sha256Schema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1),
  }).strict(),
])

/** 一条持久化的审批意见；身份与时间戳由 Host 生成。 */
export const revisionIssueSchema = z.object({
  issue_id: z.string().min(1),
  section_id: z.string().min(1),
  section_title: z.string().min(1),
  scope: z.enum(['paragraphs', 'chapter']),
  reference: revisionIssueReferenceSchema,
  instruction: z.string().trim().min(1),
  suggestion: z.string().nullable(),
  status: revisionIssueStatusSchema,
  batch_id: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
}).strict().superRefine((issue, ctx) => {
  if (issue.scope !== issue.reference.scope) {
    ctx.addIssue({ code: 'custom', message: 'scope 与 reference.scope 必须一致' })
  }
})

/** `queue.json` 的完整结构；revision 是 CAS 计数器。 */
export const revisionQueueArtifactSchema = z.object({
  schema_version: recordOnlySchemaVersion(REVISION_QUEUE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issues: z.array(revisionIssueSchema),
}).strict()

/** 一条审批意见。 */
export type RevisionIssue = z.infer<typeof revisionIssueSchema>
/** 审批意见状态。 */
export type RevisionIssueStatus = z.infer<typeof revisionIssueStatusSchema>
/** `queue.json` 的完整结构。 */
export type RevisionQueueArtifact = z.infer<typeof revisionQueueArtifactSchema>
/** 章节引用。 */
export type RevisionIssueReference = z.infer<typeof revisionIssueReferenceSchema>

/** 浏览器提交的新建审批意见输入；身份字段由 Host 填充。 */
export interface AddRevisionIssueInput {
  readonly section_id: string
  readonly scope: 'paragraphs' | 'chapter'
  readonly reference: RevisionIssueReference
  readonly instruction: string
  readonly suggestion: string | null
}

/** 浏览器提交的编辑审批意见输入；只有 `pending` 状态允许。 */
export interface UpdateRevisionIssueInput {
  readonly issue_id: string
  readonly expected_queue_revision: number
  readonly instruction?: string
  readonly suggestion?: string | null
  readonly reference?: RevisionIssueReference
  readonly scope?: 'paragraphs' | 'chapter'
}

/** 浏览器提交的删除审批意见输入；只有 `pending` 状态允许。 */
export interface DeleteRevisionIssueInput {
  readonly issue_id: string
  readonly expected_queue_revision: number
}

/** 队列读写所需的最小工作区接口。 */
export interface RevisionQueueWorkspace {
  readonly root: string
  readonly projectRoot: string
}

/**
 * 解析 `queue.json`；格式无效时拒绝读取，schema_version 仅作为记录字段。
 * @param value 已解码的 JSON 值。
 * @returns 严格业务结构的审批意见队列。
 */
export function parseRevisionQueueArtifact(value: unknown): RevisionQueueArtifact {
  return revisionQueueArtifactSchema.parse(value)
}

/** 空队列的初始结构。 */
export function emptyRevisionQueue(): RevisionQueueArtifact {
  return { schema_version: REVISION_QUEUE_SCHEMA_VERSION, revision: 0, issues: [] }
}

/**
 * 读取持久化队列；文件不存在时返回空队列。
 * @param workspace 项目工作区。
 * @returns 当前审批意见队列。
 */
export async function readRevisionQueue(workspace: RevisionQueueWorkspace): Promise<RevisionQueueArtifact> {
  const absolute = within(workspace.projectRoot, REVISION_QUEUE_PATH)
  let raw: string
  try {
    await assertNoLinkedPath(workspace.root, absolute)
    raw = await readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRevisionQueue()
    throw error
  }
  return parseRevisionQueueArtifact(JSON.parse(raw))
}

/**
 * 在 Host 持有项目锁时原子替换 `queue.json`。
 * @param workspace 项目工作区。
 * @param queue 要写入的完整队列。
 */
export async function writeRevisionQueue(workspace: RevisionQueueWorkspace, queue: RevisionQueueArtifact): Promise<void> {
  const absolute = within(workspace.projectRoot, REVISION_QUEUE_PATH)
  await assertNoLinkedPath(workspace.root, absolute)
  const validated = revisionQueueArtifactSchema.parse(queue)
  await writeFileAtomic(absolute, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 将队列变更与一次 publication 提交，确保 crash-recoverable。
 * @param workspace 项目工作区。
 * @param expectedRevision 调用方读取并持锁时观察到的 revision；`undefined` 表示新建不校验 CAS。
 * @param mutate 在同一 publication 内对队列做确定性变更；可异步读取章节正文做校验。
 * @returns 已提交且 revision 递增一次的队列。
 */
export async function commitRevisionQueueMutation(
  workspace: RevisionQueueWorkspace,
  expectedRevision: number | undefined,
  mutate: (queue: RevisionQueueArtifact) => RevisionQueueArtifact | Promise<RevisionQueueArtifact>,
): Promise<RevisionQueueArtifact> {
  const previous = await readRevisionQueue(workspace)
  if (expectedRevision !== undefined && previous.revision !== expectedRevision) {
    throw new Error('BID_REVISION_QUEUE_CONFLICT')
  }
  const next = revisionQueueArtifactSchema.parse(await mutate(previous))
  if (next === previous) return previous
  const queuePath = within(workspace.projectRoot, REVISION_QUEUE_PATH)
  await publishBidBatch(workspace.root, dirname(queuePath), async (lease) => {
    await lease.writeJson(queuePath, next)
  })
  return next
}

/**
 * 校验浏览器提交的引用对应当前正文版本与完整连续顶层段落。
 * @param reference 浏览器提交的引用。
 * @param markdown 当前章节正文。
 */
export function validateRevisionIssueReference(reference: RevisionIssueReference, markdown: string): void {
  validateChapterParagraphReference({
    scope: reference.scope,
    content_sha256: reference.base_content_sha256,
    ...(reference.scope === 'paragraphs' ? { start: reference.start, end: reference.end, text: reference.text } : {}),
  }, markdown)
}

/** 生成新的 issue_id。 */
export function createRevisionIssueId(): string {
  return `REV-${randomUUID()}`
}

/**
 * 向队列追加一条 `pending` 意见；身份与时间戳由 Host 填充。
 * @param queue 当前队列。
 * @param input 浏览器提交的意见。
 * @param sectionTitle Host 从 confirmed outline 查得的章节标题。
 * @param now 当前时间戳。
 * @returns 含新意见的队列；revision 递增一次。
 */
export function addRevisionIssue(
  queue: RevisionQueueArtifact,
  input: AddRevisionIssueInput,
  sectionTitle: string,
  now: number,
): RevisionQueueArtifact {
  const instruction = input.instruction.trim()
  if (instruction.length === 0) throw new Error('BID_REVISION_ISSUE_INSTRUCTION_EMPTY')
  const issue: RevisionIssue = {
    issue_id: createRevisionIssueId(),
    section_id: input.section_id,
    section_title: sectionTitle,
    scope: input.scope,
    reference: input.reference,
    instruction,
    suggestion: input.suggestion,
    status: 'pending',
    batch_id: null,
    created_at: now,
    updated_at: now,
  }
  return {
    schema_version: REVISION_QUEUE_SCHEMA_VERSION,
    revision: queue.revision + 1,
    issues: [...queue.issues, issue],
  }
}

/**
 * 编辑一条 `pending` 或 `conflict` 意见的 instruction/suggestion/reference；其他状态拒绝。
 * 编辑后状态重置为 `pending`，可供下一批重新规划执行。
 * @param queue 当前队列。
 * @param input 浏览器提交的编辑。
 * @param now 当前时间戳。
 * @returns 含更新意见的队列；revision 递增一次。
 */
export function updateRevisionIssue(
  queue: RevisionQueueArtifact,
  input: UpdateRevisionIssueInput,
  now: number,
): RevisionQueueArtifact {
  const index = queue.issues.findIndex(issue => issue.issue_id === input.issue_id)
  if (index < 0) throw new Error('BID_REVISION_ISSUE_NOT_FOUND')
  const current = queue.issues[index]
  if (current === undefined) throw new Error('BID_REVISION_ISSUE_NOT_FOUND')
  if (current.status !== 'pending' && current.status !== 'conflict') throw new Error('BID_REVISION_ISSUE_NOT_EDITABLE')
  const nextScope = input.scope ?? current.scope
  const nextReference = input.reference ?? current.reference
  if (nextScope !== nextReference.scope) throw new Error('BID_REVISION_ISSUE_SCOPE_MISMATCH')
  const instruction = input.instruction !== undefined ? input.instruction.trim() : current.instruction
  if (instruction.length === 0) throw new Error('BID_REVISION_ISSUE_INSTRUCTION_EMPTY')
  const suggestion = input.suggestion !== undefined ? input.suggestion : current.suggestion
  const updated: RevisionIssue = {
    ...current,
    scope: nextScope,
    reference: nextReference,
    instruction,
    suggestion,
    status: 'pending',
    batch_id: null,
    updated_at: now,
  }
  const issues = queue.issues.slice()
  issues[index] = updated
  return {
    schema_version: REVISION_QUEUE_SCHEMA_VERSION,
    revision: queue.revision + 1,
    issues,
  }
}

/**
 * 物理删除一条 `pending` 意见；其他状态拒绝浏览器直接删除。
 * @param queue 当前队列。
 * @param input 浏览器提交的删除。
 * @returns 不含该意见的队列；revision 递增一次。
 */
export function deleteRevisionIssue(
  queue: RevisionQueueArtifact,
  input: DeleteRevisionIssueInput,
): RevisionQueueArtifact {
  const index = queue.issues.findIndex(issue => issue.issue_id === input.issue_id)
  if (index < 0) throw new Error('BID_REVISION_ISSUE_NOT_FOUND')
  const current = queue.issues[index]
  if (current === undefined) throw new Error('BID_REVISION_ISSUE_NOT_FOUND')
  if (current.status !== 'pending') throw new Error('BID_REVISION_ISSUE_NOT_DELETABLE')
  const issues = queue.issues.slice()
  issues.splice(index, 1)
  return {
    schema_version: REVISION_QUEUE_SCHEMA_VERSION,
    revision: queue.revision + 1,
    issues,
  }
}

/** 重新导出 sha256 工具，供 Remote 层校验当前正文版本。 */
export { chapterContentSha256 }
