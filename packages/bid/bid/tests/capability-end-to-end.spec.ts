import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { readCapabilityPublicationReceipt } from '../src/bid-capability-changes.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { BID_CAPABILITIES } from '../src/bid-capability-registry.ts'
import { indexChapterContentBlocks } from '../src/chapter-content-reuse.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { collectDocxExportSnapshot, executeDocxExport } from '../src/docx-export.ts'
import { parseWritingPlan } from '../src/writing-requirements.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

it('同一能力 Work 先更正招标理解再改目录，正式正文仅按实际范围变化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-end-to-end-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await seedCapabilityProject(workspace, 'complete')
  const untouched = await readFile(join(workspace.projectRoot, 'chapters/sections/0004.md'))
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '更正第三章理解并修改目录标题' }],
    source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '更正第三章理解并修改目录标题', scope: { kind: 'project' }, steps: [
    { scope: { source: 'task' as const }, call: { capability: 'tender.update' as const,
      input: { operations: [{ type: 'update_requirement' as const, requirement_id: 'REQ-3',
        fields: { normalized_requirement: '第三章应说明实施检查' } }] } } },
    { scope: { source: 'task' as const }, call: { capability: 'outline.update' as const,
      input: { operations: [{ type: 'update_section' as const, section_id: 'SEC-3', title: '实施检查' }] } } },
  ] })
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
    BID_CAPABILITIES['tender.update'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const agent = { id: 'deterministic-main' } as Parameters<typeof executeCapabilityTask>[3]
  const outcome = await executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
  expect(outcome.status).toBe('completed')
  const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as {
    requirements: Array<{ id: string; normalized_requirement: string }>
  }
  expect(requirements.requirements.find(item => item.id === 'REQ-3')?.normalized_requirement)
    .toBe('第三章应说明实施检查')
  const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as {
    sections: Array<{ id: string; title: string }>
  }
  expect(outline.sections.find(item => item.id === 'SEC-3')?.title).toBe('实施检查')
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0004.md'))).toEqual(untouched)
  const receipt = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
  expect(receipt?.files.map(file => file.path)).toContain('outline/confirmed-outline.json')
  expect(receipt?.files.map(file => file.path)).toContain('analysis/requirements.json')
  const repeated = await executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
  expect(repeated.status).toBe('completed')
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0004.md'))).toEqual(untouched)
})

it('移动已有章节后保持身份和正文文件，导出按新目录顺序排列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-move-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await seedCapabilityProject(workspace, 'complete')
  const beforeManifest = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')) as {
    chapters: Array<{ section_id: string; content_path: string }>
  }
  const beforeHashes = new Map(await Promise.all(beforeManifest.chapters.map(async entry => [entry.section_id,
    createHash('sha256').update(await readFile(join(workspace.projectRoot, entry.content_path))).digest('hex')] as const)))
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '将第三章移到第一章前面，不改正文' }],
    source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '将第三章移到第一章前面，不改正文',
    scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
      call: { capability: 'outline.update', input: { operations: [{ type: 'move_section',
        section_id: 'SEC-3', parent_id: 'GROUP-A', order: 1 }] } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) },
    BID_CAPABILITIES['outline.update'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const agent = { id: 'deterministic-main' } as Parameters<typeof executeCapabilityTask>[3]
  expect(await executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session))
    .toMatchObject({ status: 'completed' })
  const manifest = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')) as {
    chapters: Array<{ section_id: string; content_path: string }>
  }
  expect(manifest.chapters.map(entry => [entry.section_id, entry.content_path]))
    .toEqual(beforeManifest.chapters.map(entry => [entry.section_id, entry.content_path]))
  for (const entry of manifest.chapters) {
    expect(createHash('sha256').update(await readFile(join(workspace.projectRoot, entry.content_path))).digest('hex'))
      .toBe(beforeHashes.get(entry.section_id))
  }
  const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as {
    sections: Array<{ id: string; parent_id: string | null; order: number }>
  }
  expect(outline.sections.filter(section => section.parent_id === 'GROUP-A')
    .sort((left, right) => left.order - right.order).map(section => section.id))
    .toEqual(['SEC-3', 'SEC-1', 'SEC-2'])
  const exportSnapshot = await collectDocxExportSnapshot(workspace)
  expect(exportSnapshot.markdown.indexOf('章节3')).toBeLessThan(exportSnapshot.markdown.indexOf('章节1'))
})

