import { z } from 'zod'

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

/** The stage execution states owned by the control plane. */
export const STAGE_RUN_STATUSES = [
  'pending',
  'waiting_start',
  'running',
  'waiting_user',
  'attention_required',
  'failed',
  'completed',
] as const

/** Current execution state of one bid stage. */
export type StageRunStatus = typeof STAGE_RUN_STATUSES[number]

/** Current count of Host-owned S4 Mapping Tasks by execution state. */
export interface BidEvidenceMappingProgress {
  /** 初步确认目录中的可写叶子任务数。 */
  readonly initial: number
  /** 目录深化或用户编辑产生的补充任务数。 */
  readonly supplemental: number
  /** Number of Mapping Tasks in the approved execution plan. */
  readonly total: number
  /** Mapping Tasks whose Child result the Host accepted. */
  readonly completed: number
  /** Mapping Tasks currently assigned to a Child Session. */
  readonly running: number
  /** Mapping Tasks that have not started a Child Session. */
  readonly not_started: number
  /** Mapping Tasks 因基础设施异常或模型修复耗尽而失败。 */
  readonly failed: number
}

/** Minimal replayable state of a bid workflow. */
export interface BidRuntimeState {
  stage: BidStage
  status: StageRunStatus
  /** Host-recorded reason for the current failed stage. */
  readonly failureReason?: string | undefined
  /** Browser-safe validation details for the current failed stage. */
  readonly failureIssues?: readonly StageValidationIssue[] | undefined
}

/** The sole client-visible projection key for Bid runtime state. */
export const BID_RUNTIME_PROJECTION_KEY = 'bid.runtime' as const

/** User actions the Bid Host may admit for the current projection. */
export const BID_CLIENT_ACTIONS = [
  'upload_files',
  'start_stage',
  'stop_stage',
  'retry_stage',
  'export_docx',
  'revise_chapter',
  'confirm_tender_analysis',
  'confirm_outline',
  'regenerate_outline',
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
  | 'bid.stage_start_required'
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

/** Host-produced client view of Bid runtime state and currently admitted actions. */
export interface BidClientProjection {
  runtime: BidRuntimeState
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
  | { readonly ok: true; readonly value: BidRuntimeState; readonly files?: readonly BidFileIntakeFileResult[] | undefined }
  | { readonly ok: false; readonly error: BidFileIntakeFailure }

/** Stable result of an S3 or S4 outline-confirmation request. */
export type BidOutlineConfirmationResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_CONFIRM_NOT_ALLOWED' | 'BID_OUTLINE_DRAFT_CONFLICT' | 'BID_INVALID_USER_OUTLINE' | 'BID_CONFIRM_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[]; readonly current?: import('./outline-confirmation-artifacts.ts').OutlineDraftView } }

/** Stable result of an S3 or S4 outline-regeneration request. */
export type BidOutlineRegenerationResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_REGENERATE_NOT_ALLOWED' | 'BID_OUTLINE_FEEDBACK_REQUIRED' | 'BID_OUTLINE_DRAFT_CONFLICT' | 'BID_REGENERATE_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[]; readonly current?: import('./outline-confirmation-artifacts.ts').OutlineDraftView } }

/** Stable result of an S2 tender-analysis confirmation request. */
export type BidTenderAnalysisConfirmationResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: { readonly code: 'BID_SESSION_REQUIRED' | 'BID_OPERATION_IN_PROGRESS' | 'BID_CONFIRM_NOT_ALLOWED' | 'BID_INVALID_TENDER_ANALYSIS_EDIT' | 'BID_CONFIRM_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[] } }

/** Stable business rejection codes returned by the Bid retry action. */
export type BidRetryErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_RETRY_NOT_ALLOWED'
  | 'BID_RETRY_FAILED'

/** Sanitized Bid retry business failure. */
export interface BidRetryFailure {
  readonly code: BidRetryErrorCode
  readonly message: string
}

/** Result returned after one dedicated Bid retry request settles. */
export type BidRetryResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: BidRetryFailure }

/** Stable business rejection codes returned by the post-reset stage start action. */
export type BidStageStartErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_STAGE_START_NOT_ALLOWED'
  | 'BID_STAGE_START_FAILED'

/** Result returned after the user starts a reset stage. */
export type BidStageStartResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: { readonly code: BidStageStartErrorCode; readonly message: string } }

/** Stable business rejection codes returned by the explicit running-stage stop action. */
export type BidStageStopErrorCode =
  | 'BID_SESSION_REQUIRED'
  | 'BID_STAGE_STOP_NOT_ALLOWED'
  | 'BID_STAGE_OWNED_BY_ANOTHER_SESSION'

/** Result returned after an explicit stop request has cancelled the active stage operation. */
export type BidStageStopResult =
  | { readonly ok: true; readonly value: BidRuntimeState }
  | { readonly ok: false; readonly error: { readonly code: BidStageStopErrorCode; readonly message: string } }

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
export type BidChapterReviewStatus = 'not_started' | 'reviewing' | 'pass' | 'needs_attention' | 'failed'

/** Page-estimate state that never turns an unavailable calculation into a zero-page result. */
export type BidPageEstimate =
  | { readonly status: 'available'; readonly pages: number }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable' }

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
  }

/** Browser-safe outline and live chapter summary used by the S5 workbench. */
export interface BidReviewWorkbenchView {
  readonly schema_version: 2
  readonly outline: readonly {
    readonly section_id: string
    readonly parent_id: string | null
    readonly order: number
    readonly title: string
    readonly summary?: string
    readonly writable: boolean
    readonly writing_status: BidChapterWritingStatus
    readonly review_status: BidChapterReviewStatus
    readonly content_available: boolean
    /** Non-leaf section estimate; omitted for a leaf whose status dot remains interactive. */
    readonly page_estimate?: (BidPageEstimate & { readonly incomplete?: boolean }) | undefined
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
}

/** Browser-safe document-level compliance finding or project-delivery todo. */
export interface BidGlobalComplianceIssueView {
  readonly compliance_id: string
  readonly status: 'fail' | 'pending'
  readonly detail: string
  readonly affected_section_ids: readonly string[]
}

const pageEstimateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), pages: z.number().int().positive() }),
  z.strictObject({ status: z.literal('empty') }),
  z.strictObject({ status: z.literal('unavailable') }),
])
const chapterPageEstimateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), pages: z.number().int().positive(), incomplete: z.boolean().optional() }),
  z.strictObject({ status: z.literal('empty') }),
  z.strictObject({ status: z.literal('unavailable') }),
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
  }),
])
const reviewWorkbenchSchema = z.strictObject({
  schema_version: z.literal(2),
  outline: z.array(z.strictObject({
    section_id: z.string(), parent_id: z.string().nullable(), order: z.number().int(), title: z.string(),
    summary: z.string().optional(), writable: z.boolean(),
    writing_status: z.enum(['not_started', 'writing', 'content_ready', 'completed', 'failed']),
    review_status: z.enum(['not_started', 'reviewing', 'pass', 'needs_attention', 'failed']), content_available: z.boolean(), page_estimate: chapterPageEstimateSchema.optional(),
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
  readonly severity: 'blocking' | 'warning' | 'info'
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
