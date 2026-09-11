import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SandboxedFileSystem from '../../../fs/fs-sandbox/src/index.ts'
import SandboxPolicyService from '../../../sandbox/sandbox-policy/src/index.ts'
import { readDocumentOutlineHeadings } from '../src/outline-framework.ts'
import { mappingMaterialRef } from '../src/evidence-mapping-source-tools.ts'
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
  executeEvidenceMappingFinalCheck,
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
import { writingPlanFixture } from './fixtures/chapter-writing-inputs.ts'

const atomicWriteFailure = vi.hoisted(() => ({ suffix: '', remaining: 0 }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (atomicWriteFailure.remaining > 0 && args[0].endsWith(atomicWriteFailure.suffix)) {
        atomicWriteFailure.remaining--
        throw Object.assign(new Error('injected atomic publication failure'), { code: 'EPERM' })
      }
      return actual.writeFileAtomic(...args)
    },
  }
})

const filesystemContexts: Context[] = []
afterEach(async () => {
  atomicWriteFailure.suffix = ''
  atomicWriteFailure.remaining = 0
  await Promise.all(filesystemContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

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
    { name: 'framework.md', role: 'outline_framework', bytes: new TextEncoder().encode('# 智慧园区方案\n\n框架正文。\n\n## 设备接入\n\n### 协议适配\n\n### 点位映射\n\n## 能耗分析\n\n### 用量统计\n\n### 用能诊断\n') },
    { name: 'reference-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode('# 云平台建设方案\n\n成熟方案。\n\n## 数据服务\n\n### 数据接入\n\n### 数据治理\n\n#### 元数据目录\n\n#### 数据血缘\n\n## 平台运维\n\n### 监控告警\n') },
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
    writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 4, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })),
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
  autoFinal = true,
) {
  let pendingMain = ''
  let active = 0
  let maxActive = 0
  let sequence = 0
  const starts: Array<{ request: ContinuableStartSpec; resolve(): void; complete(): void }> = []
  const finalStarts: Array<{ request: ContinuableStartSpec; resolve(): void; complete(): void }> = []
  const taskAttempts = new Map<string, number>()
  const disposed: string[] = []
  const serializeReply = vi.fn((value: EvidenceMappingPartialResult) => JSON.stringify(value))
  const submissionCandidates = vi.fn((value: unknown): unknown[] => [value])
  const submissionResults: Readonly<ToolExecutionResult>[] = []
  const serializeQuality = vi.fn((content: string) => content)
  const outlineReviewPrompts: string[] = []
  const outlineReviewRequests: Array<{
    toolFilter?: { allow?: readonly string[] }
    maxDepth?: number
    prompt: Array<{ type: string; text: string }>
  }> = []
  const outlineReviewDisposals: Array<ReturnType<typeof vi.fn>> = []
  const onReply = vi.fn<(child: Agent, result: EvidenceMappingPartialResult, attempt: number) => void>()
  const onFinalReply = vi.fn<(child: Agent, result: EvidenceMappingPartialResult, attempt: number) => void>()
  const fileRefs = new Map<string, { file_id: string; source_kind: 'reference' | 'reference_bid' }>()
  type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
  const childGuards = new Map<string, ToolGuard[]>()
  let createdObserver: ((payload: { agent: Agent }) => void) | undefined
  let webObserver: ((exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) | undefined
  let continuableSetup: ((childCtx: Context) => () => void) | undefined
  const setupDisposers = new Map<string, () => void>()
  const submissionTools = new Map<string, Map<string, ToolDefinition>>()
  const preparedChildren = new Set<string>()
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
    const sections = field('current_branch：') as OutlineSection[]
    const current = field('current_branch_mapping：') as Array<Omit<SectionEvidenceMapping, 'local_materials' | 'web_materials'> & {
      local_materials: Array<{ material_ref: string; usage: LocalEvidenceMaterial['usage']; summary: string }>
      web_materials: EvidenceMappingPartialResult['section_mappings'][number]['web_materials']
    }> | undefined
    const pendingReviews = field('pending_review_items：') as Array<{
      kind: 'task' | 'local_material' | 'web_material' | 'branch_summary'
      section_id: string
      value: unknown
    }> | undefined
    const attempt = (taskAttempts.get(task.task_id) ?? 0) + 1
    taskAttempts.set(task.task_id, attempt)
    const sourceKind = [...fileRefs.values()].find(identity => identity.file_id === material.fileId)?.source_kind ?? 'reference'
    const local = { source_kind: sourceKind, file_id: material.fileId, chunk: material.chunk, usage: 'reference' as const, summary: '统一资料。' }
    const operations = outlineOperations[task.task_id] ?? []
    let mappingSections = sections.filter(section => section.writable)
    if (task.phase === 'initial' && operations.length > 0) {
      let allocated = 0
      const projected = applyOutlineEdits({
        schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections,
      }, operations, () => `NEW-${task.task_id.replaceAll(/[^A-Za-z0-9]+/gu, '-')}-${String(++allocated).padStart(3, '0')}`)
      mappingSections = projected.sections.filter(section => section.writable)
    }
    const pendingMapping = (section: OutlineSection): EvidenceMappingPartialResult['section_mappings'][number] | undefined => {
      const taskReview = pendingReviews?.find(item => item.kind === 'task' && item.section_id === section.id)
      if (taskReview === undefined) return undefined
      const { mapping_present: _mappingPresent, ...taskValue } = taskReview.value as
        Pick<EvidenceMappingPartialResult['section_mappings'][number], 'writing_brief' | 'writing_dimensions' | 'missing_topics'> & { mapping_present: boolean }
      if (!_mappingPresent && taskValue.writing_dimensions.length === 0 && taskValue.writing_brief.writing_notes.length === 0) {
        taskValue.writing_dimensions = ['技术响应']
      }
      const local_materials = pendingReviews!.filter(item => item.kind === 'local_material' && item.section_id === section.id)
        .map((item) => {
          const value = item.value as { material_ref: string; usage: LocalEvidenceMaterial['usage']; summary: string }
          const [materialRef, chunk] = value.material_ref.split(':')
          return { ...value, ...fileRefs.get(materialRef!.replace('M', 'F'))!, chunk: chunk!, material_ref: undefined }
        }).map(({ material_ref: _materialRef, ...value }) => value)
      if (!_mappingPresent && local_materials.length === 0) local_materials.push(local)
      const web_materials = pendingReviews!.filter(item => item.kind === 'web_material' && item.section_id === section.id)
        .map(item => item.value as EvidenceMappingPartialResult['section_mappings'][number]['web_materials'][number])
      return { section_id: section.id, ...taskValue, local_materials, web_materials }
    }
    const result: EvidenceMappingPartialResult = {
      task_id: task.task_id,
      section_mappings: repairFirst && task.task_id === 'MAP-INIT-SEC-1' && attempt === 1
        ? []
        : task.phase === 'final_check'
          ? mappingSections.flatMap((section) => {
            const mapping = pendingMapping(section)
            return mapping === undefined ? [] : [mapping]
          })
          : mappingSections.map((section) => {
            const section_id = section.id
            const previous = current?.find(item => item.section_id === section_id)
            return {
              section_id,
              local_materials: [local],
              web_materials: [],
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
      const outline = field('需提交总述的父节点：') as OutlineSection[]
      result.branch_summaries = outline.filter(section => !section.writable).map(section => ({
        section_id: section.id, summary: section.summary ?? '说明各实施任务的技术方法、责任分工和交付条件。',
      }))
      const unchangedMappings = JSON.stringify(result.section_mappings)
      const missingMapping = pendingReviews?.some(item => item.kind === 'task'
        && (item.value as { mapping_present?: boolean }).mapping_present === false) ?? false
      onFinalReply(child, result, attempt)
      if (!missingMapping && JSON.stringify(result.section_mappings) === unchangedMappings) result.section_mappings = []
    } else onReply(child, result, attempt)
    return result
  }
  const submissionArgs = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const result = value as Record<string, unknown>
    if (!Array.isArray(result.section_mappings)) return value
    const sectionMappings = result.section_mappings as unknown[]
    return {
      ...result,
      ...(typeof result.task_id === 'string'
        && (result.task_id.startsWith('MAP-INIT-') || result.task_id.startsWith('MAP-REPAIR-'))
        && result.outline_operations === undefined
        ? { outline_operations: outlineOperations[result.task_id] ?? [] }
        : {}),
      section_mappings: sectionMappings.map((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return candidate
        const mapping = candidate as Record<string, unknown>
        if (!Array.isArray(mapping.local_materials)) return candidate
        const localMaterials = mapping.local_materials as unknown[]
        return { ...mapping, local_materials: localMaterials.map((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
          const materialEntry = entry as Record<string, unknown>
          const fileRef = [...fileRefs].find(([, identity]) => identity.file_id === materialEntry.file_id)?.[0]
          if (fileRef === undefined) return entry
          const expected = fileRefs.get(fileRef)
          const { file_id: _fileId, source_kind: _sourceKind, chunk, ...fields } = materialEntry
          return expected?.source_kind === materialEntry.source_kind
            ? { ...fields, material_ref: mappingMaterialRef(Number(fileRef.slice(1)) - 1, String(chunk)) }
            : { ...fields, material_ref: mappingMaterialRef(Number(fileRef.slice(1)) - 1, String(chunk)),
              source_kind: materialEntry.source_kind }
        }) }
      }),
    }
  }
  let submissionSequence = 0
  const invokeSubmissionTool = async (
    child: Agent,
    tool: ToolDefinition,
    args: unknown,
  ): Promise<Readonly<ToolExecutionResult>> => {
    const token = {} as ToolExecution['token']
    const exec = {
      agent: child,
      callId: `submit-${++submissionSequence}`,
      rootCallId: `submit-${submissionSequence}`,
      token,
      name: tool.name,
      arguments: args,
      signal: new AbortController().signal,
      deferContext: vi.fn(),
      concludeTurn: vi.fn(),
    } as unknown as ToolRunContext
    let result: Readonly<ToolExecutionResult>
    try {
      const returned = await tool.execute(args, exec)
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
    return result
  }
  const mappingToolArgs = (mapping: Record<string, unknown>): Record<string, unknown> => {
    const { writing_brief: _brief, writing_dimensions: _dimensions, missing_topics: _missing, ...materials } = mapping
    return materials
  }
  const taskToolArgs = (mapping: Record<string, unknown>): Record<string, unknown> => {
    const brief = mapping.writing_brief as Record<string, unknown>
    const { requirement_ids, scoring_ids, scoring_response_point_ids, ...writingBrief } = brief
    return {
      section_id: mapping.section_id, writing_dimensions: mapping.writing_dimensions, missing_topics: mapping.missing_topics,
      basis: { kind: 'section_responsibility', explanation: '根据本章已确认职责明确技术响应任务。', requirement_ids: [] },
      writing_brief: writingBrief,
      coverage_override: { requirement_ids, scoring_ids, scoring_response_point_ids },
    }
  }
  const submitReply = async (request: ContinuableStartSpec, child: Agent): Promise<void> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(serializeReply(partial(request.request, child)))
    } catch {
      parsed = undefined
    }
    const tools = submissionTools.get(String(child.id))
    if (parsed !== undefined && tools !== undefined) {
      const candidates = submissionCandidates(submissionArgs(parsed))
      const first = candidates[0] as Record<string, unknown> | undefined
      if (!preparedChildren.has(String(child.id)) && first !== undefined) {
        const apply = tools.get('apply_branch_outline_edit')
        if (apply !== undefined) for (const operation of first.outline_operations as unknown[] ?? []) {
          if ((await invokeSubmissionTool(child, apply, { operation, basis: { kind: 'section_responsibility', explanation: '按已确认职责细化主题。', requirement_ids: [] } })).isError) break
        }
        const lock = tools.get('lock_branch_outline')
        if (lock !== undefined) await invokeSubmissionTool(child, lock, { comparison: '已对照旧标层级和整本职责；现有叶子各自响应独立技术主题，无需增加层级。' })
        preparedChildren.add(String(child.id))
      }
      for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
        const record = candidate as Record<string, unknown>
        const mappings = Array.isArray(record.section_mappings) ? record.section_mappings : []
        const mappingTool = tools.get(record.task_id === 'MAP-FINAL-CHECK' ? 'replace_section_mapping' : 'submit_section_mapping')
        let rejected = mappingTool === undefined
        for (const mapping of mappings) {
          if (mappingTool === undefined || typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
            rejected = true
            break
          }
          if ((await invokeSubmissionTool(child, mappingTool, mappingToolArgs(mapping as Record<string, unknown>))).isError) {
            rejected = true
            break
          }
          const taskTool = tools.get('update_section_task')!
          if ((await invokeSubmissionTool(child, taskTool, taskToolArgs(mapping as Record<string, unknown>))).isError) {
            rejected = true
            break
          }
        }
        if (rejected) continue
        if (record.task_id === 'MAP-FINAL-CHECK') {
          const summaryTool = tools.get('submit_branch_summary')
          for (const summary of record.branch_summaries as unknown[] ?? []) {
            if (summaryTool === undefined || (await invokeSubmissionTool(child, summaryTool, summary)).isError) {
              rejected = true
              break
            }
          }
        }
        if (rejected) continue
        if (record.task_id === 'MAP-FINAL-CHECK') {
          const pending = await invokeSubmissionTool(child, tools.get('list_review_items')!, {})
          if (pending.isError) continue
          const items = (pending.value as { pending_items: Array<{ review_ref: string }> }).pending_items
          if (items.length > 0 && (await invokeSubmissionTool(child, tools.get('review_items')!, {
            items: items.map(item => ({ review_ref: item.review_ref, decision: 'keep', reason: '已对照原始职责和招标要求，任务与材料用途限于本章。' })),
          })).isError) continue
        }
        const finish = tools.get(record.task_id === 'MAP-FINAL-CHECK' ? 'finish_final_check' : 'finish_mapping_task')
        if (finish === undefined) continue
        const finishResult = await invokeSubmissionTool(child, finish, {})
        if (!finishResult.isError && (finishResult.value as { completed?: boolean }).completed) break
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
    start: vi.fn(async (_provider: string, request: { prompt: Array<{ type: string; text: string }> }) => {
      outlineReviewRequests.push(request)
      const prompt = request.prompt.map(item => item.text).join('\n')
      outlineReviewPrompts.push(prompt)
      const marker = '待复核目录：'
      const candidate = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0]!) as {
        sections: Array<{ id: string; requirement_ids: string[]; scoring_ids: string[]; scoring_response_point_ids?: string[] }>
      }
      const serialized = serializeQuality(JSON.stringify({
        schema_version: 4,
        scope: 'technical_bid',
        checked_requirement_ids: [...new Set(candidate.sections.flatMap(item => item.requirement_ids))],
        checked_scoring_ids: [...new Set(candidate.sections.flatMap(item => item.scoring_ids))],
        checked_scoring_response_point_ids: [...new Set(candidate.sections.flatMap(item => item.scoring_response_point_ids ?? []))],
        blocking_issues: [],
        issues: [],
      }))
      let structured: unknown
      try { structured = JSON.parse(serialized) } catch { structured = undefined }
      const dispose = vi.fn(async () => {})
      outlineReviewDisposals.push(dispose)
      return {
        id: SessionId(`outline-review-${outlineReviewPrompts.length}`),
        localAgent: undefined,
        result: Promise.resolve({ output: [], structured, stopReason: 'completed' as const }),
        dispose,
      }
    }),
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
          submissionTools.set(String(id), definitions)
          return () => {
            definitions.delete(definition.name)
            if (definitions.size === 0) submissionTools.delete(String(id))
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
      const settle = (submit: boolean) => {
        void (submit ? submitReply(request, localAgent) : Promise.resolve()).finally(() => {
          active--
          settleIdle()
        })
      }
      children.set(String(id), localAgent)
      childRequests.set(String(id), request)
      const final = promptText(request.request).includes('"phase":"final_check"')
      ;(final ? finalStarts : starts).push({
        request,
        resolve: () => { settle(true) },
        complete: () => { settle(false) },
      })
      if (repairFirst || (final && autoFinal)) queueMicrotask(() => { settle(true) })
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
      await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), serializeQuality(JSON.stringify({ schema_version: 4, scope: 'technical_bid', checked_requirement_ids: ['R-1', 'R-2'], checked_scoring_ids: ['S-1', 'S-2'], checked_scoring_response_point_ids: ['RP-000001', 'RP-000002'], reviewed_section_ids: ['SEC-1', 'SEC-2'], issues: [] })))
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
  const filesystemContext = new Context()
  filesystemContexts.push(filesystemContext)
  const sandboxPolicy = new SandboxPolicyService(filesystemContext, { mode: 'workspace-write' })
  const filesystem = new SandboxedFileSystem(filesystemContext, { cwd: workspace.root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const logger = { warn: vi.fn() }
  const agent = { id: 'session', session: { id: 'session', header: { cwd: workspace.root }, events: [] }, ctx: { agents, logger, get: (name: string) => ({ fs: filesystem, sandboxPolicy, tools, subagents } as Record<string, unknown>)[name], emit: vi.fn(), on }, followup, whenIdle } as unknown as Agent
  return {
    agent, filesystem, starts, finalStarts, subagents, followup, whenIdle, currentPrompt: () => pendingMain,
    childGuards, disposed, maxActive: () => maxActive, taskAttempts, on, onReply, onFinalReply, serializeReply, submissionCandidates,
    submissionResults, logger,
    serializeQuality, outlineReviewPrompts, outlineReviewRequests, outlineReviewDisposals, emitWeb, children,
    invokeSubmissionTool: async (childId: SessionId, name: string, args: unknown) => {
      const definition = submissionTools.get(String(childId))?.get(name)
      const child = children.get(String(childId))
      if (definition === undefined || child === undefined) throw new Error(`missing submission tool ${name}`)
      return invokeSubmissionTool(child, definition, args)
    },
    reviewAll: async (childId: SessionId) => {
      const child = children.get(String(childId))!
      const tools = submissionTools.get(String(childId))!
      const response = await invokeSubmissionTool(child, tools.get('list_review_items')!, {})
      if (response.isError) throw new Error(response.error.message)
      const items = (response.value as { pending_items: Array<{ review_ref: string }> }).pending_items
      if (items.length > 0) {
        const reviewed = await invokeSubmissionTool(child, tools.get('review_items')!, {
          items: items.map(item => ({ review_ref: item.review_ref, decision: 'keep', reason: '任务符合已确认职责，材料用途和总述限于本章。' })),
        })
        if (reviewed.isError) throw new Error(reviewed.error.message)
      }
    },
    emitToolResult: (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => webObserver?.(exec, result),
  }
}

const webUrl = 'https://official.example/a'

function webMaterial(url = webUrl) {
  return { url, usage: 'reference' as const, summary: '官方技术依据。', supports: '支持技术响应。' }
}

function sectionToolArgs(sectionId: string, _purpose: string, extra: Record<string, unknown> = {}) {
  return {
    section_id: sectionId,
    local_materials: [], web_materials: [],
    ...extra,
  }
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
  it('真实接受入口隔离材料与任务，并按当前版本复核任务、每条用途及受影响祖先总述', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s4-review-versions-')))
    const material = await writeInputs(workspace)
    const outlinePath = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const outline = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    const parentTitles: Record<string, string> = { ROOT: '总体方案', PARENT: '业务方案', OTHER: '配套方案' }
    const parent = (id: string, parent_id: string | null, order: number, level: number) => ({
      ...structuredClone(outline.sections[0]!), id, parent_id, order, level, title: parentTitles[id]!, purpose: '概括项目业务范围及总体思路。',
      writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [], summary: '项目方案明确业务内容及总体思路。',
    })
    outline.sections[0] = { ...outline.sections[0]!, parent_id: 'PARENT', level: 3 }
    outline.sections[1] = { ...outline.sections[1]!, parent_id: 'OTHER', level: 3, order: 1 }
    outline.sections.unshift(parent('ROOT', null, 1, 1), parent('PARENT', 'ROOT', 1, 2), parent('OTHER', 'ROOT', 2, 2))
    await writeFile(outlinePath, JSON.stringify(outline))
    const initial = mappingFixture(workspace, material)
    initial.onReply.mockImplementation((child, result) => {
      if (!result.section_mappings.some(mapping => mapping.section_id === 'SEC-1')) return
      const research = webResearch(result.task_id)
      initial.emitWeb(child, [research.search, research.fetch])
      result.section_mappings.find(mapping => mapping.section_id === 'SEC-1')!.web_materials = [webMaterial()]
    })
    const execution = executeEvidenceMapping(initial.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(initial.starts).toHaveLength(2) })
    initial.starts.forEach((start) =>{  start.resolve() })
    await execution
    const published = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    const previous = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    const fixture = mappingFixture(workspace, material, false, {}, false)
    const checking = executeEvidenceMappingFinalCheck(fixture.agent, workspace, published, ['SEC-1'], { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.finalStarts).toHaveLength(1) })
    const final = fixture.finalStarts[0]!
    const childId = final.request.childId!
    const call = (name: string, args: unknown) => fixture.invokeSubmissionTool(childId, name, args)
    type Pending = {
      review_ref: string
      section_id: string
      kind: string
      value: unknown
      conclusion?: { decision: string; reason: string }
    }
    const pending = async () => {
      const result = await call('list_review_items', {})
      expect(result.isError).toBe(false)
      return (result as { value: { pending_items: Pending[] } }).value.pending_items
    }
    const refs = await pending()
    expect(refs.map(item => item.kind).sort()).toEqual(['branch_summary', 'branch_summary', 'local_material', 'task', 'web_material'])
    expect(refs.some(item => item.section_id === 'OTHER' || item.section_id === 'SEC-2')).toBe(false)
    expect(refs.every(item => !('review_key' in item) && !('fingerprint' in item))).toBe(true)
    expect(JSON.stringify(refs)).not.toContain(material.fileId)
    expect(promptText(final.request.request)).toContain('current_branch_baseline：')
    expect(promptText(final.request.request)).toContain('scoped_diffs：')
    await expect(call('finish_final_check', {})).resolves.toMatchObject({ isError: false, value: { completed: false } })
    const valid = { section_id: 'SEC-1', local_materials: [{ material_ref: `M1:${material.chunk}`, usage: 'background', summary: '支持业务范围说明，仅概括适用对象，不展开实施步骤。' }], web_materials: [webMaterial()] }
    for (const field of ['purpose', 'must_answer', 'writing_notes', 'suggested_tables', 'suggested_figures', 'writing_dimensions', 'requirement_ids', 'scoring_ids', 'scoring_response_point_ids', 'writing_brief', 'coverage_override', 'missing_topics']) {
      await expect(call('replace_section_mapping', { ...valid, [field]: ['夹带任务'] })).resolves.toMatchObject({ isError: true })
    }
    for (const field of ['file_id', 'source_kind', 'chunk', 'path', 'title', 'line_start']) {
      await expect(call('replace_section_mapping', { ...valid, local_materials: [{ ...valid.local_materials[0], [field]: '伪造来源' }] }))
        .resolves.toMatchObject({ isError: true })
    }
    await expect(call('replace_section_mapping', { ...valid, local_materials: [{ ...valid.local_materials[0], material_ref: 'M999:chunk_9999' }] }))
      .resolves.toMatchObject({ isError: true })
    await expect(call('submit_branch_summary', { section_id: 'PARENT', summary: '本章响应 R-1 并落实 SEC-1。' }))
      .resolves.toMatchObject({ isError: true })
    for (const section_id of ['PARENT', 'ROOT']) await expect(call('submit_branch_summary', { section_id, summary: '本项目以业务需求和作业范围为基础，明确任务之间的关系，为实施方案提供依据。' }))
      .resolves.toMatchObject({ isError: false })
    await fixture.reviewAll(childId)
    expect(await pending()).toEqual([])
    await expect(call('replace_section_mapping', valid)).resolves.toMatchObject({ isError: false })
    expect((await pending()).map(item => item.kind)).toEqual(['local_material'])
    await expect(call('review_items', { items: [{ review_ref: refs.find(item => item.kind === 'local_material')!.review_ref, decision: 'keep', reason: '旧版本结论' }] }))
      .resolves.toMatchObject({ isError: true })
    await fixture.reviewAll(childId)
    await expect(call('replace_section_mapping', { ...valid, local_materials: [{ ...valid.local_materials[0], material_ref: 'M2:chunk_0001', usage: 'adapt' }] }))
      .resolves.toMatchObject({ isError: false })
    const replaced = (await pending())[0]!
    await expect(call('review_items', { items: [{ review_ref: replaced.review_ref, decision: 'correct', reason: '采用业务范围资料，保持本章展开限度。', correction: { material_ref: `M1:${material.chunk}`, usage: 'background' } }] }))
      .resolves.toMatchObject({ isError: false })
    expect((await pending())[0]!.review_ref).not.toBe(replaced.review_ref)
    await fixture.reviewAll(childId)
    const taskChange = { section_id: 'SEC-1', basis: { kind: 'section_responsibility', explanation: '背景职责只交代业务范围。', requirement_ids: [] }, writing_dimensions: ['只交代业务范围'] }
    await expect(call('update_section_task', { ...taskChange, title: '不能改标题' })).resolves.toMatchObject({ isError: true })
    const taskUpdate = await call('update_section_task', taskChange)
    expect(taskUpdate).toMatchObject({ isError: false })
    expect(JSON.stringify(taskUpdate)).not.toContain(material.fileId)
    expect(JSON.stringify(taskUpdate)).not.toContain('local_materials')
    expect((await pending()).map(item => item.kind).sort()).toEqual(['branch_summary', 'branch_summary', 'local_material', 'task', 'web_material'])
    const taskRef = (await pending()).find(item => item.kind === 'task')!.review_ref
    await expect(call('review_items', { items: [{ review_ref: taskRef, decision: 'block', reason: '已识别的实施任务越界必须修正，不能写成非阻断建议。' }] }))
      .resolves.toMatchObject({ isError: false })
    await expect(call('finish_final_check', {})).resolves.toMatchObject({ isError: false, value: { completed: false, pending_items: expect.arrayContaining([
      expect.objectContaining({ review_ref: taskRef, conclusion: { decision: 'block', reason: '已识别的实施任务越界必须修正，不能写成非阻断建议。' } }),
    ]) as unknown } })
    await expect(call('review_items', { items: [{ review_ref: taskRef, decision: 'correct', reason: '将任务明确限制在业务范围概述。', correction: { task: { ...taskChange, writing_dimensions: ['概述业务范围，不展开实施流程'] } } }] }))
      .resolves.toMatchObject({ isError: false })
    const localRef = (await pending()).find(item => item.kind === 'local_material')!.review_ref
    await expect(call('review_items', { items: [{ review_ref: localRef, decision: 'remove', reason: '该材料不再用于本章。' }] }))
      .resolves.toMatchObject({ isError: false })
    expect((await pending()).some(item => item.kind === 'local_material')).toBe(false)
    await expect(call('finish_final_check', { reviewed_section_ids: ['SEC-1'] })).resolves.toMatchObject({ isError: true })
    await fixture.reviewAll(childId)
    await expect(call('finish_final_check', {})).resolves.toMatchObject({ isError: false, value: { completed: true } })
    final.complete()
    const checked = await checking
    expect(checked.evidence.section_mappings.find(mapping => mapping.section_id === 'SEC-1')).toMatchObject({ local_materials: [], web_materials: [expect.any(Object)], writing_dimensions: ['概述业务范围，不展开实施流程'] })
    expect(checked.evidence.section_mappings.find(mapping => mapping.section_id === 'SEC-2')).toEqual(previous.section_mappings.find(mapping => mapping.section_id === 'SEC-2'))
  })

  it('Final Check 异常恢复后复用 100 项中的 80 项审核结论', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-review-progress-')))
    const material = await writeInputs(workspace)
    const outlinePath = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const original = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    const root = {
      ...structuredClone(original.sections[0]!), id: 'ROOT', parent_id: null, order: 1, level: 1,
      title: '总体方案', purpose: '统筹各项技术响应。', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [],
      scoring_response_point_ids: [], scoring_response_points: [], summary: '本方案统筹技术任务、实施方法与交付成果。',
    }
    const leaves = Array.from({ length: 49 }, (_, index) => {
      const source = structuredClone(original.sections[Math.min(index, 1)]!)
      return {
        ...source,
        id: `LEAF-${String(index + 1).padStart(2, '0')}`,
        parent_id: 'ROOT', order: index + 1, level: 2,
        title: `技术任务 ${index + 1}`, purpose: `说明技术任务 ${index + 1} 的实施方法。`, must_answer: [`如何完成技术任务 ${index + 1}？`],
        ...(index < 2 ? {} : { requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [] }),
      }
    })
    original.sections = [root, ...leaves]
    await writeFile(outlinePath, JSON.stringify(original))
    const first = mappingFixture(workspace, material, false, {}, false)
    first.onReply.mockImplementation((child, result) => {
      const mapping = result.section_mappings.find(item => item.section_id === 'LEAF-01')
      if (mapping === undefined) return
      first.emitWeb(child, [webResearch(result.task_id).fetch])
      mapping.web_materials = [webMaterial()]
    })
    const failedRun = executeEvidenceMapping(first.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    const rejected = expect(failedRun).rejects.toThrow('EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING')
    await vi.waitFor(() => { expect(first.starts).toHaveLength(1) })
    first.starts[0]!.resolve()
    await vi.waitFor(() => { expect(first.finalStarts).toHaveLength(1) }, { timeout: 5_000 })
    const final = first.finalStarts[0]!
    const listed = await first.invokeSubmissionTool(final.request.childId!, 'list_review_items', {})
    if (listed.isError) throw new Error(listed.error.message)
    const items = (listed.value as { pending_items: Array<{ review_ref: string }> }).pending_items
    expect(items).toHaveLength(100)
    await expect(first.invokeSubmissionTool(final.request.childId!, 'review_items', {
      items: items.slice(0, 80).map(item => ({
        review_ref: item.review_ref, decision: 'keep', reason: '已核对当前职责、材料用途或分支总述。',
      })),
    })).resolves.toMatchObject({ isError: false })
    final.complete()
    await rejected
    const progressCheckpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{
        task_id: string
        completed: boolean
        review_records: Array<{ review_key: string; fingerprint: string; conclusion?: unknown }>
      }>
    }
    const savedFinal = progressCheckpoint.tasks.find(task => task.task_id === 'MAP-FINAL-CHECK')!
    expect(savedFinal.completed).toBe(false)
    expect(savedFinal.review_records).toHaveLength(100)
    expect(savedFinal.review_records.filter(item => item.conclusion !== undefined)).toHaveLength(80)
    expect(savedFinal.review_records.every(item => item.review_key.length > 0 && /^[a-f0-9]{64}$/u.test(item.fingerprint))).toBe(true)

    const resumed = mappingFixture(workspace, material, false, {}, false)
    const completedRun = executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    await vi.waitFor(() => { expect(resumed.finalStarts).toHaveLength(1) }, { timeout: 5_000 })
    expect(resumed.starts).toHaveLength(0)
    const resumedFinal = resumed.finalStarts[0]!
    const prompt = promptText(resumedFinal.request.request)
    const pendingLine = prompt.split('\n').find(line => line.startsWith('pending_review_items：'))
    if (pendingLine === undefined) throw new Error('missing pending review prompt')
    expect(JSON.parse(pendingLine.slice('pending_review_items：'.length))).toHaveLength(20)
    const resumedList = await resumed.invokeSubmissionTool(resumedFinal.request.childId!, 'list_review_items', {})
    if (resumedList.isError) throw new Error(resumedList.error.message)
    expect((resumedList.value as { pending_items: unknown[] }).pending_items).toHaveLength(20)
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{
        phase: string
        prompt_context_stats?: { scoped_section_count: number; global_index_section_count: number }
        review_progress?: { review_total: number; review_reused: number; review_pending: number }
      }>
    }
    const finalLog = log.tasks.find(task => task.phase === 'final_check')
    expect(finalLog?.review_progress).toMatchObject({
      review_total: 100, review_reused: 80, review_pending: 20,
    })
    expect(finalLog!.prompt_context_stats!.scoped_section_count)
      .toBeLessThan(finalLog!.prompt_context_stats!.global_index_section_count)
    await expect(resumed.invokeSubmissionTool(resumedFinal.request.childId!, 'submit_branch_summary', {
      section_id: 'ROOT', summary: '本方案统筹各项技术任务的实施方法、责任安排与交付成果。',
    })).resolves.toMatchObject({ isError: false })
    await resumed.reviewAll(resumedFinal.request.childId!)
    await expect(resumed.invokeSubmissionTool(resumedFinal.request.childId!, 'finish_final_check', {}))
      .resolves.toMatchObject({ isError: false, value: { completed: true } })
    resumedFinal.complete()
    await completedRun
  })

  it('Material 与 Task 指纹变化只失效真实依赖项和祖先总述', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-review-invalidation-')))
    const material = await writeInputs(workspace)
    const outlinePath = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const outline = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    const root = {
      ...structuredClone(outline.sections[0]!), id: 'ROOT', parent_id: null, order: 1, level: 1,
      title: '总体方案', purpose: '统筹两个技术主题。', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [],
      scoring_response_point_ids: [], scoring_response_points: [], summary: '本方案统筹两个技术主题的实施与交付。',
    }
    outline.sections = [root, ...outline.sections.map(section => ({ ...section, parent_id: 'ROOT', level: 2 }))]
    await writeFile(outlinePath, JSON.stringify(outline))
    const initial = mappingFixture(workspace, material)
    const running = executeEvidenceMapping(initial.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(initial.starts).toHaveLength(1) })
    initial.starts[0]!.resolve()
    await running

    const published = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    const fixture = mappingFixture(workspace, material, false, {}, false)
    const checking = executeEvidenceMappingFinalCheck(fixture.agent, workspace, published, ['SEC-1', 'SEC-2'], { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(fixture.finalStarts).toHaveLength(1) })
    const final = fixture.finalStarts[0]!
    const childId = final.request.childId!
    await expect(fixture.invokeSubmissionTool(childId, 'submit_branch_summary', {
      section_id: 'ROOT', summary: '本方案统筹两个技术主题的实施方法、责任安排与交付成果。',
    })).resolves.toMatchObject({ isError: false })
    const firstList = await fixture.invokeSubmissionTool(childId, 'list_review_items', {})
    if (firstList.isError) throw new Error(firstList.error.message)
    const firstItems = (firstList.value as {
      pending_items: Array<{ review_ref: string; kind: string; section_id: string }>
    }).pending_items
    expect(firstItems).toHaveLength(5)
    const originalMaterial = firstItems.find(item => item.kind === 'local_material' && item.section_id === 'SEC-1')!
    await fixture.reviewAll(childId)

    const reviewedCheckpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; review_records: Array<{ review_key: string; fingerprint: string; conclusion?: unknown }> }>
    }
    const originalMaterialRecord = reviewedCheckpoint.tasks.find(task => task.task_id === 'MAP-FINAL-CHECK')!
      .review_records.find(item => item.review_key.startsWith('local_material:SEC-1:'))!

    await expect(fixture.invokeSubmissionTool(childId, 'replace_section_mapping', {
      section_id: 'SEC-1',
      local_materials: [{ material_ref: `M1:${material.chunk}`, usage: 'background', summary: '只用于说明本章技术背景。' }],
      web_materials: [],
    })).resolves.toMatchObject({ isError: false })
    const materialList = await fixture.invokeSubmissionTool(childId, 'list_review_items', {})
    if (materialList.isError) throw new Error(materialList.error.message)
    const materialItems = (materialList.value as {
      pending_items: Array<{ review_ref: string; kind: string; section_id: string }>
    }).pending_items
    expect(materialItems).toEqual([expect.objectContaining({ kind: 'local_material', section_id: 'SEC-1' })])
    expect(materialItems[0]!.review_ref).not.toBe(originalMaterial.review_ref)
    const changedCheckpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; review_records: Array<{ review_key: string; fingerprint: string; conclusion?: unknown }> }>
    }
    const changedMaterialRecord = changedCheckpoint.tasks.find(task => task.task_id === 'MAP-FINAL-CHECK')!
      .review_records.find(item => item.review_key === originalMaterialRecord.review_key)!
    expect(changedMaterialRecord.fingerprint).not.toBe(originalMaterialRecord.fingerprint)
    expect(changedMaterialRecord.conclusion).toBeUndefined()
    await fixture.reviewAll(childId)

    await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', {
      section_id: 'SEC-1', basis: { kind: 'section_responsibility', explanation: '限定本章技术实施职责。', requirement_ids: [] },
      writing_dimensions: ['实施方法与验收依据'],
    })).resolves.toMatchObject({ isError: false })
    const taskList = await fixture.invokeSubmissionTool(childId, 'list_review_items', {})
    if (taskList.isError) throw new Error(taskList.error.message)
    const taskItems = (taskList.value as { pending_items: Array<{ kind: string; section_id: string }> }).pending_items
    expect(taskItems.map(item => [item.kind, item.section_id]).sort()).toEqual([
      ['branch_summary', 'ROOT'], ['local_material', 'SEC-1'], ['task', 'SEC-1'],
    ])
    expect(taskItems.some(item => item.section_id === 'SEC-2')).toBe(false)
    await expect(fixture.invokeSubmissionTool(childId, 'submit_branch_summary', {
      section_id: 'ROOT', summary: '本方案统筹两个技术主题的实施方法、验收依据与交付成果。',
    })).resolves.toMatchObject({ isError: false })
    await fixture.reviewAll(childId)
    await expect(fixture.invokeSubmissionTool(childId, 'finish_final_check', {}))
      .resolves.toMatchObject({ isError: false, value: { completed: true } })
    final.complete()
    await checking
  })

  it('恢复时 fingerprint 已变化的历史 keep 重新进入 pending', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-review-fingerprint-')))
    const material = await writeInputs(workspace)
    const first = mappingFixture(workspace, material, false, {}, false)
    const failedRun = executeEvidenceMapping(first.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    const rejected = expect(failedRun).rejects.toThrow('EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING')
    await vi.waitFor(() => { expect(first.starts).toHaveLength(2) })
    first.starts.forEach((start) => { start.resolve() })
    await vi.waitFor(() => { expect(first.finalStarts).toHaveLength(1) })
    const final = first.finalStarts[0]!
    const childId = final.request.childId!
    const before = await first.invokeSubmissionTool(childId, 'list_review_items', {})
    if (before.isError) throw new Error(before.error.message)
    const beforeItems = (before.value as { pending_items: unknown[] }).pending_items
    expect(beforeItems).toHaveLength(4)
    await first.reviewAll(childId)
    await expect(first.invokeSubmissionTool(childId, 'replace_section_mapping', {
      section_id: 'SEC-1',
      local_materials: [{ material_ref: `M1:${material.chunk}`, usage: 'background', summary: '仅用于本章技术背景。' }],
      web_materials: [],
    })).resolves.toMatchObject({ isError: false })
    final.complete()
    await rejected

    const resumed = mappingFixture(workspace, material, false, {}, false)
    const resumedRun = executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    await vi.waitFor(() => { expect(resumed.finalStarts).toHaveLength(1) })
    const resumedFinal = resumed.finalStarts[0]!
    const pending = await resumed.invokeSubmissionTool(resumedFinal.request.childId!, 'list_review_items', {})
    if (pending.isError) throw new Error(pending.error.message)
    const pendingItems = (pending.value as { pending_items: Array<{ kind: string; section_id: string }> }).pending_items
    expect(pendingItems).toEqual([expect.objectContaining({ kind: 'local_material', section_id: 'SEC-1' })])
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      tasks: Array<{ phase: string; review_progress?: { review_reused: number; review_pending: number; review_invalidated: number } }>
    }
    expect(log.tasks.find(task => task.phase === 'final_check')?.review_progress).toMatchObject({
      review_reused: 3, review_pending: 1, review_invalidated: 1,
    })
    await resumed.reviewAll(resumedFinal.request.childId!)
    await expect(resumed.invokeSubmissionTool(resumedFinal.request.childId!, 'finish_final_check', {}))
      .resolves.toMatchObject({ isError: false, value: { completed: true } })
    resumedFinal.complete()
    await resumedRun
  })

  it('Final Check 完成后发布失败，恢复时不再启动 Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-review-completed-')))
    const material = await writeInputs(workspace)
    const first = mappingFixture(workspace, material)
    atomicWriteFailure.suffix = 'outline.json'
    atomicWriteFailure.remaining = 1
    const failedRun = executeEvidenceMapping(first.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    const rejected = expect(failedRun).rejects.toThrow('injected atomic publication failure')
    await vi.waitFor(() => { expect(first.starts).toHaveLength(2) })
    first.starts.forEach((start) => { start.resolve() })
    await rejected
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; completed: boolean }>
    }
    expect(checkpoint.tasks.find(task => task.task_id === 'MAP-FINAL-CHECK')?.completed).toBe(true)

    const resumed = mappingFixture(workspace, material)
    await executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    expect(resumed.starts).toHaveLength(0)
    expect(resumed.finalStarts).toHaveLength(0)
  })

  it('关键 checkpoint 写入失败会终止 Stage 并保留原始错误', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-state-write-failure-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const writes = vi.spyOn(fixture.filesystem, 'writeText')
    let checkpointFailures = 0
    fixture.filesystem.internals.inspectTemp = async ({ tempPath }) => {
      if (!tempPath.endsWith('evidence-mapping-checkpoint.json.tmp') || checkpointFailures++ > 0) return
      throw Object.assign(new Error('injected checkpoint publication failure'), { code: 'EPERM' })
    }
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    fixture.starts[0]!.resolve()
    await expect(execution).rejects.toThrow('injected checkpoint publication failure')
    expect(checkpointFailures).toBe(1)
    expect(writes.mock.calls.map(call => call[4])).toEqual(writes.mock.calls.map(() => ({ mode: 'workspace-write', workspaceRoot: realpathSync.native(workspace.root), sessionId: 'session' })))
    const failed = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      failure: Array<{ code: string; message: string }>
      tasks: Array<{ status: string }>
    }
    expect(failed.failure).toEqual([{ code: 'EVIDENCE_MAPPING_INFRASTRUCTURE_ERROR', message: 'injected checkpoint publication failure' }])
    expect(failed.tasks.every((task: { status: string }) => task.status === 'failed')).toBe(true)
  })

  it('一次 progress log 写入失败不会污染后续关键 checkpoint', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-state-write-blocked-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    atomicWriteFailure.suffix = 'evidence-mapping-log.json'
    atomicWriteFailure.remaining = 1
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 2,
    })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{ task_id: string }>
    }
    expect(checkpoint.tasks).toHaveLength(3)
    expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining('S4 资料映射进度日志写入失败'))
    await expect(readEvidenceMappingProgress(workspace)).resolves.toMatchObject({ completed: 3, failed: 0 })
  })

  it('小工具以 Host 状态完成 missing、upsert、即时引用校验和 Final baseline/summary 聚合', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-incremental-mapping-tools-')))
    const material = await writeInputs(workspace)
    const outlinePath = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    const outline = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    const third = {
      ...structuredClone(outline.sections[1]!), id: 'SEC-3', order: 3, title: '章节3',
      requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [],
    }
    const branch = {
      ...structuredClone(outline.sections[0]!), id: 'BRANCH', parent_id: null, order: 1, level: 1, title: '实施分支',
      writable: false, must_answer: [], scoring_response_point_ids: [], scoring_response_points: [],
      summary: '汇总实施分支的三个写作任务。',
    }
    for (const section of [...outline.sections, third]) {
      section.parent_id = 'BRANCH'
      section.level = 2
    }
    outline.sections = [branch, ...outline.sections, third]
    await writeFile(outlinePath, JSON.stringify(outline))
    const fixture = mappingFixture(workspace, material, false, {}, false)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    const start = fixture.starts[0]!
    const childId = start.request.childId!
    for (const args of [{}, { comparison: '' }, { comparison: ' \n\t' }]) {
      await expect(fixture.invokeSubmissionTool(childId, 'lock_branch_outline', args)).resolves.toMatchObject({ isError: true })
    }
    const basis = { kind: 'section_responsibility', explanation: '验证目录锁定前的结构修复。', requirement_ids: [] }
    for (const [operation, code] of [
      [{ type: 'add_section', parent_id: 'SEC-1', order: 1, writable: true,
        title: '子任务', purpose: '说明子任务。', must_answer: ['如何完成子任务？'] }, 'OUTLINE_SHARED_WRITABLE_NOT_LEAF'],
      [{ type: 'update_section', section_id: 'SEC-2', title: outline.sections[1]!.title }, 'OUTLINE_SHARED_SECTION_TITLE_DUPLICATE'],
      [{ type: 'add_section', parent_id: 'SEC-1', order: 1, writable: false,
        title: '空容器', purpose: '组织后续任务。', summary: '汇总后续任务。' }, 'OUTLINE_SHARED_CONTAINER_EMPTY'],
    ] as const) {
      const result = await fixture.invokeSubmissionTool(childId, 'apply_branch_outline_edit', { operation, basis })
      expect(result, code).toMatchObject({ isError: true })
      if (result.isError) expect(result.error.message).toContain(code)
    }
    const withNotes = (sectionId: string, purpose: string) => ({
      section_id: sectionId, basis: { kind: 'section_responsibility', explanation: '明确本章技术响应职责。', requirement_ids: [] },
      writing_brief: { purpose, must_answer: [`${sectionId} 必须回答的事项。`], writing_notes: ['说明实施方法。'], suggested_tables: [], suggested_figures: [] },
    })
    await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', withNotes('SEC-1', '锁前研究草稿一')))
      .resolves.toMatchObject({ isError: false })
    await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', withNotes('SEC-2', '锁前研究草稿二')))
      .resolves.toMatchObject({ isError: false })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '未锁定草稿')))
      .resolves.toMatchObject({ isError: true })
    const lock = await fixture.invokeSubmissionTool(childId, 'lock_branch_outline', { comparison: '已比较旧标层级，三个现有叶子分别承接实施任务，范围独立，无需新增标题。' })
    expect(lock).toMatchObject({ isError: false, value: { locked: true, writable_sections: [
      { section_id: 'SEC-1', purpose: '锁前研究草稿一' }, { section_id: 'SEC-2', purpose: '锁前研究草稿二' }, { section_id: 'SEC-3' },
    ] } })
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: false, missing_section_ids: ['SEC-1', 'SEC-2', 'SEC-3'] },
    })
    await expect(fixture.invokeSubmissionTool(childId, 'apply_branch_outline_edit', {
      operation: { type: 'update_section', section_id: 'SEC-1', title: '锁后修改' },
    })).resolves.toMatchObject({ isError: true })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-UNKNOWN', '未知章节')))
      .resolves.toMatchObject({ isError: true })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '错误文件', {
      local_materials: [{ material_ref: `M999:${material.chunk}`, usage: 'reference', summary: '错误引用。' }],
    }))).resolves.toMatchObject({ isError: true })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '错误分块', {
      local_materials: [{ material_ref: 'M1:chunk_9999', usage: 'reference', summary: '错误分块。' }],
    }))).resolves.toMatchObject({ isError: true })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '错误用途', {
      local_materials: [{ material_ref: `M1:${material.chunk}`, usage: 'reuse', summary: '非法复用。' }],
    }))).resolves.toMatchObject({ isError: true })
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '第一次草稿')))
      .resolves.toMatchObject({ isError: false, value: { remaining_section_ids: ['SEC-2', 'SEC-3'] } })
    await fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-1', '覆盖后的最终草稿'))
    await expect(fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-2', '允许旧标书适配', {
      local_materials: [{ material_ref: 'M2:chunk_0001', usage: 'adapt', summary: '适配成熟方案。' }],
    }))).resolves.toMatchObject({ isError: false })
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: false, missing_section_ids: ['SEC-3'] },
    })
    await fixture.invokeSubmissionTool(childId, 'submit_section_mapping', sectionToolArgs('SEC-3', '第三章草稿'))
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: false, missing_section_ids: [], issues: [
        { code: 'EVIDENCE_MAPPING_WRITING_BRIEF_INCOMPLETE' },
      ] },
    })
    await fixture.invokeSubmissionTool(childId, 'update_section_task', withNotes('SEC-3', '第三章草稿'))
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: true },
    })
    start.complete()

    await vi.waitFor(() => { expect(fixture.finalStarts).toHaveLength(1) })
    const final = fixture.finalStarts[0]!
    const finalId = final.request.childId!
    await expect(fixture.invokeSubmissionTool(finalId, 'finish_final_check', {})).resolves.toMatchObject({
      isError: false, value: { completed: false, missing_summary_section_ids: ['BRANCH'] },
    })
    await fixture.invokeSubmissionTool(finalId, 'submit_branch_summary', { section_id: 'BRANCH', summary: '第一次摘要。' })
    await fixture.invokeSubmissionTool(finalId, 'submit_branch_summary', { section_id: 'BRANCH', summary: '覆盖后的最终摘要。' })
    await expect(fixture.invokeSubmissionTool(finalId, 'finish_final_check', {})).resolves.toMatchObject({ isError: false, value: { completed: false } })
    await fixture.reviewAll(finalId)
    await expect(fixture.invokeSubmissionTool(finalId, 'finish_final_check', {})).resolves.toMatchObject({
      isError: false, value: { completed: true },
    })
    final.complete()
    await execution

    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1', 'SEC-2', 'SEC-3'])
    expect(map.section_mappings.find(mapping => mapping.section_id === 'SEC-1')).toMatchObject({
      local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: [],
    })
    const finalOutline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    expect(finalOutline.sections.find(section => section.id === 'SEC-1')?.purpose).toBe('锁前研究草稿一')
    expect(finalOutline.sections.find(section => section.id === 'BRANCH')?.summary).toBe('覆盖后的最终摘要。')
  })

  it('目录工具分配新 ID，新增章节任务及覆盖关联通过独立操作提交', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-incremental-new-sections-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    const start = fixture.starts[0]!
    const childId = start.request.childId!
    await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', {
      section_id: 'SEC-1', basis: { kind: 'section_responsibility', explanation: '记录拆分前研究草稿。', requirement_ids: [] },
      writing_dimensions: ['原章内的实施方法与质量控制'],
    })).resolves.toMatchObject({ isError: false })
    await expect(fixture.invokeSubmissionTool(childId, 'apply_branch_outline_edit', {
      operation: { type: 'update_section', section_id: 'SEC-1', summary: '分别说明两个子任务。' },
      basis: { kind: 'section_responsibility', explanation: '概括原章节的两个子任务。', requirement_ids: [] },
    })).resolves.toMatchObject({ isError: false, value: { created_section_ids: [] } })
    const split = await fixture.invokeSubmissionTool(childId, 'apply_branch_outline_edit', {
      basis: { kind: 'tender_requirement', explanation: '按 R-1 的两个子任务拆分。', requirement_ids: ['R-1'] },
      operation: { type: 'split_section', section_id: 'SEC-1', children: [
        { title: '子任务甲', purpose: '说明子任务甲的实施方法。', must_answer: ['如何实施子任务甲？'] },
        { title: '子任务乙', purpose: '说明子任务乙的实施方法。', must_answer: ['如何实施子任务乙？'] },
      ] },
    })
    expect(split).toMatchObject({ isError: false })
    const createdIds = split.isError ? [] : (split.value as { created_section_ids: string[] }).created_section_ids
    expect(createdIds).toHaveLength(2)
    expect(createdIds.every(id => id.startsWith('NEW-'))).toBe(true)
    const lock = await fixture.invokeSubmissionTool(childId, 'lock_branch_outline', { comparison: '原章节包含两个独立子任务，已按旧标任务层次拆为两个可写叶子。' })
    expect(lock).toMatchObject({ isError: false, value: { writable_sections: createdIds.map(section_id => ({ section_id })) } })
    const brief = (sectionId: string) => ({
      section_id: sectionId,
      basis: { kind: 'section_responsibility', explanation: '落实拆分后的本章职责。', requirement_ids: [] },
      writing_brief: { purpose: `完成 ${sectionId} 的响应说明。`, must_answer: [`如何完成 ${sectionId}？`], writing_notes: ['说明方法与验证。'], suggested_tables: [], suggested_figures: [] },
    })
    const withoutCoverage = await fixture.invokeSubmissionTool(childId, 'submit_section_mapping', brief(createdIds[0]!))
    expect(withoutCoverage).toMatchObject({ isError: true })
    if (withoutCoverage.isError) expect(withoutCoverage.error.message).toContain('writing_brief')
    for (const sectionId of createdIds) await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', {
      ...brief(sectionId),
      coverage_override: {
        requirement_ids: ['R-1'], scoring_ids: ['S-1'], scoring_response_point_ids: ['RP-000001'],
      },
    })).resolves.toMatchObject({ isError: false })
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: false, missing_section_ids: createdIds },
    })
    for (const sectionId of createdIds) await fixture.invokeSubmissionTool(childId, 'submit_section_mapping', {
      section_id: sectionId, local_materials: [], web_materials: [],
    })
    await expect(fixture.invokeSubmissionTool(childId, 'finish_mapping_task', {})).resolves.toMatchObject({
      isError: false, value: { completed: true },
    })
    start.complete()
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts[1]!.resolve()
    await execution

    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(new Set(map.section_mappings.map(mapping => mapping.section_id)).size).toBe(3)
    expect(map.section_mappings).toHaveLength(3)
  })

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
      const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('scoped_candidate_refs：'))!.slice('scoped_candidate_refs：'.length)) as Array<{ local_material_refs: string[] }>
      expect(candidates.flatMap(mapping => mapping.local_material_refs)).toHaveLength(1)
      expect(prompt).toContain('缺少统一判定规则。')
      const target = result.section_mappings.find(mapping => mapping.section_id === 'SEC-2')!
      target.local_materials = [{ source_kind: 'reference', file_id: material.fileId, chunk: material.chunk, usage: 'reference', summary: '支撑本章实施阶段的统一判定方法。' }]
      target.missing_topics = []
    })
    fixture.serializeReply.mockImplementation(value => JSON.stringify({ ...value, section_mappings: value.section_mappings.map(mapping => ({
      ...mapping, local_materials: mapping.local_materials.map(({ file_id: _fileId, source_kind: _sourceKind, chunk, ...item }) => ({ ...item, material_ref: `M1:${chunk}` })),
    })) }))
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[1]).toMatchObject({ missing_topics: [], local_materials: [{ file_id: material.fileId, source_kind: 'reference', chunk: material.chunk }] })
    expect(map.section_mappings[1]!.local_materials[0]).not.toHaveProperty('material_ref')
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
      const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('scoped_candidate_refs：'))!.slice('scoped_candidate_refs：'.length)) as Array<{ local_material_refs: string[] }>
      expect(candidates.flatMap(mapping => mapping.local_material_refs)).toEqual([`M1:${material.chunk}`, 'M2:chunk_0001'])
      result.section_mappings[0]!.local_materials.push(second)
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(1) })
    fixture.starts.forEach((start) => { start.resolve() })
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
    fixture.starts.forEach((start) => { start.resolve() })
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
      ...first, id, parent_id, order, level: parent_id === null ? 1 : 2,
      title: parent_id === null ? '总体实施方案' : `实施专题${order}`,
      writable: false,
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
      result.section_mappings[0]!.writing_dimensions = ['需要删除的旧任务']
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
      result.section_mappings[0]!.writing_dimensions = ['独立操作确定的新任务']
    })
    fixture.onFinalReply.mockImplementation((_child, result) => {
      expect(result.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-2'])
      expect(result.section_mappings[0]!.writing_dimensions).toEqual(['独立操作确定的新任务'])
      expect(result.section_mappings[0]!.local_materials).toHaveLength(mode === 'supplement' ? 1 : 0)
      expect(result.section_mappings[0]!.web_materials).toHaveLength(mode === 'supplement' ? 1 : 0)
      // 保留候选合并结果，让程序逐项要求复核旧材料，不能只审本轮空提交。
      result.section_mappings = []
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
    expect(after.section_mappings[1]!.writing_dimensions).toEqual(['独立操作确定的新任务'])
    expect(await readFile(join(workspace.projectRoot, snapshot), 'utf8')).toBe(snapshotContent)
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it.each(['coverage', 'provider'] as const)('局部替换失败 %s 保留原资料与写作任务', async (failure) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-remap-failure-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    const initial = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
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
    fixture.starts.forEach((start) => { start.resolve() })
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
      completedBeforeRepair ? 'EVIDENCE_MAPPING_PARTIAL_MISSING' : 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING',
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

  it('未 fetch 的 URL 在逐章提交时立即拒绝且不写入 staged mapping', async () => {
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
    const failures = fixture.submissionResults.filter(result => result.isError)
    expect(failures).toHaveLength(2)
    expect(failures.every(result => result.isError && result.error.message.includes('web_materials.0.url'))).toBe(true)
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
      if (scenario === 'schema') Object.assign(mapping.local_materials[0], { usage: 'invalid' })
      else mapping.local_materials[0].file_id = 'unknown'
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
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings.find(item => item.section_id === 'SEC-1')!.local_materials).toHaveLength(1)
    expect(map.section_mappings.find(item => item.section_id === 'SEC-2')!.local_materials).toHaveLength(1)
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it('Host 按顶层业务分支生成任务，并完整注入输入中的云平台目录分类与层级', async () => {
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
    const initialPrompt = promptText(fixture.starts[0]!.request.request)
    expect(initialPrompt).toContain('current_branch：[{"id":"SEC-1"')
    expect(initialPrompt).toContain('current_branch_baseline：[{"id":"SEC-1"')
    expect(initialPrompt).toContain('scoped_diffs：')
    expect(initialPrompt).toContain('scoped_candidate_refs：')
    expect(initialPrompt).not.toContain('S3 已确认任务：')
    expect(initialPrompt).not.toContain('当前完整目录与全书章节职责：')
    expect(initialPrompt).not.toContain('全局候选资料池：')
    expect(initialPrompt).toContain('"id":"SEC-2","parent_id":null,"title":"章节2","purpose":"响应主题2","writable":true')
    expect(initialPrompt).not.toContain('"id":"SEC-2","parent_id":null,"order":2')
    expect(initialPrompt).not.toContain('"must_answer":["响应主题2"]')
    const originalFrameworks = JSON.parse(initialPrompt.split('\n').find(line => line.startsWith('用户原始目录框架：'))!.slice('用户原始目录框架：'.length)) as Array<{ name: string; headings: unknown[] }>
    expect(originalFrameworks).toEqual([{ name: 'framework.md', headings: [
      { title: '智慧园区方案', level: 1, order: 1 },
      { title: '设备接入', level: 2, order: 2 },
      { title: '协议适配', level: 3, order: 3 },
      { title: '点位映射', level: 3, order: 4 },
      { title: '能耗分析', level: 2, order: 5 },
      { title: '用量统计', level: 3, order: 6 },
      { title: '用能诊断', level: 3, order: 7 },
    ] }])
    const globalOutline = JSON.parse(initialPrompt.split('\n').find(line => line.startsWith('global_outline_index：'))!.slice('global_outline_index：'.length)) as Array<Record<string, unknown>>
    expect(globalOutline).toEqual([1, 2].map(value => ({
      id: `SEC-${value}`, parent_id: null, title: `章节${value}`,
      writable: true, purpose: `响应主题${value}`,
    })))
    const referenceOutlines = JSON.parse(initialPrompt.split('\n').find(line => line.startsWith('参考旧标书完整目录：'))!.slice('参考旧标书完整目录：'.length)) as Array<{ headings: unknown[] }>
    expect(referenceOutlines).toHaveLength(1)
    expect(referenceOutlines[0]!.headings).toHaveLength(8)
    expect(referenceOutlines[0]!.headings[5]).toEqual({
      title: '数据血缘', level: 4, order: 6,
    })
    expect(initialPrompt).toContain('不得只塞入 writing_dimensions、must_answer 或 writing_notes')
    expect(initialPrompt).toContain('评分和要求是否覆盖、同级章节职责是否清楚、每个叶子内是否仍有值得独立编写的主题')
    expect(initialPrompt).toContain('不预设标题、固定层级或节点数量')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('相关 Requirements：[{"id":"R-1"')
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain('"id":"R-2"')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('不得脱离当前 Section 做全局资料搜集')
    expect(promptText(fixture.starts[0]!.request.request)).toContain('逐章调用 submit_section_mapping')
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain('submit_evidence_mapping')
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.tender.fileId)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.tender.path)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.framework.fileId)
    expect(promptText(fixture.starts[0]!.request.request)).not.toContain(material.framework.path)
    expect(promptText(fixture.starts[0]!.request.request)).toContain('"file_ref":"F2"')
    for (const start of fixture.starts) {
      expect(start.request.request).toMatchObject({ maxDepth: 1, toolFilter: { allow: ['web_search', 'web_fetch'] } })
    }
    const childReadGuard = fixture.childGuards.get(String(fixture.starts[0]!.request.childId))?.at(-1)
    expect(childReadGuard).toBeDefined()
    expect(fixture.on).toHaveBeenCalledWith('agent/created', expect.any(Function), { global: true })
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.tender.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toContain('read_source')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.framework.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toContain('read_source')
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.projectRoot, material.referenceBid.path) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toContain('read_source')
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
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
      observed_max_concurrency: number
      tasks: Array<{
        final_child_session_id: string | null
        prompt_context_stats?: {
          task_id: string
          scoped_section_count: number
          global_index_section_count: number
          candidate_material_count: number
          prompt_char_count: number
        }
        review_progress?: { review_total: number; review_reused: number; review_pending: number; review_invalidated: number }
      }>
    }
    expect(log.observed_max_concurrency).toBe(2)
    expect(log.tasks.every(item => item.final_child_session_id !== null)).toBe(true)
    expect(log.tasks.every(item => item.prompt_context_stats !== undefined && item.prompt_context_stats.prompt_char_count > 0)).toBe(true)
    expect(log.tasks.every(item => item.prompt_context_stats?.global_index_section_count === 2)).toBe(true)
    expect(log.tasks.at(-1)?.review_progress).toMatchObject({ review_pending: 0, review_invalidated: 0 })
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      schema_version: number
      tasks: Array<{ task_id: string; refinement_conclusion?: string }>
    }
    expect(checkpoint.schema_version).toBe(5)
    expect(checkpoint.tasks.filter(item => item.task_id.startsWith('MAP-INIT-')).every(item => Boolean(item.refinement_conclusion))).toBe(true)
    expect(parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8'))).sources).toEqual([])
    expect(fixture.followup).not.toHaveBeenCalled()
    expect(fixture.outlineReviewPrompts).toHaveLength(1)
    expect(fixture.outlineReviewPrompts[0]).not.toContain('Main-Agent Planning')
    expect(fixture.outlineReviewRequests[0]).toMatchObject({ toolFilter: { allow: [] }, maxDepth: 1 })
    expect(fixture.outlineReviewPrompts[0]).not.toContain('全局候选资料池')
    expect(fixture.outlineReviewDisposals[0]).toHaveBeenCalledTimes(1)
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
        agent: child, callId: 'first-attempt-read-failure', name: 'read_source', arguments: { source_ref: 'unknown' },
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

  it.each([1, 2, 3, 4, 5])('重跑只接受 v5 checkpoint，当前版本为 %s', async (version) => {
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

    const checkpointPath = join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json')
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as { schema_version: number }
    expect(checkpoint.schema_version).toBe(5)
    if (version !== 5) await writeFile(checkpointPath, JSON.stringify({ ...checkpoint, schema_version: version }))
    const resumed = mappingFixture(workspace, material)
    const completedRun = executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0, maxConcurrency: 2 })
    if (version !== 5) {
      await expect(completedRun).rejects.toThrow('EVIDENCE_MAPPING_CHECKPOINT_VERSION_UNSUPPORTED')
      expect(resumed.starts).toHaveLength(0)
      return
    }
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

  it('恢复失败的 Final Check 仍要求逐项复核，不重复已接受的分支研究', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-review-resume-')))
    const material = await writeInputs(workspace)
    const first = mappingFixture(workspace, material)
    first.serializeReply.mockImplementation(value => value.task_id === 'MAP-FINAL-CHECK' ? '{' : JSON.stringify(value))
    const running = executeEvidenceMapping(first.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    const rejected = expect(running).rejects.toThrow()
    await vi.waitFor(() => { expect(first.starts).toHaveLength(2) })
    first.starts.forEach((start) => { start.resolve() })
    await rejected
    const resumed = mappingFixture(workspace, material)
    resumed.onFinalReply.mockImplementation((_child, result) => { result.section_mappings = [] })
    await executeEvidenceMapping(resumed.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 0 })
    expect(resumed.starts).toHaveLength(0)
    expect(resumed.finalStarts).toHaveLength(1)
    const prompt = promptText(resumed.finalStarts[0]!.request.request)
    expect(prompt).toContain('pending_review_items：')
    expect(prompt).toContain('"kind":"task"')
    expect(prompt).toContain('"kind":"local_material"')
  })

  it('仅修改父总述时只复核该父节点，保留全部叶节任务及材料', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-summary-only-review-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const running = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await running
    const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    const evidence = await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')
    const parent = { ...structuredClone(outline.sections[0]!), id: 'ROOT', writable: false, title: '总体方案',
      purpose: '统筹业务需求与技术响应。', must_answer: [], requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [],
      scoring_response_points: [], summary: '根据业务需求统筹各项技术响应，明确总体安排与成果要求。' }
    outline.sections = [parent, ...outline.sections.map(section => ({ ...section, parent_id: 'ROOT', level: 2 }))]
    const checking = mappingFixture(workspace, material)
    checking.onFinalReply.mockImplementation((_child, result) => { expect(result.section_mappings).toEqual([]) })
    const result = await executeEvidenceMappingFinalCheck(checking.agent, workspace, outline, [], {
      maxRepairAttempts: 0, maxConcurrency: 1, summarySectionIds: ['ROOT'],
    })
    expect(checking.starts).toHaveLength(0)
    expect(checking.finalStarts).toHaveLength(1)
    expect(promptText(checking.finalStarts[0]!.request.request)).not.toContain('"kind":"task"')
    expect(result.outline.sections[0]!.summary).toBe(parent.summary)
    expect(result.evidence).toEqual(JSON.parse(evidence))
  })

  it('目录复核的具体结构问题只重开所属分支，不交给 Final Check 空转', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-outline-review-findings-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace), false, {
      'MAP-REPAIR-SEC-1': [{
        type: 'split_section', section_id: 'SEC-1', children: [
          { title: '实施方法', purpose: '独立说明实施方法。', must_answer: ['如何实施？'] },
          { title: '质量控制', purpose: '独立说明质量控制。', must_answer: ['如何控制质量？'] },
        ],
      }],
    })
    fixture.serializeQuality.mockImplementationOnce(text => JSON.stringify({
      ...JSON.parse(text) as object,
      blocking_issues: [{ section_id: 'SEC-1', reason: '研究已识别实施方法与质量控制两个独立主题，但仍只藏在写作维度中。' }],
    }))
    const running = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(3) })
    fixture.starts[2]!.resolve()
    await running
    expect(fixture.starts.map(start => promptText(start.request.request)).filter(prompt => prompt.includes('MAP-REPAIR-SEC-1'))).toHaveLength(1)
    expect(fixture.starts.map(start => promptText(start.request.request)).some(prompt => prompt.includes('MAP-REPAIR-SEC-2'))).toBe(false)
    expect(fixture.outlineReviewPrompts).toHaveLength(2)
    expect(fixture.outlineReviewPrompts[0]).toContain('最终章节写作维度与研究用途：')
    expect(fixture.outlineReviewPrompts[0]).toContain('"material_usages":[{"usage":"reference","summary":"统一资料。"}]')
    expect(fixture.outlineReviewPrompts[0]).toContain('分支粒度结论：')
    expect(promptText(fixture.finalStarts[0]!.request.request)).not.toContain('"identified_issues":')
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
      tasks: Array<{ task_id: string; refinement_conclusion?: string; repair_base_outline?: unknown }>
    }
    const repairCheckpoint = checkpoint.tasks.find(item => item.task_id === 'MAP-REPAIR-SEC-1')
    expect(typeof repairCheckpoint?.refinement_conclusion).toBe('string')
    expect(repairCheckpoint?.repair_base_outline).toBeDefined()
  })

  it('Final Check 逐项保留未变更章节，程序发布完整 baseline 映射', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-final-delta-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.onFinalReply.mockImplementation((_child, result) => {
      result.section_mappings = []
    })
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution

    const prompt = promptText(fixture.finalStarts[0]!.request.request)
    expect(prompt).not.toContain('unchanged_section_ids')
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(evidence.section_mappings.map(mapping => mapping.section_id)).toEqual(['SEC-1', 'SEC-2'])
    expect(evidence.section_mappings.every(mapping => mapping.local_materials.length === 1)).toBe(true)
  })

  it('Final Check 对无 baseline 的新增章节返回 missing，replacement 后完成', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-final-check-new-section-')))
    const material = await writeInputs(workspace)
    const initialFixture = mappingFixture(workspace, material)
    const initial = executeEvidenceMapping(initialFixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(initialFixture.starts).toHaveLength(2) })
    initialFixture.starts.forEach((start) => { start.resolve() })
    await initial

    const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
    outline.sections.push({
      ...structuredClone(outline.sections[0]!), id: 'SEC-NEW', order: 3, title: '用户新增章节',
      purpose: '说明用户新增但尚未研究的章节。', must_answer: ['如何响应新增章节？'],
      requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [],
      writing_notes: [], suggested_tables: [], suggested_figures: [],
    })
    const fixture = mappingFixture(workspace, material, false, {}, false)
    const checking = executeEvidenceMappingFinalCheck(fixture.agent, workspace, outline, ['SEC-NEW'], {
      maxRepairAttempts: 0, maxConcurrency: 1,
    })
    await vi.waitFor(() => { expect(fixture.finalStarts).toHaveLength(1) })
    const final = fixture.finalStarts[0]!
    const childId = final.request.childId!
    await expect(fixture.invokeSubmissionTool(childId, 'finish_final_check', {})).resolves.toMatchObject({
      isError: false,
      value: { completed: false, missing_mapping_section_ids: ['SEC-NEW'], missing_summary_section_ids: [] },
    })
    await expect(fixture.invokeSubmissionTool(childId, 'replace_section_mapping', {
      section_id: 'SEC-NEW', local_materials: [], web_materials: [],
    })).resolves.toMatchObject({ isError: false, value: { remaining_section_ids: [] } })
    await expect(fixture.invokeSubmissionTool(childId, 'update_section_task', {
      section_id: 'SEC-NEW', basis: { kind: 'user_change', explanation: '按用户新增章节明确响应。', requirement_ids: [] },
      writing_brief: {
        purpose: '给出用户新增章节的实施响应。', must_answer: ['如何响应新增章节？'], writing_notes: ['说明方法和验收。'],
        suggested_tables: [], suggested_figures: [],
      },
    })).resolves.toMatchObject({ isError: false, value: { applied: true } })
    await fixture.reviewAll(childId)
    await expect(fixture.invokeSubmissionTool(childId, 'finish_final_check', {})).resolves.toMatchObject({
      isError: false, value: { completed: true },
    })
    final.complete()
    const result = await checking
    expect(result.evidence.section_mappings.find(mapping => mapping.section_id === 'SEC-NEW')).toMatchObject({
      section_id: 'SEC-NEW', local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: [],
    })
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
  it('旧标 Markdown 目录保留 Setext 和嵌套格式标题，排除代码块中的伪标题', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-reference-markdown-headings-')))
    await workspace.import([{
      name: 'reference-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode([
        '项目理解', '========', '', '**项目**背景', '--------', '',
        '```markdown', '# 代码示例不是目录', '```', '',
        '### 业务*需求*与[任务](https://example.test)', '',
        '## 实施方案', '', '### 内业判定', '', '# ',
      ].join('\n')),
    }])
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    expect(locations[0]?.outline).toEqual([
      { title: '项目理解', level: 1, order: 1, heading_path: ['项目理解'] },
      { title: '项目背景', level: 2, order: 2, heading_path: ['项目理解', '项目背景'] },
      { title: '业务需求与任务', level: 3, order: 3, heading_path: ['项目理解', '项目背景', '业务需求与任务'] },
      { title: '实施方案', level: 2, order: 4, heading_path: ['项目理解', '实施方案'] },
      { title: '内业判定', level: 3, order: 5, heading_path: ['项目理解', '实施方案', '内业判定'] },
    ])
  })

  it('完整读取旧标结构文件，拒绝跨文件定位、缺失 Corpus 和损坏结构', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-reference-outline-')))
    await writeInputs(workspace)
    const manifest = await workspace.readManifest()
    const referenceBid = manifest.files.find(file => file.role === 'reference_bid')!
    const reference = manifest.files.find(file => file.role === 'reference')!
    referenceBid.structurePath = `${referenceBid.corpusPath}/structure.json`
    const headings = [
      { title: '项目理解', level: 1, order: 1, heading_path: ['项目理解'] },
      { title: '项目背景', level: 2, order: 2, heading_path: ['项目理解', '项目背景'] },
      { title: '业务需求', level: 2, order: 3, heading_path: ['项目理解', '业务需求'] },
    ]
    const structure = join(workspace.projectRoot, referenceBid.structurePath)
    await writeFile(structure, JSON.stringify({ sections: headings }))
    expect((await resolveMappingCorpusLocations(workspace, manifest)).find(location => location.role === 'reference_bid')?.outline).toEqual(headings)
    const otherStructurePath = `${reference.corpusPath}/structure.json`
    await writeFile(join(workspace.projectRoot, otherStructurePath), JSON.stringify({ sections: headings }))
    await expect(resolveMappingCorpusLocations(workspace, {
      ...manifest, files: manifest.files.map(file => file === referenceBid ? { ...file, structurePath: otherStructurePath } : file),
    })).rejects.toThrow('EVIDENCE_MAPPING_CORPUS_INVALID')
    await expect(readDocumentOutlineHeadings(workspace, { ...referenceBid, structurePath: null, documentPath: reference.documentPath }))
      .rejects.toThrow('document-outline-source-mismatch')
    await expect(readDocumentOutlineHeadings(workspace, { ...referenceBid, corpusPath: null }))
      .rejects.toThrow('document-outline-corpus-missing')
    await writeFile(structure, JSON.stringify({ sections: [{ title: '缺少层级和顺序' }] }))
    await expect(resolveMappingCorpusLocations(workspace, manifest)).rejects.toThrow('EVIDENCE_MAPPING_CORPUS_INVALID')
  })

  it('Child 直接使用程序资料引用，通用 grep/read 不能绕过授权', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-locators-')))
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    const line = promptText(fixture.starts[0]!.request.request).split('\n').find(line => line.startsWith('可用资料目录与正文定位：'))!
    const locators = JSON.parse(line.slice('可用资料目录与正文定位：'.length)) as Array<{ source_ref: string }>
    expect(line).not.toContain(locations[0]!.chunks_path)
    expect(await fixture.invokeSubmissionTool(fixture.starts[0]!.request.childId!, 'read_source', { source_ref: locators[0]!.source_ref }))
      .toMatchObject({ isError: false, value: { file_id: material.fileId, body: expect.stringContaining('统一技术资料') as unknown } })
    const guard = (name: string, path: string) => mappingCorpusToolGuard(locations, 'session', {
      name, arguments: name === 'read' ? { file_path: path } : { path },
      agent: { session: { header: { cwd: workspace.root, origin: 'subagent', parentSession: 'session' } } },
    } as unknown as ToolExecution)
    for (const location of locations) {
      expect(guard('grep', location.chunks_path)).toBeDefined()
      expect(guard('grep', location.chunks[0]!.path)).toBeDefined()
      expect(guard('read', location.chunks[0]!.path)).toBeDefined()
      expect(guard('read', location.chunk_index_path)).toBeDefined()
      expect(guard('read', location.chunks_path)).toBeDefined()
      expect(guard('grep', location.chunk_index_path)).toBeDefined()
      if (process.platform === 'win32') expect(guard('read', location.chunks[0]!.path.replaceAll('\\', '/').toUpperCase())).toBeDefined()
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
      const wrongSection = structuredClone(valid)
      wrongSection.section_mappings[0]!.section_id = 'SEC-WRONG'
      const extraField = structuredClone(valid) as typeof valid & { section_mappings: Array<Record<string, unknown>> }
      extraField.section_mappings[0]!.legacy_mapping = true
      const invalidUsage = structuredClone(valid)
      invalidUsage.section_mappings[0]!.local_materials[0]!.usage = 'reference_bid'
      const invalidCoverage = structuredClone(valid) as typeof valid & {
        section_mappings: Array<{ writing_brief: { requirement_ids: string[] } }>
      }
      invalidCoverage.section_mappings[0]!.writing_brief.requirement_ids = ['R-WRONG']
      return [wrongSection, extraField, invalidUsage, invalidCoverage, value]
    })

    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
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
      outline,
      writingPlan: writingPlanFixture(outline),
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
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
  })

  it.each([
    ['json', 'OUTLINE_REFINEMENT_STRUCTURED_MISSING'],
    ['schema', 'OUTLINE_REFINEMENT_SCHEMA_INVALID'],
  ])('全局目录复核的 quality %s 由 Validator 引导修复，成功 Mapping Child 不重跑', async (kind, code) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-repair-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeQuality.mockReturnValueOnce(kind === 'json' ? '{' : '{}')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await execution
    const repairs = fixture.outlineReviewPrompts.filter(prompt => prompt.includes('上一份质量报告未通过校验'))
    expect(repairs).toHaveLength(1)
    expect(JSON.stringify(repairs)).toContain(code)
    expect(fixture.starts).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1, 1])
    expect(fixture.subagents.followup).not.toHaveBeenCalled()
    expect(fixture.followup).not.toHaveBeenCalled()
  })

  it('全局目录复核 repair 耗尽保留质量报告错误及已完成 Mapping Task', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-refinement-exhausted-')))
    const fixture = mappingFixture(workspace, await writeInputs(workspace))
    fixture.serializeQuality.mockReturnValue('{')
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 2 })
    const rejection = expect(execution).rejects.toMatchObject({ issues: [{ code: 'OUTLINE_REFINEMENT_STRUCTURED_MISSING', artifact: 'outline/quality-report.json' }] })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach((start) => { start.resolve() })
    await rejection
    expect(fixture.outlineReviewPrompts.filter(prompt => prompt.includes('上一份质量报告未通过校验'))).toHaveLength(2)
    expect([...fixture.taskAttempts.values()]).toEqual([1, 1])
    const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { failure: Array<{ code: string }>; tasks: Array<{ status: string }> }
    expect(log.failure.map(issue => issue.code)).toEqual(['OUTLINE_REFINEMENT_STRUCTURED_MISSING'])
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
      config: { allowedExtensions: ['.md'], maxFiles: 20, maxFileBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, docxTemplateMaxBytes: 300 * 1024 * 1024, modelStageRepairAttempts: 0, evidenceMappingMaxConcurrency: 2, chapterWritingMaxConcurrency: 1, wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120000, trustedHosts: [] } satisfies Config,
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
