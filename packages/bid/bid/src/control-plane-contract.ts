import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import type { DocxTemplateId } from './docx-format-contract.ts'
import type { FlowchartSpec } from './flowchart.ts'

/** The ordered Bid Harness stages owned by the control plane. */
export const BID_STAGES = [
  'file_intake',
  'tender_analysis',
  'outline_generation',
  'evidence_mapping',
  'chapter_writing',
  'docx_export',
] as const

/** One fixed Bid Harness business stage. */
export type BidStage = typeof BID_STAGES[number]

/** The only durable statuses of a Bid task. */
export const BID_TASK_STATUSES = [
  'ready',
  'running',
  'waiting_user',
  'suspended',
  'failed',
  'completed',
] as const

/** One authoritative Bid task status. */
export type BidTaskStatus = typeof BID_TASK_STATUSES[number]

/** Latest bounded milestone reported by deterministic Run code. */
export interface BidRunProgress {
  /** Stable machine-readable phase within the current stage. */
  readonly phase: string
  /** Short user-visible description of the work currently in progress. */
  readonly summary: string
  /** Completed units, only when the executor knows an exact count. */
  readonly completed?: number | undefined
  /** Total units, only when the executor knows an exact count. */
  readonly total?: number | undefined
  /** At most five short supporting facts; never transcript or artifact content. */
  readonly details?: readonly string[] | undefined
  /** Host timestamp for this latest milestone. */
  readonly updatedAt: number
}

/** Progress input accepted by a live Run; the coordinator owns its timestamp. */
export type BidRunProgressInput = Omit<BidRunProgress, 'updatedAt'>

/** Durable terminal Run notice rendered in the conversation timeline. */
export interface BidRunNotice {
  /** Stable deduplication identity for one terminal Run outcome. */
  readonly noticeId: string
  /** Failed model turn replaced by this safe Run notice, or null outside a model turn. */
  readonly supersedesTurn: number | null
  /** The exact Run that reached a terminal resumable state. */
  readonly runId: string
  /** Workflow stage whose execution stopped. */
  readonly stage: BidStage
  /** Neutral user stop or an interrupted automatic attempt. */
  readonly kind: 'stopped' | 'interrupted' | 'completed'
  /** Presentation intent; the renderer does not infer severity from text. */
  readonly severity: 'info' | 'error'
  /** Host-authored, model-invisible user-facing summary. */
  readonly message: string
  /** 已完成能力 Work 的身份；其他 Run 通知不携带。 */
  readonly workId?: string
  /** 同批发布的结果凭据路径；其他 Run 通知不携带。 */
  readonly resultRef?: string
}

/** Why one Run stopped before completing its stage. */
export type BidRunSuspensionCause = 'user_stop' | 'retry_exhausted' | 'executor_error' | 'host_restart' | 'awaiting_input'

/** Durable decision family presented for a recoverable Bid boundary. */
export type BidRunDecisionType = 'run_recovery'

/** Structured result of one native user-question decision. */
export type BidRunDecision = 'continue' | 'restart_stage' | 'stop'

/** Identity of the suspended Run from which a new attempt resumes. */
export interface BidRunResumeIdentity {
  readonly runId: string
  readonly cause: BidRunSuspensionCause
}

/** Closed set of durable work admitted by the Bid Host. */
export const BID_WORK_KINDS = [
  'stage_execution',
  'capability_task',
  'file_intake',
  'evidence_remap',
  'outline_regeneration',
  'outline_confirmation',
  'chapter_revision',
  'chapter_revision_batch',
] as const

/** One resumable unit of work, independent of its individual Run attempts. */
export type BidWorkKind = typeof BID_WORK_KINDS[number]

/** Durable request and input identity shared by every attempt of one work item. */
export interface BidWorkDescriptor {
  readonly kind: BidWorkKind
  readonly workId: string
  readonly stage: BidStage
  readonly requestRef: string
  readonly requestSha256: string
  readonly inputFingerprint: string
}

/** Browser-safe failure details persisted at a task boundary. */
export interface BidTaskFailure {
  readonly code?: string | undefined
  readonly message: string
  readonly issues?: readonly StageValidationIssue[] | undefined
  readonly recovery?: {
    readonly kind: 'retry' | 'repair' | 'blocked'
    readonly unit: string
    readonly reason: string
    readonly candidateSha256?: string | undefined
  } | undefined
}

