import { writeInputs, outlineFixture, emptyChapterContext } from './fixtures/chapter-writing-inputs.ts'
import { mkdir, mkdtemp, readFile, writeFile, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { pickChapterContext, renderChapterExecutionPlanTask, validateChapterCandidate } from '../src/chapter-writing-executor.ts'
import type { ChapterCandidate } from '../src/chapter-writing-artifacts.ts'
import type { ChapterReview } from '../src/chapter-writing-review-artifacts.ts'
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
  parseChapterExecutionPlan,
  parseChapterMetadata,
  parseChapterReviewArtifact,
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

function candidateFrom(request: SubagentStartRequest, _valid = true, withWebEvidence = false) {
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
    markdown: `# ${section.id}\n\n正文`,
    metadata: {
      local_materials_used: [], web_materials_used: [],
      additional_web_materials: withWebEvidence ? [{
        url: fetchedUrl, usage: 'reference', summary: '官方正文摘要', supports: '公开技术要求',
      }] : [],
      unresolved_topics: [],
      handoff: {},
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
  _outline: ReturnType<typeof outlineFixture>,
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
  const definitions = new Map<string, ToolDefinition>()
  const reviewerResult = vi.fn<(request: SubagentStartRequest) => ChapterReview>(request => reviewFrom(request))
  const call = async (
    owner: Agent, registry: Map<string, ToolDefinition>, events: Map<string, (...args: unknown[]) => void>,
    name: string, args: unknown,
  ): Promise<unknown> => {
    const exec = {
      agent: owner, name, arguments: args, signal: new AbortController().signal, concludeTurn() {}, token: {},
    } as unknown as ToolRunContext
    const value = await registry.get(name)!.execute(args, exec)
    events.get('tools/result')?.(exec, { isError: false, value })
    return value
  }
  const createChild = (id: ReturnType<typeof SessionId>, request: SubagentStartRequest) => {
    const registry = new Map<string, ToolDefinition>()
    const events = new Map<string, (...args: unknown[]) => void>()
    const childTools = { ...tools, register: (definition: ToolDefinition) => {
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    } }
    const child = { id, options: {}, session: { id, header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' }, events: [] }, ctx: {
      tools: childTools, get: (name: string) => name === 'tools' ? childTools : undefined,
      on: (name: string, listener: (...args: unknown[]) => void) => { events.set(name, listener); return () => events.delete(name) },
    } } as unknown as Agent
    Object.assign(child.ctx, { agent: child })
    listeners.get('subagent/child-setup')?.({ parent: agent, childContext: child.ctx, request })
    listeners.get('agent/created')?.({ agent: child })
    return { child, registry, events }
  }
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
        const { child: localAgent, registry, events } = createChild(id, request)
        const result = (async (): Promise<SubagentResult> => {
          const review = reviewerResult(request)
          const items = [
            ...review.must_answer_coverage, ...review.requirement_coverage,
            ...review.response_point_coverage, ...review.compliance_coverage,
          ]
          await call(localAgent, registry, events, 'review_coverage_items', { items: items.map((item, index) => ({ item_ref: `R${index + 1}`, status: item.status, evidence_quote_refs: item.evidence_quotes, issue: item.issue })) })
          await call(localAgent, registry, events, 'set_review_summary', { quality_checks: review.quality_checks, blocking_issues: review.blocking_issues })
          await call(localAgent, registry, events, 'finish_chapter_review', {})
          return { stopReason: 'completed', output: [] }
        })()
        return { id, localAgent, result, dispose: async () => { disposed.push(String(id)) } }
      }
      active++
      maxActive = Math.max(maxActive, active)
      const currentAttempt = ++attempt
      const id = SessionId(`child-${currentAttempt}`)
      const { child: localAgent } = createChild(id, request)
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
    register: vi.fn((definition: ToolDefinition) => {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    }),
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
      await call(agent, definitions, listeners, 'add_global_consistency_note', { note: '统一术语。' })
      for (const [section_id, depends] of Object.entries(dependencies)) {
        await call(agent, definitions, listeners, 'set_chapter_relations', { section_id, depends_on: depends.map(section_id => ({ section_id, reason: '复用前置章节结论。' })), related_sections: [], planning_notes: [] })
      }
      await call(agent, definitions, listeners, 'finish_chapter_plan', {})
    }),
  } as unknown as Agent
  return { agent, followup, starts, subagents, tools, guards, disposed, reviewerResult, maxActive: () => maxActive }
}

