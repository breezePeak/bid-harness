/**
 * Browser-safe Bid control-plane data contracts.
 *
 * @module @deepseek-ai/dsh-bid/control-plane
 */

/** Browser-safe Bid control-plane constants and types. */
export {
  BID_CLIENT_ACTIONS,
  BID_RUNTIME_PROJECTION_KEY,
  BID_STAGES,
  STAGE_RUN_STATUSES,
} from './control-plane-contract.ts'
export type {
  BidClientAction,
  BidClientProjection,
  BidComposerCapability,
  BidComposerReason,
  BidDocumentRole,
  BidFileIntakeErrorCode,
  BidFileIntakeFailure,
  BidFileIntakeResult,
  BidPromptAdmission,
  BidRetryErrorCode,
  BidRetryFailure,
  BidRetryResult,
  BidRuntimeState,
  BidStage,
  BidStageExecutor,
  BidStagePolicy,
  BidStageTask,
  StageArtifact,
  StageRunStatus,
  StageValidationIssue,
  StageValidationResult,
  BidUploadFile,
} from './control-plane-contract.ts'
