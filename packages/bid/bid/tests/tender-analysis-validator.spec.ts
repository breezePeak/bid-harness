import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  validateTenderAnalysis,
  type StageArtifact,
  type TenderSourceRef,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
  { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
  { stage: 'tender_analysis', type: 'tender_scoring', path: 'analysis/scoring.json' },
  { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
]

async function fixture(tenderText = '# 项目\n\n必须按期交付，技术方案得 10 分。'): Promise<{
  workspace: BidWorkspace
  tenderId: string
  referenceId: string
  source: TenderSourceRef
  referenceSource: TenderSourceRef
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tender-analysis-'))
  const workspace = new BidWorkspace(root, 'session')
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tenderText) },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('# 历史材料\n\n旧项目要求。') },
  ])
  if (tender === undefined || reference === undefined
    || tender.chunksPath === null || tender.absoluteChunkIndexPath === null
    || reference.chunksPath === null || reference.absoluteChunkIndexPath === null) {
    throw new Error('test corpus was not chunked')
  }
  const tenderIndex = JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const referenceIndex = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const tenderChunk = `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`
  const tenderChunkLineEnd = (await readFile(join(workspace.sessionRoot, tenderChunk), 'utf8')).split('\n').length
  const referenceChunk = `${reference.chunksPath}/${referenceIndex.chunks[0]!.path}`
  const referenceChunkLineEnd = (await readFile(join(workspace.sessionRoot, referenceChunk), 'utf8')).split('\n').length
  return {
    workspace,
    tenderId: tender.id,
    referenceId: reference.id,
    source: { file_id: tender.id, chunk: tenderChunk, line_start: 1, line_end: tenderChunkLineEnd },
    referenceSource: { file_id: reference.id, chunk: referenceChunk, line_start: 1, line_end: referenceChunkLineEnd },
  }
}

function documents(tenderId: string, source: TenderSourceRef): Record<string, unknown> {
  return {
    'project.json': {
      schema_version: 1,
      project_name: '交付项目',
      tender_name: null,
      purchaser: null,
      owner: null,
      project_background: ['项目需要按期完成技术建设'],
      project_objectives: ['形成可交付技术方案'],
      project_scope: ['技术方案'],
      technical_scope: ['方案设计'],
      delivery_scope: ['按期交付'],
      implementation_constraints: ['按期交付'],
      key_technical_points: ['技术方案完整性'],
      source_refs: [source],
      analyzed_tender_files: [tenderId],
    },
    'requirements.json': {
      schema_version: 1,
      requirements: [{
        id: 'REQ-1', category: '交付', raw_text: '必须按期交付', normalized_requirement: '按期交付',
        mandatory: true, source_refs: [source],
      }],
    },
    'scoring.json': {
      schema_version: 1,
      scoring_items: [{
        id: 'SCORE-1', parent: null, group: '技术', title: '技术方案', raw_text: '技术方案得 10 分',
        criterion: '提供技术方案', score: 10, score_range: null, must_answer: true,
        response_points: ['说明技术方案总体设计'], source_refs: [source],
      }],
    },
    'compliance.json': {
      schema_version: 1,
      compliance_items: [{
        id: 'COMP-1', type: 'mandatory_response', raw_text: '必须按期交付', normalized_rule: '必须响应交付期限',
        severity: 'mandatory', source_refs: [source],
      }],
    },
  }
}

async function publish(workspace: BidWorkspace, docs: Record<string, unknown>): Promise<void> {
  const root = join(workspace.sessionRoot, 'analysis')
  await mkdir(root, { recursive: true })
  await Promise.all(Object.entries(docs).map(([name, value]) => (
    writeFile(join(root, name), `${JSON.stringify(value)}\n`)
  )))
}

const codes = (result: Awaited<ReturnType<typeof validateTenderAnalysis>>): string[] => (
  result.ok ? [] : result.issues.map(issue => issue.code)
)

