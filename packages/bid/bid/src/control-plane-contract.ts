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
  'running',
  'waiting_user',
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
  'retry_stage',
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

/** Whether an untrusted value names a supported Bid document purpose. */
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

/** Per-section writing state exposed by the S5 workbench. */
export type BidChapterWritingStatus = 'not_started' | 'writing' | 'content_ready' | 'completed' | 'failed'

/** Per-section review state exposed by the S5 workbench. */
export type BidChapterReviewStatus = 'not_started' | 'reviewing' | 'pass' | 'needs_attention' | 'failed'

/** Browser-safe outline and live chapter summary used by the S5 workbench. */
export interface BidReviewWorkbenchView {
  readonly schema_version: 1
  readonly outline: readonly {
    readonly section_id: string
    readonly parent_id: string | null
    readonly order: number
    readonly title: string
    readonly writable: boolean
    readonly writing_status: BidChapterWritingStatus
    readonly review_status: BidChapterReviewStatus
    readonly content_available: boolean
  }[]
  readonly summary: {
    readonly chapter_count: number
    readonly content_count: number
    readonly reviewed_count: number
    readonly needs_attention_count: number
  }
}

/** Browser-safe generic review finding reserved for later detailed-review rules. */
export interface BidReviewIssueView {
  readonly issue_id: string
  readonly section_id: string
  readonly category: string
  readonly severity: 'blocking' | 'warning' | 'info'
  readonly status: 'open' | 'resolved' | 'dismissed'
  readonly title: string
  readonly detail: string
  readonly suggestion: string
}

/** Browser-safe body for a selected S5 outline section. */
export interface BidReviewChapterView {
  readonly section_id: string
  readonly title: string
  readonly number: string
  readonly heading_path: readonly string[]
  readonly writable: boolean
  readonly markdown: string | null
  readonly requirement_ids: readonly string[]
  readonly scoring_response_point_ids: readonly string[]
  readonly evidence_status: 'available' | 'missing' | 'not_applicable'
  readonly review: { readonly status: BidChapterReviewStatus; readonly issues: readonly BidReviewIssueView[] }
}

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
