import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import type { ContinuableStartSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  BidHostRuntime,
  BidOrchestrator,
  checkpointBidProjectState,
  getOrCreateOutlineDraft,
  replaceOutlineDraft,
  validateEvidenceMapping,
  validateSectionEvidenceCoverage,
  parseOutlineConfirmationArtifact,
  type Config,
  buildBidStageTask,
  buildWebEvidenceSnapshots,
  applyOutlineEdits,
  createScoringResponsePointCatalog,
  executeEvidenceMapping,
  parseWebEvidenceSourcesArtifact,
  parseEvidenceMapArtifact,
  parseScoringResponsePointCatalog,
  parseOutlineArtifact,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  pickChapterContext,
  readEvidenceMappingProgress,
  resolveMappingCorpusLocations,
  mappingCorpusToolGuard,
  webEvidenceContentSha256,
  type EvidenceMappingPartialResult,
  type EvidenceMappingTask,
  type OutlineEditOperation,
  type OutlineSection,
  type LocalEvidenceMaterial,
  type SectionEvidenceMapping,
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
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['背景'], project_objectives: ['目标'], project_scope: ['范围'], technical_scope: ['技术'], delivery_scope: ['交付'], implementation_constraints: [], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: [tender.id] })),
    writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [1, 2].map(value => ({ id: `R-${value}`, category: '技术', raw_text: `要求${value}`, normalized_requirement: `响应要求${value}`, mandatory: true, source_refs: source })) })),
    writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring)),
    writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [1, 2].map(value => ({ scoring_id: `S-${value}`, order: 1, text: `响应点${value}` })) }))),
    writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] })),
  ])
  const outline = {
    schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [1, 2].map(value => ({
      id: `SEC-${value}`, parent_id: null, order: value, level: 1, title: `章节${value}`, purpose: `响应主题${value}`, writable: true,
      must_answer: [`响应主题${value}`], requirement_ids: [`R-${value}`], scoring_ids: [`S-${value}`], compliance_ids: [], origin: 'generated',
      scoring_response_point_ids: [`RP-${String(value).padStart(6, '0')}`], scoring_response_points: [{ scoring_id: `S-${value}`, response_point: `响应点${value}` }], suggested_tables: [], suggested_figures: [], writing_notes: [],
    })),
  }
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(outline)),
    writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })),
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
  outlineOperations: Readonly<Record<string, readonly OutlineEditOperation[]>> = {},
) {
  let pendingMain = ''
  let active = 0
  let maxActive = 0
  let sequence = 0
  const starts: Array<{ request: ContinuableStartSpec; resolve(): void }> = []
  const finalStarts: Array<{ request: ContinuableStartSpec; resolve(): void }> = []
  const taskAttempts = new Map<string, number>()
  const disposed: string[] = []
  const serializeReply = vi.fn((value: EvidenceMappingPartialResult) => JSON.stringify(value))
  const submissionCandidates = vi.fn((value: unknown): unknown[] => [value])
  const submissionResults: Readonly<ToolExecutionResult>[] = []
  const serializeQuality = vi.fn((content: string) => content)
  const onReply = vi.fn<(child: Agent, result: EvidenceMappingPartialResult, attempt: number) => void>()
  const onFinalReply = vi.fn<(child: Agent, result: EvidenceMappingPartialResult, attempt: number) => void>()
  const fileRefs = new Map<string, { file_id: string; source_kind: 'reference' | 'reference_bid' }>()
  type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
  const childGuards = new Map<string, ToolGuard[]>()
  let createdObserver: ((payload: { agent: Agent }) => void) | undefined
  let webObserver: ((exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) | undefined
  let continuableSetup: ((childCtx: Context) => () => void) | undefined
  const setupDisposers = new Map<string, () => void>()
  const submissionTools = new Map<string, ToolDefinition>()
  const resultObservers = new Map<string, Array<(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void>>()
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
    const lines = promptText(request).split('\n')
    const field = (prefix: string): unknown => {
      const line = lines.find(value => value.startsWith(prefix))
      return line === undefined ? undefined : JSON.parse(line.slice(prefix.length))
    }
    const task = field('Mapping Task：') as EvidenceMappingTask
    const sections = field('当前 Section Blueprints：') as OutlineSection[]
    const current = field('当前章节资料与已知缺口：') as Array<Omit<SectionEvidenceMapping, 'local_materials'> & { local_materials: Array<LocalEvidenceMaterial & { file_ref?: string }> }> | undefined
    const snapshots = field('已登记 Web 正文定位：') as Array<{ url: string; path: string }> | undefined
    const attempt = (taskAttempts.get(task.task_id) ?? 0) + 1
    taskAttempts.set(task.task_id, attempt)
    const sourceKind = [...fileRefs.values()].find(identity => identity.file_id === material.fileId)?.source_kind ?? 'reference'
    const local = { source_kind: sourceKind, file_id: material.fileId, chunk: material.chunk, usage: 'reference' as const, summary: '统一资料。' }
    const operations = outlineOperations[task.task_id] ?? []
    let mappingSections = sections
    if (task.phase === 'initial' && operations.length > 0) {
      let allocated = 0
      const projected = applyOutlineEdits({
        schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections,
      }, operations, () => `NEW-${task.task_id.replaceAll(/[^A-Za-z0-9]+/gu, '-')}-${String(++allocated).padStart(3, '0')}`)
      mappingSections = projected.sections.filter(section => section.writable)
    }
    const result: EvidenceMappingPartialResult = {
      task_id: task.task_id,
      section_mappings: repairFirst && task.task_id === 'MAP-INIT-SEC-1' && attempt === 1
        ? []
        : mappingSections.map((section) => {
          const section_id = section.id
          const previous = current?.find(item => item.section_id === section_id)
          return {
            section_id,
            local_materials: previous?.local_materials.map(({ file_ref, ...item }) => (
              file_ref === undefined ? item : { ...item, ...fileRefs.get(file_ref)! }
            )) ?? [local],
            web_materials: previous?.web_materials.map(item => ({
              url: snapshots!.find(snapshot => snapshot.path.replaceAll('\\', '/').endsWith(item.snapshot_path))!.url,
              usage: item.usage, summary: item.summary, supports: item.supports,
            })) ?? [],
            missing_topics: previous?.missing_topics ?? [], writing_dimensions: previous?.writing_dimensions.length ? previous.writing_dimensions : ['技术响应'],
            writing_brief: {
              purpose: section.purpose, must_answer: section.must_answer, writing_notes: section.writing_notes,
              suggested_tables: section.suggested_tables, suggested_figures: section.suggested_figures,
              requirement_ids: section.requirement_ids, scoring_ids: section.scoring_ids,
              scoring_response_point_ids: section.scoring_response_point_ids ?? [],
            },
          }
        }),
      refinement_suggestions: [],
    }
    if (task.phase === 'final_check') {
      const outline = field('最终目录各节点（仅用于理解上下文及总结）：') as OutlineSection[]
      result.branch_summaries = outline.filter(section => !section.writable).map(section => ({
        section_id: section.id, summary: section.summary ?? '说明各实施任务的技术方法、责任分工和交付条件。',
      }))
      onFinalReply(child, result, attempt)
    } else onReply(child, result, attempt)
    return result
  }
  const submissionArgs = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const result = value as Record<string, unknown>
    if (!Array.isArray(result.section_mappings)) return value
    return {
      ...result,
      ...(typeof result.task_id === 'string' && result.task_id.startsWith('MAP-INIT-') && result.outline_operations === undefined
        ? { outline_operations: outlineOperations[result.task_id] ?? [] }
        : {}),
      ...(result.task_id === 'MAP-FINAL-CHECK' && result.unchanged_section_ids === undefined
        ? { unchanged_section_ids: [] }
        : {}),
      section_mappings: result.section_mappings.map((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return candidate
        const mapping = candidate as Record<string, unknown>
        if (!Array.isArray(mapping.local_materials)) return candidate
        return { ...mapping, local_materials: mapping.local_materials.map((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
          const materialEntry = entry as Record<string, unknown>
          const fileRef = [...fileRefs].find(([, identity]) => identity.file_id === materialEntry.file_id)?.[0]
          if (fileRef === undefined) return entry
          const expected = fileRefs.get(fileRef)
          const { file_id: _fileId, source_kind: _sourceKind, ...fields } = materialEntry
          return expected?.source_kind === materialEntry.source_kind
            ? { ...fields, file_ref: fileRef }
            : { ...fields, file_ref: fileRef, source_kind: materialEntry.source_kind }
        }) }
      }),
    }
  }
  let submissionSequence = 0
  const submitReply = async (request: ContinuableStartSpec, child: Agent): Promise<void> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(serializeReply(partial(request.request, child)))
    } catch {
      parsed = undefined
    }
    const tool = submissionTools.get(String(child.id))
    if (parsed !== undefined && tool !== undefined) {
      for (const candidate of submissionCandidates(submissionArgs(parsed))) {
        const token = {} as ToolExecution['token']
        const exec = {
          agent: child,
          callId: `submit-${++submissionSequence}`,
          rootCallId: `submit-${submissionSequence}`,
          token,
          name: tool.name,
          arguments: candidate,
          signal: new AbortController().signal,
          deferContext: vi.fn(),
          concludeTurn: vi.fn(),
        } as unknown as ToolRunContext
        let result: Readonly<ToolExecutionResult>
        try {
          const returned = await tool.execute(candidate, exec)
          result = { isError: false, value: returned as never, content: [{ type: 'text', text: 'recorded' }] }
        } catch (error: unknown) {
          result = {
            isError: true,
            error: { message: error instanceof Error ? error.message : String(error) },
            content: [{ type: 'text', text: 'invalid' }],
          }
        }
        submissionResults.push(result)
        for (const observer of resultObservers.get(String(child.id)) ?? []) observer(exec, result)
        if (!result.isError) break
      }
    }
    ;(child.session.events as unknown[]).push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '结构化提交轮次结束。' }] }, seq: child.session.events.length },
      seq: child.session.events.length,
    })
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
    registerContinuableSetup: vi.fn((contribution: (childCtx: Context) => () => void) => {
      continuableSetup = contribution
      return () => { continuableSetup = undefined }
    }),
    startContinuable: vi.fn(async (request: ContinuableStartSpec) => {
      active++
      maxActive = Math.max(maxActive, active)
      const id = request.childId ?? SessionId(`child-${++sequence}`)
      let settleIdle!: () => void
      const idle = new Promise<void>((resolve) => { settleIdle = resolve })
      const manifest = await workspace.readManifest()
      manifest.files.filter(file => file.parseStatus === 'success' && (file.role === 'reference' || file.role === 'reference_bid'))
        .forEach((file, index) => fileRefs.set(`F${index + 1}`, { file_id: String(file.id), source_kind: file.role as 'reference' | 'reference_bid' }))
      const file = manifest.files.find(file => String(file.id) === material.fileId)!
      const readPath = join(workspace.projectRoot, file.chunksPath!, material.chunk + '.md')
      const scopedGuards: ToolGuard[] = []
      childGuards.set(String(id), scopedGuards)
      const definitions = new Map<string, ToolDefinition>()
      const observers: Array<(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void> = []
      resultObservers.set(String(id), observers)
      const childTools = {
        register: vi.fn((definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          if (definition.name === 'submit_evidence_mapping') submissionTools.set(String(id), definition)
          return () => {
            definitions.delete(definition.name)
            if (submissionTools.get(String(id)) === definition) submissionTools.delete(String(id))
          }
        }),
        guard: vi.fn((guard: ToolGuard) => {
          scopedGuards.push(guard)
          return () => { scopedGuards.splice(scopedGuards.indexOf(guard), 1) }
        }),
      }
      const childCtx = {
        tools: childTools,
        on: vi.fn((event: string, observer: (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) => {
          if (event !== 'tools/result') throw new Error(`unexpected child event ${event}`)
          observers.push(observer)
          return () => { observers.splice(observers.indexOf(observer), 1) }
        }),
      } as unknown as Context
      const localAgent = { id, status: 'running', ctx: childCtx,
        session: { id, header: { cwd: workspace.root, parentSession: 'session', origin: 'subagent' }, events: [] },
        whenIdle: () => idle } as unknown as Agent
      ;(childCtx as unknown as { agent: Agent }).agent = localAgent
      if (continuableSetup === undefined) throw new Error('missing continuable setup contribution')
      setupDisposers.set(String(id), continuableSetup(childCtx))
      createdObserver?.({ agent: localAgent })
      ;(localAgent.session.events as unknown[]).push(
        { type: 'tool/call', seq: 0, data: { name: 'read', callId: 'read-local', arguments: JSON.stringify({ file_path: readPath }) } },
        { type: 'tool/result', seq: 1, data: { message: { source: { callId: 'read-local' }, content: [{ isError: false }] } } },
      )
      const settle = () => {
        void submitReply(request, localAgent).finally(() => {
          active--
          settleIdle()
        })
      }
      children.set(String(id), localAgent)
      childRequests.set(String(id), request)
      const final = promptText(request.request).includes('"phase":"final_check"')
      ;(final ? finalStarts : starts).push({ request, resolve: settle })
      if (repairFirst || final) queueMicrotask(settle)
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
        void submitReply(request, child).finally(() => {
          active--
          settleIdle()
        })
      })
      return `message-${childId}` as never
    }),
    drainContinuableChildren: vi.fn(async (_parent: Agent, childIds: readonly SessionId[]) => {
      for (const childId of childIds) {
        setupDisposers.get(String(childId))?.()
        setupDisposers.delete(String(childId))
        disposed.push(String(childId))
      }
    }),
  }
  const tools = {
    schemas: vi.fn(() => ['read', 'write', 'grep', 'web_search', 'web_fetch'].map(name => ({ name }))),
    restrict: vi.fn(() => () => {}),
    guard: vi.fn(() => () => {}),
  }
  const followup = vi.fn((message: unknown) => { pendingMain = JSON.stringify(message) })
  const whenIdle = vi.fn(async () => {
    if (pendingMain.includes('Main-Agent Planning')) {
      throw new Error('Main Agent 不得规划 Mapping Task')
    }
    if (pendingMain.includes('quality-report.json')) {
      await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), serializeQuality(JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })))
    }
    if (pendingMain) (agent.session.events as unknown[]).push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '目录产物已写入。' }] } } })
    pendingMain = ''
  })
  const agents = { get: (id: SessionId) => children.get(String(id)) }
  const on = vi.fn((event: string, observer: NonNullable<typeof webObserver> | NonNullable<typeof createdObserver>) => {
    if (event === 'agent/created') {
      createdObserver = observer as NonNullable<typeof createdObserver>
      return () => { createdObserver = undefined }
    }
    webObserver = observer as NonNullable<typeof webObserver>
    return () => { webObserver = undefined }
  })
  const agent = { id: 'session', session: { id: 'session', header: { cwd: workspace.root }, events: [] }, ctx: { agents, get: (name: string) => ({ fs: { resolve: async (path: string) => path }, tools, subagents } as Record<string, unknown>)[name], emit: vi.fn(), on }, followup, whenIdle } as unknown as Agent
  return {
    agent, starts, finalStarts, subagents, followup, whenIdle, currentPrompt: () => pendingMain,
    childGuards, disposed, maxActive: () => maxActive, taskAttempts, onReply, onFinalReply, serializeReply, submissionCandidates,
    submissionResults,
    serializeQuality, emitWeb, children,
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
  it('Final Check 复用跨分支候选消除误报缺口，短 F1 由 Host 绑定真实文件', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-research-reuse-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.onReply.mockImplementation((_child, result) => {
      if (result.task_id === 'MAP-INIT-SEC-2') {
        result.section_mappings[0]!.local_materials = []
        result.section_mappings[0]!.missing_topics = ['缺少统一判定规则。']
      }
    })
    fixture.onFinalReply.mockImplementation((_child, result) => {
      const prompt = promptText(fixture.finalStarts[0]!.request.request)
      const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('全局候选资料池：'))!.slice('全局候选资料池：'.length)) as { local_materials: unknown[] }
      expect(candidates.local_materials).toHaveLength(1)
      expect(prompt).toContain('缺少统一判定规则。')
      const target = result.section_mappings.find(mapping => mapping.section_id === 'SEC-2')!
      target.local_materials = [{ source_kind: 'reference', file_id: material.fileId, chunk: material.chunk, usage: 'reference', summary: '支撑本章实施阶段的统一判定方法。' }]
      target.missing_topics = []
    })
    fixture.serializeReply.mockImplementation(value => JSON.stringify({ ...value, section_mappings: value.section_mappings.map(mapping => ({
      ...mapping, local_materials: mapping.local_materials.map(({ file_id: _fileId, source_kind: _sourceKind, ...item }) => ({ ...item, file_ref: 'F1' })),
    })) }))
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[1]).toMatchObject({ missing_topics: [], local_materials: [{ file_id: material.fileId, source_kind: 'reference', chunk: material.chunk }] })
    expect(map.section_mappings[1]!.local_materials[0]).not.toHaveProperty('file_ref')
  })

  it('合并章节可重新选择双方候选资料，不局限于保留的 section_id', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-research-merge-')))
    const material = await writeInputs(workspace)
    const outlinePath = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const initial = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    initial.sections.forEach((section) => { section.parent_id = 'BRANCH'; section.level = 2 })
    initial.sections.unshift({
      ...initial.sections[0]!, id: 'BRANCH', parent_id: null, order: 1, level: 1, title: '实施方案',
      writable: false, must_answer: [], scoring_response_point_ids: [], scoring_response_points: [], summary: '统一说明两个主题的实施过程。',
    })
    await writeFile(outlinePath, JSON.stringify(initial))
    const second: LocalEvidenceMaterial = { source_kind: 'reference_bid', file_id: material.referenceBid.fileId, chunk: 'chunk_0001', usage: 'adapt', summary: '支撑成熟实施流程的项目适配。' }
    const fixture = mappingFixture(workspace, material, false, { 'MAP-INIT-BRANCH': [{
      type: 'merge_sections', section_ids: ['SEC-1', 'SEC-2'], title: '统一实施方案', purpose: '结合统一技术规则和成熟方案说明两个主题的实施过程。',
    }] })
    fixture.onReply.mockImplementation((_child, result) => {
      if (result.task_id === 'MAP-INIT-BRANCH') result.section_mappings[0]!.local_materials.push(second)
    })
    fixture.onFinalReply.mockImplementation((_child, result) => {
      const prompt = promptText(fixture.finalStarts[0]!.request.request)
      const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('全局候选资料池：'))!.slice('全局候选资料池：'.length)) as { local_materials: Array<{ file_ref: string }> }
      expect(candidates.local_materials.map(item => item.file_ref)).toEqual(['F1', 'F2'])
      result.section_mappings[0]!.local_materials.push(second)
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings).toHaveLength(1)
    expect(map.section_mappings[0]!.local_materials.map(item => item.file_id)).toEqual([material.fileId, material.referenceBid.fileId])
    const finalOutline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    expect(finalOutline.sections.find(section => section.writable)).toMatchObject({ requirement_ids: ['R-1', 'R-2'], scoring_response_point_ids: ['RP-000001', 'RP-000002'] })
  })

  it('Final Check 未成功结构化提交时只修复一次并拒绝阶段', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-research-bad-reference-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.onFinalReply.mockImplementation((_child, result) => {
      const mapping = result.section_mappings[0]!
      mapping.local_materials.push({ ...mapping.local_materials[0]!, file_id: 'unknown-file' })
      mapping.local_materials.push({ ...mapping.local_materials[0]!, chunk: 'chunk_9999' })
      mapping.web_materials.push(webMaterial('https://unfetched.example/rule'))
    })
    fixture.serializeReply.mockImplementation(value => JSON.stringify(value.task_id !== 'MAP-FINAL-CHECK' ? value : {
      ...value, section_mappings: value.section_mappings.map((mapping, index) => index !== 0 ? mapping : {
        ...mapping, local_materials: [...mapping.local_materials, { file_ref: 'F999', chunk: material.chunk, usage: 'reference', summary: '未知文件引用。' }],
      }),
    }))
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await expect(execution).rejects.toThrow('EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING')
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { tasks: Array<{ phase: string; attempts: Array<{ issues: Array<{ code: string }> }> }> }
    const final = log.tasks.find(task => task.phase === 'final_check')!
    expect(final.attempts).toHaveLength(2)
    expect(final.attempts[1]!.issues.map(issue => issue.code)).toEqual(['EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING'])
  })

  it('37 个节点和 27 个可写章节无需拆分即可完成研究与摘要', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-research-outline-size-')))
    const material = await writeInputs(workspace)
    const path = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const outline = parseOutlineArtifact(JSON.parse(await readFile(path, 'utf8')))
    const first = outline.sections[0]!
    const second = outline.sections[1]!
    const branch = (id: string, parent_id: string | null, order: number): OutlineSection => ({
      ...first, id, parent_id, order, level: parent_id === null ? 1 : 2, title: id, writable: false,
      must_answer: [], scoring_response_point_ids: [], scoring_response_points: [],
    })
    outline.sections = [branch('ROOT', null, 1), ...Array.from({ length: 9 }, (_, index) => {
      const id = `BRANCH-${index + 1}`
      return [branch(id, 'ROOT', index + 1), ...[1, 2, 3].map(order => ({
        ...(order === 2 ? second : first), id: `${id}-LEAF-${order}`, title: `实施任务${order}`, parent_id: id, order, level: 3,
      }))]
    }).flat()]
    await writeFile(path, JSON.stringify(outline))
    const fixture = mappingFixture(workspace, material, true)
    await executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    const final = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    expect(final.sections).toHaveLength(37)
    expect(final.sections.filter(section => section.writable)).toHaveLength(27)
    expect(final.sections.filter(section => !section.writable).every(section => Boolean(section.summary))).toBe(true)
    expect(fixture.starts).toHaveLength(9)
    expect(fixture.finalStarts).toHaveLength(1)
    expect(fixture.maxActive()).toBeLessThanOrEqual(3)
  })

  it.each(['replace', 'supplement'] as const)('局部 %s 只运行选中 Section，并保留其他章节及 Web 快照', async (mode) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-targeted-remap-')))
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
    const before = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    const snapshot = before.section_mappings[0]!.web_materials[0]!.snapshot_path
    const snapshotContent = await readFile(join(workspace.projectRoot, snapshot), 'utf8')
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
    const after = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(after.section_mappings[0]).toEqual(before.section_mappings[0])
    expect(after.section_mappings[1]!.local_materials).toEqual(mode === 'replace' ? [] : before.section_mappings[1]!.local_materials)
    expect(after.section_mappings[1]!.web_materials).toEqual(mode === 'replace' ? [] : before.section_mappings[1]!.web_materials)
    expect(after.section_mappings[1]!.missing_topics).toContain('新增资料仍缺失')
    expect(await readFile(join(workspace.projectRoot, snapshot), 'utf8')).toBe(snapshotContent)
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it.each(['coverage', 'provider'] as const)('局部替换失败 %s 保留原资料与写作任务', async (failure) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-remap-failure-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const initial = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await initial
    const paths = ['analysis/evidence-map.json', 'outline/outline.json'].map(path => join(workspace.projectRoot, path))
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    fixture.starts.length = 0
    if (failure === 'provider') fixture.subagents.startContinuable.mockRejectedValueOnce(new Error('provider unavailable'))
    else fixture.onReply.mockImplementation((_child, result) => { result.section_mappings[0]!.writing_brief.requirement_ids = [] })
    const remap = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, remap: { section_ids: ['SEC-2'], mode: 'replace' },
    })
    const rejected = expect(remap).rejects.toThrow(failure === 'provider' ? 'provider unavailable' : 'OUTLINE_SHARED_REQUIREMENT_MISSING')
    if (failure === 'coverage') {
      await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
      fixture.starts[0]!.resolve()
    }
    await rejected
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before)
  })

  it('局部重新抓取同 URL 时绑定新正文，并保留未修改章节的原快照', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-remap-refetch-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((child, result) => {
      fixture.emitWeb(child, [webResearch(result.task_id).fetch])
      result.section_mappings[0]!.web_materials = [webMaterial()]
    })
    const initial = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await initial
    const mapPath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const before = parseEvidenceMapArtifact(JSON.parse(await readFile(mapPath, 'utf8')))
    fixture.starts.length = 0
    const remap = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, remap: { section_ids: ['SEC-2'], mode: 'replace' },
    })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    fixture.starts[0]!.resolve()
    await remap
    const after = parseEvidenceMapArtifact(JSON.parse(await readFile(mapPath, 'utf8')))
    expect(after.section_mappings[0]).toEqual(before.section_mappings[0])
    const latest = after.section_mappings[1]!.web_materials[0]!
    expect(latest.source_id).not.toBe(before.section_mappings[1]!.web_materials[0]!.source_id)
    expect(await readFile(join(workspace.projectRoot, latest.snapshot_path), 'utf8')).toContain('MAP-REMAP-SEC-2 正文')
  })

  it.each([
    { replaceAgent: false, completedBeforeRepair: false },
    { replaceAgent: true, completedBeforeRepair: false },
    { replaceAgent: false, completedBeforeRepair: true },
  ])('retains task Web provenance across repair: %j', async ({ replaceAgent, completedBeforeRepair }) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-repair-')))
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

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
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
    const child = fixture.children.get(String(fixture.starts[0]!.request.childId))!
    expect(child.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'web_search')).toHaveLength(1)
  })

  it.each([
    { reverse: false },
    { reverse: true },
  ])('binds the same URL to the task whose material survives merging: %j', async ({ reverse }) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-owners-')))
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

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(ledger.sources).toHaveLength(2)
    for (const [index, mapping] of map.section_mappings.entries()) {
      const bound = mapping.web_materials[0]!
      const source = ledger.sources.find(source => source.source_id === bound.source_id)!
      const taskId = `MAP-INIT-SEC-${index + 1}`
      expect(bound.snapshot_path).toBe(source.snapshot_path)
      const content = await readFile(join(workspace.projectRoot, source.snapshot_path), 'utf8')
      expect(content).toContain(`${taskId} 正文`)
      expect(source.content_sha256).toBe(webEvidenceContentSha256(content))
    }
  })

  it('目录深化保留同 section_id 的 Evidence，不运行 supplemental Task', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-supplement-')))
    const inputs = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, inputs, false, { 'MAP-INIT-SEC-1': [{ type: 'update_section', section_id: 'SEC-1', title: '深化后的技术响应' }] })
    fixture.onReply.mockImplementation((child, result) => {
      const { search, fetch } = webResearch(result.task_id)
      fixture.emitWeb(child, [search, fetch])
      result.section_mappings[0]!.web_materials = [webMaterial()]
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    const bound = map.section_mappings[0]!.web_materials[0]!
    expect(ledger.sources).toHaveLength(2)
    expect(fixture.starts).toHaveLength(2)
    expect(await readFile(join(workspace.projectRoot, bound.snapshot_path), 'utf8')).toContain('MAP-INIT-SEC-1 正文')
  })

  it.each(['fetch only', 'sibling search', 'late search', 'unknown URL'])('成功 fetch 不依赖 %s 的搜索证明', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-reject-')))
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
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[1]!.web_materials).toHaveLength(1)
  })

  it('reports each normalized invalid URL once across sections', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-dedup-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((_child, result) => {
      result.section_mappings.forEach((mapping, index) => {
        mapping.web_materials = [webMaterial(`${webUrl}#${index}`), webMaterial(`${webUrl}?different=1`)]
      })
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    const rejection = expect(execution).rejects.toBeInstanceOf(Error)
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await rejection
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ attempts: Array<{ issues: Array<{ code: string }> }> }>
    }
    expect(log.tasks[0]!.attempts[0]!.issues).toHaveLength(2)
    expect(log.tasks[0]!.attempts[0]!.issues.every(issue => issue.code === 'EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID')).toBe(true)
  })

  it.each(['schema', 'unknown-file'] as const)('提交工具拒绝同批某章节的 %s material 后允许同轮修正', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-group-material-')))
    const material = await writeInputs(workspace)
    const path = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
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
    fixture.submissionCandidates.mockImplementationOnce((value) => {
      const corrected = structuredClone(value) as {
        section_mappings: Array<{ section_id: string; local_materials: Array<Record<string, unknown>> }>
      }
      const invalid = corrected.section_mappings.find(item => item.section_id === 'SEC-1')!
      const valid = corrected.section_mappings.find(item => item.section_id === 'SEC-2')!.local_materials[0]!
      invalid.local_materials[0] = { ...valid }
      return [value, corrected]
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 3 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings.find(item => item.section_id === 'SEC-1')!.local_materials).toHaveLength(1)
    expect(map.section_mappings.find(item => item.section_id === 'SEC-2')!.local_materials).toHaveLength(1)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it('Host 按顶层业务分支生成任务，Main Agent 仅执行一次目录深化与复核', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-executor-')))
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
    expect(promptText(fixture.starts[0]!.request.request)).toContain('"file_ref":"F2"')
    for (const start of fixture.starts) {
      expect(start.request.request).toMatchObject({ maxDepth: 1, toolFilter: { allow: ['grep', 'read', 'web_search', 'web_fetch'] } })
    }
    const childReadGuard = fixture.childGuards.get(String(fixture.starts[0]!.request.childId))?.at(-1)
    expect(childReadGuard).toBeDefined()
    expect(fixture.agent.ctx.on).toHaveBeenCalledWith('agent/created', expect.any(Function), { global: true })
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.tender.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBe('S4 Mapping Child 只允许 grep 资料分块目录或文件，read 资料索引或已登记分块文件。')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.framework.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBe('S4 Mapping Child 只允许 grep 资料分块目录或文件，read 资料索引或已登记分块文件。')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.referenceBid.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBeUndefined()
    fixture.starts.forEach((start) => { start.resolve() })
    await expect(execution).resolves.toHaveLength(4)
    await expect(readEvidenceMappingProgress(workspace)).resolves.toEqual({
      total: 3,
      initial: 2,
      supplemental: 1,
      completed: 3,
      running: 0,
      not_started: 0,
      failed: 0,
    })

    const map = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')) as { section_mappings: Array<{ section_id: string; local_materials: unknown[] }> }
    expect(map.section_mappings.find(item => item.section_id === 'SEC-1')?.local_materials).toHaveLength(1)
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { observed_max_concurrency: number; tasks: Array<{ final_child_session_id: string | null }> }
    expect(log.observed_max_concurrency).toBe(2)
    expect(log.tasks.every(item => item.final_child_session_id !== null)).toBe(true)
    expect(parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8'))).sources).toEqual([])
    expect(fixture.followup).toHaveBeenCalledTimes(1)
    expect(fixture.followup.mock.calls.every(call => !JSON.stringify(call).includes('Main-Agent Planning'))).toBe(true)
    expect(fixture.disposed).toHaveLength(3)
    expect(fixture.finalStarts).toHaveLength(1)
  })

  it('repairs only the failed Mapping Child without rerunning an accepted sibling', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-repair-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material, true)
    fixture.onReply.mockImplementation((child, result, attempt) => {
      if (result.task_id !== 'MAP-INIT-SEC-1' || attempt !== 1) return
      fixture.emitToolResult({
        agent: child, callId: 'first-attempt-read-failure', name: 'read', arguments: { file_path: 'missing.md' },
      } as unknown as ToolExecution, {
        isError: true, error: { message: 'missing chunk' }, content: [{ type: 'text', text: 'missing chunk' }],
      })
    })

    await executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    expect(fixture.taskAttempts.get('MAP-INIT-SEC-1')).toBe(2)
    expect(fixture.taskAttempts.get('MAP-INIT-SEC-2')).toBe(1)
    expect(fixture.subagents.startContinuable).toHaveBeenCalledTimes(3)
    expect(fixture.subagents.followup).toHaveBeenCalledTimes(1)
    const repairPrompt = fixture.subagents.followup.mock.calls[0]?.[2]?.[0]
    if (repairPrompt === undefined) throw new Error('missing continuable repair prompt')
    expect(repairPrompt.text).toContain('EVIDENCE_MAPPING_PARTIAL_MISSING')
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ task_id: string
        attempts: Array<{
          child_session_id: string
          accepted: boolean
          issues: unknown[]
          warnings: Array<{ code: string }>
        }> }>
    }
    const attempts = log.tasks.find(item => item.task_id === 'MAP-INIT-SEC-1')!.attempts
    expect(new Set(attempts.map(item => item.child_session_id)))
      .toEqual(new Set([String(fixture.starts[0]!.request.childId)]))
    expect(attempts[0]).toMatchObject({ accepted: false, warnings: [{ code: 'EVIDENCE_MAPPING_RETRIEVAL_FAILED' }] })
    expect(attempts[1]).toMatchObject({ accepted: true, issues: [], warnings: [] })
  })

  it('失败后重跑只调度未完成分支，已接受分支从 checkpoint 复用', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-resume-')))
    const material = await writeInputs(workspace)
    const first = mappingFixture(workspace, material)
    first.serializeReply.mockImplementation(value => value.task_id === 'MAP-INIT-SEC-2' ? '{' : JSON.stringify(value))
    const failedRun = executeEvidenceMapping(first.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0, maxConcurrency: 2 })
    const rejection = expect(failedRun).rejects.toBeInstanceOf(Error)
    await vi.waitFor(() => { expect(first.starts).toHaveLength(2) })
    first.starts[0]!.resolve()
    await vi.waitFor(async () => { expect((await readEvidenceMappingProgress(workspace))?.completed).toBe(1) })
    first.starts[1]!.resolve()
    await rejection

    const resumed = mappingFixture(workspace, material)
    const completedRun = executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0, maxConcurrency: 2 })
    await vi.waitFor(() => { expect(resumed.starts).toHaveLength(1) })
    expect(promptText(resumed.starts[0]!.request.request)).toContain('"task_id":"MAP-INIT-SEC-2"')
    resumed.starts[0]!.resolve()
    await completedRun

    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; status: string; attempts: unknown[] }>
    }
    expect(log.tasks.every(task => task.status === 'completed')).toBe(true)
    expect(log.tasks.find(task => task.task_id === 'MAP-INIT-SEC-1')?.attempts).toHaveLength(1)
    expect(log.tasks.find(task => task.task_id === 'MAP-INIT-SEC-2')?.attempts).toHaveLength(2)
  })

  it('Final Check 只提交变更项与未变更 ID，Host 恢复完整 v10 映射', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-final-delta-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onFinalReply.mockImplementation((_child, result) => {
      const unchanged = result.section_mappings.map(mapping => mapping.section_id)
      result.section_mappings = []
      ;(result as unknown as { unchanged_section_ids: string[] }).unchanged_section_ids = unchanged
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution

    const prompt = promptText(fixture.finalStarts[0]!.request.request)
    expect(prompt).toContain('unchanged_section_ids')
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1', 'SEC-2'])
    expect(evidence.section_mappings.every(mapping => mapping.local_materials.length === 1)).toBe(true)
  })

  it('研究驱动拆分的每个叶子具有完整 Brief，Final Check 重新选资料并更新分支摘要', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-refinement-')))
    const material = await writeInputs(workspace)
    const initial = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')) as {
      sections: Array<Record<string, unknown>>
    }
    const fixture = mappingFixture(workspace, material, false, { 'MAP-INIT-SEC-1': [
      { type: 'update_section', section_id: 'SEC-1', summary: '分别说明数据分类分级，以及访问授权、操作留痕和安全审计。' },
      { type: 'split_section', section_id: 'SEC-1', children: [
        { title: '数据分类分级', purpose: '确定项目数据的分类分级方法和保护要求。', must_answer: ['如何识别数据类别并确定保护级别？'] },
        { title: '访问控制与安全审计', purpose: '定义访问授权、操作留痕与安全审计流程。', must_answer: ['如何分配权限并追溯敏感数据访问？'] },
      ] },
    ] })
    fixture.onFinalReply.mockImplementation((_child, result) => {
      for (const mapping of result.section_mappings.filter(item => item.section_id !== 'SEC-2')) {
        mapping.writing_brief.purpose = mapping.section_id === 'SEC-003' ? '确定项目数据的分类分级方法和保护要求。' : '定义访问授权、操作留痕与安全审计流程。'
        mapping.writing_brief.must_answer = [mapping.section_id === 'SEC-003' ? '如何识别数据类别并确定保护级别？' : '如何分配权限并追溯敏感数据访问？']
        mapping.writing_brief.writing_notes = ['说明责任、实施流程与验证方法。']
      }
      result.branch_summaries = [{ section_id: 'SEC-1', summary: '分别说明数据分类分级与保护要求，以及访问权限配置、操作留痕和安全审计流程。' }]
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 1,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.slice(0, 2).forEach((start) => { start.resolve() })
    await execution
    expect(fixture.starts).toHaveLength(2)

    const finalOutline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    expect(finalOutline).not.toEqual(initial)
    expect(new Set(finalOutline.sections.map(section => section.id))).toEqual(new Set(['SEC-1', 'SEC-003', 'SEC-004', 'SEC-2']))
    expect(finalOutline.sections.filter(section => section.parent_id === 'SEC-1').map(section => section.title))
      .toEqual(['数据分类分级', '访问控制与安全审计'])
    expect(finalOutline.sections.find(section => section.id === 'SEC-1')?.writable).toBe(false)
    expect(finalOutline.sections.find(section => section.id === 'SEC-1')?.summary).toContain('数据分类分级')
    for (const section of finalOutline.sections.filter(item => item.parent_id === 'SEC-1')) {
      expect(section.purpose).not.toBe(section.title)
      expect(section.must_answer).toHaveLength(1)
      expect(section.writing_notes).toHaveLength(1)
      expect(section.requirement_ids).toEqual(['R-1'])
      expect(section.scoring_response_point_ids).toEqual(['RP-000001'])
    }
    const map = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')) as {
      section_mappings: Array<{ section_id: string }>
    }
    expect(map.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-003', 'SEC-004', 'SEC-2'])
    const evidence = parseEvidenceMapArtifact(map)
    expect(evidence.section_mappings[0]!.local_materials).toHaveLength(1)
    expect(evidence.section_mappings[0]!.missing_topics).toEqual([])
    expect(fixture.finalStarts).toHaveLength(1)
  })

  it('拒绝不在 S4 Corpus 定位表中的本地资料引用', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-tender-material-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material.tender)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })
    const rejection = expect(execution).rejects.toBeInstanceOf(Error)

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await rejection
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ phase: string; attempts: Array<{ issues: Array<{ code: string }> }> }>
    }
    expect(log.tasks.filter(task => task.phase === 'initial').some(task =>
      task.attempts[0]?.issues[0]?.code === 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING')).toBe(true)
  })

  it('fails before planning when spawn cannot enforce an independent structured Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-provider-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.subagents.getProvider.mockReturnValue({
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: true,
    })
    await expect(executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))).rejects.toThrow('fresh-context spawn subagent provider')
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it('拒绝旧版 S4 私有执行日志', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-log-v2-')))
    await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), JSON.stringify({
      schema_version: 2,
      max_concurrency: 1,
      observed_max_concurrency: 0,
      tasks: [],
    }))
    await expect(readEvidenceMappingProgress(workspace)).rejects.toThrow()
  })
})

