import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { executeCapabilityTask } from '../src/bid-capability-task.ts'
import { readCapabilityPublicationReceipt } from '../src/bid-capability-changes.ts'
import { capabilityRecoveryFixture, recoveryDispatcher } from './capability-recovery-fixture.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

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
