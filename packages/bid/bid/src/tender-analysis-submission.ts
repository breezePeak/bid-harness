import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ZodError, z } from 'zod'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import { within } from './index.ts'
import type { StageValidationIssue } from './control-plane-contract.ts'
import {
  TENDER_ANALYSIS_SCHEMA_VERSION,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  type TenderSourceRef,
} from './tender-analysis-artifacts.ts'
import { validateTenderAnalysis, validateTenderAnalysisDraft } from './tender-analysis-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** S2 tools that accept semantic records and let the Host own deterministic fields. */
export const TENDER_ANALYSIS_SUBMISSION_TOOLS = [
  'submit_project_fact',
  'submit_requirement',
  'submit_scoring_item',
  'submit_compliance_item',
  'finish_tender_analysis',
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
}

/** Model-side citation resolved immediately to a canonical tender source reference. */
export interface TenderQuoteSource {
  readonly file_ref: string
  readonly chunk: string
  readonly quote: string
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
  readonly parent_ref: string | null
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

const quoteSourceSchema = z.object({
  file_ref: z.string().regex(/^T[1-9]\d*$/u),
  chunk: z.string().regex(/^chunk_[0-9]+$/u),
  quote: z.string().min(1).refine(value => value.trim().length > 0, 'quote must contain text'),
}).strict()
const sourcesSchema = z.array(quoteSourceSchema).min(1)
const text = z.string().trim().min(1)
const replaceRef = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[1-9]\\d*$`, 'u')).optional()

const projectFactSchema = z.object({
  field: z.enum(PROJECT_FIELDS),
  value: z.union([text, z.null()]),
  sources: sourcesSchema,
}).strict()
const requirementSchema = z.object({
  replace_ref: replaceRef('R'),
  category: text,
  raw_text: text,
  normalized_requirement: text,
  mandatory: z.boolean(),
  sources: sourcesSchema,
}).strict()
const scoreRangeSchema = z.object({ min: z.number(), max: z.number() }).strict()
  .refine(value => value.max >= value.min, 'score_range.max must be at least score_range.min')
const scoringSchema = z.object({
  replace_ref: replaceRef('S'),
  parent_ref: z.union([z.string().regex(/^S[1-9]\d*$/u), z.null()]),
  group: z.union([text, z.null()]),
  title: text,
  raw_text: text,
  criterion: text,
  score: z.union([z.number(), z.null()]),
  score_range: z.union([scoreRangeSchema, z.null()]),
  must_answer: z.boolean(),
  sources: sourcesSchema,
}).strict()
const complianceSchema = z.object({
  replace_ref: replaceRef('C'),
  type: text,
  raw_text: text,
  normalized_rule: text,
  severity: z.enum(['fatal', 'mandatory', 'warning']),
  sources: sourcesSchema,
}).strict()
const finishSchema = z.object({}).strict()

function schema(value: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(value, { target: 'draft-7' })
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

function maskHtmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, match => match.replace(/[^\r\n]/gu, ' '))
}

function lineAt(value: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index++) if (value.charCodeAt(index) === 10) line++
  return line
}

/**
 * Resolve one model citation against the exact tender chunk and quote.
 * @param workspace Workspace that owns the tender corpus.
 * @param locators Host-built tender identity table for this S2 execution.
 * @param source Model-provided short file reference, chunk id, and exact quote.
 * @returns Canonical file id, workspace-relative chunk path, and inclusive one-based lines.
 */
export async function resolveTenderQuoteSourceRef(
  workspace: BidWorkspace,
  locators: readonly TenderLocator[],
  source: TenderQuoteSource,
): Promise<TenderSourceRef> {
  const locator = locators.find(value => value.file_ref === source.file_ref)
  if (locator === undefined) throw new ToolArgsError([`file_ref: 未知 tender 引用 ${source.file_ref}。`])
  const chunk = locator.chunks.get(source.chunk)
  if (chunk === undefined) throw new ToolArgsError([`chunk: ${source.chunk} 不属于 ${source.file_ref}。`])
  await assertNoLinkedPath(workspace.root, chunk.absolutePath)
  const content = await readFile(chunk.absolutePath, 'utf8')
  const searchable = maskHtmlComments(content)
  const first = searchable.indexOf(source.quote)
  if (first < 0) throw new ToolArgsError([`quote: 在 ${source.file_ref}/${source.chunk} 正文中不存在。`])
  if (searchable.indexOf(source.quote, first + 1) >= 0) {
    throw new ToolArgsError([`quote: 在 ${source.file_ref}/${source.chunk} 正文中出现多次；请提交更长的唯一原文。`])
  }
  const last = first + source.quote.length - 1
  const lineStart = lineAt(content, first)
  const lineEnd = lineAt(content, last)
  const lineCount = content.split('\n').length
  if (lineStart < 1 || lineEnd < lineStart || lineEnd > lineCount) throw new Error('tender-analysis-source-line-resolution-invalid')
  return { file_id: locator.file_id, chunk: chunk.artifactPath, line_start: lineStart, line_end: lineEnd }
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
    return {
      file_ref: `T${String(index + 1)}`,
      file_id: file.id,
      name: file.originalName,
      chunks_path: file.chunksPath,
      chunk_index_path: file.chunkIndexPath,
      chunks,
    }
  }))
}

/** Execution-local S2 submission state and tool registrations. */
export interface TenderAnalysisSubmissionRuntime {
  readonly locators: readonly TenderLocator[]
  readonly completed: boolean
  readonly lastIssues: readonly StageValidationIssue[]
  /** Remove every execution-local tool registration. */
  dispose(): void
}

function artifactsList() {
  return [
    { stage: 'tender_analysis' as const, type: 'tender_project', path: 'analysis/project.json' },
    { stage: 'tender_analysis' as const, type: 'tender_requirements', path: 'analysis/requirements.json' },
    { stage: 'tender_analysis' as const, type: 'tender_scoring', path: 'analysis/scoring.json' },
    { stage: 'tender_analysis' as const, type: 'tender_compliance', path: 'analysis/compliance.json' },
  ]
}

/**
 * Register the five S2 private tools in the live Agent scope.
 * @param agent Live Bid Agent allowed to call the tools.
 * @param workspace Workspace receiving the final Host-authored Artifacts.
 * @param manifest Manifest frozen for this execution's tender identities and coverage.
 * @returns Runtime status and a disposer for every registration.
 */
export async function attachTenderAnalysisSubmissionRuntime(
  agent: Agent,
  workspace: BidWorkspace,
  manifest: BidManifest,
): Promise<TenderAnalysisSubmissionRuntime> {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('Bid tender analysis requires tools service')
  const locators = await buildTenderLocators(workspace, manifest)
  if (locators.length === 0) throw new Error('tender-analysis-tender-missing')
  const singles = new Map<ProjectSingleField, SourcedValue<string | null>>()
  const lists = new Map<ProjectListField, Map<string, TenderSourceRef[]>>()
  const requirements = new Map<string, RequirementDraft>()
  const scoring = new Map<string, ScoringDraft>()
  const compliance = new Map<string, ComplianceDraft>()
  const disposers: Array<() => void> = []
  let completed = false
  let lastIssues: StageValidationIssue[] = []

  const sources = async (values: readonly TenderQuoteSource[]): Promise<TenderSourceRef[]> => (
    uniqueSourceRefs(await Promise.all(values.map(value => resolveTenderQuoteSourceRef(workspace, locators, value))))
  )
  const ensureAgent = (exec: ToolRunContext): void => {
    if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
    if (completed) throw new ToolArgsError(['value: tender analysis 已完成。'])
  }
  const output = {
    schema: { type: 'object' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
  const register = (definition: Omit<ToolDefinition, 'output'>): void => {
    disposers.push(tools.register({
      ...definition,
      output,
      presentCall: () => ({ card: 'generic', title: definition.name }),
    }))
  }

  register({
    name: 'submit_project_fact',
    description: '逐项记录一个有真实 tender 引用的项目事实或摘要；数组字段由 Host 聚合去重。',
    parameters: schema(projectFactSchema),
    async execute(args, exec) {
      ensureAgent(exec)
      const input = toolArgs(args, projectFactSchema)
      const resolved = await sources(input.sources)
      if (isSingleField(input.field)) {
        singles.set(input.field, { value: input.value, source_refs: resolved })
      } else {
        if (input.value === null) throw new ToolArgsError(['value: 数组字段必须逐项提交非空字符串。'])
        const field = input.field
        const values = lists.get(field) ?? new Map<string, TenderSourceRef[]>()
        values.set(input.value, uniqueSourceRefs([...(values.get(input.value) ?? []), ...resolved]))
        lists.set(field, values)
      }
      return { recorded: true, field: input.field, total_values: isSingleField(input.field) ? 1 : lists.get(input.field)?.size ?? 0 }
    },
  })

  register({
    name: 'submit_requirement',
    description: '新增或按 requirement_ref 覆盖一个原子技术要求；Host 保持正式 REQ ID。',
    parameters: schema(requirementSchema),
    async execute(args, exec) {
      ensureAgent(exec)
      const input = toolArgs(args, requirementSchema)
      const ref = input.replace_ref ?? `R${String(requirements.size + 1)}`
      const current = requirements.get(ref)
      if (input.replace_ref !== undefined && current === undefined) throw new ToolArgsError([`replace_ref: 未知 Requirement 引用 ${ref}。`])
      requirements.set(ref, {
        id: current?.id ?? `REQ-${String(requirements.size + 1).padStart(3, '0')}`,
        category: input.category,
        raw_text: input.raw_text,
        normalized_requirement: input.normalized_requirement,
        mandatory: input.mandatory,
        source_refs: await sources(input.sources),
      })
      lastIssues = []
      return { recorded: true, requirement_ref: ref, total_requirements: requirements.size }
    },
  })

  register({
    name: 'submit_scoring_item',
    description: '新增或按 scoring_ref 覆盖一个技术评分项；parent_ref 只引用本轮已接受的评分项。',
    parameters: schema(scoringSchema),
    async execute(args, exec) {
      ensureAgent(exec)
      const input = toolArgs(args, scoringSchema)
      if (input.parent_ref !== null && !scoring.has(input.parent_ref)) {
        throw new ToolArgsError([`parent_ref: 未知 Scoring 引用 ${input.parent_ref}。`])
      }
      const ref = input.replace_ref ?? `S${String(scoring.size + 1)}`
      const current = scoring.get(ref)
      if (input.replace_ref !== undefined && current === undefined) throw new ToolArgsError([`replace_ref: 未知 Scoring 引用 ${ref}。`])
      scoring.set(ref, {
        id: current?.id ?? `SC-${String(scoring.size + 1).padStart(3, '0')}`,
        parent_ref: input.parent_ref,
        group: input.group,
        title: input.title,
        raw_text: input.raw_text,
        criterion: input.criterion,
        score: input.score,
        score_range: input.score_range,
        must_answer: input.must_answer,
        source_refs: await sources(input.sources),
      })
      lastIssues = []
      return { recorded: true, scoring_ref: ref, parent_resolved: true, total_scoring_items: scoring.size }
    },
  })

  register({
    name: 'submit_compliance_item',
    description: '新增或按 compliance_ref 覆盖一个影响技术方案的合规或强制规则；Host 保持正式 COM ID。',
    parameters: schema(complianceSchema),
    async execute(args, exec) {
      ensureAgent(exec)
      const input = toolArgs(args, complianceSchema)
      const ref = input.replace_ref ?? `C${String(compliance.size + 1)}`
      const current = compliance.get(ref)
      if (input.replace_ref !== undefined && current === undefined) throw new ToolArgsError([`replace_ref: 未知 Compliance 引用 ${ref}。`])
      compliance.set(ref, {
        id: current?.id ?? `COM-${String(compliance.size + 1).padStart(3, '0')}`,
        type: input.type,
        raw_text: input.raw_text,
        normalized_rule: input.normalized_rule,
        severity: input.severity,
        source_refs: await sources(input.sources),
      })
      lastIssues = []
      return { recorded: true, compliance_ref: ref, total_compliance_items: compliance.size }
    },
  })

  register({
    name: 'finish_tender_analysis',
    description: '检查 staged S2 结果；可修正缺项返回 issues，通过后由 Host 写入并复核四个正式 Artifact。',
    parameters: schema(finishSchema),
    async execute(args, exec) {
      ensureAgent(exec)
      toolArgs(args, finishSchema)
      const projectSources = uniqueSourceRefs([
        ...[...singles.values()].flatMap(value => value.source_refs),
        ...[...lists.values()].flatMap(values => [...values.values()].flat()),
      ])
      if (projectSources.length === 0) {
        lastIssues = [{
          code: 'TENDER_ANALYSIS_PROJECT_SOURCE_MISSING',
          artifact: 'analysis/project.json',
          path: 'source_refs',
          message: '至少提交一个有真实 tender 引用的项目事实或摘要。',
        }]
        return { completed: false, issues: lastIssues }
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
        requirements: [...requirements.values()],
      })
      const scoringIds = new Map([...scoring].map(([ref, value]) => [ref, value.id]))
      const scoringArtifact = parseTenderScoringArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        scoring_items: [...scoring.values()].map(({ parent_ref: parentRef, ...value }) => ({
          ...value,
          parent: parentRef === null ? null : scoringIds.get(parentRef),
        })),
      })
      const complianceArtifact = parseTenderComplianceArtifact({
        schema_version: TENDER_ANALYSIS_SCHEMA_VERSION,
        compliance_items: [...compliance.values()],
      })
      const artifacts = { project, requirements: requirementsArtifact, scoring: scoringArtifact, compliance: complianceArtifact }
      lastIssues = await validateTenderAnalysisDraft(workspace, manifest, artifacts)
      if (lastIssues.length > 0) return { completed: false, issues: lastIssues }

      for (const [path, value] of [
        ['analysis/project.json', project],
        ['analysis/requirements.json', requirementsArtifact],
        ['analysis/scoring.json', scoringArtifact],
        ['analysis/compliance.json', complianceArtifact],
      ] as const) {
        const absolute = within(workspace.projectRoot, path)
        await assertNoLinkedPath(workspace.root, absolute)
        await writeFileAtomic(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      const validation = await validateTenderAnalysis(workspace, 'tender_analysis', artifactsList())
      if (!validation.ok) throw new Error(`tender-analysis-host-artifact-invalid:${validation.issues.map(issue => issue.code).join(',')}`)
      completed = true
      return {
        completed: true,
        summary: {
          tender_files: locators.length,
          requirements: requirements.size,
          scoring_items: scoring.size,
          compliance_items: compliance.size,
        },
      }
    },
  })

  return {
    locators,
    get completed() { return completed },
    get lastIssues() { return lastIssues },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
}
