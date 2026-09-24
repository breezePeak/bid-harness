/** 运行中的能力请求先保存不可变内容，再登记到当前 Work 的命令日志。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidCommitLease, BidRunContext } from './run-coordinator.ts'
import { bidCapabilityTaskSchema, type BidCapabilityTask } from './bid-capability-contract.ts'
import { BID_CAPABILITIES } from './bid-capability-registry.ts'
import { readBidChapterCommandJournal, withBidCommandJournalLock, writeBidChapterCommandJournal,
  type BidChapterCommandRecord } from './chapter-command-journal.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const identity = z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict()
const requestSchema = z.object({ schema_version: z.literal(1), origin_work_id: z.string().min(1),
  queue_id: z.string().regex(/^[a-f0-9]{32}$/u), task: bidCapabilityTaskSchema,
  authorization: identity }).strict()
const commandSchema = z.object({ kind: z.literal('enqueue_capability_task'),
  queue_id: z.string().regex(/^[a-f0-9]{32}$/u), request_ref: z.string().min(1),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()

/** 已登记且尚未交给独立 Work 的用户任务。 */
export interface PendingCapabilityRequest {
  readonly recordId: string
  readonly request: z.infer<typeof requestSchema>
}

function queueId(authorization: z.infer<typeof identity>): string {
  return createHash('sha256').update(`${authorization.session_id}\0${authorization.message_id}`).digest('hex').slice(0, 32)
}

function requestPath(workId: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId) || !/^[a-f0-9]{32}$/u.test(id)) {
    throw new Error('BID_CAPABILITY_QUEUE_ID_INVALID')
  }
  return `runs/${workId}/queued-capability/${id}.json`
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/**
 * 当前 Run 的租约顺序保存请求和待执行命令；孤立请求不构成接纳。
 * @param workspace 正式项目。
 * @param run 当前拥有提交权的 Work。
 * @param task 用户授权的能力计划。
 * @param authorization 当前真实用户消息。
 * @returns 持久化的排队身份。
 */
export async function enqueueCapabilityRequest(
  workspace: BidWorkspace, run: BidRunContext, task: BidCapabilityTask,
  authorization: z.infer<typeof identity>,
): Promise<{ readonly queue_id: string; readonly request_ref: string }> {
  const id = queueId(identity.parse(authorization))
  const path = requestPath(run.work.workId, id)
  const request = requestSchema.parse({ schema_version: 1, origin_work_id: run.work.workId,
    queue_id: id, task, authorization })
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  let existingRequest: unknown
  try { existingRequest = JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existingRequest !== undefined && digest(requestSchema.parse(existingRequest)) !== digest(request)) {
    throw new Error('BID_CAPABILITY_QUEUE_REQUEST_CONFLICT')
  }
  if (existingRequest === undefined) await run.commits.writeJson(absolute, request)
  await run.commits.publish(lease => withBidCommandJournalLock(workspace, run.work.workId, async () => {
    const records = await readBidChapterCommandJournal(workspace, run.work.workId)
    const existing = records.find((record) => {
      const parsed = commandSchema.safeParse(record.command)
      return parsed.success && parsed.data.queue_id === id
    })
    if (existing !== undefined) {
      const command = commandSchema.parse(existing.command)
      if (command.request_sha256 !== digest(request) || command.request_ref !== path) {
        throw new Error('BID_CAPABILITY_QUEUE_REQUEST_CONFLICT')
      }
      return
    }
    const command = commandSchema.parse({ kind: 'enqueue_capability_task', queue_id: id,
      request_ref: path, request_sha256: digest(request) })
    await writeBidChapterCommandJournal(workspace, run.work.workId,
      [...records, { id: randomUUID(), status: 'pending', command }], lease)
  }))
  return { queue_id: id, request_ref: path }
}

/**
 * 只读取命令日志引用且身份、摘要完整的排队请求。
 * @param workspace 正式项目。
 * @param workId 原 Work 身份。
 * @returns 登记顺序的未接纳任务。
 */
