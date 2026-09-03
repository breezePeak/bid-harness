import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import type { ContinuableStartSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  BidHostRuntime,
  BidOrchestrator,
  getOrCreateOutlineDraft,
  replaceOutlineDraft,
  validateEvidenceMapping,
  validateSectionEvidenceCoverage,
  parseOutlineConfirmationArtifact,
  type Config,
  buildBidStageTask,
  buildWebEvidenceSnapshots,
  createScoringResponsePointCatalog,
  executeEvidenceMapping,
  parseWebEvidenceSourcesArtifact,
  parseEvidenceMapArtifact,
  parseOutlineArtifact,
  readEvidenceMappingProgress,
  resolveMappingCorpusLocations,
  mappingCorpusToolGuard,
  webEvidenceContentSha256,
  type EvidenceMappingPartialResult,
  type EvidenceMappingTask,
} from '@deepseek-ai/dsh-bid'

interface EvidenceMappingWebObservation {
  callId: string
  name: 'web_search' | 'web_fetch'
  arguments: unknown
  result: Readonly<ToolExecutionResult>
  callSeq: number
  resultSeq: number
  resultTime: number
}

function observation(
  input: Pick<EvidenceMappingWebObservation, 'callId' | 'name' | 'arguments' | 'callSeq' | 'resultSeq'>
  & { value?: unknown; content?: string; isError?: boolean; statusMeta?: unknown },
): EvidenceMappingWebObservation {
  const isError = input.isError ?? false
  return {
    ...input,
    resultTime: 1_788_134_400_000,
    result: isError
      ? { isError: true, error: { message: 'failed' }, content: [{ type: 'text', text: 'failed' }] }
      : {
        isError: false,
        value: input.value as never,
        content: [{ type: 'text', text: input.content ?? 'ok' }],
        ...(input.statusMeta === undefined ? {} : { meta: input.statusMeta as never }),
      },
  }
}

function promptText(request: { prompt: readonly { type: string; text?: string }[] }): string {
  return request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function writeInputs(workspace: BidWorkspace) {
  const [tender, reference, framework, referenceBid] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('要求一。要求二。评分一。评分二。') },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('可复用的统一技术资料。') },
    { name: 'framework.md', role: 'outline_framework', bytes: new TextEncoder().encode('# 人工目录\n\n框架正文。') },
    { name: 'reference-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode('# 旧标书\n\n成熟方案。') },
  ])
  if (tender === undefined || reference === undefined || framework === undefined || referenceBid === undefined
    || tender.absoluteChunkIndexPath === null || tender.chunksPath === null
    || reference.absoluteChunkIndexPath === null || reference.chunksPath === null
    || framework.absoluteChunkIndexPath === null || framework.chunksPath === null
    || referenceBid.absoluteChunkIndexPath === null || referenceBid.chunksPath === null) {
    throw new Error('executor fixture missing')
  }
  const index = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ id: string; path: string }> }
  const tenderIndex = JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ id: string; path: string }> }
  const frameworkIndex = JSON.parse(await readFile(framework.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const referenceBidIndex = JSON.parse(await readFile(referenceBid.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const chunk = index.chunks[0]!.id
  const tenderChunk = tenderIndex.chunks[0]!.id
  const tenderPath = `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`
  const source = [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }]
  const scoring = { schema_version: 1 as const, scoring_items: [1, 2].map(value => ({ id: `S-${value}`, parent: null, group: '技术', title: `评分${value}`, raw_text: `评分${value}`, criterion: `响应评分${value}`, score: 1, score_range: null, must_answer: true, source_refs: source })) }
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['背景'], project_objectives: ['目标'], project_scope: ['范围'], technical_scope: ['技术'], delivery_scope: ['交付'], implementation_constraints: [], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: [tender.id] })),
    writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [1, 2].map(value => ({ id: `R-${value}`, category: '技术', raw_text: `要求${value}`, normalized_requirement: `响应要求${value}`, mandatory: true, source_refs: source })) })),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify(scoring)),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [1, 2].map(value => ({ scoring_id: `S-${value}`, order: 1, text: `响应点${value}` })) }))),
    writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] })),
  ])
  const outline = {
    schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [1, 2].map(value => ({
      id: `SEC-${value}`, parent_id: null, order: value, level: 1, title: `章节${value}`, purpose: `响应主题${value}`, writable: true,
      must_answer: [`响应主题${value}`], requirement_ids: [`R-${value}`], scoring_ids: [`S-${value}`], compliance_ids: [], origin: 'generated',
      scoring_response_point_ids: [`RP-${String(value).padStart(6, '0')}`], scoring_response_points: [{ scoring_id: `S-${value}`, response_point: `响应点${value}` }], suggested_tables: [], suggested_figures: [], writing_notes: [],
    })),
  }
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(outline)),
    writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })),
  ])
  return {
    chunk,
    fileId: reference.id,
    tender: { chunk: tenderChunk, path: tenderPath, fileId: tender.id },
    framework: { path: `${framework.chunksPath}/${frameworkIndex.chunks[0]!.path}`, fileId: framework.id },
    referenceBid: { path: `${referenceBid.chunksPath}/${referenceBidIndex.chunks[0]!.path}`, fileId: referenceBid.id },
  }
}

