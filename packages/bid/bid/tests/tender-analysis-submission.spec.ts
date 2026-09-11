import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  attachTenderAnalysisSubmissionRuntime,
  BidWorkspace,
  DEFAULT_BID_CONFIG,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  resolveTenderQuoteSourceRef,
  validateTenderAnalysis,
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
  call(name: string, args: unknown): Promise<unknown>
}

async function fixture(): Promise<Fixture> {
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
        '重复短语。重复短语。',
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
  const runtime = await attachTenderAnalysisSubmissionRuntime(agent, workspace, await workspace.readManifest())
  const concludeTurn = vi.fn()
  const call = async (name: string, args: unknown): Promise<unknown> => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return definition.execute(args, { agent, signal: new AbortController().signal, concludeTurn } as unknown as ToolRunContext)
  }
  return { workspace, agent, tools: definitions, runtime, concludeTurn, call }
}

function source(quote: string, chunk?: string, file_ref = 'T1') {
  const resolvedChunk = chunk ?? (quote === PROJECT_QUOTE ? 'chunk_0001'
    : quote === REQUIREMENT_QUOTE || quote === COMPLIANCE_QUOTE ? 'chunk_0002' : 'chunk_0003')
  return { file_ref, chunk: resolvedChunk, quote }
}

async function submitComplete(value: Fixture): Promise<void> {
  await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
  await value.call('submit_requirement', {
    category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: '系统应支持统一身份认证和审计日志。',
    mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
  })
  await value.call('submit_scoring_item', {
    parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
    criterion: '根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
    must_answer: true, sources: [source(SCORING_QUOTE)],
  })
  await value.call('submit_compliance_item', {
    type: '强制要求', raw_text: COMPLIANCE_QUOTE, normalized_rule: '技术方案必须提供数据安全措施。',
    severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
  })
}

async function finishReviewed(value: Fixture): Promise<unknown> {
  const staged = await value.call('finish_tender_analysis', {}) as { review_required?: boolean; revision?: number }
  expect(staged).toMatchObject({ completed: false, review_required: true, revision: value.runtime.revision })
  value.runtime.beginReview()
  return value.call('finish_tender_analysis', { review_revision: value.runtime.revision })
}

