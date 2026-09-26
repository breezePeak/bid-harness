import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { readCapabilityPublicationReceipt, readCapabilityStepReceipt } from '../src/bid-capability-changes.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { BID_CAPABILITIES } from '../src/bid-capability-registry.ts'
import { collectDocxExportSnapshot } from '../src/docx-export.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { BidWorkspace } from '../src/index.ts'
import { seedCapabilityProject } from './capability-fixture.ts'
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

it('目录候选校验后中断时旧版本仍可导出，同一 Work 重试才发布新目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-outline-candidate-fault-'))
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  const formalPath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
  const formalBefore = await readFile(formalPath)
  const bodyBefore = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'))
  const exportBefore = (await collectDocxExportSnapshot(workspace)).markdown
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '把第一节改名为设计核验' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '把第一节改名为设计核验', scope: { kind: 'project' }, steps: [{
    scope: { source: 'task' }, call: { capability: 'outline.update', input: {
      operations: [{ type: 'update_section', section_id: 'SEC-1', title: '设计核验' }],
    } },
  }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) },
    BID_CAPABILITIES['outline.update'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const agent = { id: 'outline-fault-agent' } as Parameters<typeof executeCapabilityTask>[3]
  let interrupt = true
  let candidateProjectRoot: string | undefined
  const interrupted = {
    ...dispatcher,
    execute: async (...args: Parameters<typeof dispatcher.execute>) => {
      candidateProjectRoot = args[1].working.projectRoot
      return dispatcher.execute(...args)
    },
    validate: async (...args: Parameters<typeof dispatcher.validate>) => {
      await dispatcher.validate(...args)
      if (interrupt) { interrupt = false; throw new Error('目录候选校验后中断') }
    },
  }
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), interrupted, agent, session))
    .rejects.toThrow('目录候选校验后中断')
  expect(await readFile(formalPath)).toEqual(formalBefore)
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'))).toEqual(bodyBefore)
  expect((await collectDocxExportSnapshot(workspace)).markdown).toBe(exportBefore)
  expect(await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)).toBeNull()
  expect(candidateProjectRoot).toBeDefined()
  const candidate = JSON.parse(await readFile(join(candidateProjectRoot!, 'outline/confirmed-outline.json'), 'utf8')) as {
    sections: Array<{ id: string; title: string }>
  }
  expect(candidate.sections.find(section => section.id === 'SEC-1')?.title).toBe('设计核验')
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session))
    .resolves.toMatchObject({ status: 'completed' })
  const formal = JSON.parse(await readFile(formalPath, 'utf8')) as typeof candidate
  expect(formal.sections.find(section => section.id === 'SEC-1')?.title).toBe('设计核验')
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'))).toEqual(bodyBefore)
  expect(await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256))
    .toMatchObject({ work_id: work.workId })
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