describe('tender-analysis Artifact schemas', () => {
  it('accepts the four current schema documents', () => {
    const source = { file_id: 'file', chunk: 'corpus/file/chunks/chunk_0001.md', line_start: 1, line_end: 1 }
    const docs = documents('file', source)
    expect(parseTenderProjectArtifact(docs['project.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderRequirementsArtifact(docs['requirements.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderScoringArtifact(docs['scoring.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderComplianceArtifact(docs['compliance.json'])).toMatchObject({ schema_version: 1 })
  })
})

describe('tender-analysis validator', () => {
  it('accepts complete Artifacts whose source refs cover the tender corpus', async () => {
    const value = await fixture()
    await publish(value.workspace, documents(value.tenderId, value.source))
    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })
  })

  it('accepts only technical items from a mixed scoring tender and rejects a classified commercial item', async () => {
    const technicalScoring = '系统总体技术方案 10 分。项目实施方案 8 分。数据安全方案 7 分。'
    const value = await fixture([
      '# 资格评分', '企业资质 5 分。', '# 商务评分', '类似项目业绩 10 分。',
      '# 技术评分', technicalScoring,
      '# 价格评分', '报价得分 30 分。',
    ].join('\n\n'))
    const citedText = await readFile(join(value.workspace.sessionRoot, value.source.chunk), 'utf8')
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as { requirements: unknown[] }
    const compliance = docs['compliance.json'] as { compliance_items: unknown[] }
    requirements.requirements = []
    compliance.compliance_items = []
    const scoring = docs['scoring.json'] as { scoring_items: Array<Record<string, unknown>> }
    scoring.scoring_items = [
      { ...scoring.scoring_items[0], id: 'TECH-1', title: '系统总体技术方案', raw_text: citedText, criterion: '总体方案完整合理', score: 10, response_points: ['总体架构', '技术路线'] },
      { ...scoring.scoring_items[0], id: 'TECH-2', title: '项目实施方案', raw_text: citedText, criterion: '实施方案可行', score: 8, response_points: ['实施阶段', '进度保障'] },
      { ...scoring.scoring_items[0], id: 'TECH-3', title: '数据安全方案', raw_text: citedText, criterion: '安全措施完整', score: 7, response_points: ['数据保护', '安全审计'] },
    ]
    await publish(value.workspace, docs)
    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })

    scoring.scoring_items.push({
      ...scoring.scoring_items[0], id: 'COMMERCIAL-1', group: '商务评分', title: '类似项目业绩',
      raw_text: citedText, criterion: '业绩数量', response_points: ['提供业绩'],
    })
    await publish(value.workspace, docs)
    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_NON_TECHNICAL_SCORING')
  })

  it('rejects a substantive tender when every extracted technical Artifact is empty', async () => {
    const value = await fixture([
      '# 项目说明',
      '本项目面向多个业务部门建设统一管理平台，需完成现状调研、方案设计、系统部署、数据迁移、联调试运行、用户培训、运行维护和验收交付，并提供持续的技术支持和现场服务。项目实施期间应形成完整文档，按计划组织协调并保障系统稳定运行。',
    ].join('\n\n'))
    const docs = documents(value.tenderId, value.source)
    ;(docs['requirements.json'] as { requirements: unknown[] }).requirements = []
    ;(docs['scoring.json'] as { scoring_items: unknown[] }).scoring_items = []
    ;(docs['compliance.json'] as { compliance_items: unknown[] }).compliance_items = []
    await publish(value.workspace, docs)

    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_CATASTROPHICALLY_EMPTY')
  })

  it.each([
    ['技术评分', '技术评分标准：技术方案完整性满分 10 分，并按实施方案的合理性评分。'],
    ['技术评审', '技术评审办法：技术方案完整性满分 10 分。'],
    ['技术评价', '技术评价标准：实施方案的合理性满分 10 分。'],
    ['技术部分评审', '技术部分评审：技术方案完整性满分 10 分。'],
    ['技术上下文中的评分办法和分值', '评分办法：技术方案分值 10 分，得分按完整性评定，满分 10 分。'],
  ])('rejects an empty scoring Artifact when tender text contains %s', async (_signal, sourceText) => {
    const value = await fixture(`# 技术评分\n\n${sourceText}`)
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as {
      requirements: Array<{ raw_text: string; normalized_requirement: string }>
    }
    const compliance = docs['compliance.json'] as { compliance_items: Array<{ raw_text: string }> }
    requirements.requirements[0]!.raw_text = sourceText
    requirements.requirements[0]!.normalized_requirement = '技术方案应完整响应评分标准'
    compliance.compliance_items[0]!.raw_text = sourceText
    ;(docs['scoring.json'] as { scoring_items: unknown[] }).scoring_items = []
    await publish(value.workspace, docs)

    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY')
  })

  it('rejects an empty requirements Artifact when tender text has multiple technical constraints', async () => {
    const functionRequirement = '系统功能要求：应支持统一身份认证和审计日志。'
    const performanceRequirement = '性能要求：在峰值并发时保持稳定响应。'
    const value = await fixture(`# 技术要求\n\n${functionRequirement}\n\n${performanceRequirement}`)
    const docs = documents(value.tenderId, value.source)
    const scoring = docs['scoring.json'] as { scoring_items: Array<{ raw_text: string }> }
    const compliance = docs['compliance.json'] as { compliance_items: Array<{ raw_text: string }> }
    scoring.scoring_items[0]!.raw_text = functionRequirement
    compliance.compliance_items[0]!.raw_text = performanceRequirement
    ;(docs['requirements.json'] as { requirements: unknown[] }).requirements = []
    await publish(value.workspace, docs)

    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_REQUIREMENTS_SUSPICIOUSLY_EMPTY')
  })

  it('allows an empty scoring Artifact when the tender has no technical-scoring signal', async () => {
    const sourceText = '系统功能要求：应支持日志审计和权限控制。'
    const value = await fixture(`# 技术要求\n\n${sourceText}`)
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as {
      requirements: Array<{ raw_text: string; normalized_requirement: string }>
    }
    requirements.requirements[0]!.raw_text = sourceText
    requirements.requirements[0]!.normalized_requirement = '系统支持日志审计和权限控制'
    ;(docs['scoring.json'] as { scoring_items: unknown[] }).scoring_items = []
    ;(docs['compliance.json'] as { compliance_items: unknown[] }).compliance_items = []
    await publish(value.workspace, docs)

    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })
  })

  it('does not treat purely commercial scoring as a technical-scoring signal', async () => {
    const technicalRequirement = '系统功能要求：应支持日志审计和权限控制。'
    const commercialScoring = '报价评分办法：价格得分满分 10 分。'
    const value = await fixture([
      '# 技术要求',
      technicalRequirement,
      '# 商务评分',
      commercialScoring,
    ].join('\n\n'))
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as {
      requirements: Array<{ raw_text: string; normalized_requirement: string }>
    }
    requirements.requirements[0]!.raw_text = technicalRequirement
    requirements.requirements[0]!.normalized_requirement = '系统支持日志审计和权限控制'
    ;(docs['scoring.json'] as { scoring_items: unknown[] }).scoring_items = []
    ;(docs['compliance.json'] as { compliance_items: unknown[] }).compliance_items = []
    await publish(value.workspace, docs)

    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })
  })

  it.each([
    ['requirements.json', 'requirements'],
    ['scoring.json', 'scoring_items'],
    ['compliance.json', 'compliance_items'],
  ])('rejects %s raw_text that is absent from its cited source range', async (artifactName, itemKey) => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    const artifact = docs[artifactName] as Record<string, unknown>
    const items = artifact[itemKey] as Array<Record<string, unknown>>
    items[0]!.raw_text = '必须建设三座数据中心。'
    await publish(value.workspace, docs)
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
    expect(codes(result)).toContain('TENDER_ANALYSIS_SOURCE_TEXT_MISMATCH')
  })

  it('distinguishes missing files from invalid JSON', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    await publish(value.workspace, docs)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/scoring.json'), '{')
    await rm(join(value.workspace.sessionRoot, 'analysis/compliance.json'))
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([
      {
        code: 'TENDER_ANALYSIS_JSON_INVALID',
        artifact: 'analysis/scoring.json',
        message: expect.stringContaining('JSON 语法无效'),
      },
      {
        code: 'TENDER_ANALYSIS_ARTIFACT_MISSING',
        artifact: 'analysis/compliance.json',
        message: '缺少必需的招标分析文件。',
      },
    ]) })
  })

  it.each([
    ['project.json 缺少字段', 'project.json', (doc: Record<string, unknown>) => { delete doc.project_name }, 'project_name', '缺少必需字段。'],
    ['project.json 多出字段', 'project.json', (doc: Record<string, unknown>) => { doc.unknown_field = true }, 'unknown_field', '存在 Schema 未定义的字段。'],
    ['project.json 单值使用空字符串', 'project.json', (doc: Record<string, unknown>) => { doc.owner = '' }, 'owner', '未知值应使用 null，不能使用空字符串。'],
    ['scoring.json 缺少 response_points', 'scoring.json', (doc: Record<string, unknown>) => { delete (doc.scoring_items as Array<Record<string, unknown>>)[0]!.response_points }, 'scoring_items[0].response_points', '缺少必需字段。'],
    ['scoring.json response_points 为空数组', 'scoring.json', (doc: Record<string, unknown>) => { (doc.scoring_items as Array<Record<string, unknown>>)[0]!.response_points = [] }, 'scoring_items[0].response_points', '至少需要一项技术响应重点。'],
    ['scoring.json score 为字符串', 'scoring.json', (doc: Record<string, unknown>) => { (doc.scoring_items as Array<Record<string, unknown>>)[0]!.score = '10' }, 'scoring_items[0].score', '必须为数字或 null。'],
    ['scoring.json 缺少 parent', 'scoring.json', (doc: Record<string, unknown>) => { delete (doc.scoring_items as Array<Record<string, unknown>>)[0]!.parent }, 'scoring_items[0].parent', '缺少必需字段。'],
    ['compliance.json severity 非法', 'compliance.json', (doc: Record<string, unknown>) => { (doc.compliance_items as Array<Record<string, unknown>>)[0]!.severity = 'critical' }, 'compliance_items[0].severity', '只能使用 fatal、mandatory 或 warning。'],
    ['source_refs 结构非法', 'requirements.json', (doc: Record<string, unknown>) => { delete ((doc.requirements as Array<Record<string, unknown>>)[0]!.source_refs as Array<Record<string, unknown>>)[0]!.line_end }, 'requirements[0].source_refs[0].line_end', '缺少必需字段。'],
  ] as const)('returns a browser-safe schema issue for %s', async (_name, artifactName, mutate, path, message) => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    mutate(docs[artifactName] as Record<string, unknown>)
    await publish(value.workspace, docs)
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([{
      code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
      artifact: `analysis/${artifactName}`,
      path,
      message,
    }]) })
  })

  it('rejects duplicate item ids', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as { requirements: unknown[] }
    requirements.requirements.push(structuredClone(requirements.requirements[0]))
    await publish(value.workspace, docs)
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
    expect(codes(result)).toContain('TENDER_ANALYSIS_DUPLICATE_ID')
  })

  it('rejects reference authority, dangling chunks, traversal, and invalid lines', async () => {
    for (const mutate of [
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => value.referenceSource,
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, chunk: 'corpus/missing/chunk.md' }),
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, chunk: '../outside.md' }),
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, line_start: 999, line_end: 999 }),
    ]) {
      const value = await fixture()
      await publish(value.workspace, documents(value.tenderId, mutate(value)))
      const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
      expect(result.ok).toBe(false)
    }
  })

  it('requires exact coverage of every successfully parsed tender file', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    ;(docs['project.json'] as { analyzed_tender_files: string[] }).analyzed_tender_files = []
    await publish(value.workspace, docs)
    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_COVERAGE_INCOMPLETE')
  })
})
