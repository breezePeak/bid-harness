import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { pickChapterContext, renderChapterExecutionPlanTask, validateChapterCandidate, type ChapterContext } from '../src/chapter-writing-executor.ts'
import type { ChapterCandidate } from '../src/chapter-writing-artifacts.ts'
import { validateChapterWriting } from '../src/chapter-writing-validator.ts'
import type { WebEvidenceSnapshot } from '../src/web-evidence-snapshot.ts'
import { resolveFrameworkDraftMaterials } from '../src/outline-framework.ts'
import {
  BidWorkspace,
  CHAPTER_EXECUTION_SCHEMA_VERSION,
  buildBidStageTask,
  executeChapterWriting,
  getBidStagePolicy,
  outlineArtifactSha256,
  createScoringResponsePointCatalog,
  parseChapterExecutionLog,
  parseEvidenceMapArtifact,
  parseChapterWritingManifest,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  parseWebEvidenceSourcesArtifact,
  webEvidenceContentSha256,
} from '@deepseek-ai/dsh-bid'

const source = [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }]

async function writeInputs(workspace: BidWorkspace): Promise<ReturnType<typeof outlineFixture>> {
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'analysis/project.json'), `${JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['交付'], technical_scope: ['技术'], delivery_scope: ['实施'], implementation_constraints: ['周期'], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: ['tender'] })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), `${JSON.stringify({ schema_version: 1, requirements: [1, 2, 3].map(index => ({ id: `REQ-${index}`, category: '技术', raw_text: `要求${index}`, normalized_requirement: `响应要求${index}`, mandatory: true, source_refs: source })) })}\n`)
  const scoring = { schema_version: 1 as const, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, source_refs: source })) }
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), `${JSON.stringify(scoring)}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), `${JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [1, 2, 3].map(index => ({ scoring_id: `SCORE-${index}`, order: 1, text: `回答评分${index}` })) }))}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), `${JSON.stringify({ schema_version: 1, compliance_items: [] })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), `${JSON.stringify({ schema_version: 10, section_mappings: [1, 2, 3].map(index => ({ section_id: `SEC-${index}`, local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['技术方案'] })) })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({ schema_version: 2, stage: 'evidence_mapping', sources: [] })}\n`)
  const outline = outlineFixture()
  await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`)
  const outlineSha256 = outlineArtifactSha256(outline)
  await writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), `${JSON.stringify({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineSha256, confirmed_outline_sha256: outlineSha256, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineSha256 })}\n`)
  return outline
}

function outlineFixture() {
  return { schema_version: 3 as const, scope: 'technical_bid' as const, document_title: '技术标', global_compliance_ids: [], sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '目录', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const, scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...[1, 2, 3].map(index => ({ id: `SEC-${index}`, parent_id: 'STRUCT', order: index, level: 2, title: `章节${index}`, purpose: `回答主题${index}`, writable: true, must_answer: [`回答${index}`], requirement_ids: [`REQ-${index}`], scoring_ids: [`SCORE-${index}`], compliance_ids: [], origin: 'generated' as const, scoring_response_point_ids: [`RP-${String(index).padStart(6, '0')}`], scoring_response_points: [{ scoring_id: `SCORE-${index}`, response_point: `回答评分${index}` }], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ] }
}

function promptText(request: SubagentStartRequest): string {
  return request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function emptyHandoff(section_id: string) {
  return {
    section_id,
    decisions: [],
    terminology: [],
    numbers_and_parameters: [],
    interfaces: [],
    deployment_constraints: [],
    cross_reference_targets: [],
    unresolved_topics: [],
  }
}

function emptyChapterContext(section: ReturnType<typeof outlineFixture>['sections'][number]): ChapterContext {
  return {
    section,
    contentPath: 'chapters/sections/0001.md',
    metadataPath: 'chapters/meta/0001.json',
    project: parseTenderProjectArtifact({
      schema_version: 1,
      project_name: '测试项目',
      tender_name: null,
      purchaser: null,
      owner: null,
      project_background: [],
      project_objectives: [],
      project_scope: [],
      technical_scope: [],
      delivery_scope: [],
      implementation_constraints: [],
      key_technical_points: [],
      source_refs: source,
      analyzed_tender_files: ['tender'],
    }),
    requirements: [],
    scoring: [],
    responsePoints: [],
    compliance: [],
    relatedMaterials: [],
    referenceBidMaterials: [],
    frameworkDraftMaterials: [],
    webMaterials: [],
    writingDimensions: [],
    missingTopics: [],
    availableLocalCorpus: [],
    localReadLocations: [],
    frameworkReadLocations: [],
    webReadLocations: [],
  }
}

const fetchedAt = '2026-09-01T00:00:00.000Z'
const fetchedUrl = 'https://official.example/standard'

const chunkIndex = {
  schema_version: 1,
  source_document: 'document.md',
  chunk_count: 1,
  chunk_config: { minChars: 1, targetChars: 2, maxChars: 3 },
  chunks: [{
    id: 'chunk_0001', path: 'chunk_0001.md', order: 1, heading_path: ['章节'],
    page_start: null, page_end: null, source_line_start: 1, source_line_end: 1,
    char_count: 2, prev_chunk: null, next_chunk: null, oversized: false,
  }],
}

function manifestFile(id: string, role: 'tender' | 'outline_framework' | 'reference' | 'reference_bid') {
  const root = `corpus/${role}`
  return {
    id, role, originalName: `${role}.md`, inputPath: `input/${role}.md`, corpusPath: root,
    documentPath: `${root}/document.md`, structurePath: `${root}/structure.json`, metadataPath: `${root}/metadata.json`,
    chunksPath: `${root}/chunks`, chunkIndexPath: `${root}/chunks/index.json`, mediaType: 'text/markdown',
    size: 1, sha256: id, parseStatus: 'success', parseError: null,
  }
}

async function seedReadableMaterials(workspace: BidWorkspace): Promise<void> {
  await mkdir(workspace.projectRoot, { recursive: true })
  const files = [
    manifestFile('TENDER', 'tender'), manifestFile('FRAMEWORK', 'outline_framework'),
    manifestFile('REFERENCE', 'reference'), manifestFile('REFERENCE-BID', 'reference_bid'),
  ]
  await writeFile(workspace.manifestPath, `${JSON.stringify({ version: 4, files })}\n`)
  for (const file of files) {
    await mkdir(join(workspace.projectRoot, file.chunksPath), { recursive: true })
    await writeFile(join(workspace.projectRoot, file.chunkIndexPath), `${JSON.stringify(chunkIndex)}\n`)
    await writeFile(join(workspace.projectRoot, file.chunksPath, 'chunk_0001.md'), `${file.role} 正文\n`)
  }
  const snapshot = '公开技术资料\n'
  const sourceId = 'WEB-aaaaaaaaaaaaaaaa'
  await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
  await writeFile(join(workspace.projectRoot, `analysis/web-sources/${sourceId}.md`), snapshot)
  await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
    schema_version: 2,
    stage: 'evidence_mapping',
    sources: [{
      source_id: sourceId,

      requested_url: 'https://example.com/standard',
      final_url: 'https://example.com/standard', status_code: 200, truncated: false, fetched_at: fetchedAt,
      content_sha256: webEvidenceContentSha256(snapshot), snapshot_path: `analysis/web-sources/${sourceId}.md`,
    }],
  })}\n`)
}

