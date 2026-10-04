import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace, checkpointBidProjectState, outlineArtifactSha256, parseOutlineArtifact } from '../src/index.ts'
import { inspectBidProject } from '../src/bid-project-inspect.ts'
import { activeCapabilityMappingWorkspace, askCapabilityTaskInput, capabilityTaskCheckpointSchema,
  capabilityTaskRequestSchema, findCapabilityTaskRequest, hasPendingCapabilityCorrection,
  patchCapabilityTaskSteps, persistCapabilityTaskRequest,
  type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import { executeTestCapabilityTask as executeCapabilityTask } from './fixtures/task-verifier.ts'
import { bidCapabilityTaskSchema, type BidCapabilityCall } from '../src/bid-capability-contract.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { persistBidWorkRequest, readBidWorkRequest } from '../src/work-descriptor.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-task-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), '{"section_mappings":[]}\n')
  await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), '{}\n')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '审核章节和整书' }], source: { kind: 'user' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = { goal: '审核章节和整书', scope: { kind: 'project' as const }, steps: [
    { description: '审核章节', scope: { source: 'task' as const }, call: { capability: 'chapter.review' as const, input: { reason: '审核章节' } } },
    { description: '审核整书', scope: { source: 'task' as const }, call: { capability: 'document.review' as const, input: { reason: '审核整书' } } },
  ] }
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const descriptor = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
    ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null })
  const run = createTestBidRunContext({ work: descriptor })
  const agent = { id: 'execution-agent' } as Parameters<typeof executeCapabilityTask>[3]
  return { ctx, workspace, session, task, authorization, descriptor, run, agent }
}

function dispatcher(failSecond = false) {
  let failed = false
  const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (call, context) => {
    if (failSecond && call.capability === 'document.review' && !failed) {
      failed = true
      await context.run.commits.writeText(join(context.working.projectRoot, 'chapters/local-review.json'), '损坏的前一步输出')
      throw new Error('第二步暂时失败')
    }
    const path = call.capability === 'chapter.review' ? 'chapters/local-review.json' : 'chapters/document-review.json'
    await context.run.commits.writeJson(join(context.working.projectRoot, path), { reviewed: call.capability })
    return { result: { target_section_ids: [], changed_artifacts: [path], change_summary: '完成审核',
      warnings: [], missing_topics: [], needs_input: false } }
  })
  return {
    allowedWrites: async (call: BidCapabilityCall) => new Set([call.capability === 'chapter.review'
      ? 'chapters/local-review.json' : 'chapters/document-review.json']),
    execute,
    validate: async () => {},
  }
}