function mappingFixture(
  workspace: BidWorkspace,
  material: { chunk: string; fileId: string },
  repairFirst = false,
  refinedOutline?: unknown,
) {
  let pendingMain = ''
  let active = 0
  let maxActive = 0
  let sequence = 0
  const starts: Array<{ request: ContinuableStartSpec; resolve(): void }> = []
  const taskAttempts = new Map<string, number>()
  const disposed: string[] = []
  const serializeReply = vi.fn((value: EvidenceMappingPartialResult) => JSON.stringify(value))
  const serializeOutline = vi.fn((content: string) => content)
  const serializeQuality = vi.fn((content: string) => content)
  const onReply = vi.fn<(child: Agent, result: EvidenceMappingPartialResult, attempt: number) => void>()
  let webObserver: ((exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) | undefined
  const emitWeb = (child: Agent, outcomes: readonly EvidenceMappingWebObservation[]) => {
    for (const outcome of outcomes) {
      const callSeq = child.session.events.length
      ;(child.session.events as unknown[]).push(
        { type: 'tool/call', seq: callSeq, data: { callId: outcome.callId, name: outcome.name } },
        { type: 'tool/result', seq: callSeq + 1, time: outcome.resultTime, data: { message: { source: { callId: outcome.callId }, content: [{ isError: outcome.result.isError }] } } },
      )
      webObserver?.({
        agent: child, callId: outcome.callId, name: outcome.name, arguments: outcome.arguments,
      } as ToolExecution, outcome.result)
    }
  }
  const partial = (request: { prompt: readonly { type: string; text?: string }[] }, child: Agent) => {
    const line = promptText(request).split('\n').find(value => value.startsWith('Mapping Task：'))
    if (line === undefined) throw new Error('mapping task missing')
    const task = JSON.parse(line.slice('Mapping Task：'.length)) as EvidenceMappingTask
    const attempt = (taskAttempts.get(task.task_id) ?? 0) + 1
    taskAttempts.set(task.task_id, attempt)
    const local = { source_kind: 'reference' as const, file_id: material.fileId, chunk: material.chunk, usage: 'reference' as const, summary: '统一资料。' }
    const result: EvidenceMappingPartialResult = {
      task_id: task.task_id,
      section_mappings: repairFirst && task.task_id === 'MAP-INIT-SEC-1' && attempt === 1
        ? []
        : task.section_ids.map(section_id => ({
          section_id, local_materials: [local], web_materials: [], missing_topics: [], writing_dimensions: ['技术响应'],
        })),
      refinement_suggestions: [],
    }
    onReply(child, result, attempt)
    return result
  }
  const spawnProvider: Pick<SubagentProvider, 'capabilities' | 'inheritsParentContext' | 'prepareContinuable'> = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    prepareContinuable: async () => ({}),
  }
  const children = new Map<string, Agent>()
  const childRequests = new Map<string, ContinuableStartSpec>()
  const subagents = {
    getProvider: vi.fn(() => spawnProvider),
    startContinuable: vi.fn(async (request: ContinuableStartSpec) => {
      active++
      maxActive = Math.max(maxActive, active)
      const id = SessionId(`child-${++sequence}`)
      let settleIdle!: () => void
      const idle = new Promise<void>((resolve) => { settleIdle = resolve })
      const manifest = await workspace.readManifest()
      const file = manifest.files.find(file => String(file.id) === material.fileId)!
      const readPath = join(workspace.sessionRoot, file.chunksPath!, material.chunk + '.md')
      const localAgent = { id, status: 'running', session: { id, header: { cwd: workspace.root, parentSession: 'session', origin: 'subagent' }, events: [
        { type: 'tool/call', seq: 0, data: { name: 'read', callId: 'read-local', arguments: JSON.stringify({ file_path: readPath }) } },
        { type: 'tool/result', seq: 1, data: { message: { source: { callId: 'read-local' }, content: [{ isError: false }] } } },
      ] }, whenIdle: () => idle } as unknown as Agent
      const settle = () => {
        ;(localAgent.session.events as unknown[]).push({
          type: 'assistant/message', data: { message: { content: [{ type: 'text', text: serializeReply(partial(request.request, localAgent)) }] }, seq: localAgent.session.events.length },
          seq: localAgent.session.events.length,
        })
        active--
        settleIdle()
      }
      children.set(String(id), localAgent)
      childRequests.set(String(id), request)
      starts.push({ request, resolve: settle })
      if (repairFirst) queueMicrotask(settle)
      return { childId: id, messageId: `message-${id}` as never }
    }),
    followup: vi.fn(async (_parent: Agent, childId: SessionId, _content: Array<{ type: string; text: string }>) => {
      const child = children.get(String(childId))!
      active++
      let settleIdle!: () => void
      const idle = new Promise<void>((resolve) => { settleIdle = resolve })
      child.whenIdle = () => idle
      queueMicrotask(() => {
        const request = childRequests.get(String(childId))
        if (request === undefined) throw new Error('missing continuable fixture request')
        ;(child.session.events as unknown[]).push({
          type: 'assistant/message', data: { message: { content: [{ type: 'text', text: serializeReply(partial(request.request, child)) }] }, seq: child.session.events.length },
          seq: child.session.events.length,
        })
        active--
        settleIdle()
      })
      return `message-${childId}` as never
    }),
    drainContinuableChildren: vi.fn(async (_parent: Agent, childIds: readonly SessionId[]) => { disposed.push(...childIds.map(String)) }),
  }
  const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
  const tools = {
    schemas: vi.fn(() => ['read', 'write', 'grep', 'web_search', 'web_fetch'].map(name => ({ name }))),
    restrict: vi.fn(() => () => {}),
    guard: vi.fn((guard: (execution: Readonly<ToolExecution>) => string | undefined) => { guards.push(guard); return () => {} }),
  }
  const followup = vi.fn((message: unknown) => { pendingMain = JSON.stringify(message) })
  const whenIdle = vi.fn(async () => {
    if (pendingMain.includes('Main-Agent Planning')) {
      throw new Error('Main Agent 不得规划 Mapping Task')
    }
    if (pendingMain.includes('refined-outline.candidate.json')) {
      const candidate = refinedOutline === undefined
        ? await readFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), 'utf8')
        : JSON.stringify(refinedOutline)
      await writeFile(join(workspace.sessionRoot, 'outline/refined-outline.candidate.json'), serializeOutline(candidate))
    }
    if (pendingMain.includes('quality-report.json')) {
      await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), serializeQuality(JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })))
    }
    if (pendingMain) (agent.session.events as unknown[]).push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '目录产物已写入。' }] } } })
    pendingMain = ''
  })
  const agents = { get: (id: SessionId) => children.get(String(id)) }
  const agent = { id: 'session', session: { id: 'session', header: { cwd: workspace.root }, events: [] }, ctx: { agents, get: (name: string) => ({ fs: { resolve: async (path: string) => path }, tools, subagents } as Record<string, unknown>)[name], emit: vi.fn(), on: vi.fn((_event: string, observer: typeof webObserver) => { webObserver = observer; return () => { webObserver = undefined } }) }, followup, whenIdle } as unknown as Agent
  return {
    agent, starts, subagents, followup, whenIdle, currentPrompt: () => pendingMain,
    guards, disposed, maxActive: () => maxActive, taskAttempts, onReply, serializeReply,
    serializeOutline, serializeQuality, emitWeb, children,
    emitToolResult: (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => webObserver?.(exec, result),
  }
}

