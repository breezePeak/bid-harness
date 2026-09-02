import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidWorkspace,
  buildBidStageTask,
  executeOutlineGeneration,
  parseTenderScoringArtifact,
  parseTenderRequirementsArtifact,
  parseScoringResponsePointCatalog,
  renderOutlineGenerationTask,
  scoringArtifactSha256,
  validateConfirmedOutline,
  validateOutlineGenerationQuality,
  validateOutlineGeneration,
  type OutlineArtifact,
  type StageArtifact,
  type StageValidationIssue,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'outline_generation', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
  { stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' },
  { stage: 'outline_generation', type: 'outline_quality_report', path: 'outline/quality-report.json' },
]
const source = { file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }

const requirements = {
  schema_version: 1,
  requirements: [
    { id: 'REQ-ORG', category: 'implementation', raw_text: '建立项目组织。', normalized_requirement: '建立项目组织。', mandatory: true, source_refs: [source] },
    { id: 'REQ-SCHEDULE', category: 'implementation', raw_text: '制定实施进度。', normalized_requirement: '制定实施进度。', mandatory: true, source_refs: [source] },
  ],
}

const scoring = {
  schema_version: 1,
  scoring_items: [{
    id: 'SCORE-SCHEDULE', parent: null, group: '技术', title: '实施进度', raw_text: '实施进度合理得分。',
    criterion: '实施阶段和进度安排合理。', score: 10, score_range: null, must_answer: true,
    source_refs: [source],
  }],
}
const scoringArtifact = parseTenderScoringArtifact(scoring)

const compliance = {
  schema_version: 1,
  compliance_items: [{
    id: 'COMP-DELIVERY', type: 'mandatory_response', raw_text: '必须按期交付。', normalized_rule: '按期交付。', severity: 'mandatory', source_refs: [source],
  }],
}

const reviewedOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [
    {
      id: 'SEC-IMPLEMENTATION',
      parent_id: null,
      order: 1,
      level: 1,
      title: '项目实施方案',
      purpose: '组织实施专题。',
      writable: false,
      must_answer: [],
      requirement_ids: [],
      scoring_ids: [],
      compliance_ids: [],
      origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [],
      suggested_tables: [],
      suggested_figures: [],
      writing_notes: [],
    },
    {
      id: 'SEC-ORGANIZATION', parent_id: 'SEC-IMPLEMENTATION', order: 1, level: 2, title: '项目组织与职责', purpose: '说明组织安排。', writable: true,
      must_answer: ['明确项目组织、岗位职责和协同机制。'], requirement_ids: ['REQ-ORG'], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
    },
    {
      id: 'SEC-SCHEDULE', parent_id: 'SEC-IMPLEMENTATION', order: 2, level: 2, title: '实施阶段与进度控制', purpose: '说明阶段安排。', writable: true,
      must_answer: ['列明实施阶段、里程碑和进度保障措施。'], requirement_ids: ['REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
    },
  ],
}

const coarseOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [{
    id: 'SEC-IMPLEMENTATION', parent_id: null, order: 1, level: 1, title: '项目实施方案', purpose: '响应项目实施要求。', writable: true,
    must_answer: ['完整响应项目技术要求。'], requirement_ids: ['REQ-ORG', 'REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

const researchDrivenOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [{
    id: 'SEC-SECURITY', parent_id: null, order: 1, level: 1, title: '数据安全保障体系', purpose: '响应安全技术要求。', writable: true,
    must_answer: ['说明数据分类分级、访问控制和安全审计措施。'], requirement_ids: ['REQ-ORG', 'REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

async function fixture(): Promise<BidWorkspace> {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-outline-generation-')), 'session')
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify(requirements)),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify(scoring)),
    writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), JSON.stringify(compliance)),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(scoringArtifact), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] })),
    writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 7, research_topics: [], requirement_mappings: [], scoring_mappings: [], response_point_mappings: [{ response_point_id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障', local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['进度控制'] }] })),
  ])
  return workspace
}

async function publishOutline(workspace: BidWorkspace, outline: OutlineArtifact, qualityIssues: string[] = []): Promise<void> {
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'outline/outline.json'), `${JSON.stringify(outline)}\n`),
    writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), `${JSON.stringify({
      schema_version: 3,
      scope: 'technical_bid',
      checked_requirement_ids: requirements.requirements.map(item => item.id),
      checked_scoring_ids: scoring.scoring_items.map(item => item.id),
      checked_scoring_response_point_ids: ['RP-000001'],
      reviewed_section_ids: outline.sections.map(item => item.id),
      issues: qualityIssues,
    })}\n`),
  ])
}

function failureCodes(result: Awaited<ReturnType<typeof validateOutlineGeneration>>): string[] {
  return result.ok ? [] : result.issues.map(issue => issue.code)
}

