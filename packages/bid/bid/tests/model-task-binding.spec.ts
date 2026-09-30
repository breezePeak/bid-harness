/** 对象选择与程序身份的边界：模型不能提交身份、摘要或正文偏移。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import { bindBidModelTask, bindBidModelWritingPlan, collectBidModelTaskCatalog,
  bidModelTaskJsonSchema, presentBidModelTaskCatalog, bindBidModelOutlineEdit } from '../src/bid-model-task.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { zodJsonSchema } from '../src/zod-json-schema.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { verifyCapabilityTaskScope } from '../src/bid-capability-registry.ts'
import { readCapabilityOutlineBaseline } from '../src/outline-draft-store.ts'
import { addRevisionIssue, readRevisionQueue, writeRevisionQueue } from '../src/chapter-revision-queue.ts'
import { seedMainTaskPlanningProject } from './fixtures/main-task-planning-loop.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bid-model-task-binding-'))
  const workspace = await seedMainTaskPlanningProject(root)
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const body = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const catalog = await collectBidModelTaskCatalog(workspace)
  const section = catalog.objects.sections.findIndex(item => item.id === 'S2.3')
  return { workspace, body, catalog, section }
}

it('模型只选择真实章节位置，任务身份及目录编辑目标由程序绑定', async () => {
  const { catalog, section } = await fixture()
  const input = { goal: '只改本章标题', scope: { kind: 'sections', section_positions: [section] }, steps: [{
    description: '更新本章标题', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
      operations: [{ type: 'update_section', section_position: section, title: '输入与交付流程' }],
    } },
  }] }
  expect(bindBidModelTask(input, catalog)).toMatchObject({ scope: { kind: 'sections', section_ids: ['S2.3'] },
    steps: [{ call: { input: { operations: [{ section_id: 'S2.3' }] } } }] })
  expect(() => bindBidModelTask({ ...input, scope: { kind: 'sections', section_ids: ['S2.3'] } }, catalog))
    .toThrow('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
  expect(() => bindBidModelTask({ ...input, scope: { kind: 'sections', section_positions: [999] } }, catalog))
    .toThrow('BID_MODEL_TASK_OBJECT_UNKNOWN')
  const schema = JSON.stringify(bidModelTaskJsonSchema(zodJsonSchema(bidCapabilityTaskSchema)))
  expect(schema).not.toContain('"source_section_ids":')
  expect(schema).not.toContain('"task_id":')
  expect(schema).not.toContain('"content_sha256":')
  expect(schema).not.toContain('"defer_content_migration":')
})

it('目录迁移时序由后续能力或明确暂缓目标推导，拒绝模型指定程序开关', async () => {
  const { catalog, section } = await fixture()
  const directory = { description: '调整本章结构', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
    operations: [{ type: 'update_section', section_position: section, title: '输入与交付流程' }],
  } } }
  const task = { goal: '调整结构并迁移原文', scope: { kind: 'sections', section_positions: [section] }, steps: [directory] }
  const migration = { description: '迁移原文', scope: { source: 'task' }, call: { capability: 'chapter.reorganize', input: {
    instruction: '保留原文', source_section_positions: [section],
  } } }
  expect(bindBidModelTask(task, catalog).steps[0]?.call.input).toMatchObject({ defer_content_migration: false })
  expect(bindBidModelTask({ ...task, steps: [directory, migration] }, catalog).steps[0]?.call.input)
    .toMatchObject({ defer_content_migration: true })
  expect(bindBidModelTask({ ...task, allow_pending_content: true }, catalog).steps[0]?.call.input)
    .toMatchObject({ defer_content_migration: true })
  expect(() => bindBidModelTask({ ...task, steps: [{ ...directory, call: { ...directory.call,
    input: { ...directory.call.input, defer_content_migration: true } } }] }, catalog))
    .toThrow('BID_MODEL_TASK_PROGRAM_FIELD_FORBIDDEN')
})

it('缺少迁移来源的错误使用模型位置字段名，不引导抄写持久身份', async () => {
  const { catalog, section } = await fixture()
  const task = { goal: '迁移原文', scope: { kind: 'sections', section_positions: [section] }, steps: [{
    description: '迁移原文', scope: { source: 'task' }, call: { capability: 'chapter.reorganize', input: { instruction: '保留原文' } },
  }] }
  expect(() => bindBidModelTask(task, catalog)).toThrow('source_section_positions')
  expect(() => bindBidModelTask(task, catalog)).not.toThrow('source_section_ids')
})

it('程序从原文块计算精确引用，正式正文变更后拒绝旧引用', async () => {
  const { workspace, body, catalog, section } = await fixture()
  const paragraph = catalog.paragraphs.get('S2.3')!.findIndex(item => item.text === '流程一：收集输入。')
  const reference = { scope: 'paragraphs', section_position: section, start_paragraph: paragraph, end_paragraph: paragraph }
  const task = bindBidModelTask({ goal: '仅修改收集输入表达', scope: { kind: 'paragraphs', reference }, steps: [{
    description: '精确修订原选区', scope: { source: 'task' }, call: { capability: 'chapter.revise', input: {
      instruction: '把收集输入改为登记输入', reference,
    } },
  }] }, catalog)
  expect(task.scope).toEqual({ kind: 'paragraphs', reference: { scope: 'paragraphs', section_id: 'S2.3',
    content_sha256: chapterContentSha256(body), start: body.indexOf('流程一：收集输入。'),
    end: body.indexOf('流程一：收集输入。') + '流程一：收集输入。'.length, text: '流程一：收集输入。' } })
  await verifyCapabilityTaskScope(workspace, task.scope, (await readCapabilityOutlineBaseline(workspace)).outline)
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), body.replace('交付成果', '归档成果'))
  await expect(verifyCapabilityTaskScope(workspace, task.scope, (await readCapabilityOutlineBaseline(workspace)).outline))
    .rejects.toThrow()
})

it('审批选区直接绑定冻结引用，模型不能扩大或重算选区', async () => {
  const { workspace, body } = await fixture()
  const text = '收集输入'
  const start = body.indexOf(text)
  const queue = addRevisionIssue(await readRevisionQueue(workspace), { section_id: 'S2.3', scope: 'paragraphs',
    reference: { scope: 'paragraphs', base_content_sha256: chapterContentSha256(body), start, end: start + text.length, text },
    instruction: '改为登记输入', suggestion: null }, '章节1', 1)
  await writeRevisionQueue(workspace, queue)
  const catalog = await collectBidModelTaskCatalog(workspace)
  const task = bindBidModelTask({ goal: '按选区修订', issue_positions: [0],
    scope: { kind: 'paragraphs', reference: { issue_position: 0 } }, steps: [{ description: '只修订原意见选区',
      scope: { source: 'task' }, call: { capability: 'chapter.revise', input: {
        instruction: '改为登记输入', reference: { issue_position: 0 },
      } } }],
  }, catalog)
  expect(task.issue_ids).toEqual([queue.issues[0]!.issue_id])
  expect(task.scope).toMatchObject({ reference: { start, end: start + text.length, text, content_sha256: chapterContentSha256(body) } })
})

it('批次任务与依赖身份由程序生成，模型只选择意见及真正依赖的章节', async () => {
  const { workspace, body, section } = await fixture()
  const second = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
  let queue = await readRevisionQueue(workspace)
  for (const [id, content] of [['S2.3', body], ['SEC-2', second]] as const) {
    queue = addRevisionIssue(queue, { section_id: id, scope: 'chapter', reference: {
      scope: 'chapter', base_content_sha256: chapterContentSha256(content),
    }, instruction: '核对术语及交接', suggestion: null }, id, 1)
  }
  await writeRevisionQueue(workspace, queue)
  const catalog = await collectBidModelTaskCatalog(workspace)
  const next = catalog.objects.sections.findIndex(item => item.id === 'SEC-2')
  const task = bindBidModelTask({ goal: '依次修订有交接依赖的两章', issue_positions: [0, 1],
    scope: { kind: 'sections', section_positions: [section, next] }, steps: [{ description: '按真实依赖续写原 Writer',
      scope: { source: 'task' }, call: { capability: 'chapter.revision_batch', input: { issue_positions: [0, 1], tasks: [
        { section_position: section, issue_positions: [0], depends_on: [] },
        { section_position: next, issue_positions: [1], depends_on: [section], dependency_reason: '第二章依赖第一章交接术语' },
      ] } } }],
  }, catalog)
  const call = task.steps[0]!.call
  if (call.capability !== 'chapter.revision_batch') throw new Error('测试任务缺少批次能力')
  expect(call.input.tasks[0]?.task_id).toMatch(/^revision-[a-f0-9]{16}$/u)
  expect(call.input.tasks[1]?.depends_on).toEqual([call.input.tasks[0]?.task_id])
  expect(new Set(call.input.tasks.map(item => item.task_id)).size).toBe(2)
})

it('真实消息、序号及写作版本由程序绑定，模型只选要求来源', async () => {
  const { workspace, section } = await fixture()
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '本章说明写详细一点。' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  const catalog = await collectBidModelTaskCatalog(workspace, session)
  const plan = bindBidModelWritingPlan({ update_kind: 'patch', user_message_positions: [0], summary: '细化本章说明',
    affected_section_positions: [section], sections: [{ section_position: section, task: '细化说明', add_user_message_positions: [0] }],
  }, catalog)
  expect(plan).toMatchObject({ base_plan_version: 1, affected_section_ids: ['S2.3'],
    user_message_refs: [{ session_id: String(session.id), message_id: String(message.id), seq: session.events.at(-1)!.seq }] })
  const visible = JSON.stringify(presentBidModelTaskCatalog(catalog))
  expect(visible).not.toContain(String(message.id))
  expect(visible).not.toContain(chapterContentSha256(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')))
})

it('首次写作请求绑定持久回答，投影未更新仍可提交，其他会话与已消费身份拒绝绑定', async () => {
  const { workspace } = await fixture()
  await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const request = { schema_version: 1, request_id: 'private-request', attempt_id: 'private-attempt',
    owner_session_id: String(session.id), confirmed_outline_sha256: 'a'.repeat(64), state: 'answered',
    answer: { question_id: 'private-request', kind: 'no_additional_requirements', selected: ['没有，开始编写'] } }
  await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(request))
  const catalog = await collectBidModelTaskCatalog(workspace, session)
  expect(catalog.writingEntry).toEqual({ requestId: 'private-request', attemptId: 'private-attempt' })
  expect((await collectBidModelTaskCatalog(workspace, ctx.sessions.create())).writingEntry).toBeUndefined()
  await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify({ ...request,
    state: 'consumed', applied_plan_version: 1 }))
  expect((await collectBidModelTaskCatalog(workspace, session)).writingEntry).toBeUndefined()
})

it('原生目录选择使用冻结草稿，拒绝模型提供版本或混用正式章节位置', async () => {
  const { catalog } = await fixture()
  const section = catalog.outlineDraft!.sections.findIndex(entry => entry.id === 'S2.3')
  expect(bindBidModelOutlineEdit({ operations: [{ type: 'update_section', draft_section_position: section, title: '实施流程' }] }, catalog))
    .toMatchObject({ expected_revision: catalog.outlineDraft!.revision, expected_draft_sha256: catalog.outlineDraft!.sha256,
      operations: [{ section_id: 'S2.3', title: '实施流程' }] })
  expect(() => bindBidModelOutlineEdit({ expected_revision: 1, operations: [] }, catalog)).toThrow('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
  expect(() => bindBidModelOutlineEdit({ operations: [{ type: 'update_section', section_position: section }] }, catalog))
    .toThrow('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
})

it('选择表分页保留全局位置，正文窗口不会泄露其他块或冒充完整正文', async () => {
  const { catalog, section } = await fixture()
  const many = { ...catalog, objects: { ...catalog.objects,
    requirements: Array.from({ length: 45 }, (_, index) => ({ id: 'private-' + String(index), label: '要求' + String(index) })) } }
  const visible = presentBidModelTaskCatalog(many, ['S2.3'], { page: 1, pageSize: 20, offset: 0, maxChars: 1 })
  const projected = visible as { requirements: readonly { position: number; label: string }[] }
  expect(projected.requirements).toHaveLength(20)
  expect(projected.requirements[0]).toMatchObject({ position: 20, label: '要求20' })
  expect(visible).toMatchObject({
    pages: { requirements: { page: 1, total: 45, has_more: true } },
    selected_sections: [{ position: section, paragraphs: [], paragraph_window: { visible: 0 } }] })
  expect(JSON.stringify(visible)).not.toContain('private-')
  expect(JSON.stringify(visible)).not.toContain('流程一：收集输入。')
})
