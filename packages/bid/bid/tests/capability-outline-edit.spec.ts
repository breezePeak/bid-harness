import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import type { BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { bidCapabilityInputSchema } from '../src/bid-capability-contract.ts'
import { executeCapabilityTask, persistCapabilityTaskRequest,
  type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import { validateCapabilityResult } from '../src/bid-capability-registry.ts'
import { allowedOutlineCapabilityWrites, executeOutlineCapability,
  validateOutlineCapability } from '../src/bid-outline-capabilities.ts'
import { chapterReuseSeedsSchema, indexChapterContentBlocks } from '../src/chapter-content-reuse.ts'
import { collectDocxExportSnapshot } from '../src/docx-export.ts'
import { executeCapabilityChapterReorganize, executeCapabilityOutlineUpdate,
  outlineReassignmentSchema } from '../src/outline-capability-update.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { outlineArtifactSha256, parseOutlineConfirmationArtifact, parseOutlineDraft } from '../src/outline-confirmation-artifacts.ts'
import { parseOutlineArtifact } from '../src/outline-generation-artifacts.ts'
import { parseOrMigrateChapterExecutionLog } from '../src/chapter-writing-plan-artifacts.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from '../src/chapter-writing-artifacts.ts'
import { parseWritingPlan } from '../src/writing-requirements.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function readJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8')) as unknown
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-outline-capability-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  const run = createTestBidRunContext()
  const stepId = 'outline-test-step'
  const context = { canonical: workspace, working: workspace, run,
    agent: { id: 'execution-agent' } as BidCapabilityExecutionContext['agent'],
    sectionIds: new Set(['SEC-1']), stepDirectory: root,
    inputSources: new Map(), baselineHashes: new Map(), allowedWrites: new Set(),
    stepId, inputSha256: '0'.repeat(64), rootWorkId: 'user-work-1',
    authorization: { session_id: 'main', message_id: 'message-1' },
  } satisfies BidCapabilityExecutionContext
  return { workspace, context, stepId }
}

