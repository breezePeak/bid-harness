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
  BidFileIntakeFileResult,
  BidFileIntakeFailure,
  BidFileIntakeResult,
  BidOutlineConfirmationResult,
  BidPromptAdmission,
  BidRetryErrorCode,
  BidRetryFailure,
  BidRetryResult,
  BidTenderAnalysisConfirmationResult,
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
export { applyOutlineEdits, buildOutlineView } from './outline-confirmation-browser.ts'
export type { OutlineEditOperation, OutlineViewSection } from './outline-confirmation-browser.ts'
export type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
export { applyTenderAnalysisEdits } from './tender-analysis-confirmation.ts'
export type { TenderAnalysisConfirmationView, TenderAnalysisEditOperation } from './tender-analysis-confirmation.ts'
export type { TenderProjectArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'
