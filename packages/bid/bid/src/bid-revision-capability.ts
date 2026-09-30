/** 审批正文批次适配器复用原调度器，只写当前步骤候选；正式结算归任务发布。 */
import { readFile } from 'node:fs/promises'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import type { BidWorkspace } from './index.ts'
import { allowedWritingCapabilityWrites, validateWritingCapability } from './bid-writing-capability.ts'
import { capabilityFileHash } from './bid-capability-files.ts'
import { readChapterLocations } from './chapter-storage.ts'
import { chapterContentSha256, validateChapterRevisionReference } from './chapter-revision.ts'
import { REVISION_QUEUE_PATH, revisionIssueSchema } from './chapter-revision-queue.ts'
import { createRevisionBatch, readRevisionBatch, writeRevisionBatch, validateRevisionBatchPlan,
  type RevisionBatchExecutionInput } from './chapter-revision-batch.ts'
import { buildRevisionComparisonPath } from './chapter-revision-comparison.ts'
import { buildParagraphRevisionReviewPath, readParagraphRevisionReview } from './chapter-paragraph-revision-artifacts.ts'
import { buildChapterRevisionLineagePath } from './chapter-revision-lineage.ts'
import { parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type RevisionCall = Extract<BidCapabilityCall, { capability: 'chapter.revision_batch' }>
/** 在既有 Run 内执行已由 Host 从冻结意见构造的批次。 */
export type CapabilityRevisionRunner = (input: RevisionBatchExecutionInput, context: BidCapabilityExecutionContext) => Promise<void>
const batchIdFor = (stepId: string): string => 'BATCH-' + stepId

/**
 * 从实际章节位置和批次身份列出精确写入路径。
 * @param call 本次同章聚合及依赖。
 * @param workspace 当前候选。
 * @param stepId 稳定步骤身份。
 * @returns 章节、索引及批次辅助文件的精确集合。
 */
export async function allowedRevisionCapabilityWrites(
  call: RevisionCall, workspace: BidWorkspace, stepId: string,
): Promise<ReadonlySet<string>> {
  const ids = new Set(call.input.tasks.map(task => task.section_id))
  const writes = new Set(await allowedWritingCapabilityWrites(workspace, ids))
  const locations = await readChapterLocations(workspace)
  writes.add('chapters/revisions/batches/' + batchIdFor(stepId) + '.json')
  for (const task of call.input.tasks) {
    writes.add(buildRevisionComparisonPath(batchIdFor(stepId), task.task_id))
    writes.add(buildParagraphRevisionReviewPath(batchIdFor(stepId), task.task_id))
    const location = locations.get(task.section_id)
    if (location === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    writes.add(buildChapterRevisionLineagePath(String(location.storageSerial).padStart(4, '0')))
  }
  // queue 只供候选执行器读取；正式队列由任务 publication 从最新版本合并。
  writes.delete(REVISION_QUEUE_PATH)
  return writes
}

/**
 * 重新构造冻结意见的执行输入，稳定复用批次及原 Writer。
 * @param call 已授权的正文分组。
 * @param context 当前候选及唯一 Run。
 * @param runner 原批处理器的底层执行入口。
 * @returns 保存的逐项结果；局部缺输入不丢弃其他候选。
 */
export async function executeRevisionCapability(
  call: RevisionCall, context: BidCapabilityExecutionContext, runner: CapabilityRevisionRunner,
): Promise<{ readonly result: BidCapabilityResult }> {
  const source = context.sourceSnapshot
  if (source === undefined) throw new Error('BID_TASK_SOURCE_REQUIRED')
  const issues = call.input.issue_ids.map((id) => {
    const issue = [...source.issues, ...source.observed_issues].find(item => item.issue_id === id)
    if (issue === undefined) throw new Error('BID_TASK_SOURCE_ISSUE_UNKNOWN')
    if (context.sectionIds !== null && !context.sectionIds.has(issue.section_id)) throw new Error('BID_CAPABILITY_RESULT_SCOPE_INVALID')
    return issue
  })
  const queue = { schema_version: 1 as const, revision: source.queue_revision,
    issues: issues.map(issue => ({ ...issue, status: 'pending' as const, batch_id: null })) }
  const hashes = new Map<string, string>()
  const locations = await readChapterLocations(context.working)
  for (const issue of issues) {
    const location = locations.get(issue.section_id)
    if (location === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    const absolute = within(context.working.projectRoot, location.contentPath)
    await assertNoLinkedPath(context.working.root, absolute)
    hashes.set(issue.section_id, chapterContentSha256(await readFile(absolute, 'utf8')))
  }
  const input = { issue_ids: call.input.issue_ids, expected_queue_revision: source.queue_revision,
    tasks: call.input.tasks.map(({ dependency_reason, ...task }) => ({ ...task,
      ...(dependency_reason === undefined ? {} : { dependency_reason }) })) }
  const validated = validateRevisionBatchPlan(input, queue, hashes)
  const batchId = batchIdFor(context.stepId)
  let batch = await readRevisionBatch(context.working, batchId)
  if (batch === null) {
    batch = createRevisionBatch(queue, input, batchId, Date.now(), validated.staleIssues).batch
    await writeRevisionBatch(context.working, { ...batch, status: 'running' })
  }
  if (JSON.stringify(batch.issue_ids) !== JSON.stringify(call.input.issue_ids)
    || JSON.stringify(batch.tasks.map(task => [task.task_id, task.section_id, task.issue_ids, task.depends_on]))
      !== JSON.stringify(call.input.tasks.map(task => [task.task_id, task.section_id, task.issue_ids, task.depends_on]))) {
    throw new Error('BID_REVISION_BATCH_IDENTITY_MISMATCH')
  }
  // 完成项依据当前正文审核复用；冲突及其依赖留在同一候选，不妨碍独立任务。
  await validateRevisionCapability(call, context, { target_section_ids: [...hashes.keys()], changed_artifacts: [],
    change_summary: '检查已完成候选', warnings: [], missing_topics: [], needs_input: false })
  const runnable = batch.tasks.filter(task => task.status !== 'completed' && task.status !== 'conflict'
    && task.status !== 'blocked')
  const runnableIds = new Set(runnable.map(task => task.task_id))
  const execution: RevisionBatchExecutionInput = { batchId, tasks: runnable.map(task => ({
    ...task, depends_on: task.depends_on.filter(id => runnableIds.has(id)), issues: task.issue_ids.map((id) => {
      const issue = issues.find(item => item.issue_id === id)
      if (issue === undefined) throw new Error('BID_TASK_SOURCE_ISSUE_UNKNOWN')
      return { issue_id: id, instruction: issue.instruction, suggestion: issue.suggestion, scope: issue.scope,
        reference_text: issue.reference.scope === 'paragraphs' ? issue.reference.text : null,
        start: issue.reference.scope === 'paragraphs' ? issue.reference.start : null,
        end: issue.reference.scope === 'paragraphs' ? issue.reference.end : null }
    }),
  })) }
  if (execution.tasks.length > 0) await runner(execution, context)
  const finished = await readRevisionBatch(context.working, batchId)
  if (finished === null) throw new Error('BID_REVISION_BATCH_NOT_FOUND')
  await writeRevisionBatch(context.working, { ...finished,
    status: finished.tasks.every(task => task.status === 'completed') ? 'completed' : 'failed', updated_at: Date.now() })
  const missing = finished.tasks.filter(task => task.status !== 'completed')
    .map(task => task.section_id + '：' + (task.failure?.message ?? task.status))
  const changed: string[] = []
  for (const path of context.allowedWrites) {
    const current = await capabilityFileHash(context.working, path)
    if (current !== undefined && current !== context.baselineHashes.get(path)) changed.push(path)
  }
  return { result: { target_section_ids: [...new Set(issues.map(issue => issue.section_id))],
    changed_artifacts: changed, change_summary: '已保存正文审批批次候选及逐项执行结果',
    warnings: [], missing_topics: missing, needs_input: missing.length > 0 } }
}

/**
 * 每项成功候选须有当前正文对应的 Delta 或完整审核；未满足项保留待输入。
 * @param _call 审批批次输入。
 * @param context 当前步骤。
 * @param result 候选结果。
 */
export async function validateRevisionCapability(
  _call: RevisionCall, context: BidCapabilityExecutionContext, result: BidCapabilityResult,
): Promise<void> {
  const locations = await readChapterLocations(context.working)
  const batch = await readRevisionBatch(context.working, batchIdFor(context.stepId))
  if (batch === null) throw new Error('BID_REVISION_BATCH_NOT_FOUND')
  for (const task of batch.tasks.filter(item => item.status === 'completed')) {
    const location = locations.get(task.section_id)
    if (location === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    const body = await readFile(within(context.working.projectRoot, location.contentPath), 'utf8')
    const delta = await readParagraphRevisionReview(context.working, batch.batch_id, task.task_id)
    if (delta !== null) {
      if (delta.batch_id !== batch.batch_id || delta.task_id !== task.task_id || delta.section_id !== task.section_id
        || delta.issue_ids.length !== task.issue_ids.length
        || delta.after_sha256 !== chapterContentSha256(body)
        || task.issue_ids.some(id => !delta.issue_checks.some(check => check.issue_id === id))) {
        throw new Error('BID_REVISION_REVIEW_INCOMPLETE')
      }
    } else {
      await validateWritingCapability(context, [task.section_id])
      const review = parseChapterReviewArtifact(JSON.parse(await readFile(within(context.working.projectRoot, location.reviewPath), 'utf8')))
      if (review.verdict !== 'pass' || task.issue_ids.some(id =>
        !review.revision_issue_checks?.some(check => check.issue_id === id && check.status === 'satisfied'))) {
        throw new Error('BID_REVISION_REVIEW_INCOMPLETE')
      }
    }
  }
  if (result.target_section_ids.length === 0) throw new Error('BID_REVISION_BATCH_NO_PENDING_ISSUES')
}

/**
 * 单次修订沿用真实消息身份进入同一底层批次，不写正式审批队列。
 * @param call 单次修订请求。
 * @param messageId 真实授权消息身份。
 * @returns 只供候选执行的批次调用。
 */
export function singleRevisionBatchCall(
  call: Extract<BidCapabilityCall, { capability: 'chapter.revise' }>, messageId: string,
): RevisionCall {
  return { capability: 'chapter.revision_batch', input: { issue_ids: [messageId], tasks: [{
    task_id: 'revision', section_id: call.input.reference.section_id, issue_ids: [messageId], depends_on: [],
  }] } }
}

/**
 * 将当前用户的精确引用交给原 Writer 的 Delta/完整审核调度器。
 * @param call 单次修订请求。
 * @param context 当前候选及唯一 Run。
 * @param runner 原 Writer 执行入口。
 * @returns 与批次相同的逐项候选结果。
 */
export async function executeSingleRevisionCapability(
  call: Extract<BidCapabilityCall, { capability: 'chapter.revise' }>,
  context: BidCapabilityExecutionContext, runner: CapabilityRevisionRunner,
): Promise<{ readonly result: BidCapabilityResult }> {
  const source = context.sourceSnapshot
  if (source === undefined) throw new Error('BID_TASK_SOURCE_REQUIRED')
  const { section_id, content_sha256, ...reference } = call.input.reference
  const location = (await readChapterLocations(context.working)).get(section_id)
  if (location === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
  validateChapterRevisionReference(call.input,
    await readFile(within(context.working.projectRoot, location.contentPath), 'utf8'))
  const issue = revisionIssueSchema.parse({ issue_id: source.message.message_id, section_id,
    section_title: section_id, scope: reference.scope,
    reference: { ...reference, base_content_sha256: content_sha256 },
    instruction: call.input.instruction, suggestion: null, status: 'pending', batch_id: null,
    created_at: 0, updated_at: 0 })
  return executeRevisionCapability(singleRevisionBatchCall(call, source.message.message_id),
    { ...context, sourceSnapshot: { ...source, issues: [issue] } }, runner)
}
