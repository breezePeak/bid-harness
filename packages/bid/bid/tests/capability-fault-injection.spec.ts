import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { readCapabilityPublicationReceipt, readCapabilityStepReceipt } from '../src/bid-capability-changes.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { BidWorkspace } from '../src/index.ts'
import { capabilityRecoveryFixture, recoveryDispatcher } from './capability-recovery-fixture.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

it('请求已保存但命令尚未登记时，相同用户消息只恢复原 Work', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const requests = join(fixture.workspace.projectRoot, 'requests')
  const before = await readdir(requests)
  const saved = await readFile(join(fixture.workspace.projectRoot, fixture.work.requestRef))
  const repeated = await persistCapabilityTaskRequest(fixture.workspace, fixture.session, 'chapter_writing',
    fixture.task, fixture.authorization, ['chapters/execution-log.json'],
    { stage: 'chapter_writing', status: 'completed', run: null })
  expect(repeated).toEqual(fixture.work)
  expect(await readdir(requests)).toEqual(before)
  expect(await readFile(join(fixture.workspace.projectRoot, fixture.work.requestRef))).toEqual(saved)
})

it('候选审查中断时正式正文和结果凭据不变，恢复只重试未完成步骤', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const calls: string[] = []
  let fail = true
  const adapter = recoveryDispatcher(async (call) => {
    calls.push(call.capability)
    if (call.capability === 'document.review' && fail) { fail = false; throw new Error('审核前中断') }
  })
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .rejects.toThrow('审核前中断')
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
  await expect(readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readCapabilityPublicationReceipt(fixture.workspace, fixture.work.workId,
    fixture.work.requestSha256)).toBeNull()
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .resolves.toMatchObject({ status: 'completed' })
  expect(calls).toEqual(['chapter.review', 'document.review', 'document.review'])
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json'), 'utf8'))
    .toContain('chapter.review')
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
})

it('两步候选已完成而最终发布失败时，重试只提交原候选', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const calls: string[] = []
  const adapter = recoveryDispatcher(async (call) => { calls.push(call.capability) })
  const run = fixture.run()
  vi.spyOn(run.commits, 'publish').mockRejectedValueOnce(new Error('最终发布前中断'))
  await expect(executeCapabilityTask(fixture.workspace, run, adapter, fixture.agent, fixture.session))
    .rejects.toThrow('最终发布前中断')
  expect(calls).toEqual(['chapter.review', 'document.review'])
  expect(await readCapabilityPublicationReceipt(fixture.workspace, fixture.work.workId,
    fixture.work.requestSha256)).toBeNull()
  await expect(readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .resolves.toMatchObject({ status: 'completed' })
  expect(calls).toEqual(['chapter.review', 'document.review'])
  expect(await readCapabilityPublicationReceipt(fixture.workspace, fixture.work.workId,
    fixture.work.requestSha256)).toMatchObject({ work_id: fixture.work.workId })
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
})

it('步骤候选已发布但顶层检查点未更新时，恢复凭据且不重复启动执行器', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const calls: string[] = []
  const adapter = recoveryDispatcher(async (call) => { calls.push(call.capability) })
  const run = fixture.run()
  const writeJson = run.commits.writeJson.bind(run.commits)
  let checkpointWrites = 0
  vi.spyOn(run.commits, 'writeJson').mockImplementation(async (path, value) => {
    if (path.endsWith('task-checkpoint.json') && ++checkpointWrites === 3) {
      throw new Error('候选已发布，检查点未更新')
    }
    await writeJson(path, value)
  })
  await expect(executeCapabilityTask(fixture.workspace, run, adapter, fixture.agent, fixture.session))
    .rejects.toThrow('候选已发布，检查点未更新')
  const checkpoint = JSON.parse(await readFile(join(fixture.workspace.projectRoot,
    `runs/${fixture.work.workId}/task-checkpoint.json`), 'utf8')) as { steps: Array<{ step_id: string; status: string }> }
  expect(checkpoint.steps.map(step => step.status)).toEqual(['running', 'pending'])
  const workingPaths = await prepareBidWorkingTree(fixture.workspace, fixture.work)
  const working = new BidWorkspace(workingPaths.root, fixture.workspace.config)
  expect(await readCapabilityStepReceipt(working, checkpoint.steps[0]!.step_id))
    .toMatchObject({ result: { change_summary: '完成 chapter.review' } })
  await expect(readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .resolves.toMatchObject({ status: 'completed' })
  expect(calls).toEqual(['chapter.review', 'document.review'])
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
})