function candidateFrom(request: SubagentStartRequest, valid = true, withWebEvidence = false) {
  if (promptText(request).includes('Writer Candidate：')) return reviewFrom(request)
  const line = promptText(request).split('\n').find(value => value.startsWith('Current Chapter Blueprint：'))
  if (line === undefined) throw new Error('missing blueprint')
  const section = JSON.parse(line.slice('Current Chapter Blueprint：'.length)) as {
    id: string
    must_answer: string[]
    scoring_response_point_ids: string[]
    scoring_response_points: Array<{ scoring_id: string; response_point: string }>
  }
  return {
    section_id: section.id,
    markdown: `# ${section.id}\n\n正文`,
    metadata: {
      section_id: section.id,
      covered_must_answer: valid ? section.must_answer : [],
      covered_scoring_response_point_ids: section.scoring_response_point_ids,
      covered_scoring_response_points: section.scoring_response_points,
      local_materials_used: [], web_materials_used: [],
      additional_web_materials: withWebEvidence ? [{
        url: fetchedUrl, usage: 'reference', summary: '官方正文摘要', supports: '公开技术要求',
      }] : [],
      unresolved_topics: [],
      handoff: emptyHandoff(section.id),
    },
  }
}

function reviewFrom(request: SubagentStartRequest) {
  const lines = promptText(request).split('\n')
  const candidateLine = lines.find(line => line.startsWith('Writer Candidate：'))
  const blueprintLine = lines.find(line => line.startsWith('Current Chapter Blueprint：'))
  if (candidateLine === undefined || blueprintLine === undefined) throw new Error('missing reviewer context')
  const section = JSON.parse(blueprintLine.slice('Current Chapter Blueprint：'.length)) as { id: string; must_answer: string[]; requirement_ids: string[]; scoring_response_point_ids: string[]; compliance_ids: string[] }
  const candidate = JSON.parse(candidateLine.slice('Writer Candidate：'.length)) as { markdown: string }
  const quoteOptionsLine = lines.find(line => line.startsWith('Quote Options：'))!
  const quoteOptions = JSON.parse(quoteOptionsLine.slice('Quote Options：'.length)) as Record<string, string>
  const quote = Object.entries(quoteOptions).find(([, text]) => candidate.markdown.includes(text) && !text.startsWith('#'))![0]
  const coverage = (item: string) => ({ item, status: 'covered' as const, evidence_quotes: [quote], issue: null })
  return {
    schema_version: 2 as const, section_id: section.id, verdict: 'pass' as const,
    must_answer_coverage: section.must_answer.map(coverage),
    requirement_coverage: section.requirement_ids.map(requirement_id => ({ requirement_id, ...coverage(requirement_id) })),
    response_point_coverage: section.scoring_response_point_ids.map(response_point_id => (
      { response_point_id, ...coverage(response_point_id) }
    )),
    compliance_coverage: section.compliance_ids.map(compliance_id => ({ compliance_id, ...coverage(compliance_id) })),
    claim_checks: [],
    quality_checks: {
      project_specific: true, structure_complete: true,
      legacy_project_pollution_free: true, placeholder_free: true, obvious_repetition_free: true,
    },
    blocking_issues: [],
  }
}

interface DeferredRun {
  readonly request: SubagentStartRequest
  readonly run: SubagentRun
  resolve(): void
}