/** Persisted execution data for one running attempt. */
export interface BidRunData {
  readonly runId: string
  /** 接纳 Run 且持续处理公开聊天的顶层 Session。 */
  readonly interactionSessionId?: string | undefined
  /** Host 持有且执行 Run 模型工作的 Session。 */
  readonly executionSessionId?: string | undefined
  readonly epoch: number
  readonly baseProjectRevision: number
  /** Revision after this Run's `running` state was durably published. */
  readonly controlRevision?: number | undefined
  /** Exact durable work this attempt executes or resumes. */
  readonly work: BidWorkDescriptor
  /** The prior suspended attempt; a resumed Run always receives a fresh identity. */
  readonly resumeOf?: BidRunResumeIdentity | undefined
  /** Latest milestone only; prior progress remains solely in the Session event log. */
  readonly progress?: BidRunProgress | undefined
  readonly startedAt: number
  readonly updatedAt: number
}

/** Authoritative Bid task state; its discriminant makes invalid Run combinations unrepresentable. */
export type BidTaskState =
  | { readonly stage: BidStage; readonly status: 'ready'; readonly run: null }
  | { readonly stage: BidStage; readonly status: 'running'; readonly run: BidRunData }
  | {
    readonly stage: BidStage
    readonly status: 'waiting_user'
    readonly run: null
    readonly reason?: string | undefined
    readonly issues?: readonly StageValidationIssue[] | undefined
  }
  | {
    readonly stage: BidStage
    readonly status: 'suspended'
    readonly run: BidRunData & {
      readonly cause: BidRunSuspensionCause
      readonly error?: BidTaskFailure | undefined
    }
  }
  | { readonly stage: BidStage; readonly status: 'failed'; readonly run: null; readonly failure: BidTaskFailure }
  | { readonly stage: BidStage; readonly status: 'completed'; readonly run: null }

/** Current count of Host-owned S4 Mapping Tasks by execution state. */
export interface BidEvidenceMappingProgress {
  /** 初步确认目录中的可写叶子任务数。 */
  readonly initial: number
  /** 目录深化或用户编辑产生的补充任务数。 */
  readonly supplemental: number
  /** Number of Mapping Tasks in the approved execution plan. */
  readonly total: number
  /** Mapping Tasks whose accepted result is durable in the S4 checkpoint. */
  readonly completed: number
  /** Mapping Tasks currently assigned to a Child Session. */
  readonly running: number
  /** Mapping Tasks that have not started a Child Session. */
  readonly not_started: number
  /** Mapping Tasks 因基础设施异常或模型修复耗尽而失败。 */
  readonly failed: number
  /** 失败 Mapping Tasks 直接负责的 Section，按执行计划顺序去重。 */
  readonly failed_section_ids: readonly string[]
  /** 按执行日志稳定顺序排列的 Mapping Task 可见状态。 */
  readonly tasks: readonly {
    readonly task_id: string
    readonly title: string
    readonly phase: 'initial' | 'final_check'
    readonly status: 'pending' | 'running' | 'completed' | 'failed'
    readonly section_ids: readonly string[]
    readonly child_session_id: string | null
    readonly latest_issue: string | null
  }[]
}

/** The sole client-visible projection key for Bid runtime state. */
export const BID_RUNTIME_PROJECTION_KEY = 'bid.runtime' as const

/** User actions the Bid Host may admit for the current projection. */
export const BID_CLIENT_ACTIONS = [
  'upload_files',
  'export_docx',
  'revise_chapter',
  'confirm_tender_analysis',
  'confirm_outline',
  'regenerate_outline',
  'request_writing_requirements',
  'auto_start_chapter_writing',
  'send_message',
] as const

/** One user action admitted by the Bid Host. */
export type BidClientAction = typeof BID_CLIENT_ACTIONS[number]

/** The kinds of executor that may own a bid stage. */
export type BidStageExecutor = 'program' | 'agent' | 'user'

/** Timing of an explicit user decision relative to automatic work. */
export type BidStageUserGate = 'none' | 'before_execution' | 'after_validation'

/** Static requirements and transition target for one bid stage. */
export interface BidStagePolicy {
  stage: BidStage
  executor: BidStageExecutor
  requiredInputs: string[]
  allowedTools: string[]
  forbiddenTools?: string[]
  requiredArtifacts: string[]
  validator: string
  /** Explicit user decision timing for this stage. */
  userGate: BidStageUserGate
  nextStage: BidStage | null
}

