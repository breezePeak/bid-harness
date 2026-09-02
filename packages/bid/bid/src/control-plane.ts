/**
 * Browser-safe Bid control-plane data contracts.
 *
 * @module @deepseek-ai/dsh-bid/control-plane
 */

/** Browser-safe Bid control-plane constants and types. */
export {
  BID_CLIENT_ACTIONS,
  BID_BINARY_UPLOAD_PATH,
  BID_RUNTIME_PROJECTION_KEY,
  BID_STAGES,
  BID_UPLOAD_FILES_HEADER,
  BID_UPLOAD_SESSION_HEADER,
  STAGE_RUN_STATUSES,
} from './control-plane-contract.ts'
export type {
  BidClientAction,
  BidChapterReviewStatus,
  BidChapterWritingStatus,
  BidClientProjection,
  BidComposerCapability,
  BidComposerReason,
  BidDocumentRole,
  BidEvidenceMappingProgress,
  BidFileIntakeErrorCode,
  BidFileIntakeFileResult,
  BidFileIntakeFailure,
  BidFileIntakeResult,
  BidOutlineConfirmationResult,
  BidOutlineRegenerationResult,
  BidPromptAdmission,
  BidRetryErrorCode,
  BidRetryFailure,
  BidRetryResult,
  BidReviewChapterView,
  BidReviewIssueView,
  BidReviewWorkbenchView,
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
  BidBinaryUploadFile,
} from './control-plane-contract.ts'
export { BID_DOCUMENT_ROLES, isBidDocumentRole } from './control-plane-contract.ts'
export { applyOutlineEdits, buildOutlineView } from './outline-confirmation-browser.ts'
export type { OutlineEditOperation, OutlineViewSection } from './outline-confirmation-browser.ts'
export type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
export type { OutlineDraftView } from './outline-confirmation-artifacts.ts'
export type { OutlineDraftMutationRequest, OutlineDraftIdentityRequest, OutlineDraftMutationResult } from './outline-draft-store.ts'
export { OUTLINE_CONFIRMATION_ISSUES } from './outline-confirmation-issues.ts'
export type { OutlineConfirmationIssueCode, OutlineConfirmationRepairAction } from './outline-confirmation-issues.ts'
export { applyTenderAnalysisEdits } from './tender-analysis-confirmation.ts'
export type { TenderAnalysisConfirmationView, TenderAnalysisEditOperation } from './tender-analysis-confirmation.ts'
export type { TenderProjectArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'
