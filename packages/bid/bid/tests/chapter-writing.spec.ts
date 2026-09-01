import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { validateChapterCandidate, type ChapterContext } from '../src/chapter-writing-executor.ts'
import type { ChapterCandidate } from '../src/chapter-writing-artifacts.ts'
import type { EvidenceMappingWebSnapshot } from '../src/evidence-mapping-executor.ts'
import {
  BidWorkspace,
  buildBidStageTask,
  executeChapterWriting,
  getBidStagePolicy,
  outlineArtifactSha256,
  createScoringResponsePointCatalog,
  parseChapterExecutionLog,
  parseChapterWritingManifest,
  parseWebEvidenceSourcesArtifact,
} from '@deepseek-ai/dsh-bid'

const source = [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }]

async function writeInputs(workspace: BidWorkspace): Promise<ReturnType<typeof outlineFixture>> {
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/project.json'), `${JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['交付'], technical_scope: ['技术'], delivery_scope: ['实施'], implementation_constraints: ['周期'], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: ['tender'] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), `${JSON.stringify({ schema_version: 1, requirements: [1, 2, 3].map(index => ({ id: `REQ-${index}`, category: '技术', raw_text: `要求${index}`, normalized_requirement: `响应要求${index}`, mandatory: true, source_refs: source })) })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), `${JSON.stringify({ schema_version: 1, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, response_points: [`回答评分${index}`], source_refs: source })) })}\n`)
  const scoring = { schema_version: 1 as const, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, response_points: [`回答评分${index}`], source_refs: source })) }
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), `${JSON.stringify(createScoringResponsePointCatalog(scoring))}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), `${JSON.stringify({ schema_version: 1, compliance_items: [] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), `${JSON.stringify({ schema_version: 6, source_strategy: { mode: 'generated_from_scratch', framework_file_id: null, reference_bid_file_ids: [] }, framework_mappings: [], reference_bid_mappings: [], research_topics: [], requirement_mappings: [1, 2, 3].map(index => ({ requirement_id: `REQ-${index}`, materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['技术方案'] })), scoring_mappings: [1, 2, 3].map(index => ({ scoring_id: `SCORE-${index}`, materials: [], external_materials: [], missing_topics: [] })), response_point_mappings: [1, 2, 3].map(index => ({ response_point_id: `RP-${String(index).padStart(6, '0')}`, scoring_id: `SCORE-${index}`, response_point: `回答评分${index}`, materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['技术响应'] })) })}\n`)
  const outline = outlineFixture()
  await writeFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`)
  const outlineSha256 = outlineArtifactSha256(outline)
  await writeFile(join(workspace.sessionRoot, 'outline/confirmation.json'), `${JSON.stringify({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineSha256, confirmed_outline_sha256: outlineSha256, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineSha256 })}\n`)
  return outline
}

function outlineFixture() {
  return { schema_version: 2 as const, scope: 'technical_bid' as const, document_title: '技术标', global_compliance_ids: [], sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '目录', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const, content_mode: null, source_mapping_ids: [], scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...[1, 2, 3].map(index => ({ id: `SEC-${index}`, parent_id: 'STRUCT', order: index, level: 2, title: `章节${index}`, purpose: `回答主题${index}`, writable: true, must_answer: [`回答${index}`], requirement_ids: [`REQ-${index}`], scoring_ids: [`SCORE-${index}`], compliance_ids: [], origin: 'generated' as const, content_mode: 'write_new' as const, source_mapping_ids: [], scoring_response_point_ids: [`RP-${String(index).padStart(6, '0')}`], scoring_response_points: [{ scoring_id: `SCORE-${index}`, response_point: `回答评分${index}` }], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
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

const fetchedAt = '2026-09-01T00:00:00.000Z'
const fetchedUrl = 'https://official.example/standard'

function candidateFrom(request: SubagentStartRequest, valid = true, withWebEvidence = false) {
  if (promptText(request).includes('Writer Candidate：')) return reviewFrom(request)
  const line = promptText(request).split('\n').find(value => value.startsWith('Current Chapter Blueprint：'))
  if (line === undefined) throw new Error('missing blueprint')
  const section = JSON.parse(line.slice('Current Chapter Blueprint：'.length)) as {
    id: string
    must_answer: string[]
    scoring_response_point_ids: string[]
    scoring_response_points: Array<{ scoring_id: string; response_point: string }>
    source_mapping_ids: string[]
  }
  return {
    section_id: section.id,
    markdown: `# ${section.id}\n\n正文`,
    metadata: {
      section_id: section.id,
      covered_must_answer: valid ? section.must_answer : [],
      covered_scoring_response_point_ids: section.scoring_response_point_ids,
      covered_scoring_response_points: section.scoring_response_points,
      assigned_source_mapping_ids: section.source_mapping_ids,
      source_mapping_usage: [],
      source_mapping_ids_used: [],
      evidence_used: [], additional_materials: [], external_evidence_used: [],
      additional_external_materials: withWebEvidence ? [{
        title: '官方标准', url: fetchedUrl, publisher: '官方机构', retrieved_at: fetchedAt,
        retrieval_method: 'web_search', usage: 'reference', summary: '官方正文摘要', supports: '公开技术要求',
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
  const section = JSON.parse(blueprintLine.slice('Current Chapter Blueprint：'.length)) as { id: string; must_answer: string[]; requirement_ids: string[]; scoring_response_point_ids: string[]; compliance_ids: string[]; source_mapping_ids: string[] }
  const coverage = (item: string) => ({ item, status: 'covered' as const, evidence_quotes: ['正文'], issue: null })
  return {
    schema_version: 1 as const, section_id: section.id, verdict: 'pass' as const,
    must_answer_coverage: section.must_answer.map(coverage),
    requirement_coverage: section.requirement_ids.map(requirement_id => ({ requirement_id, ...coverage(requirement_id) })),
    response_point_coverage: section.scoring_response_point_ids.map(response_point_id => (
      { response_point_id, ...coverage(response_point_id) }
    )),
    compliance_coverage: section.compliance_ids.map(compliance_id => ({ compliance_id, ...coverage(compliance_id) })),
    source_mapping_review: section.source_mapping_ids.map(mapping_id => ({ mapping_id, status: 'used' as const, evidence_quotes: ['正文'], issue: null })),
    claim_checks: [],
    quality_checks: {
      content_mode_respected: true, project_specific: true, structure_complete: true,
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
  const spawnProvider = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
  }
  const subagents = {
    getProvider: vi.fn<(_name: string) => typeof spawnProvider | undefined>(() => spawnProvider),
    start: vi.fn(async (_name: string, request: SubagentStartRequest): Promise<SubagentRun> => {
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
        session: { id, header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' }, events: [] as unknown[] },
      } as unknown as Agent
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
            ;(localAgent.session.events as unknown[]).push(
              { seq: 1, time: Date.parse(fetchedAt) - 3, type: 'tool/call', data: { callId: 'search-1', name: 'web_search' } },
              { seq: 2, time: Date.parse(fetchedAt) - 2, type: 'tool/result', data: { message: { source: { callId: 'search-1' }, content: [{ isError: false }] } } },
              { seq: 3, time: Date.parse(fetchedAt) - 1, type: 'tool/call', data: { callId: 'fetch-1', name: 'web_fetch' } },
              { seq: 4, time: Date.parse(fetchedAt), type: 'tool/result', data: { message: { source: { callId: 'fetch-1' }, content: [{ isError: false }] } } },
            )
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
    guard: vi.fn(() => () => {}),
  }
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const agent = {
    id: 'parent',
    session: { header: { cwd: workspace.root }, events: [] },
    ctx: {
      get: (name: string) => name === 'tools' ? tools : name === 'subagents' ? subagents : undefined,
      on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); return () => listeners.delete(name) },
    },
    followup,
    whenIdle: vi.fn(async () => {
      if (!planPending) return
      planPending = false
      await writeFile(join(workspace.sessionRoot, 'chapters/execution-plan.json'), `${JSON.stringify({
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
  return { agent, followup, starts, subagents, tools, disposed, maxActive: () => maxActive }
}

describe('chapter-writing executor', () => {
  it('allows the S6 capability union while keeping bash forbidden', () => {
    const policy = getBidStagePolicy('chapter_writing')
    expect(policy.allowedTools).toEqual(['grep', 'read', 'write', 'web_search', 'web_fetch'])
    expect(policy.forbiddenTools).toEqual(['bash'])
    expect(policy.requiredInputs).toContain('analysis/web-evidence-sources.json')
    expect(policy.requiredArtifacts).toEqual(['chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json'])
  })

  it('overlaps independent spawn children and unlocks a strong dependency only after acceptance', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, { 'SEC-3': ['SEC-1'] }, false)
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    expect(fixture.maxActive()).toBe(2)
    await expect(readFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.followup).toHaveBeenCalledOnce()
    expect(fixture.tools.restrict).toHaveBeenCalledWith({ allow: ['read', 'write'] })
    expect(JSON.stringify(fixture.followup.mock.calls[0]?.[0])).toContain('Relation Planning')
    expect(fixture.starts.map(item => promptText(item.request))).toEqual([
      expect.stringContaining('"id":"SEC-1"'),
      expect.stringContaining('"id":"SEC-2"'),
    ])
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
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters.map(chapter => chapter.section_id)).toEqual(['SEC-1', 'SEC-2', 'SEC-3'])
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/execution-log.json'), 'utf8')))
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
    expect(reviewerCalls.every(call => call[1].maxDepth === 0)).toBe(true)
    expect(new Set(fixture.starts.map(item => item.run.id)).size).toBe(3)
    expect(fixture.disposed).toHaveLength(6)
  })

  it('persists a Writer search-to-fetch source without requiring Web for other chapters', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-web-ledger-')), 'session')
    const outline = await writeInputs(workspace)
    await mkdir(join(workspace.sessionRoot, 'analysis/web-sources'), { recursive: true })
    await writeFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
      schema_version: 1, stage: 'evidence_mapping', sources: [],
    })}\n`)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, undefined, true)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 1,
    })

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(
      await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8'),
    ))
    expect(ledger.sources).toHaveLength(1)
    expect(ledger.sources[0]).toMatchObject({
      search_call_id: 'search-1', fetch_call_id: 'fetch-1',
      chapter_context: { section_id: 'SEC-1', child_session_id: 'child-1', writer_attempt: 1 },
    })
    expect(await readFile(join(workspace.sessionRoot, ledger.sources[0]!.snapshot_path), 'utf8')).toContain('官方正文')
    const manifest = parseChapterWritingManifest(JSON.parse(
      await readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8'),
    ))
    expect(manifest.chapters[0]?.additional_external_materials).toHaveLength(1)
    expect(manifest.chapters.slice(1).every(chapter => chapter.additional_external_materials.length === 0)).toBe(true)
  })

  it('fails before Main-Agent planning when the spawn provider is absent', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-provider-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.subagents.getProvider.mockReturnValue(undefined)
    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing')))
      .rejects.toThrow('requires a fresh-context spawn subagent provider')
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it('fails before Main-Agent planning when spawn cannot enforce the Child policy', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-capability-')), 'session')
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

  it('uses a new spawn Child for repair and publishes only the accepted candidate', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-repair-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, attempt => attempt !== 1)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })

    expect(fixture.starts).toHaveLength(4)
    expect(fixture.starts[1]?.request.label).toContain('修复 1')
    expect(promptText(fixture.starts[1]!.request)).toContain('CHAPTER_WRITING_MUST_ANSWER_INVALID')
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections[0]?.attempts.map(attempt => attempt.accepted)).toEqual([false, true, true])
    expect(await readFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), 'utf8')).toContain('# SEC-1')
  })

  it('keeps scheduling an unrelated ready section while another branch is repairing', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-repair-wave-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, false, attempt => attempt !== 1)
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
    ['non-completed stop reason', (): SubagentResult => ({ stopReason: 'max-tokens', output: [] }), 'CHAPTER_SUBAGENT_STOP_REASON_INVALID'],
    ['missing structured result', (): SubagentResult => ({ stopReason: 'completed', output: [] }), 'CHAPTER_SUBAGENT_STRUCTURED_MISSING'],
    ['schema-invalid candidate', (request: SubagentStartRequest): SubagentResult => {
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      return { stopReason: 'completed', output: [], structured: { section_id: candidate.section_id, metadata: candidate.metadata } }
    }, 'CHAPTER_SUBAGENT_CANDIDATE_INVALID'],
  ])('repairs a %s in a new Child', async (_name, firstResult, issueCode) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-result-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (attempt, request) =>
      attempt === 1 ? firstResult(request) : { stopReason: 'completed', output: [], structured: candidateFrom(request) })

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1,
      maxConcurrency: 1,
    })

    expect(fixture.starts[1]?.request.label).toContain('修复 1')
    expect(promptText(fixture.starts[1]!.request)).toContain(issueCode)
    expect(fixture.disposed).toHaveLength(7)
  })

  it('aborts and disposes sibling runs without publishing a manifest when one branch exhausts repair', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-failure-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, false, () => true, attempt =>
      attempt === 1 ? { stopReason: 'error', output: [] } : { stopReason: 'completed', output: [], structured: undefined })
    const execution = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts[0]!.resolve()
    await expect(execution).rejects.toThrow('SEC-1')
    expect(fixture.disposed.sort()).toEqual(['child-1', 'child-2'])
    await expect(readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.followup).toHaveBeenCalledOnce()
  })

  it('fails S6 without a manifest when Child startup fails', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-start-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.subagents.start.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 1,
    })).rejects.toThrow('infrastructure failed for SEC-1')
    const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/execution-log.json'), 'utf8')))
    expect(log.sections[0]).toMatchObject({ section_id: 'SEC-1', status: 'failed', attempts: [] })
    await expect(readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans stale S6 artifacts and replans on a stage retry', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-retry-')), 'session')
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
    await writeFile(join(workspace.sessionRoot, 'chapters/sections/stale.md'), 'stale')

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await expect(readFile(join(workspace.sessionRoot, 'chapters/sections/stale.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.followup).toHaveBeenCalledOnce()
    expect(fixture.starts).toHaveLength(3)
  })

  it('rejects additional Web evidence that belongs to another Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-web-')), 'session')
    const section = outlineFixture().sections[1]!
    const context: ChapterContext = {
      section,
      contentPath: 'chapters/sections/0001.md',
      metadataPath: 'chapters/meta/0001.json',
      project: {
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
      },
      requirements: [],
      scoring: [],
      responsePoints: [],
      responsePointMappings: [],
      compliance: [],
      researchTopics: [],
      evidence: [],
      externalEvidence: [],
      missingTopics: [],
      sourceMappings: [],
    }
    const external = {
      title: '来源 B', url: 'https://b.example/doc', publisher: 'B', retrieved_at: '2026-09-01T00:00:00.000Z',
      retrieval_method: 'web_search' as const, usage: 'reference' as const, summary: '摘要', supports: '技术说明',
    }
    const candidate: ChapterCandidate = {
      section_id: section.id,
      markdown: '# 章节',
      metadata: {
        section_id: section.id,
        covered_must_answer: section.must_answer,
        covered_scoring_response_point_ids: section.scoring_response_point_ids ?? [],
        covered_scoring_response_points: section.scoring_response_points,
        assigned_source_mapping_ids: section.source_mapping_ids,
        source_mapping_usage: [],
        source_mapping_ids_used: [],
        evidence_used: [],
        additional_materials: [],
        external_evidence_used: [],
        additional_external_materials: [external],
        unresolved_topics: [],
        handoff: emptyHandoff(section.id),
      },
    }
    const childASnapshots: EvidenceMappingWebSnapshot[] = [{
      source: {
        source_id: 'WEB-aaaaaaaaaaaaaaaa', search_call_id: 'search-a', fetch_call_id: 'fetch-a', search_result_seq: 1,
        fetch_call_seq: 2, fetch_result_seq: 3, queries: ['A'], discovered_url: 'https://a.example/doc',
        requested_url: 'https://a.example/doc', final_url: 'https://a.example/doc', status_code: 200, truncated: false,
        fetched_at: external.retrieved_at, content_sha256: 'a'.repeat(64), snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md',
      },
      content: 'A',
    }]

    expect((await validateChapterCandidate(workspace, context, candidate, childASnapshots)).map(issue => issue.code))
      .toContain('CHAPTER_WRITING_EXTERNAL_EVIDENCE_UNVERIFIED')
  })
})