function fixtureAgent(
  workspace: BidWorkspace,
  outline: ReturnType<typeof outlineFixture>,
  dependencies: Record<string, string[]> = {},
  automatic = true,
  validCandidate: (attempt: number, request: SubagentStartRequest) => boolean = () => true,
  resultForAttempt?: (attempt: number, request: SubagentStartRequest) => SubagentResult,
  webResearch = false,
) {
  let planPending = false
  const followup = vi.fn((_message: unknown) => { planPending = true })
  const starts: DeferredRun[] = []
  let active = 0
  let maxActive = 0
  let attempt = 0
  const disposed: string[] = []
  const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
  const spawnProvider = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
  }
  const subagents = {
    getProvider: vi.fn<(_name: string) => typeof spawnProvider | undefined>(() => spawnProvider),
    start: vi.fn(async (_name: string, request: SubagentStartRequest): Promise<SubagentRun> => {
      resolveChildDepth(request.parent, request.maxDepth)
      if (request.outputSchema !== undefined) assertSupportedJsonSchema(request.outputSchema)
      if (request.toolFilter?.allow?.length === 0) {
        const id = SessionId(`reviewer-${++attempt}`)
        const localAgent = { id, session: { id, header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' }, events: [] } } as unknown as Agent
        return { id, localAgent, result: Promise.resolve({ stopReason: 'completed', output: [], structured: reviewFrom(request) }), dispose: async () => { disposed.push(String(id)) } }
      }
      active++
      maxActive = Math.max(maxActive, active)
      const currentAttempt = ++attempt
      const id = SessionId(`child-${currentAttempt}`)
      const localAgent = {
        id,
        ctx: { tools },
        session: { id, header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' }, events: [] as unknown[] },
      } as unknown as Agent
      listeners.get('agent/created')?.({ agent: localAgent })
      let settle!: () => void
      let settled = false
      const result = new Promise<SubagentResult>((resolve) => {
        settle = () => {
          if (settled) return
          settled = true
          active--
          if (webResearch && currentAttempt === 1) {
            const searchResult = {
              content: [{ type: 'text', text: 'Search result' }], isError: false,
              value: { sources: [{ url: fetchedUrl }], truncated: false },
            }
            const fetchResult = {
              content: [{ type: 'text', text: `Fetched ${fetchedUrl} (HTTP 200)\n\n官方正文` }], isError: false,
              value: { url: fetchedUrl, statusCode: 200, body: { kind: 'text', content: '官方正文' }, truncated: false },
              meta: { truncated: false },
            }
            const listener = listeners.get('tools/result')
            listener?.({ agent: localAgent, name: 'web_search', callId: 'search-1', arguments: { queries: ['官方标准'] } }, searchResult)
            listener?.({ agent: localAgent, name: 'web_fetch', callId: 'fetch-1', arguments: { url: fetchedUrl } }, fetchResult)
          }
          resolve(resultForAttempt?.(currentAttempt, request)
            ?? { stopReason: 'completed', output: [], structured: candidateFrom(request, validCandidate(currentAttempt, request), webResearch && currentAttempt === 1) })
        }
        request.signal.addEventListener('abort', () => {
          if (settled) return
          settled = true
          active--
          resolve({ stopReason: 'aborted', output: [] })
        }, { once: true })
      })
      const deferred: DeferredRun = {
        request,
        run: { id, localAgent, result, dispose: async () => { disposed.push(String(id)) } },
        resolve: settle,
      }
      starts.push(deferred)
      if (automatic) queueMicrotask(() => { deferred.resolve() })
      return deferred.run
    }),
  }
  const tools = {
    schemas: vi.fn(() => ['grep', 'read', 'write', 'web_search', 'web_fetch'].map(name => ({ name }))),
    restrict: vi.fn(() => () => {}),
    guard: vi.fn((guard: (execution: Readonly<ToolExecution>) => string | undefined) => {
      guards.push(guard)
      return () => {}
    }),
  }
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const agent = {
    id: 'parent',
    options: {},
    session: { header: { cwd: workspace.root }, events: [] },
    ctx: {
      get: (name: string) => name === 'tools' ? tools : name === 'subagents' ? subagents : undefined,
      on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); return () => listeners.delete(name) },
    },
    followup,
    whenIdle: vi.fn(async () => {
      if (!planPending) return
      planPending = false
      await writeFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), `${JSON.stringify({
        schema_version: 2,
        scope: 'technical_bid',
        confirmed_outline_sha256: outlineArtifactSha256(outline),
        global_consistency_notes: ['统一术语。'],
        sections: outline.sections.filter(section => section.writable).map(section => ({
          section_id: section.id,
          depends_on: (dependencies[section.id] ?? []).map(section_id => ({ section_id, reason: '复用前置章节结论。' })),
          related_sections: [],
          planning_notes: [],
        })),
      })}\n`)
    }),
  } as unknown as Agent
  return { agent, followup, starts, subagents, tools, guards, disposed, maxActive: () => maxActive }
}