describe('目录能力候选', () => {
  it.each(['outline.refine', 'outline.update'] as const)('%s 对 Host 新 ID 分配真实业务引用', async (capability) => {
    const { workspace, context, stepId } = await fixture()
    const prefix = createHash('sha256').update(stepId).digest('hex').slice(0, 12)
    const childId = `SEC-${prefix}-1`
    const outputs = [
      JSON.stringify([{ type: 'split_section', section_id: 'SEC-1', children: [
        { title: '设计流程', purpose: '设计', must_answer: ['设计'] },
        { title: '交付流程', purpose: '交付', must_answer: ['交付'] },
      ] }]),
      JSON.stringify([{ section_id: childId, requirement_ids: ['REQ-1'],
        scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'], compliance_ids: [] }]),
    ]
    const prompts: unknown[] = []
    const start = vi.fn(async (_provider: string, request: { prompt: unknown }) => {
      prompts.push(request.prompt)
      const output = outputs.shift()
      if (output === undefined) throw new Error('missing model output')
      return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
        dispose: async () => {} }
    })
    const agent = { ctx: { get: () => ({ getProvider: () => ({ inheritsParentContext: false }), start }) } } as unknown as BidCapabilityExecutionContext['agent']
    const call = bidCapabilityInputSchema.parse(capability === 'outline.refine'
      ? { capability, input: { feedback: '把流程拆成两个章节' } }
      : { capability, input: { operations: JSON.parse(outputs.shift()!) as unknown, defer_content_migration: true } })
    if (call.capability !== 'outline.refine' && call.capability !== 'outline.update') throw new Error('test call mismatch')
    const scoped = { ...context, agent,
      allowedWrites: await allowedOutlineCapabilityWrites(call, workspace, stepId, context.sectionIds) }
    const { result } = await executeOutlineCapability(call, scoped)
    expect(start).toHaveBeenCalledTimes(capability === 'outline.refine' ? 2 : 1)
    expect(JSON.stringify(prompts.at(-1))).toContain(childId)
    const outline = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
    expect(outline.sections.find(section => section.id === childId)?.requirement_ids).toEqual(['REQ-1'])
    expect(await readJson(workspace, 'chapters/pending-reorganization.json'))
      .toMatchObject({ pending_source_section_ids: ['SEC-1'] })
    await expect(validateOutlineCapability(scoped, result)).resolves.toBeUndefined()
  })

  it('拆分生成的业务归属缺少响应点时拒绝候选并保留原目录和正文', async () => {
    const { workspace, context } = await fixture()
    const before = await readJson(workspace, 'outline/confirmed-outline.json')
    const body = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const start = vi.fn(async () => ({ result: Promise.resolve({ stopReason: 'completed',
      output: [{ type: 'text', text: '[]' }] }), dispose: async () => {} }))
    const agent = { ctx: { get: () => ({ getProvider: () => ({ inheritsParentContext: false }), start }) } } as unknown as BidCapabilityExecutionContext['agent']
    const call = bidCapabilityInputSchema.parse({ capability: 'outline.update', input: {
      operations: [{ type: 'split_section', section_id: 'SEC-1', children: [
        { title: '准备', purpose: '准备', must_answer: ['准备'] },
        { title: '实施', purpose: '实施', must_answer: ['实施'] },
      ] }], defer_content_migration: true,
    } })
    if (call.capability !== 'outline.update') throw new Error('test call mismatch')
    await expect(executeCapabilityOutlineUpdate({ ...context, agent }, call.input))
      .rejects.toThrow('OUTLINE_SHARED_RESPONSE_POINT_MISSING')
    expect(await readJson(workspace, 'outline/confirmed-outline.json')).toEqual(before)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(body)
  })

  it('适配器限定精确写入并复核真实候选', async () => {
    const { workspace, context, stepId } = await fixture()
    const call = bidCapabilityInputSchema.parse({ capability: 'outline.update', input: {
      operations: [{ type: 'update_section', section_id: 'SEC-1', title: '流程检查' }],
    } })
    if (call.capability !== 'outline.update') throw new Error('test call mismatch')
    const allowedWrites = await allowedOutlineCapabilityWrites(call, workspace, stepId, context.sectionIds)
    const scoped = { ...context, allowedWrites }
    const { result } = await executeOutlineCapability(call, scoped)
    const outline = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
    await expect(validateCapabilityResult(scoped, result, new Set(outline.sections.map(section => section.id))))
      .resolves.toMatchObject({ change_summary: '已协调目录与受影响章节产物' })
    await expect(validateOutlineCapability(scoped, result)).resolves.toBeUndefined()
    expect(result.changed_artifacts.every(path => allowedWrites.has(path))).toBe(true)
  })

  it('拆分已写章节保留原块，发布目录、绑定、待审草稿和真实任务授权', async () => {
    const { workspace, context, stepId } = await fixture()
    const body = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const untouched = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
    const blocks = indexChapterContentBlocks('SEC-1', body)
    const prefix = createHash('sha256').update(stepId).digest('hex').slice(0, 12)
    const children = [1, 2, 3].map(index => `SEC-${prefix}-${String(index)}`)
    const assignments = blocks.map((block, index) => ({
      block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: [children[Math.min(Math.floor(index / 2), 2)]!], disposition: 'move' as const,
    }))
    const result = await executeCapabilityOutlineUpdate(context, {
      operations: [{ type: 'split_section', section_id: 'SEC-1', children: [
        { title: '流程一', purpose: '收集输入', must_answer: ['收集输入'] },
        { title: '流程二', purpose: '校验结果', must_answer: ['校验结果'] },
        { title: '流程三', purpose: '交付成果', must_answer: ['交付成果'] },
      ] }],
      business_bindings: [{ section_id: children[0]!, requirement_ids: ['REQ-1'],
        scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'], compliance_ids: [] }],
      content_assignments: assignments, allow_content_deletion: false, defer_content_migration: false,
    })
    const outline = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
    const draft = parseOutlineDraft(await readJson(workspace, 'outline/draft.json'))
    const confirmation = parseOutlineConfirmationArtifact(await readJson(workspace, 'outline/confirmation.json'))
    const log = parseOrMigrateChapterExecutionLog(await readJson(workspace, 'chapters/execution-log.json'))
    const manifest = parseChapterWritingManifest(await readJson(workspace, 'chapters/manifest.json'))
    const seeds = chapterReuseSeedsSchema.parse(await readJson(workspace, 'chapters/reuse-seeds.json'))
    const reassignment = outlineReassignmentSchema.parse(await readJson(workspace, 'outline/reassignment.json'))
    expect(result.newSectionIds).toEqual(new Set(children))
    expect(outline.sections.filter(section => children.includes(section.id)).map(section => section.requirement_ids))
      .toEqual([['REQ-1'], [], []])
    expect(confirmation).toMatchObject({ confirmed_outline_sha256: outlineArtifactSha256(outline),
      authorization: { source: 'user_task', work_id: 'user-work-1', message_id: 'message-1' } })
    expect(draft.draft_outline_sha256).toBe(confirmation.confirmed_outline_sha256)
    expect(log.sections.filter(section => children.includes(section.section_id)).map(section => section.status))
      .toEqual(['pending', 'pending', 'pending'])
    expect(manifest.chapters.map(entry => entry.section_id)).toEqual(['SEC-2', 'SEC-3', 'SEC-4', 'SEC-5'])
    expect(seeds.seeds).toHaveLength(3)
    expect(reassignment.retired_sections[0]).toMatchObject({ source_section_id: 'SEC-1',
      target_section_ids: children,
      writing_task: { acceptance_criteria: [{ id: 'AC-000002' }] },
      evidence_mapping: { section_id: 'SEC-1' }, manifest_entry: { section_id: 'SEC-1' } })
    expect((await Promise.all(seeds.seeds.map(seed => readFile(join(workspace.projectRoot, seed.content_path), 'utf8')))).join(''))
      .toBe(body)
    const chartSeed = seeds.seeds.find(seed => seed.section_id === children[2])
    expect(chartSeed).toBeDefined()
    const chartMeta = parseChapterMetadata(await readJson(workspace, chartSeed!.metadata_path))
    expect(chartMeta.flowcharts.map(chart => chart.key)).toEqual(['process-flow'])
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')).toBe(untouched)
    expect(result.deletedBlockIds).toEqual([])
    const exported = (await collectDocxExportSnapshot(workspace)).markdown
    for (const text of ['流程一：收集输入。', '流程二：校验结果。', '流程三：交付成果。']) {
      expect(exported.split(text)).toHaveLength(2)
    }
  })

  it('合并两个同级正文，保留表格、流程图及业务覆盖，不继承旧审核', async () => {
    const { workspace, context } = await fixture()
    const first = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const second = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
    const blocks = [
      ...indexChapterContentBlocks('SEC-1', first),
      ...indexChapterContentBlocks('SEC-2', second),
    ]
    const result = await executeCapabilityOutlineUpdate({ ...context, sectionIds: new Set(['SEC-1', 'SEC-2']) }, {
      operations: [{ type: 'merge_sections', section_ids: ['SEC-1', 'SEC-2'],
        title: '交付流程', purpose: '完整交付流程' }],
      business_bindings: [],
      content_assignments: blocks.map(block => ({
        block_id: block.block_id, source_section_id: block.source_section_id,
        source_sha256: block.source_sha256, block_sha256: block.sha256,
        target_section_ids: ['SEC-1'], disposition: 'move' as const,
      })),
      allow_content_deletion: false, defer_content_migration: false,
    })
    const outline = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
    const manifest = parseChapterWritingManifest(await readJson(workspace, 'chapters/manifest.json'))
    const log = parseOrMigrateChapterExecutionLog(await readJson(workspace, 'chapters/execution-log.json'))
    const seeds = chapterReuseSeedsSchema.parse(await readJson(workspace, 'chapters/reuse-seeds.json'))
    const reassignment = outlineReassignmentSchema.parse(await readJson(workspace, 'outline/reassignment.json'))
    expect(outline.sections.some(section => section.id === 'SEC-2')).toBe(false)
    expect(outline.sections.find(section => section.id === 'SEC-1')).toMatchObject({
      requirement_ids: ['REQ-1', 'REQ-2'], scoring_response_point_ids: ['RP-000001', 'RP-000002'],
    })
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(first + second)
    expect(seeds.seeds[0]?.source_section_ids).toEqual(['SEC-1', 'SEC-2'])
    expect(reassignment.retired_sections[0]).toMatchObject({ source_section_id: 'SEC-2',
      target_section_ids: ['SEC-1'], writing_task: { acceptance_criteria: [{ id: 'AC-000003' }] } })
    expect(manifest.chapters.some(entry => entry.section_id === 'SEC-1')).toBe(false)
    expect(log.sections.find(section => section.section_id === 'SEC-1')?.status).toBe('pending')
    expect(result.deletedBlockIds).toEqual([])
    const exported = (await collectDocxExportSnapshot(workspace)).markdown
    expect(exported.split('流程一：收集输入。')).toHaveLength(2)
    expect(exported.split('回答主题2。')).toHaveLength(2)
  })

  it('只改标题时保持别章正文、完成记录和验收条件 ID', async () => {
    const { workspace, context } = await fixture()
    const body = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
    const result = await executeCapabilityOutlineUpdate(context, {
      operations: [{ type: 'update_section', section_id: 'SEC-1', title: '流程与控制' }],
      business_bindings: [], content_assignments: [], allow_content_deletion: false,
      defer_content_migration: false,
    })
    const manifest = parseChapterWritingManifest(await readJson(workspace, 'chapters/manifest.json'))
    const log = parseOrMigrateChapterExecutionLog(await readJson(workspace, 'chapters/execution-log.json'))
    const plan = parseWritingPlan(await readJson(workspace, 'chapters/writing-plan.json'))
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')).toBe(body)
    expect(log.sections.find(section => section.section_id === 'SEC-2')?.status).toBe('completed')
    expect(manifest.chapters.some(entry => entry.section_id === 'SEC-2')).toBe(true)
    expect(plan.sections.find(section => section.section_id === 'SEC-2')?.acceptance_criteria[0]?.id)
      .toBe('AC-000003')
    expect(result.changedPaths.some(path => path.startsWith('chapters/sections/'))).toBe(false)
  })

  it('先设计目录再迁移原文时，旧正文保持可恢复且待迁移标记随后清空', async () => {
    const { workspace, context, stepId } = await fixture()
    const priorPlan = parseWritingPlan(await readJson(workspace, 'chapters/writing-plan.json'))
    const original = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const prefix = createHash('sha256').update(stepId).digest('hex').slice(0, 12)
    const children = [1, 2].map(index => `SEC-${prefix}-${String(index)}`)
    await executeCapabilityOutlineUpdate(context, {
      operations: [{ type: 'split_section', section_id: 'SEC-1', children: [
        { title: '前段', purpose: '前段', must_answer: ['前段'] },
        { title: '后段', purpose: '后段', must_answer: ['后段'] },
      ] }],
      business_bindings: [{ section_id: children[0]!, requirement_ids: ['REQ-1'],
        scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'], compliance_ids: [] }],
      content_assignments: [], allow_content_deletion: false, defer_content_migration: true,
    })
    const plan = parseWritingPlan(await readJson(workspace, 'chapters/writing-plan.json'))
    const childCriteria = children.map(id => plan.sections.find(section => section.section_id === id)?.acceptance_criteria[0])
    const priorIds = [...priorPlan.document_acceptance,
      ...priorPlan.sections.flatMap(section => section.acceptance_criteria)].map(item => Number(item.id.slice(3)))
    expect(childCriteria.map(item => Number(item?.id.slice(3))))
      .toEqual([Math.max(...priorIds) + 1, Math.max(...priorIds) + 2])
    expect(childCriteria.map(item => item?.scope)).toEqual(children.map(id => ({ kind: 'section', section_id: id })))
    expect(plan.sections.find(section => section.section_id === 'SEC-2')?.acceptance_criteria[0]?.id)
      .toBe(priorPlan.sections.find(section => section.section_id === 'SEC-2')?.acceptance_criteria[0]?.id)
    expect(await readJson(workspace, 'chapters/pending-reorganization.json')).toMatchObject({ pending_source_section_ids: ['SEC-1'] })
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(original)
    const blocks = indexChapterContentBlocks('SEC-1', original)
    const assignments = blocks.map((block, index) => ({
      block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: [children[Math.min(Math.floor(index / 3), 1)]!], disposition: 'move' as const,
    }))
    await executeCapabilityChapterReorganize({ ...context, sectionIds: new Set(['SEC-1', ...children]) }, {
      instruction: '把旧流程分到两个子章', source_section_ids: ['SEC-1'],
      assignments, allow_content_deletion: false,
    })
    expect(await readJson(workspace, 'chapters/pending-reorganization.json')).toMatchObject({ pending_source_section_ids: [] })
    const seeds = chapterReuseSeedsSchema.parse(await readJson(workspace, 'chapters/reuse-seeds.json'))
    expect((await Promise.all(seeds.seeds.map(seed => readFile(join(workspace.projectRoot, seed.content_path), 'utf8')))).join(''))
      .toBe(original)
  })

  it('原文迁移子会话只返回块分配，由 Host 验证并落盘', async () => {
    const { workspace, context, stepId } = await fixture()
    const prefix = createHash('sha256').update(stepId).digest('hex').slice(0, 12)
    const children = [1, 2].map(index => `SEC-${prefix}-${String(index)}`)
    await executeCapabilityOutlineUpdate(context, {
      operations: [{ type: 'split_section', section_id: 'SEC-1', children: [
        { title: '准备', purpose: '准备', must_answer: ['准备'] },
        { title: '实施', purpose: '实施', must_answer: ['实施'] },
      ] }],
      business_bindings: [{ section_id: children[0]!, requirement_ids: ['REQ-1'],
        scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'], compliance_ids: [] }],
      content_assignments: [], allow_content_deletion: false, defer_content_migration: true,
    })
    const original = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const blocks = indexChapterContentBlocks('SEC-1', original)
    const assignments = blocks.map((block, index) => ({
      block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: [children[Math.min(Math.floor(index / 3), 1)]!], disposition: 'move' as const,
    }))
    const output = JSON.stringify(assignments)
    const prompt = vi.fn(async () => ({ result: Promise.resolve({ stopReason: 'completed',
      output: [{ type: 'text', text: output }] }), dispose: async () => {} }))
    const agent = { ctx: { get: () => ({ getProvider: () => ({ inheritsParentContext: false }), start: prompt }) } } as unknown as BidCapabilityExecutionContext['agent']
    const call = bidCapabilityInputSchema.parse({ capability: 'chapter.reorganize', input: {
      instruction: '按准备和实施分配原文', source_section_ids: ['SEC-1'], allow_content_deletion: false,
    } })
    if (call.capability !== 'chapter.reorganize') throw new Error('test call mismatch')
    const scoped = { ...context, agent, sectionIds: new Set(['SEC-1', ...children]),
      allowedWrites: await allowedOutlineCapabilityWrites(call, workspace, stepId, new Set(['SEC-1', ...children])) }
    const { result } = await executeOutlineCapability(call, scoped)
    expect(prompt).toHaveBeenCalledOnce()
    expect(result.changed_artifacts.every(path => scoped.allowedWrites.has(path))).toBe(true)
    await expect(validateOutlineCapability(scoped, result)).resolves.toBeUndefined()
    expect(await readJson(workspace, 'chapters/pending-reorganization.json'))
      .toMatchObject({ pending_source_section_ids: [] })
  })

  it.each([
    { name: '连续执行', interrupt: 'none' },
    { name: '目录候选合并后迁移前中断再恢复', interrupt: 'before_reorganize' },
    { name: '原文迁移候选合并后审核前中断再恢复', interrupt: 'before_review' },
  ])('同一 Work $name，只发布精确文件和完成凭据', async ({ interrupt }) => {
    const { workspace } = await fixture()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create()
      const message = createUserMessage({ content: [{ type: 'text', text: '把第一章拆成准备和实施并迁移正文' }],
        source: { kind: 'user' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      const task = { goal: '拆分并迁移第一章', scope: { kind: 'sections' as const, section_ids: ['SEC-1'] }, steps: [
        { scope: { source: 'task' as const }, call: { capability: 'outline.refine' as const,
          input: { feedback: '拆成准备和实施两个子章' } } },
        { scope: { source: 'task' as const }, call: { capability: 'chapter.reorganize' as const,
          input: { instruction: '保留并分配旧章所有正文块', source_section_ids: ['SEC-1'], allow_content_deletion: false } } },
        ...interrupt === 'before_review' ? [{ scope: { source: 'task' as const },
          call: { capability: 'chapter.review' as const, input: { reason: '审核原文迁移结果' } } }] : [],
      ] }
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const descriptor = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
        authorization, ['outline/confirmed-outline.json', 'analysis/requirements.json'],
        { stage: 'chapter_writing', status: 'completed', run: null })
      const firstStepId = `step-${createHash('sha256').update(descriptor.workId).digest('hex').slice(0, 24)}-0001`
      const prefix = createHash('sha256').update(firstStepId).digest('hex').slice(0, 12)
      const children = [1, 2].map(index => `SEC-${prefix}-${String(index)}`)
      const original = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
      const blocks = indexChapterContentBlocks('SEC-1', original)
      const outputs = [
        JSON.stringify([{ type: 'split_section', section_id: 'SEC-1', children: [
          { title: '准备', purpose: '准备', must_answer: ['准备'] },
          { title: '实施', purpose: '实施', must_answer: ['实施'] },
        ] }]),
        JSON.stringify([{ section_id: children[0], requirement_ids: ['REQ-1'],
          scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'], compliance_ids: [] }]),
        JSON.stringify(blocks.map((block, index) => ({
          block_id: block.block_id, source_section_id: block.source_section_id,
          source_sha256: block.source_sha256, block_sha256: block.sha256,
          target_section_ids: [children[Math.min(Math.floor(index / 3), 1)]!], disposition: 'move',
        }))),
      ]
      const start = vi.fn(async () => {
        const output = outputs.shift()
        if (output === undefined) throw new Error('missing model output')
        return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
          dispose: async () => {} }
      })
      const agent = { ctx: { get: () => ({ getProvider: () => ({ inheritsParentContext: false }), start }) } } as unknown as BidCapabilityExecutionContext['agent']
      let interrupted = false
      const dispatcher: CapabilityTaskDispatcher = {
        allowedWrites: async (call, ids, working, stepId) => {
          if (call.capability === 'chapter.review') return new Set(['chapters/local-review.json'])
          if (call.capability !== 'outline.refine' && call.capability !== 'chapter.reorganize') {
            throw new Error('unexpected capability')
          }
          return allowedOutlineCapabilityWrites(call, working, stepId, ids)
        },
        execute: async (call, context) => {
          if (call.capability === 'chapter.review') {
            if (interrupt === 'before_review' && !interrupted) {
              interrupted = true
              throw new Error('原文迁移候选已合并，审核前中断')
            }
            await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'),
              { reviewed: true })
            return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
              change_summary: '已审核原文迁移结果', warnings: [], missing_topics: [], needs_input: false } }
          }
          if (call.capability !== 'outline.refine' && call.capability !== 'chapter.reorganize') {
            throw new Error('unexpected capability')
          }
          if (interrupt === 'before_reorganize' && call.capability === 'chapter.reorganize' && !interrupted) {
            interrupted = true
            throw new Error('目录候选已合并，正文迁移前中断')
          }
          return executeOutlineCapability(call, context)
        },
        validate: async (call, context, result) => {
          if (call.capability !== 'chapter.review') await validateOutlineCapability(context, result)
        },
      }
      const run = createTestBidRunContext({ work: descriptor })
      if (interrupt !== 'none') {
        await expect(executeCapabilityTask(workspace, run, dispatcher, agent, session))
          .rejects.toThrow(interrupt === 'before_reorganize'
            ? '目录候选已合并，正文迁移前中断' : '原文迁移候选已合并，审核前中断')
        expect(start).toHaveBeenCalledTimes(interrupt === 'before_reorganize' ? 2 : 3)
        const formal = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
        expect(children.some(id => formal.sections.some(section => section.id === id))).toBe(false)
        expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(original)
        const candidate = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
        const staged = parseOutlineArtifact(await readJson(candidate, 'outline/confirmed-outline.json'))
        expect(children.every(id => staged.sections.some(section => section.id === id))).toBe(true)
        if (interrupt === 'before_review') {
          const stagedSeeds = chapterReuseSeedsSchema.parse(await readJson(candidate, 'chapters/reuse-seeds.json'))
          expect((await Promise.all(stagedSeeds.seeds.map(seed => readFile(join(candidate.projectRoot,
            seed.content_path), 'utf8')))).join('')).toBe(original)
        }
      }
      const outcome = await executeCapabilityTask(workspace,
        interrupt === 'none' ? run : createTestBidRunContext({ work: descriptor }), dispatcher, agent, session)
      expect(outcome.status).toBe('completed')
      expect(start).toHaveBeenCalledTimes(3)
      const outline = parseOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
      expect(children.every(id => outline.sections.some(section => section.id === id))).toBe(true)
      const seeds = chapterReuseSeedsSchema.parse(await readJson(workspace, 'chapters/reuse-seeds.json'))
      expect((await Promise.all(seeds.seeds.map(seed => readFile(join(workspace.projectRoot, seed.content_path), 'utf8')))).join(''))
        .toBe(original)
      expect(outcome.status === 'completed' ? outcome.receipt.files.every(file => !file.path.includes('sections/0002.md')) : false)
        .toBe(true)
    } finally { await ctx.fiber.dispose() }
  }, 30_000)
})
