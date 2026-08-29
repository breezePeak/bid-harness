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
