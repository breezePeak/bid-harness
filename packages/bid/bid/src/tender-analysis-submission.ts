import { lstat, readFile } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ZodError, z } from 'zod'
import { zodJsonSchema } from './zod-json-schema.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import { within } from './index.ts'
import type { StageValidationIssue } from './control-plane-contract.ts'
import type { BidRunContext } from './run-coordinator.ts'
import {
  TENDER_ANALYSIS_SCHEMA_VERSION,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  type TenderSourceRef,
} from './tender-analysis-artifacts.ts'
import { createTenderScoringSelection } from './tender-analysis-confirmation.ts'
import { validateTenderAnalysis, validateTenderAnalysisDraft } from './tender-analysis-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { renderPdfPage } from './pdf-page-render.ts'

/** S2 tool that accepts one complete result or one Host-targeted repair while the Host owns deterministic fields. */
export const TENDER_ANALYSIS_SUBMISSION_TOOLS = ['submit_tender_analysis'] as const

/** S2-private visual inspection tools for successful tender inputs. */
export const TENDER_ANALYSIS_VIEW_TOOLS = ['view_pdf_page'] as const

/** Every execution-local tool admitted by the S2 protocol. */
export const TENDER_ANALYSIS_PRIVATE_TOOLS = [
  ...TENDER_ANALYSIS_VIEW_TOOLS,
  ...TENDER_ANALYSIS_SUBMISSION_TOOLS,
] as const

const PROJECT_SINGLE_FIELDS = ['project_name', 'tender_name', 'purchaser', 'owner'] as const
const PROJECT_LIST_FIELDS = [
  'project_background',
  'project_objectives',
  'project_scope',
  'technical_scope',
  'delivery_scope',
  'implementation_constraints',
  'key_technical_points',
] as const
const PROJECT_FIELDS = [...PROJECT_SINGLE_FIELDS, ...PROJECT_LIST_FIELDS] as const

type ProjectSingleField = typeof PROJECT_SINGLE_FIELDS[number]
type ProjectListField = typeof PROJECT_LIST_FIELDS[number]

interface TenderChunkLocator {
  readonly absolutePath: string
  readonly artifactPath: string
}

/** Host-owned, execution-local tender identity exposed to the model by short reference. */
export interface TenderLocator {
  readonly file_ref: string
  readonly file_id: string
  readonly name: string
  readonly chunks_path: string
  readonly chunk_index_path: string
  readonly chunks: ReadonlyMap<string, TenderChunkLocator>
  /** Validated original input path; never rendered to the model. */
  readonly source_path: string
  /** Manifest-declared media type for the original input. */
  readonly media_type: string
}

/** Model-provided source text associated with one tender chunk. */
export interface TenderSourceAnchor {
  readonly file_ref: string
  readonly chunk: string
  readonly anchor_text: string
}

/** Trimmed source text and chunk-wide canonical reference selected by the Host. */
export interface ResolvedTenderSource {
  readonly quote: string
  readonly source_ref: TenderSourceRef
}

interface SourcedValue<T> {
  readonly value: T
  readonly source_refs: TenderSourceRef[]
}

interface RequirementDraft {
  readonly id: string
  readonly category: string
  readonly raw_text: string
  readonly normalized_requirement: string
  readonly mandatory: boolean
  readonly source_refs: TenderSourceRef[]
}

interface ScoringDraft {
  readonly id: string
  readonly group: string | null
  readonly title: string
  readonly raw_text: string
  readonly criterion: string
  readonly score: number | null
  readonly score_range: { min: number; max: number } | null
  readonly must_answer: boolean
  readonly source_refs: TenderSourceRef[]
}

interface ComplianceDraft {
  readonly id: string
  readonly type: string
  readonly raw_text: string
  readonly normalized_rule: string
  readonly severity: 'fatal' | 'mandatory' | 'warning'
  readonly source_refs: TenderSourceRef[]
}

const text = z.string().trim().min(1)
const sourceAnchorSchema = z.object({
  file_ref: z.string().regex(/^T[1-9]\d*$/u),
  chunk: z.string().regex(/^chunk_[0-9]+$/u),
  anchor_text: text,
}).strict()
const sourcesSchema = z.array(sourceAnchorSchema).min(1)

