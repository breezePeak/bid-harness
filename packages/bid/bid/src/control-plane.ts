/**
 * Browser-safe Bid control-plane data contracts.
 *
 * @module @deepseek-ai/dsh-bid/control-plane
 */
export {
  DOCX_TEMPLATE_MAX_BYTES,
  DOCX_TEMPLATE_NAME_HEADER,
  DOCX_TEMPLATE_REVISION_HEADER,
  DOCX_TEMPLATE_SIZE_HEADER,
  DOCX_TEMPLATE_UPLOAD_PATH,
} from './docx-format-contract.ts'
export type { DocxFormatSuggestion, DocxFormatRequest, DocxFormatView, DocxFormatState, DocxTemplateId, DocxTemplateLibraryView, DocxTemplateRecord, DocxTemplateSummary, DocxTemplateUploadResult, FormatField, FormatValues, FormatCandidate, FormatConflict, FormatEvidence, FormatEvidenceSource, FormatRole, FormatValue } from './docx-format-contract.ts'

/** Browser-safe Bid control-plane constants and types. */
export {
  BID_CLIENT_ACTIONS,
  BID_BINARY_UPLOAD_PATH,
  BID_RUNTIME_PROJECTION_KEY,
  BID_STAGES,
  BID_UPLOAD_FILES_HEADER,
  BID_UPLOAD_SESSION_HEADER,
  STAGE_RUN_STATUSES,
  parseBidReviewWorkbenchView,
} from './control-plane-contract.ts'
export type {
  BidDetailsView,
  BidClientAction,
  BidChapterReviewStatus,
  BidChapterIndicatorStatus,
  BidChapterWritingStatus,
  BidChapterRevisionReference,
  BidChapterRevisionRequest,
  BidChapterRevisionResult,
  BidChapterWritingGateErrorCode,
  BidChapterWritingGateResult,
  BidClientProjection,
  BidComposerCapability,
  BidComposerReason,
  BidDocumentRole,
  BidEvidenceMappingProgress,
  BidDocxExportErrorCode,
  BidDocxExportResult,
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
  BidStageStartErrorCode,
  BidStageStartResult,
  BidStageStopErrorCode,
  BidStageStopResult,
  BidReviewChapterView,
  BidPageEstimate,
  BidPageTargetStatus,
  BidReviewIssueView,
  BidReviewMaterialView,
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
export type { OutlineDraftView, OutlineReviewContext } from './outline-confirmation-artifacts.ts'
export type { OutlineDraftMutationRequest, OutlineDraftIdentityRequest, OutlineDraftMutationResult } from './outline-draft-store.ts'
export { OUTLINE_CONFIRMATION_ISSUES } from './outline-confirmation-issues.ts'
export type { OutlineConfirmationIssueCode, OutlineConfirmationRepairAction } from './outline-confirmation-issues.ts'
export { applyTenderAnalysisEdits } from './tender-analysis-confirmation.ts'
export type { TenderAnalysisConfirmationView, TenderAnalysisEditOperation } from './tender-analysis-confirmation.ts'
export type { TenderProjectArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'