/** One stage assignment produced from a policy for an executor. */
export interface BidStageTask {
  stage: BidStage
  objective: string
  inputs: string[]
  requiredArtifacts: string[]
  allowedTools: string[]
  constraints: string[]
}

/** Workspace reference to one artifact produced by a bid stage. */
export interface StageArtifact {
  stage: BidStage
  type: string
  path: string
}

/** One actionable reason that a stage artifact set failed validation. */
export interface StageValidationIssue {
  code: string
  message: string
  artifact?: string | undefined
  path?: string | undefined
}

/** An executor failure whose browser-safe validation issues explain the rejected output. */
export class BidStageExecutionError extends Error {
  /**
   * Create an executor failure from the issues that prevented the stage from continuing.
   * @param issues - browser-safe issues that identify the rejected Artifact or field.
   */
  constructor(public readonly issues: readonly StageValidationIssue[]) {
    super(issues.map(issue => [
      issue.code,
      issue.path === undefined ? undefined : `${issue.path}:`,
      issue.message,
    ].filter(value => value !== undefined).join(' ')).join('; '))
    this.name = 'BidStageExecutionError'
  }
}

/** A business result that preserves usable stage artifacts while requiring a bounded recovery or user decision. */
export class BidStageAttentionRequiredError extends BidStageExecutionError {
  constructor(issues: readonly StageValidationIssue[]) {
    super(issues)
    this.name = 'BidStageAttentionRequiredError'
  }
}

/** Artifact validation outcome used by the orchestrator to decide whether a stage may advance. */
export type StageValidationResult =
  | { ok: true }
  | { ok: false; issues: StageValidationIssue[] }

/** Stable host reason codes for a disabled Bid composer. */
export type BidComposerReason =
  | 'bid.upload_required'
  | 'bid.stage_pending'
  | 'bid.stage_running'
  | 'bid.tender_analysis_confirmation_required'
  | 'bid.outline_confirmation_required'
  | 'bid.stage_failed'
  | 'bid.completed'

/** Host-owned composer capability for a Bid Session. */
export type BidComposerCapability =
  | { enabled: true }
  | { enabled: false; reason: BidComposerReason }

/** Host-produced client view of the authoritative task state and currently admitted actions. */
export interface BidClientProjection {
  task: BidTaskState
  allowedActions: readonly BidClientAction[]
  composer: BidComposerCapability
  /** File-name suffixes accepted by the Host, including the leading dot. */
  allowedExtensions?: readonly string[] | undefined
  maxFiles?: number | undefined
  maxFileBytes?: number | undefined
  maxTotalBytes?: number | undefined
}

/** 已发布阶段详情；S4 执行期间的目录保持为 S3 确认版本。 */
export interface BidDetailsView {
  tender: import('./tender-analysis-confirmation.ts').TenderAnalysisConfirmationView | null
  outline: import('./outline-generation-artifacts.ts').OutlineArtifact | null
  /** 产物来源决定展示模式；与工作流阶段、编辑准入分别判断。 */
  outlinePresentation: {
    source: 'initial_confirmed' | 'final_candidate' | 'final_confirmed'
    baseline: import('./outline-generation-artifacts.ts').OutlineArtifact | null
    evidence: import('./evidence-mapping-artifacts.ts').EvidenceMapArtifact | null
    errors: string[]
  } | null
  body: boolean
  writingRequest?: import('./writing-requirements.ts').WritingRequest | null
}

/** One browser-selected file encoded for the dedicated Bid Host action. */
export interface BidUploadFile {
  readonly name: string
  /** Business purpose of this project material. */
  readonly role: BidDocumentRole
  readonly mediaType?: string
  readonly size: number
  readonly data: string
}

/** Same-origin S1 binary upload endpoint; its body concatenates the declared files in order. */
export const BID_BINARY_UPLOAD_PATH = '/api/bid-upload' as const

/** Request header carrying the current Bid Session identity. */
export const BID_UPLOAD_SESSION_HEADER = 'x-dsh-bid-session-id' as const

/** Request header carrying JSON metadata for the ordered binary file body. */
export const BID_UPLOAD_FILES_HEADER = 'x-dsh-bid-files' as const