const projectFactSchema = z.object({
  field: z.enum(PROJECT_FIELDS),
  value: z.union([text, z.null()]),
  sources: sourcesSchema,
}).strict()
const requirementSchema = z.object({
  category: text,
  normalized_requirement: text,
  mandatory: z.boolean(),
  sources: sourcesSchema,
}).strict()
const scoreRangeSchema = z.object({ min: z.number(), max: z.number() }).strict()
  .refine(value => value.max >= value.min, 'score_range.max must be at least score_range.min')
const scoringSchema = z.object({
  group: z.union([text, z.null()]),
  title: text,
  criterion: text,
  score: z.union([z.number(), z.null()]),
  score_range: z.union([scoreRangeSchema, z.null()]),
  must_answer: z.boolean(),
  sources: sourcesSchema,
}).strict()
const complianceSchema = z.object({
  type: text,
  normalized_rule: text,
  severity: z.enum(['fatal', 'mandatory', 'warning']),
  sources: sourcesSchema,
}).strict()
const tenderAnalysisSubmissionSchema = z.object({
  project_facts: z.array(projectFactSchema),
  requirements: z.array(requirementSchema),
  scoring_items: z.array(scoringSchema),
  compliance_items: z.array(complianceSchema),
}).strict()
const tenderAnalysisRepairSchema = z.object({
  repair: z.union([
    z.object({ project_fact: projectFactSchema }).strict(),
    z.object({ requirement: requirementSchema }).strict(),
    z.object({ scoring_item: scoringSchema }).strict(),
    z.object({ compliance_item: complianceSchema }).strict(),
  ]),
}).strict()
const tenderAnalysisToolSchema = z.union([tenderAnalysisSubmissionSchema, tenderAnalysisRepairSchema])

type TenderAnalysisSubmission = z.infer<typeof tenderAnalysisSubmissionSchema>
type TenderAnalysisRepair = z.infer<typeof tenderAnalysisRepairSchema>

const TENDER_ANALYSIS_CANDIDATE_PATH = 'analysis/tender-analysis-candidate.json'

function schema(value: z.ZodType): Record<string, unknown> {
  return zodJsonSchema(value)
}

