import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace, type OutlineArtifact } from '../src/index.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { bidCapabilityInputSchema, bidCapabilityScopeSchema, bidCapabilityTaskSchema, validateCapabilityTaskContentFollowup,
  type BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { BID_CAPABILITIES, resolveCapabilityStepScope, validateCapabilityResult,
  verifyCapabilityTaskScope } from '../src/bid-capability-registry.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const outline = { sections: [
  { id: 'ROOT', parent_id: null }, { id: 'A', parent_id: 'ROOT' }, { id: 'B', parent_id: 'ROOT' },
] } as OutlineArtifact

describe('公共能力契约', () => {
  it('暂缓正文迁移要求同一任务继续迁移并复核，只有明确暂缓可省略', () => {
    const outlineStep = { scope: { source: 'task' }, call: { capability: 'outline.update', input: {
      operations: [{ type: 'split_section', section_id: 'A', children: [
        { title: '背景', purpose: '背景', must_answer: ['背景'] },
        { title: '目标', purpose: '目标', must_answer: ['目标'] },
      ] }], defer_content_migration: true,
    } } }
    const reorganize = { scope: { source: 'task' }, call: { capability: 'chapter.reorganize',
      input: { instruction: '分配原文', source_section_ids: ['A'] } } }
    const review = { scope: { source: 'previous_targets' }, call: { capability: 'chapter.review',
      input: { reason: '复核拆分结果' } } }
    const task = { goal: '拆分为背景与目标并完成正文', scope: { kind: 'sections', section_ids: ['A'] },
      steps: [outlineStep] }
    const validate = (input: unknown) => {
      const value = bidCapabilityTaskSchema.parse(input)
      validateCapabilityTaskContentFollowup(value)
      return value
    }
    expect(() => bidCapabilityTaskSchema.parse(task)).not.toThrow()
    expect(() => validate(task)).toThrow('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED')
    expect(() => validate({ ...task, steps: [outlineStep, reorganize] }))
      .toThrow('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED')
    expect(() => validate({ ...task, steps: [outlineStep, review, reorganize] }))
      .toThrow('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED')
    expect(() => validate({ ...task, steps: [outlineStep, reorganize, review] })).not.toThrow()
    expect(() => validate({ ...task, allow_pending_content: true })).not.toThrow()
  })

  it('能力目录闭合，业务输入拒绝任意对象和模型指定路径', () => {
    expect(Object.keys(BID_CAPABILITIES)).toHaveLength(13)
    expect(bidCapabilityInputSchema.parse({ capability: 'outline.refine', input: { feedback: '细化 A' } }).capability)
      .toBe('outline.refine')
    expect(() => bidCapabilityInputSchema.parse({ capability: 'outline.refine', input: { feedback: '细化 A', path: '../x' } })).toThrow()
    expect(() => bidCapabilityInputSchema.parse({ capability: 'unknown', input: {} })).toThrow()
    expect(() => bidCapabilityTaskSchema.parse({ goal: '细化 A', scope: { kind: 'sections', section_ids: ['A'] },
      steps: [{ scope: { source: 'task' }, call: { capability: 'outline.refine', input: { feedback: '细化 A' } },
        step_id: 'model-owned' }] })).toThrow()
  })

  it('空章节范围不退化成全书，段落范围沿用真实正文引用', () => {
    expect(() => bidCapabilityScopeSchema.parse({ kind: 'sections', section_ids: [] })).toThrow()
    expect(() => bidCapabilityScopeSchema.parse({ kind: 'paragraphs', reference: {
      scope: 'paragraphs', section_id: 'A', content_sha256: 'a'.repeat(64), start: 0, end: 2, text: '正文',
    } })).not.toThrow()
    expect(() => bidCapabilityScopeSchema.parse({ kind: 'paragraphs', reference: { section_id: 'A' } })).toThrow()
  })

  it('段落授权只接受同一选区的单步章节修订', () => {
    const reference = { scope: 'paragraphs' as const, section_id: 'A',
      content_sha256: 'a'.repeat(64), start: 0, end: 2, text: '正文' }
    const scope = { kind: 'paragraphs' as const, reference }
    const revise = { scope: { source: 'task' as const }, call: { capability: 'chapter.revise' as const,
      input: { instruction: '缩短这句', reference } } }
    expect(() => bidCapabilityTaskSchema.parse({ goal: '缩短这句', scope, steps: [revise] })).not.toThrow()
    expect(() => bidCapabilityTaskSchema.parse({ goal: '缩短这句', scope, steps: [
      { scope: { source: 'task' }, call: { capability: 'chapter.write', input: { instruction: '重写整章' } } },
    ] })).toThrow()
    expect(() => bidCapabilityTaskSchema.parse({ goal: '缩短这句', scope, steps: [
      { ...revise, call: { ...revise.call, input: { ...revise.call.input,
        reference: { ...reference, section_id: 'B' } } } },
    ] })).toThrow()
    expect(() => bidCapabilityTaskSchema.parse({ goal: '缩短这句', scope, steps: [revise, revise] })).toThrow()
    expect(() => bidCapabilityTaskSchema.parse({ goal: '缩短这句', scope, steps: [
      { ...revise, scope: { source: 'section_ids', section_ids: ['A'] } },
    ] })).toThrow()
  })

  it('previous_targets 只能引用已完成的前一步目标，且不能越权', () => {
    const task = { kind: 'sections' as const, section_ids: ['A'] }
    expect(() => resolveCapabilityStepScope(task, { source: 'previous_targets' }, outline,
      { status: 'pending' })).toThrow('BID_CAPABILITY_PREVIOUS_TARGETS_UNAVAILABLE')
    const previous = { status: 'completed' as const, result: {
      target_section_ids: ['B'], changed_artifacts: [], change_summary: '已处理', warnings: [], missing_topics: [], needs_input: false,
    } }
    expect(() => resolveCapabilityStepScope(task, { source: 'previous_targets' }, outline, previous))
      .toThrow('BID_CAPABILITY_SCOPE_ESCALATION')
    expect(() => resolveCapabilityStepScope(task, { source: 'section_ids', section_ids: ['UNKNOWN'] }, outline))
      .toThrow('BID_SECTION_SCOPE_INVALID')
    expect([...resolveCapabilityStepScope(task, { source: 'section_ids', section_ids: ['A'] }, outline).sectionIds ?? []])
      .toEqual(['A'])
    const created = { ...outline, sections: [...outline.sections, { ...outline.sections[1]!, id: 'NEW', parent_id: 'A' }] }
    const returned = { ...previous, result: { ...previous.result, target_section_ids: ['NEW'] } }
    expect(() => resolveCapabilityStepScope(task, { source: 'previous_targets' }, outline, returned))
      .toThrow('BID_CAPABILITY_PREVIOUS_TARGETS_INVALID')
    expect([...resolveCapabilityStepScope(task, { source: 'previous_targets' }, created, returned).sectionIds ?? []])
      .toEqual(['NEW'])
  })

  it('段落任务在接纳时核对真实正文版本和选区', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-capability-paragraph-'))
    roots.push(root)
    const workspace = new BidWorkspace(root)
    const { outline: projectOutline } = await seedCapabilityProject(workspace, 'partial')
    const path = join(workspace.projectRoot, 'chapters/sections/0001.md')
    const markdown = await readFile(path, 'utf8')
    const text = '流程一：收集输入。'
    const start = markdown.indexOf(text)
    const scope = { kind: 'paragraphs' as const, reference: { scope: 'paragraphs' as const,
      section_id: 'SEC-1', content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text } }
    await expect(verifyCapabilityTaskScope(workspace, scope, projectOutline)).resolves.toBeUndefined()
    await writeFile(path, `${markdown}后续修改。`)
    await expect(verifyCapabilityTaskScope(workspace, scope, projectOutline))
      .rejects.toThrow('BID_CHAPTER_REVISION_CONFLICT')
  })

  it('Host 只接受允许写入且已经存在的真实产物', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-capability-contract-'))
    roots.push(root)
    const workspace = new BidWorkspace(root)
    await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '正文')
    const baselineHashes = new Map<string, string>()
    const context = { working: workspace, sectionIds: new Set(['A']),
      allowedWrites: new Set(['chapters/sections/0001.md', 'chapters/sections/0002.md']),
      baselineHashes,
    } as unknown as BidCapabilityExecutionContext
    const valid = { target_section_ids: ['A'], changed_artifacts: ['chapters/sections/0001.md'],
      change_summary: '已写入', warnings: [], missing_topics: [], needs_input: false }
    await expect(validateCapabilityResult(context, valid, new Set(['A']))).resolves.toEqual(valid)
    baselineHashes.set('chapters/sections/0001.md', createHash('sha256').update('正文').digest('hex'))
    await expect(validateCapabilityResult(context, valid, new Set(['A'])))
      .rejects.toThrow('BID_CAPABILITY_RESULT_ARTIFACT_UNCHANGED')
    await expect(validateCapabilityResult(context, { ...valid, target_section_ids: ['B'] }, new Set(['A', 'B'])))
      .rejects.toThrow('BID_CAPABILITY_RESULT_SCOPE_INVALID')
    await expect(validateCapabilityResult(context, { ...valid, changed_artifacts: ['chapters/sections/0002.md'] }, new Set(['A'])))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(validateCapabilityResult(context, { ...valid, changed_artifacts: ['../other.md'] }, new Set(['A'])))
      .rejects.toThrow('BID_CAPABILITY_RESULT_ARTIFACT_NOT_ALLOWED')
  })
})
