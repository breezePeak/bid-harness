import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { executeCapabilityTask, type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import { capabilityRecoveryFixture, recoveryDispatcher } from './capability-recovery-fixture.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

it('完成凭据重新读取后不重复执行已发布步骤', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const adapter = recoveryDispatcher()
  const execute = vi.spyOn(adapter, 'execute')
  const first = await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session)
  expect(first.status).toBe('completed')
  const before = await readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json'))
  const second = await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session)
  expect(second.status).toBe('completed')
  expect(execute).toHaveBeenCalledTimes(2)
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json'))).toEqual(before)
})

it('输入来源在断点后变化则拒绝恢复，保留已完成候选和正式旧正文', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  let fail = true
  const calls: string[] = []
  const adapter = recoveryDispatcher(async (call) => {
    calls.push(call.capability)
    if (call.capability === 'document.review' && fail) { fail = false; throw new Error('中断') }
  })
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .rejects.toThrow('中断')
  const source = join(fixture.workspace.projectRoot, 'chapters/execution-log.json')
  await writeFile(source, '{"new":true}\n')
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .rejects.toThrow('BID_CAPABILITY_INPUT_CHANGED')
  expect(calls).toEqual(['chapter.review', 'document.review'])
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
  await expect(readFile(join(fixture.workspace.projectRoot, 'chapters/local-review.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('执行器试图改写范围外正文时拒绝发布', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const adapter: CapabilityTaskDispatcher = {
    allowedWrites: async () => new Set(['chapters/local-review.json']),
    execute: async (_call, context) => {
      await context.run.commits.writeText(join(context.working.projectRoot, 'chapters/unrelated.md'), '越界内容\n')
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/unrelated.md'],
        change_summary: '错误改写', warnings: [], missing_topics: [], needs_input: false } }
    },
    validate: async () => {},
  }
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .rejects.toThrow('BID_CAPABILITY_RESULT_ARTIFACT_NOT_ALLOWED')
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
})