describe('tender-analysis staged submission runtime', () => {
  it('builds T1/T2 from successful tenders only and resolves a unique quote to exact lines', async () => {
    const value = await fixture()
    expect(value.runtime.locators.map(locator => ({ ref: locator.file_ref, name: locator.name }))).toEqual([
      { ref: 'T1', name: 'main-tender.md' },
      { ref: 'T2', name: 'second-tender.md' },
    ])
    const locator = value.runtime.locators[0]!
    const resolved = await resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source(REQUIREMENT_QUOTE))
    const raw = await readFile(locator.chunks.get('chunk_0002')!.absolutePath, 'utf8')
    const start = raw.indexOf(REQUIREMENT_QUOTE)
    const expectedLine = raw.slice(0, start).split('\n').length
    expect(resolved).toEqual({
      file_id: locator.file_id,
      chunk: locator.chunks.get('chunk_0002')!.artifactPath,
      line_start: expectedLine,
      line_end: expectedLine,
    })
    const multiline = `${REQUIREMENT_QUOTE}\n\n${COMPLIANCE_QUOTE}`
    await expect(resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source(multiline, 'chunk_0002')))
      .resolves.toMatchObject({ line_start: expectedLine, line_end: expectedLine + 2 })
    value.runtime.dispose()
  })

  it('rejects unknown file refs, wrong chunks, missing quotes, and ambiguous quotes immediately', async () => {
    const value = await fixture()
    await expect(resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source(PROJECT_QUOTE, 'chunk_0001', 'T9')))
      .rejects.toThrow('未知 tender 引用')
    expect(value.runtime.locators[1]?.chunks.has('chunk_0004')).toBe(true)
    await expect(resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source(PROJECT_QUOTE, 'chunk_0004')))
      .rejects.toThrow('不属于 T1')
    await expect(resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source('并不存在的原文', 'chunk_0001')))
      .rejects.toThrow('正文中不存在')
    await expect(resolveTenderQuoteSourceRef(value.workspace, value.runtime.locators, source('重复短语', 'chunk_0003')))
      .rejects.toThrow('出现多次')
    value.runtime.dispose()
  })

  it('aggregates and deduplicates project arrays while Host supplies nulls, empty arrays, and tender coverage', async () => {
    const value = await fixture()
    const args = { field: 'project_background', value: '建设统一审计平台', sources: [source(PROJECT_QUOTE)] }
    await value.call('submit_project_fact', args)
    await value.call('submit_project_fact', args)
    await value.call('submit_requirement', {
      category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
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
      category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: '初始归纳', mandatory: true,
      sources: [source(REQUIREMENT_QUOTE)],
    }) as { requirement_ref: string }
    await value.call('submit_requirement', {
      replace_ref: first.requirement_ref, category: '功能要求', raw_text: REQUIREMENT_QUOTE,
      normalized_requirement: '修正后的归纳', mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await expect(value.call('submit_requirement', {
      id: 'REQ-CUSTOM', category: '功能要求', raw_text: REQUIREMENT_QUOTE,
      normalized_requirement: '非法', mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })).rejects.toThrow()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderRequirementsArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8')))
    expect(artifact.requirements).toEqual([expect.objectContaining({ id: 'REQ-001', normalized_requirement: '修正后的归纳' })])
    expect(artifact.requirements[0]?.source_refs[0]).not.toHaveProperty('file_ref')
    value.runtime.dispose()
  })

  it('keeps original scoring groups, drops nested details, and deduplicates identical groups structurally', async () => {
    const value = await fixture()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_requirement', {
      category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await expect(value.call('submit_scoring_item', {
      parent_ref: 'S99', group: '技术方案', title: '未知父项', raw_text: SCORING_QUOTE,
      criterion: '非法', score: null, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })).rejects.toThrow('未知 Scoring 引用')
    const parent = await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '完整规则：根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    }) as { scoring_ref: string }
    await value.call('submit_scoring_item', {
      parent_ref: parent.scoring_ref, group: '技术方案', title: '完整性', raw_text: SCORING_QUOTE,
      criterion: '按完整性评分', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '完整规则：根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source('# 技术评分', 'chunk_0003'), source(SCORING_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '另一独立评分区块的规则。', score: 5, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderScoringArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')))
    expect(artifact.scoring_items.map(item => ({ id: item.id, parent: item.parent, score: item.score }))).toEqual([
      { id: 'SC-001', parent: null, score: 10 },
      { id: 'SC-004', parent: null, score: 5 },
    ])
    expect(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/tender-analysis-selection.json'), 'utf8')))
      .toEqual({ schema_version: 1, selected_scoring_ids: ['SC-001', 'SC-004'] })
    await expect(readFile(join(value.workspace.projectRoot, 'analysis/scoring.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(artifact.scoring_items[0]?.source_refs).toHaveLength(2)
    value.runtime.dispose()
  })

  it('assigns stable COM IDs on replace and rejects an invalid severity at the tool boundary', async () => {
    const value = await fixture()
    const first = await value.call('submit_compliance_item', {
      type: '强制要求', raw_text: COMPLIANCE_QUOTE, normalized_rule: '初始规则', severity: 'mandatory',
      sources: [source(COMPLIANCE_QUOTE)],
    }) as { compliance_ref: string }
    await value.call('submit_compliance_item', {
      replace_ref: first.compliance_ref, type: '强制要求', raw_text: COMPLIANCE_QUOTE,
      normalized_rule: '技术方案必须提供数据安全措施。', severity: 'fatal', sources: [source(COMPLIANCE_QUOTE)],
    })
    await expect(value.call('submit_compliance_item', {
      type: '强制要求', raw_text: COMPLIANCE_QUOTE, normalized_rule: '非法', severity: 'critical',
      sources: [source(COMPLIANCE_QUOTE)],
    })).rejects.toThrow()
    await value.call('submit_project_fact', { field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] })
    await value.call('submit_requirement', {
      category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: REQUIREMENT_QUOTE,
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderComplianceArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/compliance.json'), 'utf8')))
    expect(artifact.compliance_items).toEqual([expect.objectContaining({ id: 'COM-001', severity: 'fatal' })])
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
      category: '功能要求', raw_text: `${REQUIREMENT_QUOTE}${secondQuote}`,
      normalized_requirement: '系统支持审计并保持稳定运行。', mandatory: true,
      sources: [source(REQUIREMENT_QUOTE), source(secondQuote, chunkId, 'T2')],
    })
    await value.call('submit_scoring_item', {
      parent_ref: null, group: '技术方案', title: '总体技术方案', raw_text: SCORING_QUOTE,
      criterion: '方案完整合理', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)],
    })
    await finishReviewed(value)
    const artifact = parseTenderRequirementsArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8')))
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
    await expect(value.call('finish_tender_analysis', {})).rejects.toThrow('当前初始分析已结束')
    for (const [name, args] of [
      ['submit_project_fact', { field: 'project_name', value: '不应写入', sources: [source(PROJECT_QUOTE)] }],
      ['submit_requirement', { category: '功能要求', raw_text: REQUIREMENT_QUOTE, normalized_requirement: '不应写入', mandatory: true, sources: [source(REQUIREMENT_QUOTE)] }],
      ['submit_scoring_item', { parent_ref: null, group: '技术方案', title: '不应写入', raw_text: SCORING_QUOTE, criterion: '不应写入', score: 10, score_range: null, must_answer: true, sources: [source(SCORING_QUOTE)] }],
      ['submit_compliance_item', { type: '强制要求', raw_text: COMPLIANCE_QUOTE, normalized_rule: '不应写入', severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)] }],
    ] as const) await expect(value.call(name, args)).rejects.toThrow('当前初始分析已结束')
    expect(value.runtime.revision).toBe(initialRevision)

    const snapshot = value.runtime.reviewSnapshot() as { revision: number; scoring: Array<{ scoring_ref: string; title: string }> }
    expect(snapshot).toMatchObject({ revision: initialRevision })
    expect(snapshot.scoring).toEqual([expect.objectContaining({ scoring_ref: 'S1', title: '总体技术方案' })])
    value.runtime.beginReview()
    const corrected = await value.call('submit_scoring_item', {
      replace_ref: 'S1', parent_ref: null, group: '技术方案', title: '总体技术方案（复核修正）', raw_text: SCORING_QUOTE,
      criterion: '根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    }) as { revision: number }
    expect(corrected.revision).toBe(initialRevision + 1)
    await expect(value.call('finish_tender_analysis', { review_revision: initialRevision })).resolves.toMatchObject({
      completed: false,
      issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_REVIEW_REVISION_MISMATCH' })],
      revision: corrected.revision,
    })
    await expect(value.call('finish_tender_analysis', { review_revision: corrected.revision })).resolves.toMatchObject({
      completed: true,
      revision: corrected.revision,
    })
    const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')))
    expect(scoring.scoring_items[0]?.title).toBe('总体技术方案（复核修正）')
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