describe('同一 Work 的能力序列', () => {
  it.each(['instruction', 'same_input', 'repatch', 'tamper', 'bindings', 'bindings_repatch', 'bindings_tamper', 'restart'])('重新规划保留部分正文候选；新授权可从已接纳结果重新迁移（%s）', async (scenario) => {
    const { ctx, workspace, session } = await fixture()
    try {
      await seedCapabilityProject(workspace, 'complete')
      const message = createUserMessage({ content: [{ type: 'text', text: '完成两章正文' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const task = bidCapabilityTaskSchema.parse({ goal: '完成两章正文',
        scope: { kind: 'sections', section_ids: ['SEC-1', 'SEC-2'] }, steps: [
          { description: '写完两章', scope: { source: 'task' },
            call: { capability: 'chapter.write', input: { instruction: '写完两章' } } },
        ] })
      const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
        ['outline/confirmed-outline.json'], { stage: 'chapter_writing', status: 'completed', run: null })
      const run = createTestBidRunContext({ work })
      const firstPath = 'chapters/sections/0001.md'
      const secondPath = 'chapters/sections/0002.md'
      const original = await readFile(join(workspace.projectRoot, firstPath), 'utf8')
      let sourcePath = ''
      let calls = 0
      let bindings = 0
      const adapter: CapabilityTaskDispatcher = {
        allowedWrites: async call => new Set(call.capability === 'outline.update'
          ? ['outline/confirmed-outline.json', 'chapters/writing-plan.json'] : [firstPath, secondPath]),
        validate: async () => {},
        execute: async (call, context) => {
          if (call.capability === 'chapter.reorganize') {
            expect(await readFile(join(context.working.projectRoot, firstPath), 'utf8')).toBe(original)
            return { result: { target_section_ids: ['SEC-1', 'SEC-2'], changed_artifacts: [],
              change_summary: '从已接纳正文重新迁移', warnings: [], missing_topics: [], needs_input: false } }
          }
          if (call.capability === 'outline.update') {
            bindings += 1
            const path = join(context.working.projectRoot, 'outline/confirmed-outline.json')
            const outline = JSON.parse(await readFile(path, 'utf8')) as { sections: Array<{ id: string; requirement_ids: string[] }> }
            outline.sections.find(section => section.id === 'SEC-2')!.requirement_ids = ['REQ-1']
            await context.run.commits.writeJson(path, outline)
            if (bindings === 1) {
              const planPath = join(context.working.projectRoot, 'chapters/writing-plan.json')
              const plan = JSON.parse(await readFile(planPath, 'utf8')) as { confirmed_outline_sha256: string; plan_version: number }
              plan.confirmed_outline_sha256 = outlineArtifactSha256(parseOutlineArtifact(outline))
              plan.plan_version += 1
              await context.run.commits.writeJson(planPath, plan)
            }
            return { result: { target_section_ids: ['SEC-2'], changed_artifacts: bindings === 1
              ? ['outline/confirmed-outline.json', 'chapters/writing-plan.json'] : [],
            change_summary: '纠正第二章业务绑定', warnings: [], missing_topics: [], needs_input: false } }
          }
          calls += 1
          if (calls === 1) {
            sourcePath = join(context.working.projectRoot, firstPath)
            await context.run.commits.writeText(sourcePath, '已完成的第一章正文\n')
            throw new Error('第二章中断')
          }
          expect(context.resumeCandidate).toBe(scenario === 'restart' ? undefined : true)
          expect(await readFile(join(context.working.projectRoot, firstPath), 'utf8'))
            .toBe(scenario === 'restart' ? original : '已完成的第一章正文\n')
          if (scenario.startsWith('bindings')) {
            const outline = JSON.parse(await readFile(join(context.working.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as {
              sections: Array<{ id: string; requirement_ids: string[] }>
            }
            expect(outline.sections.find(section => section.id === 'SEC-2')?.requirement_ids).toEqual(['REQ-1'])
          }
          await context.run.commits.writeText(join(context.working.projectRoot, secondPath), '补齐第二章正文\n')
          return { result: { target_section_ids: ['SEC-1', 'SEC-2'], changed_artifacts: [secondPath],
            change_summary: '保留第一章并完成第二章', warnings: [], missing_topics: [], needs_input: false } }
        },
      }
      const main = { id: session.id, session, ctx: { get: (name: string) =>
        name === 'agents' ? { get: () => main } : undefined } } as Parameters<typeof executeCapabilityTask>[3]
      await expect(executeCapabilityTask(workspace, run, adapter, main, session)).rejects.toThrow('第二章中断')
      session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'suspended', run: {
        runId: run.runId, epoch: 1, baseProjectRevision: 0, controlRevision: 0, work,
        interactionSessionId: String(session.id), executionSessionId: 'test-execution', startedAt: 1, updatedAt: 2,
        cause: 'retry_exhausted', error: { code: 'BID_EXECUTOR_ERROR', message: '第二章中断',
          recovery: { kind: 'repair', unit: work.workId, reason: '补齐失败章节' } },
      } } })
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, work)).root, workspace.config)
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
      const replacement = { ...task.steps[0]!, description: '保留第一章并补齐第二章',
        call: { capability: 'chapter.write' as const,
          input: { instruction: scenario === 'same_input' ? '写完两章' : '保留已完成候选，只补失败章节' } } }
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
        [{ ...replacement, scope: { source: 'section_ids', section_ids: ['SEC-2'] } }], main, adapter))
        .rejects.toThrow('BID_CAPABILITY_WRITING_RESUME_SCOPE_NARROWED')
      const bindingStep = bidCapabilityTaskSchema.parse({ ...task, steps: [{
        description: '纠正第二章业务绑定', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
          operations: [], business_bindings: [{ section_id: 'SEC-2', requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-2'],
            scoring_response_point_ids: ['RP-000002'], compliance_ids: [] }],
        } } }, replacement] }).steps[0]!
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
        [{ ...bindingStep, call: { capability: 'outline.update', input: {
          operations: [{ type: 'delete_section', section_id: 'SEC-1' }], business_bindings: [], content_assignments: [],
          allow_content_deletion: false, defer_content_migration: false,
        } } }, replacement], main, adapter)).rejects.toThrow('BID_CAPABILITY_WRITING_RESUME_REQUIRED')
      if (scenario === 'restart') {
        const migration = bidCapabilityTaskSchema.parse({ ...task, steps: [{ description: '重新迁移完整原文', scope: { source: 'task' },
          call: { capability: 'chapter.reorganize', input: { instruction: '重新迁移全部原文', source_section_ids: ['SEC-1', 'SEC-2'] } } }, replacement] }).steps[0]!
        await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
          [migration, replacement], main, adapter, undefined, true)).rejects.toThrow('BID_CAPABILITY_CANDIDATE_RESTART_UNAUTHORIZED')
        const restartMessage = createUserMessage({ content: [{ type: 'text', text: '保留旧候选历史，从已接纳结果重新迁移并写作。' }], source: { kind: 'user' } })
        session.append('turn/start', { turn: 3 })
        session.append('user/message', restartMessage, { surfaceOp: 'append' })
        const restartAuthorization = { session_id: String(session.id), message_id: String(restartMessage.id) }
        const narrow = { ...migration, call: { capability: 'chapter.reorganize' as const,
          input: { instruction: '遗漏第一章', source_section_ids: ['SEC-2'], allow_content_deletion: false } } }
        await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, restartAuthorization, 0,
          [narrow, replacement], main, adapter, undefined, true)).rejects.toThrow('BID_CAPABILITY_CANDIDATE_RESTART_SCOPE_REQUIRED')
        const restarted = await patchCapabilityTaskSteps(run, workspace, working, request, session, restartAuthorization, 0,
          [migration, replacement], main, adapter, undefined, true)
        expect(restarted.plan_patches.at(-1)?.restart_pending).toBe(true)
        expect(restarted.steps.every(step => step.writing_resume_seed === undefined)).toBe(true)
        await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), adapter, main, session))
          .resolves.toMatchObject({ status: 'completed' })
        expect(await readFile(sourcePath, 'utf8')).toBe('已完成的第一章正文\n')
        expect(await readFile(join(workspace.projectRoot, firstPath), 'utf8')).toBe(original)
        return
      }
      const prefix = scenario.startsWith('bindings') ? [bindingStep] : []
      const patched = await patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
        [...prefix, replacement], main, adapter)
      const seed = patched.steps[prefix.length]?.writing_resume_seed
      expect(seed?.files.some(file => file.path === firstPath)).toBe(true)
      if (prefix.length > 0) expect(seed?.source_step_id).toBe(patched.steps[0]?.step_id)
      if (scenario.endsWith('repatch')) {
        const twice = await patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
          [...prefix, ...prefix, { ...replacement,
            call: { capability: 'chapter.write', input: { instruction: '再次明确只补失败章节' } } }], main, adapter)
        expect(twice.steps[prefix.length * 2]?.writing_resume_seed).toEqual(seed)
      }
      expect(await readFile(join(workspace.projectRoot, firstPath), 'utf8')).toBe(original)
      if (scenario.endsWith('tamper')) {
        await writeFile(sourcePath, '哈希不匹配的候选\n')
        await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), adapter, main, session))
          .rejects.toThrow('BID_CAPABILITY_WRITING_RESUME_FILE_MISMATCH')
        expect(calls).toBe(1)
        expect(await readFile(join(workspace.projectRoot, firstPath), 'utf8')).toBe(original)
      } else {
        await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), adapter, main, session))
          .resolves.toMatchObject({ status: 'completed' })
        expect(calls).toBe(2)
        expect(bindings).toBe(prefix.length * (scenario.endsWith('repatch') ? 2 : 1))
        expect(await readFile(join(workspace.projectRoot, firstPath), 'utf8')).toBe('已完成的第一章正文\n')
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('已接纳步骤缺少展示说明时仍可读取，新的任务输入仍须提供说明', async () => {
    const { ctx, workspace, descriptor, task } = await fixture()
    try {
      const request = await readBidWorkRequest(workspace, descriptor) as { task: typeof task }
      const steps = task.steps.map(({ description: _description, ...step }) => step)
      expect(bidCapabilityTaskSchema.safeParse({ ...task, steps }).success).toBe(false)
      const restored = capabilityTaskRequestSchema.parse({ ...request, task: { ...task, steps } })
      const checkpoint = capabilityTaskCheckpointSchema.parse({ schema_version: 1, work_id: descriptor.workId,
        request_sha256: descriptor.requestSha256, plan_patches: [],
        steps: steps.map((step, index) => ({ step_id: `step-${index}`, step, status: 'pending',
          authorization: restored.authorization })) })
      expect(checkpoint.steps.map(record => record.step)).toEqual(restored.task.steps)
    } finally { await ctx.fiber.dispose() }
  })

  it('主 Agent 沿用原授权替换可恢复失败步骤，保留已完成结果并继续后续能力', async () => {
    const { ctx, workspace, session, descriptor, run, agent, authorization } = await fixture()
    try {
      const adapter = dispatcher(true)
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('第二步暂时失败')
      session.append('turn/start', { turn: 2 })
      const main = { id: session.id, session, ctx: { get: (name: string) =>
        name === 'agents' ? { get: () => main } : undefined } } as Parameters<typeof executeCapabilityTask>[3]
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      const replacement = [{ description: '按章节复核未完成目标', scope: { source: 'task' as const }, call: {
        capability: 'chapter.review' as const, input: { reason: '按章节复核未完成目标' },
      } }, { description: '核对整项任务结果', scope: { source: 'task' as const }, call: {
        capability: 'document.review' as const, input: { reason: '核对整项任务结果' },
      } }]
      const patch = (from = 1) => patchCapabilityTaskSteps(run, workspace, working, request, session,
        authorization, from, replacement, main)
      await expect(patch()).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
      const state = { stage: 'chapter_writing' as const, status: 'suspended' as const, run: {
        runId: run.runId, epoch: 1, baseProjectRevision: 0, controlRevision: 0, work: descriptor,
        interactionSessionId: String(session.id), executionSessionId: 'execution-agent', startedAt: 1, updatedAt: 2,
        cause: 'retry_exhausted' as const, error: { code: 'BID_EXECUTOR_ERROR', message: '需调整能力计划',
          recovery: { kind: 'repair' as const, unit: descriptor.workId, reason: '原能力无法完成目标' } },
      } }
      session.append('bid.task.changed', { state: { ...state, run: { ...state.run, cause: 'user_stop' } } })
      await expect(patch()).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
      session.append('bid.task.changed', { state })
      await checkpointBidProjectState(workspace, state)
      const view = await inspectBidProject(workspace, { object: 'task' })
      expect(view.data).toMatchObject({ capability_task: { work_id: descriptor.workId,
        goal: request.task.goal, scope: request.task.scope, steps: [
          { index: 0, status: 'completed', call: { capability: 'chapter.review' } },
          { index: 1, status: 'running', call: { capability: 'document.review' } },
        ] } })
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 1, replacement,
        { ...main, ctx })).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
      await expect(patch(0)).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP')
      const patched = await patch()
      expect(patched.steps.map(step => step.status)).toEqual(['completed', 'pending', 'pending'])
      expect(patched.steps[0]).toMatchObject({ result: { change_summary: '完成审核' } })
      expect(patched.steps[0]?.step.description).toBe(request.task.steps[0]?.description)
      expect(patched.steps.slice(1).map(step => step.step.description)).toEqual(replacement.map(step => step.description))
      expect((await patch()).plan_patches).toHaveLength(1)
      adapter.execute.mockImplementationOnce(async () => ({ result: { target_section_ids: [], changed_artifacts: [],
        change_summary: '既有章节审核结果满足要求', warnings: [], missing_topics: [], needs_input: false } }))
      await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute.mock.calls.map(([call]) => call.capability))
        .toEqual(['chapter.review', 'document.review', 'chapter.review', 'document.review'])
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).not.toContain('损坏')
    } finally { await ctx.fiber.dispose() }
  })

  it('步骤说明随请求保存，缺失或空白说明不能接纳为能力任务', async () => {
    const { ctx, workspace, session } = await fixture()
    try {
      const message = createUserMessage({ content: [{ type: 'text', text: '重构整本评分目录' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const task = bidCapabilityTaskSchema.parse({ goal: '重构整本评分目录', scope: { kind: 'project' }, steps: [{ description: '六个评分章并列',
        scope: { source: 'task' }, call: { capability: 'outline.refine', input: { feedback: '六个评分章并列' } },
      }] })
      const returnState = { stage: 'evidence_mapping' as const, status: 'ready' as const, run: null }
      for (const description of [undefined, '', '   ']) {
        await expect(persistCapabilityTaskRequest(workspace, session, 'evidence_mapping', {
          ...task, steps: [{ ...task.steps[0]!, description }],
        } as typeof task, authorization, [], returnState)).rejects.toThrow()
      }
      await expect(findCapabilityTaskRequest(workspace, authorization)).resolves.toBeNull()
      const work = await persistCapabilityTaskRequest(workspace, session, 'evidence_mapping', task,
        authorization, [], returnState)
      const saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
      expect(saved.task.steps[0]?.description).toBe('六个评分章并列')
      const checkpointPath = join(workspace.projectRoot, 'runs', work.workId, 'task-checkpoint.json')
      await mkdir(join(workspace.projectRoot, 'runs', work.workId), { recursive: true })
      await writeFile(checkpointPath, JSON.stringify({
        schema_version: 1, work_id: work.workId, request_sha256: work.requestSha256, plan_patches: [],
        steps: [{ step_id: 'step-test', step: task.steps[0], status: 'running',
          authorization, input_sha256: 'a'.repeat(64) }],
      }))
      expect(await activeCapabilityMappingWorkspace(workspace, work)).toBeNull()
      const candidateRoot = join(workspace.projectRoot, 'runs', work.workId, 'work',
        '.bid-harness', 'runs', 'step-test-aaaaaaaaaaaa', 'work')
      await mkdir(candidateRoot, { recursive: true })
      const candidate = await activeCapabilityMappingWorkspace(workspace, work)
      expect(candidate?.root).toBe(candidateRoot)
    } finally { await ctx.fiber.dispose() }
  })

  it('历史不完整计划可读取，但新任务接纳拒绝相同的步骤遗漏', async () => {
    const { ctx, workspace, session, descriptor, authorization } = await fixture()
    try {
      const previous = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const task = bidCapabilityTaskSchema.parse({ goal: '拆分背景与目标', scope: { kind: 'project' }, steps: [{ description: '执行已授权的测试步骤',
        scope: { source: 'task' }, call: { capability: 'outline.update', input: {
          operations: [{ type: 'split_section', section_id: 'A', children: [
            { title: '背景', purpose: '背景', must_answer: ['背景'] },
            { title: '目标', purpose: '目标', must_answer: ['目标'] },
          ] }], defer_content_migration: true,
        } },
      }] })
      const historicalAuthorization = { ...authorization, message_id: 'historical-message' }
      const historical = await persistBidWorkRequest(workspace, 'capability_task', 'chapter_writing',
        { ...previous, task, authorization: historicalAuthorization }, previous.input_sources)
      await expect(findCapabilityTaskRequest(workspace, historicalAuthorization)).resolves.toEqual(historical)
      const message = createUserMessage({ content: [{ type: 'text', text: '执行拆分并修改正文' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const next = { session_id: String(session.id), message_id: String(message.id) }
      await expect(persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, next,
        [], previous.return_state)).rejects.toThrow('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED')
      await expect(findCapabilityTaskRequest(workspace, next)).resolves.toBeNull()
    } finally { await ctx.fiber.dispose() }
  })

  it('段落任务的后续计划补丁不能换成整章写作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-capability-paragraph-patch-'))
    roots.push(root)
    const workspace = new BidWorkspace(root)
    await seedCapabilityProject(workspace, 'complete')
    const markdown = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const text = '流程一：收集输入。'
    const start = markdown.indexOf(text)
    const reference = { scope: 'paragraphs' as const, section_id: 'SEC-1',
      content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create()
      const original = createUserMessage({ content: [{ type: 'text', text: '缩短选中段落' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', original, { surfaceOp: 'append' })
      const task = { goal: '缩短选中段落', scope: { kind: 'paragraphs' as const, reference }, steps: [{ description: '缩短选中段落',
        scope: { source: 'task' as const }, call: { capability: 'chapter.revise' as const,
          input: { instruction: '缩短选中段落', reference } },
      }] }
      const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
        { session_id: String(session.id), message_id: String(original.id) },
        ['chapters/sections/0001.md'], { stage: 'chapter_writing', status: 'completed', run: null })
      const run = createTestBidRunContext({ work })
      const noExecution: CapabilityTaskDispatcher = {
        allowedWrites: async () => { throw new Error('计划待补丁') },
        execute: async () => { throw new Error('不应执行') }, validate: async () => {},
      }
      const agent = { id: 'paragraph-agent' } as Parameters<typeof executeCapabilityTask>[3]
      await expect(executeCapabilityTask(workspace, run, noExecution, agent, session)).rejects.toThrow('计划待补丁')
      const next = createUserMessage({ content: [{ type: 'text', text: '改成整章写作' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', next, { surfaceOp: 'append' })
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, work)).root, workspace.config)
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session,
        { session_id: String(session.id), message_id: String(next.id) }, 0,
        [{ description: '重写整章', scope: { source: 'task' }, call: { capability: 'chapter.write', input: { instruction: '重写整章' } } }]))
        .rejects.toThrow('BID_CAPABILITY_PARAGRAPH_PLAN_INVALID')
      const checkpointPath = join(workspace.projectRoot, `runs/${work.workId}/task-checkpoint.json`)
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        steps: Array<{ step: { call: { capability: string } }; authorization: { session_id: string; message_id: string } }>
        plan_patches: unknown[]
      }
      expect(checkpoint.steps.map(step => step.step.call.capability)).toEqual(['chapter.revise'])
      expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(markdown)
      const replacement = { description: '重写整章', scope: { source: 'task' }, call: { capability: 'chapter.write',
        input: { instruction: '重写整章' } } }
      const nextAuthorization = { session_id: String(session.id), message_id: String(next.id) }
      checkpoint.steps[0] = { ...checkpoint.steps[0]!, step: replacement, authorization: nextAuthorization }
      checkpoint.plan_patches.push({ from_index: 0, authorization: nextAuthorization, steps: [replacement] })
      await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`)
      await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), noExecution, agent, session))
        .rejects.toThrow('BID_CAPABILITY_PARAGRAPH_PLAN_INVALID')
      expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(markdown)
    } finally { await ctx.fiber.dispose() }
  })

  it('后续真实消息只能替换尚未开始的步骤', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const base = dispatcher()
      let block = true
      const adapter: CapabilityTaskDispatcher = { ...base,
        allowedWrites: async (call, _sectionIds, _working) => {
          if (call.capability === 'document.review' && block) {
            block = false
            throw new Error('等待计划调整')
          }
          return base.allowedWrites(call)
        } }
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('等待计划调整')
      expect(base.execute).toHaveBeenCalledOnce()
      const message = createUserMessage({ content: [{ type: 'text', text: '调整整书审核范围' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      const replacement = [{ description: '只核对当前完整目录', scope: { source: 'task' as const },
        call: { capability: 'document.review' as const, input: { reason: '只核对当前完整目录' } } }]
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0, replacement))
        .rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP')
      const patched = await patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 1, replacement)
      expect(patched.steps.map(step => step.status)).toEqual(['completed', 'pending'])
      expect(patched.plan_patches).toHaveLength(1)
      await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(base.execute).toHaveBeenCalledTimes(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('串行执行两步，只使用一个根 Run 并留下同批发布结果', async () => {
    const { ctx, workspace, session, run, agent } = await fixture()
    try {
      const adapter = dispatcher()
      const outcome = await executeCapabilityTask(workspace, run, adapter, agent, session)
      expect(outcome.status).toBe('completed')
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      expect(adapter.execute.mock.calls.map(call => call[1].run.runId)).toEqual([run.runId, run.runId])
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
      expect(await readFile(join(workspace.projectRoot, 'chapters/document-review.json'), 'utf8')).toContain('document.review')
    } finally { await ctx.fiber.dispose() }
  })

  it('第二步失败后保留第一步检查点；已发布但未结算时不重复执行', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const adapter = dispatcher(true)
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('第二步暂时失败')
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      const resumed = createTestBidRunContext({ work: descriptor })
      const outcome = await executeCapabilityTask(workspace, resumed, adapter, agent, session)
      expect(outcome.status).toBe('completed')
      expect(adapter.execute).toHaveBeenCalledTimes(3)
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
      const afterCommit = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, afterCommit, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose() }
  })

  it('纠正已发布 Work 只追加新授权步骤，旧凭据不结算纠正且不重跑完成前缀', async () => {
    const { ctx, workspace, session, descriptor, run, agent, authorization: originalAuthorization } = await fixture()
    try {
      const adapter = dispatcher()
      const published = await executeCapabilityTask(workspace, run, adapter, agent, session)
      if (published.status !== 'completed') throw new Error('测试前置任务未发布')
      adapter.execute.mockImplementationOnce(async (call, context) => {
        const path = 'chapters/local-review.json'
        await context.run.commits.writeJson(join(context.working.projectRoot, path), { reviewed: call.capability, corrected: true })
        return { result: { target_section_ids: [], changed_artifacts: [path], change_summary: '已复核纠正结果',
          warnings: [], missing_topics: [], needs_input: false } }
      })
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '纠正当前结果并重新复核' }] })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const steps = [{ description: '复核纠正结果', scope: { source: 'task' as const },
        call: { capability: 'chapter.review' as const, input: { reason: '复核纠正结果' } } }]
      const patch = (from: number, auth = authorization) => patchCapabilityTaskSteps(run, workspace, working, request,
        session, auth, from, steps, undefined, adapter, published.receipt)
      await expect(patch(2, originalAuthorization)).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
      await expect(patch(0)).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
      await expect(patch(2, { ...authorization, session_id: '另一会话' })).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
      const updated = await patch(2)
      expect(updated.publications).toEqual([{ completed_step_count: 2, receipt: published.receipt }])
      expect(updated.steps.map(step => step.status)).toEqual(['completed', 'completed', 'pending'])
      await expect(hasPendingCapabilityCorrection(workspace, descriptor)).resolves.toBe(true)
      await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute).toHaveBeenCalledTimes(3)
      await expect(hasPendingCapabilityCorrection(workspace, descriptor)).resolves.toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['原摘要', '字节变化', '其他请求'] as const)('历史 Work 的原章节身份仅从原步骤及原目录摘要恢复：%s', async (scenario) => {
    const { ctx, workspace, session } = await fixture()
    try {
      await seedCapabilityProject(workspace, 'complete')
      const original = await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
      const originalIds = parseOutlineArtifact(JSON.parse(original)).sections.map(section => section.id)
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '调整目录并复核' }] })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const task = bidCapabilityTaskSchema.parse({ goal: '调整目录并复核', scope: { kind: 'project' }, allow_pending_content: true,
        steps: [{ description: '调整目录', scope: { source: 'task' }, call: { capability: 'outline.update',
          input: { operations: [{ type: 'update_section', section_id: 'SEC-1', title: '流程调整' }] } } }] })
      const descriptor = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
        ['outline/confirmed-outline.json'], { stage: 'chapter_writing', status: 'completed', run: null })
      const run = createTestBidRunContext({ work: descriptor })
      const agent = { id: 'execution-agent' } as Parameters<typeof executeCapabilityTask>[3]
      const adapter: CapabilityTaskDispatcher = {
        allowedWrites: async () => new Set(['outline/confirmed-outline.json']), validate: async () => {},
        execute: async (_call, context) => {
          const outline = parseOutlineArtifact(JSON.parse(original))
          outline.sections[0]!.title = '流程调整'
          await context.run.commits.writeJson(join(context.working.projectRoot, 'outline/confirmed-outline.json'), outline)
          return { result: { target_section_ids: originalIds, changed_artifacts: ['outline/confirmed-outline.json'],
            change_summary: '目录已调整', warnings: [], missing_topics: [], needs_input: false } }
        },
      }
      const outcome = await executeCapabilityTask(workspace, run, adapter, agent, session)
      if (outcome.status !== 'completed') throw new Error('测试目录未发布')
      const checkpointPath = join(workspace.projectRoot, 'runs', descriptor.workId, 'task-checkpoint.json')
      const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8')))
      delete checkpoint.original_section_ids
      await writeFile(checkpointPath, JSON.stringify(checkpoint))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      const stepId = checkpoint.steps[0]!.step_id
      const fingerprint = 'a'.repeat(64)
      const historyWork = { ...descriptor, workId: `${stepId}-${fingerprint.slice(0, 12)}`,
        inputFingerprint: fingerprint, requestRef: `requests/${stepId}-${fingerprint.slice(0, 12)}.json` }
      const history = await prepareBidWorkingTree(working, historyWork)
      await writeFile(join(history.projectRoot, 'outline/confirmed-outline.json'), original + (scenario === '字节变化' ? ' ' : ''))
      if (scenario === '其他请求') await writeFile(join(history.root, 'work-identity.json'),
        JSON.stringify({ ...historyWork, requestSha256: 'b'.repeat(64) }))
      const correction = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '纠正当前结果' }] })
      session.append('turn/start', { turn: 3 })
      session.append('user/message', correction, { surfaceOp: 'append' })
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const patch = patchCapabilityTaskSteps(run, workspace, working, request, session,
        { session_id: String(session.id), message_id: String(correction.id) }, 1,
        [{ description: '复核结果', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '复核结果' } } }],
        undefined, adapter, outcome.receipt)
      if (scenario === '原摘要') expect((await patch).original_section_ids).toEqual(originalIds)
      else await expect(patch).rejects.toThrow(scenario === '字节变化'
        ? 'BID_CAPABILITY_ORIGINAL_OUTLINE_UNAVAILABLE' : 'BID_WORKING_TREE_IDENTITY_MISMATCH')
    } finally { await ctx.fiber.dispose() }
  })

  it('同一用户消息复用原 Work，输入变化不能改写原指纹后继续', async () => {
    const { ctx, workspace, session, task, authorization, descriptor, run, agent } = await fixture()
    try {
      const duplicate = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
        ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null })
      expect(duplicate).toEqual(descriptor)
      await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), '{"changed":true}\n')
      const adapter = dispatcher()
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('BID_CAPABILITY_INPUT_CHANGED')
      expect(adapter.execute).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('步骤文件已合并但检查点未写时拒绝替换计划，凭回执恢复而不重复执行', async () => {
    const { ctx, workspace, session, descriptor, run, agent, authorization } = await fixture()
    try {
      const adapter = dispatcher()
      const originalWrite = run.commits.writeJson.bind(run.commits)
      let interrupted = false
      vi.spyOn(run.commits, 'writeJson').mockImplementation((path, value) => {
        if (path.endsWith('task-checkpoint.json') && !interrupted
          && capabilityTaskCheckpointSchema.parse(value).steps[0]?.status === 'completed'
          && (interrupted = true)) {
          return Promise.reject(new Error('检查点中断'))
        }
        return originalWrite(path, value)
      })
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('检查点中断')
      expect(adapter.execute).toHaveBeenCalledOnce()
      session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'suspended', run: {
        runId: run.runId, epoch: 1, baseProjectRevision: 0, controlRevision: 0, work: descriptor,
        interactionSessionId: String(session.id), executionSessionId: 'execution-agent', startedAt: 1, updatedAt: 2,
        cause: 'retry_exhausted', error: { code: 'BID_EXECUTOR_ERROR', message: '检查点中断',
          recovery: { kind: 'repair', unit: descriptor.workId, reason: '恢复检查点' } },
      } } })
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0,
        [{ description: '替换审核', scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: '替换审核' } } }]))
        .rejects.toThrow('步骤已有提交凭据')
      const resumed = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, resumed, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
    } finally { await ctx.fiber.dispose() }
  })

  it('需要用户输入时保留问题身份并等待，不重复调用执行器', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (call, context) => {
        const waiting = context.inputAnswer === undefined && call.capability === 'chapter.review'
        const path = 'chapters/local-review.json'
        if (call.capability === 'chapter.review') {
          if (!waiting) {
            expect(context.resumeCandidate).toBe(true)
            expect(JSON.parse(await readFile(join(context.working.projectRoot, path), 'utf8')))
              .toEqual({ candidate: '保留的审核依据' })
          }
          await context.run.commits.writeJson(join(context.working.projectRoot, path),
            waiting ? { candidate: '保留的审核依据' } : { candidate: '已补充验收文件' })
        }
        return { result: { target_section_ids: [], changed_artifacts: call.capability === 'chapter.review' ? [path] : [],
          change_summary: waiting ? '需要补充依据' : '依据已补充',
          warnings: [], missing_topics: waiting ? ['缺少验收文件'] : [], needs_input: waiting } }
      })
      const adapter: CapabilityTaskDispatcher = {
        allowedWrites: async call => new Set(call.capability === 'chapter.review'
          ? ['chapters/local-review.json'] : []), execute, validate: async () => {},
      }
      const first = await executeCapabilityTask(workspace, run, adapter, agent, session)
      expect(first).toMatchObject({ status: 'awaiting_input', result: { missing_topics: ['缺少验收文件'] } })
      const waiting = createTestBidRunContext({ work: descriptor })
      const second = await executeCapabilityTask(workspace, waiting, adapter, agent, session)
      expect(second).toEqual(first)
      expect(execute).toHaveBeenCalledOnce()
      if (first.status !== 'awaiting_input') throw new Error('应等待补充输入')
      const asked = vi.fn(async (question: { id: string }) => ({ id: question.id, selected: [], custom: '已补充验收文件。' }))
      await expect(askCapabilityTaskInput(session, descriptor.workId, first, asked, async () => {})).resolves.toBe(true)
      expect(asked).toHaveBeenCalledOnce()
      expect(session.events.filter(event => event.type === 'bid.capability.input.received')).toHaveLength(1)
      const resumed = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, resumed, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(execute).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose() }
  })

  it('等待输入恢复将已生成文件和删除差异一起发布，重复缺口获得新问题身份', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      await writeFile(join(workspace.projectRoot, 'chapters/deleted.json'), '旧文件\n')
      let calls = 0
      const adapter: CapabilityTaskDispatcher = {
        allowedWrites: async call => new Set(call.capability === 'chapter.review'
          ? ['chapters/kept.json', 'chapters/deleted.json'] : []),
        execute: async (call, context) => {
          if (call.capability !== 'chapter.review') return { result: { target_section_ids: [],
            changed_artifacts: [], change_summary: '完成后续步骤', warnings: [], missing_topics: [], needs_input: false } }
          calls++
          if (calls === 1) {
            await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/kept.json'), { writer: '原有成果' })
            await context.run.commits.remove(join(context.working.projectRoot, 'chapters/deleted.json'))
          } else {
            expect(context.resumeCandidate).toBe(true)
            expect(await readFile(join(context.working.projectRoot, 'chapters/kept.json'), 'utf8')).toContain('原有成果')
          }
          return { result: { target_section_ids: [], changed_artifacts: calls === 1 ? ['chapters/kept.json'] : [],
            change_summary: '保留成果', warnings: [], missing_topics: calls < 3 ? ['仍缺企业资料'] : [],
            needs_input: calls < 3 }, removedPaths: calls === 1 ? ['chapters/deleted.json'] : [] }
        }, validate: async () => {},
      }
      const first = await executeCapabilityTask(workspace, run, adapter, agent, session)
      if (first.status !== 'awaiting_input') throw new Error('缺少待答问题')
      expect(await askCapabilityTaskInput(session, descriptor.workId, first,
        async question => ({ id: question.id, selected: [], custom: '无关的补充。' }), async () => {})).toBe(true)
      const second = await executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session)
      if (second.status !== 'awaiting_input') throw new Error('缺口必须保留')
      expect(second.questionId).not.toBe(first.questionId)
      expect(await askCapabilityTaskInput(session, descriptor.workId, second,
        async question => ({ id: question.id, selected: [], custom: '已提供真实资料。' }), async () => {})).toBe(true)
      const final = await executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session)
      expect(final.status).toBe('completed')
      if (final.status !== 'completed') return
      expect(final.receipt.files.map(file => file.path)).toContain('chapters/kept.json')
      expect(final.receipt.removed_paths).toContain('chapters/deleted.json')
      expect(await readFile(join(workspace.projectRoot, 'chapters/kept.json'), 'utf8')).toContain('原有成果')
      await expect(readFile(join(workspace.projectRoot, 'chapters/deleted.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(calls).toBe(3)
    } finally { await ctx.fiber.dispose() }
  })
})