/** Browser file metadata paired with the raw bytes in the binary S1 upload body. */
export interface BidBinaryUploadFile {
  readonly name: string
  readonly role: BidDocumentRole
  readonly mediaType?: string
  readonly size: number
}

/** Business purposes assigned to imported project materials. */
export const BID_DOCUMENT_ROLES = [
  'tender',
  'outline_framework',
  'reference_bid',
  'reference',
] as const

/** Business purpose assigned to one imported project material. */
export type BidDocumentRole = typeof BID_DOCUMENT_ROLES[number]

/**
 * Whether an untrusted value names a supported Bid document purpose.
 * @param value Untrusted document-purpose value.
 * @returns Whether the value is a supported document role.
 */
export function isBidDocumentRole(value: unknown): value is BidDocumentRole {
  return typeof value === 'string' && (BID_DOCUMENT_ROLES as readonly string[]).includes(value)
}

/** Stable business rejection codes returned by Bid file intake. */
export type BidFileIntakeErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_FILE_INTAKE_NOT_ALLOWED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_FILE_COUNT_LIMIT'
  | 'BID_FILE_SIZE_LIMIT'
  | 'BID_TOTAL_SIZE_LIMIT'
  | 'BID_FILE_TYPE_UNSUPPORTED'
  | 'BID_FILE_ROLE_INVALID'
  | 'BID_FILE_NAME_INVALID'
  | 'BID_FILE_INTAKE_FAILED'

/** Sanitized Bid file-intake business failure. */
export interface BidFileIntakeFailure {
  readonly code: BidFileIntakeErrorCode
  readonly message: string
  /** Per-file outcomes when the Host could identify individual failures. */
  readonly files?: readonly BidFileIntakeFileResult[] | undefined
}

/** Outcome of one file within a Bid intake request. */
export interface BidFileIntakeFileResult {
  readonly name: string
  readonly role: BidDocumentRole
  readonly status: 'completed' | 'failed'
  readonly error?: { readonly code: string; readonly message: string } | undefined
}

/** Result returned after one dedicated Bid file-intake request settles. */
export type BidFileIntakeResult =
  | { readonly ok: true; readonly value: BidTaskState; readonly files?: readonly BidFileIntakeFileResult[] | undefined }
  | { readonly ok: false; readonly error: BidFileIntakeFailure }

/** Stable result of an S3 or S4 outline-confirmation request. */
export type BidOutlineConfirmationResult =
  | { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_CONFIRM_NOT_ALLOWED' | 'BID_OUTLINE_DRAFT_CONFLICT' | 'BID_INVALID_USER_OUTLINE' | 'BID_CONFIRM_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[]; readonly current?: import('./outline-confirmation-artifacts.ts').OutlineDraftView } }

/** Stable result of an S3 or S4 outline-regeneration request. */
export type BidOutlineRegenerationResult =
  | { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_REGENERATE_NOT_ALLOWED' | 'BID_OUTLINE_FEEDBACK_REQUIRED' | 'BID_OUTLINE_DRAFT_CONFLICT' | 'BID_REGENERATE_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[]; readonly current?: import('./outline-confirmation-artifacts.ts').OutlineDraftView } }

/** Stable result of an S2 tender-analysis confirmation request. */
export type BidTenderAnalysisConfirmationResult =
  | { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_CONFIRM_NOT_ALLOWED' | 'BID_INVALID_TENDER_ANALYSIS_EDIT' | 'BID_CONFIRM_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[] } }

/** Stable rejection codes for the two S5 waiting-user actions. */
export type BidChapterWritingGateErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_CHAPTER_WRITING_GATE_NOT_ALLOWED'
  | 'BID_CHAPTER_WRITING_GATE_FAILED'
  | 'BID_WRITING_ENTRY_CONFLICT'
  | 'BID_WRITING_ENTRY_ACTION_NOT_ALLOWED'

/** Result of requesting manual requirements or starting S5 with the automatic default plan. */
export type BidChapterWritingGateResult =
  | { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly error: { readonly code: BidChapterWritingGateErrorCode; readonly message: string } }

/** Stable business rejection codes returned by an on-demand DOCX export. */
export type BidDocxExportErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_DOCX_EXPORT_NOT_ALLOWED'
  | 'BID_DOCX_EXPORT_FAILED'

