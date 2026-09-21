import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  attachTenderAnalysisSubmissionRuntime,
  BidWorkspace,
  DEFAULT_BID_CONFIG,
  createTestBidRunContext,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  resolveTenderSourceAnchor,
  validateTenderAnalysis,
  type BidRunContext,
} from '@deepseek-ai/dsh-bid'

const PROJECT_QUOTE = '项目名称：智慧审计平台。'
const REQUIREMENT_QUOTE = '系统功能要求：应支持统一身份认证和审计日志。'
const SCORING_QUOTE = '技术评分标准：总体技术方案完整合理得 10 分。'
const COMPLIANCE_QUOTE = '投标技术方案必须提供数据安全措施。'

interface Fixture {
  workspace: BidWorkspace
  agent: Agent
  tools: Map<string, ToolDefinition>
  runtime: Awaited<ReturnType<typeof attachTenderAnalysisSubmissionRuntime>>
  concludeTurn: ReturnType<typeof vi.fn>
  run: BidRunContext
  call(name: string, args: unknown): Promise<unknown>
}

async function fixture(_durable = false): Promise<Fixture> {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-submit-')), {
    ...DEFAULT_BID_CONFIG,
    documentChunk: { minChars: 200, targetChars: 400, maxChars: 500 },
  })
  const second = Array.from({ length: 50 }, (_, index) => (
    `第二份招标技术要求第${String(index + 1).padStart(2, '0')}段：系统应保持稳定运行并提交验收记录。`
  )).join('\n\n')
  await workspace.import([
    {
      name: 'main-tender.md',
      role: 'tender',
      bytes: new TextEncoder().encode([
        '# 项目概况', PROJECT_QUOTE,
        '# 技术要求', REQUIREMENT_QUOTE, COMPLIANCE_QUOTE,
        '# 技术评分', SCORING_QUOTE,
        '重复短语。', '重复短语。',
      ].join('\n\n')),
    },
    { name: 'second-tender.md', role: 'tender', bytes: new TextEncoder().encode(second) },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('旧项目技术要求仅供参考。') },
  ])
  const definitions = new Map<string, ToolDefinition>()
  const services = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      },
    },
  }
  const agent = { id: 'session', ctx: { get: (name: keyof typeof services) => services[name] } } as unknown as Agent
  const signal = new AbortController().signal
  const run = createTestBidRunContext({ signal })
  const runtime = await attachTenderAnalysisSubmissionRuntime(agent, workspace, await workspace.readManifest(), run)
  const concludeTurn = vi.fn()
  const call = async (name: string, args: unknown): Promise<unknown> => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return definition.execute(args, { agent, signal: new AbortController().signal, concludeTurn } as unknown as ToolRunContext)
  }
  return { workspace, agent, tools: definitions, runtime, concludeTurn, call, run }
}

function source(anchor_text: string, chunk?: string, file_ref = 'T1') {
  const resolvedChunk = chunk ?? (anchor_text === PROJECT_QUOTE ? 'chunk_0001'
    : anchor_text === REQUIREMENT_QUOTE || anchor_text === COMPLIANCE_QUOTE ? 'chunk_0002' : 'chunk_0003')
  return { file_ref, chunk: resolvedChunk, anchor_text }
}

async function submitComplete(value: Fixture): Promise<void> {
  await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
  await value.call('submit_requirement', {
    action: 'create',
    category: '功能要求', normalized_requirement: '系统应支持统一身份认证和审计日志。',
    mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
  })
  await value.call('submit_scoring_item', {
    action: 'create',
    group: '技术方案', title: '总体技术方案',
    criterion: '根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
    must_answer: true, sources: [source(SCORING_QUOTE)],
  })
  await value.call('submit_compliance_item', {
    action: 'create',
    type: '强制要求', normalized_rule: '技术方案必须提供数据安全措施。',
    severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
  })
}

async function finishReviewed(value: Fixture): Promise<unknown> {
  const staged = await value.call('finish_tender_analysis', {}) as { review_required?: boolean; revision?: number }
  expect(staged).toMatchObject({ completed: false, review_required: true, revision: value.runtime.revision })
  await value.runtime.beginReview()
  return value.call('finish_tender_analysis', { review_revision: value.runtime.revision })
}