function toolArgs<T>(input: unknown, parser: z.ZodType<T>): T {
  try {
    return parser.parse(input)
  } catch (error: unknown) {
    if (!(error instanceof ZodError)) throw error
    throw new ToolArgsError(error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`))
  }
}

function isSingleField(field: typeof PROJECT_FIELDS[number]): field is ProjectSingleField {
  return (PROJECT_SINGLE_FIELDS as readonly string[]).includes(field)
}

function sourceRefKey(ref: TenderSourceRef): string {
  return `${ref.file_id}\0${ref.chunk}\0${String(ref.line_start)}\0${String(ref.line_end)}`
}

function uniqueSourceRefs(values: readonly TenderSourceRef[]): TenderSourceRef[] {
  return [...new Map(values.map(value => [sourceRefKey(value), value])).values()]
}

/**
 * Resolve one model-provided anchor to a validated tender chunk.
 * @param workspace Workspace that owns the tender corpus.
 * @param locators Host-built tender identity table for this S2 execution.
 * @param source Model-provided short file reference, chunk id, and source text.
 * @returns Trimmed source text and the chunk-wide canonical line reference.
 */
export async function resolveTenderSourceAnchor(
  workspace: BidWorkspace,
  locators: readonly TenderLocator[],
  source: TenderSourceAnchor,
): Promise<ResolvedTenderSource> {
  const locator = locators.find(value => value.file_ref === source.file_ref)
  if (locator === undefined) throw new ToolArgsError([`file_ref: 未知 tender 引用 ${source.file_ref}。`])
  const chunk = locator.chunks.get(source.chunk)
  if (chunk === undefined) throw new ToolArgsError([`chunk: ${source.chunk} 不属于 ${source.file_ref}。`])
  const quote = source.anchor_text.trim()
  if (quote.length === 0) throw new ToolArgsError(['anchor_text: 必须是非空文本。'])
  await assertNoLinkedPath(workspace.root, chunk.absolutePath)
  const content = await readFile(chunk.absolutePath, 'utf8')
  return {
    quote,
    source_ref: {
      file_id: locator.file_id,
      chunk: chunk.artifactPath,
      line_start: 1,
      line_end: content.split('\n').length,
    },
  }
}

/**
 * Build stable T1..Tn locators for every successful tender in manifest order.
 * @param workspace Workspace that owns every manifest path.
 * @param manifest Validated manifest used for this S2 execution.
 * @returns Tender locators with validated chunk ownership.
 */
export async function buildTenderLocators(workspace: BidWorkspace, manifest: BidManifest): Promise<TenderLocator[]> {
  const tenders = manifest.files.filter(file => file.role === 'tender' && file.parseStatus === 'success')
  return Promise.all(tenders.map(async (file, index) => {
    if (file.chunksPath === null || file.chunkIndexPath === null) throw new Error(`tender-analysis-corpus-path-missing:${file.id}`)
    const indexPath = within(workspace.projectRoot, file.chunkIndexPath)
    await assertNoLinkedPath(workspace.root, indexPath)
    const chunkIndex = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    const chunks = new Map<string, TenderChunkLocator>()
    for (const entry of chunkIndex.chunks) {
      const artifactPath = posix.join(file.chunksPath, entry.path)
      const absolutePath = within(workspace.projectRoot, artifactPath)
      await assertNoLinkedPath(workspace.root, absolutePath)
      if (!(await lstat(absolutePath)).isFile()) throw new Error(`tender-analysis-chunk-invalid:${file.id}:${entry.id}`)
      chunks.set(entry.id, { absolutePath, artifactPath })
    }
    const sourcePath = within(workspace.projectRoot, file.inputPath)
    await assertNoLinkedPath(workspace.root, sourcePath)
    if (!(await lstat(sourcePath)).isFile()) throw new Error(`tender-analysis-source-invalid:${file.id}`)
    return {
      file_ref: `T${String(index + 1)}`,
      file_id: file.id,
      name: file.originalName,
      chunks_path: file.chunksPath,
      chunk_index_path: file.chunkIndexPath,
      chunks,
      source_path: sourcePath,
      media_type: file.mediaType,
    }
  }))
}

interface PdfPageViewValue {
  file_ref: string
  name: string
  page: number
  page_count: number
  image: ImageAttachmentRef
}

const pdfPageSchema = z.object({
  file_ref: z.string().trim().min(1),
  page: z.number().int().positive(),
}).strict()

async function assertImageCapableRoute(agent: Agent, exec: ToolRunContext): Promise<void> {
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('无法查看 PDF 页面：当前模型路由无法解析；请切换到支持图片输入的模型。')
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`无法查看 PDF 页面：模型“${model}”未声明图片输入能力；请切换到支持图片输入的模型。`)
  }
}

function pdfPageContent(value: PdfPageViewValue) {
  return [
    {
      type: 'text' as const,
      text: `<pdf_page>\nfile_ref: ${value.file_ref}\nname: ${value.name}\npage: ${String(value.page)}/${String(value.page_count)}\n</pdf_page>`,
    },
    { type: 'image' as const, attachment: value.image },
  ]
}

/** Execution-local S2 submission state and tool registrations. */
export interface TenderAnalysisSubmissionRuntime {
  readonly locators: readonly TenderLocator[]
  readonly completed: boolean
  readonly lastIssues: readonly StageValidationIssue[]
  /** Return only the current invalid item and its cited chunk text for repair. */
  repairContext(): unknown
  /** 在下一次请求组装前挂载或卸载 S2 私有提交工具。 */
  setToolsEnabled(enabled: boolean): void
  /** Remove every execution-local tool registration. */
  dispose(): void
}

function artifactsList() {
  return [
    { stage: 'tender_analysis' as const, type: 'tender_project', path: 'analysis/project.json' },
    { stage: 'tender_analysis' as const, type: 'tender_requirements', path: 'analysis/requirements.json' },
    { stage: 'tender_analysis' as const, type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
    { stage: 'tender_analysis' as const, type: 'tender_compliance', path: 'analysis/compliance.json' },
  ]
}

/**
 * Register the S2 inspection and complete-submission tools in the live Agent scope.
 * @param agent Live Bid Agent allowed to call the tools.
 * @param workspace Workspace receiving the final Host-authored Artifacts.
 * @param manifest Manifest frozen for this execution's tender identities and coverage.
 * @param run Run authority that owns tools, cancellation, and publication.
 * @returns Runtime status and a disposer for every registration.
 */
export async function attachTenderAnalysisSubmissionRuntime(
  agent: Agent,
  workspace: BidWorkspace,
  manifest: BidManifest,
  run: BidRunContext,
): Promise<TenderAnalysisSubmissionRuntime> {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('Bid tender analysis requires tools service')
  const locators = await buildTenderLocators(workspace, manifest)
  if (locators.length === 0) throw new Error('tender-analysis-tender-missing')
  let toolDisposers: Array<() => void> = []
  const definitions: ToolDefinition[] = []
  let toolsEnabled = true
  let disposed = false
  let completed = false
  let lastIssues: StageValidationIssue[] = []
  let candidate: TenderAnalysisSubmission | undefined
  let repairTarget: { kind: keyof TenderAnalysisSubmission; index: number } | undefined
  let currentRepairContext: unknown
  const candidatePath = within(workspace.projectRoot, TENDER_ANALYSIS_CANDIDATE_PATH)
  await assertNoLinkedPath(workspace.root, candidatePath)

  const sources = async (values: readonly TenderSourceAnchor[], path: string): Promise<{
    quotes: string[]
    source_refs: TenderSourceRef[]
    issues: StageValidationIssue[]
  }> => {
    const resolved: ResolvedTenderSource[] = []
    const issues: StageValidationIssue[] = []
    for (const [index, value] of values.entries()) {
      try {
        resolved.push(await resolveTenderSourceAnchor(workspace, locators, value))
      } catch (error: unknown) {
        const issuePath = `${path}.sources.${String(index)}`
        if (error instanceof ToolArgsError) {
          issues.push({ code: 'TENDER_ANALYSIS_SOURCE_INVALID', path: issuePath, message: error.message })
          continue
        }
        throw error
      }
    }
    return {
      quotes: [...new Set(resolved.map(value => value.quote))],
      source_refs: uniqueSourceRefs(resolved.map(value => value.source_ref)),
      issues,
    }
  }
  const recover = <T extends object>(exec: ToolRunContext, issues: readonly StageValidationIssue[], result: T): T & {
    readonly issues: readonly StageValidationIssue[]
  } => {
    lastIssues = [...issues]
    exec.concludeTurn()
    return { ...result, issues: lastIssues }
  }
  const operationIssue = (exec: ToolRunContext): StageValidationIssue | undefined => {
    if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
    if (completed) return {
      code: 'TENDER_ANALYSIS_OPERATION_NOT_ALLOWED',
      message: 'S2 已完成，不能重复提交。',
    }
  }
  const targetForIssue = (
    input: TenderAnalysisSubmission,
    issue: StageValidationIssue,
  ): { kind: keyof TenderAnalysisSubmission; index: number } => {
    const match = /^(project_facts|requirements|scoring_items|compliance_items)(?:\.|\[)(\d+)/u.exec(issue.path ?? '')
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { kind: match[1] as keyof TenderAnalysisSubmission, index: Number(match[2]) }
    }
    if (issue.artifact === 'analysis/requirements.json') return { kind: 'requirements', index: input.requirements.length }
    if (issue.artifact === 'analysis/scoring-origin.json') return { kind: 'scoring_items', index: input.scoring_items.length }
    if (issue.artifact === 'analysis/compliance.json') return { kind: 'compliance_items', index: input.compliance_items.length }
    return { kind: 'project_facts', index: input.project_facts.length }
  }
  const prepareRepair = async (
    input: TenderAnalysisSubmission,
    issues: readonly StageValidationIssue[],
  ): Promise<StageValidationIssue[]> => {
    const issue = issues[0]
    if (issue === undefined) throw new Error('tender-analysis-repair-issue-missing')
    run.reportProgress({
      phase: 'repairing',
      summary: '招标信息候选需要局部修正',
      details: issues.slice(0, 5).map(value => `${value.code}：${value.message}`),
    })
    repairTarget = targetForIssue(input, issue)
    const repairKey = repairTarget.kind === 'project_facts' ? 'project_fact'
      : repairTarget.kind === 'requirements' ? 'requirement'
        : repairTarget.kind === 'scoring_items' ? 'scoring_item' : 'compliance_item'
    const item = input[repairTarget.kind][repairTarget.index] ?? null
    const anchors = item === null ? [] : item.sources
    const relatedChunks = []
    const seen = new Set<string>()
    for (const anchor of anchors) {
      const key = `${anchor.file_ref}\0${anchor.chunk}`
      if (seen.has(key)) continue
      seen.add(key)
      const locator = locators.find(value => value.file_ref === anchor.file_ref)
      const chunk = locator?.chunks.get(anchor.chunk)
      if (chunk !== undefined) relatedChunks.push({
        file_ref: anchor.file_ref,
        chunk: anchor.chunk,
        text: await readFile(chunk.absolutePath, 'utf8'),
      })
    }
    if (relatedChunks.length === 0) {
      const signal = repairTarget.kind === 'scoring_items'
        ? /技术评分|技术评审|技术评价|评分标准|评分表|评审因素|分值|满分/u
        : repairTarget.kind === 'requirements' ? /技术要求|功能要求|性能要求|应当|应|必须|不得/u : undefined
      for (const locator of locators) {
        for (const [chunkId, chunk] of locator.chunks) {
          const text = await readFile(chunk.absolutePath, 'utf8')
          if (signal !== undefined && !signal.test(text)) continue
          relatedChunks.push({ file_ref: locator.file_ref, chunk: chunkId, text })
          if (relatedChunks.length >= 3) break
        }
        if (relatedChunks.length >= 3) break
      }
    }
    currentRepairContext = { repair_key: repairKey, issue, item, related_chunks: relatedChunks }
    return [issue]
  }
  const applyRepair = (input: TenderAnalysisRepair): void => {
    if (candidate === undefined || repairTarget === undefined) {
      throw new ToolArgsError(['repair: 当前没有等待修正的问题项，请先提交完整结果。'])
    }
    const expectedKey = repairTarget.kind === 'project_facts' ? 'project_fact'
      : repairTarget.kind === 'requirements' ? 'requirement'
        : repairTarget.kind === 'scoring_items' ? 'scoring_item' : 'compliance_item'
    const repair = input.repair as Record<string, unknown>
    const value = repair[expectedKey]
    if (value === undefined) throw new ToolArgsError([`repair: 当前只接受 ${expectedKey}。`])
    const items = candidate[repairTarget.kind] as unknown[]
    if (repairTarget.index === items.length) items.push(value)
    else items[repairTarget.index] = value
  }
  const output = {
    schema: { type: 'object' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
  const registerDefinition = (registered: ToolDefinition): void => {
    definitions.push(registered)
    if (toolsEnabled) toolDisposers.push(tools.register(registered))
  }
  const register = (definition: Omit<ToolDefinition, 'output'>): void => {
    const registered: ToolDefinition = {
      ...definition,
      output,
      presentCall: () => ({ card: 'generic', title: definition.name }),
    }
    registerDefinition(registered)
  }

  registerDefinition({
    name: 'view_pdf_page',
    description: '查看一个成功解析的 tender PDF 指定页。仅在 grep/read 无法可靠解释表格、图片或版式时使用；不得逐页浏览整份 PDF。',
    parameters: schema(pdfPageSchema),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => pdfPageContent(value as unknown as PdfPageViewValue),
    },
    presentCall: (args) => {
      const page = (args as { page?: unknown }).page
      const suffix = typeof page === 'number' || typeof page === 'string' ? ` ${String(page)}` : ''
      return { card: 'generic', title: `查看 PDF 页面${suffix}` }
    },
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
      const input = toolArgs(args, pdfPageSchema)
      const locator = locators.find(value => value.file_ref === input.file_ref)
      if (locator === undefined) throw new ToolArgsError([`file_ref: 未知 tender 引用 ${input.file_ref}。`])
      if (locator.media_type !== 'application/pdf') {
        throw new ToolArgsError([`file_ref: ${input.file_ref} 不是 PDF，不能使用 view_pdf_page。`])
      }
      const attachments = agent.ctx.get('attachments')
      if (attachments === undefined) throw new Error('无法查看 PDF 页面：当前运行环境未挂载附件存储。')
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new Error('无法查看 PDF 页面：当前运行环境不接受 PNG 图片。')
      }
      await assertImageCapableRoute(agent, exec)
      const rendered = await renderPdfPage(
        new Uint8Array(await readFile(locator.source_path)),
        input.page,
        attachments.imageLimits,
        exec.signal,
      )
      const image = await attachments.saveImage({
        data: rendered.data,
        mediaType: 'image/png',
        name: `${basename(locator.name)}-page-${String(input.page)}.png`,
      })
      return {
        file_ref: locator.file_ref,
        name: locator.name,
        page: input.page,
        page_count: rendered.pageCount,
        image,
      } satisfies PdfPageViewValue
    },
  })
  const setToolsEnabled = (enabled: boolean): void => {
    if (disposed || toolsEnabled === enabled) return
    toolsEnabled = enabled
    if (!enabled) {
      for (const dispose of toolDisposers.reverse()) dispose()
      toolDisposers = []
      return
    }
    toolDisposers = definitions.map(definition => tools.register(definition))
  }

  register({
    name: 'submit_tender_analysis',
    description: '首次提交完整 S2 语义结果；校验失败后只提交 Host 指定问题项的 repair。只填写实际内容和已读取的 tender 原文位置；Host 统一生成 ID、原文引用和正式 Artifact。',
    parameters: schema(tenderAnalysisToolSchema),
    async execute(args, exec) {
      const issue = operationIssue(exec)
      if (issue !== undefined) return recover(exec, [issue], { completed: false })
      const input = toolArgs(args, tenderAnalysisToolSchema)
      if ('repair' in input) applyRepair(input)
      else {
        if (repairTarget !== undefined) throw new ToolArgsError(['当前只接受 Host 指定问题项的 repair，不得重新提交完整结果。'])
        candidate = input
      }
      if (candidate === undefined) throw new Error('tender-analysis-candidate-missing')
      run.reportProgress({
        phase: 'collecting',
        summary: '正在解析招标信息候选及原文引用',
        details: [
          `项目事实 ${String(candidate.project_facts.length)} 项`,
          `技术要求 ${String(candidate.requirements.length)} 项`,
          `评分项 ${String(candidate.scoring_items.length)} 项`,
          `合规项 ${String(candidate.compliance_items.length)} 项`,
        ],
      })
      await run.commits.writeJson(candidatePath, candidate)
      const currentCandidate = candidate
      const singles = new Map<ProjectSingleField, SourcedValue<string | null>>()
      const lists = new Map<ProjectListField, Map<string, TenderSourceRef[]>>()
      const requirements: RequirementDraft[] = []
      const scoring: ScoringDraft[] = []
      const compliance: ComplianceDraft[] = []
      const issues: StageValidationIssue[] = []

      for (const [index, item] of currentCandidate.project_facts.entries()) {
        const resolved = await sources(item.sources, `project_facts.${String(index)}`)
        issues.push(...resolved.issues)
        if (resolved.issues.length > 0) continue
        if (isSingleField(item.field)) {
          singles.set(item.field, { value: item.value, source_refs: resolved.source_refs })
        } else if (item.value === null) {
          issues.push({
            code: 'TENDER_ANALYSIS_PROJECT_VALUE_INVALID',
            path: `project_facts.${String(index)}.value`,
            message: '项目数组字段必须提交非空字符串；未知字段直接省略。',
          })
        } else {
          const values = lists.get(item.field) ?? new Map<string, TenderSourceRef[]>()
          values.set(item.value, uniqueSourceRefs([...(values.get(item.value) ?? []), ...resolved.source_refs]))
          lists.set(item.field, values)
        }
      }
      for (const [index, item] of currentCandidate.requirements.entries()) {
        const resolved = await sources(item.sources, `requirements.${String(index)}`)
        issues.push(...resolved.issues)
        if (resolved.issues.length === 0) requirements.push({
          id: `REQ-${String(index + 1).padStart(3, '0')}`,
          category: item.category,
          raw_text: resolved.quotes.join('\n'),
          normalized_requirement: item.normalized_requirement,
          mandatory: item.mandatory,
          source_refs: resolved.source_refs,
        })
      }
      for (const [index, item] of currentCandidate.scoring_items.entries()) {
        const resolved = await sources(item.sources, `scoring_items.${String(index)}`)
        issues.push(...resolved.issues)
        if (resolved.issues.length === 0) scoring.push({
          id: '',
          group: item.group,
          title: item.title,
          raw_text: resolved.quotes.join('\n'),
          criterion: item.criterion,
          score: item.score,
          score_range: item.score_range,
          must_answer: item.must_answer,
          source_refs: resolved.source_refs,
        })
      }
      for (const [index, item] of currentCandidate.compliance_items.entries()) {
        const resolved = await sources(item.sources, `compliance_items.${String(index)}`)
        issues.push(...resolved.issues)
        if (resolved.issues.length === 0) compliance.push({
          id: `COM-${String(index + 1).padStart(3, '0')}`,
          type: item.type,
          raw_text: resolved.quotes.join('\n'),
          normalized_rule: item.normalized_rule,
          severity: item.severity,
          source_refs: resolved.source_refs,
        })
      }
      if (issues.length > 0) return recover(exec, await prepareRepair(currentCandidate, issues), { completed: false })

      const projectSources = uniqueSourceRefs([
        ...[...singles.values()].flatMap(value => value.source_refs),
        ...[...lists.values()].flatMap(values => [...values.values()].flat()),
      ])
      if (projectSources.length === 0) {
        const projectIssues = [{
          code: 'TENDER_ANALYSIS_PROJECT_SOURCE_MISSING',
          artifact: 'analysis/project.json',
          path: 'source_refs',
          message: '至少提交一个有真实 tender 引用的项目事实或摘要。',
        }] satisfies StageValidationIssue[]
        return recover(exec, await prepareRepair(currentCandidate, projectIssues), { completed: false })
      }
      const project = parseTenderProjectArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        ...Object.fromEntries(PROJECT_SINGLE_FIELDS.map(field => [field, singles.get(field)?.value ?? null])),
        ...Object.fromEntries(PROJECT_LIST_FIELDS.map(field => [field, [...(lists.get(field)?.keys() ?? [])]])),
        source_refs: projectSources,
        analyzed_tender_files: locators.map(locator => locator.file_id),
      })
      const requirementsArtifact = parseTenderRequirementsArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        requirements,
      })
      const scoringItems = new Map<string, Omit<ScoringDraft, 'id'> & { parent: null }>()
      for (const { id: _id, ...item } of scoring) {
        const key = JSON.stringify([
          item.group, item.title, item.raw_text, item.criterion, item.score, item.score_range, item.must_answer,
        ])
        const current = scoringItems.get(key)
        scoringItems.set(key, current === undefined ? { ...item, parent: null } : {
          ...current,
          source_refs: uniqueSourceRefs([...current.source_refs, ...item.source_refs]),
        })
      }
      const scoringArtifact = parseTenderScoringArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        scoring_items: [...scoringItems.values()].map((item, index) => ({
          ...item,
          id: `SC-${String(index + 1).padStart(3, '0')}`,
        })),
      })
      const complianceArtifact = parseTenderComplianceArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        compliance_items: compliance,
      })
      const artifacts = { project, requirements: requirementsArtifact, scoring: scoringArtifact, compliance: complianceArtifact }
      run.reportProgress({
        phase: 'validating',
        summary: '正在校验招标信息完整性与引用覆盖',
        details: [
          `技术要求 ${String(requirements.length)} 项`,
          `评分项 ${String(scoringItems.size)} 项`,
          `合规项 ${String(compliance.length)} 项`,
        ],
      })
      lastIssues = await validateTenderAnalysisDraft(workspace, manifest, artifacts)
      if (lastIssues.length > 0) return recover(exec, await prepareRepair(currentCandidate, lastIssues), { completed: false })

      await run.commits.publish(async (lease) => {
        for (const [path, value] of [
          ['analysis/project.json', project],
          ['analysis/requirements.json', requirementsArtifact],
          ['analysis/scoring-origin.json', scoringArtifact],
          ['analysis/tender-analysis-selection.json', createTenderScoringSelection(scoringArtifact)],
          ['analysis/compliance.json', complianceArtifact],
        ] as const) {
          const absolute = within(workspace.projectRoot, path)
          await assertNoLinkedPath(workspace.root, absolute)
          await lease.writeJson(absolute, value)
        }
      })
      const validation = await validateTenderAnalysis(workspace, 'tender_analysis', artifactsList())
      if (!validation.ok) throw new Error(`tender-analysis-host-artifact-invalid:${validation.issues.map(issue => issue.code).join(',')}`)
      completed = true
      lastIssues = []
      repairTarget = undefined
      currentRepairContext = undefined
      return {
        completed: true,
        summary: {
          tender_files: locators.length,
          requirements: requirements.length,
          scoring_items: scoringItems.size,
          compliance_items: compliance.length,
        },
      }
    },
  })

  return {
    locators,
    get completed() { return completed },
    get lastIssues() { return lastIssues },
    repairContext() { return currentRepairContext },
    setToolsEnabled,
    dispose() {
      disposed = true
      for (const dispose of toolDisposers.reverse()) dispose()
      toolDisposers = []
    },
  }
}
