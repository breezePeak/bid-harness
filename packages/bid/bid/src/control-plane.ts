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
  BID_TASK_STATUSES,
  BID_WORK_KINDS,
  BID_UPLOAD_FILES_HEADER,
  BID_UPLOAD_SESSION_HEADER,
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
  BidReviewChapterView,
  BidPageEstimate,
  BidPageTargetStatus,
  BidReviewIssueView,
  BidReviewMaterialView,
  BidReviewWorkbenchView,
  BidRevisionTaskStatus,
  BidTenderAnalysisConfirmationResult,
  BidRunData,
  BidRunResumeIdentity,
  BidRunDecision,
  BidRunDecisionType,
  BidRunNotice,
  BidRunSuspensionCause,
  BidWorkDescriptor,
  BidWorkKind,
  BidStage,
  BidStageExecutor,
  BidStagePolicy,
  BidStageTask,
  StageArtifact,
  BidTaskFailure,
  BidTaskState,
  BidTaskStatus,
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
export { BID_WRITING_ENTRY_PROJECTION_KEY } from './writing-entry-contract.ts'
export type { WritingEntryView, WritingEntryIntent, WritingEntryExpected, WritingEntryStop } from './writing-entry-contract.ts'
export { BID_DOCX_EXPORT_PROJECTION_KEY } from './docx-export-operation.ts'
export type { DocxExportOperation } from './docx-export-operation.ts'
export type {
  BidRevisionIssueStatus,
  BidRevisionIssueReference,
  BidRevisionIssueView,
  BidRevisionQueueView,
  BidAddRevisionIssueRequest,
  BidUpdateRevisionIssueRequest,
  BidDeleteRevisionIssueRequest,
  BidRevisionQueueErrorCode,
  BidRevisionQueueResult,
  BidRevisionComparisonView,
  BidRevisionComparisonErrorCode,
  BidRevisionComparisonResult,
} from './control-plane-contract.ts'