const webUrl = 'https://official.example/a'

function webMaterial(url = webUrl) {
  return { url, usage: 'reference' as const, summary: '官方技术依据。', supports: '支持技术响应。' }
}

function webResearch(taskId: string) {
  const search = observation({
    callId: `${taskId}-search`, name: 'web_search', arguments: { queries: ['官方技术依据'] }, callSeq: 1, resultSeq: 2,
    value: { sources: [{ url: `${webUrl}#source` }], truncated: false },
  })
  const fetch = observation({
    callId: `${taskId}-fetch`, name: 'web_fetch', arguments: { url: webUrl }, callSeq: 3, resultSeq: 4,
    value: { url: webUrl, statusCode: 200, body: { kind: 'text', content: `${taskId} 正文` }, truncated: false },
    content: `Fetched ${webUrl} (HTTP 200)\n\n${taskId} 正文`,
  })
  return { search, fetch }
}

describe('evidence-mapping Agent executor', () => {
  it.each(['replace', 'supplement'] as const)('局部 %s 只运行选中 Section，并保留其他章节及 Web 快照', async (mode) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-targeted-remap-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      fixture.emitWeb(child, [search, fetch])
      result.section_mappings[0]!.web_materials = [webMaterial()]
    })
    const initial = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await initial
    const before = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    const snapshot = before.section_mappings[0]!.web_materials[0]!.snapshot_path
    const snapshotContent = await readFile(join(workspace.sessionRoot, snapshot), 'utf8')
    fixture.starts.length = 0
    fixture.followup.mockClear()
    fixture.whenIdle.mockImplementation(async () => { throw new Error('工具执行期间不得等待 Main Agent 空闲') })
    fixture.onReply.mockImplementation((_child, result) => {
      result.section_mappings[0]!.local_materials = []
      result.section_mappings[0]!.missing_topics = ['新增资料仍缺失']
    })
    const remap = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0, remap: { section_ids: ['SEC-2'], mode, reason: '只处理第二章' } })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    const prompt = promptText(fixture.starts[0]!.request.request)
    expect(prompt).toContain('"section_ids":["SEC-2"]')
    expect(prompt).toContain('只处理第二章')
    fixture.starts[0]!.resolve()
    await remap
    const after = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(after.section_mappings[0]).toEqual(before.section_mappings[0])
    expect(after.section_mappings[1]!.local_materials).toEqual(mode === 'replace' ? [] : before.section_mappings[1]!.local_materials)
    expect(after.section_mappings[1]!.web_materials).toEqual(mode === 'replace' ? [] : before.section_mappings[1]!.web_materials)
    expect(after.section_mappings[1]!.missing_topics).toContain('新增资料仍缺失')
    expect(await readFile(join(workspace.sessionRoot, snapshot), 'utf8')).toBe(snapshotContent)
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it.each([
    { replaceAgent: false, completedBeforeRepair: false },
    { replaceAgent: true, completedBeforeRepair: false },
    { replaceAgent: false, completedBeforeRepair: true },
  ])('retains task Web provenance across repair: %j', async ({ replaceAgent, completedBeforeRepair }) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-repair-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const { search, fetch } = webResearch('MAP-INIT-SEC-1')
    fixture.onReply.mockImplementation((child, result, attempt) => {
      if (result.task_id !== 'MAP-INIT-SEC-1') return
      result.section_mappings[0]!.web_materials = [webMaterial()]
      if (completedBeforeRepair) {
        if (attempt === 1) {
          fixture.emitWeb(child, [search, fetch])
          result.section_mappings = []
        }
      } else fixture.emitWeb(child, attempt === 1 ? [search] : [fetch])
    })
    if (replaceAgent) {
      const followup = fixture.subagents.followup.getMockImplementation()!
      fixture.subagents.followup.mockImplementation(async (...args) => {
        const previous = fixture.children.get(args[1])!
        fixture.children.set(args[1], { ...previous })
        return followup(...args)
      })
    }
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(ledger.sources).toHaveLength(1)
    expect(ledger.sources[0]).toMatchObject({ requested_url: webUrl, status_code: 200 })
    expect(map.section_mappings[0]!.web_materials[0]).toMatchObject({
      source_id: ledger.sources[0]!.source_id, snapshot_path: ledger.sources[0]!.snapshot_path,
    })
    expect(fixture.taskAttempts.get('MAP-INIT-SEC-1')).toBe(2)
    expect(fixture.taskAttempts.get('MAP-INIT-SEC-2')).toBe(1)
    expect(fixture.subagents.followup.mock.calls[0]![2][0]!.text).toContain(
      completedBeforeRepair ? 'EVIDENCE_MAPPING_PARTIAL_MISSING' : 'EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID',
    )
    const child = fixture.children.get('child-1')!
    expect(child.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'web_search')).toHaveLength(1)
  })

  it.each([
    { reverse: false },
    { reverse: true },
  ])('binds the same URL to the task whose material survives merging: %j', async ({ reverse }) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-owners-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      fixture.emitWeb(child, [search, fetch])
      for (const mapping of result.section_mappings) mapping.web_materials = [webMaterial()]
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    const ordered = reverse ? [...fixture.starts].reverse() : fixture.starts
    ordered.forEach((start) => { start.resolve() })
    await execution

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(ledger.sources).toHaveLength(2)
    for (const [index, mapping] of map.section_mappings.entries()) {
      const bound = mapping.web_materials[0]!
      const source = ledger.sources.find(source => source.source_id === bound.source_id)!
      const taskId = `MAP-INIT-SEC-${index + 1}`
      expect(bound.snapshot_path).toBe(source.snapshot_path)
      const content = await readFile(join(workspace.sessionRoot, source.snapshot_path), 'utf8')
      expect(content).toContain(`${taskId} 正文`)
      expect(source.content_sha256).toBe(webEvidenceContentSha256(content))
    }
  })

  it('目录深化保留同 section_id 的 Evidence，不运行 supplemental Task', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-supplement-')), 'session')
    const inputs = await writeInputs(workspace)
    const refined = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), 'utf8')))
    refined.sections[0]!.title = '深化后的技术响应'
    const fixture = mappingFixture(workspace, inputs, false, refined)
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      fixture.emitWeb(child, [search, fetch])
      result.section_mappings[0]!.web_materials = [webMaterial()]
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    const bound = map.section_mappings[0]!.web_materials[0]!
    expect(ledger.sources).toHaveLength(2)
    expect(fixture.starts).toHaveLength(2)
    expect(await readFile(join(workspace.sessionRoot, bound.snapshot_path), 'utf8')).toContain('MAP-INIT-SEC-1 正文')
  })

  it.each(['fetch only', 'sibling search', 'late search', 'unknown URL'])('成功 fetch 不依赖 %s 的搜索证明', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-reject-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      if (result.task_id === 'MAP-INIT-SEC-1') {
        if (scenario === 'sibling search') fixture.emitWeb(child, [search])
        return
      }
      result.section_mappings[0]!.web_materials = [webMaterial()]
      fixture.emitWeb(child, scenario === 'late search' ? [fetch, search]
        : scenario === 'unknown URL' ? [{ ...search, result: { ...search.result, value: { sources: [{ url: 'https://other.example/a' }] } } as ToolExecutionResult }, fetch]
          : [fetch])
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await expect(execution).resolves.toHaveLength(4)
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[1]!.web_materials).toHaveLength(1)
  })

  it('reports each normalized invalid URL once across sections', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-dedup-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((_child, result) => {
      result.section_mappings.forEach((mapping, index) => {
        mapping.web_materials = [webMaterial(`${webUrl}#${index}`), webMaterial(`${webUrl}?different=1`)]
      })
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ attempts: Array<{ issues: Array<{ code: string }> }> }>
    }
    expect(log.tasks[0]!.attempts[0]!.issues).toHaveLength(2)
    expect(log.tasks[0]!.attempts[0]!.issues.every(issue => issue.code === 'EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID')).toBe(true)
  })

  it.each(['schema', 'unknown-file'] as const)('同批某章节 material %s 无效时保留其他章节资料', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-group-material-')), 'session')
    const material = await writeInputs(workspace)
    const path = join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json')
    const outline = parseOutlineArtifact(JSON.parse(await readFile(path, 'utf8')))
    const branch = { ...outline.sections[0]!, id: 'BRANCH', writable: false, must_answer: [], scoring_response_point_ids: [], scoring_response_points: [] }
    const other = { ...outline.sections[1]!, id: 'OTHER', order: 2, title: '其他业务' }
    outline.sections.forEach((section) => { section.parent_id = 'BRANCH'; section.level = 2 })
    outline.sections.unshift(branch)
    outline.sections.push(other)
    await writeFile(path, JSON.stringify(outline))
    const fixture = mappingFixture(workspace, material)
    fixture.onReply.mockImplementation((_child, result) => {
      const mapping = result.section_mappings.find(item => item.section_id === 'SEC-1')
      if (mapping === undefined) return
      mapping.local_materials[0] = { ...mapping.local_materials[0]! }
      if (scenario === 'schema') (mapping.local_materials[0] as unknown as { usage: string }).usage = 'invalid'
      else mapping.local_materials[0]!.file_id = 'unknown'
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 3 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings.find(item => item.section_id === 'SEC-1')).toMatchObject({ local_materials: [], missing_topics: [expect.any(String)] })
    expect(map.section_mappings.find(item => item.section_id === 'SEC-2')!.local_materials).toHaveLength(1)
    expect(fixture.subagents.followup).toHaveBeenCalledTimes(1)
  })

  it('Host 按顶层业务分支生成任务，Main Agent 仅执行一次目录深化与复核', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-executor-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    expect(fixture.maxActive()).toBe(2)
    await expect(readEvidenceMappingProgress(workspace)).resolves.toEqual({
      total: 2,
      initial: 2,
      supplemental: 0,
      completed: 0,
      running: 2,
      not_started: 0,
      failed: 0,
    })
    expect(promptText(fixture.starts[0]!.request.request)).toContain('当前 Section Blueprints：[{"id":"SEC-1"')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('相关 Requirements：[{"id":"R-1"')
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain('"id":"R-2"')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('不得脱离当前 Section 做全局资料搜集')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('提交前逐项检查')
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.tender.fileId)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.tender.path)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.framework.fileId)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.framework.path)
    expect(promptText(fixture.starts[0]!.request.request)).toContain(material.referenceBid.fileId)
    for (const start of fixture.starts) {
      expect(start.request.request).toMatchObject({ maxDepth: 1, toolFilter: { allow: ['grep', 'read', 'web_search', 'web_fetch'] } })
    }
    const childReadGuard = fixture.guards.at(-1)
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.sessionRoot, material.tender.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBe('S4 Mapping Child 只允许 grep 资料分块目录或文件，read 资料索引或已登记分块文件。')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.sessionRoot, material.framework.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBe('S4 Mapping Child 只允许 grep 资料分块目录或文件，read 资料索引或已登记分块文件。')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.sessionRoot, material.referenceBid.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBeUndefined()
    fixture.starts.forEach((start) => { start.resolve() })
    await expect(execution).resolves.toHaveLength(4)
    await expect(readEvidenceMappingProgress(workspace)).resolves.toEqual({
      total: 2,
      initial: 2,
      supplemental: 0,
      completed: 2,
      running: 0,
      not_started: 0,
      failed: 0,
    })

    const map = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')) as { section_mappings: Array<{ section_id: string; local_materials: unknown[] }> }
    expect(map.section_mappings.find(item => item.section_id === 'SEC-1')?.local_materials).toHaveLength(1)
    const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { observed_max_concurrency: number; tasks: Array<{ final_child_session_id: string | null }> }
    expect(log.observed_max_concurrency).toBe(2)
    expect(log.tasks.every(item => item.final_child_session_id !== null)).toBe(true)
    expect(parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8'))).sources).toEqual([])
    expect(fixture.followup).toHaveBeenCalledTimes(2)
    expect(fixture.followup.mock.calls.every(call => !JSON.stringify(call).includes('Main-Agent Planning'))).toBe(true)
    expect(fixture.disposed).toHaveLength(2)
  })

  it('repairs only the failed Mapping Child without rerunning an accepted sibling', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-repair-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material, true)

    await executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    expect(fixture.taskAttempts.get('MAP-INIT-SEC-1')).toBe(2)
    expect(fixture.taskAttempts.get('MAP-INIT-SEC-2')).toBe(1)
    expect(fixture.subagents.startContinuable).toHaveBeenCalledTimes(2)
    expect(fixture.subagents.followup).toHaveBeenCalledTimes(1)
    const repairPrompt = fixture.subagents.followup.mock.calls[0]?.[2]?.[0]
    if (repairPrompt === undefined) throw new Error('missing continuable repair prompt')
    expect(repairPrompt.text).toContain('EVIDENCE_MAPPING_PARTIAL_MISSING')
    const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; attempts: Array<{ child_session_id: string }> }>
    }
    expect(new Set(log.tasks.find(item => item.task_id === 'MAP-INIT-SEC-1')!.attempts.map(item => item.child_session_id))).toEqual(new Set(['child-1']))
  })

  it('目录深化拆分章节继承原资料，不启动补映射', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-refinement-')), 'session')
    const material = await writeInputs(workspace)
    const initial = JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), 'utf8')) as {
      sections: Array<Record<string, unknown>>
    }
    const first = initial.sections[0]!
    const refined = {
      ...initial,
      sections: [
        {
          ...first,
          writable: false,
          must_answer: [],
          requirement_ids: [],
          scoring_ids: [],
          scoring_response_point_ids: [],
          scoring_response_points: [],
        },
        {
          ...first,
          id: 'NEW-CLASSIFICATION',
          parent_id: 'SEC-1',
          title: '数据分类分级',
          order: 1,
          level: 2,
        },
        {
          ...first,
          id: 'NEW-AUDIT',
          parent_id: 'SEC-1',
          title: '访问控制与安全审计',
          order: 2,
          level: 2,
        },
        initial.sections[1]!,
      ],
    }
    const fixture = mappingFixture(workspace, material, false, refined)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 1,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.slice(0, 2).forEach((start) => { start.resolve() })
    await execution
    expect(fixture.starts).toHaveLength(2)

    const finalOutline = JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8')) as {
      sections: Array<{ id: string; parent_id: string | null; writable: boolean; title: string }>
    }
    expect(finalOutline).not.toEqual(initial)
    expect(finalOutline.sections.map(section => section.id)).toEqual(['SEC-1', 'SEC-003', 'SEC-004', 'SEC-2'])
    expect(finalOutline.sections.filter(section => section.parent_id === 'SEC-1').map(section => section.title))
      .toEqual(['数据分类分级', '访问控制与安全审计'])
    expect(finalOutline.sections.find(section => section.id === 'SEC-1')?.writable).toBe(false)
    const map = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')) as {
      section_mappings: Array<{ section_id: string }>
    }
    expect(map.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-003', 'SEC-004', 'SEC-2'])
    const evidence = parseEvidenceMapArtifact(map)
    expect(evidence.section_mappings[0]!.local_materials).toHaveLength(1)
    expect(evidence.section_mappings[0]!.missing_topics.join()).toContain('重新筛选')
  })

  it('rejects a local material whose declared source kind does not match the manifest role', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-tender-material-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material.tender)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await expect(execution).resolves.toHaveLength(4)
    await expect(readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8'))
      .resolves.toContain('本地资料不可用')
  })

  it('fails before planning when spawn cannot enforce an independent structured Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-provider-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.subagents.getProvider.mockReturnValue({
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: true,
    })
    await expect(executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))).rejects.toThrow('fresh-context spawn subagent provider')
    expect(fixture.followup).not.toHaveBeenCalled()
  })
})

