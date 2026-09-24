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
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { collectDocxExportSnapshot } from '../src/docx-export.ts'
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
