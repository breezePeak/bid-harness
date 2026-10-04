import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { cancelCapabilityRequestsForPlanPatch, cancelCapabilityRequestsForReset, enqueueCapabilityRequest, markCapabilityRequestApplied,
  pendingCapabilityWorkIds, readPendingCapabilityRequests } from '../src/bid-capability-queue.ts'
import { readBidChapterCommandJournal, withBidCommandJournalLock,
  writeBidChapterCommandJournal } from '../src/chapter-command-journal.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'

it('请求先落盘再登记；孤立文件不执行且 applied 不重复读取', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-queue-')))
  const run = createTestBidRunContext()
  const authorization = { session_id: 'user-session', message_id: 'message-1' }
  const task = { goal: '更正一条要求', scope: { kind: 'project' as const }, steps: [{ description: '执行已授权的测试步骤',
    scope: { source: 'task' as const }, call: { capability: 'tender.update' as const,
      input: { operations: [{ type: 'update_requirement' as const, requirement_id: 'REQ-1',
        fields: { normalized_requirement: '明确实施边界' } }] } },
  }] }
  const orphan = join(workspace.projectRoot, 'runs', run.work.workId, 'queued-capability', 'f'.repeat(32) + '.json')
  await mkdir(dirname(orphan), { recursive: true })
  await writeFile(orphan, '{}\n')
  expect(await readPendingCapabilityRequests(workspace, run.work.workId)).toEqual([])
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([])
  const queued = await enqueueCapabilityRequest(workspace, run, task, authorization)
  expect(queued.request_ref).toContain(queued.queue_id)
  const pending = await readPendingCapabilityRequests(workspace, run.work.workId)
  expect(pending).toHaveLength(1)
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([run.work.workId])
  expect(pending[0]?.request.task).toEqual(task)
  expect(await enqueueCapabilityRequest(workspace, run, task, authorization)).toEqual(queued)
  await expect(enqueueCapabilityRequest(workspace, run, { ...task, goal: '其他目标' }, authorization))
    .rejects.toThrow('BID_CAPABILITY_QUEUE_REQUEST_CONFLICT')
  await markCapabilityRequestApplied(workspace, run.work.workId, pending[0]!.recordId, run)
  expect(await readPendingCapabilityRequests(workspace, run.work.workId)).toEqual([])
})

it('重置删除必需输入时取消已登记请求，其他请求保留', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-reset-')))
  const run = createTestBidRunContext()
  const task = { goal: '更正招标要求', scope: { kind: 'project' as const }, steps: [{ description: '执行已授权的测试步骤',
    scope: { source: 'task' as const }, call: { capability: 'tender.update' as const,
      input: { operations: [{ type: 'update_requirement' as const, requirement_id: 'REQ-1',
        fields: { normalized_requirement: '明确实施边界' } }] } },
  }] }
  await enqueueCapabilityRequest(workspace, run, task,
    { session_id: 'user-session', message_id: 'message-1' })
  await enqueueCapabilityRequest(workspace, run, { goal: '分析招标文件', scope: { kind: 'project' },
    steps: [{ description: '执行已授权的测试步骤', scope: { source: 'task' }, call: { capability: 'tender.analyze', input: {} } }],
  }, { session_id: 'user-session', message_id: 'message-2' })
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForReset(workspace,
      [join(workspace.projectRoot, 'chapters')], lease)).toBe(0)
  })
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([run.work.workId])
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForReset(workspace,
      [join(workspace.projectRoot, 'analysis')], lease)).toBe(1)
  })
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([run.work.workId])
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForReset(workspace,
      [join(workspace.projectRoot, 'manifest.json')], lease)).toBe(1)
  })
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([])
})

it('原计划接纳同一消息的修正后取消重复排队，其他消息和会话的请求保留', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-replan-queue-')))
  const run = createTestBidRunContext()
  const task = { goal: '分析招标文件', scope: { kind: 'project' as const },
    steps: [{ description: '读取已登记招标文件', scope: { source: 'task' as const },
      call: { capability: 'tender.analyze' as const, input: {} } }] }
  const authorization = { session_id: 'user-session', message_id: 'same-intent' }
  const replaced = await enqueueCapabilityRequest(workspace, run, task, authorization)
  await enqueueCapabilityRequest(workspace, run, task, { ...authorization, message_id: 'later-intent' })
  await enqueueCapabilityRequest(workspace, run, task, { ...authorization, session_id: 'other-session' })
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForPlanPatch(workspace, run.work.workId, authorization, lease)).toBe(1)
  })
  const pending = await readPendingCapabilityRequests(workspace, run.work.workId)
  expect(pending.map(item => item.request.authorization)).toEqual([
    { ...authorization, message_id: 'later-intent' }, { ...authorization, session_id: 'other-session' },
  ])
  expect((await readBidChapterCommandJournal(workspace, run.work.workId))[0]).toMatchObject({
    status: 'canceled', command: { queue_id: replaced.queue_id, request_ref: replaced.request_ref },
  })
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForPlanPatch(workspace, run.work.workId, authorization, lease)).toBe(0)
  })
})

it('同一 Work 的并发命令日志更新均保留', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-command-lock-')))
  const run = createTestBidRunContext()
  let releaseFirst!: () => void
  let signalFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => { signalFirst = resolve })
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve })
  const append = (id: string, wait: boolean) => withBidCommandJournalLock(workspace, run.work.workId,
    async () => {
      const records = await readBidChapterCommandJournal(workspace, run.work.workId)
      if (wait) { signalFirst(); await firstReleased }
      await run.commits.publish(lease => writeBidChapterCommandJournal(workspace, run.work.workId,
        [...records, { id, status: 'pending', command: { kind: 'test' } }], lease))
    })
  const first = append('11111111-1111-4111-8111-111111111111', true)
  await firstHeld
  const second = append('22222222-2222-4222-8222-222222222222', false)
  releaseFirst()
  await Promise.all([first, second])
  expect((await readBidChapterCommandJournal(workspace, run.work.workId)).map(record => record.id))
    .toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
})