/** Result returned after an on-demand DOCX export settles without changing S5 state. */
export type BidDocxExportResult =
  | { readonly ok: true; readonly value: { readonly path: string; readonly warnings?: readonly StageValidationIssue[] } }
  | {
    readonly ok: false
    readonly error: { readonly code: BidDocxExportErrorCode; readonly message: string; readonly issues?: readonly StageValidationIssue[] }
  }

/** Per-section writing state exposed by the S5 workbench. */
export type BidChapterWritingStatus = 'not_started' | 'writing' | 'content_ready' | 'completed' | 'failed'

/** Per-section review state exposed by the S5 workbench. */
export type BidChapterReviewStatus = 'not_started' | 'reviewing' | 'pass' | 'needs_input' | 'needs_attention' | 'failed'

/** Stable visual status vocabulary for a writable chapter in the review workbench. */
export type BidChapterIndicatorStatus = 'queued' | 'writing' | 'repairing' | 'content_ready' | 'reviewing' | 'needs_input' | 'needs_attention' | 'passed' | 'failed' | 'not_started'

/** 一次页数结果使用的排版基准和统计方法。 */
export interface BidPageEstimateBasis {
  readonly source: 'default' | 'template'
  readonly method: 'fast' | 'rendered'
  readonly template: { readonly id: DocxTemplateId; readonly name: string; readonly revision: number } | null
}

/** 页数状态不会把不可用的计算伪装成零页结果。 */
export type BidPageEstimate =
  | ({ readonly status: 'available'; readonly pages: number } & BidPageEstimateBasis)
  | ({ readonly status: 'empty' } & BidPageEstimateBasis)
  | { readonly status: 'unavailable'; readonly basis?: BidPageEstimateBasis }

type BidPageTarget = {
  readonly kind: 'approximate' | 'minimum' | 'maximum' | 'range'
  readonly min_pages: number | null
  readonly max_pages: number | null
  readonly estimate_basis: string
}

/** 已确认目标与当前未取整正文估算的独立状态。 */
export type BidPageTargetStatus =
  | { readonly status: 'not_set' }
  | { readonly status: 'not_required' }
  | { readonly status: 'unavailable'; readonly target: BidPageTarget | null; readonly reason: string }
  | {
    readonly status: 'met' | 'below' | 'above'
    readonly target: BidPageTarget
    readonly estimated_pages: number
    readonly difference: number
    readonly format_revision: number
    readonly format_source: 'default' | 'template'
    readonly format_template_id: DocxTemplateId | null
    readonly estimate_method: 'fast' | 'rendered'
  }

/** S5 工作台使用的浏览器安全目录及实时章节摘要。 */
export interface BidReviewWorkbenchView {
  readonly schema_version: number
  readonly outline: readonly {
    readonly section_id: string
    readonly parent_id: string | null
    readonly order: number
    readonly title: string
    readonly summary?: string
    readonly writable: boolean
    readonly writing_status: BidChapterWritingStatus
    readonly review_status: BidChapterReviewStatus
    readonly chapter_indicator: { readonly status: BidChapterIndicatorStatus; readonly tooltip: string }
    readonly content_available: boolean
    /** Non-leaf section estimate; omitted for a leaf whose status dot remains interactive. */
    readonly page_estimate?: (BidPageEstimate & { readonly incomplete?: boolean }) | undefined
    /** 批量修订叠加状态；不存在时表示该章节未参与当前批次。 */
    readonly revision?: {
      readonly batch_id: string
      readonly task_id: string
      readonly status: BidRevisionTaskStatus
      readonly issue_count: number
    }
  }[]
  readonly summary: {
    readonly chapter_count: number
    readonly content_count: number
    readonly reviewed_count: number
    readonly needs_attention_count: number
    readonly page_estimate: BidPageEstimate
    readonly page_target: BidPageTargetStatus
  }
  /** 文档级核验及项目递交待办，不计入任一章节红点。 */
  readonly global_compliance: {
    readonly status: 'not_required' | 'reviewing' | 'pass' | 'needs_attention'
    readonly reviewed_count: number
    readonly total_count: number
    readonly document_issues: readonly BidGlobalComplianceIssueView[]
    readonly delivery_todos: readonly BidGlobalComplianceIssueView[]
  }
  /** 当前活跃的批量修订进度摘要；不存在时表示无批次正在执行。 */
  readonly revision_batch?: {
    readonly batch_id: string
    readonly status: 'planning' | 'running' | 'suspended' | 'completed' | 'failed'
    readonly total_issues: number
    readonly completed: number
    readonly running: number
    readonly pending: number
    readonly needs_input: number
    readonly failed: number
    readonly conflict: number
  } | undefined
}