describe('S4 Host 准入与最终确认', () => {
  it('Prompt locator 在真实 Child cwd 下可直接使用，grep 与 read 权限独立', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-locators-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    const line = promptText(fixture.starts[0]!.request.request).split('\n').find(line => line.startsWith('可用 Corpus 定位：'))!
    const locators = JSON.parse(line.slice('可用 Corpus 定位：'.length)) as Array<{ chunks_path: string; chunk_index_path: string }>
    expect(locators[0]!.chunks_path).toBe(locations[0]!.chunks_path)
    expect(await readFile(locators[0]!.chunk_index_path, 'utf8')).toContain('chunk_0001')
    const guard = (name: string, path: string) => mappingCorpusToolGuard(locations, 'session', {
      name, arguments: name === 'read' ? { file_path: path } : { path },
      agent: { session: { header: { cwd: workspace.root, origin: 'subagent', parentSession: 'session' } } },
    } as unknown as ToolExecution)
    for (const location of locations) {
      expect(guard('grep', location.chunks_path)).toBeUndefined()
      expect(guard('grep', location.chunks[0]!.path)).toBeUndefined()
      expect(guard('read', location.chunks[0]!.path)).toBeUndefined()
      expect(guard('read', location.chunk_index_path)).toBeUndefined()
      expect(guard('read', location.chunks_path)).toBeDefined()
      expect(guard('grep', location.chunk_index_path)).toBeDefined()
      if (process.platform === 'win32') expect(guard('read', location.chunks[0]!.path.replaceAll('\\', '/').toUpperCase())).toBeUndefined()
    }
    for (const path of [material.tender.path, material.framework.path, '../outside.md', 'corpus/reference.md/document.md']) {
      for (const name of ['read', 'grep']) expect(guard(name, join(workspace.sessionRoot, path))).toBeDefined()
    }
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
  })

  it.each(['missing', 'invalid', 'chunk-missing', 'traversal', 'linked'] as const)('Corpus %s 在任何 Child 启动前失败', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-preflight-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const location = locations[0]!
    if (scenario === 'missing') await rm(location.chunk_index_path)
    if (scenario === 'invalid') await writeFile(location.chunk_index_path, '{')
    if (scenario === 'chunk-missing') await rm(location.chunks[0]!.path)
    if (scenario === 'traversal') {
      const index = JSON.parse(await readFile(location.chunk_index_path, 'utf8')) as { chunks: Array<{ path: string }> }
      index.chunks[0]!.path = '../../document.md'
      await writeFile(location.chunk_index_path, JSON.stringify(index))
    }
    if (scenario === 'linked') {
      await rm(location.chunk_index_path)
      await symlink(workspace.root, location.chunk_index_path, 'junction')
    }
    await expect(executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))).rejects.toThrow('EVIDENCE_MAPPING_CORPUS_INVALID')
    expect(fixture.starts).toHaveLength(0)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
    expect(fixture.followup).not.toHaveBeenCalled()
    const log = await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')
    expect(log).toContain(location.file_id)
    expect(log).toContain(location.name)
    const executionLog = JSON.parse(log) as { tasks: Array<{ status: string }> }
    expect(executionLog.tasks.every(task => task.status === 'failed')).toBe(true)
  })

  it('JSON 语法错误仅在原 Child 修复', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-json-repair-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeReply.mockImplementationOnce(() => '{')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    expect(fixture.subagents.followup).toHaveBeenCalledOnce()
    expect(fixture.starts).toHaveLength(2)
  })

  it.each(['SEARCH_INVALID_PATTERN', 'SEARCH_RAW_OUTPUT_OVERFLOW', 'SEARCH_ABORTED', undefined])('grep %s 允许当前 Child 调整搜索，不中止 Sibling', async (code) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-grep-repair-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const [location] = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    const child = fixture.children.get('child-1')!
    const exec = { agent: child, callId: 'grep-invalid', name: 'grep', arguments: { path: location!.chunks_path, pattern: '[' } } as unknown as ToolExecution
    fixture.emitToolResult(exec, { isError: true, error: { message: '请调整搜索条件', ...(code === undefined ? {} : { info: { name: 'SearchError', code } }) }, content: [{ type: 'text', text: '请调整搜索条件' }] })
    expect(fixture.starts.every(start => !start.request.signal?.aborted)).toBe(true)
    fixture.emitToolResult({ ...exec, callId: 'grep-corrected' as ToolExecution['callId'], arguments: { path: location!.chunks_path, pattern: '技术' } }, { isError: false, value: { matches: [] }, content: [{ type: 'text', text: 'No matches found' }] })
    fixture.starts.forEach(start => start.resolve())
    await execution
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it.each([
    ['json', 'OUTLINE_REFINEMENT_JSON_INVALID'],
    ['schema', 'OUTLINE_REFINEMENT_SCHEMA_INVALID'],
    ['structure', 'OUTLINE_SHARED_SECTION_PARENT_UNKNOWN'],
    ['quality', 'OUTLINE_REFINEMENT_SCHEMA_INVALID'],
  ])('目录深化 %s 由 Validator 引导修复，成功 Mapping Child 不重跑', async (kind, code) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-repair-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    if (kind === 'quality') fixture.serializeQuality.mockReturnValueOnce('{}')
    else fixture.serializeOutline.mockImplementationOnce((content) => {
      if (kind === 'json') return '{'
      if (kind === 'schema') return '{}'
      const outline = parseOutlineArtifact(JSON.parse(content))
      outline.sections[0]!.parent_id = 'missing-parent'
      return JSON.stringify(outline)
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const repairs = fixture.followup.mock.calls.filter(call => JSON.stringify(call).includes('Outline Refinement Repair'))
    expect(repairs).toHaveLength(1)
    expect(JSON.stringify(repairs)).toContain(code)
    expect(fixture.starts).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it('目录深化 repair 耗尽保留模型产物错误及已完成 Mapping Task', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-exhausted-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeOutline.mockReturnValue('{')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 2 })
    const rejection = expect(execution).rejects.toMatchObject({ issues: [{ code: 'OUTLINE_REFINEMENT_JSON_INVALID', artifact: 'outline/refined-outline.candidate.json' }] })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await rejection
    expect(fixture.followup.mock.calls.filter(call => JSON.stringify(call).includes('Outline Refinement Repair'))).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1])
    const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { failure: Array<{ code: string }>; tasks: Array<{ status: string }> }
    expect(log.failure.map(issue => issue.code)).toEqual(['OUTLINE_REFINEMENT_JSON_INVALID'])
    expect(log.tasks.map(task => task.status)).toEqual(['completed', 'completed'])
  })

  it.each(['provider', 'filesystem', 'host-invariant'] as const)('目录深化 %s 立即失败，不进入模型 repair', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-infra-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeOutline.mockImplementation(() => { throw new Error('provider unavailable') })
    if (scenario !== 'provider') fixture.serializeOutline.mockImplementation(content => content)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 2 })
    const rejection = expect(execution).rejects.toThrow('EVIDENCE_MAPPING_INFRASTRUCTURE_ERROR')
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    if (scenario !== 'provider') {
      const manifest = await workspace.readManifest()
      const framework = manifest.files.find(file => file.role === 'outline_framework')!
      const path = join(workspace.sessionRoot, framework.chunkIndexPath!)
      if (scenario === 'filesystem') await rm(path)
      else await writeFile(path, '{')
    }
    fixture.starts.forEach(start => start.resolve())
    await rejection
    expect(fixture.followup.mock.calls.filter(call => JSON.stringify(call).includes('Outline Refinement Repair'))).toHaveLength(0)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it.each(['invalid-json', 'agent-error', 'provider'] as const)('单 Task %s 降级，不取消其他 Task，最多修复一次', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-task-fallback-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    if (scenario === 'invalid-json') fixture.serializeReply.mockImplementation(value => value.task_id === 'MAP-INIT-SEC-1' ? '{' : JSON.stringify(value))
    if (scenario === 'agent-error') fixture.onReply.mockImplementation((child, result) => {
      if (result.task_id === 'MAP-INIT-SEC-1') (child.session.events as unknown[]).push({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '模型异常' } } } })
    })
    if (scenario === 'provider') fixture.subagents.startContinuable.mockRejectedValueOnce(new Error('child unavailable'))
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 5 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(scenario === 'provider' ? 1 : 2) })
    if (scenario !== 'provider') {
      fixture.starts[0]!.resolve()
      await vi.waitFor(() => { expect(fixture.disposed).toContain('child-1') })
    }
    expect(fixture.starts.every(start => !start.request.signal?.aborted)).toBe(true)
    fixture.starts.at(-1)!.resolve()
    await expect(execution).resolves.toHaveLength(4)
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[0]!.local_materials).toEqual([])
    expect(map.section_mappings[0]!.missing_topics.length).toBeGreaterThan(0)
    expect(map.section_mappings[1]!.local_materials).toHaveLength(1)
    expect(fixture.subagents.followup.mock.calls.length).toBe(scenario === 'invalid-json' ? 1 : 0)
  })

  it('空 Evidence 合法，本地 chunk 不需要 Child read 日志证明', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-empty-evidence-')), 'session')
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((_child, result) => {
      result.section_mappings[0]!.local_materials = []
      result.section_mappings[0]!.missing_topics = ['无可靠资料，无需联网']
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    expect((await readEvidenceMappingProgress(workspace))!.completed).toBe(2)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
    fixture.onReply.mockImplementation((child) => { (child.session.events as unknown[]).splice(0) })
    const unread = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(4) })
    fixture.starts.slice(2).forEach((start) => { start.resolve() })
    await expect(unread).resolves.toHaveLength(4)
  })

  it.each(['add', 'purpose', 'must_answer', 'scoring', 'order', 'delete', 'delete-unused', 'split'] as const)('最终确认 %s：直接 reconcile 并发布确认文件', async (edit) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-confirm-')), 'session')
    const material = await writeInputs(workspace)
    if (edit === 'delete-unused') {
      const path = join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json')
      const outline = parseOutlineArtifact(JSON.parse(await readFile(path, 'utf8')))
      outline.sections[0]!.requirement_ids.push(...outline.sections[1]!.requirement_ids)
      outline.sections[0]!.scoring_ids.push(...outline.sections[1]!.scoring_ids)
      outline.sections[0]!.scoring_response_point_ids!.push(...outline.sections[1]!.scoring_response_point_ids!)
      outline.sections[0]!.scoring_response_points.push(...outline.sections[1]!.scoring_response_points)
      await writeFile(path, JSON.stringify(outline))
    }
    const fixture = mappingFixture(workspace, material)
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      fixture.emitWeb(child, [search, fetch])
      result.section_mappings[0]!.web_materials = [webMaterial()]
    })
    const initial = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await initial
    const initialLedger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const session = ctx.sessions.create(SessionId('session'), { meta: { cwd: workspace.root, agentPreset: 'bid' } })
    for (const stage of ['file_intake', 'tender_analysis', 'outline_generation'] as const) {
      session.append('bid.stage.started', { stage, status: 'running' })
      session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
    session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
    Object.assign(fixture.agent, { session })
    const draft = await getOrCreateOutlineDraft(workspace)
    const candidate = structuredClone(draft.outline)
    if (edit === 'add') candidate.sections.push({ ...candidate.sections[0]!, id: 'SEC-NEW', title: '新增章节', order: 3 })
    if (edit === 'purpose') candidate.sections[0]!.purpose = '新的研究主题'
    if (edit === 'must_answer') candidate.sections[0]!.must_answer.push('新增回答要求')
    if (edit === 'scoring') {
      candidate.sections[0]!.scoring_ids.push('S-2')
      candidate.sections[0]!.scoring_response_point_ids!.push('RP-000002')
      candidate.sections[0]!.scoring_response_points.push(candidate.sections[1]!.scoring_response_points[0]!)
    }
    if (edit === 'order') { candidate.sections[0]!.order = 2; candidate.sections[1]!.order = 1 }
    if (edit === 'delete') {
      candidate.sections[0]!.requirement_ids.push(...candidate.sections[1]!.requirement_ids)
      candidate.sections[0]!.scoring_ids.push(...candidate.sections[1]!.scoring_ids)
      candidate.sections[0]!.scoring_response_point_ids!.push(...candidate.sections[1]!.scoring_response_point_ids!)
      candidate.sections[0]!.scoring_response_points.push(...candidate.sections[1]!.scoring_response_points)
      candidate.sections.pop()
    }
    if (edit === 'delete-unused') candidate.sections.pop()
    if (edit === 'split') {
      const original = structuredClone(candidate.sections[0]!)
      candidate.sections[0]!.writable = false
      candidate.sections[0]!.must_answer = []
      candidate.sections[0]!.scoring_response_point_ids = []
      candidate.sections[0]!.scoring_response_points = []
      candidate.sections.push(...[1, 2].map(order => ({ ...original, id: `SPLIT-${order}`, title: `拆分章节${order}`, parent_id: original.id, level: 2, order })))
    }
    const changed = await replaceOutlineDraft(workspace, {
      expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256,
    }, candidate)
    if (!changed.ok) throw new Error(changed.error.message)
    const current = changed.value
    const host = Object.create(BidHostRuntime.prototype) as BidHostRuntime
    Object.assign(host, {
      ctx: { agents: { get: () => fixture.agent }, sessions: { flush: async () => {} } },
      config: { allowedExtensions: ['.md'], maxFiles: 20, maxFileBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, modelStageRepairAttempts: 0, evidenceMappingMaxConcurrency: 2, chapterWritingMaxConcurrency: 1, trustedHosts: [] } satisfies Config,
      inFlight: new Map(),
      automaticOrchestrator: () => new BidOrchestrator(session,
        { canExecute: () => false, execute: async () => [] },
        { validate: (stage, artifacts) => validateEvidenceMapping(workspace, stage, artifacts) }),
    })
    const confirming = host.confirmOutline(session, {
      expected_revision: current.revision, expected_draft_sha256: current.draft_outline_sha256,
    })
    const result = await confirming
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(fixture.starts).toHaveLength(2)
    expect(session.events.filter(event => event.type === 'bid.stage.started' && event.data.stage === 'evidence_mapping')).toHaveLength(1)
    {
      const confirmed = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8')))
      const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
      expect(validateSectionEvidenceCoverage(confirmed, evidence)).toEqual([])
      expect(parseOutlineConfirmationArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmation.json'), 'utf8'))).decision).toBe('confirmed')
      if (edit === 'delete') expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1'])
      if (edit === 'order') expect(fixture.starts).toHaveLength(2)
      if (edit === 'delete-unused') {
        expect(fixture.starts).toHaveLength(2)
        expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1'])
        const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
        expect(ledger.sources).toEqual([initialLedger.sources[0]])
        await expect(readFile(join(workspace.sessionRoot, initialLedger.sources[1]!.snapshot_path), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(workspace.sessionRoot, initialLedger.sources[0]!.snapshot_path), 'utf8')).toContain('MAP-INIT-SEC-1 正文')
      }
      if (edit === 'add') expect(evidence.section_mappings.find(mapping => mapping.section_id === 'SEC-NEW')).toMatchObject({ local_materials: [], web_materials: [], missing_topics: [expect.any(String)] })
      if (edit === 'split') for (const mapping of evidence.section_mappings.filter(mapping => mapping.section_id.startsWith('SPLIT-'))) {
        expect(mapping.local_materials).toHaveLength(1)
        expect(mapping.web_materials).toHaveLength(1)
        expect(mapping.missing_topics.join()).toContain('重新筛选')
      }
    }
    await ctx.fiber.dispose()
  })
})