describe('tender-analysis staged submission runtime', () => {
  it('renders one located PDF page as an image block and rejects routes without image input', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-pdf-page-')))
    const pdf = await readFile(join(import.meta.dirname, 'fixtures/bid-document.pdf'))
    await workspace.import([
      { name: 'tender.pdf', role: 'tender', bytes: new Uint8Array(pdf) },
      { name: 'appendix.md', role: 'tender', bytes: new TextEncoder().encode('补充技术要求。') },
    ])
    const definitions = new Map<string, ToolDefinition>()
    let savedPng: Uint8Array | undefined
    const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      savedPng = input.data
      return {
        attachmentId: 'att-pdf-page',
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1191,
        height: 1684,
        name: input.name,
      }
    })
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
    const services = {
      tools: {
        register(definition: ToolDefinition) {
          definitions.set(definition.name, definition)
          return () => { definitions.delete(definition.name) }
        },
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 8_000_000,
          maxImagesPerMessage: 4,
          maxMessageImageBytes: 16_000_000,
          maxImagePixels: 4_000_000,
          maxImageDimension: 2_048,
          mediaTypes: ['image/png'],
        },
        saveImage,
      },
      llm: { resolveModelInfo },
    }
    const agent = {
      id: 'session',
      options: { provider: 'test', model: 'vision' },
      session: { requestHeader: () => undefined },
      ctx: { get: (name: keyof typeof services) => services[name] },
    } as unknown as Agent
    const runtime = await attachTenderAnalysisSubmissionRuntime(
      agent,
      workspace,
      await workspace.readManifest(),
      createTestBidRunContext(),
    )
    const tool = definitions.get('view_pdf_page')
    expect(tool).toBeDefined()
    const exec = { agent, signal: new AbortController().signal, concludeTurn: vi.fn() } as unknown as ToolRunContext
    const result = await tool?.execute({ file_ref: 'T1', page: 1 }, exec) as {
      page_count: number
      image: { attachmentId: string }
    }
    expect(result).toMatchObject({ page_count: 2, image: { attachmentId: 'att-pdf-page' } })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'tender.pdf-page-1.png' }))
    expect(Array.from(savedPng!.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const rendered = tool!.output.render({ file_ref: 'T1', page: 1 }, result)
    expect(rendered[0]?.type).toBe('text')
    expect(rendered[0]?.type === 'text' ? rendered[0].text : '').toContain('page: 1/2')
    expect(rendered[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-pdf-page' } })

    resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
    await expect(tool?.execute({ file_ref: 'T1', page: 1 }, exec)).rejects.toThrow('请切换到支持图片输入的模型')
    await expect(tool?.execute({ file_ref: 'T9', page: 1 }, exec)).rejects.toThrow('未知 tender 引用 T9')
    resolveModelInfo.mockResolvedValue({ inputModalities: ['text', 'image'] })
    await expect(tool?.execute({ file_ref: 'T1', page: 3 }, exec)).rejects.toThrow('该文件共 2 页')
    await expect(tool?.execute({ file_ref: 'T2', page: 1 }, exec)).rejects.toThrow('T2 不是 PDF')
    expect(saveImage).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('restores durable staged records and restarts an interrupted review at its safe boundary', async () => {
    const value = await fixture(true)
    await submitComplete(value)
    await expect(value.call('finish_tender_analysis', {})).resolves.toMatchObject({
      completed: false,
      review_required: true,
    })
    await value.runtime.beginReview()
    const revision = value.runtime.revision
    value.runtime.dispose()

    const restored = await attachTenderAnalysisSubmissionRuntime(
      value.agent,
      value.workspace,
      await value.workspace.readManifest(),
      value.run,
    )

    expect(restored.phase).toBe('review_required')
    expect(restored.revision).toBe(revision)
    expect(restored.reviewSnapshot()).toMatchObject({
      project_facts: [{ field: 'project_name', value: '智慧审计平台' }],
      requirements: [{ normalized_requirement: '系统应支持统一身份认证和审计日志。' }],
      scoring: [{ title: '总体技术方案' }],
      compliance: [{ normalized_rule: '技术方案必须提供数据安全措施。' }],
    })
    await restored.beginReview()
    await expect(value.call('submit_requirement', {
      action: 'replace', replace_ref: 'R99', category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).resolves.toMatchObject({
      recorded: false, rejected: true, replace_ref: 'R99', current_refs: ['R1'], revision,
    })
    expect(restored.revision).toBe(revision)
    restored.dispose()
  })

  it('builds T1/T2 from successful tenders and resolves a unique anchor to exact chunk text and lines', async () => {
    const value = await fixture()
    expect(value.runtime.locators.map(locator => ({ ref: locator.file_ref, name: locator.name }))).toEqual([
      { ref: 'T1', name: 'main-tender.md' },
      { ref: 'T2', name: 'second-tender.md' },
    ])
    const locator = value.runtime.locators[0]!
    const resolved = await resolveTenderSourceAnchor(value.workspace, value.runtime.locators, source(REQUIREMENT_QUOTE, 'chunk_0002'))
    const raw = await readFile(locator.chunks.get('chunk_0002')!.absolutePath, 'utf8')
    const start = raw.indexOf(REQUIREMENT_QUOTE)
    const expectedLine = raw.slice(0, start).split('\n').length
    expect(resolved).toEqual({
      quote: REQUIREMENT_QUOTE,
      source_ref: {
        file_id: locator.file_id,
        chunk: locator.chunks.get('chunk_0002')!.artifactPath,
        line_start: expectedLine,
        line_end: expectedLine,
      },
    })
    value.runtime.dispose()
  })

  it('rejects unknown file refs, wrong chunks, absent anchors, and ambiguous anchors immediately', async () => {
    const value = await fixture()
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, source(PROJECT_QUOTE, 'chunk_0001', 'T9')))
      .rejects.toThrow('未知 tender 引用')
    expect(value.runtime.locators[1]?.chunks.has('chunk_0004')).toBe(true)
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, source(PROJECT_QUOTE, 'chunk_0004')))
      .rejects.toThrow('不属于 T1')
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, source('无关的虚构原文', 'chunk_0001')))
      .rejects.toThrow('重新读取该 chunk')
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, source('重复短语。', 'chunk_0003')))
      .rejects.toThrow('更长、更有区分度')
    value.runtime.dispose()
  })

  it('normalizes only NFKC and whitespace while returning the original quote and spanning lines', async () => {
    const value = await fixture()
    const locator = value.runtime.locators[0]!
    const chunk = locator.chunks.get('chunk_0001')!
    await writeFile(chunk.absolutePath, '第一行：全角ＡＢＣ。\n第二行\t连续 空白。')
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, {
      file_ref: 'T1', chunk: 'chunk_0001', anchor_text: '全角ABC。 第二行 连续 空白。',
    })).resolves.toEqual({
      quote: '全角ＡＢＣ。\n第二行\t连续 空白。',
      source_ref: { file_id: locator.file_id, chunk: chunk.artifactPath, line_start: 1, line_end: 2 },
    })
    value.runtime.dispose()
  })

  it('returns recoverable anchor issues, concludes the turn, and accepts a longer replacement anchor', async () => {
    const value = await fixture()
    const requirement = {
      action: 'create' as const, category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE, mandatory: true,
    }
    await expect(value.call('submit_requirement', { ...requirement, sources: [source('并不存在的原文', 'chunk_0002')] }))
      .resolves.toMatchObject({ recorded: false, rejected: true, issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_ANCHOR_NOT_FOUND' })] })
    await expect(value.call('submit_requirement', { ...requirement, sources: [source('重复短语。', 'chunk_0003')] }))
      .resolves.toMatchObject({ recorded: false, rejected: true, issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_ANCHOR_AMBIGUOUS' })] })
    expect(value.concludeTurn).toHaveBeenCalledTimes(2)
    await expect(value.call('submit_requirement', {
      ...requirement, sources: [source('重复短语。\n\n重复短语。', 'chunk_0003')],
    })).resolves.toMatchObject({ recorded: true, requirement_ref: 'R1' })
    value.runtime.dispose()
  })

  it('applies the same anchor recovery to Requirement, Scoring, and Compliance submissions', async () => {
    const value = await fixture()
    const invalid = [source('并不存在的原文', 'chunk_0002')]
    for (const [name, args] of [
      ['submit_requirement', { action: 'create', category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE, mandatory: true, sources: invalid }],
      ['submit_scoring_item', { action: 'create', group: '技术方案', title: '总体技术方案', criterion: SCORING_QUOTE, score: 10, score_range: null, must_answer: true, sources: invalid }],
      ['submit_compliance_item', { action: 'create', type: '强制要求', normalized_rule: COMPLIANCE_QUOTE, severity: 'mandatory', sources: invalid }],
    ] as const) await expect(value.call(name, args)).resolves.toMatchObject({
      recorded: false, rejected: true, issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_ANCHOR_NOT_FOUND' })],
    })
    expect(value.concludeTurn).toHaveBeenCalledTimes(3)
    value.runtime.dispose()
  })

  it('aggregates and deduplicates project arrays while Host supplies nulls, empty arrays, and tender coverage', async () => {
    const value = await fixture()
    const args = { field: 'project_background', value: '建设统一审计平台', sources: [source(PROJECT_QUOTE)] }
    await value.call('submit_project_fact', args)
    await value.call('submit_project_fact', args)
    await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    const result = await finishReviewed(value)
    expect(result).toMatchObject({ completed: true })
    const project = parseTenderProjectArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/project.json'), 'utf8')))
    expect(project).toMatchObject({
      project_name: null,
      tender_name: null,
      purchaser: null,
      owner: null,
      project_background: ['建设统一审计平台'],
      project_objectives: [],
      project_scope: [],
      technical_scope: [],
      delivery_scope: [],
      implementation_constraints: [],
      key_technical_points: [],
      analyzed_tender_files: value.runtime.locators.map(locator => locator.file_id),
    })
    value.runtime.dispose()
  })

  it('assigns stable REQ IDs, replaces by runtime ref, and rejects model-owned fields', async () => {
    const value = await fixture()
    const first = await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: '初始归纳', mandatory: true,
      sources: [source(REQUIREMENT_QUOTE)],
    }) as { requirement_ref: string }
    await value.call('submit_requirement', {
      action: 'replace', replace_ref: first.requirement_ref, category: '功能要求',
      normalized_requirement: '修正后的归纳', mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await expect(value.call('submit_requirement', {
      action: 'create', id: 'REQ-CUSTOM', category: '功能要求', raw_text: REQUIREMENT_QUOTE,
      normalized_requirement: '非法', mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).rejects.toThrow()
    await expect(value.call('submit_requirement', {
      action: 'create', category: '功能要求', normalized_requirement: '非法', mandatory: true,
      sources: [{ file_ref: 'T1', chunk: 'chunk_0002', anchor_text: REQUIREMENT_QUOTE, quote: REQUIREMENT_QUOTE, source_ref: {}, line_start: 1, line_end: 1 }],
    })).rejects.toThrow()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderRequirementsArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8')))
    expect(artifact.requirements).toEqual([expect.objectContaining({
      id: 'REQ-001', raw_text: REQUIREMENT_QUOTE, normalized_requirement: '修正后的归纳',
    })])
    expect(artifact.requirements[0]?.source_refs[0]).not.toHaveProperty('file_ref')
    value.runtime.dispose()
  })

  it('uses a discriminated create/replace schema', async () => {
    const value = await fixture()
    const requirement = {
      category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    }
    const scoring = {
      group: '技术方案', title: '总体技术方案', criterion: '方案完整合理',
      score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    }
    const compliance = {
      type: '强制要求', normalized_rule: COMPLIANCE_QUOTE,
      severity: 'mandatory' as const, sources: [source(COMPLIANCE_QUOTE)],
    }
    await expect(value.call('submit_requirement', { action: 'create', replace_ref: 'R1', ...requirement })).rejects.toThrow()
    await expect(value.call('submit_scoring_item', { action: 'create', replace_ref: 'S1', ...scoring })).rejects.toThrow()
    await expect(value.call('submit_compliance_item', { action: 'create', replace_ref: 'C1', ...compliance })).rejects.toThrow()
    await expect(value.call('submit_requirement', { action: 'replace', ...requirement })).rejects.toThrow()
    await expect(value.call('submit_scoring_item', { action: 'replace', ...scoring })).rejects.toThrow()
    await expect(value.call('submit_compliance_item', { action: 'replace', ...compliance })).rejects.toThrow()
    value.runtime.dispose()
  })

  it('requires existing runtime refs for replace, preserves staged records, and ends the rejected turn', async () => {
    const value = await fixture()
    expect(value.tools.get('submit_requirement')?.description).toContain('action=create')
    expect(value.tools.get('submit_scoring_item')?.description).toContain('action=replace')
    expect(value.tools.get('submit_compliance_item')?.description).toContain('action=create')
    const requirement = await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    }) as { requirement_ref: string }
    const requirementRevision = value.runtime.revision
    const requirementSnapshot = value.runtime.reviewSnapshot()
    await expect(value.call('submit_requirement', {
      action: 'replace', replace_ref: 'R99', category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).resolves.toMatchObject({
      recorded: false, rejected: true, replace_ref: 'R99', current_refs: ['R1'], revision: requirementRevision,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_REPLACE_REF_UNKNOWN' })],
      message: '未知 Requirement runtime ref R99。当前有效 refs：R1。',
    })
    expect(value.runtime.revision).toBe(requirementRevision)
    expect(value.runtime.reviewSnapshot()).toEqual(requirementSnapshot)
    expect(value.concludeTurn).toHaveBeenCalledOnce()
    await expect(value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: '系统应提供审计日志。',
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).resolves.toMatchObject({ recorded: true, requirement_ref: 'R2' })
    const scoring = await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案', criterion: '方案完整合理',
      score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    }) as { scoring_ref: string }
    const scoringRevision = value.runtime.revision
    const scoringSnapshot = value.runtime.reviewSnapshot()
    await expect(value.call('submit_scoring_item', {
      action: 'replace', replace_ref: 'S99', group: '技术方案', title: '总体技术方案', criterion: '方案完整合理',
      score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })).resolves.toMatchObject({
      recorded: false, rejected: true, replace_ref: 'S99', current_refs: ['S1'], revision: scoringRevision,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_REPLACE_REF_UNKNOWN' })],
      message: '未知 Scoring runtime ref S99。当前有效 refs：S1。',
    })
    expect(value.runtime.revision).toBe(scoringRevision)
    expect(value.runtime.reviewSnapshot()).toEqual(scoringSnapshot)
    await expect(value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '实施方案', criterion: '实施方案合理',
      score: 5, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })).resolves.toMatchObject({ recorded: true, scoring_ref: 'S2' })
    const compliance = await value.call('submit_compliance_item', {
      action: 'create',
      type: '强制要求', normalized_rule: COMPLIANCE_QUOTE,
      severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
    }) as { compliance_ref: string }
    const complianceRevision = value.runtime.revision
    const complianceSnapshot = value.runtime.reviewSnapshot()
    await expect(value.call('submit_compliance_item', {
      action: 'replace', replace_ref: 'C99', type: '强制要求', normalized_rule: COMPLIANCE_QUOTE,
      severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
    })).resolves.toMatchObject({
      recorded: false, rejected: true, replace_ref: 'C99', current_refs: ['C1'], revision: complianceRevision,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_REPLACE_REF_UNKNOWN' })],
      message: '未知 Compliance runtime ref C99。当前有效 refs：C1。',
    })
    expect(value.runtime.revision).toBe(complianceRevision)
    expect(value.runtime.reviewSnapshot()).toEqual(complianceSnapshot)
    expect(value.concludeTurn).toHaveBeenCalledTimes(3)
    await expect(value.call('submit_compliance_item', {
      action: 'create',
      type: '强制要求', normalized_rule: '技术方案必须支持安全审计。',
      severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
    })).resolves.toMatchObject({ recorded: true, compliance_ref: 'C2' })
    expect({ requirement, scoring, compliance }).toMatchObject({
      requirement: { requirement_ref: 'R1' }, scoring: { scoring_ref: 'S1' }, compliance: { compliance_ref: 'C1' },
    })
    expect(value.runtime.reviewSnapshot()).toMatchObject({
      requirements: [{ requirement_ref: 'R1' }, { requirement_ref: 'R2' }],
      scoring: [{ scoring_ref: 'S1' }, { scoring_ref: 'S2' }],
      compliance: [{ compliance_ref: 'C1' }, { compliance_ref: 'C2' }],
    })
    value.runtime.dispose()
  })

  it('allocates unused runtime refs after restoring sparse staged records', async () => {
    const value = await fixture()
    for (const normalized_requirement of ['要求一', '要求二', '要求三']) {
      await value.call('submit_requirement', { action: 'create', category: '功能要求', normalized_requirement, mandatory: true, sources: [source(REQUIREMENT_QUOTE)] })
    }
    for (const title of ['评分一', '评分二', '评分三']) {
      await value.call('submit_scoring_item', {
        action: 'create', group: '技术方案', title, criterion: `${title}规则`, score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
      })
    }
    for (const normalized_rule of ['规则一', '规则二', '规则三']) {
      await value.call('submit_compliance_item', { action: 'create', type: '强制要求', normalized_rule, severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)] })
    }
    const checkpointPath = join(value.workspace.projectRoot, 'analysis/tender-analysis-checkpoint.json')
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      requirements: Array<{ ref: string }>
      scoring: Array<{ ref: string }>
      compliance: Array<{ ref: string }>
    }
    checkpoint.requirements[2]!.ref = 'R4'
    checkpoint.scoring[2]!.ref = 'S4'
    checkpoint.compliance[2]!.ref = 'C4'
    await writeFile(checkpointPath, JSON.stringify(checkpoint))
    value.runtime.dispose()
    const restored = await attachTenderAnalysisSubmissionRuntime(
      value.agent, value.workspace, await value.workspace.readManifest(), value.run,
    )

    await expect(value.call('submit_requirement', {
      action: 'create', category: '功能要求', normalized_requirement: '要求四', mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).resolves.toMatchObject({ requirement_ref: 'R3' })
    await expect(value.call('submit_scoring_item', {
      action: 'create', group: '技术方案', title: '评分四', criterion: '评分四规则', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })).resolves.toMatchObject({ scoring_ref: 'S3' })
    await expect(value.call('submit_compliance_item', {
      action: 'create', type: '强制要求', normalized_rule: '规则四', severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
    })).resolves.toMatchObject({ compliance_ref: 'C3' })
    expect(restored.reviewSnapshot()).toMatchObject({
      requirements: [{ requirement_ref: 'R1' }, { requirement_ref: 'R2' }, { requirement_ref: 'R4' }, { requirement_ref: 'R3' }],
      scoring: [{ scoring_ref: 'S1' }, { scoring_ref: 'S2' }, { scoring_ref: 'S4' }, { scoring_ref: 'S3' }],
      compliance: [{ compliance_ref: 'C1' }, { compliance_ref: 'C2' }, { compliance_ref: 'C4' }, { compliance_ref: 'C3' }],
    })
    restored.dispose()
  })

  it('keeps original scoring groups, fixes parent to null, and deduplicates identical groups structurally', async () => {
    const value = await fixture()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await expect(value.call('submit_scoring_item', {
      action: 'create', parent_ref: 'S1', group: '技术方案', title: '内部细则',
      criterion: '非法', score: null, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })).rejects.toThrow()
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '完整规则：根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '完整规则：根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '另一独立评分区块的规则。', score: 5, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderScoringArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')))
    expect(artifact.scoring_items.map(item => ({ id: item.id, parent: item.parent, score: item.score }))).toEqual([
      { id: 'SC-001', parent: null, score: 10 },
      { id: 'SC-003', parent: null, score: 5 },
    ])
    expect(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/tender-analysis-selection.json'), 'utf8')))
      .toEqual({ schema_version: 1, selected_scoring_ids: ['SC-001', 'SC-003'] })
    await expect(readFile(join(value.workspace.projectRoot, 'analysis/scoring.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(artifact.scoring_items[0]).toMatchObject({ raw_text: SCORING_QUOTE, source_refs: [expect.any(Object)] })
    value.runtime.dispose()
  })

  it('assigns stable COM IDs on replace and rejects an invalid severity at the tool boundary', async () => {
    const value = await fixture()
    const first = await value.call('submit_compliance_item', {
      action: 'create',
      type: '强制要求', normalized_rule: '初始规则', severity: 'mandatory',
      sources: [source(COMPLIANCE_QUOTE)],
    }) as { compliance_ref: string }
    await value.call('submit_compliance_item', {
      action: 'replace', replace_ref: first.compliance_ref, type: '强制要求',
      normalized_rule: '技术方案必须提供数据安全措施。', severity: 'fatal', sources: [source(COMPLIANCE_QUOTE)],
    })
    await expect(value.call('submit_compliance_item', {
      action: 'create', type: '强制要求', normalized_rule: '非法', severity: 'critical',
      sources: [source(COMPLIANCE_QUOTE)],
    })).rejects.toThrow()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderComplianceArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/compliance.json'), 'utf8')))
    expect(artifact.compliance_items).toEqual([expect.objectContaining({
      id: 'COM-001', raw_text: COMPLIANCE_QUOTE, severity: 'fatal',
    })])
    value.runtime.dispose()
  })

  it('preserves multiple cross-chunk citations as separate source_refs', async () => {
    const value = await fixture()
    const second = value.runtime.locators[1]!
    const chunkId = [...second.chunks.keys()][1]
    if (chunkId === undefined) throw new Error('missing second tender chunk')
    const raw = await readFile(second.chunks.get(chunkId)!.absolutePath, 'utf8')
    const secondQuoteMatch = /第二份招标技术要求第\d+段：系统应保持稳定运行并提交验收记录。/u.exec(raw)
    if (secondQuoteMatch?.[0] === undefined) throw new Error('missing second tender quote')
    const secondQuote = secondQuoteMatch[0]
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_requirement', {
      action: 'create',
      category: '功能要求', normalized_requirement: '系统支持审计并保持稳定运行。', mandatory: true,
      sources: [source(REQUIREMENT_QUOTE), source(secondQuote, chunkId, 'T2')],
    })
    await value.call('submit_scoring_item', {
      action: 'create',
      group: '技术方案', title: '总体技术方案',
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderRequirementsArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8')))
    expect(artifact.requirements[0]?.raw_text).toBe(`${REQUIREMENT_QUOTE}\n${secondQuote}`)
    expect(artifact.requirements[0]?.source_refs).toHaveLength(2)
    expect(new Set(artifact.requirements[0]?.source_refs.map(ref => ref.file_id))).toEqual(
      new Set(value.runtime.locators.map(locator => locator.file_id)),
    )
    value.runtime.dispose()
  })

  it('returns recoverable finish issues for missing scoring and requirements', async () => {
    const scoringMissing = await fixture()
    await scoringMissing.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    const scoringResult = await scoringMissing.call('finish_tender_analysis', {}) as { completed: boolean; issues: Array<{ code: string }> }
    expect(scoringResult.completed).toBe(false)
    expect(scoringResult.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY',
      'TENDER_ANALYSIS_REQUIREMENTS_SUSPICIOUSLY_EMPTY',
    ]))
    expect(scoringMissing.concludeTurn).toHaveBeenCalledOnce()
    expect(scoringMissing.runtime.completed).toBe(false)
    scoringMissing.runtime.dispose()
  })

  it('requires a same-runtime full review of the latest staged revision before publishing', async () => {
    const value = await fixture()
    await submitComplete(value)
    const initialRevision = value.runtime.revision

    await expect(value.call('finish_tender_analysis', {})).resolves.toEqual({
      completed: false,
      review_required: true,
      revision: initialRevision,
    })
    expect(value.runtime.phase).toBe('review_required')
    expect(value.concludeTurn).toHaveBeenCalledOnce()
    await expect(readFile(join(value.workspace.projectRoot, 'analysis/project.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(value.call('finish_tender_analysis', {})).resolves.toMatchObject({
      completed: false,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_OPERATION_NOT_ALLOWED' })],
    })
    for (const [name, args] of [
      ['submit_project_fact', { field: 'project_name', value: '不应写入', sources: [source(PROJECT_QUOTE)] }],
      ['submit_requirement', { action: 'create', category: '功能要求', normalized_requirement: '不应写入', mandatory: true, sources: [source(REQUIREMENT_QUOTE)] }],
      ['submit_scoring_item', { action: 'create', group: '技术方案', title: '不应写入', criterion: '不应写入', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)] }],
      ['submit_compliance_item', { action: 'create', type: '强制要求', normalized_rule: '不应写入', severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)] }],
    ] as const) await expect(value.call(name, args)).resolves.toMatchObject({
      recorded: false,
      rejected: true,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_OPERATION_NOT_ALLOWED' })],
    })
    expect(value.runtime.revision).toBe(initialRevision)
    expect(value.concludeTurn).toHaveBeenCalledTimes(6)

    const snapshot = value.runtime.reviewSnapshot() as { revision: number; scoring: Array<{ scoring_ref: string; title: string }> }
    expect(snapshot).toMatchObject({ revision: initialRevision })
    expect(snapshot.scoring).toEqual([expect.objectContaining({ scoring_ref: 'S1', title: '总体技术方案' })])
    await value.runtime.beginReview()
    const corrected = await value.call('submit_scoring_item', {
      action: 'replace', replace_ref: 'S1', group: '技术方案', title: '总体技术方案（复核修正）',
      criterion: '根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    }) as { revision: number }
    expect(corrected.revision).toBe(initialRevision + 1)
    await expect(value.call('finish_tender_analysis', { review_revision: initialRevision })).resolves.toMatchObject({
      completed: false,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_REVIEW_REVISION_MISMATCH' })],
      revision: corrected.revision,
    })
    expect(value.concludeTurn).toHaveBeenCalledTimes(7)
    await expect(value.call('finish_tender_analysis', { review_revision: corrected.revision })).resolves.toMatchObject({
      completed: true,
      revision: corrected.revision,
    })
    const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')))
    expect(scoring.scoring_items[0]?.title).toBe('总体技术方案（复核修正）')
    value.runtime.dispose()
  })

  it('提前携带复核版本时仍进入初次复核', async () => {
    const value = await fixture()
    await submitComplete(value)

    await expect(value.call('finish_tender_analysis', { review_revision: value.runtime.revision })).resolves.toEqual({
      completed: false,
      review_required: true,
      revision: value.runtime.revision,
    })
    expect(value.runtime.phase).toBe('review_required')
    value.runtime.dispose()
  })

  it('writes four parser-compatible Artifacts that pass the final Validator and remain S3-readable', async () => {
    const value = await fixture()
    await submitComplete(value)
    const result = await finishReviewed(value)
    expect(result).toEqual({
      completed: true,
      revision: value.runtime.revision,
      summary: { tender_files: 2, requirements: 1, scoring_items: 1, compliance_items: 1 },
    })
    const [project, requirements, scoring, compliance] = await Promise.all([
      readFile(join(value.workspace.projectRoot, 'analysis/project.json'), 'utf8').then(JSON.parse).then(parseTenderProjectArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8').then(JSON.parse).then(parseTenderRequirementsArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8').then(JSON.parse).then(parseTenderScoringArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/compliance.json'), 'utf8').then(JSON.parse).then(parseTenderComplianceArtifact),
    ])
    expect({ project, requirements, scoring, compliance }).toBeDefined()
    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', [
      { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
      { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
      { stage: 'tender_analysis', type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
      { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
    ])).resolves.toEqual({ ok: true })
    expect(value.runtime.completed).toBe(true)
    value.runtime.dispose()
  })
})