/** 批量修订中单个 task 的浏览器安全状态。 */
export type BidRevisionTaskStatus =
  | 'queued'
  | 'running'
  | 'reviewing'
  | 'repairing'
  | 'completed'
  | 'conflict'
  | 'failed'
  | 'needs_input'
  | 'blocked'

/** Browser-safe document-level compliance finding or project-delivery todo. */
export interface BidGlobalComplianceIssueView {
  readonly compliance_id: string
  readonly status: 'fail' | 'pending'
  readonly detail: string
  readonly affected_section_ids: readonly string[]
}

const docxTemplateIdSchema = z.string().regex(/^[a-f\d]{64}$/u) as unknown as z.ZodType<DocxTemplateId>
const pageEstimateBasisShape = {
  source: z.enum(['default', 'template']),
  method: z.enum(['fast', 'rendered']),
  template: z.strictObject({
    id: docxTemplateIdSchema,
    name: z.string(),
    revision: z.number().int().nonnegative(),
  }).nullable(),
}
const pageEstimateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), pages: z.number().int().positive(), ...pageEstimateBasisShape }),
  z.strictObject({ status: z.literal('empty'), ...pageEstimateBasisShape }),
  z.strictObject({ status: z.literal('unavailable'), basis: z.strictObject(pageEstimateBasisShape).optional() }),
])
const chapterPageEstimateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), pages: z.number().int().positive(), incomplete: z.boolean().optional(), ...pageEstimateBasisShape }),
  z.strictObject({ status: z.literal('empty'), ...pageEstimateBasisShape }),
  z.strictObject({ status: z.literal('unavailable'), basis: z.strictObject(pageEstimateBasisShape).optional() }),
])
const pageTargetSchema = z.strictObject({
  kind: z.enum(['approximate', 'minimum', 'maximum', 'range']),
  min_pages: z.number().int().positive().nullable(), max_pages: z.number().int().positive().nullable(),
  estimate_basis: z.string(),
})
const pageTargetStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not_set') }),
  z.strictObject({ status: z.literal('not_required') }),
  z.strictObject({ status: z.literal('unavailable'), target: pageTargetSchema.nullable(), reason: z.string() }),
  z.strictObject({
    status: z.enum(['met', 'below', 'above']), target: pageTargetSchema,
    estimated_pages: z.number().nonnegative(), difference: z.number(),
    format_revision: z.number().int().nonnegative(), format_source: z.enum(['default', 'template']),
    format_template_id: docxTemplateIdSchema.nullable(), estimate_method: z.enum(['fast', 'rendered']),
  }),
])
const reviewWorkbenchSchema = z.strictObject({
  schema_version: recordOnlySchemaVersion(6),
  outline: z.array(z.strictObject({
    section_id: z.string(), parent_id: z.string().nullable(), order: z.number().int(), title: z.string(),
    summary: z.string().optional(), writable: z.boolean(),
    writing_status: z.enum(['not_started', 'writing', 'content_ready', 'completed', 'failed']),
    review_status: z.enum(['not_started', 'reviewing', 'pass', 'needs_input', 'needs_attention', 'failed']),
    chapter_indicator: z.strictObject({
      status: z.enum(['queued', 'writing', 'repairing', 'content_ready', 'reviewing', 'needs_input', 'needs_attention', 'passed', 'failed', 'not_started']),
      tooltip: z.string().min(1),
    }),
    content_available: z.boolean(), page_estimate: chapterPageEstimateSchema.optional(),
    revision: z.strictObject({
      batch_id: z.string(), task_id: z.string(),
      status: z.enum(['queued', 'running', 'reviewing', 'repairing', 'completed', 'conflict', 'failed', 'needs_input', 'blocked']),
      issue_count: z.number().int().positive(),
    }).optional(),
  })),
  summary: z.strictObject({
    chapter_count: z.number().int().nonnegative(), content_count: z.number().int().nonnegative(),
    reviewed_count: z.number().int().nonnegative(),
    needs_attention_count: z.number().int().nonnegative(), page_estimate: pageEstimateSchema,
    page_target: pageTargetStatusSchema,
  }),
  global_compliance: z.strictObject({
    status: z.enum(['not_required', 'reviewing', 'pass', 'needs_attention']),
    reviewed_count: z.number().int().nonnegative(), total_count: z.number().int().nonnegative(),
    document_issues: z.array(z.strictObject({
      compliance_id: z.string(), status: z.enum(['fail', 'pending']), detail: z.string(), affected_section_ids: z.array(z.string()),
    })),
    delivery_todos: z.array(z.strictObject({
      compliance_id: z.string(), status: z.enum(['fail', 'pending']), detail: z.string(), affected_section_ids: z.array(z.string()),
    })),
  }),
  revision_batch: z.strictObject({
    batch_id: z.string(),
    status: z.enum(['planning', 'running', 'suspended', 'completed', 'failed']),
    total_issues: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    needs_input: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
  }).optional(),
})