describe('chapter-writing executor', () => {
  it('审查错误宣称通过时仍按实际内容缺口修订，保留问题并继续其他章节', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-review-verdict-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) => ({
      stopReason: 'completed', output: [], structured: {
        ...candidateFrom(request), markdown: '# 实施方案\n\n正文内容\n\n按项目技术要求组织实施、执行质量复核并交付完整成果。',
      },
    }))
    const start = fixture.subagents.start.getMockImplementation()!
    fixture.subagents.start.mockImplementation(async (provider, request) => {
      const run = await start(provider, request)
      if (request.toolFilter?.allow?.length !== 0) return run
      const review = reviewFrom(request)
      return { ...run, result: Promise.resolve({ stopReason: 'completed', output: [], structured: {
        ...review, must_answer_coverage: review.must_answer_coverage.map(item => ({ ...item, status: 'missing', evidence_quotes: [], issue: '缺少具体措施' })),
      } }) }
    })
    const artifacts = await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })
    expect(artifacts).toHaveLength(3)
    await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
    expect(fixture.starts).toHaveLength(6)
    const review = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')) as {
      verdict: string
      requirement_coverage: Array<{ evidence_quotes: string[] }>
      blocking_issues: string[]
    }
    expect(review.verdict).toBe('repair')
    expect(review.requirement_coverage[0]?.evidence_quotes).toEqual(['正文内容'])
    expect(review.blocking_issues.join('；')).toContain('未覆盖：回答1')
    expect(promptText(fixture.starts[1]!.request)).toContain('未覆盖：回答1')
  })

  it('结构化提交只接受实际资料身份、允许用法与正文原文引句', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-material-schema-')))
    const outline = await writeInputs(workspace)
    await seedReadableMaterials(workspace)
    const fixture = fixtureAgent(workspace, outline)
    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })
    const request = fixture.starts[0]!.request
    const schema = request.outputSchema!
    const candidate = candidateFrom(request)
    if (!('metadata' in candidate)) throw new Error('Expected writer candidate')
    const validateMaterial = (source_kind: string, file_id: string, usage: string) => validateJsonSchemaValue(schema, {
      ...candidate,
      metadata: { ...candidate.metadata, local_materials_used: [{ source_kind, file_id, usage, chunk: 'chunk_0001', summary: '资料依据' }] },
    })
    expect(validateMaterial('reference', 'REFERENCE', 'reference')).toEqual([])
    expect(validateMaterial('reference_bid', 'REFERENCE-BID', 'adapt')).toEqual([])
    expect(validateMaterial('reference_bid', 'REFERENCE-BI', 'adapt')).not.toEqual([])
    expect(validateMaterial('reference', 'FRAMEWORK', 'reference')).not.toEqual([])
    expect(validateMaterial('reference', 'REFERENCE-BID', 'reference')).not.toEqual([])
    expect(validateMaterial('reference', 'REFERENCE', 'adapt')).not.toEqual([])
    const reviewRequest = fixture.subagents.start.mock.calls.find(([, request]) => request.toolFilter?.allow?.length === 0)![1]
    const review = reviewFrom(reviewRequest)
    expect(validateJsonSchemaValue(reviewRequest.outputSchema!, review)).toEqual([])
    for (const quote of ['“正文”', '正', '正文。']) {
      expect(validateJsonSchemaValue(reviewRequest.outputSchema!, {
        ...review,
        must_answer_coverage: review.must_answer_coverage.map(item => ({ ...item, evidence_quotes: [quote] })),
      })).not.toEqual([])
      expect(validateJsonSchemaValue(reviewRequest.outputSchema!, {
        ...review,
        claim_checks: [{ claim_quote: quote, kind: 'project_fact', status: 'unsupported', source_reference: null, issue: '无依据' }],
      })).not.toEqual([])
    }
  })

  it('keeps the last reviewed candidate when its content repair hits repeated transport errors', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-fallback-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) =>
      request.label?.includes('修复 1') === true
        ? { stopReason: 'error', output: [], diagnostic: 'LLM turn failed (PI_AI_ERROR).' }
        : { stopReason: 'completed', output: [], structured: {
          ...candidateFrom(request),
          markdown: `${(() => {
            const candidate = candidateFrom(request)
            if (!('markdown' in candidate)) throw new Error('expected writer candidate')
            return candidate.markdown.split('\n')[0]
          })()}\n\n完整实施措施与质量控制。`,
        } })
    const start = fixture.subagents.start.getMockImplementation()!
    fixture.subagents.start.mockImplementation(async (provider, request) => {
      const run = await start(provider, request)
      if (request.toolFilter?.allow?.length !== 0 || !request.label?.endsWith('章节1')) return run
      const review = reviewFrom(request)
      return { ...run, result: Promise.resolve({ stopReason: 'completed', output: [], structured: {
        ...review,
        verdict: 'repair',
        blocking_issues: ['缺少真实设备数量，保留待核实项。'],
      } }) }
    })

    const artifacts = await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1,
      maxConcurrency: 1,
    })

    await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections[0]).toMatchObject({ status: 'completed', final_writer_child_session_id: 'child-1' })
    expect(log.sections[0]?.attempts.filter(attempt => attempt.role === 'writer').map(attempt => attempt.stop_reason))
      .toEqual(['completed', 'error', 'error'])
    const review = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')) as { verdict: string }
    expect(review.verdict).toBe('repair')
  })

  it.each([false, true])('审查引用必须逐字匹配正文，持续无效=%s', async (alwaysInvalid) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-review-repair-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    const start = fixture.subagents.start.getMockImplementation()!
    let reviewCount = 0
    fixture.subagents.start.mockImplementation(async (provider, request) => {
      const run = await start(provider, request)
      if (request.toolFilter?.allow?.length !== 0) return run
      if (reviewCount++ > 0 && !alwaysInvalid) return run
      const review = reviewFrom(request)
      return { ...run, result: Promise.resolve({ stopReason: 'completed', output: [], structured: {
        ...review, must_answer_coverage: review.must_answer_coverage.map(item => ({ ...item, evidence_quotes: ['“正文”'] })),
      } }) }
    })
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })
    if (alwaysInvalid) {
      await expect(execution).rejects.toThrow('CHAPTER_REVIEW_QUOTE_INVALID')
      await expect(readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(execution).resolves.toHaveLength(3)
      expect(fixture.starts).toHaveLength(3)
      const repair = fixture.subagents.start.mock.calls.find(call => promptText(call[1]).includes('修复审查报告的字段或原文引用'))
      expect(repair).toBeDefined()
      expect(promptText(repair![1])).toContain('CHAPTER_REVIEW_QUOTE_INVALID')
      expect(promptText(repair![1])).toContain('Project：')
    }
  })

  it('旧版计划收到字段级修复说明，通过校验后才启动章节写作', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-plan-repair-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true)
    const writePlan = vi.mocked(fixture.agent.whenIdle).getMockImplementation()!
    vi.spyOn(fixture.agent, 'whenIdle').mockImplementation(async () => {
      await writePlan()
      if (fixture.followup.mock.calls.length !== 1) return
      const path = join(workspace.projectRoot, 'chapters/execution-plan.json')
      const plan = JSON.parse(await readFile(path, 'utf8')) as {
        schema_version: number
        sections: Array<{ depends_on?: string[]; planning_notes?: unknown }>
      }
      const secondSection = plan.sections[1]
      if (secondSection === undefined) throw new Error('missing second chapter plan section')
      plan.schema_version = 1
      secondSection.depends_on = ['SEC-1']
      delete secondSection.planning_notes
      await writeFile(path, JSON.stringify(plan))
      expect(fixture.starts).toHaveLength(0)
    })

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    expect(fixture.followup).toHaveBeenCalledTimes(2)
    const repair = JSON.stringify(fixture.followup.mock.calls[1]?.[0])
    expect(repair).toContain('字段=schema_version')
    expect(repair).toContain('字段=sections.1.depends_on.0')
    expect(repair).toContain('字段=sections.1.planning_notes')
    expect(repair).toContain('reason')
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters).toHaveLength(3)
  })

  it('uses the current execution-plan schema version in the planning prompt', async () => {
    const outline = outlineFixture()
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-plan-prompt-')))
    const prompt = renderChapterExecutionPlanTask(
      { id: 'parent' } as unknown as Agent,
      workspace,
      outline,
      outlineArtifactSha256(outline),
      {
        project: parseTenderProjectArtifact({
          schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null,
          project_background: [], project_objectives: [], project_scope: [], technical_scope: [], delivery_scope: [],
          implementation_constraints: [], key_technical_points: [], source_refs: source, analyzed_tender_files: ['tender'],
        }),
        requirements: parseTenderRequirementsArtifact({ schema_version: 1, requirements: [] }),
        scoring: parseTenderScoringArtifact({ schema_version: 1, scoring_items: [] }),
        compliance: parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [] }),
      },
    )
    expect(prompt).toContain(`\"schema_version\":${String(CHAPTER_EXECUTION_SCHEMA_VERSION)}`)
  })

  it('allows the S6 capability union while keeping bash forbidden', () => {
    const policy = getBidStagePolicy('chapter_writing')
    expect(policy.allowedTools).toEqual(['grep', 'read', 'write', 'web_search', 'web_fetch'])
    expect(policy.forbiddenTools).toEqual(['bash'])
    expect(policy.requiredInputs).toContain('analysis/web-evidence-sources.json')
    expect(policy.requiredArtifacts).toEqual(['chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json'])
  })

  it('classifies reference, reference-bid, and Web materials without source-section abstractions', () => {
    const scoring = parseTenderScoringArtifact({
      schema_version: 1,
      scoring_items: [{
        id: 'SCORE-1', parent: null, group: null, title: '评分', raw_text: '评分', criterion: '评分', score: 1,
        score_range: null, must_answer: true, source_refs: source,
      }],
    })
    const context = pickChapterContext({
      section: outlineFixture().sections[1]!,
      sequence: 1,
      project: parseTenderProjectArtifact({
        schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null,
        project_background: [], project_objectives: [], project_scope: [], technical_scope: [], delivery_scope: [],
        implementation_constraints: [], key_technical_points: [], source_refs: source, analyzed_tender_files: ['tender'],
      }),
      requirements: parseTenderRequirementsArtifact({
        schema_version: 1,
        requirements: [{ id: 'REQ-1', category: '技术', raw_text: '要求', normalized_requirement: '要求', mandatory: true, source_refs: source }],
      }),
      scoring,
      compliance: parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [] }),
      evidence: parseEvidenceMapArtifact({
        schema_version: 10,
        section_mappings: [{
          section_id: 'SEC-1',

          local_materials: [
            { source_kind: 'reference', file_id: 'REFERENCE', chunk: 'chunk_0001', usage: 'reference', summary: '项目资料' },
            { source_kind: 'reference_bid', file_id: 'REFERENCE-BID', chunk: 'chunk_0001', usage: 'adapt', summary: '旧标书方案' },
          ],
          web_materials: [{ source_id: 'WEB-aaaaaaaaaaaaaaaa', snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md', usage: 'reference', summary: '公开资料', supports: '评分响应' }],
          missing_topics: [], writing_dimensions: ['需求维度', '评分维度'],
        }],
      }),
      responsePointCatalog: createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [{ scoring_id: 'SCORE-1', order: 1, text: '回答评分1' }] }).points,
      globalComplianceIds: [],
    })

    expect(context.relatedMaterials.map(material => material.file_id)).toEqual(['REFERENCE'])
    expect(context.referenceBidMaterials.map(material => material.file_id)).toEqual(['REFERENCE-BID'])
    expect(context.webMaterials.map(material => material.source_id)).toEqual(['WEB-aaaaaaaaaaaaaaaa'])
    expect(context.writingDimensions).toEqual(['需求维度', '评分维度'])
  })

  it('allows reference and framework draft chunks plus ledger Web snapshots', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-read-guard-')))
    const outline = await writeInputs(workspace)
    await seedReadableMaterials(workspace)
    const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as {
      section_mappings: Array<{ local_materials: unknown[]; web_materials: unknown[] }>
    }
    evidence.section_mappings[0]!.local_materials = [
      { source_kind: 'reference', file_id: 'REFERENCE', chunk: 'chunk_0001', usage: 'reference', summary: '项目资料' },
      { source_kind: 'reference_bid', file_id: 'REFERENCE-BID', chunk: 'chunk_0001', usage: 'adapt', summary: '旧标书方案' },
    ]
    evidence.section_mappings[0]!.web_materials = [{
      source_id: 'WEB-aaaaaaaaaaaaaaaa', snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md',
      usage: 'reference', summary: '公开资料', supports: '章节方法',
    }]
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`)
    const fixture = fixtureAgent(workspace, outline)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 1,
    })

    const firstWriter = fixture.subagents.start.mock.calls.find(call => call[1].toolFilter?.allow?.length !== 0
      && promptText(call[1]).includes('"id":"SEC-1"'))
    expect(firstWriter).toBeDefined()
    const prompt = promptText(firstWriter![1])
    expect(prompt).toContain('corpus/reference/chunks/chunk_0001.md')
    expect(prompt).toContain('corpus/reference/chunks/index.json')
    expect(prompt).toContain('corpus/reference_bid/chunks/chunk_0001.md')
    expect(prompt).toContain('analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md')

    const guard = fixture.guards.at(-1)
    expect(guard).toBeDefined()
    const guarded = (name: 'read' | 'grep', argument: 'file_path' | 'path', path: string): string | undefined => guard!({
      name,
      arguments: { [argument]: path },
      agent: { session: { id: SessionId('guard-child'), header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' } } },
    } as unknown as ToolExecution)
    const sessionPath = (path: string): string => join(workspace.projectRoot, ...path.split('/'))
    expect(guarded('read', 'file_path', sessionPath('corpus/reference/chunks/chunk_0001.md'))).toBeUndefined()
    expect(guarded('grep', 'path', sessionPath('corpus/reference/chunks'))).toBeUndefined()
    expect(guarded('grep', 'path', sessionPath('corpus/reference/chunks/index.json'))).toBeUndefined()
    expect(guarded('read', 'file_path', sessionPath('corpus/reference_bid/chunks/chunk_0001.md'))).toBeUndefined()
    expect(guarded('grep', 'path', sessionPath('corpus/reference_bid/chunks/index.json'))).toBeUndefined()
    expect(guarded('read', 'file_path', sessionPath('analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md'))).toBeUndefined()
    expect(guarded('read', 'file_path', sessionPath('corpus/tender/chunks/chunk_0001.md'))).toContain('不可读取')
    expect(guarded('read', 'file_path', sessionPath('corpus/outline_framework/chunks/chunk_0001.md'))).toBeUndefined()
    expect(guarded('grep', 'path', sessionPath('corpus/outline_framework/chunks'))).toBeUndefined()
    expect(guarded('read', 'file_path', sessionPath('corpus/reference/chunks'))).toContain('不可读取')
    expect(guarded('grep', 'path', sessionPath('corpus/tender/chunks'))).toContain('不可读取')
    expect(guarded('grep', 'path', sessionPath('corpus'))).toContain('只可检索')
    expect(guarded('read', 'file_path', sessionPath('analysis/web-sources/WEB-bbbbbbbbbbbbbbbb.md'))).toContain('账本')
  })

  it('未映射资料的定位支持当前章节补搜，实际引用写入 metadata 且不改 S4', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-local-supplement-')))
    const outline = await writeInputs(workspace)
    await seedReadableMaterials(workspace)
    const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const evidenceBefore = await readFile(evidencePath, 'utf8')
    const fixture = fixtureAgent(workspace, outline)
    const start = fixture.subagents.start.getMockImplementation()!
    fixture.subagents.start.mockImplementation(async (provider, request) => {
      if (request.toolFilter?.allow?.length === 0) return start(provider, request)
      const lines = promptText(request).split('\n')
      const corpus = JSON.parse(lines.find(line => line.startsWith('Available Local Corpus：'))!.slice('Available Local Corpus：'.length)) as Array<{
        file_id: string
        role: string
        chunks_path: string
        chunk_index_path: string
      }>
      expect(corpus.map(file => file.role)).toEqual(['outline_framework', 'reference', 'reference_bid'])
      const snapshots = JSON.parse(lines.find(line => line.startsWith('Web Snapshot Read Locations：'))!.slice('Web Snapshot Read Locations：'.length)) as Array<{ source_id: string; read_path: string }>
      expect(snapshots[0]?.source_id).toBe('WEB-aaaaaaaaaaaaaaaa')
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      if (candidate.section_id !== 'SEC-1') return start(provider, request)
      expect(lines).toContain('Related Materials：[]')
      const file = corpus.find(item => item.file_id === 'REFERENCE')!
      const guard = fixture.guards.at(-1)!
      const allowed = (name: 'grep' | 'read', path: string) => guard({
        name, arguments: { [name === 'grep' ? 'path' : 'file_path']: path },
        agent: { session: { header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' } } },
      } as unknown as ToolExecution)
      expect(allowed('grep', file.chunks_path)).toBeUndefined()
      const chunkPath = join(file.chunks_path, 'chunk_0001.md')
      expect(allowed('read', chunkPath)).toBeUndefined()
      const text = (await readFile(chunkPath, 'utf8')).trim()
      const run = await start(provider, request)
      return { ...run, result: run.result.then(result => ({ ...result, structured: {
        ...candidate, markdown: `# 当前章节\n\n结合 ${text}，说明本项目实施流程与质量控制要求。`,
        metadata: { ...candidate.metadata, local_materials_used: [{
          file_id: file.file_id, source_kind: file.role, chunk: 'chunk_0001', usage: 'reference', summary: '支撑本章实施流程与质量控制要求。',
        }] },
      } })) }
    })

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1 })

    const metadata = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), 'utf8'))
    expect(metadata.local_materials_used).toEqual([{ file_id: 'REFERENCE', source_kind: 'reference', chunk: 'chunk_0001', usage: 'reference', summary: '支撑本章实施流程与质量控制要求。' }])
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toContain('reference 正文')
    expect(await readFile(evidencePath, 'utf8')).toBe(evidenceBefore)
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters.slice(1).every(chapter => chapter.local_materials_used.length === 0)).toBe(true)
  })

  it('resolves the exact referenced framework body for the chapter writer', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-framework-draft-')))
    await seedReadableMaterials(workspace)

    const materials = await resolveFrameworkDraftMaterials(workspace, [{
      file_id: 'FRAMEWORK',
      heading_path: ['章节'],
    }])

    expect(materials).toHaveLength(1)
    expect(materials[0]).toMatchObject({ file_id: 'FRAMEWORK', chunk: 'chunk_0001', heading_path: ['章节'] })
    await expect(readFile(materials[0]!.chunk_path, 'utf8')).resolves.toContain('outline_framework 正文')
  })

  it('accepts any Web material whose ledger snapshot and hash are real', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-ledger-material-')))
    await seedReadableMaterials(workspace)
    const section = outlineFixture().sections[1]!
    const candidate: ChapterCandidate = {
      section_id: section.id,
      markdown: '# 章节\n\n正文内容',
      metadata: {
        section_id: section.id,
        covered_must_answer: section.must_answer,
        covered_scoring_response_point_ids: section.scoring_response_point_ids ?? [],
        covered_scoring_response_points: section.scoring_response_points,
        local_materials_used: [],
        web_materials_used: [{
          source_id: 'WEB-aaaaaaaaaaaaaaaa',
          snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md',
          usage: 'reference',
          summary: '公开资料',
          supports: '章节方法',
        }],
        additional_web_materials: [],
        unresolved_topics: [],
        handoff: emptyHandoff(section.id),
      },
    }

    await expect(validateChapterCandidate(workspace, emptyChapterContext(section), candidate, [])).resolves.toEqual([])
  })

  it('overlaps independent spawn children and unlocks a strong dependency only after acceptance', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, { 'SEC-3': ['SEC-1'] }, false)
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    expect(fixture.maxActive()).toBe(2)
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.followup).toHaveBeenCalledOnce()
    expect(fixture.tools.restrict).toHaveBeenCalledWith({ allow: ['read', 'write'] })
    const planningPrompt = JSON.stringify(fixture.followup.mock.calls[0]?.[0])
    expect(planningPrompt).toContain('Relation Planning')
    expect(planningPrompt).not.toContain('source_refs')
    expect(planningPrompt).not.toContain('analyzed_tender_files')
    expect(planningPrompt).not.toContain('corpus/tender')
    expect(fixture.starts.map(item => promptText(item.request))).toEqual([
      expect.stringContaining('"id":"SEC-1"'),
      expect.stringContaining('"id":"SEC-2"'),
    ])
    for (const prompt of fixture.starts.map(item => promptText(item.request))) {
      expect(prompt).not.toContain('source_refs')
      expect(prompt).not.toContain('analyzed_tender_files')
      expect(prompt).not.toContain('corpus/tender')
      expect(prompt).toContain('Related Materials：')
      expect(prompt).toContain('Reference Bid Materials：')
      expect(prompt).toContain('Web Materials：')
      expect(prompt).toContain('Writing Dimensions：')
    }
    fixture.starts[0]!.resolve()
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(3) })
    const dependentPrompt = promptText(fixture.starts[2]!.request)
    expect(dependentPrompt).toContain('"section_id":"SEC-1"')
    expect(dependentPrompt).not.toContain('# SEC-1')
    expect(dependentPrompt).not.toContain('# SEC-2')
    fixture.starts[1]!.resolve()
    fixture.starts[2]!.resolve()

    await expect(execution).resolves.toEqual([
      { stage: 'chapter_writing', type: 'chapter_execution_plan', path: 'chapters/execution-plan.json' },
      { stage: 'chapter_writing', type: 'chapter_execution_log', path: 'chapters/execution-log.json' },
      { stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' },
    ])
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters.map(chapter => chapter.section_id)).toEqual(['SEC-1', 'SEC-2', 'SEC-3'])
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections.every(section => section.status === 'completed'
      && section.final_writer_child_session_id !== null && section.final_reviewer_child_session_id !== null)).toBe(true)
    expect(fixture.subagents.start).toHaveBeenCalledTimes(6)
    expect(fixture.subagents.start.mock.calls.every(call => call[0] === 'spawn')).toBe(true)
    const writerCalls = fixture.subagents.start.mock.calls.filter(call => call[1].toolFilter?.allow?.length !== 0)
    for (const [index, call] of writerCalls.entries()) {
      expect(call[1]).toMatchObject({ maxDepth: 1, toolFilter: { allow: ['grep', 'read', 'web_search', 'web_fetch'] } })
      expect(call[1].parent).toBe(fixture.agent)
      expect(call[1].label).toContain(`000${index + 1}`)
      expect(fixture.starts[index]?.run.localAgent?.session.header).toMatchObject({ parentSession: 'parent', origin: 'subagent' })
    }
    const reviewerCalls = fixture.subagents.start.mock.calls.filter(call => call[1].toolFilter?.allow?.length === 0)
    expect(reviewerCalls).toHaveLength(3)
    expect(reviewerCalls.every(call => call[1].maxDepth === 1)).toBe(true)
    expect(promptText(writerCalls[0]![1])).toContain('不得添加带“示例”的伪数据行')
    expect(promptText(reviewerCalls[0]![1])).toContain('不得要求 Writer 虚构数据或添加示例记录')
    expect(new Set(fixture.starts.map(item => item.run.id)).size).toBe(3)
    expect(fixture.disposed).toHaveLength(6)
  })

  it('S5 空 Evidence 章节可写作和补搜，成功 fetch 不依赖事件日志', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-web-ledger-')))
    const outline = await writeInputs(workspace)
    await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
      schema_version: 2, stage: 'evidence_mapping', sources: [],
    })}\n`)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, undefined, true)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 1,
    })

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(
      await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8'),
    ))
    expect(ledger.sources).toHaveLength(1)
    expect(ledger.sources[0]).toMatchObject({

      chapter_context: { section_id: 'SEC-1', child_session_id: 'child-1', writer_attempt: 1 },
    })
    expect(await readFile(join(workspace.projectRoot, ledger.sources[0]!.snapshot_path), 'utf8')).toContain('官方正文')
    const manifest = parseChapterWritingManifest(JSON.parse(
      await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8'),
    ))
    expect(manifest.chapters[0]?.web_materials_used).toEqual([{
      source_id: ledger.sources[0]?.source_id,
      snapshot_path: ledger.sources[0]?.snapshot_path,
      usage: 'reference',
      summary: '官方正文摘要',
      supports: '公开技术要求',
    }])
    expect(JSON.stringify(manifest.chapters[0])).not.toContain(fetchedUrl)
    expect(manifest.chapters.slice(1).every(chapter => chapter.web_materials_used.length === 0)).toBe(true)
  })

  it('fails before Main-Agent planning when the spawn provider is absent', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-provider-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.subagents.getProvider.mockReturnValue(undefined)
    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing')))
      .rejects.toThrow('requires a fresh-context spawn subagent provider')
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it('fails before Main-Agent planning when spawn cannot enforce the Child policy', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-capability-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.subagents.getProvider.mockReturnValue({
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: false, persona: true },
      inheritsParentContext: false,
    })

    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing')))
      .rejects.toThrow('requires spawn output-schema, depth-limit, tool-filter, and persona capabilities')
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it('binds confirmed-outline coverage fields instead of repairing model punctuation', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-repair-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, attempt => attempt !== 1)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })

    expect(fixture.starts).toHaveLength(3)
    expect(fixture.starts.every(item => !item.request.label?.includes('修复'))).toBe(true)
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections[0]?.attempts.map(attempt => attempt.accepted)).toEqual([true, true])
    const metadata = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), 'utf8'))
    expect(metadata.covered_must_answer).toEqual(outline.sections.find(section => section.id === 'SEC-1')?.must_answer)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toContain('# SEC-1')
  })

  it('keeps scheduling an unrelated ready section while another branch is repairing', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-repair-wave-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, false, () => true, (attempt, request) => {
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      return {
        stopReason: 'completed', output: [], structured: attempt === 1
          ? { ...candidate, metadata: { ...candidate.metadata, handoff: emptyHandoff('OTHER') } }
          : candidate,
      }
    })
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts[0]!.resolve()
    await vi.waitFor(() => { expect(fixture.starts[2]?.request.label).toContain('修复 1') })
    fixture.starts[1]!.resolve()
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(4) })
    expect(promptText(fixture.starts[3]!.request)).toContain('"id":"SEC-3"')
    expect(fixture.maxActive()).toBe(2)
    fixture.starts[2]!.resolve()
    fixture.starts[3]!.resolve()
    await expect(execution).resolves.toHaveLength(3)
  })

  it.each([
    ['non-completed stop reason', (): SubagentResult => ({ stopReason: 'error', output: [], diagnostic: '模型服务没有可用认证。' }), 'CHAPTER_SUBAGENT_STOP_REASON_INVALID'],
    ['missing structured result', (): SubagentResult => ({ stopReason: 'completed', output: [] }), 'CHAPTER_SUBAGENT_STRUCTURED_MISSING'],
    ['schema-invalid candidate', (request: SubagentStartRequest): SubagentResult => {
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      return { stopReason: 'completed', output: [], structured: { section_id: candidate.section_id, metadata: candidate.metadata } }
    }, 'CHAPTER_SUBAGENT_CANDIDATE_INVALID'],
    ['reference material marked as adapted', (request: SubagentStartRequest): SubagentResult => {
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      return { stopReason: 'completed', output: [], structured: {
        ...candidate,
        metadata: { ...candidate.metadata, local_materials_used: [{ source_kind: 'reference', file_id: 'REFERENCE', chunk: 'chunk_0001', usage: 'adapt', summary: '公开背景资料。' }] },
      } }
    }, 'CHAPTER_SUBAGENT_CANDIDATE_INVALID'],
  ])('repairs a %s in a new Child', async (_name, firstResult, issueCode) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-result-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (attempt, request) =>
      attempt === 1 ? firstResult(request) : { stopReason: 'completed', output: [], structured: candidateFrom(request) })

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1,
      maxConcurrency: 1,
    })

    if (_name === 'non-completed stop reason') {
      expect(fixture.starts[1]?.request.label).toContain('运行重试 1')
      expect(promptText(fixture.starts[1]!.request)).not.toContain(issueCode)
    } else {
      expect(fixture.starts[1]?.request.label).toContain('修复 1')
      expect(promptText(fixture.starts[1]!.request)).toContain(issueCode)
    }
    if (_name === 'reference material marked as adapted') {
      expect(promptText(fixture.starts[1]!.request)).toContain('字段=metadata.local_materials_used.0.usage')
      expect(promptText(fixture.starts[1]!.request)).toContain('reference material usage must be reference or background')
    }
    expect(fixture.disposed).toHaveLength(7)
  })

  it('lets unrelated chapters finish before reporting one exhausted branch', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-failure-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, false, () => true, (_attempt, request) =>
      request.label?.endsWith('章节1') === true
        ? { stopReason: 'error', output: [], diagnostic: 'LLM turn failed (PI_AI_ERROR).' }
        : { stopReason: 'completed', output: [], structured: candidateFrom(request) })
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts[0]!.resolve()
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(3) })
    fixture.starts[1]!.resolve()
    fixture.starts[2]!.resolve()
    await expect(execution).rejects.toThrow('SEC-1')
    expect(fixture.disposed).toContain('child-1')
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections.map(section => section.status)).toEqual(['failed', 'completed', 'completed'])
    await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.followup).toHaveBeenCalledOnce()
  })

  it('fails S6 without a manifest when Child startup fails', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-start-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.subagents.start.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 1,
    })).rejects.toThrow('infrastructure failed for SEC-1')
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections[0]).toMatchObject({ section_id: 'SEC-1', status: 'failed', attempts: [] })
    await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps unrelated chapter files and replans when no valid checkpoint exists', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-retry-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/stale.md'), 'stale')

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/stale.md'), 'utf8')).resolves.toBe('stale')
    expect(fixture.followup).toHaveBeenCalledOnce()
    expect(fixture.starts).toHaveLength(3)
  })

  it('resumes a validated checkpoint without rewriting completed chapters', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-checkpoint-')))
    const outline = await writeInputs(workspace)
    const first = fixtureAgent(workspace, outline)
    await executeChapterWriting(first.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })
    const completedBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const priorLog = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    const failed = priorLog.sections.find(section => section.section_id === 'SEC-3')!
    failed.status = 'failed'
    failed.final_writer_child_session_id = null
    failed.final_reviewer_child_session_id = null
    await writeFile(logPath, `${JSON.stringify(priorLog)}\n`)

    const resumed = fixtureAgent(workspace, outline)
    await executeChapterWriting(resumed.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    expect(resumed.followup).not.toHaveBeenCalled()
    expect(resumed.starts).toHaveLength(1)
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).resolves.toBe(completedBody)
    const finalLog = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    expect(finalLog.sections.every(section => section.status === 'completed')).toBe(true)
    expect(finalLog.sections[0]?.attempts).toEqual(priorLog.sections[0]?.attempts)
  })

  it('rejects additional Web evidence that belongs to another Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-web-')))
    await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
      schema_version: 2, stage: 'evidence_mapping', sources: [],
    })}\n`)
    const section = outlineFixture().sections[1]!
    const context = emptyChapterContext(section)
    const external = {
      url: 'https://b.example/doc', usage: 'reference' as const, summary: '摘要', supports: '技术说明',
    }
    const candidate: ChapterCandidate = {
      section_id: section.id,
      markdown: '# 章节',
      metadata: {
        section_id: section.id,
        covered_must_answer: section.must_answer,
        covered_scoring_response_point_ids: section.scoring_response_point_ids ?? [],
        covered_scoring_response_points: section.scoring_response_points,
        local_materials_used: [],
        web_materials_used: [],
        additional_web_materials: [external],
        unresolved_topics: [],
        handoff: emptyHandoff(section.id),
      },
    }
    const childASnapshots: WebEvidenceSnapshot[] = [{
      source: {
        source_id: 'WEB-aaaaaaaaaaaaaaaa',

        requested_url: 'https://a.example/doc', final_url: 'https://a.example/doc', status_code: 200, truncated: false,
        fetched_at: fetchedAt, content_sha256: 'a'.repeat(64), snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md',
      },
      content: 'A',
    }]

    expect((await validateChapterCandidate(workspace, context, candidate, childASnapshots)).map(issue => issue.code))
      .toContain('CHAPTER_WRITING_WEB_MATERIAL_UNVERIFIED')
  })
})