describe('chapter-writing executor', () => {
  it.each(['损坏', '未完成'])('恢复按强依赖传递失效，%s 前置章节时保留弱关联章节', async (damage) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-dependent-resume-')))
    const outline = await writeInputs(workspace)
    outline.sections.push({ ...outline.sections[3]!, id: 'SEC-4', title: '章节4', order: 4 })
    // C/B/A 的显示顺序与依赖方向相反，D 仅弱关联 A。
    outline.sections[1]!.order = 3
    outline.sections[3]!.order = 1
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline))
    const hash = outlineArtifactSha256(outline)
    await writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: hash, confirmed_outline_sha256: hash, confirmed_draft_revision: 1, confirmed_draft_sha256: hash }))
    const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(evidencePath, 'utf8')))
    evidence.section_mappings.push({ ...evidence.section_mappings[2]!, section_id: 'SEC-4' })
    await writeFile(evidencePath, JSON.stringify(evidence))
    const first = fixtureAgent(workspace, outline, { 'SEC-2': ['SEC-1'], 'SEC-3': ['SEC-2'] })
    await executeChapterWriting(first.agent, workspace, buildBidStageTask('chapter_writing'))
    const planPath = join(workspace.projectRoot, 'chapters/execution-plan.json')
    const plan = parseChapterExecutionPlan(JSON.parse(await readFile(planPath, 'utf8')))
    plan.sections.find(s => s.section_id === 'SEC-4')!.related_sections = [{ section_id: 'SEC-1', reason: '术语关联', strength: 'weak' }]
    await writeFile(planPath, JSON.stringify(plan))
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const prior = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    prior.sections.find(s => s.section_id === 'SEC-4')!.related_sections = ['SEC-1']
    if (damage === '未完成') prior.sections.find(s => s.section_id === 'SEC-1')!.status = 'running'
    else await writeFile(join(workspace.projectRoot, 'chapters/sections/0003.md'), '损坏正文')
    await writeFile(logPath, JSON.stringify(prior))
    const retained = await Promise.all(['sections/0004.md', 'meta/0004.json', 'reviews/0004.json'].map(path => readFile(join(workspace.projectRoot, 'chapters', path), 'utf8')))
    const resumed = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) => ({
      stopReason: 'completed', output: [], structured: { ...candidateFrom(request), metadata: { handoff: { decisions: [`${request.label} 本轮新决策`] } } },
    }))
    const start = resumed.subagents.start.getMockImplementation()!
    let firstWriter = true
    resumed.subagents.start.mockImplementation(async (provider, request) => {
      if (firstWriter) {
        firstWriter = false
        const checkpoint = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
        for (const id of ['SEC-1', 'SEC-2', 'SEC-3']) {
          const section = checkpoint.sections.find(section => section.section_id === id)!
          expect(section.status).toBe(id === 'SEC-1' ? 'running' : 'pending')
          expect(section.final_writer_child_session_id).toBeNull()
          expect(section.final_reviewer_child_session_id).toBeNull()
          expect(section.attempts).toEqual(prior.sections.find(section => section.section_id === id)!.attempts)
        }
      }
      return start(provider, request)
    })
    await executeChapterWriting(resumed.agent, workspace, buildBidStageTask('chapter_writing'))
    expect(resumed.followup).not.toHaveBeenCalled()
    expect(resumed.starts.map(start => start.request.label?.slice(-3))).toEqual(['章节1', '章节2', '章节3'])
    for (const [index, start] of resumed.starts.slice(1).entries()) {
      const line = promptText(start.request).split('\n').find(line => line.startsWith('Dependency Chapter Context：'))!
      expect(JSON.parse(line.slice('Dependency Chapter Context：'.length))).toMatchObject([
        { section_id: `SEC-${index + 1}`, handoff: { decisions: [expect.stringContaining(`章节${index + 1} 本轮新决策`)] } },
      ])
    }
    const final = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    expect(final.sections.find(s => s.section_id === 'SEC-4')).toEqual(prior.sections.find(s => s.section_id === 'SEC-4'))
    for (const section of final.sections.filter(s => s.section_id !== 'SEC-4')) expect(section.attempts.length).toBe(prior.sections.find(s => s.section_id === section.section_id)!.attempts.length + 2)
    expect(await Promise.all(['sections/0004.md', 'meta/0004.json', 'reviews/0004.json'].map(path => readFile(join(workspace.projectRoot, 'chapters', path), 'utf8')))).toEqual(retained)
  })

  it.each(['正文写入中', 'metadata 写入后', 'review 写入后', '提交成功后'])('最终落盘取消：%s', async (point) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-final-abort-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    const controller = new AbortController()
    const original = atomicWrite.writeFileAtomic
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let bodies = 0
    let metadata = 0
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, content, options) => {
      const name = path.replaceAll('\\', '/')
      const target = point === '正文写入中' ? name.endsWith('sections/0001.md') && ++bodies === 2
        : point === 'metadata 写入后' ? name.endsWith('meta/0001.json') && ++metadata === 2
          : point === 'review 写入后' ? name.endsWith('reviews/0001.json')
            : name.endsWith('execution-log.json') && content.includes('"status": "completed"')
      if (target && point === '正文写入中') { entered.resolve(undefined); await release.promise }
      await original(path, content, options)
      if (target && point !== '正文写入中') { entered.resolve(undefined); await release.promise }
    })
    try {
      const result = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1, signal: controller.signal })
      const rejection = expect(result).rejects.toThrow()
      await entered.promise
      controller.abort()
      release.resolve(undefined)
      await rejection
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(log.sections[0]!.status === 'completed').toBe(point === '提交成功后')
      expect(fixture.disposed).toHaveLength(fixture.subagents.start.mock.calls.length)
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      spy.mockRestore()
      const resumed = fixtureAgent(workspace, outline)
      await executeChapterWriting(resumed.agent, workspace, buildBidStageTask('chapter_writing'))
      expect(resumed.starts.some(start => start.request.label?.endsWith('章节1'))).toBe(point !== '提交成功后')
    } finally { release.resolve(undefined); spy.mockRestore() }
  })

  it('完成日志排队期间取消，不让前面的普通日志发布共享 completed 状态', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-queued-commit-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, false)
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const reviewWritten = Promise.withResolvers<undefined>()
    const returnReview = Promise.withResolvers<undefined>()
    const queueEntered = Promise.withResolvers<undefined>()
    const releaseQueue = Promise.withResolvers<undefined>()
    const start = fixture.subagents.start.getMockImplementation()!
    fixture.subagents.start.mockImplementation(async (name, request) => {
      const run = await start(name, request)
      if (fixture.starts.length === 3) started.resolve(undefined)
      return run
    })
    const original = atomicWrite.writeFileAtomic
    const published: ReturnType<typeof parseChapterExecutionLog>[] = []
    let blockNextLog = false
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, content, options) => {
      const name = path.replaceAll('\\', '/')
      if (name.endsWith('execution-log.json')) {
        if (blockNextLog) { blockNextLog = false; queueEntered.resolve(undefined); await releaseQueue.promise }
        published.push(parseChapterExecutionLog(JSON.parse(content)))
      }
      await original(path, content, options)
      if (name.endsWith('reviews/0001.json')) { reviewWritten.resolve(undefined); await returnReview.promise }
    })
    try {
      const result = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3, signal: controller.signal })
      const rejection = expect(result).rejects.toThrow()
      await started.promise
      fixture.starts[0]!.resolve()
      await reviewWritten.promise
      blockNextLog = true
      fixture.starts[1]!.resolve()
      await queueEntered.promise
      fixture.starts[2]!.resolve()
      // 磁盘读取让已兑现 Writer 的微任务排入日志队列；队列仍由可控 Promise 阻塞。
      await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'))
      returnReview.resolve(undefined)
      await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'))
      controller.abort()
      releaseQueue.resolve(undefined)
      await rejection
      expect(published.every(log => log.sections.every(section => section.status !== 'completed'))).toBe(true)
      const disk = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(disk.sections.every(section => section.status !== 'completed')).toBe(true)
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(fixture.disposed).toHaveLength(fixture.subagents.start.mock.calls.length)
    } finally { returnReview.resolve(undefined); releaseQueue.resolve(undefined); spy.mockRestore() }
  })

  it('完成日志原子写入失败时不发布完成或 manifest', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-commit-failure-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    const original = atomicWrite.writeFileAtomic
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, content, options) => {
      if (path.endsWith('execution-log.json') && content.includes('"status": "completed"')) throw new Error('测试磁盘失败')
      await original(path, content, options)
    })
    try {
      await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1 })).rejects.toThrow('测试磁盘失败')
      const disk = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(disk.sections.every(section => section.status !== 'completed')).toBe(true)
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(fixture.disposed).toHaveLength(fixture.subagents.start.mock.calls.length)
    } finally { spy.mockRestore() }
  })

  it('取消合法 repair 的最终落盘时保留此前章节与旧 manifest，不通过 fallback 完成', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-abort-retained-')))
    const outline = await writeInputs(workspace)
    await executeChapterWriting(fixtureAgent(workspace, outline).agent, workspace, buildBidStageTask('chapter_writing'))
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const prior = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    prior.sections[1]!.status = 'pending'
    await writeFile(logPath, JSON.stringify(prior))
    const retainedPaths = ['manifest.json', 'sections/0001.md', 'meta/0001.json', 'reviews/0001.json', 'sections/0003.md', 'meta/0003.json', 'reviews/0003.json']
    const retained = await Promise.all(retainedPaths.map(path => readFile(join(workspace.projectRoot, 'chapters', path), 'utf8')))
    const fixture = fixtureAgent(workspace, outline)
    fixture.reviewerResult.mockImplementation(request => ({ ...reviewFrom(request), verdict: 'repair', blocking_issues: ['真实待核实内容'] }))
    const controller = new AbortController()
    const original = atomicWrite.writeFileAtomic
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, content, options) => {
      await original(path, content, options)
      if (path.replaceAll('\\', '/').endsWith('reviews/0002.json')) { entered.resolve(undefined); await release.promise }
    })
    try {
      const result = executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3, signal: controller.signal })
      const rejection = expect(result).rejects.toThrow()
      await entered.promise
      controller.abort()
      release.resolve(undefined)
      await rejection
      const disk = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
      expect(disk.sections[1]!.status).not.toBe('completed')
      expect(disk.sections[0]).toEqual(prior.sections[0])
      expect(disk.sections[2]).toEqual(prior.sections[2])
      expect(await Promise.all(retainedPaths.map(path => readFile(join(workspace.projectRoot, 'chapters', path), 'utf8')))).toEqual(retained)
      expect(spy.mock.calls.some(([path]) => path.replaceAll('\\', '/').endsWith('chapters/manifest.json'))).toBe(false)
      expect(fixture.starts).toHaveLength(1)
    } finally { release.resolve(undefined); spy.mockRestore() }
  })

  it.each(['sections/0001.md', 'meta/0001.json', 'reviews/0001.json'])('最终 %s 写盘失败不当作 Child 传输重试或 fallback', async (suffix) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-final-write-failure-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    const original = atomicWrite.writeFileAtomic
    let writes = 0
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, content, options) => {
      if (path.replaceAll('\\', '/').endsWith(suffix) && ++writes === (suffix.startsWith('reviews') ? 1 : 2)) throw new Error('最终文件写入失败')
      await original(path, content, options)
    })
    try {
      await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3 })).rejects.toThrow('SEC-1')
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(log.sections[0]!.status).toBe('failed')
      expect(log.sections[0]!.attempts).toHaveLength(2)
      expect(log.sections.slice(1).every(section => section.status === 'completed')).toBe(true)
      expect(fixture.starts).toHaveLength(3)
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { spy.mockRestore() }
  })

  it.each(['丢失', 'Hash', '链接路径'])('完整 S5 入口隔离候选 Web 来源%s，保留本地写作与映射要求', async (damage) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-web-isolation-')))
    const outline = await writeInputs(workspace)
    await seedReadableMaterials(workspace)
    const ledgerPath = join(workspace.projectRoot, 'analysis/web-evidence-sources.json')
    const ledgerText = await readFile(ledgerPath, 'utf8')
    const source = parseWebEvidenceSourcesArtifact(JSON.parse(ledgerText)).sources[0]!
    const snapshotPath = join(workspace.projectRoot, source.snapshot_path)
    if (damage === 'Hash') await writeFile(snapshotPath, '已篡改')
    else {
      await unlink(snapshotPath)
      if (damage === '链接路径') await symlink(await mkdtemp(join(tmpdir(), 'dsh-s5-linked-source-')), snapshotPath, 'junction')
    }
    const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(evidencePath, 'utf8')))
    evidence.section_mappings[1]!.web_materials = [{ source_id: source.source_id, snapshot_path: source.snapshot_path, usage: 'reference', summary: '已映射的技术要求', supports: '技术方案' }]
    await writeFile(evidencePath, JSON.stringify(evidence))
    const evidenceText = await readFile(evidencePath, 'utf8')
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) => ({
      stopReason: 'completed', output: [], structured: {
        ...candidateFrom(request), markdown: '# 当前实施章节\n\n采用本地资料中经过核实的技术依据组织实施，明确责任与交付成果。',
        metadata: { local_materials_used: [{ file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '本地依据' }] },
      },
    }))
    const artifacts = await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'))
    expect(fixture.starts).toHaveLength(3)
    const mappedPrompt = promptText(fixture.starts.find(start => start.request.label?.endsWith('章节2'))!.request)
    expect(mappedPrompt).toContain('不可用')
    expect(mappedPrompt).toContain('已映射的技术要求')
    expect(mappedPrompt).toContain('回答2')
    expect(mappedPrompt).not.toContain('"web_ref":"W1"')
    await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerText)
    expect(await readFile(evidencePath, 'utf8')).toBe(evidenceText)
  })

  it('审查错误宣称通过时仍按实际内容缺口修订，保留问题并继续其他章节', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-review-verdict-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) => ({
      stopReason: 'completed', output: [], structured: {
        ...candidateFrom(request), markdown: '# 实施方案\n\n正文内容\n\n按项目技术要求组织实施、执行质量复核并交付完整成果。',
      },
    }))
    fixture.reviewerResult.mockImplementation((request) => {
      const review = reviewFrom(request)
      return {
        ...review, must_answer_coverage: review.must_answer_coverage.map(item => ({ ...item, status: 'missing', evidence_quotes: [], issue: '缺少具体措施' })),
      }
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

  it('Writer Schema 只接受短引用语义字段，Reviewer 不要求 structured output', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-material-schema-')))
    const outline = await writeInputs(workspace)
    await seedReadableMaterials(workspace)
    const fixture = fixtureAgent(workspace, outline)
    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 1 })
    const request = fixture.starts[0]!.request
    const schema = request.outputSchema!
    assertSupportedJsonSchema(schema)
    const candidate = { markdown: '完整正文', metadata: {} }
    expect(validateJsonSchemaValue(schema, candidate)).toEqual([])
    const validateMaterial = (material: unknown) =>
      validateJsonSchemaValue(schema, { ...candidate, metadata: { local_materials_used: [material] } })
    expect(validateMaterial({ file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '资料依据' })).toEqual([])
    expect(validateMaterial({ material_ref: 'M1', usage: 'reference', summary: '资料依据' })).toEqual([])
    expect(validateMaterial({ material_ref: 'M1', file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '资料依据' })).not.toEqual([])
    expect(validateMaterial({ source_kind: 'reference', file_id: 'REFERENCE', chunk: 'chunk_0001', usage: 'reference', summary: '资料依据' })).not.toEqual([])
    expect(validateJsonSchemaValue(schema, { ...candidate, section_id: 'SEC-1' })).not.toEqual([])
    const reviewRequest = fixture.subagents.start.mock.calls.find(([, request]) => request.toolFilter?.allow?.length === 0)![1]
    expect(reviewRequest.outputSchema).toBeUndefined()
    expect(promptText(reviewRequest)).toContain('Review Checklist：')
    expect(promptText(reviewRequest)).toContain('Evidence Pack：')
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
    fixture.reviewerResult.mockImplementation((request) => {
      const review = reviewFrom(request)
      if (!request.label?.endsWith('章节1')) return review
      return {
        ...review,
        verdict: 'repair',
        blocking_issues: ['缺少真实设备数量，保留待核实项。'],
      }
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

  it('无效审查引句不能生成报告，结束后不另建 Child 补协议或重写正文', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-review-repair-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline)
    fixture.reviewerResult.mockImplementation((request) => {
      const review = reviewFrom(request)
      return {
        ...review, must_answer_coverage: review.must_answer_coverage.map(item => ({ ...item, evidence_quotes: ['“正文”'] })),
      }
    })
    await expect(executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), {
      maxRepairAttempts: 1, maxConcurrency: 1,
    })).rejects.toThrow('CHAPTER_REVIEWER_FINISH_REQUIRED')
    await expect(readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.starts).toHaveLength(3)
    expect(fixture.reviewerResult).toHaveBeenCalledTimes(3)
  })

  it('旧版非法计划由私有协议重新规划，Host 写入当前版本后才启动章节写作', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-plan-repair-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true)
    await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), JSON.stringify({ schema_version: 1, sections: [{ depends_on: ['SEC-1'] }] }))
    expect(fixture.starts).toHaveLength(0)

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    expect(fixture.followup).toHaveBeenCalledTimes(1)
    expect(parseChapterExecutionPlan(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), 'utf8'))).schema_version).toBe(CHAPTER_EXECUTION_SCHEMA_VERSION)
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters).toHaveLength(3)
  })

  it('规划提示只要求语义关系工具，不要求模型组装版本或章节集合', async () => {
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
    expect(prompt).toContain('finish_chapter_plan')
    expect(prompt).toContain('无需逐章提交空数组')
  })

  it('allows the S6 capability union while keeping bash forbidden', () => {
    const policy = getBidStagePolicy('chapter_writing')
    expect(policy.allowedTools).toEqual(['grep', 'read', 'web_search', 'web_fetch'])
    expect(policy.forbiddenTools).toEqual(['bash', 'write'])
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
      compliance: parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [{
        id: 'GLOBAL-1', type: '强制', raw_text: '全局规则', normalized_rule: '全局安全约束',
        severity: 'mandatory', source_refs: source,
      }] }),
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
      globalComplianceIds: ['GLOBAL-1'],
    })

    expect(context.relatedMaterials.map(material => material.file_id)).toEqual(['REFERENCE'])
    expect(context.referenceBidMaterials.map(material => material.file_id)).toEqual(['REFERENCE-BID'])
    expect(context.webMaterials.map(material => material.source_id)).toEqual(['WEB-aaaaaaaaaaaaaaaa'])
    expect(context.writingDimensions).toEqual(['需求维度', '评分维度'])
    expect(context.compliance.map(item => item.id)).toEqual(['GLOBAL-1'])
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
      const corpus = JSON.parse(lines.find(line => line.startsWith('Available Evidence Files：'))!.slice('Available Evidence Files：'.length)) as Array<{
        file_ref: string
        role: string
        chunks_path: string
        chunk_index_path: string
      }>
      expect(corpus.map(file => file.role)).toEqual(['reference', 'reference_bid'])
      const snapshots = JSON.parse(lines.find(line => line.startsWith('Verified Web Snapshots：'))!.slice('Verified Web Snapshots：'.length)) as Array<{ web_ref: string; read_path: string }>
      expect(snapshots[0]?.web_ref).toBe('W1')
      const candidate = candidateFrom(request)
      if (!('metadata' in candidate)) throw new Error('expected writer candidate')
      if (!request.label?.endsWith('章节1')) return start(provider, request)
      expect(lines).toContain('Mapped Materials：[]')
      const file = corpus.find(item => item.role === 'reference')!
      const run = await start(provider, request)
      const guard = fixture.guards.at(-1)!
      const allowed = (name: 'grep' | 'read', path: string) => guard({
        name, arguments: { [name === 'grep' ? 'path' : 'file_path']: path },
        agent: { session: { header: { cwd: workspace.root, parentSession: 'parent', origin: 'subagent' } } },
      } as unknown as ToolExecution)
      expect(allowed('grep', file.chunks_path)).toBeUndefined()
      const chunkPath = join(file.chunks_path, 'chunk_0001.md')
      expect(allowed('read', chunkPath)).toBeUndefined()
      const text = (await readFile(chunkPath, 'utf8')).trim()
      return { ...run, result: run.result.then(result => ({ ...result, structured: {
        ...candidate, markdown: `# 当前章节\n\n结合 ${text}，说明本项目实施流程与质量控制要求。`,
        metadata: { ...candidate.metadata, local_materials_used: [{
          file_ref: file.file_ref, chunk: 'chunk_0001', usage: 'reference', summary: '支撑本章实施流程与质量控制要求。',
        }] },
      } })) }
    })

    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1 })

    const metadata = parseChapterMetadata(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), 'utf8')))
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
    expect(fixture.tools.restrict).toHaveBeenCalledWith({ allow: [] })
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
      expect(prompt).toContain('Mapped Materials：')
      expect(prompt).toContain('Available Evidence Files：')
      expect(prompt).toContain('Verified Web Snapshots：')
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
    const metadata = parseChapterMetadata(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), 'utf8')))
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
      return { stopReason: 'completed', output: [], structured: { metadata: candidate.metadata } }
    }, 'CHAPTER_SUBAGENT_CANDIDATE_INVALID'],
    ['provider result carrying forbidden durable identities', (request: SubagentStartRequest): SubagentResult => {
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

  it('仅有合法 plan、没有 log 时复用计划，不再次请求 Relation Planning', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-plan-only-')))
    const outline = await writeInputs(workspace)
    await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
    const plan = { schema_version: CHAPTER_EXECUTION_SCHEMA_VERSION, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), global_consistency_notes: ['保留已确认的一致性要求。'], sections: outline.sections.filter(section => section.writable).map(section => ({ section_id: section.id, depends_on: [], related_sections: [], planning_notes: [] })) }
    await writeFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), JSON.stringify(plan))
    const fixture = fixtureAgent(workspace, outline)
    await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3 })
    expect(fixture.followup).not.toHaveBeenCalled()
    expect(fixture.starts).toHaveLength(3)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), 'utf8'))).toEqual(plan)
  })

  it('恢复保留合法 repair，只重跑引句已损坏的章节', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-repair-checkpoint-')))
    const outline = await writeInputs(workspace)
    const first = fixtureAgent(workspace, outline)
    first.reviewerResult.mockImplementation(request => ({ ...reviewFrom(request), verdict: 'repair', blocking_issues: ['保留真实缺口。'] }))
    await executeChapterWriting(first.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3 })
    const retained = await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')
    const damagedPath = join(workspace.projectRoot, 'chapters/reviews/0002.json')
    const damaged = parseChapterReviewArtifact(JSON.parse(await readFile(damagedPath, 'utf8')))
    const firstCoverage = damaged.must_answer_coverage[0]
    if (firstCoverage === undefined) throw new Error('missing must-answer coverage')
    firstCoverage.evidence_quotes = ['正文中不存在的引句']
    await writeFile(damagedPath, JSON.stringify(damaged))
    const resumed = fixtureAgent(workspace, outline)
    await executeChapterWriting(resumed.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3 })
    expect(resumed.followup).not.toHaveBeenCalled()
    expect(resumed.starts).toHaveLength(1)
    expect(resumed.starts[0]?.request.label).toContain('章节2')
    expect(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')).toBe(retained)
  })

  it('最终读取拒绝报告自身矛盾、缺 coverage 或伪造 claim 引句，合法 repair 仍可完成', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-review-integrity-')))
    const outline = await writeInputs(workspace)
    const fixture = fixtureAgent(workspace, outline, {}, true, () => true, (_attempt, request) => ({ stopReason: 'completed', output: [], structured: { ...candidateFrom(request), markdown: '# 本章方案\n\n本章按已确认技术要求描述实际措施、责任安排及成果核验方法。' } }))
    const artifacts = await executeChapterWriting(fixture.agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 3 })
    const path = join(workspace.projectRoot, 'chapters/reviews/0001.json')
    const original = parseChapterReviewArtifact(JSON.parse(await readFile(path, 'utf8')))
    for (const invalid of [
      { ...original, must_answer_coverage: [] },
      { ...original, quality_checks: { ...original.quality_checks, project_specific: false } },
      { ...original, must_answer_coverage: original.must_answer_coverage.map((item: object) => ({ ...item, evidence_quotes: [] })) },
      { ...original, claim_checks: [{ claim_quote: '伪造正文', kind: 'technical_fact', status: 'supported', source_reference: 'analysis/project.json', issue: null }] },
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      expect((await validateChapterWriting(workspace, 'chapter_writing', artifacts)).ok).toBe(false)
    }
    await writeFile(path, JSON.stringify({ ...original, verdict: 'repair', quality_checks: { ...original.quality_checks, project_specific: false }, blocking_issues: ['缺少项目具体措施。'] }))
    await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
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