/**
 * Validate the untrusted RPC body before the browser renders workbench state.
 * @param value Untrusted workbench response body.
 * @returns Validated review-workbench state.
 */
export function parseBidReviewWorkbenchView(value: unknown): BidReviewWorkbenchView {
  return reviewWorkbenchSchema.parse(value) as BidReviewWorkbenchView
}

/** Browser-safe generic review finding reserved for later detailed-review rules. */
export interface BidReviewIssueView {
  readonly issue_id: string
  readonly section_id: string
  /** 说明问题来自已保存的审核报告，还是 Writer / Reviewer 的执行记录。 */
  readonly source: 'review' | 'writing_execution' | 'review_execution'
  readonly category: string
  readonly severity: 'high' | 'medium' | 'low'
  readonly status: 'open' | 'resolved' | 'dismissed'
  readonly title: string
  readonly detail: string
  /** 审核报告明确给出修改建议时才返回，避免客户端编造建议。 */
  readonly suggestion?: string
}

/** Browser-safe reference material mapped to one S5 outline section. */
export interface BidReviewMaterialView {
  readonly source_kind: 'reference' | 'reference_bid' | 'web'
  readonly source_label: string
  readonly file_id: string
  readonly usage: string
  readonly summary: string
}

/** Browser-safe body for a selected S5 outline section. */
export interface BidReviewChapterView {
  readonly section_id: string
  readonly title: string
  readonly number: string
  readonly heading_path: readonly string[]
  readonly writable: boolean
  readonly markdown: string | null
  /** Host-validated structured flowcharts; legacy chapters return an empty list. */
  readonly flowcharts?: readonly FlowchartSpec[]
  /** 完整 markdown 的 SHA-256；正文尚未生成时为 null。 */
  readonly content_sha256: string | null
  readonly requirement_ids: readonly string[]
  readonly scoring_response_point_ids: readonly string[]
  readonly evidence_status: 'available' | 'missing' | 'not_applicable'
  readonly materials?: readonly BidReviewMaterialView[]
  readonly review: { readonly status: BidChapterReviewStatus; readonly issues: readonly BidReviewIssueView[] }
}

/** 对话框中与编写意见分开的章节或连续段落引用。 */
export type BidChapterRevisionReference = {
  readonly section_id: string
  readonly content_sha256: string
} & ({ readonly scope: 'chapter' } | {
  readonly scope: 'paragraphs'
  /** 完整 markdown 中的 UTF-16 起止偏移，end 不包含在选区内。 */
  readonly start: number
  readonly end: number
  readonly text: string
})

/** 一次仅交给指定章节原 Writer 的编写意见。 */
export interface BidChapterRevisionRequest {
  readonly instruction: string
  readonly reference: BidChapterRevisionReference
}

/** 修订成功返回新正文；失败保留原文并允许用户重新加载或修改意见。 */
export type BidChapterRevisionResult =
  | { readonly ok: true; readonly value: BidReviewChapterView }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 浏览器安全的审批意见状态；与后端 RevisionIssueStatus 一一对应。 */
export type BidRevisionIssueStatus =
  | 'pending' | 'scheduled' | 'running' | 'completed' | 'needs_input' | 'conflict' | 'failed'

