import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { askCapabilityTaskInput, executeCapabilityTask, persistCapabilityTaskRequest,
  type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { BID_CAPABILITIES } from '../src/bid-capability-registry.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { capabilityRecoveryFixture, recoveryDispatcher } from './capability-recovery-fixture.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

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

it('已登记输入文件在断点后丢失时拒绝恢复且不执行剩余步骤', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  const calls: string[] = []
  let interrupt = true
  const adapter = recoveryDispatcher(async (call) => {
    calls.push(call.capability)
    if (call.capability === 'document.review' && interrupt) {
      interrupt = false
      throw new Error('输入删除前中断')
    }
  })
  await expect(executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .rejects.toThrow('输入删除前中断')
  await rm(join(fixture.workspace.projectRoot, 'chapters/execution-log.json'))
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

it('等待输入的步骤在重试时保持原问题，只有用户回答后继续', async () => {
  const fixture = await capabilityRecoveryFixture()
  disposals.push(fixture.dispose)
  let calls = 0
  const adapter = recoveryDispatcher()
  const execute = adapter.execute.bind(adapter)
  adapter.execute = async (call, context) => {
    calls += 1
    if (call.capability === 'chapter.review' && calls === 1) {
      return { result: { target_section_ids: [], changed_artifacts: [], change_summary: '需要补充材料',
        warnings: [], missing_topics: ['请提供审核依据'], needs_input: true } }
    }
    return execute(call, context)
  }
  const first = await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session)
  expect(first.status).toBe('awaiting_input')
  if (first.status !== 'awaiting_input') throw new Error('缺少等待输入步骤')
  expect(calls).toBe(1)
  expect(await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .toEqual(first)
  expect(calls).toBe(1)
  expect(await askCapabilityTaskInput(fixture.session, fixture.work.workId, first,
    async question => ({ id: question.id, selected: ['稍后补充'] }), async () => {})).toBe(false)
  expect(await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .toEqual(first)
  expect(await askCapabilityTaskInput(fixture.session, fixture.work.workId, first,
    async question => ({ id: question.id, selected: [], custom: '依据已提供' }), async () => {})).toBe(true)
  expect(await executeCapabilityTask(fixture.workspace, fixture.run(), adapter, fixture.agent, fixture.session))
    .toMatchObject({ status: 'completed' })
  expect(calls).toBe(3)
  expect(await readFile(join(fixture.workspace.projectRoot, 'chapters/unrelated.md'), 'utf8')).toBe('范围外正文\n')
})

it('段落引用在接纳后变化时，恢复拒绝旧选区且不启动 Writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-stale-paragraph-'))
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const path = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const markdown = await readFile(path, 'utf8')
  const text = '流程一：收集输入。'
  const start = markdown.indexOf(text)
  const reference = { scope: 'paragraphs' as const, section_id: 'SEC-1',
    content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text }
  const message = createUserMessage({ content: [{ type: 'text', text: '缩短选中段落' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', {
    goal: '缩短选中段落', scope: { kind: 'paragraphs', reference },
    steps: [{ scope: { source: 'task' }, call: { capability: 'chapter.revise',
      input: { instruction: '缩短选中段落', reference } } }],
  }, { session_id: String(session.id), message_id: String(message.id) },
  BID_CAPABILITIES['chapter.revise'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  const revised = markdown.replace(text, '流程一：先收集输入。')
  await writeFile(path, revised)
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const agent = { id: 'stale-paragraph-agent' } as Parameters<typeof executeCapabilityTask>[3]
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session))
    .rejects.toThrow('BID_CHAPTER_REVISION_CONFLICT')
  expect(await readFile(path, 'utf8')).toBe(revised)
  await expect(readFile(join(workspace.projectRoot, `requests/${work.workId}/result.json`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('接纳后目标章节被移除时，旧任务拒绝改写相邻章节', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-removed-target-'))
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '修改第一章标题' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', {
    goal: '修改第一章标题', scope: { kind: 'sections', section_ids: ['SEC-1'] },
    steps: [{ scope: { source: 'task' }, call: { capability: 'outline.update', input: {
      operations: [{ type: 'update_section', section_id: 'SEC-1', title: '新标题' }],
      business_bindings: [], content_assignments: [], allow_content_deletion: false,
      defer_content_migration: false,
    } } }],
  }, { session_id: String(session.id), message_id: String(message.id) },
  BID_CAPABILITIES['outline.update'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  const body = join(workspace.projectRoot, 'chapters/sections/0002.md')
  const before = await readFile(body, 'utf8')
  for (const name of ['outline/outline.json', 'outline/confirmed-outline.json']) {
    const path = join(workspace.projectRoot, name)
    const outline = JSON.parse(await readFile(path, 'utf8')) as { sections: Array<{ id: string }> }
    await writeFile(path, `${JSON.stringify({ ...outline, sections: outline.sections.filter(section => section.id !== 'SEC-1') })}\n`)
  }
  const dispatcher = recoveryDispatcher()
  const execute = vi.spyOn(dispatcher, 'execute')
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher,
    { id: 'removed-target-agent' } as Parameters<typeof executeCapabilityTask>[3], session))
    .rejects.toThrow('BID_CAPABILITY_INPUT_CHANGED')
  expect(execute).not.toHaveBeenCalled()
  expect(await readFile(body, 'utf8')).toBe(before)
  await expect(readFile(join(workspace.projectRoot, `requests/${work.workId}/result.json`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
})