describe('outline-generation Blueprint Quality Review', () => {
  it('gives S3 stable response points and tender conclusions as structural inputs', async () => {
    const workspace = await fixture()
    const task = renderOutlineGenerationTask({ id: 'session', session: { events: [] } } as unknown as Agent, workspace, buildBidStageTask('outline_generation'))

    expect(task).toContain('稳定评分响应点目录设计技术标详细写作 Blueprint')
    expect(task).toContain('id、parent_id、order、level、title、purpose、writable、must_answer')
    expect(task).toContain('目录模式：无人工框架')
    expect(task).toContain('评分响应点和评分项为主要拆分依据')
  })

  it('injects successful outline-framework headings without S3 source mappings', async () => {
    const workspace = await fixture()
    await workspace.import([{
      name: 'framework.md', role: 'outline_framework',
      bytes: new TextEncoder().encode('# 总体方案\n\n## 实施计划\n'),
    }])
    const followup = vi.fn()
    let idleCalls = 0
    const whenIdle = vi.fn(async () => {
      idleCalls += 1
      if (idleCalls === 2) await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({ schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }))
      if (idleCalls === 4) await publishOutline(workspace, reviewedOutline)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = { id: 'session', session: { events: [] }, ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() }, followup, whenIdle } as unknown as Agent

    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))

    const draftMessage = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(draftMessage.content[0]?.text).toContain('目录模式：存在人工框架')
    expect(draftMessage.content[0]?.text).toContain('总体方案')
    expect(draftMessage.content[0]?.text).toContain('实施计划')
    expect(draftMessage.content[0]?.text).not.toContain('mapping_id')
  })

  it('publishes the Blueprint written after response-point analysis', async () => {
    const workspace = await fixture()
    const followup = vi.fn()
    let idleCalls = 0
    const whenIdle = vi.fn(async () => {
      idleCalls += 1
      if (idleCalls === 2) await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({ schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }))
      if (idleCalls === 4) await publishOutline(workspace, researchDrivenOutline)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = { id: 'session', session: { events: [] }, ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() }, followup, whenIdle } as unknown as Agent

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).resolves.toEqual(artifacts)
    const outline = JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
    expect(outline.sections[0]).toMatchObject({
      title: '数据安全保障体系',
      must_answer: ['说明数据分类分级、访问控制和安全审计措施。'],
    })
  })

  it('revises a coarse first draft in a mandatory second Agent follow-up before validation', async () => {
    const workspace = await fixture()
    const followup = vi.fn()
    let idleCalls = 0
    const whenIdle = vi.fn(async () => {
      idleCalls += 1
      if (idleCalls === 2) await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({ schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }))
      if (idleCalls === 3) {
        await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
        await writeFile(join(workspace.sessionRoot, 'outline/outline.json'), `${JSON.stringify(coarseOutline)}\n`)
      }
      if (idleCalls === 4) await publishOutline(workspace, reviewedOutline)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = {
      id: 'session',
      session: { events: [] },
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup,
      whenIdle,
    } as unknown as Agent

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation')))
      .resolves.toEqual(artifacts)
    expect(whenIdle).toHaveBeenCalledTimes(4)
    expect(followup).toHaveBeenCalledTimes(3)
    const draftMessage = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    const reviewMessage = followup.mock.calls[2]?.[0] as { content: Array<{ text: string }> }
    expect(draftMessage.content[0]?.text).toContain('本轮初稿唯一输出')
    expect(reviewMessage.content[0]?.text).toContain('这是强制复核')
    expect(reviewMessage.content[0]?.text).toContain('根据评分语义判断章节')
    expect(reviewMessage.content[0]?.text).not.toContain('不得超过 4 个')
    expect(reviewMessage.content[0]?.text).not.toContain('不得超过 3 个')
    expect(reviewMessage.content[0]?.text).toContain('quality-report.json')
    expect(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8'))).toEqual(reviewedOutline)
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it('repairs an invalid reviewed Blueprint before the stage returns', async () => {
    const workspace = await fixture()
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 2) await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({ schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }))
      if (whenIdle.mock.calls.length === 3) {
        await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
        await writeFile(join(workspace.sessionRoot, 'outline/outline.json'), JSON.stringify({ ...reviewedOutline, schema_version: 0 }))
      }
      if (whenIdle.mock.calls.length === 4) {
        await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), JSON.stringify({
          schema_version: 0, scope: 'technical_bid', checked_requirement_ids: [], checked_scoring_ids: [], reviewed_section_ids: [], issues: [],
        }))
      }
      if (whenIdle.mock.calls.length === 5) await publishOutline(workspace, reviewedOutline)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = { id: 'session', session: { events: [] }, ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() }, followup, whenIdle } as unknown as Agent

    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 })

    expect(followup).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(followup.mock.calls[3]?.[0])).toContain('Artifact Repair')
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it.each([
    ['writable parent', (outline: OutlineArtifact) => {
      outline.sections[0] = { ...outline.sections[0]!, writable: true, must_answer: ['统筹项目实施专题。'] }
    }, 'OUTLINE_SHARED_WRITABLE_NOT_LEAF'],
    ['duplicate sibling title', (outline: OutlineArtifact) => {
      outline.sections[2] = { ...outline.sections[2]!, title: outline.sections[1]!.title }
    }, 'OUTLINE_SHARED_SECTION_TITLE_DUPLICATE'],
    ['duplicate must-answer item', (outline: OutlineArtifact) => {
      outline.sections[1] = { ...outline.sections[1]!, must_answer: ['明确项目组织、岗位职责和协同机制。', '明确项目组织、岗位职责和协同机制'] }
    }, 'OUTLINE_SHARED_SECTION_REFERENCE_DUPLICATE'],
  ])('rejects a %s', async (_name, mutate, expectedCode) => {
    const workspace = await fixture()
    const outline = structuredClone(reviewedOutline)
    mutate(outline)
    await publishOutline(workspace, outline)
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts))).toContain(expectedCode)
  })

  it('requires a complete clean internal quality report without inventing ids', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })

    await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), JSON.stringify({
      schema_version: 3,
      scope: 'technical_bid',
      checked_requirement_ids: ['REQ-ORG'],
      checked_scoring_ids: ['SCORE-SCHEDULE'],
      checked_scoring_response_point_ids: ['RP-000001'],
      reviewed_section_ids: reviewedOutline.sections.map(item => item.id),
      issues: [],
    }))
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts)))
      .toContain('OUTLINE_GENERATION_QUALITY_REQUIREMENT_MISSING')

    await publishOutline(workspace, reviewedOutline, ['实施章节仍然过粗。'])
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts)))
      .toContain('OUTLINE_GENERATION_QUALITY_ISSUES_UNRESOLVED')

    await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), '')
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts)))
      .toContain('OUTLINE_GENERATION_INPUT_INVALID')
  })

  it('applies the writable-leaf rule to S5 candidates', () => {
    const outline = structuredClone(reviewedOutline)
    outline.sections[0] = { ...outline.sections[0]!, writable: true, must_answer: ['统筹项目实施专题。'] }
    const result = validateConfirmedOutline(outline, requirements, scoring, compliance, { schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(scoringArtifact), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('S5 candidate unexpectedly passed')
    expect(result.issues.map(issue => issue.code)).toContain('OUTLINE_SHARED_WRITABLE_NOT_LEAF')
  })

  it('does not impose fixed requirement or scoring counts on a writable section', () => {
    const manyRequirements = parseTenderRequirementsArtifact({ schema_version: 1, requirements: Array.from({ length: 5 }, (_, index) => ({ ...requirements.requirements[0]!, id: `REQ-${String(index + 1)}`, raw_text: `要求${String(index + 1)}`, normalized_requirement: `要求${String(index + 1)}` })) })
    const manyScoring = parseTenderScoringArtifact({ schema_version: 1, scoring_items: Array.from({ length: 4 }, (_, index) => ({ ...scoring.scoring_items[0]!, id: `SCORE-${String(index + 1)}`, title: `评分${String(index + 1)}` })) })
    const manyCatalog = parseScoringResponsePointCatalog({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(manyScoring), next_sequence: 5, points: manyScoring.scoring_items.map((item, index) => ({ id: `RP-${String(index + 1).padStart(6, '0')}`, scoring_id: item.id, order: 1, text: `响应点${String(index + 1)}` })) })
    const outline: OutlineArtifact = { schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '综合实施方案', purpose: '完整响应。', writable: true, must_answer: ['分别说明五项要求和四项评分响应。'], requirement_ids: manyRequirements.requirements.map(item => item.id), scoring_ids: manyScoring.scoring_items.map(item => item.id), compliance_ids: [], origin: 'generated', scoring_response_point_ids: manyCatalog.points.map(point => point.id), scoring_response_points: manyCatalog.points.map(point => ({ scoring_id: point.scoring_id, response_point: point.text })), suggested_tables: [], suggested_figures: [], writing_notes: [] }] }
    const qualityIssues: StageValidationIssue[] = []
    validateOutlineGenerationQuality(outline, { schema_version: 3, scope: 'technical_bid', checked_requirement_ids: outline.sections[0]!.requirement_ids, checked_scoring_ids: outline.sections[0]!.scoring_ids, checked_scoring_response_point_ids: manyCatalog.points.map(point => point.id), reviewed_section_ids: ['SEC-1'], issues: [] }, manyRequirements, manyScoring, manyCatalog, qualityIssues)
    expect(qualityIssues).toEqual([])
    const s5 = validateConfirmedOutline(
      outline,
      manyRequirements,
      manyScoring,
      { schema_version: 1, compliance_items: [] },
      manyCatalog,
    )
    expect(s5).toEqual({ ok: true })
  })

  it('keeps structural rules in the model-visible draft assignment', async () => {
    const workspace = await fixture()
    const task = renderOutlineGenerationTask({ id: 'session', session: { events: [] } } as unknown as Agent, workspace, buildBidStageTask('outline_generation'))
    expect(task).toContain('索引重复引用不能替代正文拆分')
  })
})
