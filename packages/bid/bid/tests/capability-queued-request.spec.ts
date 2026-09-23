import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { cancelCapabilityRequestsForReset, enqueueCapabilityRequest, markCapabilityRequestApplied,
  pendingCapabilityWorkIds, readPendingCapabilityRequests } from '../src/bid-capability-queue.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'

it('请求先落盘再登记；孤立文件不执行且 applied 不重复读取', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-queue-')))
  const run = createTestBidRunContext()
  const authorization = { session_id: 'user-session', message_id: 'message-1' }
  const task = { goal: '更正一条要求', scope: { kind: 'project' as const }, steps: [{
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
  const task = { goal: '更正招标要求', scope: { kind: 'project' as const }, steps: [{
    scope: { source: 'task' as const }, call: { capability: 'tender.update' as const,
      input: { operations: [{ type: 'update_requirement' as const, requirement_id: 'REQ-1',
        fields: { normalized_requirement: '明确实施边界' } }] } },
  }] }
  await enqueueCapabilityRequest(workspace, run, task,
    { session_id: 'user-session', message_id: 'message-1' })
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForReset(workspace,
      [join(workspace.projectRoot, 'chapters')], lease)).toBe(0)
  })
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([run.work.workId])
  await run.commits.publish(async (lease) => {
    expect(await cancelCapabilityRequestsForReset(workspace,
      [join(workspace.projectRoot, 'analysis')], lease)).toBe(1)
  })
  expect(await pendingCapabilityWorkIds(workspace)).toEqual([])
})