/** 浏览器安全的章节或连续段落引用。 */
export type BidRevisionIssueReference =
  | { readonly scope: 'chapter'; readonly base_content_sha256: string }
  | { readonly scope: 'paragraphs'; readonly base_content_sha256: string; readonly start: number; readonly end: number; readonly text: string }

/** 浏览器安全的一条审批意见。 */
export interface BidRevisionIssueView {
  readonly issue_id: string
  readonly section_id: string
  readonly section_title: string
  readonly scope: 'paragraphs' | 'chapter'
  readonly reference: BidRevisionIssueReference
  readonly instruction: string
  readonly suggestion: string | null
  readonly status: BidRevisionIssueStatus
  readonly batch_id: string | null
  readonly created_at: number
  readonly updated_at: number
}

/** 浏览器安全的审批意见队列视图。 */
export interface BidRevisionQueueView {
  readonly schema_version: number
  readonly revision: number
  readonly issues: readonly BidRevisionIssueView[]
}

/** 浏览器安全的一次成功批量修订前后正文。 */
export interface BidRevisionComparisonView {
  readonly issue_id: string
  readonly batch_id: string
  readonly task_id: string
  readonly section_id: string
  readonly section_title: string
  readonly before_markdown: string
  readonly after_markdown: string
  readonly before_sha256: string
  readonly after_sha256: string
}

/** 历史 comparison 读取的稳定错误码。 */
export type BidRevisionComparisonErrorCode =
  | 'BID_REVISION_COMPARISON_NOT_AVAILABLE'
  | 'BID_REVISION_COMPARISON_NOT_FOUND'
  | 'BID_REVISION_COMPARISON_CORRUPT'

/** 读取一条审批意见所对应历史 comparison 的结果。 */
export type BidRevisionComparisonResult =
  | { readonly ok: true; readonly value: BidRevisionComparisonView }
  | { readonly ok: false; readonly error: { readonly code: BidRevisionComparisonErrorCode; readonly message: string } }

/** 浏览器提交的新建审批意见输入。 */
export interface BidAddRevisionIssueRequest {
  readonly section_id: string
  readonly scope: 'paragraphs' | 'chapter'
  readonly reference: BidRevisionIssueReference
  readonly instruction: string
  readonly suggestion: string | null
}

/** 浏览器提交的编辑审批意见输入。 */
export interface BidUpdateRevisionIssueRequest {
  readonly issue_id: string
  readonly expected_queue_revision: number
  readonly instruction?: string
  readonly suggestion?: string | null
  readonly reference?: BidRevisionIssueReference
  readonly scope?: 'paragraphs' | 'chapter'
}

/** 浏览器提交的删除审批意见输入。 */
export interface BidDeleteRevisionIssueRequest {
  readonly issue_id: string
  readonly expected_queue_revision: number
}

/** 审批意见队列操作的稳定错误码。 */
export type BidRevisionQueueErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_REVISION_QUEUE_NOT_ALLOWED'
  | 'BID_REVISION_QUEUE_CONFLICT'
  | 'BID_REVISION_ISSUE_INVALID'
  | 'BID_REVISION_ISSUE_NOT_FOUND'
  | 'BID_REVISION_ISSUE_NOT_EDITABLE'
  | 'BID_REVISION_ISSUE_NOT_DELETABLE'
  | 'BID_REVISION_ISSUE_SCOPE_MISMATCH'
  | 'BID_REVISION_ISSUE_INSTRUCTION_EMPTY'
  | 'BID_CHAPTER_REVISION_CONFLICT'
  | 'BID_CHAPTER_REVISION_SELECTION_INVALID'
  | 'BID_CHAPTER_REVISION_NOT_WRITABLE'
  | 'BID_REVIEW_SECTION_UNKNOWN'

/** 审批意见队列操作结果。 */
export type BidRevisionQueueResult =
  | { readonly ok: true; readonly value: BidRevisionQueueView }
  | { readonly ok: false; readonly error: { readonly code: BidRevisionQueueErrorCode; readonly message: string } }

/** Result of host admission for an ordinary Bid composer message. */
export type BidPromptAdmission =
  | { admitted: true; stage: BidStage; input: string }
  | { admitted: false; reason: BidComposerReason | 'bid.prompt_empty' }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Host-authorized Bid state and client capabilities. */
    [BID_RUNTIME_PROJECTION_KEY]: BidClientProjection
  }
}