describe('S4 Host 准入与最终确认', () => {
  it('Prompt locator 在真实 Child cwd 下可直接使用，grep 与 read 权限独立', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-locators-')))
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
      for (const name of ['read', 'grep']) expect(guard(name, join(workspace.projectRoot, path))).toBeDefined()
    }
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
  })

  it.each(['missing', 'invalid', 'chunk-missing', 'traversal', 'linked'] as const)('Corpus %s 在任何 Child 启动前失败', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-preflight-')))
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
    const log = await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')
    expect(log).toContain(location.file_id)
    expect(log).toContain(location.name)
    const executionLog = JSON.parse(log) as { tasks: Array<{ status: string }> }
    expect(executionLog.tasks.every(task => task.status === 'failed')).toBe(true)
  })

  it('未调用结构化提交工具时仅在原 Child 修复一次', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-json-repair-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeReply.mockImplementationOnce(() => '{')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    expect(fixture.subagents.followup).toHaveBeenCalledOnce()
    expect(fixture.starts).toHaveLength(2)
  })

  it('reference_bid usage 在提交工具内拒绝并同轮修正，不产生 Host repair', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-usage-submit-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, { fileId: material.referenceBid.fileId, chunk: 'chunk_0001' })
    const adapt = (_child: Agent, result: EvidenceMappingPartialResult) => {
      for (const mapping of result.section_mappings) for (const local of mapping.local_materials) local.usage = 'adapt'
    }
    fixture.onReply.mockImplementation(adapt)
    fixture.onFinalReply.mockImplementation(adapt)
    fixture.submissionCandidates.mockImplementationOnce((value) => {
      const valid = value as { task_id: string; section_mappings: Array<{ section_id: string; local_materials: Array<{ usage: string }> }> }
      const wrongTask = { ...structuredClone(valid), task_id: 'MAP-WRONG' }
      const wrongSection = structuredClone(valid)
      wrongSection.section_mappings[0]!.section_id = 'SEC-WRONG'
      const extraField = { ...structuredClone(valid), legacy_mapping: true }
      const invalidUsage = structuredClone(valid)
      invalidUsage.section_mappings[0]!.local_materials[0]!.usage = 'reference_bid'
      return [wrongTask, wrongSection, extraField, invalidUsage, value]
    })

    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution

    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      schema_version: number
      tasks: Array<{ attempts: Array<{ accepted: boolean; issues: unknown[] }> }>
    }
    expect(log.schema_version).toBe(3)
    expect(log.tasks.every(task => task.attempts.length === 1
      && task.attempts[0]!.accepted && task.attempts[0]!.issues.length === 0)).toBe(true)
    expect(fixture.submissionResults.filter(result => result.isError)).toHaveLength(4)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings.every(mapping => mapping.local_materials.every(local => local.usage === 'adapt'))).toBe(true)
    const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
    const context = pickChapterContext({
      section: outline.sections.find(section => section.id === 'SEC-1')!,
      sequence: 1,
      project: parseTenderProjectArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8'))),
      requirements: parseTenderRequirementsArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8'))),
      scoring,
      compliance: parseTenderComplianceArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/compliance.json'), 'utf8'))),
      evidence: map,
      responsePointCatalog: parseScoringResponsePointCatalog(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8'))).points,
      globalComplianceIds: [],
    })
    expect(context.referenceBidMaterials).toHaveLength(1)
    expect(context.relatedMaterials).toEqual([])
  })

  it.each(['SEARCH_INVALID_PATTERN', 'SEARCH_RAW_OUTPUT_OVERFLOW', 'SEARCH_ABORTED', undefined])('grep %s 允许当前 Child 调整搜索，不中止 Sibling', async (code) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-grep-repair-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const [location] = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    const child = fixture.children.get(String(fixture.starts[0]!.request.childId))!
    const exec = { agent: child, callId: 'grep-invalid', name: 'grep', arguments: { path: location!.chunks_path, pattern: '[' } } as unknown as ToolExecution
    fixture.emitToolResult(exec, { isError: true, error: { message: '请调整搜索条件', ...(code === undefined ? {} : { info: { name: 'SearchError', code } }) }, content: [{ type: 'text', text: '请调整搜索条件' }] })
    expect(fixture.starts.every(start => !start.request.signal?.aborted)).toBe(true)
    fixture.emitToolResult({ ...exec, callId: 'grep-corrected' as ToolExecution['callId'], arguments: { path: location!.chunks_path, pattern: '技术' } }, { isError: false, value: { matches: [] }, content: [{ type: 'text', text: 'No matches found' }] })
    fixture.starts.forEach(start => start.resolve())
    await execution
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it.each([
    ['json', 'OUTLINE_REFINEMENT_JSON_INVALID'],
    ['schema', 'OUTLINE_REFINEMENT_SCHEMA_INVALID'],
  ])('全局目录复核的 quality %s 由 Validator 引导修复，成功 Mapping Child 不重跑', async (kind, code) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-repair-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeQuality.mockReturnValueOnce(kind === 'json' ? '{' : '{}')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await execution
    const repairs = fixture.followup.mock.calls.filter(call => JSON.stringify(call).includes('Outline Review Repair'))
    expect(repairs).toHaveLength(1)
    expect(JSON.stringify(repairs)).toContain(code)
    expect(fixture.starts).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it('全局目录复核 repair 耗尽保留质量报告错误及已完成 Mapping Task', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-exhausted-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeQuality.mockReturnValue('{')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 2 })
    const rejection = expect(execution).rejects.toMatchObject({ issues: [{ code: 'OUTLINE_REFINEMENT_JSON_INVALID', artifact: 'outline/quality-report.json' }] })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await rejection
    expect(fixture.followup.mock.calls.filter(call => JSON.stringify(call).includes('Outline Review Repair'))).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1])
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { failure: Array<{ code: string }>; tasks: Array<{ status: string }> }
    expect(log.failure.map(issue => issue.code)).toEqual(['OUTLINE_REFINEMENT_JSON_INVALID'])
    expect(log.tasks.map(task => task.status)).toEqual(['completed', 'completed'])
  })

  it.each(['invalid-json', 'agent-error', 'provider'] as const)('单 Task %s 失败时终止本轮，禁止把未接受结果伪装成完成', async (scenario) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-task-fallback-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    if (scenario === 'invalid-json') fixture.serializeReply.mockImplementation(value => value.task_id === 'MAP-INIT-SEC-1' ? '{' : JSON.stringify(value))
    if (scenario === 'agent-error') fixture.onReply.mockImplementation((child, result) => {
      if (result.task_id === 'MAP-INIT-SEC-1') (child.session.events as unknown[]).push({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '模型异常' } } } })
    })
    if (scenario === 'provider') fixture.subagents.startContinuable.mockRejectedValueOnce(new Error('child unavailable'))
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 5 })
    const rejection = expect(execution).rejects.toBeInstanceOf(Error)
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(scenario === 'provider' ? 1 : 2) })
    if (scenario !== 'provider') {
      fixture.starts[0]!.resolve()
      await vi.waitFor(() => { expect(fixture.disposed).toContain(String(fixture.starts[0]!.request.childId)) })
    }
    fixture.starts.at(-1)?.resolve()
    await rejection
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      failure: Array<{ code: string }>
      tasks: Array<{ status: string }>
    }
    expect(log.failure).toHaveLength(1)
    expect(log.tasks.some(task => task.status === 'failed')).toBe(true)
  })

  it('空 Evidence 合法，本地 chunk 不需要 Child read 日志证明', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-empty-evidence-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onReply.mockImplementation((_child, result) => {
      result.section_mappings[0]!.local_materials = []
      result.section_mappings[0]!.missing_topics = ['无可靠资料，无需联网']
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    expect((await readEvidenceMappingProgress(workspace))!.completed).toBe(3)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
    fixture.onReply.mockImplementation((child) => { (child.session.events as unknown[]).splice(0) })
    const unread = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(4) })
    fixture.starts.slice(2).forEach((start) => { start.resolve() })
    await expect(unread).resolves.toHaveLength(4)
  })

  it.each(['add', 'purpose', 'must_answer', 'scoring', 'order', 'delete', 'delete-unused', 'split'] as const)('最终确认 %s：语义修改局部复核，排序免复核', async (edit) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-confirm-')))
    const material = await writeInputs(workspace)
    if (edit === 'delete-unused') {
      const path = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
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
    const initialLedger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const initialSourceContents = await Promise.all(initialLedger.sources.map(async source => ({
      source,
      content: await readFile(join(workspace.projectRoot, source.snapshot_path), 'utf8'),
    })))
    const session = ctx.sessions.create(SessionId('session'), { meta: { cwd: workspace.root, agentPreset: 'bid' } })
    for (const stage of ['file_intake', 'tender_analysis', 'outline_generation'] as const) {
      session.append('bid.stage.started', { stage, status: 'running' })
      session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
    session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
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
      ctx: {
        agents: { get: () => fixture.agent, list: () => [fixture.agent] },
        sessions: { list: () => [session], flush: async () => {} },
      },
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
    expect(fixture.finalStarts).toHaveLength(edit === 'order' || edit === 'delete-unused' ? 1 : 2)
    expect(session.events.filter(event => event.type === 'bid.stage.started' && event.data.stage === 'evidence_mapping')).toHaveLength(1)
    {
      const confirmed = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')))
      const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      expect(validateSectionEvidenceCoverage(confirmed, evidence)).toEqual([])
      expect(parseOutlineConfirmationArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmation.json'), 'utf8'))).decision).toBe('confirmed')
      if (edit === 'delete') expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1'])
      if (edit === 'order') expect(fixture.starts).toHaveLength(2)
      if (edit === 'delete-unused') {
        expect(fixture.starts).toHaveLength(2)
        expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1'])
        const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
        const retained = initialSourceContents.find(item => item.content.includes('MAP-INIT-SEC-1 正文'))!
        const removed = initialSourceContents.find(item => item.content.includes('MAP-INIT-SEC-2 正文'))!
        expect(ledger.sources).toEqual([retained.source])
        await expect(readFile(join(workspace.projectRoot, removed.source.snapshot_path), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(workspace.projectRoot, retained.source.snapshot_path), 'utf8')).toContain('MAP-INIT-SEC-1 正文')
      }
      if (edit === 'add') expect(evidence.section_mappings.find(mapping => mapping.section_id === 'SEC-NEW')).toMatchObject({ local_materials: [expect.any(Object)], web_materials: [], missing_topics: [] })
      if (edit === 'split') for (const mapping of evidence.section_mappings.filter(mapping => mapping.section_id.startsWith('SPLIT-'))) {
        expect(mapping.local_materials).toHaveLength(1)
        expect(mapping.web_materials).toHaveLength(0)
        expect(mapping.missing_topics).toEqual([])
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
