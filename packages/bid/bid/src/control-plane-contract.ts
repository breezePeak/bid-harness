/** The ordered Bid Harness stages owned by the control plane. */
export const BID_STAGES = [
  'file_intake',
  'tender_analysis',
  'evidence_mapping',
  'outline_generation',
  'outline_confirmation',
  'chapter_writing',
  'book_review',
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

/** Minimal replayable state of a bid workflow. */
export interface BidRuntimeState {
  stage: BidStage
  status: StageRunStatus
}

/** The kinds of executor that may own a bid stage. */
export type BidStageExecutor = 'program' | 'agent' | 'user'

/** Static requirements and transition target for one bid stage. */
export interface BidStagePolicy {
  stage: BidStage
  executor: BidStageExecutor
  requiredInputs: string[]
  allowedTools: string[]
  forbiddenTools?: string[]
  requiredArtifacts: string[]
  validator: string
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
  artifact?: string
}

/** Artifact validation outcome used by the orchestrator to decide whether a stage may advance. */
export type StageValidationResult =
  | { ok: true }
  | { ok: false; issues: StageValidationIssue[] }

/** Bid actions that a host may expose to a client for the current runtime state. */
export const BID_CLIENT_ACTIONS = [
  'upload_files',
  'retry_stage',
  'confirm_outline',
  'send_message',
] as const

/** One host-authorized action that a Bid client may present. */
export type BidClientAction = typeof BID_CLIENT_ACTIONS[number]

/** Stable host reason codes for a disabled Bid composer. */
export type BidComposerReason =
  | 'bid.upload_required'
  | 'bid.stage_pending'
  | 'bid.stage_running'
  | 'bid.outline_confirmation_required'
  | 'bid.stage_failed'
  | 'bid.completed'

/** Host-produced client view of Bid runtime state and currently admitted actions. */
export interface BidClientProjection {
  runtime: BidRuntimeState
  allowedActions: BidClientAction[]
  composer:
    | { enabled: true }
    | { enabled: false; reason: BidComposerReason }
}

/** Result of host admission for an ordinary Bid composer message. */
export type BidPromptAdmission =
  | { admitted: true; stage: BidStage; input: string }
  | { admitted: false; reason: BidComposerReason | 'bid.prompt_empty' }