export async function readPendingCapabilityRequests(
  workspace: BidWorkspace, workId: string,
): Promise<PendingCapabilityRequest[]> {
  const records = await readBidChapterCommandJournal(workspace, workId)
  const pending: PendingCapabilityRequest[] = []
  for (const record of records) {
    const parsed = commandSchema.safeParse(record.command)
    if (!parsed.success || record.status !== 'pending') continue
    const command = parsed.data
    if (command.request_ref !== requestPath(workId, command.queue_id)) {
      throw new Error('BID_CAPABILITY_QUEUE_PATH_MISMATCH')
    }
    const absolute = within(workspace.projectRoot, command.request_ref)
    await assertNoLinkedPath(workspace.root, absolute)
    const request = requestSchema.parse(JSON.parse(await readFile(absolute, 'utf8')))
    if (request.origin_work_id !== workId || request.queue_id !== command.queue_id
      || digest(request) !== command.request_sha256) throw new Error('BID_CAPABILITY_QUEUE_REQUEST_MISMATCH')
    pending.push({ recordId: record.id, request })
  }
  return pending
}

/**
 * 重启后只从持久命令日志发现待办 Work，不扫描孤立请求文件。
 * @param workspace 正式项目。
 * @returns 含有待办命令的原 Work 身份。
 */
export async function pendingCapabilityWorkIds(workspace: BidWorkspace): Promise<string[]> {
  const root = within(workspace.projectRoot, 'runs')
  await assertNoLinkedPath(workspace.root, root)
  let ids: string[]
  try { ids = await readdir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const pending: string[] = []
  for (const id of ids.filter(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)).sort()) {
    if ((await readPendingCapabilityRequests(workspace, id)).length > 0) pending.push(id)
  }
  return pending
}

/**
 * 新 Work 已持久化接纳后标记原命令；applied 不代表业务成果完成。
 * @param workspace 正式项目。
 * @param originWorkId 原命令日志所属 Work。
 * @param recordId 待标记的命令身份。
 * @param run 当前执行槽的提交租约。
 */
export async function markCapabilityRequestApplied(
  workspace: BidWorkspace, originWorkId: string, recordId: string, run: BidRunContext,
): Promise<void> {
  await run.commits.publish(lease => withBidCommandJournalLock(workspace, originWorkId,
    () => markCapabilityRequestAppliedWithLease(workspace, originWorkId, recordId, lease)))
}

/** 在已有项目 mutation 内确认先前接纳的 Work，避免重启后再启动一个 Run。
 * @param workspace 当前项目。
 * @param originWorkId 保存命令日志的 Work。
 * @param recordId 待结算的命令身份。
 * @param lease 当前项目写入租约。
 */
export async function markCapabilityRequestAppliedWithLease(
  workspace: BidWorkspace, originWorkId: string, recordId: string, lease: BidCommitLease,
): Promise<void> {
  const records = await readBidChapterCommandJournal(workspace, originWorkId)
  const record = records.find(item => item.id === recordId)
  if (record === undefined || !commandSchema.safeParse(record.command).success) {
    throw new Error('BID_CAPABILITY_QUEUE_COMMAND_MISSING')
  }
  if (record.status === 'applied') return
  const next: BidChapterCommandRecord[] = records.map(item => item.id === recordId
    ? { ...item, status: 'applied' } : item)
  await writeBidChapterCommandJournal(workspace, originWorkId, next, lease)
}

/** 重置时取消依赖已删除输入的排队任务，并保留日志中的取消证据。
 * @param workspace 当前项目。
 * @param removedPaths 重置删除的真实路径。
 * @param lease 当前项目写入租约。
 * @returns 被取消的排队任务数。
 */
export async function cancelCapabilityRequestsForReset(
  workspace: BidWorkspace, removedPaths: readonly string[], lease: BidCommitLease,
): Promise<number> {
  const removes = (path: string): boolean => removedPaths.some(removed => path === removed
    || path.startsWith(`${removed}\\`) || path.startsWith(`${removed}/`))
  let canceled = 0
  for (const workId of await pendingCapabilityWorkIds(workspace)) {
    if (removes(within(workspace.projectRoot, `runs/${workId}`))) continue
    const pending = await readPendingCapabilityRequests(workspace, workId)
    const invalid = new Set(pending.filter(({ request }) => request.task.steps.some(step =>
      BID_CAPABILITIES[step.call.capability].requires.some(input => removes(within(workspace.projectRoot,
        input))))).map(item => item.recordId))
    if (invalid.size === 0) continue
    await withBidCommandJournalLock(workspace, workId, async () => {
      const records = await readBidChapterCommandJournal(workspace, workId)
      await writeBidChapterCommandJournal(workspace, workId, records.map(record => invalid.has(record.id)
        ? { ...record, status: 'canceled' as const } : record), lease)
    })
    canceled += invalid.size
  }
  return canceled
}