it('同一完成项目连续更正要求、移动合并章节和局部约束后再次导出，范围外正文保持原值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-repeat-export-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await seedCapabilityProject(workspace, 'complete')
  const original = await readFile(join(workspace.projectRoot, 'chapters/sections/0003.md'))
  const first = await executeDocxExport(workspace, createTestBidRunContext(), 'output/before.docx')
  expect(first).toHaveLength(1)
  const before = (await collectDocxExportSnapshot(workspace)).markdown
  const session = ctx.sessions.create()
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const agent = { id: 'deterministic-main' } as Parameters<typeof executeCapabilityTask>[3]
  const run = async (goal: string, capability: 'tender.update' | 'outline.update', input: unknown) => {
    const message = createUserMessage({ content: [{ type: 'text', text: goal }], source: { kind: 'user' } })
    session.append('user/message', message, { surfaceOp: 'append' })
    const task = bidCapabilityTaskSchema.parse({ goal, scope: { kind: 'project' }, steps: [{
      scope: { source: 'task' }, call: { capability, input },
    }] })
    const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
      { session_id: String(session.id), message_id: String(message.id) }, BID_CAPABILITIES[capability].requires,
      { stage: 'chapter_writing', status: 'completed', run: null })
    return executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
  }
  expect(await run('更正第三章要求的理解', 'tender.update', { operations: [{ type: 'update_requirement',
    requirement_id: 'REQ-3', fields: { normalized_requirement: '第三章应说明实施检查' } }] }))
    .toMatchObject({ status: 'completed' })
  expect(await run('把第三章移到第一章前，不改正文', 'outline.update', { operations: [{
    type: 'move_section', section_id: 'SEC-3', parent_id: 'GROUP-A', order: 1,
  }] })).toMatchObject({ status: 'completed' })
  const firstBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const secondBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
  const assignments = [
    ...indexChapterContentBlocks('SEC-1', firstBody),
    ...indexChapterContentBlocks('SEC-2', secondBody),
  ].map(block => ({ block_id: block.block_id, source_section_id: block.source_section_id,
    source_sha256: block.source_sha256, block_sha256: block.sha256,
    target_section_ids: ['SEC-1'], disposition: 'move' }))
  expect(await run('合并第一章和第二章，保留全部原文', 'outline.update', {
    operations: [{ type: 'merge_sections', section_ids: ['SEC-1', 'SEC-2'],
      title: '合并后的实施方案', purpose: '完整说明实施和交付' }], content_assignments: assignments,
  })).toMatchObject({ status: 'completed' })
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8'))
    .toBe(firstBody + secondBody)
  const planPath = join(workspace.projectRoot, 'chapters/writing-plan.json')
  const priorPlan = parseWritingPlan(JSON.parse(await readFile(planPath, 'utf8')))
  const planMessage = createUserMessage({ content: [{ type: 'text', text: '仅第三章增加实施检查步骤' }],
    source: { kind: 'user' } })
  const planEvent = session.append('user/message', planMessage, { surfaceOp: 'append' })
  const ref = { session_id: String(session.id), message_id: String(planMessage.id), seq: planEvent.seq }
  const planTask = bidCapabilityTaskSchema.parse({ goal: '仅第三章增加实施检查步骤',
    scope: { kind: 'sections', section_ids: ['SEC-3'] }, steps: [{ scope: { source: 'task' },
      call: { capability: 'writing.plan', input: { update_kind: 'patch',
        base_plan_version: priorPlan.plan_version, user_message_refs: [ref],
        summary: '第三章增加实施检查步骤', affected_section_ids: ['SEC-3'], sections: [{
          section_id: 'SEC-3', add_user_message_refs: [ref],
          writing_instructions: ['说明实施检查步骤及核验成果。'],
          acceptance_criteria: { add: [{ description: '说明实施检查步骤及核验成果。',
            priority: 'required', evaluator: { kind: 'semantic' } }], update: [], delete: [] },
        }],
      } } }] })
  const planWork = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', planTask,
    { session_id: String(session.id), message_id: String(planMessage.id) },
    BID_CAPABILITIES['writing.plan'].requires, { stage: 'chapter_writing', status: 'completed', run: null })
  expect(await executeCapabilityTask(workspace, createTestBidRunContext({ work: planWork }), dispatcher, agent, session))
    .toMatchObject({ status: 'completed' })
  const updatedPlan = parseWritingPlan(JSON.parse(await readFile(planPath, 'utf8')))
  expect(updatedPlan.sections.find(section => section.section_id === 'SEC-3')?.writing_instructions)
    .toContain('说明实施检查步骤及核验成果。')
  expect(updatedPlan.sections.find(section => section.section_id === 'SEC-4'))
    .toEqual(priorPlan.sections.find(section => section.section_id === 'SEC-4'))
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0003.md'))).toEqual(original)
  const after = (await collectDocxExportSnapshot(workspace)).markdown
  expect(after).not.toBe(before)
  expect(after.indexOf('章节3')).toBeLessThan(after.indexOf('章节1'))
  const second = await executeDocxExport(workspace, createTestBidRunContext(), 'output/after.docx')
  expect(second).toHaveLength(1)
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0003.md'))).toEqual(original)
  expect(await readFile(join(workspace.outputRoot, 'before.docx'))).not.toHaveLength(0)
  expect(await readFile(join(workspace.outputRoot, 'after.docx'))).not.toHaveLength(0)
}, 30_000)