describe('S4 / S5 共用 fetch 正文快照', () => {
  const captured = (value: unknown, isError = false) => ({
    exec: { name: 'web_fetch', arguments: { url: webUrl } } as unknown as ToolExecution,
    result: isError ? { isError: true, content: [], error: { message: 'fetch failed' } } as ToolExecutionResult
      : { isError: false, value, content: [] } as ToolExecutionResult,
  })
  const value = { url: webUrl, statusCode: 200, body: { content: '正文' }, truncated: false }
  it('只有成功 fetch 也生成正文 Snapshot 与 hash，无需 call id / event seq / search', () => {
    const snapshots = buildWebEvidenceSnapshots([captured(value)])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ content: '正文', source: { status_code: 200, content_sha256: webEvidenceContentSha256('正文') } })
    expect(snapshots[0]!.source).not.toHaveProperty('fetch_call_id')
    expect(buildWebEvidenceSnapshots([captured(value), captured(value)])).toHaveLength(1)
  })
  it.each([
    { ...value, statusCode: 404 }, { ...value, statusCode: 302 },
    { ...value, url: 'file:///private' }, { ...value, body: { content: '  ' } },
  ])('拒绝失败、非 HTTP 或空正文：%j', (input) => {
    expect(buildWebEvidenceSnapshots([captured(input)])).toEqual([])
  })
  it('忽略 fetch 工具错误', () => {
    expect(buildWebEvidenceSnapshots([captured(value, true)])).toEqual([])
  })
})
