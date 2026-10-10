/**
 * Workspace-local import, parsing, manifest, and DOCX-export primitives for
 * the bid profile. The caller supplies the selected project workspace;
 * this module never stores an ambient current workspace or emits file bytes to
 * a model request.
 */
import { normalizeOutlineSectionTitle } from './outline-title.ts'

import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { bindBidInputRecovery, readBidInputRecovery, writeBidInputRecovery, retryableBidInputFailure,
  type BidInputBinding, type BidInputRecovery } from './bid-input-recovery.ts'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { seedDescriptorTurn, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import * as XLSX from 'xlsx'
import { z as zod } from 'zod'
import { extractDocument, type ExtractDocumentInput, type ExtractDocumentResult } from './document-extract.ts'
import { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, type DocumentChunkConfig } from './document-chunk.ts'
import { validateFileIntake } from './file-intake-validator.ts'
import { validateTenderAnalysis, validateTenderAnalysisCandidate } from './tender-analysis-validator.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import {
  applyTenderAnalysisEdits,
  createConfirmedTenderScoring,
  parseTenderScoringSelection,
  parseTenderAnalysisEditOperations,
  setTenderScoringSelection,
  type TenderAnalysisConfirmationView,
  type TenderAnalysisEditOperation,
} from './tender-analysis-confirmation.ts'
import { DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY, executeEvidenceMapping, executeEvidenceMappingFinalCheck, pruneWebEvidenceArtifacts, readEvidenceMappingLog, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { loadOutlineReviewSources } from './outline-review-sources.ts'
import { changedWritableSectionIds, reconcileSectionEvidence } from './section-evidence-context.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { executeOutlineGeneration, generateScopedOutlineOperations, generateScopedOutlineBusinessBindings } from './outline-generation-executor.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { OUTLINE_GENERATION_SCHEMA_VERSION, parseOutlineArtifact, type OutlineArtifact } from './outline-generation-artifacts.ts'
import { ensureTechnicalDeviationSection } from './outline-generation-normalization.ts'
import { assertBidMainSession, inspectBidStage, installStageInteractionTools, isBidHostSession, isBidMainSession, readStageJson, renderStageInteractionPrompt, stageInteractionSchema } from './stage-interaction.ts'
import { prepareBidStageContextTransition, recoverOverflowedBidStageContext, resetBidStageContext } from './stage-context.ts'
import { applyOutlineEdits, parseOutlineEditOperations } from './outline-confirmation-edits.ts'
import { outlineArtifactSha256, parseOutlineConfirmationArtifact, parseConfirmedOutlineArtifact, type OutlineDraftView, type OutlineReviewContext } from './outline-confirmation-artifacts.ts'
import { getOrCreateOutlineDraft, readCapabilityOutlineBaseline, mutateOutlineDraft, replaceOutlineDraft, type OutlineDraftIdentityRequest, type OutlineDraftMutationRequest, type OutlineDraftMutationResult } from './outline-draft-store.ts'
import { validateOutlineDraftForConfirmation } from './outline-confirmation-validator.ts'
import { parseOutlineRegenerationChangeSet, regenerationChangeSetMatches } from './outline-regeneration-artifacts.ts'
import {
  buildChapterWorklist,
  DEFAULT_CHAPTER_WRITING_COMPLETION_REPAIR_ROUNDS,
  DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
  executeChapterWriting,
  type ChapterWritingCommand,
  type ChapterWritingControl,
  type FlowchartVisualReviewPolicy,
} from './chapter-writing-executor.ts'
import { suggestDocxFormat } from './docx-format-suggestions.ts'
import { readDocxXml } from './docx-template.ts'
import { renderDocx, docxAssetHash } from './docx-render.ts'
import type { BidCoverData } from './docx-cover.ts'
import { buildDocxFromResolvedTemplate, docxTemplateHash } from './docx-build.ts'
import { docxFingerprint, readDocxFormat, readDocxTemplateLibrary, saveDocxFormat, saveDocxFormatInterpretation,
  clearDocxExportArtifacts, invalidateDocxLastExports, registerDocxExportArtifacts,
  saveDocxTemplate, setEstimateDocxTemplate, writeDocxFormat } from './docx-format-store.ts'
import {
  DOCX_TEMPLATE_MAX_BYTES,
  DOCX_TEMPLATE_NAME_HEADER,
  DOCX_TEMPLATE_REVISION_HEADER,
  DOCX_TEMPLATE_SIZE_HEADER,
  DOCX_TEMPLATE_UPLOAD_PATH,
} from './docx-format-contract.ts'
import type { DocxFormatRequest, DocxFormatView, DocxFormatSuggestion, DocxTemplateId, DocxTemplateLibraryView, DocxTemplateUploadResult } from './docx-format-contract.ts'
import { assessDocxExportPageTarget, executeDocxExport, validateDocxExport, collectDocxExportSnapshot, collectDocxMarkdown } from './docx-export.ts'
import type { TechnicalDeviationComposition } from './docx-compose.ts'
import { estimateChapterWritingPages, estimateDocxMarkdownPages } from './page-estimate.ts'
import { CHAPTER_EXECUTION_LOG_SCHEMA_VERSION, parseOrMigrateChapterExecutionLog, type ChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { CHAPTER_REVIEW_SCHEMA_VERSION, chapterCandidateSha256, parseChapterReviewArtifact, type ChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { parseChapterMetadata } from './chapter-writing-artifacts.ts'
import { readChapterLocation, readChapterLocations } from './chapter-storage.ts'
import { BID_CAPABILITIES, defaultBidCapabilityForStage } from './bid-capability-registry.ts'
import {
  activeCapabilityMappingWorkspace, askCapabilityTaskInput, capabilityPlanPatchRepeated, executeCapabilityTask, patchCapabilityTaskSteps,
  readCapabilityAwaitingInput, persistCapabilityTaskRequest, findCapabilityTaskRequest, readCapabilityTaskCheckpoint,
  capabilityTaskRequestSchema, capabilityTaskCheckpointSchema, collectCapabilityTaskVerificationInput,
  isCapabilityAuthorizationRecheckFailure, hasPendingCapabilityCorrection,
  type CapabilityTaskDispatcher, type CapabilityTaskRequest,
} from './bid-capability-task.ts'
import { capabilityPublicationReceiptSchema, readCapabilityPublicationReceipt, readCapabilityPublicationRecord,
  type CapabilityPublicationReceipt } from './bid-capability-changes.ts'
import {
  bidCapabilityTaskSchema, validateCapabilityTaskContentFollowup, type BidCapabilityTask,
} from './bid-capability-contract.ts'
import { readBidWorkDescriptor, bidWorkRoot } from './work-descriptor.ts'
import { bindBidTaskSourceContext, freezeBidTaskSource } from './bid-task-source.ts'
import { createBidCapabilityDispatcher, type BidCapabilityDispatcher } from './bid-capability-dispatcher.ts'
import { prepareWritingCapabilityPreservation } from './bid-writing-capability.ts'
import { cancelCapabilityRequestsForPlanPatch, cancelCapabilityRequestsForReset, enqueueCapabilityRequest,
  markCapabilityRequestApplied, markCapabilityRequestAppliedWithLease,
  pendingCapabilityWorkIds, readPendingCapabilityRequests } from './bid-capability-queue.ts'
import { inspectBidProject } from './bid-project-inspect.ts'
import { renderFlowchartSvg, validateFlowchartSpec } from './flowchart.ts'
import {
  createNativeVisioExport,
  detectFlowchartExportEnvironment,
  extractFlowchartSpecs,
  flowchartPlaceholder,
  type FlowchartExportMode,
  type NativeVisioExport,
} from './native-visio.ts'
import { createNativeWordFinalizer, DOCX_TOC_UPDATE_DEFERRED } from './native-word.ts'
import { createDocxVisualReviewer, reviewDocxVisualBlocks, type VisualReviewAdjustments, type VisualReviewModel } from './docx-visual-review.ts'
import { parseGlobalComplianceReviewArtifact } from './chapter-writing-global-review-artifacts.ts'
import { validateGlobalComplianceReview, type GlobalComplianceChapter } from './chapter-writing-global-review.ts'
import { chapterContentSha256, chapterRevisionRequestSchema } from './chapter-revision.ts'
import {
  addRevisionIssue as addRevisionIssueToQueue,
  commitRevisionQueueMutation,
  deleteRevisionIssue as deleteRevisionIssueFromQueue,
  readRevisionQueue,
  revisionIssueSchema,
  updateRevisionIssue as updateRevisionIssueInQueue,
  validateRevisionIssueReference,

  type RevisionQueueArtifact,
} from './chapter-revision-queue.ts'
import {
  writeRevisionBatch,
  commitRevisionBatchExecutionSettlement,
  readRevisionBatch,
  resumeRevisionBatchExecution,
  suspendRevisionBatchExecution,
  completeRevisionBatchExecution,
  failRevisionBatchExecution,
  updateRevisionBatchTaskStatus,
  settleRevisionBatchIssues,
  type RevisionBatchArtifact,
  type RevisionBatchExecutionInput,
  type RevisionBatchTaskExecution,
  type RevisionIssueCheck,
} from './chapter-revision-batch.ts'
import { readRevisionComparison } from './chapter-revision-comparison.ts'
import { readParagraphRevisionReview } from './chapter-paragraph-revision-artifacts.ts'
import {
  executeParagraphRevisionTask,
  isParagraphOnlyRevisionTask,
  runParagraphRevisionScheduler,
  type ParagraphRevisionTaskResult,
} from './chapter-paragraph-revision-executor.ts'
import { resolveSemanticRevisionPath } from './chapter-revision-lineage.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS, type ModelStageExecutionOptions, type StageSchedulerControl } from './model-stage-repair.ts'
import { BidOrchestrator, BidOrchestratorError } from './orchestrator.ts'
import { registerBidDocxExportProjection, registerBidRuntimeProjection, registerBidWritingEntryProjection } from './projection.ts'
import { reduceDocxExportOperation, type DocxExportOperation } from './docx-export-operation.ts'
import { BID_INITIAL_TASK_STATE, bidTaskStateSchema, buildBidStageTask, getBidClientProjection, getBidStagePolicy, reduceBidTaskState, suspendForHostRestart } from './runtime-state.ts'
import { BidRunCoordinator, type BidCommitScope, type BidRunContext } from './run-coordinator.ts'
import { sanitizeBidErrorText } from './safe-error.ts'
import { bidProjectTaskState, checkpointBidProjectState, commitBidProjectMutation, readBidProjectState, type BidProjectState } from './project-state.ts'
import { publishBidBatch, reconcileBidPublications, type BidPublicationLease } from './publication-batch.ts'
import { bidInputFingerprint, bidResetWorkPaths, bidWorkDescriptorSchema, persistBidWorkRequest, readBidWorkRequest } from './work-descriptor.ts'
import { prepareBidWorkingTree, publishBidWorkingPaths, readExistingBidWorkingTree } from './working-tree.ts'
import { assertNoLinkedPath, within, atomicBytes } from './workspace-path.ts'
import { BID_STAGES, BidStageExecutionError, isBidDocumentRole } from './control-plane-contract.ts'
import { BID_BINARY_UPLOAD_PATH, BID_UPLOAD_FILES_HEADER, BID_UPLOAD_SESSION_HEADER } from './control-plane-contract.ts'
import { appendBidSchemaWarning, createBidSchemaWarning } from './bid-events.ts'
import type {} from '@deepseek-ai/dsh-goal-round-driver'
import { bidCapabilityTakeoverRun, bidCompletedCapabilityRun, bidEvidenceMappingTakeoverRun, bidRecoverableRun, bidRecoveryFingerprint, bidRecoveryInstructionRepeated, bidRunRecoveryEligibility, bidWritingPlanRecoveryEligibility, isBidWritingPlanRecoverableFailure, safeRecoverableBidFailure } from './bid-recovery.ts'
import { BidRecoveryDriver, type BidRecoveryNotice } from './bid-recovery-driver.ts'
import { resolveBidToolAuthorization, withBidNativeTaskAuthorization } from './bid-tool-authorization.ts'
import type { BidSessionEventMap } from './bid-events.ts'
import {
  applyWritingPlanInput,
  createAutomaticWritingPlan,
  parseWritingPlan,
  validateWritingPlan,
  validateWritingPlanInput,
  writingRequestSchema,
  classifyWritingRequirementAnswer,
  WRITING_REQUIREMENT_NONE_OPTION,
  WRITING_REQUEST_SCHEMA_VERSION,
  WRITING_PLAN_SCHEMA_VERSION,
  type WritingRequest,
  type WritingRequirementMessageRef,
} from './writing-requirements.ts'
import {
  readCurrentWritingPlan,
  readWritingEntryStop,
  writeWritingEntryStop,
  removeWritingEntryStop,
} from './writing-entry-state.ts'
import type { WritingEntryStop, WritingEntryIntent, WritingEntryView, WritingEntryExpected } from './writing-entry-contract.ts'
import { writingEntryIntentSchema } from './writing-entry-contract.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'
import type { BidBeforeStageStart } from './orchestrator.ts'
import { assessBoundedMetric } from './acceptance-criteria.ts'
import { readBidChapterCommandJournal, withBidCommandJournalLock, writeBidChapterCommandJournal, type BidChapterCommandRecord } from './chapter-command-journal.ts'
import type {
  BidDetailsView,
  BidChapterRevisionRequest,
  BidChapterRevisionResult,
  BidChapterWritingGateErrorCode,
  BidChapterWritingGateResult,
  BidClientProjection,
  BidEvidenceMappingProgress,
  BidDocxExportErrorCode,
  BidDocxExportResult,
  BidFileIntakeErrorCode,
  BidFileIntakeFileResult,
  BidFileIntakeResult,
  BidOutlineConfirmationResult,
  BidOutlineRegenerationResult,
  BidTenderAnalysisConfirmationResult,
  BidReviewWorkbenchView,
  BidReviewChapterView,
  BidReviewIssueView,
  BidReviewMaterialView,
  BidRevisionTaskStatus,
  BidRunNotice,
  BidRunData,
  BidRunDecision,
  BidRunDecisionType,
  BidStage,
  BidWorkDescriptor,
  BidTaskState,
  BidCapabilityPlanView,
  BidDocumentRole,
  BidBinaryUploadFile,
  BidUploadFile,
  BidAddRevisionIssueRequest,
  BidUpdateRevisionIssueRequest,
  BidDeleteRevisionIssueRequest,
  BidRevisionQueueResult,
  BidRevisionQueueView,
  BidRevisionQueueErrorCode,
  BidRevisionComparisonResult,
  StageArtifact,
  StageValidationIssue,
} from './control-plane-contract.ts'

export { extractDocument } from './document-extract.ts'
export type { DocumentMetadata, DocumentParseStatus, DocumentSection, ExtractDocumentInput, ExtractDocumentResult } from './document-extract.ts'
export { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, parseDocumentChunkIndex } from './document-chunk.ts'
export type { ChunkDocumentInput, ChunkDocumentResult, DocumentChunkConfig, DocumentChunkEntry, DocumentChunkIndex } from './document-chunk.ts'
export { BID_CLIENT_ACTIONS, BID_DOCUMENT_ROLES, BID_RUNTIME_PROJECTION_KEY, BID_STAGES, BID_TASK_STATUSES, BID_WORK_KINDS, isBidDocumentRole, parseBidReviewWorkbenchView } from './control-plane-contract.ts'
export { createAutomaticWritingPlan, parseWritingPlan, validateWritingPlan, writingPlanInputSchema, writingPlanSchema, writingRequestSchema, WRITING_PLAN_SCHEMA_VERSION, WRITING_REQUIREMENT_NONE_OPTION } from './writing-requirements.ts'
export type { WritingPlan, WritingPlanInput, WritingRequest } from './writing-requirements.ts'
export type {
  BidChapterRevisionReference,
  BidChapterRevisionRequest,
  BidChapterRevisionResult,
  BidChapterWritingGateErrorCode,
  BidChapterWritingGateResult,
  BidChapterIndicatorStatus,
  BidClientAction,
  BidDocumentRole,
  BidEvidenceMappingProgress,
  BidDocxExportErrorCode,
  BidDocxExportResult,
  BidClientProjection,
  BidComposerReason,
  BidPromptAdmission,
  BidComposerCapability,
  BidFileIntakeErrorCode,
  BidFileIntakeFailure,
  BidFileIntakeResult,
  BidOutlineRegenerationResult,
  BidTenderAnalysisConfirmationResult,
  BidReviewWorkbenchView,
  BidPageEstimate,
  BidPageEstimateBasis,
  BidPageTargetStatus,
  BidReviewChapterView,
  BidReviewMaterialView,

  BidRunData,
  BidRunResumeIdentity,
  BidRunDecision,
  BidRunDecisionType,
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
  BidAddRevisionIssueRequest,
  BidUpdateRevisionIssueRequest,
  BidDeleteRevisionIssueRequest,
  BidRevisionQueueResult,
  BidRevisionQueueView,
  BidRevisionIssueView,
  BidRevisionIssueStatus,
  BidRevisionIssueReference,
  BidRevisionQueueErrorCode,
  BidRevisionComparisonResult,
  BidCapabilityPlanView,
} from './control-plane-contract.ts'
export { BID_SESSION_EVENT_TYPES, appendBidSchemaWarning, createBidSchemaWarning } from './bid-events.ts'
export type { BidSchemaWarning, BidSchemaWarningReason, BidSessionEventMap, BidSessionEventType } from './bid-events.ts'
export {
  BID_INITIAL_TASK_STATE,
  bidTaskStateSchema,
  buildBidStageTask,
  getBidClientProjection,
  getBidStagePolicy,
  reduceBidTaskState,
  suspendForHostRestart,
} from './runtime-state.ts'
export { BidCommitScope, BidRunCoordinator, DirectBidRunScheduler, createTestBidRunContext } from './run-coordinator.ts'
export type { BidChildScope, BidCommitLease, BidRunActivityScope, BidRunCheckpoint, BidRunContext, BidRunScheduler } from './run-coordinator.ts'
export { BidOrchestrator, BidOrchestratorError }
export type {
  BidOrchestratorErrorCode,
  BidStageContextTransition,
  BidStageExecutorPort,
  BidStageValidatorPort,
} from './orchestrator.ts'
export { validateFileIntake }
export * from './tender-analysis-artifacts.ts'
export * from './tender-analysis-confirmation.ts'
export * from './tender-analysis-submission.ts'
export * from './scoring-response-point-artifacts.ts'
export { executeTenderAnalysis, renderTenderAnalysisRepairTask, renderTenderAnalysisTask } from './tender-analysis-executor.ts'
export { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS } from './model-stage-repair.ts'
export type { ModelStageExecutionOptions, StageSchedulerControl } from './model-stage-repair.ts'
export { validateTenderAnalysis, validateTenderAnalysisDraft } from './tender-analysis-validator.ts'
export type { TenderAnalysisArtifacts } from './tender-analysis-validator.ts'
export * from './evidence-mapping-artifacts.ts'
export * from './section-evidence-context.ts'
export * from './evidence-mapping-corpus.ts'
export * from './web-evidence-source-artifacts.ts'
export * from './web-evidence-snapshot.ts'
export * from './web-evidence-chunks.ts'
export * from './web-research-pool.ts'
export {
  DEFAULT_EVIDENCE_MAPPING_INFRASTRUCTURE_RETRY_ATTEMPTS,
  DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
  executeEvidenceMapping,
  executeEvidenceMappingFinalCheck,
  buildEvidenceMappingAcceptanceReport,
  mergeEvidenceMappingPartialResults,
  parseEvidenceMappingExecutionLog,
  readEvidenceMappingLog,
  readEvidenceMappingProgress,
  renderEvidenceMappingSubagentTask,
  buildEvidenceMappingPlan,
  type MergedEvidenceMappingResults,
  type EvidenceMappingAcceptanceReport,
  type EvidenceMappingAcceptanceToolStats,
  type EvidenceMappingExecutionLog,
  type SectionResearchAssessment,
  type SectionStructureAssessment,
} from './evidence-mapping-executor.ts'
export type { EvidenceMappingExecutionOptions } from './evidence-mapping-executor.ts'
export { validateEvidenceMapping } from './evidence-mapping-validator.ts'
export * from './outline-generation-artifacts.ts'
export * from './outline-confirmation-artifacts.ts'
export * from './outline-confirmation-edits.ts'
export * from './outline-confirmation-issues.ts'
export * from './outline-draft-store.ts'
export * from './outline-regeneration-artifacts.ts'
export { executeOutlineGeneration, renderOutlineGenerationRepairTask, renderOutlineGenerationTask } from './outline-generation-executor.ts'
export { validateOutlineGeneration } from './outline-generation-validator.ts'
export { validateOutlineGenerationQuality } from './outline-generation-quality-validator.ts'
export { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
export { validateConfirmedOutline } from './outline-confirmation-validator.ts'
export * from './chapter-writing-artifacts.ts'
export * from './flowchart.ts'
export * from './chapter-writing-review-artifacts.ts'
export * from './chapter-writing-global-review-artifacts.ts'
export { parseChapterWritingCompletionState } from './chapter-writing-completion-review.ts'
export type { ChapterWritingCompletionState } from './chapter-writing-completion-review.ts'
export { buildGlobalComplianceEvidence, validateGlobalComplianceReview } from './chapter-writing-global-review.ts'
export * from './chapter-writing-plan-artifacts.ts'
export {
  bidCapabilityInputSchema, bidCapabilityResultSchema, bidCapabilityScopeSchema,
  bidCapabilityStepSchema, bidCapabilityStepScopeSchema, bidCapabilityTaskSchema,
} from './bid-capability-contract.ts'
export type {
  BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityId, BidCapabilityResult,
  BidCapabilityScope, BidCapabilityStepScope,
} from './bid-capability-contract.ts'
export { BID_CAPABILITIES, resolveCapabilityStepScope, validateCapabilityResult, verifyCapabilityTaskScope } from './bid-capability-registry.ts'
export { bidProjectInspectSchema, inspectBidProject } from './bid-project-inspect.ts'
export type { BidProjectInspectRequest, BidProjectInspectResult } from './bid-project-inspect.ts'
export {
  REVISION_QUEUE_PATH,
  REVISION_QUEUE_SCHEMA_VERSION,
  addRevisionIssue,
  commitRevisionQueueMutation,
  createRevisionIssueId,
  deleteRevisionIssue,
  emptyRevisionQueue,
  parseRevisionQueueArtifact,
  readRevisionQueue,
  revisionIssueSchema,
  revisionIssueStatusSchema,
  revisionQueueArtifactSchema,
  updateRevisionIssue,
  validateRevisionIssueReference,
  writeRevisionQueue,
} from './chapter-revision-queue.ts'
export type {
  AddRevisionIssueInput,
  DeleteRevisionIssueInput,
  RevisionIssue,
  RevisionIssueReference,
  RevisionIssueStatus,
  RevisionQueueArtifact,
  RevisionQueueWorkspace,
  UpdateRevisionIssueInput,
} from './chapter-revision-queue.ts'
export {
  DEFAULT_CHAPTER_FLOWCHART_VISUAL_REVIEW_ROUNDS,
  DEFAULT_CHAPTER_WRITING_COMPLETION_REPAIR_ROUNDS,
  DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
  buildChapterWorklist,
  executeChapterWriting,
  pickChapterContext,
  renderChapterExecutionPlanRepairTask,
  renderChapterExecutionPlanTask,
  renderGlobalComplianceReviewTask,
  renderChapterSubagentRepairTask,
  renderChapterSubagentTask,
  validateChapterCandidate,
} from './chapter-writing-executor.ts'
export type { ChapterWritingExecutionOptions, FlowchartVisualReviewPolicy } from './chapter-writing-executor.ts'
export { validateChapterWriting } from './chapter-writing-validator.ts'
export { TECHNICAL_DEVIATION_HEADERS, parseTechnicalDeviationTable, validateTechnicalDeviationTable } from './technical-deviation-table.ts'
export {
  assessDocxExportPageTarget,
  executeDocxExport,
  validateDocxExport,
} from './docx-export.ts'
export {
  createNativeVisioExport,
  detectFlowchartExportEnvironment,
  flowchartPlaceholder,
  type FlowchartExportEnvironment,
  type FlowchartExportMode,
  type NativeVisioExport,
  type VisioBackend,
  type VisioDiagramResult,
  type WordVisioEmbedder,
} from './native-visio.ts'
export { fillBidCover, type BidCoverData } from './docx-cover.ts'
export {
  createNativeWordFinalizer,
  DOCX_TOC_UPDATE_DEFERRED,
  WORD_FINALIZER_UNAVAILABLE,
  type WordDocumentFinalizer,
} from './native-word.ts'
export { registerBidDocxExportProjection, registerBidRuntimeProjection, registerBidWritingEntryProjection } from './projection.ts'
export * from './writing-entry-contract.ts'
export * from './writing-entry-state.ts'
export { bidProjectTaskState, readBidProjectState, writeBidProjectState, checkpointBidProjectState } from './project-state.ts'
export type { BidProjectState } from './project-state.ts'

/** Durable result of parsing one imported bid file. */
export type ParseStatus = 'pending' | 'success' | 'needs_ocr' | 'failed'

/** Current durable Bid workspace manifest version. */
export const BID_MANIFEST_VERSION = 4 as const

/** SHA-256-derived identifier for an imported bid file. */
export type BidFileId = string & { readonly __bidFileId: unique symbol }

/** Deployment-owned import limits. */
export interface BidConfig {
  allowedExtensions: readonly string[]
  maxFileBytes: number
  maxFiles: number
  maxTotalBytes: number
  docxTemplateMaxBytes: number
  projectDirectory: string
  outputDirectory: string
  enableDocxExport: boolean
  font: string
  bodySize: number
  headingSize: number
  /** 默认技术标封面的投标人名称；为空时不猜测。 */
  bidderName?: string
  documentChunk: DocumentChunkConfig
}

/** Conservative defaults matching the documented MVP limits. */
export const DEFAULT_BID_CONFIG: BidConfig = {
  allowedExtensions: ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md'],
  maxFileBytes: 200 * 1024 * 1024,
  maxFiles: 20,
  maxTotalBytes: 500 * 1024 * 1024,
  docxTemplateMaxBytes: DOCX_TEMPLATE_MAX_BYTES,
  projectDirectory: '.bid-harness',
  outputDirectory: 'output',
  enableDocxExport: true,
  font: 'Microsoft YaHei',
  bodySize: 22,
  headingSize: 32,
  bidderName: '',
  documentChunk: DEFAULT_DOCUMENT_CHUNK_CONFIG,
}

/** Validated file limits, model-stage recovery budget, and Subagent concurrency limits. */
export interface Config {
  /** File extensions accepted by the Bid upload Remote. */
  allowedExtensions: string[]
  /** Maximum files admitted in one upload batch. */
  maxFiles: number
  /** Maximum decoded bytes admitted for one uploaded file. */
  maxFileBytes: number
  /** Maximum decoded bytes admitted across one upload batch. */
  maxTotalBytes: number
  /** Maximum original bytes admitted for one DOCX format template. */
  docxTemplateMaxBytes: number
  /** Validator-guided repair turns available to each model-authored stage execution. */
  modelStageRepairAttempts: number
  /** Maximum Mapping Subagents running at the same time during S4. */
  evidenceMappingMaxConcurrency: number
  /** Maximum Chapter Subagents running at the same time during S5. */
  chapterWritingMaxConcurrency: number
  /** Maximum Main-Agent whole-document repair rounds after chapter review. */
  chapterWritingCompletionRepairRounds: number
  /** Non-loopback browser authorities admitted to the direct binary S1 endpoint. */
  trustedHosts: string[]
  /** Whether Bid stages may use the registered Web search and fetch tools. */
  webSearchEnabled: boolean
  /** Word 自然语言格式建议的输出 token 上限。 */
  wordFormatMaxTokens: number
  /** Word 格式建议超时毫秒数。 */
  wordFormatTimeoutMs: number
  /** 默认技术标封面的投标人名称。 */
  bidderName: string
}

const DEFAULT_HOST_RUNTIME_CONFIG: Config = {
  allowedExtensions: [...DEFAULT_BID_CONFIG.allowedExtensions],
  maxFiles: DEFAULT_BID_CONFIG.maxFiles,
  maxFileBytes: DEFAULT_BID_CONFIG.maxFileBytes,
  maxTotalBytes: DEFAULT_BID_CONFIG.maxTotalBytes,
  docxTemplateMaxBytes: DEFAULT_BID_CONFIG.docxTemplateMaxBytes,
  modelStageRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
  evidenceMappingMaxConcurrency: DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
  chapterWritingMaxConcurrency: DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
  chapterWritingCompletionRepairRounds: DEFAULT_CHAPTER_WRITING_COMPLETION_REPAIR_ROUNDS,
  trustedHosts: [],
  webSearchEnabled: true,
  wordFormatMaxTokens: 8192,
  wordFormatTimeoutMs: 120000,
  bidderName: '',
}

/** Validated Bid Host runtime configuration. */
export const Config: z<Config> = z.object({
  allowedExtensions: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.allowedExtensions),
  maxFiles: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFiles),
  maxFileBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFileBytes),
  maxTotalBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxTotalBytes),
  docxTemplateMaxBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.docxTemplateMaxBytes),
  modelStageRepairAttempts: z.natural().min(1).max(20).default(DEFAULT_HOST_RUNTIME_CONFIG.modelStageRepairAttempts),
  evidenceMappingMaxConcurrency: z.natural().min(1).max(8).default(DEFAULT_HOST_RUNTIME_CONFIG.evidenceMappingMaxConcurrency),
  chapterWritingMaxConcurrency: z.natural().min(1).max(8).default(DEFAULT_HOST_RUNTIME_CONFIG.chapterWritingMaxConcurrency),
  chapterWritingCompletionRepairRounds: z.natural().min(1).max(20)
    .default(DEFAULT_HOST_RUNTIME_CONFIG.chapterWritingCompletionRepairRounds),
  trustedHosts: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.trustedHosts),
  webSearchEnabled: z.boolean().default(DEFAULT_HOST_RUNTIME_CONFIG.webSearchEnabled),
  wordFormatMaxTokens: z.natural().min(256).max(32768).default(DEFAULT_HOST_RUNTIME_CONFIG.wordFormatMaxTokens),
  wordFormatTimeoutMs: z.natural().min(1000).max(600000).default(DEFAULT_HOST_RUNTIME_CONFIG.wordFormatTimeoutMs),
  bidderName: z.string().max(200).default(DEFAULT_HOST_RUNTIME_CONFIG.bidderName),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Dedicated Host actions and runtime admission for Bid Sessions. */
    bid: BidHostRuntime
  }
}

/** Build the workspace configuration governed by the Host file limits. */
function workspaceConfig(config: Config): BidConfig {
  return {
    ...DEFAULT_BID_CONFIG,
    allowedExtensions: [...config.allowedExtensions],
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    docxTemplateMaxBytes: config.docxTemplateMaxBytes,
    bidderName: config.bidderName,
  }
}

async function readTenderAnalysisConfirmationView(workspace: BidWorkspace): Promise<TenderAnalysisConfirmationView> {
  const paths = {
    project: within(workspace.projectRoot, 'analysis/project.json'),
    requirements: within(workspace.projectRoot, 'analysis/requirements.json'),
    scoring: within(workspace.projectRoot, 'analysis/scoring-origin.json'),
    selection: within(workspace.projectRoot, 'analysis/tender-analysis-selection.json'),
    compliance: within(workspace.projectRoot, 'analysis/compliance.json'),
  }
  await Promise.all(Object.values(paths).map(path => assertNoLinkedPath(workspace.root, path)))
  const [project, requirements, scoringRaw, selectionRaw, compliance] = await Promise.all([
    readFile(paths.project, 'utf8'),
    readFile(paths.requirements, 'utf8'),
    readFile(paths.scoring, 'utf8'),
    readFile(paths.selection, 'utf8'),
    readFile(paths.compliance, 'utf8'),
  ])
  const scoring = parseTenderScoringArtifact(JSON.parse(scoringRaw))
  return {
    project: parseTenderProjectArtifact(JSON.parse(project)),
    requirements: parseTenderRequirementsArtifact(JSON.parse(requirements)),
    scoring,
    selected_scoring_ids: parseTenderScoringSelection(JSON.parse(selectionRaw), scoring).selected_scoring_ids,
    compliance: parseTenderComplianceArtifact(JSON.parse(compliance)),
  }
}

/** Build one immutable success result. */
function intakeSuccess(value: BidTaskState, files?: readonly BidFileIntakeFileResult[]): BidFileIntakeResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({ ...value }),
    ...(files === undefined || files.length === 0 ? {} : { files: Object.freeze([...files]) }),
  })
}

/** Build one immutable, sanitized business rejection. */
function intakeRejected(code: BidFileIntakeErrorCode, message: string, files?: readonly BidFileIntakeFileResult[]): BidFileIntakeResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message,
      ...(files === undefined || files.length === 0 ? {} : { files: Object.freeze([...files]) }),
    }),
  })
}

/** Build one immutable on-demand DOCX export rejection. */
function docxExportRejected(
  code: BidDocxExportErrorCode,
  message: string,
  issues?: readonly StageValidationIssue[],
): BidDocxExportResult {
  return Object.freeze({ ok: false, error: Object.freeze({
    code,
    message,
    ...(issues === undefined ? {} : { issues: Object.freeze([...issues]) }),
  }) })
}

type RuntimeActionInput<Code extends string> = { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly code: Code; readonly message: string }
type RuntimeActionResult<Code extends string> = { readonly ok: true; readonly value: BidTaskState }
  | { readonly ok: false; readonly error: { readonly code: Code; readonly message: string } }

/** Build an immutable state-bearing Host action result. */
function runtimeActionResult<Code extends string>(result: RuntimeActionInput<Code>): RuntimeActionResult<Code> {
  return result.ok
    ? Object.freeze({ ok: true, value: Object.freeze({ ...result.value }) })
    : Object.freeze({ ok: false, error: Object.freeze({ code: result.code, message: result.message }) })
}

/** Result builders retain each public action's narrower rejection vocabulary. */
const chapterWritingGateResult: (
  result: RuntimeActionInput<BidChapterWritingGateErrorCode>,
) => BidChapterWritingGateResult = runtimeActionResult

/** Minimal webserver registration face used only when the web carrier is composed. */
interface BidBinaryUploadWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Validate an explicit non-loopback authority used by the binary S1 route. */
function assertBidUploadTrustedAuthority(authority: string): void {
  const parsed = new URL(`http://${authority}`)
  if (parsed.host !== authority.toLocaleLowerCase('en-US')) {
    throw new Error(`bid: trustedHosts entry ${JSON.stringify(authority)} is not a bare host[:port] authority`)
  }
}

/** Apply the existing API route's Host, Origin, and Fetch-Metadata checks to binary S1 traffic. */
function isTrustedBidUploadRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname.toLocaleLowerCase('en-US')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (!loopback && !trustedHosts.some((authority) => {
    try { return new URL(`http://${authority}`).host === hostUrl.host }
    catch { return false }
  })) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host }
  catch { return false }
}

interface DecodedUploadBatch {
  incoming: IncomingFile[]
  failures: BidFileIntakeFileResult[]
}

/** Convert one canonical browser base64 file into importer bytes after size admission. */
function decodeUploadFile(file: BidUploadFile): IncomingFile {
  if (!isBidDocumentRole(file.role)) throw new Error('bid-invalid-file-role')
  const expectedLength = Math.ceil(file.size / 3) * 4
  if (file.data.length !== expectedLength
    || file.data.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.data)) {
    throw new Error('bid-invalid-file-data')
  }
  const bytes = Buffer.from(file.data, 'base64')
  if (bytes.byteLength !== file.size || bytes.toString('base64') !== file.data) {
    throw new Error('bid-invalid-file-data')
  }
  return {
    name: file.name,
    role: file.role,
    ...(file.mediaType === undefined ? {} : { type: file.mediaType }),
    bytes,
  }
}

/** Convert a rejected internal admission error into a file-level diagnostic. */
function fileIntakeFailure(file: BidUploadFile, error: unknown): BidFileIntakeFileResult {
  const mapped = intakeFailure(error)
  return {
    name: file.name,
    role: file.role,
    status: 'failed',
    error: mapped,
  }
}

/** Map an internal admission or parser failure to the public business vocabulary. */
function intakeFailure(error: unknown): { code: BidFileIntakeErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  switch (message) {
    case 'bid-file-count-limit':
      return { code: 'BID_FILE_COUNT_LIMIT', message: 'The selected file count exceeds the Bid Host limit.' }
    case 'bid-file-size-limit':
    case 'bid-empty-file':
      return { code: 'BID_FILE_SIZE_LIMIT', message: 'A selected file is empty or exceeds the Bid Host size limit.' }
    case 'bid-total-size-limit':
      return { code: 'BID_TOTAL_SIZE_LIMIT', message: 'The selected files exceed the Bid Host total-size limit.' }
    case 'bid-unsupported-file-type':
      return { code: 'BID_FILE_TYPE_UNSUPPORTED', message: 'A selected file type is not accepted by the Bid Host.' }
    case 'bid-invalid-file-role':
      return { code: 'BID_FILE_ROLE_INVALID', message: 'A selected file has an unsupported Bid document role.' }
    case 'bid-invalid-file-name':
    case 'bid-reserved-file-name':
      return { code: 'BID_FILE_NAME_INVALID', message: 'A selected file name is not valid for the Bid workspace.' }
    default:
      return { code: 'BID_FILE_INTAKE_FAILED', message }
  }
}

/** Convert canonical browser base64 into importer bytes while retaining independent file failures. */
function decodeUploadFiles(files: readonly BidUploadFile[], config: Config): DecodedUploadBatch {
  if (files.length === 0 || files.length > config.maxFiles) throw new Error('bid-file-count-limit')
  const incoming: IncomingFile[] = []
  const failures: BidFileIntakeFileResult[] = []
  let declaredTotal = 0
  for (const file of files) {
    try {
      const extension = extname(safeFileName(file.name)).toLocaleLowerCase('en-US')
      if (!config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > config.maxFileBytes) {
        throw new Error('bid-file-size-limit')
      }
      if (!Number.isSafeInteger(declaredTotal + file.size) || declaredTotal + file.size > config.maxTotalBytes) {
        throw new Error('bid-total-size-limit')
      }
      declaredTotal += file.size
      incoming.push(decodeUploadFile(file))
    } catch (error) {
      failures.push(fileIntakeFailure(file, error))
    }
  }
  return { incoming, failures }
}

/** Parse the small JSON header that describes the ordered raw upload body. */
function parseBinaryUploadFiles(value: string): BidBinaryUploadFile[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('bid-file-count-limit')
  return parsed.map((file): BidBinaryUploadFile => {
    if (typeof file !== 'object' || file === null) throw new Error('bid-invalid-file-data')
    const record = file as Record<string, unknown>
    if (typeof record.name !== 'string' || !isBidDocumentRole(record.role)
      || typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size <= 0
      || (record.mediaType !== undefined && typeof record.mediaType !== 'string')) {
      throw new Error('bid-invalid-file-data')
    }
    return {
      name: record.name,
      role: record.role,
      ...(record.mediaType === undefined ? {} : { mediaType: record.mediaType }),
      size: record.size,
    }
  })
}

/** Read one bounded binary S1 request and restore the files in its declared order. */
async function readBinaryUpload(req: IncomingMessage, files: readonly BidBinaryUploadFile[], config: Config): Promise<IncomingFile[]> {
  if (files.length > config.maxFiles) throw new Error('bid-file-count-limit')
  const expected = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(expected) || expected > config.maxTotalBytes) throw new Error('bid-total-size-limit')
  for (const file of files) {
    if (file.size > config.maxFileBytes) throw new Error('bid-file-size-limit')
    const extension = extname(safeFileName(file.name)).toLocaleLowerCase('en-US')
    if (!config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
  }
  const body = await readExactRequestBody(req, expected, 'bid-invalid-file-data')
  let offset = 0
  return files.map((file): IncomingFile => {
    const bytes = body.subarray(offset, offset + file.size)
    offset += file.size
    return {
      name: file.name,
      role: file.role,
      ...(file.mediaType === undefined ? {} : { type: file.mediaType }),
      bytes,
    }
  })
}

/** Buffer one streamed request body only up to its admitted exact byte length. */
async function readExactRequestBody(req: IncomingMessage, expected: number, mismatchMessage: string): Promise<Buffer> {
  const body = Buffer.allocUnsafe(expected)
  let received = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array)
    if (received + bytes.byteLength > expected) throw new Error(mismatchMessage)
    bytes.copy(body, received)
    received += bytes.byteLength
  }
  if (received !== expected) throw new Error(mismatchMessage)
  return body
}

function docxTemplateUploadFailure(error: unknown): DocxTemplateUploadResult {
  return {
    ok: false,
    error: {
      code: 'BID_DOCX_TEMPLATE_UPLOAD_FAILED',
      message: error instanceof Error ? error.message : 'Word 模板上传失败，请重试。',
    },
  }
}

/** Translate an expected admission rejection into the public business vocabulary. */
function intakeError(error: unknown): BidFileIntakeResult {
  const failure = intakeFailure(error)
  return intakeRejected(
    failure.code,
    failure.code === 'BID_FILE_INTAKE_FAILED'
      ? 'The Bid Host could not import and validate the selected files.'
      : failure.message,
  )
}

/** Host service for Bid projection, prompt admission, and dedicated file intake. */
interface ActiveBidOperation {
  readonly key: BidProjectKey
  readonly session: Session
  readonly workspace: BidWorkspace
  ready: boolean
  controller: AbortController
  readonly done: Promise<void>
  readonly settle: () => void
  reservedForReset: boolean
  finishing?: Promise<void>
  retirement?: Promise<void>
  interaction?: boolean
  executionSessionId?: SessionId
  executionHandle?: AgentHandle
  executionStage?: BidStage
  lastAdmittedWorkId?: string
  readonly stageControl: HostStageSchedulerControl
  readonly writingControl: HostChapterWritingControl
  readonly runs: BidRunCoordinator
  readonly stopTrackingContinuableChildren: () => void
  projectRevision: number
  suspension?: Promise<unknown>
  recovery?: ModelStageExecutionOptions['recovery']
}

interface HostExecutionUpdate {
  readonly stage: BidStage
  readonly status: 'suspended' | 'completed' | 'failed' | 'waiting_user'
  readonly cause?: string | undefined
  readonly code?: string | undefined
  readonly message: string
  readonly issues?: readonly StageValidationIssue[] | undefined
}

/** Render the bounded terminal state that the Interaction Agent needs for its next reply. */
function renderHostExecutionUpdate(update: HostExecutionUpdate): string {
  return [
    'Host execution update:',
    `阶段：${update.stage}`,
    `状态：${update.status}`,
    ...(update.cause === undefined ? [] : [`原因：${sanitizeBidErrorText(update.cause)}`]),
    ...(update.code === undefined ? [] : [`错误：${sanitizeBidErrorText(update.code)}`]),
    `摘要：${sanitizeBidErrorText(update.message)}`,
    ...update.issues?.slice(0, 3).map(issue => `关键问题：${sanitizeBidErrorText(issue.code)}: ${sanitizeBidErrorText(issue.message)}`) ?? [],
  ].join('\n')
}

/** 一个在线原生问题；业务状态仍以持久化请求记录为准。 */
interface ActiveWritingQuestion {
  readonly key: BidProjectKey
  readonly requestId: string
  readonly attemptId: string
  readonly ownerSessionId: string
  readonly agent: Agent
  readonly controller: AbortController
  task: Promise<void>
}

/** 一个真实派发的计划处理消息/回合；不代表整个 request 永久运行。 */
interface ActiveWritingPlanProcessing {
  readonly key: BidProjectKey
  readonly requestId: string
  readonly attemptId: string
  readonly ownerSessionId: string
  readonly messageId: string
  readonly agent: Agent
  turn: number | null
}

/** 入口意图处理后的显式效果；在锁释放后执行。 */
type WritingEntryEffect =
  | { kind: 'none' }
  | { kind: 'ask'; request: WritingRequest }
  | { kind: 'process'; request: WritingRequest }
  | { kind: 'start_saved_plan' }
  | { kind: 'retry_answer'; requestId: string; attemptId: string }

/** In-memory pause gate owned by one active stage operation. */
class HostStageSchedulerControl implements StageSchedulerControl {
  private held = false
  private closed = false
  private gate = Promise.withResolvers<undefined>()

  constructor() { this.gate.resolve(undefined) }

  paused(): boolean { return this.held }

  close(): void {
    this.closed = true
    this.held = false
    this.gate.resolve(undefined)
  }

  pause(): boolean {
    if (this.held) return false
    this.held = true
    this.gate = Promise.withResolvers<undefined>()
    return true
  }

  resume(): boolean {
    if (!this.held) return false
    this.held = false
    this.gate.resolve(undefined)
    return true
  }

  async waitUntilRunnable(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.assertOpen()
    while (this.held) {
      const aborted = Promise.withResolvers<never>()
      const abort = (): void => { aborted.reject(signal.reason ?? new Error('Bid stage operation cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      try { await Promise.race([this.gate.promise, aborted.promise]) } finally {
        signal.removeEventListener('abort', abort)
      }
      signal.throwIfAborted()
      this.assertOpen()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('BID_RUN_SCHEDULER_CLOSED')
  }
}

/** In-memory wakeable command queue owned by one locked Bid operation. */
class HostChapterWritingControl implements ChapterWritingControl {
  private readonly commands: ChapterWritingCommand[] = []
  private readonly listeners = new Set<() => void>()
  private workspace: BidWorkspace | undefined
  private workId: string | undefined
  private commits: BidCommitScope | undefined
  private records: BidChapterCommandRecord[] = []
  private writes = Promise.resolve()

  async bind(workspace: BidWorkspace, workId: string, commits: BidCommitScope): Promise<void> {
    if (this.workspace === workspace && this.workId === workId) {
      this.commits = commits
      return
    }
    this.workspace = workspace
    this.workId = workId
    this.commits = commits
    this.records = await readBidChapterCommandJournal(workspace, workId)
    this.commands.splice(0, this.commands.length, ...this.records.flatMap((record) => {
      if (record.status !== 'pending' || typeof record.command !== 'object' || record.command === null
        || !('kind' in record.command)) return []
      const kind = record.command.kind
      return kind === 'writing_plan' || kind === 'revision' || kind === 'flowchart_visual_review_policy'
        ? [{ ...(record.command as ChapterWritingCommand), commandId: record.id }] : []
    }))
  }

  async enqueue(command: ChapterWritingCommand): Promise<void> {
    const workspace = this.workspace
    const workId = this.workId
    const commits = this.commits
    if (workspace === undefined || workId === undefined || commits === undefined) throw new Error('BID_CHAPTER_COMMAND_JOURNAL_UNBOUND')
    const record: BidChapterCommandRecord = { id: randomUUID(), status: 'pending', command }
    this.writes = this.writes.then(() => withBidCommandJournalLock(workspace, workId, async () => {
      const records = [...await readBidChapterCommandJournal(workspace, workId), record]
      await writeBidChapterCommandJournal(workspace, workId, records, commits)
      this.records = records
    }))
    await this.writes
    this.commands.push({ ...command, commandId: record.id })
    for (const listener of this.listeners) listener()
  }

  drain(): ChapterWritingCommand[] {
    return this.commands.splice(0)
  }

  flowchartVisualReviewPolicy(): FlowchartVisualReviewPolicy {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const command = this.records[index]?.command as ChapterWritingCommand | undefined
      if (command?.kind === 'flowchart_visual_review_policy'
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- 日志记录来自持久化文件。
        && (command.policy === 'required' || command.policy === 'skip')) return command.policy
    }
    return 'required'
  }

  pending(): boolean {
    return this.commands.length > 0
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async commit(
    commands: readonly ChapterWritingCommand[],
    write: (lease: import('./run-coordinator.ts').BidCommitLease) => Promise<void>,
  ): Promise<void> {
    const workspace = this.workspace
    const workId = this.workId
    const commits = this.commits
    if (workspace === undefined || workId === undefined || commits === undefined) throw new Error('BID_CHAPTER_COMMAND_JOURNAL_UNBOUND')
    const ids = new Set(commands.flatMap(command => command.commandId === undefined ? [] : [command.commandId]))
    this.writes = this.writes.then(async () => {
      let records: BidChapterCommandRecord[] = []
      await commits.publish(lease => withBidCommandJournalLock(workspace, workId, async () => {
        records = (await readBidChapterCommandJournal(workspace, workId))
          .map(record => ids.has(record.id) ? { ...record, status: 'applied' as const } : record)
        await write(lease)
        await writeBidChapterCommandJournal(workspace, workId, records, lease)
      }))
      this.records = records
    })
    await this.writes
  }
}

type BidProjectKey = string & { readonly __bidProjectKey: unique symbol }

type BidRunDecisionRequest = BidSessionEventMap['bid.run.decision.required']

const BID_STAGE_LABELS: Readonly<Record<BidStage, string>> = {
  file_intake: '资料上传',
  tender_analysis: '招标分析',
  outline_generation: '初步目录生成',
  evidence_mapping: '目录生成/资料映射',
  chapter_writing: '正文编写',
  docx_export: '导出标书',
}

function bidStageExecutionLabel(stage: BidStage): string {
  return ({
    file_intake: 'S1 · 文件接入与拆分',
    tender_analysis: 'S2 · 招标信息提取',
    outline_generation: 'S3 · 初步目录生成',
    evidence_mapping: 'S4 · 资料映射与目录深化',
    chapter_writing: 'S5 · 正文编写与审核',
    docx_export: 'S6 · DOCX 导出',
  } satisfies Record<BidStage, string>)[stage]
}

const RUN_DECISION_OPTIONS = {
  continue: '继续未完成任务（推荐）',
  restart: '重新执行当前阶段',
  stop: '停止任务',
} as const

function runDecisionKey(session: Session, stage: BidStage, runId: string, decisionType: BidRunDecisionType): string {
  return `${String(session.id)}:${stage}:${runId}:${decisionType}`
}

function selectedRunDecision(question: AskUserQuestionItem, answer: AskUserQuestionAnswer): BidRunDecision | undefined {
  const item = answer.answers.find(candidate => candidate.id === question.id)
  if (item === undefined || item.custom !== undefined || item.selected.length !== 1) return undefined
  switch (item.selected[0]) {
    case RUN_DECISION_OPTIONS.continue: return 'continue'
    case RUN_DECISION_OPTIONS.restart: return 'restart_stage'
    case RUN_DECISION_OPTIONS.stop: return 'stop'
    default: return undefined
  }
}

function bidSessionTaskState(session: Session): BidTaskState {
  return session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
}

/** 同一目录的符号链接及 Windows 大小写别名共用一把项目锁。 */
function projectKey(session: Pick<Session, 'header'>): BidProjectKey {
  if (session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
  const path = realpathSync(session.header.cwd)
  return (process.platform === 'win32' ? path.toLowerCase() : path) as BidProjectKey
}

const WRITING_REQUEST_PATH = 'chapters/writing-request.json'
const WRITING_PLAN_PATH = 'chapters/writing-plan.json'
const WRITING_PLAN_APPLIED_PATH = 'chapters/applied-writing-plan.json'

async function confirmedOutline(workspace: BidWorkspace): Promise<{ outline: OutlineArtifact; sha256: string }> {
  const path = within(workspace.projectRoot, 'outline/confirmed-outline.json')
  await assertNoLinkedPath(workspace.root, path)
  const outline = parseOutlineArtifact(JSON.parse(await readFile(path, 'utf8')))
  return { outline, sha256: outlineArtifactSha256(outline) }
}

async function hasCurrentWritingPlan(workspace: BidWorkspace): Promise<boolean> {
  const { sha256 } = await confirmedOutline(workspace)
  return (await readCurrentWritingPlan(workspace, sha256)) !== undefined
}

async function currentWritingPlan(workspace: BidWorkspace): Promise<ReturnType<typeof parseWritingPlan> | undefined> {
  const { sha256 } = await confirmedOutline(workspace)
  return readCurrentWritingPlan(workspace, sha256)
}

async function writeWritingRequest(
  workspace: BidWorkspace,
  request: WritingRequest,
  lease: BidPublicationLease,
): Promise<void> {
  const path = within(workspace.projectRoot, WRITING_REQUEST_PATH)
  await assertNoLinkedPath(workspace.root, path)
  await lease.writeJson(path, request)
}

function consumedWritingRequest(request: WritingRequest, planVersion: number): WritingRequest {
  return { ...request, state: 'consumed', applied_plan_version: planVersion, error: undefined, processing: undefined, processing_message_id: undefined }
}

async function readWritingRequest(workspace: BidWorkspace): Promise<WritingRequest | undefined> {
  const path = within(workspace.projectRoot, WRITING_REQUEST_PATH)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed !== null && typeof parsed === 'object' && 'prompt_event' in parsed) {
    return undefined
  }
  return writingRequestSchema.parse(parsed)
}


function resolveWritingRequirementMessages(
  session: Session,
  refs: readonly WritingRequirementMessageRef[],
): Array<{ ref: WritingRequirementMessageRef; text: string }> {
  return refs.map((ref) => {
    if (ref.session_id !== session.id) throw new Error(`用户消息引用不属于当前 Session：${ref.session_id}/${ref.seq}`)
    const event = session.events[ref.seq]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user'
      || String(event.data.id) !== ref.message_id) {
      throw new Error(`用户消息引用不存在或身份不匹配：${ref.session_id}/${ref.seq}/${ref.message_id}`)
    }
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text.length === 0) throw new Error(`用户消息引用没有可持久化的文本：${ref.session_id}/${ref.seq}`)
    return { ref, text }
  })
}

async function persistHostWork(
  workspace: BidWorkspace,
  kind: import('./control-plane-contract.ts').BidWorkKind,
  stage: BidStage,
  payload: unknown,
): Promise<import('./control-plane-contract.ts').BidWorkDescriptor> {
  const inputIdentity = await hostWorkInputIdentity(workspace, stage, payload)
  return persistBidWorkRequest(workspace, kind, stage, payload, inputIdentity)
}

async function hostWorkInputIdentity(
  workspace: BidWorkspace,
  stage: BidStage,
  payload: unknown,
): Promise<unknown> {
  const inputs = await Promise.all(getBidStagePolicy(stage).requiredInputs.map(async (path) => {
    const absolute = within(workspace.projectRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    try { return { path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') } } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, sha256: null }
      throw error
    }
  }))
  return { stage, inputs, payload }
}

async function readHostWork(
  workspace: BidWorkspace,
  descriptor: import('./control-plane-contract.ts').BidWorkDescriptor,
): Promise<unknown> {
  const payload = await readBidWorkRequest(workspace, descriptor)
  if (descriptor.kind === 'capability_task') return payload
  if (bidInputFingerprint(await hostWorkInputIdentity(workspace, descriptor.stage, payload))
    !== descriptor.inputFingerprint) throw new Error('BID_WORK_INPUT_FINGERPRINT_MISMATCH')
  return payload
}

async function prepareWorkingWorkspace(
  workspace: BidWorkspace,
  run: BidRunContext,
): Promise<{ readonly workspace: BidWorkspace; readonly run: BidRunContext }> {
  const paths = await prepareBidWorkingTree(workspace, run.work)
  const working = new BidWorkspace(workspace.root, {
    ...workspace.config,
    projectDirectory: relative(workspace.root, paths.projectRoot),
  })
  const samePath = process.platform === 'win32'
    ? working.projectRoot.toLocaleLowerCase('en-US') === paths.projectRoot.toLocaleLowerCase('en-US')
    : working.projectRoot === paths.projectRoot
  if (!samePath) throw new Error('BID_WORKING_TREE_CONFIG_MISMATCH')
  return {
    workspace: working,
    run: {
      ...run,
      commits: run.commits.forPublication({ workspaceRoot: working.root, projectRoot: working.projectRoot }),
    },
  }
}

type StageInteractionRequest = zod.infer<typeof stageInteractionSchema>
type CapabilitySupersede = NonNullable<Extract<StageInteractionRequest, { action: 'bid_run_task' }>['supersede']>
type OutlineLongInteraction = Extract<StageInteractionRequest, {
  readonly action: 'bid_outline_regenerate_scope' | 'bid_evidence_remap'
}>

const EVIDENCE_REMAP_PUBLICATION_PATHS = [
  'analysis/evidence-map.json',
  'analysis/evidence-map.candidate.json',
  'analysis/evidence-mapping-quality.candidate.json',
  'analysis/web-evidence-sources.json',
  'analysis/web-sources',
  'analysis/evidence-mapping-plan.json',
  'analysis/evidence-mapping-log.json',
  'analysis/evidence-mapping-checkpoint.json',
  'outline/refined-outline.candidate.json',
  'outline/draft.json',
] as const

const evidenceMappingTakeoverSchema = zod.object({
  stage: zod.literal('evidence_mapping'),
  kind: zod.literal('evidence_mapping_takeover'),
  source_work: bidWorkDescriptorSchema,
  task: bidCapabilityTaskSchema,
  authorization: zod.object({ session_id: zod.string().min(1), message_id: zod.string().min(1) }).strict(),
  failed_state: bidTaskStateSchema.refine(state => state.status === 'failed' && state.stage === 'evidence_mapping'),
  instruction: zod.string().trim().min(1),
}).strict()

/** 已接受的单步结构研究计划只开放原失败子树，完整阶段仍由标准 S4 执行器核验。 */
function evidenceMappingTakeoverInstruction(task: BidCapabilityTask, message: string): string {
  const step = task.steps[0]
  if (task.scope.kind !== 'project' || task.steps.length !== 1 || step?.scope.source !== 'task'
    || task.issue_ids !== undefined || !(step.call.capability === 'outline.refine'
      || step.call.capability === 'evidence.research' && step.call.input.mode === 'supplement'
        && step.call.input.allow_outline_refinement)) throw new Error('BID_S4_SUPERSEDE_SINGLE_STRUCTURE_PLAN_REQUIRED')
  const feedback = step.call.capability === 'outline.refine' ? step.call.input.feedback : step.call.input.reason
  return ['新的直接用户授权：' + message, '已接纳任务目标：' + task.goal,
    '已接纳结构研究步骤：' + feedback].join('\n')
}

async function prepareEvidenceMappingTakeover(
  canonical: BidWorkspace, previous: BidRunData, task: BidCapabilityTask,
  authorization: CapabilityTaskRequest['authorization'], failedState: BidTaskState, instruction: string,
): Promise<BidWorkDescriptor> {
  await readHostWork(canonical, previous.work)
  const existing = await readExistingBidWorkingTree(canonical, previous.work)
  const source = existing === null ? canonical : new BidWorkspace(canonical.root, {
    ...canonical.config, projectDirectory: relative(canonical.root, existing.projectRoot),
  })
  const [log, progress, candidate, project, requirements, scoring, compliance] = await Promise.all([
    readEvidenceMappingLog(source), readEvidenceMappingProgress(source),
    readStageJson(source, 'outline/refined-outline.candidate.json').then(parseOutlineArtifact),
    readStageJson(source, 'analysis/project.json').then(parseTenderProjectArtifact),
    readStageJson(source, 'analysis/requirements.json').then(parseTenderRequirementsArtifact),
    readStageJson(source, 'analysis/scoring.json').then(parseTenderScoringArtifact),
    readStageJson(source, 'analysis/compliance.json').then(parseTenderComplianceArtifact),
    readStageJson(source, 'analysis/evidence-mapping-checkpoint.json'),
    readStageJson(source, 'analysis/evidence-map.candidate.json').then(parseEvidenceMapArtifact),
  ])
  const blocking = log?.outline_reviews?.at(-1)?.blocking_issues ?? []
  if (progress === null || blocking.length === 0
    || blocking.some(issue => !candidate.sections.some(section => section.id === issue.section_id))) {
    throw new Error('BID_S4_SUPERSEDE_FAILED_CANDIDATE_REQUIRED')
  }
  await loadOutlineReviewSources(source, [...project.source_refs,
    ...requirements.requirements.flatMap(item => item.source_refs), ...scoring.scoring_items.flatMap(item => item.source_refs),
    ...compliance.compliance_items.flatMap(item => item.source_refs)])
  const original = existing ?? await prepareBidWorkingTree(canonical, previous.work)
  const work = await persistHostWork(canonical, 'stage_execution', 'evidence_mapping', evidenceMappingTakeoverSchema.parse({
    stage: 'evidence_mapping', kind: 'evidence_mapping_takeover', source_work: previous.work,
    task, authorization, failed_state: failedState, instruction,
  }))
  await prepareBidWorkingTree(canonical, work, { source: original })
  return work
}

async function executeEvidenceMappingTakeoverCandidate(
  agent: Agent, canonical: BidWorkspace, run: BidRunContext, config: Config,
  recovery: ModelStageExecutionOptions['recovery'],
): Promise<StageArtifact[]> {
  const candidate = await prepareWorkingWorkspace(canonical, run)
  const artifacts = await executeEvidenceMapping(agent, candidate.workspace, buildBidStageTask('evidence_mapping'), {
    run: candidate.run, maxRepairAttempts: config.modelStageRepairAttempts,
    maxConcurrency: config.evidenceMappingMaxConcurrency, webSearchEnabled: config.webSearchEnabled,
    resumeCandidate: true, preserveAcceptedCandidate: true, ...(recovery === undefined ? {} : { recovery }),
  })
  const validation = await validateEvidenceMapping(candidate.workspace, 'evidence_mapping', artifacts)
  if (!validation.ok) throw new BidStageExecutionError(validation.issues)
  await publishBidWorkingPaths(run, canonical, candidate.workspace, [
    ...EVIDENCE_REMAP_PUBLICATION_PATHS, 'outline/outline.json', 'outline/quality-report.json',
  ])
  return artifacts
}

async function executeOutlineInteractionCandidate(
  agent: Agent,
  canonical: BidWorkspace,
  request: OutlineLongInteraction,
  run: BidRunContext,
  config: Config,
  recovery?: ModelStageExecutionOptions['recovery'],
): Promise<OutlineDraftMutationResult> {
  const candidate = await prepareWorkingWorkspace(canonical, run)
  const base = await getOrCreateOutlineDraft(candidate.workspace)
  if (request.expected_revision !== base.revision
    || request.expected_draft_sha256 !== base.draft_outline_sha256) {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: base } }
  }
  const operations = request.action === 'bid_outline_regenerate_scope'
    ? await generateScopedOutlineOperations(
      agent,
      base,
      request.section_ids,
      request.feedback,
      candidate.run.signal,
      recovery,
    )
    : []
  candidate.run.signal.throwIfAborted()
  let mutation: OutlineDraftMutationResult | undefined
  await candidate.run.commits.publish(async (lease) => {
    mutation = await mutateOutlineDraft(candidate.workspace, { ...request, operations }, lease)
    if (!mutation.ok) throw Object.assign(new Error('BID_OUTLINE_MUTATION_REJECTED'), { mutation })
  }).catch((error: unknown) => {
    const rejected = (error as { mutation?: OutlineDraftMutationResult }).mutation
    if (rejected !== undefined) mutation = rejected
    else throw error
  })
  if (mutation === undefined) throw new Error('BID_OUTLINE_MUTATION_MISSING')
  if (!mutation.ok) return mutation
  if (request.action !== 'bid_evidence_remap') {
    await publishBidWorkingPaths(run, canonical, candidate.workspace, ['outline/draft.json'])
    return mutation
  }

  const previousOutline = parseOutlineArtifact(await readStageJson(candidate.workspace, 'outline/outline.json'))
  await candidate.run.commits.writeJson(
    within(candidate.workspace.projectRoot, 'outline/outline.json'),
    mutation.value.outline,
  )
  await executeEvidenceMapping(agent, candidate.workspace, buildBidStageTask('evidence_mapping'), {
    maxRepairAttempts: config.modelStageRepairAttempts,
    maxConcurrency: config.evidenceMappingMaxConcurrency,
    webSearchEnabled: config.webSearchEnabled,
    run: candidate.run,
    ...(recovery === undefined ? {} : { recovery }),
    remap: {
      section_ids: request.section_ids,
      mode: request.mode,
      previous_outline: previousOutline,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    },
  })
  candidate.run.signal.throwIfAborted()
  const checkedOutline = parseOutlineArtifact(await readStageJson(candidate.workspace, 'outline/outline.json'))
  const updated = {
    ...mutation.value,
    revision: Math.max(base.revision + 1, mutation.value.revision),
    outline: checkedOutline,
    draft_outline_sha256: outlineArtifactSha256(checkedOutline),
  }
  await candidate.run.commits.writeJson(within(candidate.workspace.projectRoot, 'outline/draft.json'), updated)
  await publishBidWorkingPaths(run, canonical, candidate.workspace, EVIDENCE_REMAP_PUBLICATION_PATHS)
  return { ok: true, value: updated }
}

const outlineRegenerationRequestSchema = zod.object({
  expected_revision: zod.number().int().positive(),
  expected_draft_sha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  feedback: zod.string().trim().min(1),
}).strict()
type OutlineRegenerationRequest = zod.infer<typeof outlineRegenerationRequestSchema>

async function executeOutlineRegenerationCandidate(
  agent: Agent,
  canonical: BidWorkspace,
  request: OutlineRegenerationRequest,
  run: BidRunContext,
  config: Config,
  recovery?: ModelStageExecutionOptions['recovery'],
): Promise<BidOutlineRegenerationResult> {
  const candidate = await prepareWorkingWorkspace(canonical, run)
  const draft = await getOrCreateOutlineDraft(candidate.workspace)
  await candidate.run.commits.writeJson(within(candidate.workspace.projectRoot, 'outline/draft.json'), draft)
  if (request.expected_revision !== draft.revision
    || request.expected_draft_sha256 !== draft.draft_outline_sha256) {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
  }
  const outlinePath = within(candidate.workspace.projectRoot, 'outline/outline.json')
  const qualityPath = within(candidate.workspace.projectRoot, 'outline/quality-report.json')
  const changeSetPath = within(candidate.workspace.projectRoot, 'outline/regeneration/change-set.json')
  let validationIssues: readonly StageValidationIssue[] = []
  try {
    const artifacts = await executeOutlineGeneration(
      agent,
      candidate.workspace,
      buildBidStageTask('outline_generation'),
      {
        maxRepairAttempts: config.modelStageRepairAttempts,
        run: candidate.run,
        ...(recovery === undefined ? {} : { recovery }),
        regeneration: {
          feedback: request.feedback,
          revision: draft.revision,
          draftSha256: draft.draft_outline_sha256,
        },
      },
    )
    const validation = await validateOutlineGeneration(candidate.workspace, 'outline_generation', artifacts)
    if (!validation.ok) {
      validationIssues = validation.issues
      throw new Error('candidate-validation')
    }
    const [candidateRaw, qualityRaw, changeSetRaw] = await Promise.all([
      readFile(outlinePath, 'utf8'),
      readFile(qualityPath, 'utf8'),
      readFile(changeSetPath, 'utf8'),
    ])
    const outline = parseOutlineArtifact(JSON.parse(candidateRaw))
    const changeSet = parseOutlineRegenerationChangeSet(JSON.parse(changeSetRaw))
    if (!regenerationChangeSetMatches(
      changeSet,
      draft.outline,
      outline,
      draft.revision,
      draft.draft_outline_sha256,
    )) throw new Error('change-set-mismatch')
    let replacement: OutlineDraftMutationResult | undefined
    await candidate.run.commits.publish(async (lease) => {
      await lease.writeText(within(candidate.workspace.projectRoot, 'outline/regeneration/candidate-outline.json'), candidateRaw)
      await lease.writeText(within(candidate.workspace.projectRoot, 'outline/regeneration/quality-report.json'), qualityRaw)
      await lease.writeText(changeSetPath, changeSetRaw)
      replacement = await replaceOutlineDraft(candidate.workspace, request, outline, lease)
      if (!replacement.ok) throw Object.assign(new Error('BID_OUTLINE_MUTATION_REJECTED'), { replacement })
    }).catch((error: unknown) => {
      const rejected = (error as { replacement?: OutlineDraftMutationResult }).replacement
      if (rejected !== undefined) replacement = rejected
      else throw error
    })
    if (replacement === undefined) throw new Error('BID_OUTLINE_MUTATION_MISSING')
    if (!replacement.ok) {
      return { ok: false, error: {
        ...replacement.error,
        code: replacement.error.code === 'BID_OUTLINE_DRAFT_CONFLICT'
          ? 'BID_OUTLINE_DRAFT_CONFLICT'
          : 'BID_REGENERATE_FAILED',
      } }
    }
    await publishBidWorkingPaths(run, canonical, candidate.workspace, [
      'outline/regeneration',
      'outline/draft.json',
    ])
    return { ok: true, value: { stage: run.work.stage, status: 'waiting_user', run: null } }
  } catch (error: unknown) {
    const originalCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    return { ok: false, error: {
      code: 'BID_REGENERATE_FAILED',
      message: error instanceof Error && error.message === 'change-set-mismatch'
        ? 'The regeneration change set does not match the candidate.'
        : `The regenerated outline candidate is invalid: ${error instanceof Error ? error.message : String(error)}`,
      issues: validationIssues.length > 0 ? validationIssues : error instanceof BidStageExecutionError ? error.issues
        : typeof originalCode === 'string' ? [{ code: originalCode, message: error instanceof Error ? error.message : String(error) }] : [],
      current: draft,
    } }
  }
}

const outlineConfirmationRequestSchema = zod.object({
  expected_revision: zod.number().int().positive(),
  expected_draft_sha256: zod.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

type OutlineConfirmationCandidateResult =
  | { readonly ok: true; readonly artifacts: StageArtifact[] }
  | { readonly ok: false; readonly issues: readonly StageValidationIssue[] }

async function executeOutlineConfirmationCandidate(
  agent: Agent,
  canonical: BidWorkspace,
  request: OutlineDraftIdentityRequest,
  run: BidRunContext,
  config: Config,
  recovery?: ModelStageExecutionOptions['recovery'],
): Promise<OutlineConfirmationCandidateResult> {
  const candidateWorkspace = await prepareWorkingWorkspace(canonical, run)
  const { workspace, run: workingRun } = candidateWorkspace
  const draft = await getOrCreateOutlineDraft(workspace)
  if (request.expected_revision !== draft.revision
    || request.expected_draft_sha256 !== draft.draft_outline_sha256) {
    return { ok: false, issues: [{
      code: 'BID_OUTLINE_DRAFT_CONFLICT',
      message: 'The outline draft changed before confirmation.',
      artifact: 'outline/draft.json',
    }] }
  }
  let outline = parseOutlineArtifact({ ...draft.outline, sections: ensureTechnicalDeviationSection(draft.outline.sections) })
  const sharedInputs = await Promise.all([
    'analysis/requirements.json',
    'analysis/scoring.json',
    'analysis/compliance.json',
    'analysis/scoring-response-points.json',
  ].map(async (path): Promise<unknown> => JSON.parse(
    await readFile(within(workspace.projectRoot, path), 'utf8'),
  ) as unknown))
  const prevalidation = validateOutlineDraftForConfirmation(
    outline,
    sharedInputs[0],
    sharedInputs[1],
    sharedInputs[2],
    sharedInputs[3],
  )
  if (!prevalidation.ok) return { ok: false, issues: prevalidation.issues }

  const confirmedRelative = run.work.stage === 'outline_generation'
    ? 'outline/initial-confirmed-outline.json'
    : 'outline/confirmed-outline.json'
  if (run.work.stage === 'evidence_mapping') {
    const researched = parseOutlineArtifact(await readStageJson(workspace, 'outline/outline.json'))
    const affected = changedWritableSectionIds(researched, outline)
    const summarySectionIds = outline.sections.filter(section => !section.writable
      && researched.sections.find(previous => previous.id === section.id)?.summary !== section.summary)
      .map(section => section.id)
    let evidence = parseEvidenceMapArtifact(await readStageJson(workspace, 'analysis/evidence-map.json'))
    if (affected.length > 0 || summarySectionIds.length > 0) {
      const checked = await executeEvidenceMappingFinalCheck(agent, workspace, outline, affected, {
        maxRepairAttempts: config.modelStageRepairAttempts,
        maxConcurrency: config.evidenceMappingMaxConcurrency,
        webSearchEnabled: config.webSearchEnabled,
        summarySectionIds,
        run: workingRun,
        ...(recovery === undefined ? {} : { recovery }),
      })
      outline = checked.outline
      evidence = checked.evidence
    }
    const reconciled = reconcileSectionEvidence(outline, evidence)
    await workingRun.commits.writeJson(within(workspace.projectRoot, 'analysis/evidence-map.json'), reconciled)
    await pruneWebEvidenceArtifacts(workspace, reconciled, workingRun.commits)
  }
  const qualityPath = within(workspace.projectRoot, 'outline/quality-report.json')
  const quality = JSON.parse(await readFile(qualityPath, 'utf8')) as Record<string, unknown>
  quality.reviewed_section_ids = outline.sections.map(section => section.id)
  await workingRun.commits.publish(async (lease) => {
    await lease.writeJson(within(workspace.projectRoot, 'outline/outline.json'), outline)
    await lease.writeJson(qualityPath, quality)
    await lease.writeJson(within(workspace.projectRoot, confirmedRelative), outline)
    if (run.work.stage === 'evidence_mapping') {
      await lease.writeJson(within(workspace.projectRoot, 'outline/confirmation.json'), parseOutlineConfirmationArtifact({
        schema_version: 2,
        scope: 'technical_bid',
        decision: 'confirmed',
        source_outline_sha256: draft.source_outline_sha256,
        confirmed_outline_sha256: outlineArtifactSha256(outline),
        confirmed_draft_revision: draft.revision,
        confirmed_draft_sha256: draft.draft_outline_sha256,
        authorization: { source: 'user_confirmation' },
      }))
    }
  })

  const artifacts: StageArtifact[] = run.work.stage === 'outline_generation' ? [
    { stage: 'outline_generation', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
    { stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' },
    { stage: 'outline_generation', type: 'outline_quality_report', path: 'outline/quality-report.json' },
  ] : [
    { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
    { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
    { stage: 'evidence_mapping', type: 'outline', path: 'outline/outline.json' },
    { stage: 'evidence_mapping', type: 'outline_quality_report', path: 'outline/quality-report.json' },
  ]
  const validation = run.work.stage === 'evidence_mapping'
    ? await validateEvidenceMapping(workspace, 'evidence_mapping', artifacts)
    : await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
  if (!validation.ok) return { ok: false, issues: validation.issues }
  await publishBidWorkingPaths(
    run,
    canonical,
    workspace,
    run.work.stage === 'outline_generation'
      ? ['outline/outline.json', 'outline/quality-report.json', confirmedRelative]
      : [
        'analysis/evidence-map.json',
        'analysis/web-evidence-sources.json',
        'analysis/web-sources',
        'outline/outline.json',
        'outline/quality-report.json',
        confirmedRelative,
        'outline/confirmation.json',
      ],
    ['outline/draft.json'],
  )
  return { ok: true, artifacts }
}

const fileIntakeWorkPayloadSchema = zod.object({
  files: zod.array(zod.object({
    name: zod.string().min(1),
    role: zod.enum(['tender', 'outline_framework', 'reference_bid', 'reference']).optional(),
    type: zod.string().optional(),
    bytes_ref: zod.string().min(1),
    size: zod.number().int().positive(),
    sha256: zod.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()),
}).strict()

async function persistFileIntakeWork(
  workspace: BidWorkspace,
  files: readonly IncomingFile[],
): Promise<import('./control-plane-contract.ts').BidWorkDescriptor> {
  const workId = randomUUID()
  const records = []
  for (const [index, file] of files.entries()) {
    const bytesRef = `requests/${workId}/files/${String(index + 1).padStart(4, '0')}`
    const path = within(workspace.projectRoot, bytesRef)
    await atomicBytes(workspace.root, path, file.bytes)
    records.push({
      name: file.name,
      ...(file.role === undefined ? {} : { role: file.role }),
      ...(file.type === undefined ? {} : { type: file.type }),
      bytes_ref: bytesRef,
      size: file.bytes.byteLength,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })
  }
  return persistBidWorkRequest(workspace, 'file_intake', 'file_intake', { files: records }, records, workId)
}

async function readFileIntakeWork(
  workspace: BidWorkspace,
  descriptor: import('./control-plane-contract.ts').BidWorkDescriptor,
): Promise<IncomingFile[]> {
  const payload = fileIntakeWorkPayloadSchema.parse(await readBidWorkRequest(workspace, descriptor))
  return Promise.all(payload.files.map(async (file) => {
    const path = within(workspace.projectRoot, file.bytes_ref)
    await assertNoLinkedPath(workspace.root, path)
    const bytes = await readFile(path)
    if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('BID_FILE_INTAKE_REQUEST_IDENTITY_MISMATCH')
    }
    return {
      name: file.name,
      ...(file.role === undefined ? {} : { role: file.role }),
      ...(file.type === undefined ? {} : { type: file.type }),
      bytes,
    }
  }))
}

/** Host-owned Bid RPC runtime that serializes stage mutations and publishes durable stage state. */
export class BidHostRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'sessions', 'subagents', 'userQuestions']
  static Config = Config

  private readonly config: Config
  private disposing = false
  private readonly inFlight = new Map<BidProjectKey, ActiveBidOperation>()
  private readonly docxInFlight = new Set<BidProjectKey>()
  private readonly docxExports = new Map<SessionId, Promise<BidDocxExportResult>>()
  private readonly pendingRunDecisions = new Map<string, Promise<void>>()
  private readonly pendingCapabilityInputs = new Map<string, Promise<void>>()
  private readonly pendingCapabilityInputControllers = new Map<string, AbortController>()
  private capabilityTaskDispatcher: CapabilityTaskDispatcher | undefined
  private readonly builtInCapabilityDispatcher: BidCapabilityDispatcher
  private readonly queuedDrains = new Set<BidProjectKey>()
  private readonly queuedDrainRequested = new Set<BidProjectKey>()
  private readonly pendingRunDecisionControllers = new Map<string, AbortController>()
  private readonly recoveryDriver: BidRecoveryDriver
  private readonly resultNotices = new WeakMap<Session, string>()
  private readonly recoveryAcceptances = new Map<string, Promise<{ accepted: true; run_id: string }>>()
  private readonly recoveryTasks = new Set<Promise<unknown>>()
  private readonly pendingWritingQuestions = new Map<BidProjectKey, ActiveWritingQuestion>()
  private readonly processingWritingPlans = new Map<BidProjectKey, ActiveWritingPlanProcessing>()
  private readonly writingEntryStops = new Map<BidProjectKey, {
    readonly token: object
    readonly done: Promise<void>
    state: 'pending' | 'failed'
    error?: Error
  }>()
  private readonly unsavedWritingAnswers = new Map<
    BidProjectKey,
    {
      readonly requestId: string
      readonly attemptId: string
      readonly ownerSessionId: string
      readonly answer: AskUserQuestionAnswer
      readonly error: Error
    }
  >()

  private isContextActive(): boolean {
    return !this.disposing && this.ctx.fiber.state === FiberState.ACTIVE
  }

  /**
   * 安装能力步骤执行器；后续能力适配器共用此单一 Run 入口。
   * @param dispatcher 负责授权文件、执行和业务校验的适配器。
   * @returns 仅移除当前注册实例的 disposer。
   */
  registerCapabilityTaskDispatcher(dispatcher: CapabilityTaskDispatcher): () => void {
    if (this.capabilityTaskDispatcher !== undefined) throw new Error('BID_CAPABILITY_DISPATCHER_ALREADY_REGISTERED')
    this.capabilityTaskDispatcher = dispatcher
    return () => {
      if (this.capabilityTaskDispatcher === dispatcher) this.capabilityTaskDispatcher = undefined
    }
  }

  /** Word 操作按项目互斥，可与任意会话的阶段执行并行；阶段重置期间拒绝写入。 */
  private async withDocxOperation<T>(session: Session, execute: (workspace: BidWorkspace) => Promise<T>): Promise<T> {
    assertBidMainSession(session)
    const key = projectKey(session)
    const active = this.inFlight.get(key)
    if (active?.reservedForReset) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目正在重置阶段，请稍后重试 Word 操作。')
    }
    if (this.docxInFlight.has(key)) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Word 操作正在执行。')
    }
    this.docxInFlight.add(key)
    try {
      return await execute(active?.workspace ?? new BidWorkspace(key, workspaceConfig(this.config)))
    } finally {
      this.docxInFlight.delete(key)
    }
  }

  /** Settle a persisted export whose execution handle disappeared with its Host. */
  private async reconcileDocxExport(session: Session): Promise<void> {
    const operation = session.events.reduce<DocxExportOperation | null>(reduceDocxExportOperation, null)
    if (operation?.status !== 'running' || this.docxExports.has(session.id)) return
    session.append('bid.docx_export.changed', { operation: {
      operationId: operation.operationId,
      templateId: operation.templateId,
      startedAt: operation.startedAt,
      updatedAt: Date.now(),
      status: 'failed',
      phase: operation.phase,
      message: 'Word 导出已中断',
      error: '宿主进程已重启，Word 导出未完成，请重试。',
    } })
    await this.ctx.sessions.flush(session)
  }

  private async syncEvidenceMappingProjection(
    session: Session,
    workspace: BidWorkspace,
    observed?: BidClientProjection,
  ): Promise<{ task: BidTaskState; observedMatches: boolean }> {
    const key = projectKey(session)
    let selected: { task: BidTaskState; revision: number } | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
      const active = this.inFlight.get(key)
      if (active !== undefined) {
        if (!active.ready) throw new Error('BID_PROGRESS_STATE_NOT_READY')
        selected = {
          task: bidSessionTaskState(active.session),
          revision: active.projectRevision,
        }
        break
      }

      const eventCount = session.events.length
      const saved = await readBidProjectState(workspace)
      if (this.inFlight.has(key) || session.events.length !== eventCount) continue

      const resumed = session.events.findLast(event => event.type === 'bid.project.resumed')
      const sessionRevision = resumed?.type === 'bid.project.resumed'
        ? resumed.data.revision
        : 0

      // Equal revisions keep live Session events that may follow the checkpoint.
      // Only a newer disk checkpoint replaces an already resumed Session.
      selected = saved !== undefined && (resumed === undefined || saved.revision > sessionRevision)
        ? {
          task: bidProjectTaskState(saved),
          revision: saved.revision,
        }
        : { task: bidSessionTaskState(session), revision: sessionRevision }
      break
    }

    if (selected === undefined) throw new Error('BID_PROGRESS_STATE_CHANGED')

    const { task, revision } = selected
    const current = getBidClientProjection(task)
    const observedMatches = observed === undefined || isDeepStrictEqual(observed.task, current.task)

    if (!isDeepStrictEqual(bidSessionTaskState(session), task) || !observedMatches) {
      session.append('bid.project.resumed', { state: task, revision })
      await this.ctx.sessions.flush(session)
    }

    return { task: current.task, observedMatches }
  }

  /** 在第一次异步操作前占用项目，直到落盘和所有执行器完成。 */
  private beginOperation(session: Session): ActiveBidOperation {
    assertBidMainSession(session)
    const key = projectKey(session)
    if (this.inFlight.has(key)) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Bid 操作正在执行。')
    }
    const settled = Promise.withResolvers<void>()
    const stageControl = new HostStageSchedulerControl()
    const controller = new AbortController()
    const workspace = new BidWorkspace(key, workspaceConfig(this.config))
    const continuableChildren = new Set<SessionId>()
    const stopTrackingContinuableChildren = this.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin === 'subagent'
        && agent.session.header.parentSession === holder.current?.executionSessionId) {
        continuableChildren.add(agent.id)
      }
    }, { global: true })
    const holder: { current?: ActiveBidOperation } = {}
    const runs = new BidRunCoordinator(
      session,
      stageControl,
      {
        drain: async () => {
          if (continuableChildren.size === 0) return
          const agent = holder.current?.executionHandle?.agent
          if (agent !== undefined) await this.ctx.subagents.drainContinuableChildren(agent, [...continuableChildren])
        },
      },
      () => holder.current?.projectRevision ?? 0,
      async () => {
        await this.checkpoint(operation)
        return operation.projectRevision
      },
      controller.signal,
      { workspaceRoot: workspace.root, projectRoot: workspace.projectRoot },
      () => holder.current?.executionSessionId,
      (run) => {
        const current = holder.current
        if (current === undefined) return
        try {
          this.recordRunAdmission(current, run)
        } catch {
          // Admission diagnostics must never turn a durably admitted Run into a failed Run.
          this.ctx.logger.warn('Bid Run admission diagnostics unavailable.')
        }
        current.lastAdmittedWorkId = run.work.workId
      },
      (notice, run) => {
        this.injectHostExecutionUpdate(session, {
          stage: run.work.stage,
          status: bidSessionTaskState(session).status === 'failed' ? 'failed' : 'suspended',
          cause: run.cause,
          code: run.error?.code,
          message: run.error?.message ?? notice.message,
          issues: run.error?.issues,
        })
      },
    )
    const operation: ActiveBidOperation = {
      key,
      session,
      workspace,
      ready: false,
      controller,
      done: settled.promise,
      settle: settled.resolve,
      reservedForReset: false,
      stageControl,
      writingControl: new HostChapterWritingControl(),
      stopTrackingContinuableChildren,
      projectRevision: 0,
      runs,
    }
    holder.current = operation
    this.inFlight.set(key, operation)
    return operation
  }

  /** 延迟创建 Host 持有的执行通道，不占用聊天 Agent。 */
  private async executionAgent(operation: ActiveBidOperation, stage: BidStage): Promise<Agent> {
    if (operation.executionHandle !== undefined) {
      this.setExecutionAgentStage(operation, operation.executionHandle.agent, stage)
      return operation.executionHandle.agent
    }
    const interaction = this.ctx.agents.get(operation.session.id)
    if (interaction === undefined) throw new Error('Bid interaction Session has no live Agent.')
    const presets = typeof (this.ctx as unknown as { get?: unknown }).get === 'function'
      ? this.ctx.get('agentPresets')
      : undefined
    const agentPreset = resolveSessionPreset(operation.session)
    if (presets !== undefined && agentPreset === undefined) throw new Error('Bid execution Session has no preset.')
    const executionSessionId = SessionId(randomUUID())
    const selectedRoute = interaction.session.requestHeader()?.config
    operation.executionSessionId = executionSessionId
    try {
      const handle = await this.ctx.agents.create({
        sessionId: executionSessionId,
        seed: seedDescriptorTurn(executionSessionId, undefined, snapshotSubagentDescriptor({
          mode: 'one-shot',
          provider: 'bid',
          label: bidStageExecutionLabel(stage),
        })),
        agentOptions: { ...interaction.options,
          ...selectedRoute?.provider === undefined ? {} : { provider: selectedRoute.provider },
          ...selectedRoute?.model === undefined ? {} : { model: selectedRoute.model } },
        meta: {
          cwd: operation.workspace.root,
          ...(agentPreset === undefined ? {} : {
            agentPreset,
          }),
          parentSession: operation.session.id,
          origin: 'subagent',
        },
        setup: async (agentCtx: Context) => {
          // Host 阶段指令可启动模型；Child 报告不能自行启动父会话回合。
          agentCtx.on('agent/pre-step', async ({ agent }, next) => {
            const decision = await next()
            if (decision.kind === 'reject' || agent.id !== executionSessionId) return decision
            const messages = decision.messages.filter(message =>
              message.source.kind !== 'subagent-report' && message.source.kind !== 'subagent-settled')
            if (messages.length === decision.messages.length) return decision
            return messages.length === 0 ? { kind: 'reject' as const } : { ...decision, messages }
          })
          if (presets !== undefined) {
            const joinedPreset = presets.composeFrom(agentCtx, interaction.ctx)
            if (joinedPreset === undefined) {
              if (agentPreset === undefined) throw new Error('Bid execution Session has no preset.')
              await presets.mount(agentCtx, agentPreset)
            }
          }
        },
      })
      operation.executionHandle = handle
      operation.executionStage = stage
      return handle.agent
    } catch (error) {
      delete operation.executionSessionId
      throw error
    }
  }

  private setExecutionAgentStage(operation: ActiveBidOperation, agent: Agent, stage: BidStage): void {
    if (operation.executionStage === stage) return
    agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'bid',
      label: bidStageExecutionLabel(stage),
    }))
    operation.executionStage = stage
  }

  /** Record the exact identities and model-visible tool surface granted at Run admission. */
  private recordRunAdmission(operation: ActiveBidOperation, run: BidRunContext): void {
    const execution = operation.executionHandle?.agent
    const tools = typeof (this.ctx as unknown as { get?: unknown }).get === 'function'
      ? this.ctx.get('tools')
      : undefined
    const toolNames = execution === undefined || tools === undefined ? [] : tools.schemas(execution).map(tool => tool.name)
    this.ctx.logger.info(`Bid Run admission ${JSON.stringify({
      conversationId: operation.session.id,
      sessionId: operation.session.id,
      conversationSessionId: operation.session.id,
      interactionSessionId: operation.session.id,
      interactionAgentId: this.ctx.agents.get(operation.session.id)?.id ?? operation.session.id,
      executionSessionId: execution?.session.id ?? operation.executionSessionId ?? null,
      executionAgentId: execution?.id ?? null,
      runId: run.runId,
      resumeOf: run.resumeOf ?? null,
      stage: run.work.stage,
      webSearchEnabled: this.config.webSearchEnabled,
      executionAgentToolNames: toolNames,
    })}`)
  }

  /** 先持久化稳定状态，再释放项目；并发调用共享同一个结算边界。 */
  private finishOperation(session: Session, operation: ActiveBidOperation, persist = true): Promise<void> {
    operation.finishing ??= this.finishOperationOnce(session, operation, persist)
    return operation.finishing
  }

  private async finishOperationOnce(_session: Session, operation: ActiveBidOperation, persist: boolean): Promise<void> {
    const key = operation.key
    try {
      if (operation.ready && persist) {
        if (operation.retirement !== undefined) {
          await operation.retirement
        } else {
          const current = operation.runs.current
          if (current !== undefined && this.inFlight.get(key) === operation) {
            const failure = safeRecoverableBidFailure(current.work, new Error('阶段执行已中断，已保存完成进度。'))
            operation.suspension ??= operation.runs.suspend(
              failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure,
            )
          }
          await operation.suspension
          if (operation.suspension === undefined && this.isContextActive()) await this.checkpoint(operation)
        }
      }
    } finally {
      try {
        operation.stopTrackingContinuableChildren()
        await operation.executionHandle?.dispose()
      } finally {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
        operation.settle()
        const settledTask = bidSessionTaskState(operation.session)
        if (this.isContextActive() && operation.lastAdmittedWorkId !== undefined
          && settledTask.status !== 'suspended' && settledTask.status !== 'failed') {
          const continuation = this.continueCapabilityExport(operation.session, operation.lastAdmittedWorkId)
            .then(completed => completed && this.isContextActive() ? this.drainPersistedCapabilityRequests(operation.session) : undefined)
          this.recoveryTasks.add(continuation)
          void continuation.catch((error: unknown) => {
            this.ctx.logger.warn(`Bid 排队能力任务调度失败：${sanitizeBidErrorText(
              error instanceof Error ? error.message : String(error),
            )}`)
          }).finally(() => { this.recoveryTasks.delete(continuation) })
        }
        const main = this.ctx.agents.get(operation.session.id)
        if (main?.session === operation.session) {
          this.steerMainAgentForFailure(main.session)
          this.steerMainAgentForResult(main.session)
        }
        const goalDriver = this.ctx.get('goalRoundDriver')
        if (goalDriver !== undefined) {
          for (const agent of this.ctx.agents.list()) {
            if (!isBidMainSession(agent.session)) continue
            let candidate: BidProjectKey
            try { candidate = projectKey(agent.session) } catch (error: unknown) {
              // 已删除或不可访问的其他工作区不阻止当前项目收尾。
              if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
              throw error
            }
            if (candidate === key) goalDriver.request(agent)
          }
        }
        if (main?.session === operation.session && settledTask.status === 'suspended'
          && settledTask.run.cause !== 'host_restart') {
          this.ensureRunDecision(main)
        }
      }
    }
  }

  /** 项目文件是操作授权依据，旧 Session 的投影在持锁后重新加载。 */
  private async prepareOperation(operation: ActiveBidOperation): Promise<BidTaskState> {
    const saved = await readBidProjectState(operation.workspace)
    let state = saved
    if (state === undefined) state = await checkpointBidProjectState(operation.workspace, BID_INITIAL_TASK_STATE)
    else if (state.status === 'running') {
      const unfinished = state.run
      const committed = unfinished.work.kind === 'capability_task'
        ? await this.readCommittedCapabilityTask(operation.workspace, unfinished.work) : null
      if (committed !== null) {
        state = await checkpointBidProjectState(operation.workspace, committed.return_state)
        if (!operation.session.events.some(event => event.type === 'bid.run.completed'
          && event.data.run.runId === unfinished.runId)) {
          operation.session.append('bid.run.completed', { run: { ...unfinished, updatedAt: Date.now() } })
        }
        const receipt = await readCapabilityPublicationReceipt(operation.workspace, unfinished.work.workId, unfinished.work.requestSha256)
        if (receipt !== null && receipt.goal_met !== false) this.appendCapabilityCompletionNotice(operation.session, unfinished, receipt)
        else operation.lastAdmittedWorkId = unfinished.work.workId
      } else {
        const interruptedState = suspendForHostRestart(state)
        if (interruptedState.status !== 'suspended') throw new Error('BID_HOST_RESTART_STATE_INVALID')
        const interrupted = interruptedState.run
        state = await checkpointBidProjectState(operation.workspace, interruptedState)
        const notice: BidRunNotice = {
          noticeId: `run:${interrupted.runId}:suspended`,
          supersedesTurn: null,
          runId: interrupted.runId,
          stage: state.stage,
          kind: 'interrupted',
          severity: 'error',
          message: '当前阶段已中断，已保存已完成进度。',
        }
        operation.session.append('bid.run.notice', notice)
        this.injectHostExecutionUpdate(operation.session, {
          stage: state.stage,
          status: 'suspended',
          cause: interrupted.cause,
          message: notice.message,
        })
      }
    }
    if (state.status === 'failed' && state.failure.code === 'BID_TASK_SCOPE_AUTHORIZATION_REQUIRED') {
      const failedRun = bidCapabilityTakeoverRun(operation.session, bidProjectTaskState(state))
      if (failedRun !== undefined && await isCapabilityAuthorizationRecheckFailure(
        operation.workspace, failedRun.work, operation.session)) {
        const error = safeRecoverableBidFailure(failedRun.work, Object.assign(
          new Error('同一不可变请求的授权已通过；模型重复授权结论冲突，继续原 Work 核验剩余成果。'),
          { code: 'BID_TASK_AUTHORIZATION_RECHECK_CONFLICT' }))
        state = await checkpointBidProjectState(operation.workspace, { stage: state.stage, status: 'failed',
          run: null, failure: error })
      }
    }
    const lastStarted = operation.session.events.findLast(event => event.type === 'bid.run.started')
    if (state.status !== 'running' && state.status !== 'suspended'
      && lastStarted?.type === 'bid.run.started' && lastStarted.data.run.work.kind === 'capability_task'
      && !operation.session.events.some(event => event.type === 'bid.run.notice'
        && event.data.kind === 'completed' && event.data.runId === lastStarted.data.run.runId)) {
      const request = await this.readCommittedCapabilityTask(operation.workspace, lastStarted.data.run.work)
      if (request !== null && isDeepStrictEqual(request.return_state, bidProjectTaskState(state))) {
        const receipt = await readCapabilityPublicationReceipt(operation.workspace, lastStarted.data.run.work.workId,
          lastStarted.data.run.work.requestSha256)
        if (receipt !== null && receipt.goal_met !== false) {
          this.appendCapabilityCompletionNotice(operation.session, lastStarted.data.run, receipt)
        }
        else operation.lastAdmittedWorkId = lastStarted.data.run.work.workId
      }
    }
    operation.projectRevision = state.revision
    operation.session.append('bid.project.resumed', { state: bidProjectTaskState(state), revision: state.revision })
    operation.ready = true
    await this.publishProjectState(operation, state)
    return bidProjectTaskState(state)
  }

  private async readCommittedCapabilityTask(
    workspace: BidWorkspace, work: BidWorkDescriptor,
  ): Promise<CapabilityTaskRequest | null> {
    await reconcileBidPublications(workspace.root, workspace.projectRoot)
    if (await hasPendingCapabilityCorrection(workspace, work)) return null
    const receipt = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
    return receipt === null ? null : capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
  }

  /** 只广播控制状态；每个 Session 保留独立的聊天、工具及模型上下文。 */
  private async publishProjectState(operation: ActiveBidOperation, state: BidProjectState): Promise<void> {
    if (!this.isContextActive()) return
    const key = operation.key
    const sessionsService = this.ctx.get('sessions')
    if (sessionsService === undefined) return
    const sessions = [operation.session, ...sessionsService.list().filter((session) => {
      if (session === operation.session) return false
      if (!isBidMainSession(session)) return false
      try { return projectKey(session) === key } catch (error) {
        // 已删除或不可访问的其他工作区不参与当前项目的实时投影。
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
      }
    })]
    const task = bidProjectTaskState(state)
    for (const session of sessions) {
      const last = session.events.at(-1)
      if (last?.type !== 'bid.project.resumed' || last.data.revision !== state.revision) {
        session.append('bid.project.resumed', { state: task, revision: state.revision })
      }
    }
    await this.broadcastWritingEntryView(operation.workspace, task, state.revision, sessions)
    await Promise.all(sessions.map(session => this.ctx.sessions.flush(session)))
  }

  /** 广播统一快照的 S5 入口摘要到主会话。 */
  private async broadcastWritingEntryView(
    workspace: BidWorkspace,
    task: BidTaskState,
    revision: number,
    sessions: readonly Session[],
  ): Promise<void> {
    if (sessions.length === 0) return
    const primary = sessions[0]
    if (primary === undefined) return
    let view: WritingEntryView
    try {
      view = await this.readWritingEntryView(primary, workspace, task, revision)
    } catch (error) {
      view = this.failedEntryView(revision, error)
    }
    for (const session of sessions) {
      const last = session.events.findLast(event => event.type === 'bid.writing_entry.changed')
      if (last === undefined || !this.isSameWritingEntryView(last.data.view, view)) {
        session.append('bid.writing_entry.changed', { view })
      }
    }
  }

  private isSameWritingEntryView(a: WritingEntryView | undefined, b: WritingEntryView): boolean {
    if (a === undefined) return false
    return JSON.stringify(a) === JSON.stringify(b)
  }

  private failedEntryView(revision: number, error: unknown): WritingEntryView {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'BID_WRITING_ENTRY_READ_FAILED'
    return {
      expected: {
        project_revision: revision,
        request_id: null,
        attempt_id: null,
        stop_id: null,
        plan_version: null,
      },
      phase: 'failed',
      owner_session_id: null,
      request_state: null,
      continuation: null,
      processing_state: null,
      has_answer: false,
      has_plan: false,
      answer_save_status: 'none',
      can_retry_answer: false,
      error: { code, message },
      durability: 'memory_only',
    }
  }

  /** 从持久化控制状态构造一个恢复边界；同一 Run 只会生成一个问题。 */
  private currentRunDecision(session: Session): BidRunDecisionRequest | undefined {
    const task = bidSessionTaskState(session)
    if (task.status !== 'suspended') return undefined
    const { run } = task
    if (run.cause !== 'user_stop') return undefined
    const decisionKey = runDecisionKey(session, task.stage, run.runId, 'run_recovery')
    const options = task.stage === 'file_intake'
      ? [{ label: RUN_DECISION_OPTIONS.continue }, { label: RUN_DECISION_OPTIONS.stop }]
      : [{ label: RUN_DECISION_OPTIONS.continue }, { label: RUN_DECISION_OPTIONS.restart }, { label: RUN_DECISION_OPTIONS.stop }]
    return {
      decisionKey,
      stage: task.stage,
      runId: run.runId,
      decisionType: 'run_recovery',
      question: {
        id: decisionKey,
        header: BID_STAGE_LABELS[task.stage],
        question: `上次「${BID_STAGE_LABELS[task.stage]}」任务因 ${run.cause} 中断，接下来如何处理？`,
        options,
      },
    }
  }

  /** 在共享原生提问空间中挂起恢复决策，不使用普通聊天消息或阶段卡按钮。 */
  private ensureRunDecision(agent: Agent): void {
    const { session } = agent
    if (!isBidMainSession(session)) return
    const current = this.currentRunDecision(session)
    if (current === undefined) {
      const task = bidSessionTaskState(session)
      if (task.status === 'suspended' && task.run.cause === 'awaiting_input'
        && task.run.work.kind === 'capability_task') this.ensureCapabilityInput(agent)
      return
    }
    const received = session.events.findLast(event => event.type === 'bid.run.decision.received'
      && event.data.decisionKey === current.decisionKey)
    if (received?.type === 'bid.run.decision.received' && received.data.decision === 'stop'
      || this.pendingRunDecisions.has(current.decisionKey)) return
    const persisted = session.events.findLast(event => event.type === 'bid.run.decision.required'
      && event.data.decisionKey === current.decisionKey)
    const request = persisted?.type === 'bid.run.decision.required' ? persisted.data : current
    const controller = new AbortController()
    this.pendingRunDecisionControllers.set(request.decisionKey, controller)
    const task = this.askRunDecision(agent, request, controller)
    this.pendingRunDecisions.set(request.decisionKey, task)
    void task
  }

  /** 同一悬挂 Run 仅开放一个持久化问题；答案保存后续行原 Work。 */
  private ensureCapabilityInput(agent: Agent): void {
    if (!this.isContextActive()) return
    const task = bidSessionTaskState(agent.session)
    if (task.status !== 'suspended' || task.run.cause !== 'awaiting_input'
      || task.run.work.kind !== 'capability_task') return
    const key = task.run.runId
    if (this.pendingCapabilityInputs.has(key)) return
    const controller = new AbortController()
    this.pendingCapabilityInputControllers.set(key, controller)
    const pending = this.askAndResumeCapabilityInput(agent, task.run, controller).finally(() => {
      this.pendingCapabilityInputs.delete(key)
      this.pendingCapabilityInputControllers.delete(key)
    })
    this.pendingCapabilityInputs.set(key, pending)
    void pending
  }

  private async askAndResumeCapabilityInput(
    agent: Agent, suspended: Extract<BidTaskState, { status: 'suspended' }>['run'], controller: AbortController,
  ): Promise<void> {
    const workspace = new BidWorkspace(projectKey(agent.session), workspaceConfig(this.config))
    const binding = bindBidInputRecovery(String(agent.session.id), suspended, 'capability', suspended.runId)
    await this.driveInputRecovery(agent, workspace, binding, controller, async (record, execute) => {
      record.phase = 'reading_checkpoint'
      await writeBidInputRecovery(workspace, record)
      if (this.inputControllerStopped(controller)) return false
      const outcome = await readCapabilityAwaitingInput(workspace, suspended.work.workId, suspended.work.requestSha256)
      if (this.inputControllerStopped(controller)) return false
      if (outcome === null) throw Object.assign(new Error('原 Work 缺少待回答步骤。'), { code: 'BID_CAPABILITY_AWAITING_STEP_MISSING' })
      if (record.answer !== undefined) {
        if (record.answer.id !== outcome.questionId) throw Object.assign(new Error('保存的答案与当前待答问题不一致。'),
          { code: 'BID_INPUT_IDENTITY_MISMATCH' })
        if (!agent.session.events.some(event => event.type === 'bid.capability.input.received'
          && event.data.workId === suspended.work.workId && event.data.questionId === outcome.questionId)) {
          agent.session.append('bid.capability.input.received', { workId: suspended.work.workId,
            stepId: outcome.stepId, questionId: outcome.questionId, answer: { id: record.answer.id,
              selected: record.answer.selected, ...(record.answer.custom === undefined ? {} : { custom: record.answer.custom }) } })
        }
      }
      const answered = await askCapabilityTaskInput(agent.session, suspended.work.workId, outcome,
        async (question) => {
          record.phase = 'asking'
          await writeBidInputRecovery(workspace, record)
          if (this.inputControllerStopped(controller)) throw controller.signal.reason ?? new Error('BID_HOST_DISPOSED')
          const reply = await this.ctx.userQuestions.ask({ agent, questions: [question], signal: controller.signal })
          const item = reply.answers.find(answer => answer.id === question.id)
          if (item === undefined) throw Object.assign(new Error('原生问题未返回对应答案。'), { code: 'BID_CAPABILITY_INPUT_ANSWER_MISSING' })
          if (item.custom?.trim()) {
            record.answer = { id: item.id, selected: item.selected, custom: item.custom.trim() }
            record.phase = 'answered'
            await writeBidInputRecovery(workspace, record)
            if (this.inputControllerStopped(controller)) throw controller.signal.reason ?? new Error('BID_HOST_DISPOSED')
          }
          return item
        }, async () => { await this.ctx.sessions.flush(agent.session) })
      if (!answered || controller.signal.aborted || !this.isContextActive()) return false
      await this.ctx.sessions.flush(agent.session)
      const saved = await readBidProjectState(workspace)
      if (saved?.status !== 'suspended' || saved.run.runId !== suspended.runId
        || saved.run.cause !== 'awaiting_input' || saved.run.work.requestSha256 !== suspended.work.requestSha256) {
        throw Object.assign(new Error('原 Run 或问题检查点已变化。'), { code: 'BID_INPUT_IDENTITY_MISMATCH' })
      }
      return execute(async () => { await this.resumeCurrentRun(agent.session, suspended.runId, saved.revision) })
    })
  }

  /** 准备输入不占执行次数；调用动作前保存应用身份，已接纳原 Run 只补结算。 */
  private async driveInputRecovery(agent: Agent, workspace: BidWorkspace, binding: BidInputBinding,
    controller: AbortController,
    prepare: (record: BidInputRecovery, execute: (action: () => Promise<void>) => Promise<boolean>) => Promise<boolean>): Promise<void> {
    let record: BidInputRecovery | undefined
    let unsavedAnswer: Pick<BidInputRecovery, 'answer' | 'decision'> = {}
    for (let localAttempt = 0; localAttempt < this.config.modelStageRepairAttempts
      && this.isContextActive() && !controller.signal.aborted; localAttempt++) {
      const execution = { started: false }
      try {
        record = await readBidInputRecovery(workspace, binding, this.config.modelStageRepairAttempts)
        if (this.inputControllerStopped(controller)) return
        if (record.phase === 'applied') return
        const admitted = await this.inputRunAdmitted(agent.session, workspace, binding)
        if (this.inputControllerStopped(controller)) return
        if (admitted !== undefined || record.phase === 'accepted') {
          await this.confirmAdmittedInput(workspace, record, admitted)
          return
        }
        if (record.phase === 'blocked') {
          await this.settleInputFailure(agent.session, binding, record.error?.code ?? 'BID_INPUT_RETRY_EXHAUSTED',
            record.error?.message ?? '原生输入应用已耗尽持久尝试预算。')
          return
        }
        Object.assign(record, unsavedAnswer)
        const currentRecord = record
        const execute = async (action: () => Promise<void>): Promise<boolean> => {
          if (this.inputControllerStopped(controller)) return false
          if (currentRecord.attempts >= currentRecord.budget) throw Object.assign(
            new Error('原生输入应用已耗尽持久尝试预算。'), { code: 'BID_INPUT_RETRY_EXHAUSTED' })
          const previousApplication = currentRecord.application
          const previousPhase = currentRecord.phase
          currentRecord.attempts++
          currentRecord.application = { id: createHash('sha256').update(JSON.stringify([
            binding, currentRecord.attempts])).digest('hex'), attempt: currentRecord.attempts }
          currentRecord.phase = 'applying'
          let reservationError: unknown
          try { await writeBidInputRecovery(workspace, currentRecord) } catch (error: unknown) { reservationError = error }
          if (reservationError !== undefined || this.inputControllerStopped(controller)) {
            currentRecord.attempts--
            currentRecord.phase = previousPhase
            if (previousApplication === undefined) delete currentRecord.application
            else currentRecord.application = previousApplication
            await writeBidInputRecovery(workspace, currentRecord)
            if (reservationError !== undefined) throw reservationError instanceof Error ? reservationError
              : new Error('原生输入应用预占保存失败。', { cause: reservationError })
            return false
          }
          // 写盘等待期间取消只撤回未开始的预占；调用之后的取消保留执行事实。
          execution.started = true
          await action()
          return true
        }
        if (!await prepare(currentRecord, execute)) return
        if (this.inputControllerStopped(controller)) return
        const accepted = await this.inputRunAdmitted(agent.session, workspace, binding)
        await this.confirmAdmittedInput(workspace, record, accepted)
        return
      } catch (error: unknown) {
        if (this.inputControllerStopped(controller)) return
        let admitted: BidRunData | undefined
        try { admitted = await this.inputRunAdmitted(agent.session, workspace, binding) } catch (proofError: unknown) {
          error = proofError
        }
        if (this.inputControllerStopped(controller)) return
        if (record !== undefined && admitted !== undefined) {
          let confirmed = true
          try { await this.confirmAdmittedInput(workspace, record, admitted) } catch (confirmationError: unknown) {
            confirmed = false
            error = confirmationError
          }
          if (confirmed) return
        }
        if (record !== undefined && !execution.started) record.preparation_failures++
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'BID_INPUT_BRIDGE_FAILED'
        const message = sanitizeBidErrorText(error instanceof Error ? error.message : String(error))
        const failures = (execution.started ? record?.attempts : record?.preparation_failures) ?? localAttempt + 1
        const retry = retryableBidInputFailure(error) && failures
          < (record?.budget ?? this.config.modelStageRepairAttempts) && localAttempt + 1 < this.config.modelStageRepairAttempts
        if (record !== undefined) {
          unsavedAnswer = { ...(record.answer === undefined ? {} : { answer: record.answer }),
            ...(record.decision === undefined ? {} : { decision: record.decision }) }
          record.error = { code, message, phase: record.phase }
          record.phase = retry ? 'failed' : 'blocked'
          try { await writeBidInputRecovery(workspace, record) } catch (saveError: unknown) {
            this.ctx.logger.warn(`Bid 输入恢复状态保存失败：${sanitizeBidErrorText(String(saveError))}`)
          }
        }
        if (!retry) {
          await this.settleInputFailure(agent.session, binding, code, message)
          return
        }
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, Math.min(2000, 20 * 2 ** localAttempt))
          controller.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }

  private async confirmAdmittedInput(workspace: BidWorkspace, record: BidInputRecovery, admitted?: BidRunData): Promise<void> {
    delete record.error
    if (admitted !== undefined && record.application !== undefined) {
      record.application.accepted_run = { run_id: admitted.runId, epoch: admitted.epoch }
      record.phase = 'accepted'
      await writeBidInputRecovery(workspace, record)
    }
    record.phase = 'applied'
    await writeBidInputRecovery(workspace, record)
  }

  private async inputRunAdmitted(session: Session, workspace: BidWorkspace, binding: BidInputBinding): Promise<BidRunData | undefined> {
    const started = session.events.findLast(event => event.type === 'bid.run.started'
      && event.data.run.resumeOf?.runId === binding.run_id && event.data.run.work.workId === binding.work_id
      && event.data.run.work.requestSha256 === binding.request_sha256)
    if (started?.type === 'bid.run.started' && !session.events.some(event => event.type === 'bid.run.start_failed'
      && event.data.runId === started.data.run.runId && event.data.epoch === started.data.run.epoch)) return started.data.run
    const saved = await readBidProjectState(workspace)
    return saved?.run?.resumeOf?.runId === binding.run_id && saved.run.work.workId === binding.work_id
      && saved.run.work.requestSha256 === binding.request_sha256 ? saved.run : undefined
  }

  /** 项目已经推进时，原问题仍可按持久接纳事件补结算，无需重新开放或执行。 */
  private async reconcileAdmittedInputs(session: Session, workspace: BidWorkspace): Promise<void> {
    for (const event of session.events) {
      if (event.type !== 'bid.run.started' || event.data.run.resumeOf === undefined) continue
      const accepted = event.data.run
      const original = { ...accepted, runId: event.data.run.resumeOf.runId }
      const question = session.events.find(item => item.type === 'bid.run.decision.required'
        && item.data.runId === original.runId)
      const binding = question?.type === 'bid.run.decision.required'
        ? bindBidInputRecovery(String(session.id), original, 'decision', question.data.decisionKey)
        : accepted.work.kind === 'capability_task'
          ? bindBidInputRecovery(String(session.id), original, 'capability', original.runId) : undefined
      if (binding === undefined) continue
      const record = await readBidInputRecovery(workspace, binding, this.config.modelStageRepairAttempts)
      if (record.application === undefined || record.phase === 'applied') continue
      const admitted = await this.inputRunAdmitted(session, workspace, binding)
      if (admitted === undefined) continue
      await this.confirmAdmittedInput(workspace, record, admitted)
    }
  }

  private inputControllerStopped(controller: AbortController): boolean {
    return controller.signal.aborted || !this.isContextActive()
  }

  /** 无有效待答问题时把桥接故障结算为阻断，保留原 Run、检查点和已保存答案。 */
  private async settleInputFailure(session: Session, binding: BidInputBinding, code: string, message: string): Promise<void> {
    let settlementError: unknown
    for (let attempt = 0; attempt < this.config.modelStageRepairAttempts && this.isContextActive(); attempt++) {
      try {
        while (true) {
          const active = this.inFlight.get(projectKey(session))
          if (active === undefined) break
          await active.done
        }
        if (!this.isContextActive()) return
        const operation = this.beginOperation(session)
        try {
          const current = await this.prepareOperation(operation)
          if (current.status !== 'suspended' || current.run.runId !== binding.run_id
            || current.run.work.workId !== binding.work_id || current.run.work.requestSha256 !== binding.request_sha256
            || current.run.cause === 'user_stop' && binding.kind === 'capability') return
          if (current.run.cause === 'user_stop') {
            const noticeId = `input:${binding.run_id}:blocked`
            if (!session.events.some(event => event.type === 'bid.run.notice' && event.data.noticeId === noticeId)) {
              session.append('bid.run.notice', { noticeId, supersedesTurn: null, runId: binding.run_id,
                stage: current.stage, kind: 'interrupted', severity: 'error', message: `${code}: ${message}` })
              this.injectHostExecutionUpdate(session, { stage: current.stage, status: 'suspended', cause: 'user_stop', code, message })
            }
            await this.ctx.sessions.flush(session)
            return
          }
          session.append('bid.task.changed', { state: { ...current, run: { ...current.run, cause: 'executor_error', updatedAt: Date.now(),
            error: { code, message, recovery: { kind: 'blocked', unit: 'native_input', reason: message } } } } })
          await this.ctx.sessions.flush(session)
        } finally { await this.finishOperation(session, operation) }
        return
      } catch (error: unknown) {
        settlementError = error
        if (!retryableBidInputFailure(error)) break
      }
    }
    const current = bidSessionTaskState(session)
    if (current.status !== 'suspended' || current.run.runId !== binding.run_id
      || current.run.cause === 'user_stop' && binding.kind === 'capability') return
    session.append('bid.task.changed', { state: { ...current, run: { ...current.run,
      cause: current.run.cause === 'user_stop' ? 'user_stop' : 'executor_error', updatedAt: Date.now(),
      error: { code, message: `${message}；阻断状态尚未可靠落盘：${sanitizeBidErrorText(String(settlementError))}`,
        recovery: { kind: 'blocked', unit: 'native_input', reason: '输入故障结算落盘失败，需修复持久化后核验原 Run。' } } } } })
    session.append('bid.run.notice', { noticeId: `input:${binding.run_id}:blocked`, supersedesTurn: null,
      runId: binding.run_id, stage: current.stage, kind: 'interrupted', severity: 'error', message })
    this.steerMainAgentForFailure(session)
  }

  private cancelRunDecisions(session: Session): void {
    for (const [key, controller] of this.pendingRunDecisionControllers) {
      if (key.startsWith(`${String(session.id)}:`)) controller.abort(new Error('BID_RUN_DECISION_STALE'))
    }
  }

  private async askRunDecision(agent: Agent, request: BidRunDecisionRequest, controller: AbortController): Promise<void> {
    try {
      const current = bidSessionTaskState(agent.session)
      if (current.status !== 'suspended' || current.run.runId !== request.runId) return
      const workspace = new BidWorkspace(projectKey(agent.session), workspaceConfig(this.config))
      const binding = bindBidInputRecovery(String(agent.session.id), current.run, 'decision', request.decisionKey)
      await this.driveInputRecovery(agent, workspace, binding, controller, async (record, execute) => {
        const requested = agent.session.events.findLast(event => event.type === 'bid.run.decision.required'
        && event.data.decisionKey === request.decisionKey)
        if (requested === undefined) {
          agent.session.append('bid.run.decision.required', request)
          await this.ctx.sessions.flush(agent.session)
        }
        const received = agent.session.events.findLast(event => event.type === 'bid.run.decision.received'
        && event.data.decisionKey === request.decisionKey)
        if (record.decision === undefined && received === undefined) {
          record.phase = 'asking'
          await writeBidInputRecovery(workspace, record)
        }
        const decision = record.decision ?? (received?.type === 'bid.run.decision.received' ? received.data.decision
          : selectedRunDecision(request.question,
            await this.ctx.userQuestions.ask({ agent, questions: [request.question], signal: controller.signal })))
        if (controller.signal.aborted || !this.isContextActive()) return false
        if (decision === undefined) throw new Error('BID_RUN_DECISION_INVALID')
        record.decision = decision
        record.phase = 'answered'
        await writeBidInputRecovery(workspace, record)
        if (this.inputControllerStopped(controller)) return false
        if (received === undefined) agent.session.append('bid.run.decision.received', {
          decisionKey: request.decisionKey,
          stage: request.stage,
          runId: request.runId,
          decisionType: request.decisionType,
          decision,
        })
        await this.ctx.sessions.flush(agent.session)
        if (this.inputControllerStopped(controller)) return false
        return execute(async () => { await this.applyRunDecision(agent, request, decision) })
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Bid 原生用户提问未完成：${String(error)}`)
    } finally {
      this.pendingRunDecisions.delete(request.decisionKey)
      this.pendingRunDecisionControllers.delete(request.decisionKey)
    }
  }

  private async applyRunDecision(agent: Agent, request: BidRunDecisionRequest, decision: BidRunDecision): Promise<void> {
    if (decision === 'stop') {
      agent.cancel({ kind: 'user' })
      return
    }
    if (decision === 'continue') {
      const current = bidSessionTaskState(agent.session)
      const saved = await readBidProjectState(new BidWorkspace(projectKey(agent.session), workspaceConfig(this.config)))
      if (current.status !== 'suspended' || current.run.runId !== request.runId
        || saved?.status !== 'suspended' || saved.run.runId !== request.runId
        || saved.run.work.requestSha256 !== current.run.work.requestSha256) {
        throw Object.assign(new Error('原 Run 或项目状态已改变，不能应用保存的继续答案。'), { code: 'BID_INPUT_IDENTITY_MISMATCH' })
      }
      await this.resumeCurrentRun(agent.session, request.runId, saved.revision)
      return
    }
    await this.resetStage(agent, request.stage)
  }

  /** Start one Host-owned native S5 question after the project operation is free. */
  private startWritingQuestion(agent: Agent, request: WritingRequest): void {
    if (!this.isContextActive() || request.owner_session_id !== String(agent.session.id)) return
    const key = projectKey(agent.session)
    const existing = this.pendingWritingQuestions.get(key)
    if (existing !== undefined) {
      if (existing.requestId === request.request_id && existing.attemptId === request.attempt_id) return
      existing.controller.abort(new Error('BID_WRITING_QUESTION_REPLACED'))
    }
    const controller = new AbortController()
    const pending: ActiveWritingQuestion = {
      key,
      requestId: request.request_id,
      attemptId: request.attempt_id,
      ownerSessionId: request.owner_session_id,
      agent,
      controller,
      task: Promise.resolve(),
    }
    this.pendingWritingQuestions.set(key, pending)
    pending.task = this.ctx.userQuestions.ask({
      agent,
      questions: [{
        id: request.request_id,
        header: '整体写作要求',
        question: '开始正文编写前，是否还有其他整体写作要求？',
        detail: '可以直接开始，也可以输入补充要求；提交后将据此制定写作计划并开始编写。',
        options: [{ label: WRITING_REQUIREMENT_NONE_OPTION }],
        multiSelect: false,
      }],
      signal: controller.signal,
    }).then(answer => this.acceptWritingQuestionAnswer(pending, answer), (error: unknown) => {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      if (code === 'ASK_ABORTED' || code === 'ASK_CANCELLED' || controller.signal.aborted) {
        return this.dismissWritingQuestion(pending)
      }
      return this.recordWritingQuestionError(pending, error)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`Bid S5 原生提问处理未完成：${String(error)}`)
    }).finally(() => {
      if (this.pendingWritingQuestions.get(key) === pending) this.pendingWritingQuestions.delete(key)
    })
    void pending.task
  }

  /** Persist an answer only after rechecking the current project and question attempt. */
  private async acceptWritingQuestionAnswer(
    pending: ActiveWritingQuestion,
    answer: AskUserQuestionAnswer,
  ): Promise<void> {
    if (!this.isContextActive()) return
    const active = this.inFlight.get(pending.key)
    if (active !== undefined) {
      await active.done
      if (!this.isContextActive()) return
      return this.acceptWritingQuestionAnswer(pending, answer)
    }
    const operation = this.beginOperation(pending.agent.session)
    let accepted = false
    let request: WritingRequest | undefined
    let saveFailure: { error: unknown } | undefined
    try {
      const task = await this.prepareOperation(operation)
      request = await readWritingRequest(operation.workspace)
      let current: { outline: OutlineArtifact; sha256: string } | undefined
      try {
        current = await confirmedOutline(operation.workspace)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (request?.request_id !== pending.requestId || request.attempt_id !== pending.attemptId
        || request.owner_session_id !== pending.ownerSessionId
        || request.confirmed_outline_sha256 !== current.sha256
        || task.stage !== 'chapter_writing' || task.status !== 'waiting_user'
        || request.state !== 'awaiting_answer') return
      const classified = classifyWritingRequirementAnswer(request.request_id, answer)
      const next: WritingRequest = classified.kind === 'dismissed'
        ? { ...request, state: 'dismissed', continuation: 'allowed', error: undefined }
        : {
          ...request,
          state: 'answered',
          continuation: 'allowed',
          error: undefined,
          answer: {
            question_id: request.request_id,
            kind: classified.kind,
            selected: [...classified.selected],
            ...(classified.kind === 'custom' ? { custom: classified.custom } : {}),
          },
        }
      try {
        await this.mutateProject(operation, lease => writeWritingRequest(operation.workspace, next, lease))
        const cached = this.unsavedWritingAnswers.get(pending.key)
        if (cached?.requestId === pending.requestId && cached.attemptId === pending.attemptId) {
          this.unsavedWritingAnswers.delete(pending.key)
        }
        accepted = classified.kind !== 'dismissed'
        request = next
      } catch (saveError: unknown) {
        saveFailure = { error: saveError }
      }
    } finally {
      await this.finishOperation(pending.agent.session, operation)
    }
    if (saveFailure !== undefined) {
      await this.recordWritingAnswerSaveFailure(pending, answer, saveFailure.error)
      return
    }
    try {
      if (accepted) await this.scheduleWritingPlanProcessing(pending.agent, request)
    } catch (error: unknown) {
      this.ctx.logger.warn(`Bid S5 计划处理启动失败：${String(error)}`)
    }
  }

  /** 答案保存失败时记录错误并保留内存中的未保存答案，供用户重试。 */
  private async recordWritingAnswerSaveFailure(
    pending: ActiveWritingQuestion,
    answer: AskUserQuestionAnswer,
    error: unknown,
  ): Promise<void> {
    const err = error instanceof Error ? error : new Error(String(error))
    this.unsavedWritingAnswers.set(pending.key, {
      requestId: pending.requestId,
      attemptId: pending.attemptId,
      ownerSessionId: pending.ownerSessionId,
      answer,
      error: err,
    })
    const active = this.inFlight.get(pending.key)
    if (active !== undefined) {
      await active.done
      if (!this.isContextActive()) return
    }
    const operation = this.beginOperation(pending.agent.session)
    try {
      await this.prepareOperation(operation)
      const request = await readWritingRequest(operation.workspace)
      if (request?.request_id !== pending.requestId
        || request.attempt_id !== pending.attemptId
        || request.owner_session_id !== pending.ownerSessionId) {
        return
      }
      const failed = {
        ...request,
        error: { code: 'BID_WRITING_ANSWER_SAVE_FAILED', message: `答案保存失败：${err.message}` },
      }
      try {
        await this.mutateProject(operation, lease => writeWritingRequest(operation.workspace, failed, lease))
      } catch (mutateError: unknown) {
        this.ctx.logger.warn(`Bid 答案保存失败记录无法落盘：${String(mutateError)}`)
        const memoryOnlyView: WritingEntryView = {
          expected: {
            project_revision: operation.projectRevision,
            request_id: request.request_id,
            attempt_id: request.attempt_id,
            stop_id: null,
            plan_version: null,
          },
          phase: 'failed',
          owner_session_id: request.owner_session_id,
          request_state: request.state,
          continuation: request.continuation,
          processing_state: request.processing?.state ?? null,
          has_answer: false,
          has_plan: false,
          answer_save_status: 'unconfirmed',
          can_retry_answer: true,
          error: { code: 'BID_WRITING_ANSWER_SAVE_FAILED', message: `答案保存失败：${err.message}` },
          durability: 'memory_only',
        }
        pending.agent.session.append('bid.writing_entry.changed', { view: memoryOnlyView })
        await this.ctx.sessions.flush(pending.agent.session)
      }
    } finally {
      await this.finishOperation(pending.agent.session, operation)
    }
  }

  /** Keep provider failures recoverable without claiming that the question was answered. */
  private async recordWritingQuestionError(pending: ActiveWritingQuestion, error: unknown): Promise<void> {
    if (!this.isContextActive()) return
    const active = this.inFlight.get(pending.key)
    if (active !== undefined) {
      await active.done
      if (!this.isContextActive()) return
      return this.recordWritingQuestionError(pending, error)
    }
    const operation = this.beginOperation(pending.agent.session)
    try {
      await this.prepareOperation(operation)
      const request = await readWritingRequest(operation.workspace)
      if (request?.request_id !== pending.requestId || request.attempt_id !== pending.attemptId) return
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'BID_WRITING_QUESTION_FAILED'
      const failed = { ...request, error: { code, message: error instanceof Error ? error.message : String(error) } }
      await this.mutateProject(operation, lease => writeWritingRequest(operation.workspace, failed, lease))
    } finally {
      await this.finishOperation(pending.agent.session, operation)
    }
  }

  /** A closed question is a dismissed business state, not an authorization to start. */
  private async dismissWritingQuestion(pending: ActiveWritingQuestion): Promise<void> {
    if (!this.isContextActive()) return
    const active = this.inFlight.get(pending.key)
    if (active !== undefined) {
      await active.done
      if (!this.isContextActive()) return
      return this.dismissWritingQuestion(pending)
    }
    const operation = this.beginOperation(pending.agent.session)
    try {
      await this.prepareOperation(operation)
      const request = await readWritingRequest(operation.workspace)
      if (request?.request_id !== pending.requestId || request.attempt_id !== pending.attemptId
        || request.state !== 'awaiting_answer') return
      const dismissed = { ...request, state: 'dismissed' as const, error: undefined }
      await this.mutateProject(operation, lease => writeWritingRequest(operation.workspace, dismissed, lease))
    } finally {
      await this.finishOperation(pending.agent.session, operation)
    }
  }

  /** Queue the model continuation only after a real native answer is durable. */
  private async scheduleWritingPlanProcessing(
    agent: Agent,
    request: WritingRequest,
    recovery?: { instruction: string },
  ): Promise<boolean> {
    if (!this.isContextActive()) return false
    const expectedRecovery = recovery === undefined ? undefined
      : bidWritingPlanRecoveryEligibility(agent.session, this.config.modelStageRepairAttempts)
    const key = projectKey(agent.session)
    const dispatch = await this.withWritingEntryOperation(agent.session, async (operation, workspace) => {
      const current = await readWritingRequest(workspace)
      if (current === undefined) return null
      if (current.request_id !== request.request_id
        || current.attempt_id !== request.attempt_id
        || current.owner_session_id !== request.owner_session_id
        || current.owner_session_id !== String(agent.session.id)) return null
      if (current.state !== 'answered' || current.continuation !== 'allowed') return null
      if (this.writingEntryStops.has(key)) return null
      const stop = await readWritingEntryStop(workspace)
      if (stop !== undefined) return null
      const { sha256 } = await confirmedOutline(workspace)
      const plan = await readCurrentWritingPlan(workspace, sha256)
      if (plan !== undefined) return null
      const existing = this.processingWritingPlans.get(key)
      if (existing !== undefined && existing.requestId === current.request_id && existing.attemptId === current.attempt_id) {
        const queued = [...existing.agent.inbox.nextTurn, ...existing.agent.inbox.nextStep]
          .find(msg => String(msg.id) === existing.messageId)
        if (queued !== undefined) return null
        if (existing.turn !== null) {
          const turnEnded = existing.agent.session.events.some(
            e => e.type === 'turn/end' && e.data.turn === existing.turn,
          )
          if (!turnEnded) return null
        }
        this.processingWritingPlans.delete(key)
        const failed: WritingRequest = {
          ...current,
          processing: { message_id: existing.messageId, state: 'failed', turn: existing.turn },
          error: { code: 'BID_WRITING_PLAN_NOT_COMMITTED', message: '写作要求已保存，但本轮未成功提交写作计划。主 Agent 将读取诊断并处理。' },
          processing_message_id: undefined,
        }
        await this.mutateProject(operation, lease => writeWritingRequest(workspace, failed, lease))
        return null
      }
      if (recovery !== undefined) {
        const eligibility = bidWritingPlanRecoveryEligibility(agent.session, this.config.modelStageRepairAttempts)
        if (!eligibility.eligible || eligibility.fingerprint === undefined
          || eligibility.fingerprint !== expectedRecovery?.fingerprint
          || current.confirmed_outline_sha256 !== sha256
          || eligibility.target?.requestId !== current.request_id || eligibility.target.attemptId !== current.attempt_id
          || current.processing?.state !== 'failed'
          || !isBidWritingPlanRecoverableFailure(current.error)) {
          throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', 'S5 已保存答案不满足当前自动恢复条件。')
        }
        if (bidRecoveryInstructionRepeated(agent.session, eligibility.target, eligibility.fingerprint, recovery.instruction)) {
          throw new BidOrchestratorError('BID_RECOVERY_DUPLICATE_INSTRUCTION', '同一问题不能重复提交相同修复指令。')
        }
        agent.session.append('bid.recovery.requested', {
          ownerSessionId: String(agent.session.id),
          target: { kind: 'writing_plan', requestId: current.request_id, attemptId: current.attempt_id },
          unit: 'writing_plan',
          instruction: recovery.instruction,
          progressFingerprint: eligibility.fingerprint,
        })
        await this.ctx.sessions.flush(agent.session)
      }
      const stagePrompt = renderStageInteractionPrompt('chapter_writing')
      const message = createUserMessage({
        content: [
          { type: 'text', text: stagePrompt },
          { type: 'text', text: 'Host 已保存 S5 初始原生问答。请读取 bid_stage_inspect(view=task_contract_context) 中的真实回答，结合对象位置制定首次 Writing Plan；请求身份由程序绑定，不要再次询问这个初始问题。' },
          ...(recovery === undefined ? [] : [{ type: 'text' as const, text: `Host 已接受针对写作计划失败的改进要求：${sanitizeBidErrorText(recovery.instruction, 4000)}。继续使用同一已保存答案和原提交工具，不再提问。` }]),
        ],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      })
      const entry: ActiveWritingPlanProcessing = {
        key,
        requestId: current.request_id,
        attemptId: current.attempt_id,
        ownerSessionId: current.owner_session_id,
        messageId: String(message.id),
        agent,
        turn: null,
      }
      const updated: WritingRequest = {
        ...current,
        processing: { message_id: String(message.id), state: 'queued', turn: null },
        error: undefined,
        processing_message_id: undefined,
      }
      await this.mutateProject(operation, lease => writeWritingRequest(workspace, updated, lease))
      this.processingWritingPlans.set(key, entry)
      return message
    })
    if (dispatch === null) return false
    if (!this.isContextActive()) return false
    if (this.writingEntryStops.has(key)) return false
    const entry = this.processingWritingPlans.get(key)
    if (entry === undefined || entry.messageId !== String(dispatch.id)) return false
    try {
      agent.followup(dispatch)
    } catch (error: unknown) {
      if (this.processingWritingPlans.get(key) === entry) {
        this.processingWritingPlans.delete(key)
      }
      try {
        await this.withWritingEntryOperation(agent.session, async (operation, workspace) => {
          const current = await readWritingRequest(workspace)
          if (current?.request_id !== request.request_id || current.attempt_id !== request.attempt_id) return
          const failed: WritingRequest = {
            ...current,
            processing: { message_id: String(dispatch.id), state: 'failed', turn: null },
            error: { code: 'BID_WRITING_PLAN_DISPATCH_FAILED', message: `写作计划通知派发失败：${error instanceof Error ? error.message : String(error)}` },
          }
          await this.mutateProject(operation, lease => writeWritingRequest(workspace, failed, lease))
        })
      } catch (innerError: unknown) {
        this.ctx.logger.warn(`Bid 写入计划失败状态写入失败：${String(innerError)}`)
      }
      this.ctx.logger.warn(`Bid 写入计划引导消息派发失败：${String(error)}`)
      return false
    }
    void this.publishWritingEntryView(agent.session).catch((error: unknown) => {
      this.ctx.logger.warn(`Bid S5 入口摘要发布失败：${String(error)}`)
    })
    return true
  }

  /** Re-drive an answered request after Host restart without reopening the question. */
  private async resumeWritingPlanProcessing(agent: Agent, workspace: BidWorkspace): Promise<void> {
    if (!this.isContextActive()) return
    const key = projectKey(agent.session)
    const request = await readWritingRequest(workspace)
    if (request === undefined) return
    if (request.owner_session_id !== String(agent.session.id)) return
    if (request.continuation === 'paused') return
    if (this.writingEntryStops.has(key)) return
    const stop = await readWritingEntryStop(workspace)
    if (stop !== undefined) return
    const { sha256 } = await confirmedOutline(workspace)
    const plan = await readCurrentWritingPlan(workspace, sha256)
    if (plan !== undefined) return
    if (request.state === 'dismissed' || request.state === 'consumed' || request.state !== 'answered') return
    if (request.processing === undefined) {
      await this.scheduleWritingPlanProcessing(agent, request)
      return
    }
    const processing = request.processing
    if (processing.state === 'failed') return
    const existing = this.processingWritingPlans.get(key)
    if (processing.state === 'queued') {
      if (existing !== undefined && existing.messageId === processing.message_id) {
        const queued = [...existing.agent.inbox.nextTurn, ...existing.agent.inbox.nextStep]
          .find(msg => String(msg.id) === existing.messageId)
        if (queued !== undefined) return
        if (existing.turn !== null) {
          const turnEnded = existing.agent.session.events.some(
            e => e.type === 'turn/end' && e.data.turn === existing.turn,
          )
          if (!turnEnded) return
        }
      }
      const turnEnded = processing.turn !== null && agent.session.events.some(
        e => e.type === 'turn/end' && e.data.turn === processing.turn,
      )
      if (turnEnded) {
        await this.withWritingEntryOperation(agent.session, async (operation, ws) => {
          const current = await readWritingRequest(ws)
          if (current?.request_id !== request.request_id || current.attempt_id !== request.attempt_id) return
          const failed: WritingRequest = {
            ...current,
            processing: { ...processing, state: 'failed' },
            error: { code: 'BID_WRITING_PLAN_NOT_COMMITTED', message: '写作要求已保存，但本轮未成功提交写作计划。主 Agent 将读取诊断并处理。' },
          }
          await this.mutateProject(operation, lease => writeWritingRequest(ws, failed, lease))
        })
        return
      }
      const newRequest = await this.withWritingEntryOperation(agent.session, async (operation, ws) => {
        const current = await readWritingRequest(ws)
        if (current?.request_id !== request.request_id || current.attempt_id !== request.attempt_id) return null
        const nextAttempt = randomUUID()
        const updated: WritingRequest = {
          ...current,
          attempt_id: nextAttempt,
          processing: undefined,
          error: undefined,
          processing_message_id: undefined,
        }
        await this.mutateProject(operation, lease => writeWritingRequest(ws, updated, lease))
        return updated
      })
      if (newRequest !== null) await this.scheduleWritingPlanProcessing(agent, newRequest)
      return
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- 恢复时从磁盘读取处理状态。
    if (processing.state === 'running') {
      if (existing !== undefined && existing.messageId === processing.message_id && existing.turn !== null) {
        const turnEnded = existing.agent.session.events.some(
          e => e.type === 'turn/end' && e.data.turn === existing.turn,
        )
        if (!turnEnded) return
      }
      await this.withWritingEntryOperation(agent.session, async (operation, ws) => {
        const current = await readWritingRequest(ws)
        if (current?.request_id !== request.request_id || current.attempt_id !== request.attempt_id) return
        const failed: WritingRequest = {
          ...current,
          processing: { ...processing, state: 'failed' },
          error: { code: 'BID_WRITING_PLAN_NOT_COMMITTED', message: '写作要求已保存，但本轮未成功提交写作计划。主 Agent 将读取诊断并处理。' },
        }
        await this.mutateProject(operation, lease => writeWritingRequest(ws, failed, lease))
      })
    }
  }

  /** Remove a plugin-owned plan-processing message from the agent inbox. */
  private discardWritingPlanMessage(entry: ActiveWritingPlanProcessing): void {
    const queued = [...entry.agent.inbox.nextTurn, ...entry.agent.inbox.nextStep]
      .find(message => String(message.id) === entry.messageId)
    if (queued !== undefined) entry.agent.inbox.remove(queued.id)
  }

  /** Settle one plan-processing turn after the owning agent turn ended. */
  private async finishWritingPlanTurn(entry: ActiveWritingPlanProcessing, reason: {
    kind: string
    error?: { code?: string; message: string }
  }): Promise<void> {
    if (!this.isContextActive()) return
    if (this.processingWritingPlans.get(entry.key) !== entry) return
    try {
      await this.withWritingEntryOperation(entry.agent.session, async (operation, workspace) => {
        const current = await readWritingRequest(workspace)
        if (current?.request_id !== entry.requestId || current.attempt_id !== entry.attemptId
          || current.owner_session_id !== entry.ownerSessionId) {
          if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
          return
        }
        const stop = await readWritingEntryStop(workspace)
        if (stop !== undefined || current.continuation === 'paused') {
          if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
          return
        }
        const { sha256 } = await confirmedOutline(workspace)
        const plan = await readCurrentWritingPlan(workspace, sha256)
        if (current.state === 'consumed' && plan !== undefined) {
          const settled: WritingRequest = {
            ...current,
            processing: undefined,
            error: undefined,
            processing_message_id: undefined,
          }
          await this.mutateProject(operation, lease => writeWritingRequest(workspace, settled, lease))
          if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
          return
        }
        if (current.state === 'answered' && reason.kind !== 'aborted') {
          const failed: WritingRequest = {
            ...current,
            processing: { message_id: entry.messageId, state: 'failed', turn: entry.turn },
            error: reason.kind === 'completed'
              ? { code: 'BID_WRITING_PLAN_NOT_COMMITTED', message: '写作要求已保存，但本轮未成功提交写作计划。主 Agent 将读取诊断并处理。' }
              : { code: reason.kind === 'error' ? reason.error?.code ?? 'BID_WRITING_PLAN_MODEL_ERROR' : 'BID_WRITING_PLAN_TURN_INTERRUPTED',
                message: sanitizeBidErrorText(reason.error?.message ?? `写作计划回合因 ${reason.kind} 中断。`) },
          }
          await this.mutateProject(operation, lease => writeWritingRequest(workspace, failed, lease))
          if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
        }
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Bid 计划回合结算失败：${String(error)}`)
      if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
    }
    void this.publishWritingEntryView(entry.agent.session).catch((error: unknown) => {
      this.ctx.logger.warn(`Bid S5 入口摘要发布失败：${String(error)}`)
    })
  }

  /** Invalidate an online question when reset or an explicit automatic start takes over. */
  private invalidateWritingQuestion(key: BidProjectKey): void {
    const pending = this.pendingWritingQuestions.get(key)
    pending?.controller.abort(new Error('BID_WRITING_QUESTION_INVALIDATED'))
    if (pending !== undefined && this.pendingWritingQuestions.get(key) === pending) this.pendingWritingQuestions.delete(key)
    const processing = this.processingWritingPlans.get(key)
    if (processing !== undefined) {
      this.discardWritingPlanMessage(processing)
      this.processingWritingPlans.delete(key)
    }
  }

  /** 执行器启动前及 Host 操作结束后共用的原子项目检查点。 */
  private async checkpoint(operation: ActiveBidOperation): Promise<void> {
    if (!this.isContextActive()) return
    const task = operation.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
    const state = await checkpointBidProjectState(operation.workspace, task)
    operation.projectRevision = state.revision
    await this.publishProjectState(operation, state)
  }

  /** 在稳定失败落盘并释放项目锁后唤醒主 Agent，不选择业务修复方案。 */
  private steerMainAgentForFailure(session: Session, diagnostic?: string): void {
    const agent = this.ctx.get('agents')?.get(session.id)
    if (agent?.session !== session) return
    if (diagnostic !== undefined) this.injectHostExecutionUpdate(session, {
      stage: bidSessionTaskState(session).stage, status: 'failed', message: sanitizeBidErrorText(diagnostic),
    })
    void this.recoveryDriver.request(agent).catch((error: unknown) => {
      this.ctx.logger.warn(`Bid 恢复结算失败：${sanitizeBidErrorText(String(error))}`)
    })
  }

  private readRecoveryNotice(session: Session): BidRecoveryNotice | undefined {
    if (!this.isContextActive() || !isBidMainSession(session) || this.inFlight.has(projectKey(session))) return
    const agent = this.ctx.get('agents')?.get(session.id)
    if (agent?.session !== session) return
    const task = bidSessionTaskState(session)
    const writing = session.events.findLast(event => event.type === 'bid.writing_entry.changed')
    const decision = task.stage === 'chapter_writing' && task.status === 'waiting_user'
      ? bidWritingPlanRecoveryEligibility(session, this.config.modelStageRepairAttempts)
      : bidRunRecoveryEligibility(session, this.config.modelStageRepairAttempts)
    const original = bidRecoverableRun(session, task)
    const target = decision.target ?? (original === undefined ? undefined
      : { kind: 'run' as const, workId: original.work.workId, runId: original.runId })
    if (target === undefined || task.status === 'suspended'
      && (task.run.cause === 'user_stop' || task.run.cause === 'awaiting_input')
      || task.status === 'waiting_user' && (writing?.type !== 'bid.writing_entry.changed'
        || writing.data.view.phase !== 'failed' || writing.data.view.request_state !== 'answered')) return
    const failure = task.status === 'suspended' ? task.run.error
      : task.status === 'failed' ? task.failure
        : writing?.type === 'bid.writing_entry.changed' ? writing.data.view.error ?? undefined : undefined
    const issues = task.status === 'suspended' ? task.run.error?.issues
      : task.status === 'failed' ? task.failure.issues : undefined
    const facts = [
      '当前阶段执行失败，失败状态已保存。',
      `stage: ${task.stage}`,
      `target: ${JSON.stringify(target)}`,
      `failure_code: ${failure?.code ?? 'BID_WRITING_PLAN_FAILED'}`,
      `failure_unit: ${(task.status === 'suspended' ? task.run.error?.recovery?.unit
        : task.status === 'failed' ? task.failure.recovery?.unit : undefined) ?? 'writing_plan'}`,
      `reason: ${sanitizeBidErrorText(task.status === 'failed' ? task.failure.message : decision.reason)}`,
      `recoverable: ${String(decision.eligible)}`,
      ...issues?.slice(0, 3).map(issue => `${sanitizeBidErrorText(issue.code)}: ${sanitizeBidErrorText(issue.message)}`) ?? [],
      decision.eligible
        ? '已完成成果和 checkpoint 保持不变。先调用 bid_stage_inspect(view="recovery") 分析根因，再用 bid_recover_task 提交具体方案。'
        : '先调用 bid_stage_inspect(view="recovery") 分析真实阻断，向用户说明原因和需要的动作；不要机械重试。',
    ]
    return { target, fingerprint: decision.fingerprint ?? createHash('sha256').update(JSON.stringify([target, failure])).digest('hex'),
      eligible: decision.eligible, reason: decision.reason, facts }
  }

  /** 正式结果在项目锁释放后回传；notice 不授予新的业务写入权限。 */
  private steerMainAgentForResult(session: Session): void {
    if (!this.isContextActive() || !isBidMainSession(session) || this.inFlight.has(projectKey(session))) return
    const agent = this.ctx.get('agents')?.get(session.id)
    if (agent?.session !== session) return
    const notice = session.events.findLast(event => event.type === 'bid.run.notice')
    if (notice?.type !== 'bid.run.notice' || notice.data.kind !== 'completed'
      || notice.data.workId === undefined || notice.data.resultRef === undefined) return
    const identity = 'bid-result:' + notice.data.noticeId
    if (this.resultNotices.get(session) === identity) return
    if (session.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-bid' && event.data.source.form === 'notice'
      && event.data.source.summary === identity)) return
    const message = createUserMessage({ content: [{ type: 'text', text: [
      notice.data.message, `work_id=${notice.data.workId ?? ''}；result_ref=${notice.data.resultRef ?? ''}`,
      '这是已发布结果的只读交付通知。读取任务凭据并汇总实际成果；不得据此创建或扩大用户任务。',
    ].join('\n') }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice', summary: identity } })
    if (agent.status === 'running') agent.inject(message)
    else agent.steer(message)
    this.resultNotices.set(session, identity)
  }

  /** Queue one durable Host summary without waking an idle Interaction Agent. */
  private injectHostExecutionUpdate(session: Session, update: HostExecutionUpdate): void {
    const message = createUserMessage({
      content: [{ type: 'text', text: renderHostExecutionUpdate(update) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    })
    const agent = this.ctx.agents.get(session.id)
    if (agent === undefined) {
      session.append('user/message', message, { surfaceOp: 'append' })
      return
    }
    agent.inject(message)
  }

  /** Publish one deterministic canonical mutation and revision under the project lock. */
  private async mutateProject(
    operation: ActiveBidOperation,
    mutate: (lease: BidPublicationLease) => Promise<void>,
    task = operation.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
  ): Promise<void> {
    const state = await commitBidProjectMutation(operation.workspace, operation.projectRevision, task, mutate)
    operation.projectRevision = state.revision
    await this.publishProjectState(operation, state)
  }

  /**
   * @param ctx - Host Context that owns Sessions and their Bid projection.
   * @param config - validated file limits, model-stage recovery budget, and Subagent concurrency limits.
   */
  constructor(ctx: Context, config: Config = DEFAULT_HOST_RUNTIME_CONFIG) {
    super(ctx, 'bid')
    this.config = config
    this.recoveryDriver = new BidRecoveryDriver(ctx, config.modelStageRepairAttempts,
      session => this.readRecoveryNotice(session), session => this.isContextActive() && isBidMainSession(session)
        && this.ctx.agents.get(session.id)?.session === session && !this.inFlight.has(projectKey(session))
        && !this.writingEntryStops.has(projectKey(session)))
    this.builtInCapabilityDispatcher = createBidCapabilityDispatcher(config, async (input, context) =>
      this.executeChapterRevisionBatchCandidate(context.sourceSession as Session, context.agent,
        context.canonical, input, context.run, { workspace: context.working, run: context.run,
          preservation: await prepareWritingCapabilityPreservation(context, input.tasks.map(task => task.section_id), true) }))
    for (const authority of config.trustedHosts) assertBidUploadTrustedAuthority(authority)
    ctx.effect(
      () => registerBidRuntimeProjection(ctx.sessionProjections, config),
      'bid: runtime projection',
    )
    ctx.effect(
      () => registerBidWritingEntryProjection(ctx.sessionProjections),
      'bid: writing entry projection',
    )
    ctx.effect(
      () => registerBidDocxExportProjection(ctx.sessionProjections),
      'bid: Word export projection',
    )
    ctx.on('session/prompt-admission', ({ session }) => {
      if (!isBidHostSession(session)) return
      const projection = getBidClientProjection(bidSessionTaskState(session))
      if (projection.composer.enabled) return
      const reason = projection.composer.reason
      return {
        reason,
        message: `Bid session prompt rejected by Host admission: ${reason}`,
      }
    }, { global: true })
    installStageInteractionTools(ctx,
      (agent, request, signal, authorization) => this.executeStageInteraction(agent, request, signal, authorization),
      session => new BidWorkspace(projectKey(session), workspaceConfig(this.config)))
    ctx.on('agent/session-start', ({ agent }) => {
      if (!this.isContextActive() || !isBidMainSession(agent.session)) return
      const task = this.drainPersistedCapabilityRequests(agent.session)
      this.recoveryTasks.add(task)
      void task.catch((error: unknown) => {
        this.ctx.logger.warn(`Bid 排队能力任务恢复失败：${sanitizeBidErrorText(
          error instanceof Error ? error.message : String(error),
        )}`)
      }).finally(() => { this.recoveryTasks.delete(task) })
    }, { global: true })
    ctx.inject(['goalRoundDriver'], (goalCtx) => {
      goalCtx.effect(() => goalCtx.goalRoundDriver.registerGate(agent =>
        isBidMainSession(agent.session) && this.inFlight.has(projectKey(agent.session)) ? 'wait' : undefined))
    })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !isBidMainSession(agent.session)) return decision
      const messages = decision.messages.filter(message =>
        message.source.kind !== 'subagent-report' && message.source.kind !== 'subagent-settled')
      if (messages.length === decision.messages.length) return decision
      return messages.length === 0 ? { kind: 'reject' as const } : { ...decision, messages }
    }, { global: true })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!isBidMainSession(agent.session)) return decision
      const key = projectKey(agent.session)
      const entry = this.processingWritingPlans.get(key)
      if (entry === undefined || entry.agent !== agent) return decision
      const hasPlanMessage = decision.messages.some(message => String(message.id) === entry.messageId)
      if (!hasPlanMessage) return decision
      let stale = false
      if (this.writingEntryStops.has(key)) {
        stale = true
      } else {
        try {
          const workspace = new BidWorkspace(agent.session.header.cwd, workspaceConfig(this.config))
          const stop = await readWritingEntryStop(workspace)
          if (stop !== undefined) {
            stale = true
          } else {
            const current = await readWritingRequest(workspace)
            if (current?.request_id !== entry.requestId || current.attempt_id !== entry.attemptId
              || current.continuation === 'paused') stale = true
          }
        } catch {
          stale = true
        }
      }
      if (!stale) return decision
      const remaining = decision.messages.filter(message => String(message.id) !== entry.messageId)
      return remaining.length === 0 ? { kind: 'reject' as const } : { ...decision, messages: remaining }
    }, { global: true })
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => toolCtx.tools.guard((execution) => {
        if (execution.name === 'ask_user_question' && execution.agent !== undefined) {
          const operation = [...this.inFlight.values()].find(active => active.executionHandle?.agent === execution.agent)
          if (operation !== undefined) {
            const run = operation.runs.current
            if (run !== undefined && operation.suspension === undefined) {
              const question = sanitizeBidErrorText(JSON.stringify(execution.arguments), 1600)
              const failure = safeRecoverableBidFailure(run.work, new BidStageExecutionError([{
                code: 'BID_EXECUTION_QUESTION_REQUIRES_MAIN_AGENT',
                message: `后台执行 Agent 尝试等待用户回答：${question}`,
              }]))
              operation.suspension = operation.runs.suspend('executor_error', failure)
              void operation.suspension.catch((error: unknown) => {
                this.ctx.logger.warn(`Bid 后台提问结算失败：${String(error)}`)
              })
            }
            return 'BID_EXECUTION_QUESTION_REQUIRES_MAIN_AGENT'
          }
        }
        const session = execution.agent?.session
        if (session === undefined || !isBidMainSession(session)) return
        if ((execution.name === 'web_search' || execution.name === 'web_fetch') && !this.config.webSearchEnabled) {
          return 'BID_WEB_ACCESS_DISABLED'
        }
        const operation = this.inFlight.get(projectKey(session))
        // shortcut: 通用文件权限包含正式产物目录；需要强制隔离时扩展沙箱策略。
        if (operation !== undefined && operation.session !== session && execution.name.startsWith('bid_')) return 'BID_OPERATION_IN_PROGRESS'
      }))
    })
    ctx.on('agent/session-start', ({ agent }) => {
      if (!isBidMainSession(agent.session)) return
      void this.driveStartedSession(agent, agent.session.header.cwd).catch((error: unknown) => { ctx.logger.warn(`Bid 项目启动失败：${String(error)}`) })
    }, { global: true })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !isBidMainSession(agent.session)) return
      const task = bidSessionTaskState(agent.session)
      if (task.status === 'failed' || task.status === 'waiting_user') {
        this.steerMainAgentForFailure(agent.session)
        return
      }
      if (task.status === 'suspended') {
        this.ensureRunDecision(agent)
        return
      }
      if (task.status !== 'ready') return
      if (agent.session.events.findLast(event => event.type === 'bid.run.started')?.data.run.work.kind === 'capability_task'
        && bidCompletedCapabilityRun(agent.session, task) !== undefined) return
      void this.driveStartedSession(agent, agent.session.header.cwd).catch((error: unknown) => { ctx.logger.warn(`Bid 写作计划启动失败：${String(error)}`) })
    }, { global: true })
    ctx.on('agent/cancel-requested', ({ agent, cause }) => {
      if (cause.kind !== 'user' || !isBidMainSession(agent.session)) return
      void this.handleUserStop(agent.session).catch((error: unknown) => {
        ctx.logger.warn(`Bid 用户停止处理失败：${String(error)}`)
      })
    }, { global: true })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      for (const entry of this.processingWritingPlans.values()) {
        if (String(message.id) === entry.messageId && agent === entry.agent) {
          entry.turn = turn
          void this.withWritingEntryOperation(agent.session, async (operation, workspace) => {
            const current = await readWritingRequest(workspace)
            if (current?.request_id !== entry.requestId || current.attempt_id !== entry.attemptId) return
            if (current.processing?.message_id !== entry.messageId || current.state !== 'answered') return
            const updated: WritingRequest = {
              ...current,
              processing: { message_id: entry.messageId, state: 'running', turn },
            }
            await this.mutateProject(operation, lease => writeWritingRequest(workspace, updated, lease))
          }).catch((error: unknown) => {
            ctx.logger.warn(`Bid 计划处理 running 状态写入失败：${String(error)}`)
          })
          break
        }
      }
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (isBidMainSession(session)) {
        if (event.type === 'bid.run.started' && event.data.run.resumeOf !== undefined
          || event.type === 'bid.recovery.requested' && event.data.target.kind === 'writing_plan') {
          const target = event.type === 'bid.run.started'
            ? { kind: 'run' as const, workId: event.data.run.work.workId, runId: event.data.run.runId }
            : event.data.target
          // Session observer 内禁止再次 append；审计写入在原权威事件发布后进行。
          void Promise.resolve().then(async () => {
            if (!this.isContextActive()) return
            const round = session.events.findLast(item => item.type === 'bid.recovery.round')
            if (round?.type !== 'bid.recovery.round' || ['blocked', 'cancelled', 'recovered', 'waiting_input'].includes(round.data.state)) return
            if (target.kind === 'run' ? round.data.target.kind !== 'run' || round.data.target.workId !== target.workId
              : round.data.target.kind !== 'writing_plan' || round.data.target.requestId !== target.requestId) return
            session.append('bid.recovery.round', { ...round.data, target, state: 'executing', reason: '恢复动作已由 Host 接纳并启动，等待结果核验。' })
            await ctx.sessions.flush(session)
          }).catch((error: unknown) => { ctx.logger.warn(`Bid 恢复执行审计保存失败：${String(error)}`) })
        }
        if (event.type === 'bid.task.changed' && event.data.state.status === 'waiting_user'
          && event.data.state.reason !== undefined) {
          this.injectHostExecutionUpdate(session, {
            stage: event.data.state.stage,
            status: 'waiting_user',
            cause: 'business_attention',
            message: event.data.state.reason,
            issues: event.data.state.issues,
          })
        } else if (event.type === 'bid.task.changed' && event.data.state.status === 'failed') {
          this.injectHostExecutionUpdate(session, {
            stage: event.data.state.stage,
            status: 'failed',
            code: event.data.state.failure.code,
            message: event.data.state.failure.message,
            issues: event.data.state.failure.issues,
          })
        } else if (event.type === 'bid.stage.attention_required') {
          this.injectHostExecutionUpdate(session, {
            stage: event.data.stage,
            status: 'waiting_user',
            cause: 'legacy_business_attention',
            message: event.data.reason,
            issues: event.data.issues,
          })
        } else if (event.type === 'bid.workflow.failed') {
          this.injectHostExecutionUpdate(session, {
            stage: event.data.stage,
            status: 'failed',
            cause: 'workflow_failed',
            message: event.data.reason,
            issues: event.data.issues,
          })
        } else if (event.type === 'bid.stage.completed'
          && getBidStagePolicy(event.data.stage).nextStage === null) {
          this.injectHostExecutionUpdate(session, {
            stage: event.data.stage,
            status: event.data.status,
            message: '当前阶段已完成。',
          })
        }
      }
      if (event.type !== 'turn/end') return
      for (const entry of this.processingWritingPlans.values()) {
        if (entry.turn !== null && event.data.turn === entry.turn && String(entry.agent.session.id) === String(session.id)) {
          void this.finishWritingPlanTurn(entry, event.data.reason)
          break
        }
      }
    }, { global: true })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      for (const entry of this.processingWritingPlans.values()) {
        if (String(message.id) === entry.messageId && agent === entry.agent) {
          if (this.processingWritingPlans.get(entry.key) !== entry) break
          const stopExists = this.writingEntryStops.has(entry.key)
          if (!stopExists) {
            void this.withWritingEntryOperation(agent.session, async (operation, workspace) => {
              const current = await readWritingRequest(workspace)
              if (current?.request_id !== entry.requestId || current.attempt_id !== entry.attemptId) return
              const { sha256 } = await confirmedOutline(workspace)
              const plan = await readCurrentWritingPlan(workspace, sha256)
              if (plan !== undefined) return
              const failed: WritingRequest = {
                ...current,
                processing: { message_id: entry.messageId, state: 'failed', turn: entry.turn },
                error: { code: 'BID_WRITING_PLAN_NOT_COMMITTED', message: '写作要求已保存，但本轮未成功提交写作计划。主 Agent 将读取诊断并处理。' },
              }
              await this.mutateProject(operation, lease => writeWritingRequest(workspace, failed, lease))
            }).catch((error: unknown) => {
              ctx.logger.warn(`Bid 计划处理 discarded 状态写入失败：${String(error)}`)
            })
          }
          if (this.processingWritingPlans.get(entry.key) === entry) this.processingWritingPlans.delete(entry.key)
          break
        }
      }
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const [key, entry] of this.processingWritingPlans) {
        if (entry.agent === agent) {
          this.processingWritingPlans.delete(key)
        }
      }
    }, { global: true })
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer') as unknown as BidBinaryUploadWebServer
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: BID_BINARY_UPLOAD_PATH,
        handler: (req, res) => this.handleBinaryUpload(req, res),
      }), 'bid: binary file intake route')
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: DOCX_TEMPLATE_UPLOAD_PATH,
        handler: (req, res) => this.handleDocxTemplateUpload(req, res),
      }), 'bid: DOCX template upload route')
    })
    ctx.effect(() => async () => {
      this.disposing = true
      const pendingTasks = [...this.pendingRunDecisions.values(), ...this.pendingCapabilityInputs.values(), ...this.recoveryTasks]
      for (const controller of this.pendingRunDecisionControllers.values()) controller.abort(new Error('BID_HOST_DISPOSED'))
      this.pendingRunDecisionControllers.clear()
      for (const controller of this.pendingCapabilityInputControllers.values()) controller.abort(new Error('BID_HOST_DISPOSED'))
      this.pendingCapabilityInputControllers.clear()
      for (const pending of this.pendingWritingQuestions.values()) pending.controller.abort(new Error('BID_HOST_DISPOSED'))
      this.pendingWritingQuestions.clear()
      for (const entry of this.processingWritingPlans.values()) {
        this.discardWritingPlanMessage(entry)
      }
      this.processingWritingPlans.clear()
      await Promise.allSettled(pendingTasks)
    }, 'bid: 收口原生输入与恢复队列')
  }

  /** Validate and durably commit one Main-Agent-submitted S5 writing plan. */
  private async commitWritingPlan(
    agent: Agent,
    workspace: BidWorkspace,
    request: Extract<zod.infer<typeof stageInteractionSchema>, { action: 'bid_confirm_writing_plan' }>,
  ): Promise<
    | { ok: false; error: { code: 'BID_WRITING_PLAN_INVALID'; issues: string[] } }
    | { ok: true; plan: ReturnType<typeof parseWritingPlan>; plan_version: number; request?: WritingRequest; message: string }
  > {
    const { action: _action, ...submitted } = request
    const appliedPath = within(workspace.projectRoot, WRITING_PLAN_APPLIED_PATH)
    await assertNoLinkedPath(workspace.root, appliedPath)
    const current = await confirmedOutline(workspace)
    const previous = await currentWritingPlan(workspace)
    let marker: WritingRequest | undefined
    if (submitted.update_kind === 'initial') {
      const markerPath = within(workspace.projectRoot, WRITING_REQUEST_PATH)
      await assertNoLinkedPath(workspace.root, markerPath)
      try {
        marker = writingRequestSchema.parse(JSON.parse(await readFile(markerPath, 'utf8')))
      } catch {
        return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: ['未找到有效的 S5 初始询问记录，请重新读取 S5 任务上下文。'] } }
      }
      if (marker.confirmed_outline_sha256 !== current.sha256) {
        throw new Error('写作要求询问与当前确认目录不一致，请重新进入 S5。')
      }
      if (submitted.writing_request_id !== marker.request_id || submitted.attempt_id !== marker.attempt_id) {
        return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: ['writing_request_id 或 attempt_id 已失效，请重新读取 S5 任务上下文。'] } }
      }
      if (marker.continuation === 'paused') {
        return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: ['写作计划处理已暂停，请在界面显式恢复后再提交计划。'] } }
      }
      if (marker.owner_session_id !== String(agent.session.id)
        || marker.state !== 'answered' || marker.answer === undefined) {
        return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: ['首次 Writing Plan 必须绑定当前 Session 已保存的真实原生回答。'] } }
      }
    }
    const input = submitted
    const inputIssues = validateWritingPlanInput(input, current.outline, previous)
    if (inputIssues.length > 0) return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: inputIssues } }
    let resolved: ReturnType<typeof resolveWritingRequirementMessages>
    try {
      resolved = resolveWritingRequirementMessages(agent.session, input.user_message_refs)
    } catch (error: unknown) {
      return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: [error instanceof Error ? error.message : String(error)] } }
    }
    let materialized: ReturnType<typeof applyWritingPlanInput>
    try {
      materialized = applyWritingPlanInput(input, resolved, previous)
    } catch (error: unknown) {
      return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues: [error instanceof Error ? error.message : String(error)] } }
    }
    if (submitted.update_kind === 'initial' && marker?.answer?.kind === 'custom') {
      materialized = {
        ...materialized,
        user_requirements: [...materialized.user_requirements, marker.answer.custom ?? ''],
      }
    }
    const { affected_section_ids: materializedAffectedSectionIds, ...planFields } = materialized
    let affectedSectionIds = [...materializedAffectedSectionIds]
    if (previous !== undefined && input.update_kind === 'patch') {
      let appliedVersion = previous.plan_version
      try {
        appliedVersion = zod.strictObject({ schema_version: recordOnlySchemaVersion(1), plan_version: zod.number().int().positive() })
          .parse(JSON.parse(await readFile(appliedPath, 'utf8'))).plan_version
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (appliedVersion < previous.plan_version && previous.revision !== null) {
        affectedSectionIds = [...new Set([...previous.revision.affected_section_ids, ...affectedSectionIds])]
      }
    }
    const version = (previous?.plan_version ?? 0) + 1
    const revision = input.update_kind === 'initial' || previous === undefined ? null : {
      summary: input.summary,
      affected_section_ids: affectedSectionIds,
      base_plan_version: previous.plan_version,
    }
    const plan = parseWritingPlan({
      ...planFields,
      revision,
      schema_version: WRITING_PLAN_SCHEMA_VERSION,
      scope: 'technical_bid',
      plan_version: version,
      confirmed: true,
      confirmed_outline_sha256: current.sha256,
    })
    const issues = validateWritingPlan(plan, current.outline)
    if (issues.length > 0) return { ok: false, error: { code: 'BID_WRITING_PLAN_INVALID', issues } }
    return { ok: true, plan, plan_version: version, ...(marker === undefined ? {} : { request: marker }), message: '整体写作要求与计划已确认，将由当前章节调度器应用。' }
  }

  /** Main Agent 的阶段动作使用项目锁；失败恢复已保存产物，不产生确认事件。 */
  private async executeStageInteraction(agent: Agent, input: unknown, callerSignal: AbortSignal,
    admittedAuthorization: ReturnType<typeof resolveBidToolAuthorization> | null = resolveBidToolAuthorization(agent) ?? null,
  ): Promise<unknown> {
    const { session } = agent
    const request = stageInteractionSchema.parse(input)
    if (!isBidMainSession(session)) throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '阶段工具只供 Bid Main Agent 使用。')
    const key = projectKey(session)
    if (request.action === 'bid_project_inspect') {
      const canonical = new BidWorkspace(key, workspaceConfig(this.config))
      return inspectBidProject(canonical, request.query, this.inFlight.get(key)?.workspace,
        bidRecoverableRun(session, bidSessionTaskState(session))?.work)
    }
    if (request.action === 'bid_run_task') {
      return this.runCapabilityTaskFromTool(agent, request.task, request.supersede)
    }
    if (request.action === 'bid_plan_task') {
      if (this.ctx.agents.get(session.id) !== agent) throw new Error('BID_CAPABILITY_DISPATCHER_UNAVAILABLE')
      const operation = this.beginOperation(session)
      try {
        const state = await this.prepareOperation(operation)
        const completed = bidCompletedCapabilityRun(session, state)
        const interrupted = bidRecoverableRun(session, state)
        const current = interrupted?.cause !== 'awaiting_input' ? interrupted ?? completed : completed
        if (current === undefined || current.work.kind !== 'capability_task' || current.work.workId !== request.work_id) {
          throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
        }
        const saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(operation.workspace, current.work))
        const published = completed === undefined ? undefined
          : await readCapabilityPublicationReceipt(operation.workspace, current.work.workId, current.work.requestSha256)
        if (completed !== undefined && published === null) throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
        const authorization = admittedAuthorization ?? saved.authorization
        const workingPaths = await prepareBidWorkingTree(operation.workspace, current.work)
        const working = new BidWorkspace(workingPaths.root, operation.workspace.config)
        const before = await readCapabilityTaskCheckpoint(operation.workspace, working, { work: current.work }, saved, session)
        const repeated = before !== null && capabilityPlanPatchRepeated(before, authorization,
          request.from_index, request.steps, request.restart_pending)
        const correctionFailure = { code: 'BID_TASK_RESULT_UNMET', message: '用户要求纠正已发布结果；原 Work 已保留，待追加步骤完成后重新核验发布。',
          recovery: { kind: 'repair' as const, unit: current.work.workId, reason: '执行已授权的结果纠正步骤。' } }
        const updatedState: BidTaskState = completed === undefined || repeated ? state : { stage: state.stage, status: 'failed',
          run: null, failure: correctionFailure }
        let stepCount = 0
        await this.mutateProject(operation, async (lease) => {
          const checkpoint = await patchCapabilityTaskSteps({ work: current.work,
            commits: { writeJson: (path, value) => lease.writeJson(path, value) } },
          operation.workspace, working, saved, session, authorization, request.from_index, request.steps, agent,
          this.capabilityTaskDispatcher ?? this.builtInCapabilityDispatcher, published ?? undefined, request.restart_pending)
          await cancelCapabilityRequestsForPlanPatch(operation.workspace, current.work.workId, authorization, lease)
          stepCount = checkpoint.steps.length
        }, updatedState)
        if (completed !== undefined && !repeated) session.append('bid.run.notice', {
          noticeId: `run:${completed.runId}:failed`, supersedesTurn: null, runId: completed.runId,
          stage: state.stage, kind: 'interrupted', severity: 'info', message: correctionFailure.message,
        })
        return { accepted: true, work_id: request.work_id, steps: stepCount,
          message: '已保存未完成步骤；可修复的执行问题请调用 bid_recover_task 在原 Work 继续，用户停止的任务须等用户明确恢复。' }
      } finally { await this.finishOperation(session, operation) }
    }
    if (request.action === 'bid_outline_apply_operations'
      || request.action === 'bid_outline_regenerate_scope' || request.action === 'bid_evidence_remap') {
      const workspace = new BidWorkspace(key, workspaceConfig(this.config))
      const persisted = await readBidProjectState(workspace)
      const state = persisted === undefined ? bidSessionTaskState(session) : bidProjectTaskState(persisted)
      const native = state.status === 'waiting_user' && (request.action === 'bid_evidence_remap'
        ? state.stage === 'evidence_mapping'
        : state.stage === 'outline_generation' || state.stage === 'evidence_mapping')
      if (!native) {
        const baseline = await readCapabilityOutlineBaseline(workspace)
        if (request.expected_revision !== baseline.revision
          || request.expected_draft_sha256 !== baseline.draft_outline_sha256) {
          return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', current: baseline } }
        }
        const task = request.action === 'bid_outline_apply_operations' ? {
          goal: '按用户要求调整目录', scope: { kind: 'project' }, steps: [{ description: '应用目录编辑并同步章节引用', scope: { source: 'task' },
            call: { capability: 'outline.update', input: { operations: request.operations,
              business_bindings: request.business_bindings ?? [] } } }],
        } : request.action === 'bid_outline_regenerate_scope' ? {
          goal: '按用户要求深化选中目录', scope: { kind: 'sections', section_ids: request.section_ids },
          steps: [{ description: '按反馈深化选中目录', scope: { source: 'task' }, call: { capability: 'outline.refine',
            input: { feedback: request.feedback } } }],
        } : {
          goal: '按用户要求更新选中资料', scope: { kind: 'sections', section_ids: request.section_ids },
          steps: [{ description: '重新研究选中章节资料', scope: { source: 'task' }, call: { capability: 'evidence.research',
            input: { mode: request.mode, reason: request.reason ?? '重新核对该范围的资料',
              allow_outline_refinement: false } } }],
        }
        return this.runCapabilityTaskFromTool(agent, bidCapabilityTaskSchema.parse(task))
      }
    }
    if (request.action === 'bid_confirm_writing_plan') {
      const state = bidSessionTaskState(session)
      if (state.stage !== 'chapter_writing') {
        const { action: _action, ...input } = request
        return this.runCapabilityTaskFromTool(agent, bidCapabilityTaskSchema.parse({
          goal: '按用户要求更新写作计划', scope: { kind: 'project' }, steps: [{
            description: input.update_kind === 'patch' ? '更新写作安排与验收条件' : '建立写作安排与验收条件', scope: { source: 'task' },
            call: { capability: 'writing.plan', input } }],
        }))
      }
    }
    if (request.action === 'bid_revise_chapter') {
      {
        return this.runCapabilityTaskFromTool(agent, bidCapabilityTaskSchema.parse({
          goal: request.instruction,
          scope: request.reference.scope === 'paragraphs'
            ? { kind: 'paragraphs', reference: request.reference }
            : { kind: 'sections', section_ids: [request.reference.section_id] },
          steps: [{ description: request.reference.scope === 'paragraphs' ? '按用户意见修订正文选区' : '按用户意见修订章节正文', scope: { source: 'task' }, call: { capability: 'chapter.revise',
            input: { instruction: request.instruction, reference: request.reference } } }],
        }))
      }
    }
    if (request.action === 'bid_pause_stage') return this.setStagePaused(session, true)
    if (request.action === 'bid_resume_stage') return this.setStagePaused(session, false)
    if (request.action === 'bid_resume_current_run') {
      const authorization = resolveBidToolAuthorization(agent)
      if (authorization === undefined) throw new Error('BID_USER_CONTINUATION_REQUIRED')
      if (this.ctx.agents.get(session.id) !== agent) {
        throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '当前主会话无法恢复挂起任务。')
      }
      const current = bidSessionTaskState(session)
      if (current.status !== 'suspended' || current.run.cause === 'awaiting_input') {
        throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', '当前任务不在可由聊天继续的挂起状态。')
      }
      if (current.run.cause === 'user_stop') {
        const messageIndex = session.events.findIndex(event => event.type === 'user/message'
          && String(event.data.id) === authorization.message_id && event.data.source.kind === 'user')
        const stoppedIndex = session.events.findIndex((event) => {
          if (event.type === 'bid.run.suspended') return event.data.run.runId === current.run.runId
            && event.data.run.updatedAt === current.run.updatedAt && event.data.run.cause === 'user_stop'
          if (event.type === 'bid.task.changed') return event.data.state.status === 'suspended'
            && event.data.state.run.runId === current.run.runId && event.data.state.run.updatedAt === current.run.updatedAt
            && event.data.state.run.cause === 'user_stop'
          if (event.type === 'bid.project.resumed' && 'state' in event.data) return event.data.state.status === 'suspended'
            && event.data.state.run.runId === current.run.runId && event.data.state.run.updatedAt === current.run.updatedAt
            && event.data.state.run.cause === 'user_stop'
          return false
        })
        if (messageIndex <= stoppedIndex) throw new Error('BID_USER_CONTINUATION_REQUIRED')
      }
      this.cancelRunDecisions(session)
      const accepted = Promise.withResolvers<{ accepted: true; execution_status: 'started'; completed: false; run_id: string }>()
      const task = this.ctx.agents.withoutInitiator(() => this.resumeCurrentRun(
        session, request.run_id, request.expected_project_revision,
        (run) => { accepted.resolve({ accepted: true, execution_status: 'started', completed: false, run_id: run.runId }) },
      ))
      this.recoveryTasks.add(task)
      void task.then(() => {
        accepted.reject(new Error('BID_RESUME_NOT_ADMITTED'))
      }, (error: unknown) => {
        accepted.reject(error)
        this.ctx.logger.warn(`Bid 用户继续任务失败：${sanitizeBidErrorText(error instanceof Error ? error.message : String(error))}`)
      }).finally(() => {
        this.recoveryTasks.delete(task)
      })
      return accepted.promise
    }
    if (request.action === 'bid_recover_task') {
      if (!isBidMainSession(session) || this.ctx.agents.get(session.id) !== agent) {
        throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '当前调用者不是 live Bid Main Agent。')
      }
      if (request.target === 'writing_plan') {
        const processing = this.processingWritingPlans.get(key)
        if (processing?.requestId === request.writing_request_id
          && processing.attemptId === request.attempt_id && processing.ownerSessionId === String(session.id)) {
          return { accepted: true, execution_status: 'started', completed: false, already_processing: true,
            writing_request_id: processing.requestId, attempt_id: processing.attemptId }
        }
        const decision = bidWritingPlanRecoveryEligibility(session, this.config.modelStageRepairAttempts)
        if (!decision.eligible || decision.target?.requestId !== request.writing_request_id
          || decision.target.attemptId !== request.attempt_id || this.inFlight.has(key)) {
          throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', decision.reason)
        }
        if (bidRecoveryInstructionRepeated(session, decision.target, decision.fingerprint, request.instruction)) {
          throw new BidOrchestratorError('BID_RECOVERY_DUPLICATE_INSTRUCTION', '同一问题不能重复提交相同修复指令。')
        }
        const workspace = new BidWorkspace(key, workspaceConfig(this.config))
        const saved = await readWritingRequest(workspace)
        if (saved?.request_id !== request.writing_request_id || saved.attempt_id !== request.attempt_id
          || saved.owner_session_id !== String(session.id) || saved.state !== 'answered'
          || saved.continuation !== 'allowed' || saved.processing?.state !== 'failed') {
          throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', '已保存写作要求已变化。')
        }
        const accepted = await this.ctx.agents.withoutInitiator(() => this.scheduleWritingPlanProcessing(
          agent, saved, { instruction: request.instruction },
        ))
        return { accepted, execution_status: accepted ? 'started' : 'failed', completed: false,
          writing_request_id: saved.request_id, attempt_id: saved.attempt_id }
      }
      const recoveryKey = `${String(session.id)}:${request.run_id}`
      const existing = this.recoveryAcceptances.get(recoveryKey)
      if (existing !== undefined) return existing
      const decision = bidRunRecoveryEligibility(session, this.config.modelStageRepairAttempts)
      if (!decision.eligible || decision.target?.runId !== request.run_id) {
        throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', decision.reason)
      }
      if (bidRecoveryInstructionRepeated(session, decision.target, decision.fingerprint, request.instruction)) {
        throw new BidOrchestratorError('BID_RECOVERY_DUPLICATE_INSTRUCTION', '同一问题不能重复提交相同修复指令。')
      }
      this.cancelRunDecisions(session)
      const resumed = session.events.findLast(event => event.type === 'bid.project.resumed')
      if (resumed?.type !== 'bid.project.resumed') throw new Error('BID_RUN_RESUME_REVISION_MISSING')
      const accepted = Promise.withResolvers<{
        accepted: true
        execution_status: 'started'
        completed: false
        run_id: string
        recovery_status: 'accepted'
        actual_modification: false
      }>()
      this.recoveryAcceptances.set(recoveryKey, accepted.promise)
      const task = this.ctx.agents.withoutInitiator(() => this.resumeCurrentRun(
        session, request.run_id, resumed.data.revision,
        (run) => { accepted.resolve({ accepted: true, execution_status: 'started', completed: false, run_id: run.runId,
          recovery_status: 'accepted', actual_modification: false }) },
        { instruction: request.instruction },
      ))
      this.recoveryTasks.add(task)
      void task.then(() => {
        accepted.reject(new Error('BID_RECOVERY_NOT_ADMITTED'))
      }, (error: unknown) => {
        accepted.reject(error)
        this.ctx.logger.warn(`Bid 恢复任务失败：${sanitizeBidErrorText(error instanceof Error ? error.message : String(error))}`)
      }).finally(() => {
        this.recoveryTasks.delete(task)
        this.recoveryAcceptances.delete(recoveryKey)
      })
      return accepted.promise
    }
    const active = this.inFlight.get(key)
    if (request.action === 'bid_stage_inspect') {
      let workspace: BidWorkspace | undefined = active?.workspace ?? new BidWorkspace(key, workspaceConfig(this.config))
      if (request.view === 'recovery') {
        const state = bidSessionTaskState(session)
        const run = bidRecoverableRun(session, state)
        if (run !== undefined && run.work.kind !== 'stage_execution' && run.work.kind !== 'file_intake') {
          const paths = await readExistingBidWorkingTree(workspace, run.work)
          workspace = paths === null ? undefined : new BidWorkspace(workspace.root, {
            ...workspace.config,
            projectDirectory: relative(workspace.root, paths.projectRoot),
          })
        } else if (run === undefined && state.status === 'failed') workspace = undefined
      }
      return {
        ...await inspectBidStage(workspace, session, request.reference, request.view),
        ...(request.view === 'recovery' ? { continuation: session.events.findLast(event => event.type === 'bid.recovery.round')?.data ?? null } : {}),
        scheduling_paused: active?.stageControl.paused() ?? false,
      }
    }
    if (request.action === 'bid_plan_revision_batch') {
      const workspace = new BidWorkspace(key, workspaceConfig(this.config))
      const queue = await readRevisionQueue(workspace)
      if (queue.revision !== request.expected_queue_revision) throw new Error('BID_REVISION_BATCH_QUEUE_CONFLICT')
      const ids = request.issue_ids.map((id) => {
        const issue = queue.issues.find(item => item.issue_id === id)
        if (issue === undefined) throw new Error('BID_REVISION_BATCH_ISSUE_NOT_FOUND')
        return issue.section_id
      })
      return this.runCapabilityTaskFromTool(agent, bidCapabilityTaskSchema.parse({
        goal: '处理本次选定的审批意见', issue_ids: request.issue_ids,
        scope: { kind: 'sections', section_ids: [...new Set(ids)] }, steps: [{
          description: '按原始意见处理正文并逐项核验', scope: { source: 'task' },
          call: { capability: 'chapter.revision_batch', input: { issue_ids: request.issue_ids, tasks: request.tasks } },
        }],
      }))
    }
    if (request.action === 'bid_execute_revision_batch') {
      const workspace = new BidWorkspace(key, workspaceConfig(this.config))
      const batch = await readRevisionBatch(workspace, request.batch_id)
      if (batch === null) throw new Error('BID_REVISION_BATCH_NOT_FOUND')
      return this.runCapabilityTaskFromTool(agent, bidCapabilityTaskSchema.parse({
        goal: '处理本次选定的审批意见', issue_ids: batch.issue_ids,
        scope: { kind: 'sections', section_ids: [...new Set(batch.tasks.map(task => task.section_id))] },
        steps: [{ description: '按冻结意见修订正文并核对原始要求', scope: { source: 'task' },
          call: { capability: 'chapter.revision_batch', input: { issue_ids: batch.issue_ids,
            tasks: batch.tasks.map(({ task_id, section_id, issue_ids, depends_on, dependency_reason }) => ({
              task_id, section_id, issue_ids, depends_on, ...(dependency_reason === undefined ? {} : { dependency_reason }),
            })) } } }],
      }))
    }
    if (active !== undefined) {
      const activeRuntime = bidSessionTaskState(active.session)
      if (activeRuntime.stage === 'chapter_writing' && activeRuntime.status === 'running') {
        if (request.action === 'bid_set_flowchart_visual_review') {
          await active.writingControl.enqueue({ kind: 'flowchart_visual_review_policy', policy: request.policy })
          return {
            ok: true, policy: request.policy,
            message: request.policy === 'skip'
              ? '已设置当前 S5 work 后续跳过流程图视觉检查。'
              : '已恢复当前 S5 work 的流程图视觉检查。',
          }
        }
        if (request.action === 'bid_confirm_writing_plan') {
          const committed = await this.commitWritingPlan(agent, active.workspace, request)
          if (!committed.ok) return committed
          await active.writingControl.enqueue({ kind: 'writing_plan', plan: committed.plan })
          const { plan: _plan, request: _request, ...result } = committed
          return result
        }
      }
      while (true) {
        const current = this.inFlight.get(key)
        if (current === undefined) break
        const currentRuntime = bidSessionTaskState(current.session)
        if (currentRuntime.status === 'running') {
          throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前阶段已有操作正在执行。')
        }
        await current.done
      }
    }
    if (request.action === 'bid_set_flowchart_visual_review') {
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const saved = await readBidProjectState(workspace)
      if (saved?.status !== 'suspended' || saved.stage !== 'chapter_writing'
        || saved.run.work.kind !== 'stage_execution') {
        throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '当前没有可设置流程图视觉检查策略的 S5 work。')
      }
      const operation = this.beginOperation(session)
      try {
        await this.prepareOperation(operation)
        const currentTask = operation.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
        if (currentTask.status !== 'suspended' || currentTask.stage !== 'chapter_writing'
          || currentTask.run.work.kind !== 'stage_execution'
          || currentTask.run.runId !== saved.run.runId
          || currentTask.run.work.workId !== saved.run.work.workId) {
          throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', 'The suspended Bid Run changed before the visual policy was saved.')
        }
        const workId = currentTask.run.work.workId
        const records = await readBidChapterCommandJournal(workspace, workId)
        const record: BidChapterCommandRecord = {
          id: randomUUID(), status: 'pending',
          command: { kind: 'flowchart_visual_review_policy', policy: request.policy },
        }
        await this.mutateProject(operation, lease => writeBidChapterCommandJournal(
          workspace, workId, [...records, record], lease,
        ))
        return {
          ok: true, policy: request.policy, workId,
          message: request.policy === 'skip'
            ? '已设置当前 S5 work 后续跳过流程图视觉检查。'
            : '已恢复当前 S5 work 的流程图视觉检查。',
        }
      } finally { await this.finishOperation(session, operation) }
    }
    if (request.action === 'bid_confirm_writing_plan') {
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const saved = await readBidProjectState(workspace)
      if (saved?.status === 'suspended' && saved.stage === 'chapter_writing'
        && saved.run.work.kind === 'stage_execution') {
        const operation = this.beginOperation(session)
        try {
          await this.prepareOperation(operation)
          const currentTask = operation.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
          if (currentTask.status !== 'suspended' || currentTask.run.runId !== saved.run.runId) {
            throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', 'The suspended Bid Run changed before the writing plan was saved.')
          }
          const current = currentTask.run
          const committed = await this.commitWritingPlan(agent, workspace, request)
          if (!committed.ok) return committed
          const records = await readBidChapterCommandJournal(workspace, current.work.workId)
          const record: BidChapterCommandRecord = {
            id: randomUUID(), status: 'pending', command: { kind: 'writing_plan', plan: committed.plan },
          }
          const planPath = within(workspace.projectRoot, WRITING_PLAN_PATH)
          await this.mutateProject(operation, async (lease) => {
            await lease.writeJson(planPath, committed.plan)
            if (request.update_kind === 'initial') {
              if (committed.request === undefined) throw new Error('BID_WRITING_REQUEST_MISSING')
              await writeWritingRequest(workspace, consumedWritingRequest(committed.request, committed.plan_version), lease)
            }
            await writeBidChapterCommandJournal(workspace, current.work.workId, [...records, record], lease)
          })
          if (request.update_kind === 'initial') {
            const entry = this.processingWritingPlans.get(key)
            if (entry !== undefined && entry.requestId === committed.request?.request_id) {
              if (this.processingWritingPlans.get(key) === entry) this.processingWritingPlans.delete(key)
            }
          }
          session.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
          const { plan: _plan, request: _request, ...result } = committed
          return { ...result, accepted: true, workId: current.work.workId }
        } finally { await this.finishOperation(session, operation) }
      }
    }
    callerSignal.throwIfAborted()
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const operation = this.beginOperation(session)
    operation.interaction = true
    const signal = AbortSignal.any([callerSignal, operation.controller.signal])
    let started = false
    let detached = false
    let run: BidRunContext | undefined
    let task = BID_INITIAL_TASK_STATE
    try {
      task = await this.prepareOperation(operation)
      const writingPlanAction = request.action === 'bid_confirm_writing_plan' && task.stage === 'chapter_writing'
        && (task.status === 'waiting_user'
          || (request.update_kind === 'patch' && task.status === 'completed'))
      const outlineAction = request.action !== 'bid_confirm_writing_plan'
        && (task.stage === 'outline_generation' || task.stage === 'evidence_mapping')
      if ((!writingPlanAction && !outlineAction) || (outlineAction && task.status !== 'waiting_user')
        || (request.action === 'bid_evidence_remap' && task.stage !== 'evidence_mapping')) throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '当前阶段不允许该操作。')
      if (request.action === 'bid_confirm_writing_plan') {
        if (request.update_kind === 'initial') {
          if (callerSignal.aborted || operation.controller.signal.aborted || this.writingEntryStops.has(key)) {
            return { ok: false, error: { code: 'BID_WRITING_PLAN_REJECTED', message: 'S5 启动前流程已停止。' } }
          }
          const stop = await readWritingEntryStop(workspace)
          if (stop !== undefined) {
            return { ok: false, error: { code: 'BID_WRITING_PLAN_REJECTED', message: 'S5 启动前流程已停止。' } }
          }
          const currentReq = await readWritingRequest(workspace)
          if (currentReq?.continuation === 'paused' || currentReq?.attempt_id !== request.attempt_id) {
            return { ok: false, error: { code: 'BID_WRITING_PLAN_REJECTED', message: '写作要求状态已变更或已暂停。' } }
          }
        }
        const committed = await this.commitWritingPlan(agent, workspace, request)
        if (!committed.ok) return committed
        await this.mutateProject(operation, async (lease) => {
          await lease.writeJson(within(workspace.projectRoot, WRITING_PLAN_PATH), committed.plan)
          if (request.update_kind === 'initial') {
            const latestReq = await readWritingRequest(workspace)
            const targetReq = latestReq ?? committed.request
            if (targetReq === undefined) throw new Error('BID_WRITING_REQUEST_MISSING')
            const marker = consumedWritingRequest(targetReq, committed.plan_version)
            await writeWritingRequest(workspace, marker, lease)
          }
        }, { stage: 'chapter_writing', status: 'ready', run: null })
        session.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
        const { plan: _plan, request: _request, ...result } = committed
        return result
      }
      const base = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== base.revision || request.expected_draft_sha256 !== base.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', current: base } }
      if (request.action === 'bid_outline_apply_operations') {
        let bindings = request.business_bindings
        if (bindings === undefined && request.operations.some(operation => ['split_section', 'add_section'].includes(operation.type))) {
          const structural = applyOutlineEdits(base.outline, parseOutlineEditOperations(request.operations))
          const [requirements, scoring, compliance, points] = await Promise.all([
            readStageJson(workspace, 'analysis/requirements.json').then(parseTenderRequirementsArtifact),
            readStageJson(workspace, 'analysis/scoring.json').then(parseTenderScoringArtifact),
            readStageJson(workspace, 'analysis/compliance.json').then(parseTenderComplianceArtifact),
            readStageJson(workspace, 'analysis/scoring-response-points.json').then(parseScoringResponsePointCatalog),
          ])
          const roots = request.operations.flatMap(edit => edit.type === 'merge_sections' ? edit.section_ids
            : edit.type === 'add_section' ? edit.parent_id === null
              ? structural.sections.filter(section => section.parent_id === null).map(section => section.id) : [edit.parent_id]
              : [edit.section_id])
          bindings = await generateScopedOutlineBusinessBindings(agent, structural, roots, base.outline, {
            requirements: requirements.requirements.map(item => ({ id: item.id, text: item.normalized_requirement })),
            scoring: scoring.scoring_items.map(item => ({ id: item.id, text: item.criterion })),
            compliance: compliance.compliance_items.map(item => ({ id: item.id, text: item.normalized_rule })),
            response_points: points.points.map(item => ({ id: item.id, scoring_id: item.scoring_id, text: item.text })),
          }, JSON.stringify(request.operations), signal)
        }
        let mutation: OutlineDraftMutationResult | undefined
        await this.mutateProject(operation, async (lease) => {
          mutation = await mutateOutlineDraft(workspace, {
            expected_revision: request.expected_revision,
            expected_draft_sha256: request.expected_draft_sha256,
            operations: parseOutlineEditOperations(request.operations),
            ...(bindings === undefined ? {} : { business_bindings: bindings }),
          }, lease)
          if (!mutation.ok) throw Object.assign(new Error('BID_OUTLINE_MUTATION_REJECTED'), { mutation })
        }).catch((error: unknown) => {
          const rejected = (error as { mutation?: OutlineDraftMutationResult }).mutation
          if (rejected !== undefined) mutation = rejected
          else throw error
        })
        if (mutation === undefined) throw new Error('BID_OUTLINE_MUTATION_MISSING')
        return mutation.ok ? { ok: true, message: '已更新，请重新确认。', draft: mutation.value } : mutation
      }
      signal.throwIfAborted()
      const work = await persistHostWork(workspace, request.action === 'bid_evidence_remap' ? 'evidence_remap' : 'outline_regeneration', task.stage, request)
      const executionAgent = await this.executionAgent(operation, task.stage)
      const admittedRun = await operation.runs.start(work)
      run = admittedRun
      started = true
      detached = true
      void this.finishDetachedOutlineInteraction(
        agent,
        operation,
        executionAgent,
        workspace,
        request,
        task.stage,
        admittedRun,
      )
      return {
        ok: true,
        accepted: true,
        runId: admittedRun.runId,
        message: '阶段操作已接管，正在后台处理；完成后可重新 inspect 查看结果。',
      }
    } finally {
      if (!detached) {
        if (started) {
          if (run !== undefined && operation.runs.current === run && !run.signal.aborted) {
            await operation.runs.complete(run, () => {
              session.append('bid.user_confirmation.required', { stage: task.stage, status: 'waiting_user' })
            })
          } else if (operation.runs.current !== undefined) {
            const failure = safeRecoverableBidFailure(operation.runs.current.work,
              new Error('阶段交互未完成，已保留工作候选供恢复。'))
            await operation.runs.suspend(run?.signal.aborted === true ? 'user_stop'
              : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure)
          }
        }
        try { await this.ctx.sessions.flush(session) } finally { await this.finishOperation(session, operation) }
      }
    }
  }

  /** Keep a long stage interaction owned by Host after the model tool returns. */
  private async finishDetachedOutlineInteraction(
    agent: Agent,
    operation: ActiveBidOperation,
    executionAgent: Agent,
    workspace: BidWorkspace,
    request: OutlineLongInteraction,
    stage: BidStage,
    run: BidRunContext,
  ): Promise<void> {
    let mutation: OutlineDraftMutationResult | undefined
    let failure: unknown
    try {
      mutation = await run.activities.track(() => executeOutlineInteractionCandidate(
        executionAgent,
        workspace,
        request,
        run,
        this.config,
      ))
    } catch (error: unknown) {
      failure = error
    }
    try {
      if (mutation?.ok === true && !run.signal.aborted) {
        await operation.runs.complete(run, () => {
          agent.session.append('bid.user_confirmation.required', { stage, status: 'waiting_user' })
        })
      } else if (operation.runs.current === run) {
        const error = safeRecoverableBidFailure(run.work,
          failure ?? new Error('阶段交互未完成，已保留工作候选供恢复。'))
        await operation.runs.suspend(run.signal.aborted ? 'user_stop'
          : error.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', error)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`Bid 后台阶段交互结算失败：${String(error)}`)
    } finally {
      try { await this.ctx.sessions.flush(agent.session) } finally { await this.finishOperation(agent.session, operation) }
    }
  }

  /** 新聊天仅从项目文件恢复控制状态，等待中的项目不重复运行阶段。 */
  private async driveStartedSession(agent: Agent, cwd: string, startSavedPlan = false): Promise<void> {
    const { session } = agent
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) {
      const checkpoint = active.session.events.findLast(event => event.type === 'bid.project.resumed')
      if (checkpoint !== undefined) {
        session.append('bid.project.resumed', checkpoint.data)
        await this.ctx.sessions.flush(session)
      }
      await active.done
    }
    const operation = this.beginOperation(session)
    let driven = false
    try {
      const task = await this.prepareOperation(operation)
      const workspace = new BidWorkspace(cwd, workspaceConfig(this.config))
      await this.reconcileAdmittedInputs(session, workspace)
      const writingStopped = task.stage === 'chapter_writing' && (
        this.writingEntryStops.has(key)
        || (await readWritingEntryStop(workspace)) !== undefined
        || (await readWritingRequest(workspace))?.continuation === 'paused'
      )
      if (task.status === 'suspended') {
        if (!writingStopped && task.run.cause === 'host_restart'
          && task.run.work.kind !== 'file_intake'
          && ['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'].includes(task.stage)) {
          const { runId } = task.run
          const revision = operation.projectRevision
          const continuation = operation.done.then(async () => {
            if (!this.isContextActive() || this.inFlight.has(key)) return
            await this.ctx.agents.withoutInitiator(() => this.resumeCurrentRun(session, runId, revision))
          })
          this.recoveryTasks.add(continuation)
          void continuation.catch(async (error: unknown) => {
            const message = sanitizeBidErrorText(error instanceof Error ? error.message : String(error))
            this.ctx.logger.warn(`Bid Host 重启续行失败：${message}`)
            const current = bidSessionTaskState(session)
            if (current.status !== 'suspended' || current.run.cause !== 'host_restart'
              || current.run.runId !== runId || this.inFlight.has(key)) return
            session.append('bid.run.notice', { noticeId: `run:${runId}:resume-failed`, supersedesTurn: null,
              runId, stage: current.stage, kind: 'interrupted', severity: 'error', message })
            await this.ctx.sessions.flush(session)
            this.steerMainAgentForFailure(session, message)
          }).finally(() => { this.recoveryTasks.delete(continuation) })
        } else this.ensureRunDecision(agent)
        return
      }
      if (task.stage === 'chapter_writing' && task.status !== 'running') {
        if (writingStopped) {
          await this.broadcastWritingEntryView(workspace, task, operation.projectRevision, [session])
          await this.ctx.sessions.flush(session)
          return
        }
      }
      if (task.stage === 'chapter_writing' && task.status === 'waiting_user') {
        const existing = await readWritingRequest(workspace)
        if (existing !== undefined) {
          void operation.done.then(async () => {
            if (existing.state === 'awaiting_answer') this.startWritingQuestion(agent, existing)
            else if (existing.state === 'answered' && existing.continuation !== 'paused') await this.resumeWritingPlanProcessing(agent, workspace)
          }).catch((error: unknown) => { this.ctx.logger.warn(`Bid S5 原生提问恢复失败：${String(error)}`) })
        }
        await this.ctx.sessions.flush(session)
        void this.publishWritingEntryView(session).catch((error: unknown) => {
          this.ctx.logger.warn(`Bid S5 入口摘要发布失败：${String(error)}`)
        })
        return
      }
      if (task.status !== 'ready' || task.stage === 'file_intake') return
      const completedCapability = bidCompletedCapabilityRun(session, task)
      const latestRun = session.events.findLast(event => event.type === 'bid.run.started')
      // 局部能力恢复原阶段后，空闲状态不授予整本阶段的执行权限。
      if (!startSavedPlan && completedCapability !== undefined && latestRun?.data.run.runId === completedCapability.runId) return
      driven = true
      const executionAgent = await this.executionAgent(operation, task.stage)
      const orchestrator = this.automaticOrchestrator(executionAgent, workspace, operation.controller.signal, operation)
      if (task.stage === 'chapter_writing' && await hasCurrentWritingPlan(workspace)) {
        await orchestrator.runConfirmedStage()
      } else {
        await orchestrator.drive()
      }
      await this.ctx.sessions.flush(session)
      if (bidSessionTaskState(session).status === 'suspended') this.ensureRunDecision(agent)
    } finally {
      await this.finishOperation(session, operation, driven)
    }
  }

  private createBeforeStageStart(operation: ActiveBidOperation, workspace: BidWorkspace): BidBeforeStageStart {
    const key = projectKey(operation.session)
    return async (stage, resumeOf) => {
      if (stage !== 'chapter_writing') return true
      if (operation.controller.signal.aborted || this.writingEntryStops.has(key)) return false
      const task = operation.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      if (resumeOf !== undefined) {
        return bidRecoverableRun(operation.session, task)?.runId === resumeOf.runId
      }
      try {
        const stop = await readWritingEntryStop(workspace)
        if (stop !== undefined) return false
      } catch {
        return false
      }
      if (task.stage !== 'chapter_writing' || task.status !== 'ready') return false
      try {
        const request = await readWritingRequest(workspace)
        if (request?.continuation === 'paused') return false
        const { sha256 } = await confirmedOutline(workspace)
        const plan = await readCurrentWritingPlan(workspace, sha256)
        if (plan === undefined) return false
        return true
      } catch {
        return false
      }
    }
  }

  /** Build the production executor and Validator for implemented automatic stages. */
  private automaticOrchestrator(
    agent: Agent,
    workspace: BidWorkspace,
    signal: AbortSignal | undefined,
    operation: ActiveBidOperation,
    intake?: {
      readonly incoming: readonly IncomingFile[]
      readonly failures: readonly BidFileIntakeFileResult[]
      readonly work: BidWorkDescriptor
      readonly onImported: (files: ImportedFile[]) => void
    },
  ): BidOrchestrator {
    let intakeFiles: IncomingFile[] = []
    let importedFiles: ImportedFile[] = []
    return new BidOrchestrator(
      operation.session,
      {
        canExecute: stage => stage === 'file_intake' || defaultBidCapabilityForStage(stage) !== undefined,
        execute: async (task, run) => {
          this.setExecutionAgentStage(operation, agent, task.stage)
          await run.scheduler.waitUntilRunnable(run.signal)
          if (task.stage === 'file_intake') {
            if (run.work.kind !== 'file_intake') throw new Error('BID_FILE_INTAKE_WORK_REQUIRED')
            intakeFiles = await readFileIntakeWork(workspace, run.work)
            importedFiles = await workspace.import(intakeFiles, run)
            intake?.onImported(importedFiles)
            if (intake !== undefined && intake.failures.length > 0) {
              throw new Error('file intake could not decode every selected file')
            }
            return [{ stage: 'file_intake', type: 'manifest', path: 'manifest.json' }]
          }
          if (task.stage === 'docx_export') return executeDocxExport(
            workspace,
            run,
            undefined,
            undefined,
            undefined,
            createDocxVisualReviewer(this.ctx, operation.session, run.signal),
          )
          if (task.stage === 'evidence_mapping' && run.work.kind === 'stage_execution') {
            const payload = await readHostWork(workspace, run.work)
            if (payload !== null && typeof payload === 'object' && 'kind' in payload
              && payload.kind === 'evidence_mapping_takeover') {
              const request = evidenceMappingTakeoverSchema.parse(payload)
              if (request.authorization.session_id !== String(operation.session.id)) {
                throw new Error('BID_RESUME_OWNER_SESSION_REQUIRED')
              }
              if (operation.recovery?.workId !== run.work.workId) throw new Error('BID_RECOVERY_AUTHORIZATION_MISSING')
              return executeEvidenceMappingTakeoverCandidate(agent, workspace, run, this.config, operation.recovery)
            }
          }
          if (defaultBidCapabilityForStage(task.stage) === 'chapter.write') {
            await operation.writingControl.bind(workspace, run.work.workId, run.commits)
          }
          return this.builtInCapabilityDispatcher.executeDefault(task, {
            agent, workspace, run,
            maxRepairAttempts: this.config.modelStageRepairAttempts,
            evidenceMappingMaxConcurrency: this.config.evidenceMappingMaxConcurrency,
            chapterWritingMaxConcurrency: this.config.chapterWritingMaxConcurrency,
            chapterWritingCompletionRepairRounds: this.config.chapterWritingCompletionRepairRounds,
            webSearchEnabled: this.config.webSearchEnabled,
            writingControl: operation.writingControl,
            ...(operation.recovery?.workId === run.work.workId ? { recovery: operation.recovery } : {}),
          })
        },
      },
      {
        validate: (stage, artifacts) => {
          switch (stage) {
            case 'file_intake': return validateFileIntake(workspace, importedFiles, stage, artifacts, intake?.incoming ?? intakeFiles)
            case 'docx_export': return validateDocxExport(workspace, stage, artifacts)
            default: return this.builtInCapabilityDispatcher.validateDefault(stage, workspace, artifacts)
          }
        },
      },
      signal,
      (fromStage, toStage) => prepareBidStageContextTransition(
        operation.session,
        workspace,
        fromStage,
        toStage,
      ),
      operation.runs,
      async (stage) => {
        if (stage === 'file_intake' && intake !== undefined) return intake.work
        if (stage === 'chapter_writing' && !await hasCurrentWritingPlan(workspace)) {
          const current = await confirmedOutline(workspace)
          const plan = createAutomaticWritingPlan(current.outline, current.sha256)
          const planPath = within(workspace.projectRoot, WRITING_PLAN_PATH)
          await assertNoLinkedPath(workspace.root, planPath)
          await this.mutateProject(operation, lease => lease.writeJson(planPath, plan))
        }
        return persistHostWork(workspace, 'stage_execution', stage, { stage })
      },
      this.createBeforeStageStart(operation, workspace),
    )
  }

  /** 重置请求返回已提交状态后，再让同一项目操作继续自动阶段。 */
  private async finishResetStage(
    interactionAgent: Agent,
    operation: ActiveBidOperation,
    stage: BidStage,
  ): Promise<void> {
    try {
      const executionAgent = await this.executionAgent(operation, stage)
      await this.automaticOrchestrator(
        executionAgent,
        operation.workspace,
        operation.controller.signal,
        operation,
      ).drive()
      await this.ctx.sessions.flush(operation.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(`Bid 重置后的阶段续行失败：${String(error)}`)
    } finally {
      try {
        await this.finishOperation(operation.session, operation)
      } finally {
        if (bidSessionTaskState(operation.session).status === 'suspended') this.ensureRunDecision(interactionAgent)
      }
    }
  }

  /**
   * Pause or resume only future task starts in the active stage operation.
   * @param session Main Agent Session that owns the active project operation.
   * @param paused whether later stage tasks should wait.
   * @returns the current scheduling gate state or a stable rejection.
   */
  private setStagePaused(session: Session, paused: boolean): {
    readonly ok: boolean
    readonly scheduling_paused?: boolean
    readonly changed?: boolean
    readonly error?: { readonly code: string; readonly message: string }
  } {
    const operation = this.inFlight.get(projectKey(session))
    if (operation === undefined) {
      return { ok: false, error: { code: 'BID_STAGE_CONTROL_NOT_ALLOWED', message: '当前没有正在运行的阶段任务。' } }
    }
    const task = bidSessionTaskState(operation.session)
    if (task.status !== 'running') {
      return { ok: false, error: { code: 'BID_STAGE_CONTROL_NOT_ALLOWED', message: '当前阶段不处于运行状态。' } }
    }
    const changed = paused ? operation.stageControl.pause() : operation.stageControl.resume()
    return { ok: true, scheduling_paused: operation.stageControl.paused(), changed }
  }

  /**
   * Rewind to the current or an earlier Bid stage and apply its fixed restart policy.
   * Active work is cancelled and drained before artifacts owned by the selected
   * stage and every later stage are removed.
   * S1 同时清理项目内上传资料、解析语料、资料清单与 Word 模板及格式配置。
   * @param agent - live Bid Agent receiving the scoped command.
   * @param stage - current or earlier stage named by that command.
   * @returns S2-S4 已提交的 ready 状态；S1 与 S5 返回 waiting_user。
   */
  async resetStage(agent: Agent, stage: BidStage): Promise<BidTaskState> {
    const { session } = agent
    if (!isBidMainSession(session)) {
      throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', 'Stage reset requires a Bid Session with a Host workspace.')
    }
    const key = projectKey(session)
    this.invalidateWritingQuestion(key)
    this.discardActiveWritingPlanProcessing(key)
    this.unsavedWritingAnswers.delete(key)
    const barrier = this.writingEntryStops.get(key)
    if (barrier !== undefined) {
      await barrier.done.catch(() => {})
      this.writingEntryStops.delete(key)
    }
    if (this.docxInFlight.has(key)) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Word 操作正在执行，请完成后重置阶段。')
    }
    const prior = this.inFlight.get(key)
    const priorExecutionAgent = prior?.executionHandle?.agent
    let priorRetirement: Promise<void> | undefined
    if (prior !== undefined) {
      if (prior.reservedForReset || prior.session !== session) {
        throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Bid 操作正在执行。')
      }
      const runtime = bidSessionTaskState(session)
      if (BID_STAGES.indexOf(stage) > BID_STAGES.indexOf(runtime.stage)) throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', '不能重置尚未开始的阶段。')
      if (prior.finishing === undefined) priorRetirement = prior.retirement ??= prior.runs.retire()
      this.inFlight.delete(key)
    }
    if (BID_STAGES.indexOf(stage) > BID_STAGES.indexOf(bidSessionTaskState(session).stage)) {
      throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', '不能重置尚未开始的阶段。')
    }
    this.cancelRunDecisions(session)
    const operation = this.beginOperation(session)
    operation.reservedForReset = true
    let resetCompleted = false
    let detached = false
    try {
      if (prior !== undefined) {
        if (priorRetirement !== undefined) {
          prior.controller.abort()
          priorExecutionAgent?.cancel({ kind: 'hook', reason: 'bid-stage-reset' })
          await Promise.all([priorRetirement, prior.done, priorExecutionAgent?.whenIdle()])
        } else {
          await prior.done
        }
      }
      const runtime = await this.prepareOperation(operation)
      if (BID_STAGES.indexOf(stage) > BID_STAGES.indexOf(runtime.stage)) throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', '不能重置尚未开始的阶段。')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const resetPaths: Readonly<Record<BidStage, readonly string[]>> = {
        file_intake: ['input', 'corpus', 'manifest.json', 'word-export', 'analysis', 'outline', 'chapters', 'flowcharts'],
        tender_analysis: ['analysis', 'outline', 'chapters', 'flowcharts'],
        outline_generation: [
          'analysis/scoring-response-points.candidate.json',
          'analysis/scoring-response-points.json',
          'analysis/evidence-mapping-plan.json',
          'analysis/evidence-mapping-log.json',
          'analysis/evidence-mapping-checkpoint.json',
          'analysis/evidence-map.candidate.json',
          'analysis/evidence-mapping-quality.candidate.json',
          'analysis/evidence-map.json',
          'analysis/web-evidence-sources.json',
          'analysis/web-sources',
          'outline',
          'chapters',
          'flowcharts',
        ],
        evidence_mapping: [
          'analysis/evidence-mapping-plan.json',
          'analysis/evidence-mapping-log.json',
          'analysis/evidence-mapping-checkpoint.json',
          'analysis/evidence-map.candidate.json',
          'analysis/evidence-mapping-quality.candidate.json',
          'outline/refined-outline.candidate.json',
          'analysis/evidence-map.json',
          'analysis/web-evidence-sources.json',
          'analysis/web-sources',
          'outline/draft.json',
          'outline/outline.json',
          'outline/quality-report.json',
          'outline/confirmed-outline.json',
          'outline/confirmation.json',
          'chapters',
          'flowcharts',
        ],
        chapter_writing: ['chapters', 'flowcharts'],
        docx_export: ['flowcharts'],
      }
      const paths = [...new Set([
        ...resetPaths[stage].map(path => within(workspace.projectRoot, path)),
        ...(await bidResetWorkPaths(workspace, stage)),
      ])]
      for (const path of paths) await assertNoLinkedPath(workspace.root, path)
      const resetState: BidTaskState = stage === 'file_intake' || stage === 'chapter_writing'
        ? { stage, status: 'waiting_user', run: null }
        : { stage, status: 'ready', run: null }
      await this.mutateProject(operation, async (lease) => {
        const canceled = await cancelCapabilityRequestsForReset(workspace, paths, lease)
        if (canceled > 0) this.ctx.logger.info(`Bid 重置取消 ${canceled} 项输入已失效的排队能力任务。`)
        const invalidatedExports = await invalidateDocxLastExports(workspace, lease)
        const registeredExports = await clearDocxExportArtifacts(workspace, lease)
        const outputPaths = [...new Set(workspace.config.outputDirectory === DEFAULT_BID_CONFIG.outputDirectory
          ? [workspace.outputRoot]
          : [...invalidatedExports, ...registeredExports])]
        for (const path of outputPaths) await assertNoLinkedPath(workspace.root, path)
        await Promise.all([
          ...paths.map(path => lease.remove(path, true)),
          ...outputPaths.map(path => lease.remove(path, path === workspace.outputRoot)),
        ])
      }, resetState)
      resetBidStageContext(session, stage)
      session.append('bid.task.changed', { state: resetState })
      await this.ctx.sessions.flush(session)
      resetCompleted = true
      if (resetState.status !== 'ready') return bidSessionTaskState(session)
      operation.reservedForReset = false
      detached = true
      setImmediate(() => { void this.finishResetStage(agent, operation, stage) })
      return bidSessionTaskState(session)
    } finally {
      operation.reservedForReset = false
      if (!detached) {
        try {
          await this.finishOperation(session, operation)
        } finally {
          if (resetCompleted && bidSessionTaskState(session).status === 'suspended') this.ensureRunDecision(agent)
        }
      }
    }
  }

  /**
   * Ask the Main Agent for manual S5 writing requirements.
   * @param session - live Bid Session waiting before chapter writing.
   * @param intent - whether to ensure or retry the writing request.
   * @returns the unchanged waiting state after the request is durably queued.
   */
  @Remote('requestWritingRequirements')
  async requestWritingRequirements(
    session: Session,
    intent?: WritingEntryIntent,
  ): Promise<BidChapterWritingGateResult> {
    if (!isBidMainSession(session)) {
      return chapterWritingGateResult({ ok: false, code: 'BID_SESSION_REQUIRED', message: 'Writing requirements require a Bid Session with a Host workspace.' })
    }
    const parsedIntent = writingEntryIntentSchema.parse(intent ?? { mode: 'ensure' })
    const key = projectKey(session)
    if (this.inFlight.has(key)) {
      return chapterWritingGateResult({ ok: false, code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' })
    }
    const operation = this.beginOperation(session)
    operation.interaction = true
    let effect: WritingEntryEffect = { kind: 'none' }
    let result: BidChapterWritingGateResult
    try {
      const task = await this.prepareOperation(operation)
      const projection = getBidClientProjection(task)
      const isWaitingUserEntry = task.stage === 'chapter_writing'
        && task.status === 'waiting_user'
        && projection.allowedActions.includes('request_writing_requirements')
      if (!isWaitingUserEntry) {
        result = chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_NOT_ALLOWED', message: 'Writing requirements are not requested in the current Bid stage state.' })
      } else {
        const agent = this.ctx.agents.get(session.id)
        if (agent === undefined) {
          result = chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: 'Bid Session has no live Agent.' })
        } else {
          const workspace = operation.workspace
          const { sha256 } = await confirmedOutline(workspace)
          const currentRequest = await readWritingRequest(workspace)
          const stop = await readWritingEntryStop(workspace)
          const currentPlan = await readCurrentWritingPlan(workspace, sha256)
          const state = await readBidProjectState(workspace)
          const revision = state?.revision ?? 0
          if (parsedIntent.mode !== 'ensure') {
            const expected = parsedIntent.expected
            if (expected.project_revision !== revision
              || expected.request_id !== (currentRequest?.request_id ?? null)
              || expected.attempt_id !== (currentRequest?.attempt_id ?? null)
              || expected.stop_id !== (stop?.stop_id ?? null)
              || expected.plan_version !== (currentPlan?.plan_version ?? null)) {
              result = chapterWritingGateResult({ ok: false, code: 'BID_WRITING_ENTRY_CONFLICT', message: '入口状态已变更，请刷新后重试。' })
            } else {
              effect = await this.handleWritingEntryAction(
                parsedIntent, session, workspace, operation, currentRequest, stop, currentPlan, sha256,
              )
              await this.ctx.sessions.flush(session)
              result = chapterWritingGateResult({ ok: true, value: task })
            }
          } else {
            effect = await this.handleWritingEntryEnsure(session, workspace, operation, currentRequest, stop, currentPlan, sha256)
            await this.ctx.sessions.flush(session)
            result = chapterWritingGateResult({ ok: true, value: task })
          }
        }
      }
    } catch (error: unknown) {
      result = chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: error instanceof Error ? error.message : 'The Bid Host could not request writing requirements.' })
    } finally {
      await this.finishOperation(session, operation)
    }
    if (effect.kind !== 'none') {
      const agent = this.ctx.agents.get(session.id)
      if (agent !== undefined) {
        try {
          if (effect.kind === 'ask') {
            this.startWritingQuestion(agent, effect.request)
          } else if (effect.kind === 'process') {
            await this.scheduleWritingPlanProcessing(agent, effect.request)
          } else if (effect.kind === 'start_saved_plan') {
            void this.driveStartedSession(agent, session.header.cwd, true).catch((error: unknown) => {
              this.ctx.logger.warn(`Bid S5 计划启动失败：${String(error)}`)
            })
          }
        } catch (error: unknown) {
          this.ctx.logger.warn(`Bid S5 入口效果执行失败：${String(error)}`)
        }
      }
    }
    return result
  }

  /** ensure 模式：只确保首次入口，不是恢复授权。 */
  private async handleWritingEntryEnsure(
    session: Session,
    workspace: BidWorkspace,
    operation: ActiveBidOperation,
    currentRequest: WritingRequest | undefined,
    stop: WritingEntryStop | undefined,
    currentPlan: ReturnType<typeof parseWritingPlan> | undefined,
    sha256: string,
  ): Promise<WritingEntryEffect> {
    if (currentPlan !== undefined) return { kind: 'none' }
    if (stop !== undefined || currentRequest?.continuation === 'paused') return { kind: 'none' }
    if (currentRequest !== undefined) return { kind: 'none' }
    const request = writingRequestSchema.parse({
      schema_version: WRITING_REQUEST_SCHEMA_VERSION,
      request_id: randomUUID(),
      confirmed_outline_sha256: sha256,
      owner_session_id: String(session.id),
      attempt_id: randomUUID(),
      state: 'awaiting_answer',
      continuation: 'allowed',
    })
    await this.mutateProject(operation, lease => writeWritingRequest(workspace, request, lease))
    return { kind: 'ask', request }
  }

  /** reopen/resume/takeover/retry_answer 模式处理。 */
  private async handleWritingEntryAction(
    intent: Extract<WritingEntryIntent, { mode: 'reopen' | 'resume' | 'takeover' | 'retry_answer' }>,
    session: Session,
    workspace: BidWorkspace,
    operation: ActiveBidOperation,
    currentRequest: WritingRequest | undefined,
    stop: WritingEntryStop | undefined,
    currentPlan: ReturnType<typeof parseWritingPlan> | undefined,
    sha256: string,
  ): Promise<WritingEntryEffect> {
    const key = projectKey(session)
    if (intent.mode === 'reopen') {
      if (currentPlan !== undefined) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '已有有效计划，不能重新打开问题。')
      }
      if (currentRequest !== undefined && (currentRequest.state === 'answered' || currentRequest.state === 'consumed') && currentRequest.answer !== undefined) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '已有保存的答案，请使用恢复。')
      }
      this.invalidateWritingQuestion(key)
      this.unsavedWritingAnswers.delete(key)
      const request = writingRequestSchema.parse({
        schema_version: WRITING_REQUEST_SCHEMA_VERSION,
        request_id: randomUUID(),
        confirmed_outline_sha256: sha256,
        owner_session_id: String(session.id),
        attempt_id: randomUUID(),
        state: 'awaiting_answer',
        continuation: 'allowed',
      })
      await this.mutateProject(operation, async (lease) => {
        await writeWritingRequest(workspace, request, lease)
        if (stop !== undefined) await removeWritingEntryStop(workspace, lease)
      })
      return { kind: 'ask', request }
    }
    if (intent.mode === 'resume') {
      if (currentPlan !== undefined) {
        if (intent.expected.plan_version !== currentPlan.plan_version) {
          throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '计划版本不匹配。')
        }
        const nextState: BidTaskState = { stage: 'chapter_writing', status: 'ready', run: null }
        if (currentRequest !== undefined) {
          const resumed = writingRequestSchema.parse({
            ...currentRequest,
            continuation: 'allowed',
            attempt_id: randomUUID(),
            processing: undefined,
            processing_message_id: undefined,
            error: undefined,
          })
          await this.mutateProject(operation, async (lease) => {
            await writeWritingRequest(workspace, resumed, lease)
            if (stop !== undefined) await removeWritingEntryStop(workspace, lease)
          }, nextState)
        } else {
          await this.mutateProject(operation, async (lease) => {
            if (stop !== undefined) await removeWritingEntryStop(workspace, lease)
          }, nextState)
        }
        session.append('bid.task.changed', { state: nextState })
        return { kind: 'start_saved_plan' }
      }
      if (currentRequest !== undefined && currentRequest.state === 'answered' && currentRequest.owner_session_id === String(session.id)) {
        const resumed = writingRequestSchema.parse({
          ...currentRequest,
          attempt_id: randomUUID(),
          continuation: 'allowed',
          processing: undefined,
          processing_message_id: undefined,
          error: undefined,
        })
        await this.mutateProject(operation, async (lease) => {
          await writeWritingRequest(workspace, resumed, lease)
          if (stop !== undefined) await removeWritingEntryStop(workspace, lease)
        })
        return { kind: 'process', request: resumed }
      }
      throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '没有可恢复的已保存要求，请重新填写写作要求。')
    }
    if (intent.mode === 'takeover') {
      if (currentRequest === undefined) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '没有当前请求可以接管。')
      }
      this.invalidateWritingQuestion(key)
      this.unsavedWritingAnswers.delete(key)
      const taken = writingRequestSchema.parse({
        ...currentRequest,
        owner_session_id: String(session.id),
        attempt_id: randomUUID(),
        processing: undefined,
        processing_message_id: undefined,
      })
      await this.mutateProject(operation, lease => writeWritingRequest(workspace, taken, lease))
      if (taken.state === 'awaiting_answer' && taken.continuation !== 'paused') {
        return { kind: 'ask', request: taken }
      }
      if (taken.state === 'answered' && taken.continuation === 'allowed') {
        return { kind: 'process', request: taken }
      }
      return { kind: 'none' }
    }
    {
      const unsaved = this.unsavedWritingAnswers.get(key)
      if (unsaved === undefined) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '没有待重试的未保存答案。')
      }
      if (currentPlan !== undefined) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '已有有效计划，不能重试答案。')
      }
      if (stop !== undefined || this.writingEntryStops.has(key)) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', 'S5 处于停止状态，不能重试答案。')
      }
      if (currentRequest === undefined || currentRequest.state !== 'awaiting_answer'
        || currentRequest.request_id !== unsaved.requestId
        || currentRequest.attempt_id !== unsaved.attemptId
        || currentRequest.owner_session_id !== unsaved.ownerSessionId
        || intent.expected.request_id !== unsaved.requestId
        || intent.expected.attempt_id !== unsaved.attemptId) {
        throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '未保存答案的提问身份与当前状态不符。')
      }
      const classified = classifyWritingRequirementAnswer(currentRequest.request_id, unsaved.answer)
      const next: WritingRequest = classified.kind === 'dismissed'
        ? { ...currentRequest, state: 'dismissed', continuation: 'allowed', error: undefined }
        : {
          ...currentRequest,
          state: 'answered',
          continuation: 'allowed',
          error: undefined,
          answer: {
            question_id: currentRequest.request_id,
            kind: classified.kind,
            selected: [...classified.selected],
            ...(classified.kind === 'custom' ? { custom: classified.custom } : {}),
          },
        }
      await this.mutateProject(operation, lease => writeWritingRequest(workspace, next, lease))
      if (this.unsavedWritingAnswers.get(key) === unsaved) {
        this.unsavedWritingAnswers.delete(key)
      }
      if (classified.kind === 'dismissed') return { kind: 'none' }
      return { kind: 'process', request: next }
    }
    throw new BidOrchestratorError('BID_WRITING_ENTRY_ACTION_NOT_ALLOWED', '未知的写作入口操作。')
  }

  /** 构造 S5 入口安全摘要。 */
  private async readWritingEntryView(
    session: Session,
    workspace: BidWorkspace,
    task: BidTaskState,
    revision: number,
  ): Promise<WritingEntryView> {
    if (task.stage !== 'chapter_writing') {
      return this.inactiveEntryView(revision)
    }
    if (task.status === 'running' || task.status === 'suspended') {
      return { ...this.inactiveEntryView(revision), phase: 'running' }
    }
    const key = projectKey(session)
    const stopBarrier = this.writingEntryStops.has(key)
    let stop: WritingEntryStop | undefined
    try {
      stop = await readWritingEntryStop(workspace)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      stop = undefined
    }
    const { sha256 } = await confirmedOutline(workspace)
    if (stop !== undefined && stop.confirmed_outline_sha256 !== sha256) {
      return {
        expected: {
          project_revision: revision,
          request_id: null,
          attempt_id: null,
          stop_id: stop.stop_id,
          plan_version: null,
        },
        phase: 'failed',
        owner_session_id: null,
        request_state: null,
        continuation: 'paused',
        processing_state: null,
        has_answer: false,
        has_plan: false,
        answer_save_status: 'none',
        can_retry_answer: false,
        error: {
          code: 'BID_WRITING_ENTRY_STOP_CONFLICT',
          message: '停止记录与当前大纲版本不一致。',
        },
        durability: 'memory_only',
      }
    }
    let currentPlan: ReturnType<typeof parseWritingPlan> | undefined
    try {
      currentPlan = await readCurrentWritingPlan(workspace, sha256)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      currentPlan = undefined
    }
    const request = await readWritingRequest(workspace)
    const expected: WritingEntryExpected = {
      project_revision: revision,
      request_id: request?.request_id ?? null,
      attempt_id: request?.attempt_id ?? null,
      stop_id: stop?.stop_id ?? null,
      plan_version: currentPlan?.plan_version ?? null,
    }
    const hasPlan = currentPlan !== undefined
    const hasAnswer = request?.answer !== undefined
    const isPaused = stopBarrier || stop !== undefined || request?.continuation === 'paused'
    const isFailed = request?.error !== undefined || request?.processing?.state === 'failed'
    let phase: WritingEntryView['phase']
    if (isPaused) {
      phase = 'paused'
    } else if (isFailed) {
      phase = 'failed'
    } else if (hasPlan) {
      phase = 'ready'
    } else if (request?.state === 'awaiting_answer') {
      phase = 'awaiting_answer'
    } else if (request?.state === 'dismissed') {
      phase = 'dismissed'
    } else if (request?.state === 'answered' && request.processing?.state !== 'failed') {
      phase = 'planning'
    } else {
      phase = 'empty'
    }
    const unsaved = this.unsavedWritingAnswers.get(key)
    const hasUnsavedAnswer = unsaved !== undefined
      && (request === undefined || (unsaved.requestId === request.request_id && unsaved.attemptId === request.attempt_id))
    return {
      expected,
      phase,
      owner_session_id: request?.owner_session_id ?? null,
      request_state: request?.state ?? null,
      continuation: request?.continuation ?? null,
      processing_state: request?.processing?.state ?? null,
      has_answer: hasAnswer,
      has_plan: hasPlan,
      answer_save_status: hasUnsavedAnswer ? 'unconfirmed' : hasAnswer ? 'saved' : 'none',
      can_retry_answer: hasUnsavedAnswer,
      error: request?.error ?? null,
      durability: 'durable',
    }
  }

  private inactiveEntryView(revision: number): WritingEntryView {
    return {
      expected: { project_revision: revision, request_id: null, attempt_id: null, stop_id: null, plan_version: null },
      phase: 'inactive',
      owner_session_id: null,
      request_state: null,
      continuation: null,
      processing_state: null,
      has_answer: false,
      has_plan: false,
      answer_save_status: 'none',
      can_retry_answer: false,
      error: null,
      durability: 'durable',
    }
  }

  /** 发布 S5 入口摘要到主会话。 */
  private async publishWritingEntryView(session: Session): Promise<void> {
    if (!this.isContextActive() || !isBidMainSession(session)) return
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
    const state = await readBidProjectState(workspace)
    const revision = state?.revision ?? 0
    await this.broadcastWritingEntryView(workspace, task, revision, [session])
    await this.ctx.sessions.flush(session)
    this.steerMainAgentForFailure(session)
  }

  /**
   * Start S5 with a Host-generated plan that contains no user requirements.
   * @param session - live Bid Session waiting before chapter writing.
   * @returns the state reached through the existing confirmed-stage orchestrator.
   */
  @Remote('autoStartChapterWriting')
  async autoStartChapterWriting(session: Session): Promise<BidChapterWritingGateResult> {
    if (!isBidMainSession(session)) {
      return chapterWritingGateResult({ ok: false, code: 'BID_SESSION_REQUIRED', message: 'Automatic chapter writing requires a Bid Session with a Host workspace.' })
    }
    const key = projectKey(session)
    const active = this.inFlight.get(key)
    if (active?.interaction === true) {
      await active.done
      return this.autoStartChapterWriting(session)
    }
    if (active !== undefined) {
      return chapterWritingGateResult({ ok: false, code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' })
    }
    const operation = this.beginOperation(session)
    try {
      const task = await this.prepareOperation(operation)
      if (!getBidClientProjection(task).allowedActions.includes('auto_start_chapter_writing')) {
        return chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_NOT_ALLOWED', message: 'Automatic chapter writing is not allowed in the current Bid stage state.' })
      }
      if (this.writingEntryStops.has(key)) {
        return chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: 'S5 启动前流程已停止，不能自动开始。' })
      }
      const stop = await readWritingEntryStop(operation.workspace)
      if (stop !== undefined) {
        return chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: 'S5 启动前流程已停止，不能自动开始。' })
      }
      const writingRequest = await readWritingRequest(operation.workspace)
      if (writingRequest !== undefined && writingRequest.state !== 'consumed') {
        return chapterWritingGateResult({
          ok: false,
          code: 'BID_CHAPTER_WRITING_GATE_FAILED',
          message: writingRequest.state === 'awaiting_answer'
            ? '已有待回答的写作要求提问，不能直接自动开始。'
            : writingRequest.state === 'answered'
              ? '已有自定义写作要求待处理，请先提交其 Writing Plan。'
              : '初始写作提问已被关闭，如需开始请重新提出要求或提交写作计划。',
        })
      }
      const agent = await this.executionAgent(operation, task.stage)
      const current = await confirmedOutline(operation.workspace)
      const plan = createAutomaticWritingPlan(current.outline, current.sha256)
      const issues = validateWritingPlan(plan, current.outline)
      if (issues.length > 0) {
        return chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: 'The automatic writing plan is invalid.' })
      }
      const planPath = within(operation.workspace.projectRoot, WRITING_PLAN_PATH)
      await assertNoLinkedPath(operation.workspace.root, planPath)
      const ready: BidTaskState = { stage: 'chapter_writing', status: 'ready', run: null }
      await this.mutateProject(operation, lease => lease.writeJson(planPath, plan), {
        ...ready,
      })
      session.append('bid.task.changed', { state: ready })
      const next = await this.automaticOrchestrator(agent, operation.workspace, operation.controller.signal, operation).runConfirmedStage()
      await this.ctx.sessions.flush(session)
      void this.publishWritingEntryView(session).catch((error: unknown) => {
        this.ctx.logger.warn(`Bid S5 入口摘要发布失败：${String(error)}`)
      })
      return chapterWritingGateResult({ ok: true, value: next })
    } catch {
      return chapterWritingGateResult({ ok: false, code: 'BID_CHAPTER_WRITING_GATE_FAILED', message: 'The Bid Host could not start automatic chapter writing.' })
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  private discardActiveWritingPlanProcessing(key: BidProjectKey): void {
    const processing = this.processingWritingPlans.get(key)
    if (processing !== undefined) {
      this.discardWritingPlanMessage(processing)
      this.processingWritingPlans.delete(key)
    }
  }

  /** 统一用户停止处理：覆盖运行中 Run、在线提问以及已回答但尚未启动写作的窗口。 */
  private handleUserStop(session: Session): Promise<void> {
    if (!isBidMainSession(session)) return Promise.resolve()
    const key = projectKey(session)
    const task = bidSessionTaskState(session)
    if (task.status === 'suspended') this.pendingCapabilityInputControllers.get(task.run.runId)?.abort(new Error('BID_CAPABILITY_USER_STOP'))
    this.cancelRunDecisions(session)
    const existing = this.writingEntryStops.get(key)
    if (existing?.state === 'pending') {
      return existing.done
    }
    const token = {}
    const { promise: done, resolve, reject } = Promise.withResolvers<void>()
    const barrier: { readonly token: object; readonly done: Promise<void>; state: 'pending' | 'failed'; error?: Error } = {
      token,
      done,
      state: 'pending',
    }
    this.writingEntryStops.set(key, barrier)

    this.invalidateWritingQuestion(key)
    this.discardActiveWritingPlanProcessing(key)

    const operation = this.inFlight.get(key)
    if (operation?.runs.current !== undefined) {
      operation.suspension ??= operation.runs.suspend('user_stop').catch((error: unknown) => {
        this.ctx.logger.warn(`Bid Run 停止收敛失败：${String(error)}`)
      })
    } else if (operation !== undefined) {
      operation.controller.abort({ kind: 'hook', reason: 'bid-run-user-stop' })
    }

    void this.persistWritingEntryStop(session, key, token).then(
      () => {
        if (this.writingEntryStops.get(key)?.token === token) {
          this.writingEntryStops.delete(key)
        }
        resolve()
      },
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error))
        if (this.writingEntryStops.get(key)?.token === token) {
          barrier.state = 'failed'
          barrier.error = err
        }
        this.ctx.logger.error(`Bid 停止状态未能保存，本进程已阻止启动：${err.message}`)
        reject(err)
      },
    )

    return done
  }

  private async persistWritingEntryStop(session: Session, key: BidProjectKey, token: object): Promise<void> {
    assertBidMainSession(session)
    while (true) {
      const active = this.inFlight.get(key)
      if (active === undefined) break
      await active.done
    }

    if (this.writingEntryStops.get(key)?.token !== token) return

    const operation = this.beginOperation(session)
    try {
      await this.prepareOperation(operation)
      const task = bidSessionTaskState(session)

      // 4. 若已经处于 suspended Run：不写入口停止记录，保留现有 Run 恢复链路
      if (task.status === 'suspended') {
        if (task.run.cause !== 'user_stop') {
          const { error, ...run } = task.run
          session.append('bid.task.changed', { state: { ...task, run: { ...run, cause: 'user_stop', updatedAt: Date.now(),
            ...(error === undefined ? {} : { error }) } } })
          await this.ctx.sessions.flush(session)
        }
        return
      }

      // 5. 若不在 chapter_writing，或不是 waiting_user/pending：不写入口停止记录
      if (task.stage !== 'chapter_writing' || task.status !== 'waiting_user') {
        return
      }

      // 6. 在锁内重新读取 confirmed outline、当前有效计划、当前问答
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const { sha256 } = await confirmedOutline(workspace)
      const currentPlan = await readCurrentWritingPlan(workspace, sha256)
      const writingRequest = await readWritingRequest(workspace)

      // 7. 对当前有效 native request 处理
      let updatedRequest: WritingRequest | undefined = undefined
      if (writingRequest !== undefined && writingRequest.confirmed_outline_sha256 === sha256) {
        const nextAttempt = randomUUID()
        if (writingRequest.state === 'awaiting_answer') {
          updatedRequest = {
            ...writingRequest,
            state: 'dismissed',
            attempt_id: nextAttempt,
            continuation: 'paused',
            processing: undefined,
            processing_message_id: undefined,
          }
        } else if (writingRequest.state === 'answered' || writingRequest.state === 'consumed') {
          updatedRequest = {
            ...writingRequest,
            attempt_id: nextAttempt,
            continuation: 'paused',
            processing: undefined,
            processing_message_id: undefined,
          }
        } else {
          updatedRequest = writingRequest
        }
      }

      // 8. 构造 WritingEntryStop
      const stopRecord: WritingEntryStop = {
        stop_id: randomUUID(),
        confirmed_outline_sha256: sha256,
        request_id: updatedRequest?.request_id ?? null,
        attempt_id: updatedRequest?.attempt_id ?? null,
        plan_version: currentPlan?.plan_version ?? null,
      }

      // 9. 用一次 mutateProject 同批写入 native request（若有）与 writing-entry-stop.json
      await this.mutateProject(operation, async (lease) => {
        if (updatedRequest !== undefined) {
          await writeWritingRequest(workspace, updatedRequest, lease)
        }
        await writeWritingEntryStop(workspace, stopRecord, lease)
      })
      await this.ctx.sessions.flush(session)
      void this.publishWritingEntryView(session).catch((error: unknown) => {
        this.ctx.logger.warn(`Bid S5 入口摘要发布失败：${String(error)}`)
      })
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /** 串行化安全 helper：先等停止屏障完成，再获取同一把项目锁。 */
  private async withWritingEntryOperation<T>(
    session: Session,
    callback: (operation: ActiveBidOperation, workspace: BidWorkspace) => Promise<T>,
  ): Promise<T> {
    assertBidMainSession(session)
    const key = projectKey(session)
    const barrier = this.writingEntryStops.get(key)
    if (barrier !== undefined) {
      if (barrier.state === 'failed') {
        throw new Error(`BID_WRITING_ENTRY_STOPPED: 停止状态未能保存，本进程已阻止操作 (${barrier.error?.message ?? 'unknown error'})`)
      }
      await barrier.done
    }
    while (true) {
      const active = this.inFlight.get(key)
      if (active === undefined) break
      await active.done
    }
    const operation = this.beginOperation(session)
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    try {
      await this.prepareOperation(operation)
      return await callback(operation, workspace)
    } finally {
      await this.finishOperation(session, operation, false)
    }
  }

  /**
   * 停止当前会话回复及项目后台 Run，保留待处理的用户消息。
   * @param session 发起停止的 Bid 主会话。
   * @returns 后台任务停止并保存状态后确认接受。
   */
  @Remote('stopRun')
  async stopRun(session: Session): Promise<{ accepted: true }> {
    if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
    this.ctx.agents.get(session.id)?.cancel({ kind: 'user' }, { keepInbox: true })
    await this.handleUserStop(session)
    return { accepted: true }
  }

  /**
   * Import and validate one browser-selected file batch for the current Bid stage.
   * @param session - Host-resolved live Session; only its header supplies workspace identity.
   * @param files - Browser file metadata and canonical base64 bytes.
   * @returns the next runtime state or one stable business rejection.
   */
  @Remote('uploadFiles')
  async uploadFiles(session: Session, files: readonly BidUploadFile[]): Promise<BidFileIntakeResult> {
    let decoded: DecodedUploadBatch
    try {
      decoded = decodeUploadFiles(files, this.config)
    } catch (error) {
      return intakeError(error)
    }
    return this.uploadIncomingFiles(session, decoded.incoming, decoded.failures)
  }

  /**
   * Run the common S1 admission, persistence, manifest validation, and stage transition for raw bytes.
   * @param session - live Session selected by the browser transport.
   * @param incoming - every decoded selected file in request order.
   * @param failures - file-level transport decode failures retained for an S1 failure.
   * @returns the durable S1 outcome.
   */
  async uploadIncomingFiles(
    session: Session,
    incoming: readonly IncomingFile[],
    failures: readonly BidFileIntakeFileResult[] = [],
  ): Promise<BidFileIntakeResult> {
    if (!isBidMainSession(session)) {
      return intakeRejected('BID_SESSION_REQUIRED', 'File intake requires a Bid Session with a Host workspace.')
    }
    if (this.inFlight.has(projectKey(session))) {
      return intakeRejected('BID_OPERATION_IN_PROGRESS', 'A file-intake operation is already running for this Bid Session.')
    }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('upload_files')) {
        return intakeRejected('BID_FILE_INTAKE_NOT_ALLOWED', 'File intake is not allowed in the current Bid stage state.')
      }

      if (incoming.length === 0) {
        const failure = failures[0]?.error
        return intakeRejected(
          (failure?.code as BidFileIntakeErrorCode | undefined) ?? 'BID_FILE_INTAKE_FAILED',
          failure?.message ?? 'No selected file could be imported.',
          failures,
        )
      }
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const agent = await this.executionAgent(operation, runtime.stage)
      validateBidFileBatch(incoming, workspace.config)
      const intakeWork = await persistFileIntakeWork(workspace, incoming)
      let imported: ImportedFile[] = []
      const orchestrator = this.automaticOrchestrator(agent, workspace, operation.controller.signal, operation, {
        incoming,
        failures,
        work: intakeWork,
        onImported: (files) => { imported = files },
      })
      await orchestrator.runCurrentProgramStage()
      const next = await orchestrator.drive()
      await this.ctx.sessions.flush(session)
      const fileResults: BidFileIntakeFileResult[] = [
        ...failures,
        ...imported.map((file): BidFileIntakeFileResult => file.parseStatus === 'success'
          ? { name: file.originalName, role: file.role, status: 'completed' }
          : {
            name: file.originalName,
            role: file.role,
            status: 'failed',
            error: {
              code: file.parseStatus === 'needs_ocr' ? 'BID_FILE_NEEDS_OCR' : 'BID_FILE_PARSE_FAILED',
              message: file.parseError ?? 'The file could not be parsed.',
            },
          }),
      ]
      const hasFailedFile = fileResults.some(file => file.status === 'failed')
      if (next.status === 'failed') {
        if (next.stage === 'file_intake') {
          return intakeRejected(
            'BID_FILE_INTAKE_FAILED',
            next.failure.message,
            fileResults,
          )
        }
        return intakeSuccess(next, hasFailedFile ? fileResults : undefined)
      }
      return intakeSuccess(next, hasFailedFile ? fileResults : undefined)
    } catch (error: unknown) {
      if (error instanceof BidOrchestratorError) {
        if (error.code === 'BID_OPERATION_IN_PROGRESS') {
          return intakeRejected('BID_OPERATION_IN_PROGRESS', error.message)
        }
        return intakeRejected('BID_FILE_INTAKE_NOT_ALLOWED', error.message)
      }
      return intakeError(error)
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /** Serve the same-origin binary S1 endpoint without base64 expanding browser files. */
  private async handleBinaryUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedBidUploadRequest(req, this.config.trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const sessionHeader = req.headers[BID_UPLOAD_SESSION_HEADER]
    const filesHeader = req.headers[BID_UPLOAD_FILES_HEADER]
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined
    const metadata = typeof filesHeader === 'string' ? filesHeader : undefined
    const session = sessionId === undefined ? undefined : this.ctx.sessions.get(SessionId(sessionId))
    let result: BidFileIntakeResult
    try {
      if (session === undefined || !isBidMainSession(session) || metadata === undefined) throw new Error('bid-invalid-file-data')
      const files = parseBinaryUploadFiles(decodeURIComponent(metadata))
      const incoming = await readBinaryUpload(req, files, this.config)
      result = await this.uploadIncomingFiles(session, incoming)
    } catch (error) {
      result = session === undefined || !isBidMainSession(session)
        ? intakeError(error)
        : await this.recordBinaryUploadFailure(session, error)
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  }

  /** Receive one bounded DOCX template as a same-origin binary request. */
  private async handleDocxTemplateUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedBidUploadRequest(req, this.config.trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let result: DocxTemplateUploadResult
    try {
      const sessionHeader = req.headers[BID_UPLOAD_SESSION_HEADER]
      const nameHeader = req.headers[DOCX_TEMPLATE_NAME_HEADER]
      const sizeHeader = req.headers[DOCX_TEMPLATE_SIZE_HEADER]
      const revisionHeader = req.headers[DOCX_TEMPLATE_REVISION_HEADER]
      if (typeof sessionHeader !== 'string' || typeof nameHeader !== 'string'
        || typeof sizeHeader !== 'string' || typeof revisionHeader !== 'string'
        || !/^[1-9]\d*$/u.test(sizeHeader) || !/^\d+$/u.test(revisionHeader)) {
        throw new Error('Word 模板上传请求无效。')
      }
      const size = Number(sizeHeader)
      const revision = Number(revisionHeader)
      if (!Number.isSafeInteger(size) || size > this.config.docxTemplateMaxBytes) {
        throw new Error(`模板文件不能超过 ${String(Math.floor(this.config.docxTemplateMaxBytes / 1024 / 1024))} MiB。`)
      }
      if (!Number.isSafeInteger(revision)) throw new Error('Word 模板上传请求无效。')
      const session = this.ctx.sessions.get(SessionId(sessionHeader))
      if (session === undefined || !isBidMainSession(session)) {
        throw new Error('Word 模板需要标书项目会话。')
      }
      const bytes = await readExactRequestBody(req, size, 'DOCX 模板内容与声明大小不一致。')
      result = await this.withDocxOperation<DocxTemplateUploadResult>(session, async (workspace) => {
        let view = await saveDocxTemplate(workspace, {
          revision,
          name: decodeURIComponent(nameHeader),
          bytes,
        })
        const interpretation = view.state.modelInterpreted
        if (view.library.revision === revision && (Object.keys(interpretation.values).length > 0
          || Object.keys(interpretation.mapping).length > 0 || interpretation.evidence.length > 0)) {
          return { ok: true, value: view }
        }
        let suggestion: DocxFormatSuggestion
        try {
          suggestion = await suggestDocxFormat(
            this.ctx,
            session,
            view,
            AbortSignal.timeout(this.config.wordFormatTimeoutMs),
            this.config.wordFormatMaxTokens,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : '未知错误。'
          return {
            ok: true,
            value: {
              ...view,
              warnings: [...view.warnings, `模板解析完成；自动格式解释未应用（${reason}），可重新上传模板重试。`],
            },
          }
        }
        if (view.templateId === null) throw new Error('模板上传未返回模板 ID。')
        view = await saveDocxFormatInterpretation(workspace, view.templateId, view.state.revision, suggestion)
        return { ok: true, value: view }
      })
    } catch (error) {
      result = docxTemplateUploadFailure(error)
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  }

  /** Record an S1 failure when a selected binary upload cannot be fully reconstructed. */
  private async recordBinaryUploadFailure(session: Session, error: unknown): Promise<BidFileIntakeResult> {
    if (!isBidMainSession(session)) return intakeError(error)
    if (this.inFlight.has(projectKey(session))) return intakeRejected('BID_OPERATION_IN_PROGRESS', 'A file-intake operation is already running for this Bid Session.')
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('upload_files')) {
        return intakeRejected('BID_FILE_INTAKE_NOT_ALLOWED', 'File intake is not allowed in the current Bid stage state.')
      }
      const failure = intakeFailure(error)
      return intakeRejected('BID_FILE_INTAKE_FAILED', failure.message)
    } catch (caught) {
      return intakeError(caught)
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /**
   * 公开工具在运行期保存排队请求；空闲时持久接纳并启动后台执行。
   * @param agent 当前公开主 Agent。
   * @param task 已解析的能力计划。
   * @returns 接纳、排队或正式发布状态。
   */
  private async runCapabilityTaskFromTool(
    agent: Agent, task: BidCapabilityTask, supersede?: CapabilitySupersede,
  ): Promise<unknown> {
    validateCapabilityTaskContentFollowup(task)
    const session = agent.session
    assertBidMainSession(session)
    const authorization = resolveBidToolAuthorization(agent)
    if (authorization === undefined) throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
    const first = task.steps[0]
    if (first === undefined) throw new Error('BID_CAPABILITY_EMPTY_TASK')
    const exportStep = this.capabilityExportStep(task)
    const key = projectKey(session)
    const active = this.inFlight.get(key)
    const currentRun = active?.runs.current
    if (active !== undefined && currentRun !== undefined) {
      if (supersede !== undefined) throw new Error('BID_CAPABILITY_SUPERSEDE_NOT_SUSPENDED')
      const queued = await enqueueCapabilityRequest(active.workspace, currentRun, task, authorization,
        await freezeBidTaskSource(active.workspace, session, task, authorization))
      return { accepted: true, queued: true, execution_status: 'queued', completed: false, ...queued,
        message: '能力任务已在当前 Work 命令日志登记；当前 Run 收敛后按顺序执行。' }
    }
    if (active !== undefined) await active.done
    if (supersede !== undefined && bidEvidenceMappingTakeoverRun(session, bidSessionTaskState(session)) !== undefined) {
      const admitted = Promise.withResolvers<BidRunContext>()
      const completed = this.runEvidenceMappingTakeover(agent, task, authorization, supersede,
        (run) => { admitted.resolve(run) }).then(state => ({
        accepted: true, queued: false, execution_status: state.status, completed: false, state,
      }))
      const outcome = await Promise.race([completed, admitted.promise.then(run => ({
        accepted: true, queued: false, execution_status: 'started', completed: false,
        work_id: run.work.workId, state: bidSessionTaskState(session),
      }))])
      void completed.catch((error: unknown) => {
        this.ctx.logger.warn(`S4 新授权补修结算失败：${sanitizeBidErrorText(String(error))}`)
      })
      return outcome
    }
    const executionTask = exportStep === null ? task : { ...task, steps: task.steps.slice(0, -1) }
    if (supersede !== undefined && executionTask.steps.length === 0) {
      throw new Error('BID_CAPABILITY_SUPERSEDE_REQUIRES_WORK')
    }
    const inputs = BID_CAPABILITIES[first.call.capability].requires
    if (executionTask.steps.length > 0) {
      const admitted = Promise.withResolvers<BidRunContext>()
      const completed = this.runCapabilityTask(agent, executionTask, authorization, inputs,
        (run) => { admitted.resolve(run); return Promise.resolve() }, supersede, task).then(async (state) => {
        if (state.status !== 'failed' && state.status !== 'suspended') {
          const work = await findCapabilityTaskRequest(new BidWorkspace(key, workspaceConfig(this.config)), authorization)
          if (work === null) throw new Error('BID_CAPABILITY_TASK_REQUEST_MISSING')
          await this.continueCapabilityExport(session, work.workId)
        }
        return { accepted: true, queued: false, execution_status: state.status,
          completed: false, state }
      })
      const outcome = await Promise.race([completed, admitted.promise.then(run => ({
        accepted: true, queued: false, execution_status: 'started', completed: false,
        work_id: run.work.workId, state: bidSessionTaskState(session),
      }))])
      void completed.catch((error: unknown) => {
        this.ctx.logger.warn(`Bid 能力后台结算失败：${sanitizeBidErrorText(String(error))}`)
      })
      return outcome
    }
    const state = bidSessionTaskState(session)
    if (state.status === 'failed' || state.status === 'suspended') {
      return { accepted: true, queued: false, execution_status: state.status, completed: false, state }
    }
    const exported = exportStep === null ? null : await this.exportDocxWithIdentity(session,
      exportStep.input.template_id as DocxTemplateId | null,
      this.capabilityExportIdentity(authorization, exportStep.input.template_id))
    if (exported !== null && !exported.ok) return { accepted: true, queued: false, completed: false,
      goal_met: false, execution_status: 'failed', content_published: false,
      export_error: exported.error, state }
    return { accepted: true, queued: false,
      execution_status: 'completed', completed: true, goal_met: true, state,
      export_path: exported?.ok ? exported.value.path : null }
  }

  /** 新的直接用户任务接管结构失败候选；旧 Work 身份、检查点与预算独立保留。 */
  private async runEvidenceMappingTakeover(
    agent: Agent, task: BidCapabilityTask, authorization: CapabilityTaskRequest['authorization'],
    supersede: CapabilitySupersede, onAdmitted: (run: BidRunContext) => void,
  ): Promise<BidTaskState> {
    const session = agent.session
    if (this.ctx.agents.get(session.id) !== agent) throw new Error('BID_CAPABILITY_DISPATCHER_UNAVAILABLE')
    const operation = this.beginOperation(session)
    let admitted = false
    try {
      const current = await this.prepareOperation(operation)
      const previous = bidEvidenceMappingTakeoverRun(session, current)
      if (previous === undefined || current.status !== 'failed') throw new Error('BID_S4_SUPERSEDE_NOT_ALLOWED')
      if (previous.runId !== supersede.run_id || operation.projectRevision !== supersede.expected_project_revision) {
        throw new Error('BID_CAPABILITY_SUPERSEDE_STALE')
      }
      const authorized = resolveBidToolAuthorization(agent)
      const message = session.events.findLast(event => event.type === 'user/message'
        && String(event.data.id) === authorization.message_id)
      const failure = session.events.findLast(event => event.type === 'bid.run.notice'
        && event.data.noticeId === `run:${previous.runId}:failed`)
      if (authorized?.session_id !== String(session.id) || authorized.message_id !== authorization.message_id
        || message?.type !== 'user/message' || message.data.source.kind !== 'user'
        || failure === undefined || message.seq <= failure.seq) throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
      const text = message.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
      if (text === '') throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
      const selected = bidCapabilityTaskSchema.parse(task)
      const instruction = evidenceMappingTakeoverInstruction(selected, text)
      const work = await prepareEvidenceMappingTakeover(operation.workspace, previous, selected, authorization, current, instruction)
      const execution = await this.executionAgent(operation, 'evidence_mapping')
      let run: BidRunContext
      try { run = await operation.runs.start(work) } catch (error) {
        if (bidSessionTaskState(session).status !== current.status) {
          session.append('bid.task.changed', { state: current })
          await this.ctx.sessions.flush(session)
        }
        throw error
      }
      admitted = true
      const unit = current.failure.recovery?.unit ?? 'outline/quality-report.json'
      const execute = async (): Promise<void> => {
        const acceptedRecovery = session.append('bid.recovery.requested', {
          ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: run.runId },
          unit, instruction, progressFingerprint: bidRecoveryFingerprint(work, current.failure, previous.progress),
        })
        operation.recovery = { workId: work.workId, ownerSessionId: String(session.id), requestSeq: acceptedRecovery.seq,
          unit, instruction, issues: current.failure.issues ?? [] }
        this.cancelRunDecisions(session)
        session.append('bid.run.notice', { noticeId: `run:${previous.runId}:superseded`, supersedesTurn: null,
          runId: previous.runId, stage: 'evidence_mapping', kind: 'stopped', severity: 'info',
          message: '已按新的直接用户授权接纳独立目录补修任务；原失败候选、检查点和恢复预算已保留。' })
        await this.ctx.sessions.flush(session)
        onAdmitted(run)
        await run.activities.track(() => executeEvidenceMappingTakeoverCandidate(
          execution, operation.workspace, run, this.config, operation.recovery,
        ))
        await operation.runs.complete(run, () => {
          session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
        })
      }
      try { await execute() } catch (error: unknown) {
        if (operation.runs.current === run) {
          const failure = safeRecoverableBidFailure(work, error)
          await operation.runs.suspend(run.signal.aborted ? 'user_stop'
            : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure)
        }
      }
      return bidSessionTaskState(session)
    } finally { await this.finishOperation(session, operation, admitted) }
  }

  /** 已发布内容只续稳定身份的导出尾效果；正式结算与通知均在独立导出之后。 */
  private async continueCapabilityExport(session: Session, workId: string): Promise<boolean> {
    if (!this.isContextActive()) return false
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const work = await readBidWorkDescriptor(workspace, workId)
    if (work?.kind !== 'capability_task') return true
    const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
    const working = new BidWorkspace(bidWorkRoot(workspace, work), workspace.config)
    const checkpoint = await readCapabilityTaskCheckpoint(workspace, working, { work }, request, session)
    const call = this.capabilityExportStep({ ...request.task,
      steps: checkpoint?.steps.map(record => record.step) ?? (request.complete_task ?? request.task).steps })
    if (call === null) return true
    const receipt = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
    if (receipt === null) return false
    if (receipt.goal_met === true) return true
    if (!this.isContextActive()) return false
    const identity = this.capabilityExportIdentity(request.authorization, call.input.template_id)
    const exported = await this.exportDocxWithIdentity(session, call.input.template_id as DocxTemplateId | null, identity)
    if (!exported.ok) return false
    while (true) {
      const active = this.inFlight.get(projectKey(session))
      if (active === undefined) break
      await active.done
    }
    if (!this.isContextActive()) return false
    const operation = this.beginOperation(session)
    try {
      const state = await this.prepareOperation(operation)
      const current = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
      if (current === null) throw new Error('BID_CAPABILITY_COMPLETED_RECEIPT_MISSING')
      if (!this.isContextActive()) return false
      if (current.goal_met !== true) {
        const path = within(workspace.projectRoot, exported.value.path)
        await assertNoLinkedPath(workspace.root, path)
        const bytes = await readFile(path)
        const completed = capabilityPublicationReceiptSchema.parse({ ...current, goal_met: true,
          export_receipt: { operation_id: identity, path: exported.value.path, sha256: createHash('sha256').update(bytes).digest('hex') } })
        await this.mutateProject(operation, async (lease) => {
          const queue = await readRevisionQueue(workspace)
          const frozen = request.source_snapshot
          const sources = (current.issue_results ?? []).map((result) => {
            const source = [...frozen?.issues ?? [], ...frozen?.observed_issues ?? []]
              .find(item => item.issue_id === result.issue_id)
            if (source === undefined) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
            return source
          })
          for (const source of sources) {
            const issue = queue.issues.find(item => item.issue_id === source.issue_id)
            if (issue === undefined || JSON.stringify([issue.section_id, issue.scope, issue.instruction, issue.suggestion, issue.reference])
              !== JSON.stringify([source.section_id, source.scope, source.instruction, source.suggestion, source.reference])) throw new Error('BID_TASK_SOURCE_ISSUE_CHANGED')
          }
          if (sources.length > 0) await lease.writeJson(within(workspace.projectRoot, 'chapters/revisions/queue.json'), {
            ...queue, revision: queue.revision + 1,
            issues: queue.issues.map(issue => sources.some(source => source.issue_id === issue.issue_id)
              ? { ...issue, status: 'completed',
                batch_id: current.issue_results?.find(result => result.issue_id === issue.issue_id)?.batch_id ?? null,
                updated_at: Date.now() } : issue),
          })
          await lease.writeJson(within(workspace.projectRoot, 'requests/' + work.workId + '/result.json'), completed)
        }, state)
      }
      const event = session.events.findLast(item => item.type === 'bid.run.completed' && item.data.run.work.workId === workId)
      if (event?.type === 'bid.run.completed') {
        const published = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
        if (published === null) throw new Error('BID_CAPABILITY_COMPLETED_RECEIPT_MISSING')
        this.appendCapabilityCompletionNotice(session, event.data.run, published,
          '内容已发布，Word 已导出至 ' + exported.value.path + '；')
      }
      await this.ctx.sessions.flush(session)
      return true
    } finally { await this.finishOperation(session, operation) }
  }

  /** 导出只能作为任务的最后一步，由独立导出操作读取已提交正文。 */
  private capabilityExportStep(task: BidCapabilityTask): Extract<BidCapabilityTask['steps'][number]['call'],
    { capability: 'docx.export' }> | null {
    const positions = task.steps.flatMap((step, index) => step.call.capability === 'docx.export' ? [index] : [])
    if (positions.length === 0) return null
    if (positions.length !== 1 || positions[0] !== task.steps.length - 1) {
      throw new Error('BID_CAPABILITY_EXPORT_MUST_BE_LAST_STEP')
    }
    const call = task.steps.at(-1)?.call
    if (call?.capability !== 'docx.export') throw new Error('BID_CAPABILITY_EXPORT_MISSING')
    return call
  }

  private capabilityExportIdentity(
    authorization: CapabilityTaskRequest['authorization'], templateId: string | null,
  ): string {
    return createHash('sha256').update(`${authorization.session_id}\0${authorization.message_id}\0docx.export\0${templateId ?? 'default'}`)
      .digest('hex').slice(0, 32)
  }

  /** 当前 Work 收敛后只消费登记过的请求，后续步骤取得独立 Run。 */
  private async drainQueuedCapabilityRequests(session: Session, originWorkId: string): Promise<void> {
    if (!this.isContextActive() || !isBidMainSession(session)) return
    const key = projectKey(session)
    const workspace = new BidWorkspace(key, workspaceConfig(this.config))
    for (const pending of await readPendingCapabilityRequests(workspace, originWorkId)) {
      if (!this.isContextActive() || this.inFlight.has(key)) return
      const state = await readBidProjectState(workspace)
      if (state === undefined || state.status === 'running' || state.status === 'suspended'
        || state.status === 'failed') return
      const agent = this.ctx.agents.get(session.id)
      if (agent?.session !== session || pending.request.authorization.session_id !== String(session.id)) return
      const checkpointPath = within(workspace.projectRoot, `runs/${originWorkId}/task-checkpoint.json`)
      await assertNoLinkedPath(workspace.root, checkpointPath)
      let checkpoint: ReturnType<typeof capabilityTaskCheckpointSchema.parse> | undefined
      try { checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8'))) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!this.isContextActive()) return
      if (checkpoint !== undefined && checkpoint.work_id !== originWorkId) throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
      if (checkpoint?.plan_patches.some(patch => patch.authorization.session_id === pending.request.authorization.session_id
        && patch.authorization.message_id === pending.request.authorization.message_id)) {
        const operation = this.beginOperation(session)
        try {
          const current = await this.prepareOperation(operation)
          await this.mutateProject(operation, async (lease) => {
            await cancelCapabilityRequestsForPlanPatch(workspace, originWorkId, pending.request.authorization, lease)
          }, current)
        } finally { await this.finishOperation(session, operation) }
        continue
      }
      const first = pending.request.task.steps[0]
      if (first === undefined) throw new Error('BID_CAPABILITY_QUEUE_EMPTY_TASK')
      const exportStep = this.capabilityExportStep(pending.request.task)
      const executionTask = exportStep === null ? pending.request.task
        : { ...pending.request.task, steps: pending.request.task.steps.slice(0, -1) }
      const inputs = BID_CAPABILITIES[first.call.capability].requires
      const existing = executionTask.steps.length === 0 ? null
        : await findCapabilityTaskRequest(workspace, pending.request.authorization)
      if (!this.isContextActive()) return
      if (existing !== null) {
        const started = session.events.some(event => event.type === 'bid.run.started'
          && event.data.run.work.workId === existing.workId)
        if (started) {
          const completed = session.events.some(event => event.type === 'bid.run.completed'
            && event.data.run.work.workId === existing.workId)
          if (!completed) return
          const receipt = await readCapabilityPublicationRecord(workspace, existing.workId, existing.requestSha256)
          if (receipt?.goal_met !== false) {
            await this.acknowledgeQueuedCapability(session, workspace, originWorkId, pending.recordId)
            continue
          }
        }
      }
      if (executionTask.steps.length > 0 && (existing === null || !session.events.some(event =>
        event.type === 'bid.run.completed' && event.data.run.work.workId === existing.workId))) {
        const outcome = await this.runCapabilityTask(agent, executionTask, pending.request.authorization, inputs,
          exportStep === null ? run => markCapabilityRequestApplied(workspace, originWorkId, pending.recordId, run)
            : undefined, undefined, pending.request.task)
        if (outcome.status === 'suspended' || outcome.status === 'failed') return
      }
      const contentWork = await findCapabilityTaskRequest(workspace, pending.request.authorization)
      if (!this.isContextActive()) return
      if (contentWork !== null) {
        if (!await this.continueCapabilityExport(session, contentWork.workId)) return
        await this.acknowledgeQueuedCapability(session, workspace, originWorkId, pending.recordId)
      } else if (exportStep !== null) {
        const exported = await this.exportDocxWithIdentity(session,
          exportStep.input.template_id as DocxTemplateId | null,
          this.capabilityExportIdentity(pending.request.authorization, exportStep.input.template_id))
        if (!exported.ok) return
        await this.acknowledgeQueuedCapability(session, workspace, originWorkId, pending.recordId)
      }
    }
  }

  private async acknowledgeQueuedCapability(
    session: Session, workspace: BidWorkspace, originWorkId: string, recordId: string,
  ): Promise<void> {
    if (!this.isContextActive()) return
    const operation = this.beginOperation(session)
    try {
      const current = await this.prepareOperation(operation)
      if (!this.isContextActive()) return
      await this.mutateProject(operation, lease => withBidCommandJournalLock(workspace, originWorkId,
        () => markCapabilityRequestAppliedWithLease(workspace, originWorkId, recordId, lease)), current)
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /** 在项目空闲边界按持久命令日志恢复队列；同一项目只运行一个调度器。 */
  private async drainPersistedCapabilityRequests(session: Session): Promise<void> {
    if (!this.isContextActive() || !isBidMainSession(session)) return
    const key = projectKey(session)
    const started = session.events.findLast(event => event.type === 'bid.run.started')
    if (started?.type === 'bid.run.started' && started.data.run.work.kind === 'capability_task') {
      const work = started.data.run.work
      const workspace = new BidWorkspace(key, workspaceConfig(this.config))
      const receipt = await readCapabilityPublicationRecord(workspace, work.workId, work.requestSha256)
      if (receipt?.goal_met === false) return
    }
    if (!this.isContextActive()) return
    if (this.queuedDrains.has(key)) {
      this.queuedDrainRequested.add(key)
      return
    }
    this.queuedDrains.add(key)
    try {
      do {
        this.queuedDrainRequested.delete(key)
        if (!this.isContextActive() || this.inFlight.has(key)) return
        const workspace = new BidWorkspace(key, workspaceConfig(this.config))
        for (const workId of await pendingCapabilityWorkIds(workspace)) {
          await this.drainQueuedCapabilityRequests(session, workId)
          if (this.inFlight.has(key)) return
        }
      } while (this.queuedDrainRequested.has(key))
    } finally {
      this.queuedDrains.delete(key)
    }
  }

  /**
   * 接纳一个由真实用户消息授权的能力序列。
   * @param agent 公开主会话的 Agent。
   * @param task 有序能力步骤与任务范围。
   * @param authorization 用户消息身份。
   * @param inputPaths 本次任务读取的正式输入文件。
   * @param onAdmitted Run 落盘后调用的可选接纳回调。
   * @param supersede 精确接管当前挂起或失败能力任务的 Run 身份与项目修订号。
   * @param completeTask 含独立导出尾步骤的完整任务。
   * @returns Run 结算后的项目状态。
   */
  async runCapabilityTask(
    agent: Agent, task: BidCapabilityTask,
    authorization: CapabilityTaskRequest['authorization'], inputPaths: readonly string[],
    onAdmitted?: (run: BidRunContext) => Promise<void>,
    supersede?: CapabilitySupersede, completeTask?: BidCapabilityTask,
  ): Promise<BidTaskState> {
    const session = agent.session
    assertBidMainSession(session)
    if (this.ctx.agents.get(session.id) !== agent) {
      throw new Error('BID_CAPABILITY_DISPATCHER_UNAVAILABLE')
    }
    const operation = this.beginOperation(session)
    let admitted = false
    try {
      const current = await this.prepareOperation(operation)
      let returnState: CapabilityTaskRequest['return_state']
      if (supersede === undefined) {
        if (current.status !== 'ready' && current.status !== 'waiting_user' && current.status !== 'completed') {
          throw new Error('BID_CAPABILITY_TASK_STATE_NOT_READY')
        }
        returnState = current
      } else {
        const previousRun = bidCapabilityTakeoverRun(session, current)
        if (previousRun === undefined) throw new Error('BID_CAPABILITY_SUPERSEDE_NOT_ALLOWED')
        if (previousRun.runId !== supersede.run_id
          || operation.projectRevision !== supersede.expected_project_revision) {
          throw new Error('BID_CAPABILITY_SUPERSEDE_STALE')
        }
        const authorized = resolveBidToolAuthorization(agent)
        const message = session.events.findLast(event => event.type === 'user/message'
          && String(event.data.id) === authorization.message_id)
        if (authorized?.session_id !== authorization.session_id
          || authorized.message_id !== authorization.message_id
          || message?.type !== 'user/message' || message.data.source.kind !== 'user') {
          throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
        }
        const previous = capabilityTaskRequestSchema.parse(await readBidWorkRequest(operation.workspace, previousRun.work))
        if (authorization.message_id === previous.authorization.message_id) {
          throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
        }
        returnState = previous.return_state
      }
      const selected = bidCapabilityTaskSchema.parse(task)
      const work = await persistCapabilityTaskRequest(operation.workspace, session, current.stage, selected,
        authorization, inputPaths, returnState, agent, completeTask)
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(operation.workspace, work))
      if (session.events.some(event => event.type === 'bid.run.completed'
        && event.data.run.work.workId === work.workId)) {
        if (await readCapabilityPublicationReceipt(operation.workspace, work.workId, work.requestSha256) === null) {
          throw new Error('BID_CAPABILITY_COMPLETED_RECEIPT_MISSING')
        }
        return current
      }
      const execution = await this.executionAgent(operation, current.stage)
      let run: BidRunContext
      try { run = await operation.runs.start(work) } catch (error) {
        if (supersede !== undefined && bidSessionTaskState(session).status !== current.status) {
          session.append('bid.task.changed', { state: current })
          await this.ctx.sessions.flush(session)
        }
        throw error
      }
      admitted = true
      if (supersede !== undefined) {
        this.cancelRunDecisions(session)
        session.append('bid.run.notice', {
          noticeId: `run:${supersede.run_id}:superseded`, supersedesTurn: null,
          runId: supersede.run_id, stage: current.stage, kind: 'stopped', severity: 'info',
          message: '旧能力任务已由新的用户任务替代；旧候选和 checkpoint 已保留，不再自动恢复。',
        })
        await this.ctx.sessions.flush(session)
      }
      if (onAdmitted !== undefined) {
        try { await onAdmitted(run) } catch (error: unknown) {
          if (operation.runs.current === run) {
            await operation.runs.suspend(run.signal.aborted ? 'user_stop' : 'executor_error', safeRecoverableBidFailure(run.work, error))
          }
          throw error
        }
      }
      return await this.executeAdmittedCapabilityTask(execution, operation, run, request)
    } finally {
      await this.finishOperation(session, operation, admitted)
    }
  }

  private async executeAdmittedCapabilityTask(
    agent: Agent, operation: ActiveBidOperation, run: BidRunContext, request: CapabilityTaskRequest,
  ): Promise<BidTaskState> {
    try {
      const dispatcher = this.capabilityTaskDispatcher ?? this.builtInCapabilityDispatcher
      const outcome = await run.activities.track(() => executeCapabilityTask(
        operation.workspace, run, dispatcher, agent, operation.session,
        operation.recovery?.workId === run.work.workId ? operation.recovery : undefined,
      ))
      if (outcome.status === 'awaiting_input') {
        await operation.runs.suspend('awaiting_input')
        return bidSessionTaskState(operation.session)
      }
      await operation.runs.complete(run, () => {
        if (outcome.receipt.goal_met === true) this.appendCapabilityCompletionNotice(operation.session, run, outcome.receipt,
          outcome.results.map(result => result.change_summary).join('；'))
        operation.session.append('bid.task.changed', { state: request.return_state })
      })
      return bidSessionTaskState(operation.session)
    } catch (error: unknown) {
      if (operation.runs.current === run) {
        const failure = safeRecoverableBidFailure(run.work, error)
        await operation.runs.suspend(run.signal.aborted ? 'user_stop'
          : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure)
      }
      return bidSessionTaskState(operation.session)
    }
  }

  private appendCapabilityCompletionNotice(session: Session, run: Pick<BidRunData, 'runId' | 'work'>,
    receipt: CapabilityPublicationReceipt, summary?: string): void {
    const workId = run.work.workId
    const noticeId = `work:${workId}:completed:${bidInputFingerprint(receipt)}`
    if (session.events.some(event => event.type === 'bid.run.notice' && event.data.noticeId === noticeId)) return
    const resultRef = `requests/${workId}/result.json`
    session.append('bid.run.notice', {
      noticeId, supersedesTurn: null, runId: run.runId, stage: run.work.stage,
      kind: 'completed', severity: 'info', workId, resultRef,
      message: '能力任务交付结果；' + (receipt.goal_met === true
        ? '本次任务范围内目标已通过核验并正式发布，goal_met=true；'
        : summary ?? '历史执行记录，未有本次任务核验证据；') + '结果凭据：' + resultRef,
    })
  }

  /**
   * Resume one exact suspended Run after checking its project revision and durable checkpoints.
   * @param session - Bid Session that owns the suspended Run.
   * @param suspendedRunId - Exact suspended attempt selected by the client.
   * @param expectedProjectRevision - Project revision observed by the client.
   * @param onAccepted - Callback invoked after the replacement Run is durable.
   * @param recovery - 主 Agent 修复指令，在项目锁内重验并记录。
   * @returns State reached when the resumed work next settles.
   */

  async resumeCurrentRun(
    session: Session,
    suspendedRunId: string,
    expectedProjectRevision: number,
    onAccepted?: (run: BidRunContext) => void,
    recovery?: { instruction: string },
  ): Promise<BidTaskState> {
    if (!isBidMainSession(session)) {
      throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', 'Resume requires a Bid Session with a Host workspace.')
    }
    if (this.inFlight.has(projectKey(session))) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', 'A Bid operation is already running for this Session.')
    }
    const expectedRecovery = recovery === undefined ? undefined : bidRunRecoveryEligibility(session, this.config.modelStageRepairAttempts)
    const operation = this.beginOperation(session)
    let admitted = false
    try {
      const task = await this.prepareOperation(operation)
      const suspended = bidRecoverableRun(session, task)
      if (operation.projectRevision !== expectedProjectRevision || suspended?.runId !== suspendedRunId
        || task.status !== 'suspended' && (recovery === undefined || task.status !== 'failed')) {
        throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', '原 Run 或项目状态已改变，不能恢复。')
      }
      if (suspended.work.kind === 'file_intake') await readFileIntakeWork(operation.workspace, suspended.work)
      else {
        const payload = await readHostWork(operation.workspace, suspended.work)
        if (suspended.work.kind === 'capability_task'
          && capabilityTaskRequestSchema.parse(payload).authorization.session_id !== String(session.id)) {
          throw new BidOrchestratorError('BID_RESUME_OWNER_SESSION_REQUIRED', '请回到原授权会话继续此任务；当前会话不能恢复原 Work。')
        }
        if (suspended.work.kind === 'stage_execution' && payload !== null && typeof payload === 'object'
          && 'kind' in payload && payload.kind === 'evidence_mapping_takeover'
          && evidenceMappingTakeoverSchema.parse(payload).authorization.session_id !== String(session.id)) {
          throw new BidOrchestratorError('BID_RESUME_OWNER_SESSION_REQUIRED', '请回到原授权会话继续目录补修；当前会话不能恢复原 Work。')
        }
      }
      if (recovery !== undefined) {
        const main = this.ctx.agents.get(session.id)
        const eligibility = bidRunRecoveryEligibility(session, this.config.modelStageRepairAttempts)
        if (main?.session !== session
          || !eligibility.eligible || eligibility.target?.runId !== suspendedRunId
          || eligibility.target.workId !== expectedRecovery?.target?.workId
          || eligibility.fingerprint !== expectedRecovery.fingerprint
          || suspended.work.kind === 'file_intake' || suspended.work.stage === 'file_intake'
          || suspended.work.stage === 'docx_export' && suspended.work.kind !== 'capability_task'
          || suspended.error?.recovery === undefined
          || eligibility.fingerprint === undefined) {
          throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', '当前 Run 已失去自动恢复授权。')
        }
        if (suspended.work.kind === 'capability_task'
          && ['BID_TASK_PLAN_MISMATCH', 'BID_TASK_RESULT_UNMET'].includes(suspended.error.code ?? '')) {
          const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(operation.workspace, suspended.work))
          const raw = await readFile(within(operation.workspace.projectRoot, 'runs/' + suspended.work.workId + '/task-checkpoint.json'), 'utf8')
          const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(raw))
          const task = { ...request.task, steps: checkpoint.steps.map(record => record.step) }
          const previousVerification = checkpoint.verifications?.at(-1)
          if (previousVerification?.plan_sha256 === bidInputFingerprint(task)) {
            const paths = await readExistingBidWorkingTree(operation.workspace, suspended.work)
            if (paths === null) throw new Error('BID_WORKING_TREE_REQUIRED')
            const working = new BidWorkspace(paths.root, operation.workspace.config)
            const source = bindBidTaskSourceContext(session, request.source_snapshot
              ?? await freezeBidTaskSource(operation.workspace, session, task, request.authorization))
            const input = await collectCapabilityTaskVerificationInput(operation.workspace, working, source,
              request, checkpoint, previousVerification.phase)
            if (previousVerification.input_sha256 === bidInputFingerprint(input)) {
              throw Object.assign(new Error('原任务核验未通过，请先修改能力步骤或真实业务输入，再恢复原 Work。'), { code: 'BID_RECOVERY_STRATEGY_CHANGE_REQUIRED' })
            }
          }
        }
        if (bidRecoveryInstructionRepeated(session, eligibility.target, eligibility.fingerprint, recovery.instruction)) {
          throw new BidOrchestratorError('BID_RECOVERY_DUPLICATE_INSTRUCTION', '同一问题不能重复提交相同修复指令。')
        }
        const acceptedRecovery = session.append('bid.recovery.requested', {
          ownerSessionId: String(session.id),
          target: { kind: 'run', workId: suspended.work.workId, runId: suspendedRunId },
          unit: suspended.error.recovery.unit,
          instruction: recovery.instruction,
          progressFingerprint: eligibility.fingerprint,
        })
        await this.ctx.sessions.flush(session)
        operation.recovery = {
          workId: suspended.work.workId,
          ownerSessionId: String(session.id),
          requestSeq: acceptedRecovery.seq,
          unit: suspended.error.recovery.unit,
          instruction: recovery.instruction,
          issues: suspended.error.issues ?? [],
        }
      } else {
        const acceptedRecovery = session.events.findLast(event => event.type === 'bid.recovery.requested'
          && event.data.target.kind === 'run' && event.data.target.workId === suspended.work.workId)
        if (acceptedRecovery?.type === 'bid.recovery.requested') {
          const original = session.events.findLast(event => event.type === 'bid.task.changed'
            && event.seq < acceptedRecovery.seq
            && (event.data.state.status === 'failed' && event.data.state.stage === suspended.work.stage
              || event.data.state.status === 'suspended' && event.data.state.run.work.workId === suspended.work.workId))
          const issues = original?.type === 'bid.task.changed' && original.data.state.status === 'failed'
            ? original.data.state.failure.issues : original?.type === 'bid.task.changed' && original.data.state.status === 'suspended'
              ? original.data.state.run.error?.issues : undefined
          operation.recovery = {
            workId: suspended.work.workId, ownerSessionId: String(session.id), requestSeq: acceptedRecovery.seq,
            unit: acceptedRecovery.data.unit, instruction: acceptedRecovery.data.instruction,
            issues: issues ?? suspended.error?.issues ?? [],
          }
        }
      }
      const agent = await this.executionAgent(operation, task.stage)
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      if (task.stage === 'chapter_writing') recoverOverflowedBidStageContext(session, task.stage)
      admitted = true
      const next = suspended.work.kind === 'stage_execution' || suspended.work.kind === 'file_intake'
        ? await this.automaticOrchestrator(agent, workspace, operation.controller.signal, operation)
          .resume(suspendedRunId, onAccepted)
        : await this.resumeDedicatedWork(agent, operation, suspended, onAccepted)
      await this.ctx.sessions.flush(session)
      return next
    } finally {
      await this.finishOperation(session, operation, admitted)
    }
  }

  private async resumeDedicatedWork(
    agent: Agent,
    operation: ActiveBidOperation,
    suspended: Extract<BidTaskState, { status: 'suspended' }>['run'],
    onAccepted?: (run: BidRunContext) => void,
  ): Promise<BidTaskState> {
    const payload = await readHostWork(operation.workspace, suspended.work)
    if (suspended.work.kind === 'capability_task') {
      const request = capabilityTaskRequestSchema.parse(payload)
      const run = await operation.runs.start(suspended.work, { runId: suspended.runId, cause: suspended.cause })
      onAccepted?.(run)
      return this.executeAdmittedCapabilityTask(agent, operation, run, request)
    }
    const run = await operation.runs.start(suspended.work, {
      runId: suspended.runId,
      cause: suspended.cause,
    })
    onAccepted?.(run)
    let confirmedArtifacts: StageArtifact[] | undefined
    try {
      await run.activities.track(async () => {
        switch (run.work.kind) {
          case 'evidence_remap': {
            const request = stageInteractionSchema.parse(payload)
            if (request.action !== 'bid_evidence_remap') throw new Error('BID_WORK_REQUEST_KIND_MISMATCH')
            const result = await executeOutlineInteractionCandidate(agent, operation.workspace, request, run, this.config,
              operation.recovery?.workId === run.work.workId ? operation.recovery : undefined)
            if (!result.ok) throw new BidStageExecutionError(result.error.issues ?? [{
              code: result.error.code,
              message: result.error.message,
              artifact: 'outline/draft.json',
            }])
            return
          }
          case 'outline_regeneration': {
            const interaction = stageInteractionSchema.safeParse(payload)
            if (interaction.success && interaction.data.action === 'bid_outline_regenerate_scope') {
              const result = await executeOutlineInteractionCandidate(
                agent,
                operation.workspace,
                interaction.data,
                run,
                this.config,
                operation.recovery?.workId === run.work.workId ? operation.recovery : undefined,
              )
              if (!result.ok) throw new BidStageExecutionError(result.error.issues ?? [{
                code: result.error.code,
                message: result.error.message,
                artifact: 'outline/draft.json',
              }])
              return
            }
            const request = outlineRegenerationRequestSchema.parse(payload)
            const result = await executeOutlineRegenerationCandidate(agent, operation.workspace, request, run, this.config,
              operation.recovery?.workId === run.work.workId ? operation.recovery : undefined)
            if (!result.ok) throw new BidStageExecutionError(result.error.issues ?? [{
              code: result.error.code,
              message: result.error.message,
              artifact: 'outline/regeneration',
            }])
            return
          }
          case 'outline_confirmation': {
            const request = outlineConfirmationRequestSchema.parse(payload)
            const result = await executeOutlineConfirmationCandidate(agent, operation.workspace, request, run, this.config,
              operation.recovery?.workId === run.work.workId ? operation.recovery : undefined)
            if (!result.ok) throw new BidStageExecutionError(result.issues)
            confirmedArtifacts = result.artifacts
            return
          }
          case 'chapter_revision': {
            const request = chapterRevisionRequestSchema.parse(payload)
            await this.executeChapterRevisionCandidate(operation.session, agent, operation.workspace, request, run)
            return
          }
          case 'chapter_revision_batch': {
            const parsed = zod.object({ batch_id: zod.string().min(1) }).strict().parse(payload)
            const batch = await readRevisionBatch(operation.workspace, parsed.batch_id)
            if (batch === null) throw new Error('BID_REVISION_BATCH_NOT_FOUND')
            const runningBatch = resumeRevisionBatchExecution(batch, Date.now())
            await writeRevisionBatch(operation.workspace, runningBatch)
            const queue = await readRevisionQueue(operation.workspace)
            const issueMap = new Map(queue.issues.map(issue => [issue.issue_id, issue]))
            const batchTasks: RevisionBatchTaskExecution[] = runningBatch.tasks.map((task) => {
              const issues = task.issue_ids.map((id) => {
                const issue = issueMap.get(id)
                if (issue === undefined) {
                  throw new Error(`FATAL_CORRUPTION: BID_REVISION_BATCH_CORRUPTED_MISSING_ISSUE: 队列缺失审批意见 ${id}`)
                }
                return {
                  issue_id: id,
                  instruction: issue.instruction,
                  suggestion: issue.suggestion,
                  scope: issue.scope,
                  reference_text: issue.reference.scope === 'paragraphs' ? issue.reference.text : null,
                  start: issue.reference.scope === 'paragraphs' ? issue.reference.start : null,
                  end: issue.reference.scope === 'paragraphs' ? issue.reference.end : null,
                }
              })
              return {
                task_id: task.task_id,
                section_id: task.section_id,
                issue_ids: [...task.issue_ids],
                depends_on: [...task.depends_on],
                issues,
              }
            })
            const runnableTasks = batchTasks.filter((task) => {
              const taskArtifact = runningBatch.tasks.find(t => t.task_id === task.task_id)
              return taskArtifact !== undefined
                && taskArtifact.status !== 'completed'
                && taskArtifact.status !== 'conflict'
                && taskArtifact.status !== 'blocked'
            })
            if (runnableTasks.length > 0) {
              await this.executeChapterRevisionBatchCandidate(
                operation.session, agent, operation.workspace,
                { batchId: runningBatch.batch_id, tasks: runnableTasks }, run,
              )
            }
            const outlineForSettle = parseConfirmedOutlineArtifact(JSON.parse(await readFile(
              within(operation.workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8',
            )))
            const worklistForSettle = buildChapterWorklist(outlineForSettle)
            const settledLocations = await readChapterLocations(operation.workspace)
            const serialsForSettle = new Map(worklistForSettle.flatMap((section) => {
              const assigned = settledLocations.get(section.id)
              return assigned === undefined ? [] : [[section.id, String(assigned.storageSerial).padStart(4, '0')] as const]
            }))
            const settled = await this.settleBatchRevisionIssues(operation.workspace, runningBatch, queue, serialsForSettle)
            const completedBatch = completeRevisionBatchExecution(settled.batch, Date.now())
            await commitRevisionBatchExecutionSettlement(operation.workspace, settled.queue, completedBatch)
            return
          }
          case 'stage_execution':
          case 'file_intake':
            throw new Error('BID_DEDICATED_WORK_KIND_REQUIRED')
          case 'capability_task':
            throw new Error('BID_CAPABILITY_DISPATCH_ALREADY_SELECTED')
        }
      })
      if (confirmedArtifacts !== undefined) {
        await this.automaticOrchestrator(agent, operation.workspace, operation.controller.signal, operation)
          .commitPrevalidatedStage(
            run.work.stage,
            confirmedArtifacts,
            commitOutcome => operation.runs.complete(run, commitOutcome),
          )
      } else if (operation.runs.current === run) {
        const returnState: BidTaskState = run.work.kind === 'evidence_remap' || run.work.kind === 'outline_regeneration'
          ? { stage: run.work.stage, status: 'waiting_user', run: null }
          : { stage: 'chapter_writing', status: 'completed', run: null }
        await operation.runs.complete(run, () => {
          operation.session.append('bid.task.changed', { state: returnState })
        })
      }
      return bidSessionTaskState(operation.session)
    } catch (error: unknown) {
      if (operation.runs.current === run) {
        const failure = safeRecoverableBidFailure(run.work, error)
        await operation.runs.suspend(
          run.signal.aborted ? 'user_stop' : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error',
          failure,
        )
      }
      if (run.work.kind === 'chapter_revision_batch') {
        try {
          const parsed = zod.object({ batch_id: zod.string().min(1) }).safeParse(payload)
          if (parsed.success) {
            const batch = await readRevisionBatch(operation.workspace, parsed.data.batch_id)
            if (batch !== null) {
              const isFatal = error instanceof Error && error.message.includes('FATAL_CORRUPTION')
              const nextBatch = isFatal
                ? failRevisionBatchExecution(batch, Date.now())
                : suspendRevisionBatchExecution(batch, Date.now())
              await writeRevisionBatch(operation.workspace, nextBatch)
            }
          }
        } catch { /* 批次状态更新失败不掩盖原始错误 */ }
      }
      return bidSessionTaskState(operation.session)
    }
  }

  /** 读取项目 Word 模板列表，不解析模板或生成文件。
   * @param session 当前标书会话。
   * @returns 模板身份、页数基准和各模板格式摘要。
   */
  @Remote('getDocxTemplateLibrary')
  async getDocxTemplateLibrary(session: Session): Promise<DocxTemplateLibraryView> {
    if (!isBidMainSession(session)) throw new Error('Word 模板库需要标书项目会话。')
    return readDocxTemplateLibrary(new BidWorkspace(projectKey(session), workspaceConfig(this.config)))
  }

  /** 读取一份明确的项目 Word 配置，不解析模板或生成文件。
   * @param session 当前标书会话。
   * @param templateId 模板 ID；null 明确选择系统默认格式。
   * @returns 已保存格式与来源。
   */
  @Remote('getDocxFormat')
  async getDocxFormat(session: Session, templateId: DocxTemplateId | null): Promise<DocxFormatView> {
    if (!isBidMainSession(session)) throw new Error('Word 配置需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const view = await readDocxFormat(workspace, templateId)
    const project = await readBidProjectState(workspace)
    if (project?.stage === 'docx_export' && project.status !== 'running' || project?.stage === 'chapter_writing' && project.status === 'completed') {
      return collectDocxMarkdown(workspace).then(async markdown => ({
        ...view, fingerprint: docxFingerprint(markdown, view, await docxAssetHash(workspace, markdown)),
      })).catch(() => ({
        ...view, warnings: [...view.warnings, '当前正文或图片无法用于导出，请在更新预览时检查具体错误；已保存配置和旧文件仍可使用。'],
      }))
    }
    return view
  }

  /** 保存一份模板的项目格式，独立于 S1—S5 的资料与阶段状态。
   * @param session 当前标书会话。
   * @param templateId 模板 ID；null 表示系统默认格式。
   * @param request 包含版本及用户配置的请求；模板字节使用独立二进制端点。
   * @returns 保存后的格式。
   */
  @Remote('saveDocxFormat')
  async saveDocxFormat(session: Session, templateId: DocxTemplateId | null, request: DocxFormatRequest): Promise<DocxFormatView> {
    if (!isBidMainSession(session)) throw new Error('Word 配置需要标书项目会话。')
    return this.withDocxOperation(session, workspace => saveDocxFormat(workspace, templateId, request))
  }

  /** 修改 S5 页数基准，不改变 S6 当前选择或任一模板格式。
   * @param session - 当前标书会话。
   * @param templateId - 页数测算模板；null 表示默认格式。
   * @param revision - 要修改的配置版本。
   * @returns 保存后的模板库视图。
   */
  @Remote('setEstimateDocxTemplate')
  async setEstimateDocxTemplate(
    session: Session,
    templateId: DocxTemplateId | null,
    revision: number,
  ): Promise<DocxTemplateLibraryView> {
    if (!isBidMainSession(session)) throw new Error('Word 模板选择需要标书项目会话。')
    return this.withDocxOperation(session, workspace => setEstimateDocxTemplate(workspace, templateId, revision))
  }

  /** 使用已保存配置和固定正文快照生成浏览器预览，不完成 S6。
   * @param session 当前标书会话。
   * @param templateId 模板 ID；null 表示系统默认格式。
   * @returns 带内容标识的样式预览。
   */
  @Remote('previewDocx')
  async previewDocx(session: Session, templateId: DocxTemplateId | null): Promise<DocxFormatView> {
    if (!isBidMainSession(session)) throw new Error('Word 预览需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const view = await readDocxFormat(workspace, templateId)
    const markdown = '# 文档标题\n\n# 1 一级标题\n\n## 1.1 二级标题\n\n这是一段正文示例……\n\n图 图片标题\n\n表 表格标题\n\n| 表头示例 | 说明 |\n| --- | --- |\n| 单元格示例 | 非正文 |\n'
    const rendered = await renderDocx(workspace, markdown, view.state.resolved, false, 'a4')
    return { ...view, fingerprint: docxFingerprint(markdown, view, rendered.assetHash), previewHtml: rendered.html }
  }

  /** 生成待确认的格式建议，不修改模板、正文或生效配置。
   * @param session 当前标书会话。
   * @param templateId 模板 ID；系统默认格式不需要模型建议。
   * @returns 带来源原文的建议。
   */
  @Remote('suggestDocxFormat')
  async suggestDocxFormat(session: Session, templateId: DocxTemplateId): Promise<DocxFormatSuggestion> {
    if (!isBidMainSession(session)) throw new Error('格式建议需要标书项目会话。')
    return this.withDocxOperation(session, async workspace => suggestDocxFormat(
      this.ctx, session, await readDocxFormat(workspace, templateId),
      AbortSignal.timeout(this.config.wordFormatTimeoutMs),
      this.config.wordFormatMaxTokens,
    ))
  }

  /** 下载当前项目最近一次成功的 Word，不接受浏览器文件路径。
   * @param session 当前标书会话。
   * @param templateId 本次导出使用的模板 ID；null 表示系统默认格式。
   * @returns 下载名称和文件字节。
   */
  @Remote('downloadDocx')
  async downloadDocx(session: Session, templateId: DocxTemplateId | null): Promise<{ data: string; name: string }> {
    if (!isBidMainSession(session)) throw new Error('下载需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const view = await readDocxFormat(workspace, templateId)
    if (!view.state.lastExport) throw new Error('请先生成 Word。')
    const path = within(workspace.projectRoot, view.state.lastExport.path)
    if (!path.startsWith(workspace.outputRoot + sep)) throw new Error('Word 文件不在输出目录中。')
    await assertNoLinkedPath(workspace.root, path)
    return { data: (await readFile(path)).toString('base64'), name: basename(path) }
  }

  /**
   * 按完整目录和已保存正文生成 Word，不暂停写作，也不离开审核阶段；导出不代表审核通过。
   * @param session 当前项目的 Bid 会话，无需持有阶段操作。
   * @param templateId 本次导出使用的模板 ID；null 表示系统默认格式。
   * @returns 新文件信息，或稳定的拒绝结果。
   */
  @Remote('exportDocx')
  async exportDocx(session: Session, templateId: DocxTemplateId | null): Promise<BidDocxExportResult> {
    return this.exportDocxWithIdentity(session, templateId)
  }

  /** 用户能力任务复用独立导出生命周期，稳定身份用于重启去重。 */
  private async exportDocxWithIdentity(
    session: Session, templateId: DocxTemplateId | null, operationId?: string,
  ): Promise<BidDocxExportResult> {
    if (!isBidMainSession(session)) {
      return docxExportRejected('BID_SESSION_REQUIRED', 'Word 导出需要标书项目会话。')
    }
    if (operationId !== undefined) {
      const prior = session.events.findLast(event => event.type === 'bid.docx_export.changed'
        && event.data.operation.operationId === operationId)
      if (prior?.type === 'bid.docx_export.changed' && prior.data.operation.status === 'completed') {
        const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
        const previousPath = within(workspace.projectRoot, prior.data.operation.path)
        await assertNoLinkedPath(workspace.root, previousPath)
        try {
          await readFile(previousPath)
          return { ok: true, value: { path: prior.data.operation.path,
            warnings: prior.data.operation.warnings } }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    const existing = this.docxExports.get(session.id)
    if (existing !== undefined) return existing
    const failure = (error: unknown): BidDocxExportResult => {
      if (error instanceof BidStageExecutionError) {
        return docxExportRejected('BID_DOCX_EXPORT_FAILED', '当前已保存正文无法导出，请检查正文完整性。', error.issues)
      }
      return docxExportRejected('BID_DOCX_EXPORT_FAILED', error instanceof Error ? error.message : 'Word 生成失败，请重试。')
    }
    const generate = async (
      workspace: BidWorkspace,
      task: BidTaskState,
      publish: (phase: DocxExportOperation['phase'], message: string) => Promise<void>,
    ): Promise<BidDocxExportResult> => {
      const projection = getBidClientProjection(task)
      if (!projection.allowedActions.includes('export_docx')) {
        return docxExportRejected('BID_DOCX_EXPORT_NOT_ALLOWED', '当前阶段没有可导出的章节正文。')
      }
      const partialExport = projection.task.stage === 'chapter_writing'
        && projection.task.status !== 'completed'
      const destination = `${workspace.config.outputDirectory}/bid-${String(Date.now())}-${randomBytes(3).toString('hex')}.docx`
      await publish('collecting', '正在收集目录和已保存正文')
      const snapshot = await collectDocxExportSnapshot(workspace, undefined, templateId)
      if (!partialExport && snapshot.technicalDeviation.status === 'pending') {
        throw new BidStageExecutionError([{
          ...snapshot.technicalDeviation.issue,
          message: '第一章“技术偏离表”正文缺失或结构不完整，请先修复该章节后重新导出 Word。',
        }])
      }
      const technicalDeviation: TechnicalDeviationComposition | undefined = snapshot.technicalDeviation.status === 'ready'
        ? { mode: 'fill', table: snapshot.technicalDeviation.table }
        : snapshot.technicalDeviation.status === 'pending' ? { mode: 'clear' } : undefined
      const source = destination.slice(0, -'.docx'.length) + '.md'
      await publish('exporting', '正在生成 Word')
      await workspace.exportDocxMarkdown(
        snapshot.markdown,
        destination,
        templateId,
        undefined,
        source,
        undefined,
        technicalDeviation,
        createDocxVisualReviewer(this.ctx, session),
      )
      const artifacts: StageArtifact[] = [{ stage: 'docx_export', type: 'docx', path: destination }]
      await publish('finalizing', '正在校验 Word 并整理结果')
      const validation = await validateDocxExport(workspace, 'docx_export', artifacts)
      if (!validation.ok) return docxExportRejected('BID_DOCX_EXPORT_FAILED', '生成的 Word 文件结构无效。', validation.issues)
      const formatView = await readDocxFormat(workspace, templateId)
      const exportReportWarnings = formatView.state.lastExport?.summary ? [{
        code: formatView.state.lastExport.mode === 'editable' ? 'DOCX_EXPORT_MODE_EDITABLE' : 'DOCX_EXPORT_MODE_FALLBACK',
        message: formatView.state.lastExport.summary,
      }] : []
      const tocWarnings = formatView.state.lastExport?.tocUpdateDeferred ? [{
        code: DOCX_TOC_UPDATE_DEFERRED,
        message: '当前环境未检测到 Microsoft Word，已保留真实目录字段；在 Word 中打开文档时将自动请求刷新目录和页码。',
      }] : []
      const technicalDeviationWarnings = snapshot.technicalDeviation.status === 'pending' ? [{
        code: 'DOCX_EXPORT_TECHNICAL_DEVIATION_PENDING',
        message: '技术偏离表章节尚未形成可导出的完整数据，本次为阶段性 Word；技术偏离表数据行已留空，其余已保存正文已正常导出。',
      }] : []
      const warnings = [{
        code: 'DOCX_EXPORT_CONTENT_SNAPSHOT',
        message: `Word 已按已保存正文快照 ${createHash('sha256').update(snapshot.markdown).digest('hex').slice(0, 12)} 生成；缺失正文的章节已标注。`,
      }, ...technicalDeviationWarnings, ...exportReportWarnings, ...tocWarnings, ...await assessDocxExportPageTarget(workspace, templateId)]
      return { ok: true, value: { path: destination, warnings } }
    }
    const pending = this.withDocxOperation(session, async (workspace) => {
      const saved = await readBidProjectState(workspace)
      const active = this.inFlight.get(projectKey(session))
      const task = active === undefined
        ? saved === undefined
          ? bidSessionTaskState(session)
          : bidProjectTaskState(saved)
        : bidSessionTaskState(active.session)
      const projection = getBidClientProjection(task)
      if (!projection.allowedActions.includes('export_docx')) {
        return docxExportRejected('BID_DOCX_EXPORT_NOT_ALLOWED', '当前阶段没有可导出的章节正文。')
      }
      const startedAt = Date.now()
      const base = { operationId: operationId ?? randomBytes(16).toString('hex'), templateId, startedAt }
      let current: DocxExportOperation = {
        ...base, updatedAt: startedAt, status: 'running', phase: 'collecting', message: '正在收集目录和已保存正文',
      }
      const publishOperation = async (operation: DocxExportOperation): Promise<void> => {
        current = operation
        session.append('bid.docx_export.changed', { operation })
        await this.ctx.sessions.flush(session)
      }
      const publish = async (phase: DocxExportOperation['phase'], message: string): Promise<void> => {
        await publishOperation({ ...base, updatedAt: Date.now(), status: 'running', phase, message })
      }
      try {
        const result = await generate(workspace, task, publish)
        if (!result.ok) {
          await publishOperation({ ...base, updatedAt: Date.now(), status: 'failed', phase: current.phase,
            message: 'Word 导出失败', error: result.error.message.slice(0, 500) })
        } else {
          await publishOperation({ ...base, updatedAt: Date.now(), status: 'completed', phase: 'finalizing',
            message: 'Word 导出完成', path: result.value.path,
            filePath: within(workspace.projectRoot, result.value.path),
            warnings: (result.value.warnings ?? []).slice(0, 20).map(warning => ({
              code: warning.code.slice(0, 100), message: warning.message.slice(0, 500),
            })) })
        }
        return result
      } catch (error: unknown) {
        const result = failure(error)
        if (current.operationId === base.operationId && !result.ok) {
          await publishOperation({ ...base, updatedAt: Date.now(), status: 'failed', phase: current.phase,
            message: 'Word 导出失败', error: result.error.message.slice(0, 500) })
        }
        return result
      }
    })
    this.docxExports.set(session.id, pending)
    try { return await pending } catch (error: unknown) { return failure(error) } finally { this.docxExports.delete(session.id) }
  }

  /** 使用正式 Renderer 尝试核验指定模板的当前导出页数。
   * @param session - 当前标书会话。
   * @param templateId - 待测算模板；null 表示默认格式。
   * @returns 页数估算及其配置基准。
   */
  @Remote('estimateDocxPages')
  async estimateDocxPages(session: Session, templateId: DocxTemplateId | null): Promise<import('./control-plane-contract.ts').BidPageEstimate> {
    if (!isBidMainSession(session)) throw new Error('Word 页数测算需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const currentBasis = async (): Promise<import('./control-plane-contract.ts').BidPageEstimateBasis> => {
      const view = await readDocxFormat(workspace, templateId)
      return {
        source: view.templateId === null ? 'default' : 'template',
        method: 'fast',
        template: view.templateId === null ? null : {
          id: view.templateId,
          name: view.state.template?.name ?? view.templateId,
          revision: view.state.revision,
        },
      }
    }
    let markdown: string
    try { markdown = await collectDocxMarkdown(workspace) } catch (error) {
      const basis = await currentBasis()
      return error instanceof BidStageExecutionError
        && error.issues.some(issue => issue.code === 'DOCX_EXPORT_NO_SAVED_CHAPTERS')
        ? { status: 'empty', ...basis }
        : { status: 'unavailable', basis }
    }
    try {
      const estimate = await estimateDocxMarkdownPages(workspace, markdown, templateId)
      const basis = {
        source: estimate.format.source,
        method: estimate.method,
        template: estimate.format.template_id === null ? null : {
          id: estimate.format.template_id,
          name: estimate.format.template_name ?? estimate.format.template_id,
          revision: estimate.format.revision,
        },
      } as const
      return estimate.pages > 0 ? { status: 'available', pages: Math.ceil(estimate.pages), ...basis } : { status: 'empty', ...basis }
    } catch { return { status: 'unavailable', basis: await currentBasis() } }
  }

  /**
   * 将用户意见交给目标章节原 Writer；整个操作互斥，失败保留正文。
   * @param session 发起修订的 Bid 会话。
   * @param request 章节或完整连续段落引用与编写意见。
   * @returns 新正文，或可重新选择原文后重试的业务错误。
   */
  @Remote('reviseChapter')
  async reviseChapter(session: Session, request: BidChapterRevisionRequest): Promise<BidChapterRevisionResult> {
    const parsed = chapterRevisionRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: { code: 'BID_CHAPTER_REVISION_INVALID', message: '请选择真实正文并填写修订意见。' } }
    const agent = this.ctx.get('agents')?.get(session.id)
    if (agent?.session !== session || !isBidMainSession(session)) return { ok: false,
      error: { code: 'BID_SESSION_REQUIRED', message: '修订需要当前项目的主会话。' } }
    const chapter = await this.getReviewChapter(session, parsed.data.reference.section_id)
    if (chapter.markdown === null || chapter.content_sha256 !== parsed.data.reference.content_sha256) return { ok: false,
      error: { code: 'BID_CHAPTER_REVISION_CONFLICT', message: '章节正文已变化，请重新选择章节或段落。' } }
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: parsed.data.instruction + '\n用户在正文视图指定的修订引用：' + JSON.stringify(parsed.data.reference) }] })
    session.append('user/message', message, { surfaceOp: 'append' })
    const task = bidCapabilityTaskSchema.parse({ goal: parsed.data.instruction,
      scope: parsed.data.reference.scope === 'paragraphs' ? { kind: 'paragraphs', reference: parsed.data.reference }
        : { kind: 'sections', section_ids: [parsed.data.reference.section_id] },
      steps: [{ description: parsed.data.reference.scope === 'paragraphs' ? '按用户意见修订正文选区' : '按用户意见修订章节正文', scope: { source: 'task' },
        call: { capability: 'chapter.revise', input: parsed.data } }] })
    const state = await withBidNativeTaskAuthorization(session, message, () => this.runCapabilityTask(agent, task,
      { session_id: String(session.id), message_id: String(message.id) }, BID_CAPABILITIES['chapter.revise'].requires))
    if (state.status === 'suspended' || state.status === 'failed') return { ok: false,
      error: { code: 'BID_CHAPTER_REVISION_FAILED', message: '修订未达到原始要求，已保存诊断和候选。' } }
    return { ok: true, value: await this.getReviewChapter(session, parsed.data.reference.section_id) }
  }

  private async executeChapterRevisionCandidate(
    session: Session,
    executionAgent: Agent,
    canonical: BidWorkspace,
    request: BidChapterRevisionRequest,
    run: BidRunContext,
  ): Promise<void> {
    const candidate = await prepareWorkingWorkspace(canonical, run)
    const logPath = within(candidate.workspace.projectRoot, 'chapters/execution-log.json')
    await assertNoLinkedPath(candidate.workspace.root, logPath)
    const log = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    const writerId = log.sections.find(section => section.section_id === request.reference.section_id)
      ?.final_writer_child_session_id
    if (writerId == null) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    const writer = await persistence.inspect(SessionId(writerId), run.signal)
    const parentId = writer.meta.parentSession
    if (parentId === undefined || writer.meta.cwd === undefined
      || projectKey({ header: writer.meta }) !== projectKey(session)) {
      throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    }
    let resumedParent: AgentHandle | undefined
    let parent = parentId === executionAgent.id ? executionAgent : this.ctx.agents.get(parentId)
    try {
      if (parent === undefined) {
        const parentSession = await persistence.inspect(SessionId(parentId), run.signal)
        const presets = this.ctx.get('agentPresets')
        resumedParent = await this.ctx.agents.resume({
          resumeSessionId: parentId,
          signal: run.signal,
          async setup(parentContext) {
            parentContext.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
            if (presets !== undefined) await presets.mount(parentContext, resolveSessionPreset({
              header: parentSession.meta,
              events: parentSession.events,
            }))
          },
        })
        parent = resumedParent.agent
      }
      if (parent.session.header.cwd === undefined || projectKey(parent.session) !== projectKey(session)) {
        throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
      }
      await executeChapterWriting(parent, candidate.workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: this.config.modelStageRepairAttempts,
        maxConcurrency: this.config.chapterWritingMaxConcurrency,
        maxCompletionRepairRounds: this.config.chapterWritingCompletionRepairRounds,
        webSearchEnabled: this.config.webSearchEnabled,
        run: candidate.run,
        revision: request,
      })
      await publishBidWorkingPaths(run, canonical, candidate.workspace, ['chapters'])
    } finally {
      await resumedParent?.dispose()
    }
  }

  /**
   * 恢复批次中各 section 原 Writer 的 parent agent，执行批量修订后发布结果。
   * 原 Writer 不可恢复时抛出 BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE。
   * 每个原 parent 只恢复和释放一次，全部章节仍共享同一并发上限。
   * @param session Bid Main Session。
   * @param executionAgent 当前执行 agent，仅当其本身即原 parent 时直接复用。
   * @param canonical 规范工作区。
   * @param batchExecutionInput 批次执行输入。
   * @param run 当前 Run 上下文。
   * @param admittedCandidate 已接纳任务的步骤候选，复用时只执行，不另行发布。
   */
  private async executeChapterRevisionBatchCandidate(
    session: Session,
    executionAgent: Agent,
    canonical: BidWorkspace,
    batchExecutionInput: RevisionBatchExecutionInput,
    run: BidRunContext,
    admittedCandidate?: {
      readonly workspace: BidWorkspace
      readonly run: BidRunContext
      readonly preservation?: Awaited<ReturnType<typeof prepareWritingCapabilityPreservation>>
    },
  ): Promise<void> {
    const candidate = admittedCandidate ?? await prepareWorkingWorkspace(canonical, run)
    const logPath = within(candidate.workspace.projectRoot, 'chapters/execution-log.json')
    await assertNoLinkedPath(candidate.workspace.root, logPath)
    const log = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    const sectionIds = new Set(batchExecutionInput.tasks.map(task => task.section_id))
    const writerIds = new Map<string, string>()
    for (const sectionId of sectionIds) {
      const writerId = log.sections.find(section => section.section_id === sectionId)
        ?.final_writer_child_session_id
      if (writerId == null) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
      writerIds.set(sectionId, writerId)
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    const parentIds = new Set<SessionId>()
    const writerParents = new Map<string, SessionId>()
    for (const writerId of writerIds.values()) {
      const writer = await persistence.inspect(SessionId(writerId), run.signal)
      const parentId = writer.meta.parentSession
      if (parentId === undefined || writer.meta.cwd === undefined
        || projectKey({ header: writer.meta }) !== projectKey(session)) {
        throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
      }
      parentIds.add(parentId)
      writerParents.set(writerId, parentId)
    }
    const resumedParents: AgentHandle[] = []
    const revisionParents = new Map<SessionId, Agent>()
    try {
      for (const parentId of parentIds) {
        let parent = parentId === executionAgent.id ? executionAgent : this.ctx.agents.get(parentId)
        if (parent === undefined) {
          const parentSession = await persistence.inspect(parentId, run.signal)
          const presets = this.ctx.get('agentPresets')
          const handle = await this.ctx.agents.resume({
            resumeSessionId: parentId, signal: run.signal,
            async setup(parentContext) {
              parentContext.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
              if (presets !== undefined) await presets.mount(parentContext, resolveSessionPreset({
                header: parentSession.meta, events: parentSession.events,
              }))
            },
          })
          resumedParents.push(handle)
          parent = handle.agent
        }
        if (parent.session.header.cwd === undefined || projectKey(parent.session) !== projectKey(session)) {
          throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
        }
        revisionParents.set(parentId, parent)
      }
      const parentFor = (writerId: string): Agent => {
        const parentId = writerParents.get(writerId)
        const parent = parentId === undefined ? undefined : revisionParents.get(parentId)
        if (parent === undefined) throw new Error('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
        return parent
      }
      const [outline, requirements, scoring, compliance, responsePoints, writingPlan] = await Promise.all([
        readFile(within(candidate.workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
          .then(value => parseConfirmedOutlineArtifact(JSON.parse(value))),
        readFile(within(candidate.workspace.projectRoot, 'analysis/requirements.json'), 'utf8')
          .then(value => parseTenderRequirementsArtifact(JSON.parse(value))),
        readFile(within(candidate.workspace.projectRoot, 'analysis/scoring.json'), 'utf8')
          .then(value => parseTenderScoringArtifact(JSON.parse(value))),
        readFile(within(candidate.workspace.projectRoot, 'analysis/compliance.json'), 'utf8')
          .then(value => parseTenderComplianceArtifact(JSON.parse(value))),
        readFile(within(candidate.workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')
          .then(value => parseScoringResponsePointCatalog(JSON.parse(value))),
        readFile(within(candidate.workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')
          .then(value => parseWritingPlan(JSON.parse(value))),
      ])
      const worklist = buildChapterWorklist(outline)
      const locations = await readChapterLocations(candidate.workspace)
      const scheduled = batchExecutionInput.tasks.map((task) => {
        const index = worklist.findIndex(section => section.id === task.section_id)
        const section = worklist[index]
        const writerId = writerIds.get(task.section_id)
        const assigned = locations.get(task.section_id)
        if (section === undefined || writerId === undefined || assigned === undefined) throw new Error('BID_CHAPTER_REVISION_NOT_WRITABLE')
        return { task, value: { location: assigned, title: section.title, writerId } }
      })
      const customerTextContext = {
        outline,
        requirements,
        scoring,
        compliance,
        responsePoints,
        acceptanceCriterionIds: [
          ...writingPlan.document_acceptance.map(item => item.id),
          ...writingPlan.sections.flatMap(section => section.acceptance_criteria.map(item => item.id)),
        ],
      }
      const fallback = async (item: typeof scheduled[number]): Promise<ParagraphRevisionTaskResult> => {
        try { await executeChapterWriting(executionAgent, candidate.workspace, buildBidStageTask('chapter_writing'), {
          maxRepairAttempts: this.config.modelStageRepairAttempts,
          maxConcurrency: 1,
          maxCompletionRepairRounds: this.config.chapterWritingCompletionRepairRounds,
          webSearchEnabled: this.config.webSearchEnabled,
          run: candidate.run,
          documentReview: 'defer',
          writerParentFor: writerId => Promise.resolve(parentFor(writerId)),
          ...(admittedCandidate?.preservation === undefined ? {} : { preservation: admittedCandidate.preservation }),
          revisionBatch: {
            batchId: batchExecutionInput.batchId,
            tasks: [{ ...item.task, depends_on: [] }],
          },
        }) } catch (error) {
          candidate.run.signal.throwIfAborted()
          const failure = safeRecoverableBidFailure(candidate.run.work, error)
          return { status: 'failed', code: failure.issues?.[0]?.code ?? failure.code ?? 'BID_CHAPTER_REVISION_FAILED',
            message: failure.issues?.[0]?.message ?? failure.message }
        }
        const unit = (await readRevisionBatch(candidate.workspace, batchExecutionInput.batchId))?.tasks
          .find(task => task.task_id === item.task.task_id)
        if (unit === undefined) throw new Error('BID_REVISION_BATCH_TASK_NOT_FOUND')
        if (unit.status === 'completed' || unit.status === 'needs_input') return { status: unit.status }
        return { status: unit.status === 'blocked' ? 'blocked' : 'failed',
          code: unit.failure?.code ?? 'BID_CHAPTER_REVISION_FAILED', message: unit.failure?.message ?? '正文修订未完成。' }
      }
      const results = await runParagraphRevisionScheduler({
        tasks: scheduled,
        maxConcurrency: this.config.chapterWritingMaxConcurrency,
        run: async (item) => {
          if (!isParagraphOnlyRevisionTask(item.task)) return { status: 'full_review' }
          try { return await executeParagraphRevisionTask({
            parent: parentFor(item.value.writerId),
            workspace: candidate.workspace,
            batchId: batchExecutionInput.batchId,
            task: item.task,
            location: item.value.location,
            title: item.value.title,
            writerId: item.value.writerId,
            signal: candidate.run.signal,
            customerTextContext,
          }) } catch (error) {
            candidate.run.signal.throwIfAborted()
            const failure = safeRecoverableBidFailure(candidate.run.work, error)
            return { status: 'failed', code: failure.issues?.[0]?.code ?? failure.code ?? 'BID_CHAPTER_REVISION_FAILED',
              message: failure.issues?.[0]?.message ?? failure.message }
          }
        },
        fallback,
      })
      let updatedBatch = await readRevisionBatch(candidate.workspace, batchExecutionInput.batchId)
      if (updatedBatch !== null) {
        const now = Date.now()
        updatedBatch = {
          ...updatedBatch,
          tasks: updatedBatch.tasks.map((task) => {
            const result = results.get(task.task_id)
            if (result === undefined) return task
            return result.status === 'completed'
              ? { ...task, status: 'completed' as const, failure: null, started_at: task.started_at ?? now, completed_at: task.completed_at ?? now }
              : result.status === 'needs_input'
                ? { ...task, status: 'needs_input' as const, started_at: task.started_at ?? now, completed_at: null }
                : result.status === 'blocked'
                  ? { ...task, status: 'blocked' as const, started_at: task.started_at, completed_at: null, failure: {
                    code: result.code, message: result.message, phase: null,
                  } }
                  : { ...task, status: 'failed' as const, started_at: task.started_at ?? now, completed_at: null, failure: {
                    code: result.status === 'failed' ? result.code : 'PARAGRAPH_REVISION_FAILED',
                    message: result.status === 'failed' ? result.message : '局部修订失败。', phase: null,
                  } }
          }),
          updated_at: now,
        }
        await writeRevisionBatch(candidate.workspace, updatedBatch)
      }
      if (admittedCandidate === undefined) await publishBidWorkingPaths(run, canonical, candidate.workspace, ['chapters'])
    } finally {
      await Promise.all(resumedParents.map(parent => parent.dispose()))
    }
  }

  /**
   * 读取批次中各 section 的 review artifact，提取 revision_issue_checks 并结算 issue 状态。
   * @param workspace 项目工作区。
   * @param batch 批次 artifact。
   * @param queue 当前队列。
   * @param sectionSerials section_id → serial 映射。
   * @returns 结算后的队列。
   */
  private async settleBatchRevisionIssues(
    workspace: BidWorkspace,
    batch: RevisionBatchArtifact,
    queue: RevisionQueueArtifact,
    sectionSerials: ReadonlyMap<string, string>,
  ): Promise<{ readonly queue: RevisionQueueArtifact; readonly batch: RevisionBatchArtifact }> {
    let currentQueue = queue
    const now = Date.now()
    let log: ChapterExecutionLog | undefined
    try {
      const logRaw: unknown = JSON.parse(await readFile(within(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8'))
      log = parseOrMigrateChapterExecutionLog(logRaw)
    } catch {}
    let currentBatch = await readRevisionBatch(workspace, batch.batch_id) ?? batch
    for (const task of batch.tasks) {
      const currentTask = currentBatch.tasks.find(t => t.task_id === task.task_id)
      if (currentTask?.status === 'conflict' || currentTask?.status === 'blocked') {
        continue
      }
      if (currentTask?.status === 'needs_input' || currentTask?.status === 'failed') {
        const status = currentTask.status === 'needs_input' ? 'needs_input' as const : 'failed' as const
        currentQueue = {
          ...currentQueue,
          issues: currentQueue.issues.map(issue => task.issue_ids.includes(issue.issue_id)
            ? { ...issue, status, updated_at: now }
            : issue),
        }
        continue
      }
      const serial = sectionSerials.get(task.section_id)
      if (serial === undefined) {
        throw new Error(`BID_REVISION_REVIEW_INCOMPLETE: 缺少章节序号 ${task.section_id}`)
      }
      const sectionLog = log?.sections.find(s => s.section_id === task.section_id)
      if (sectionLog !== undefined && sectionLog.status === 'failed') {
        currentQueue = {
          ...currentQueue,
          issues: currentQueue.issues.map(issue =>
            task.issue_ids.includes(issue.issue_id)
              ? { ...issue, status: 'failed' as const, updated_at: now }
              : issue,
          ),
        }
        currentBatch = updateRevisionBatchTaskStatus(currentBatch, task.task_id, {
          status: sectionLog.failure_phase === 'blocked' ? 'blocked' : 'failed',
          // Writer 已经把可诊断的失败写入 task artifact；只在旧 artifact
          // 没有失败详情时回退到章节日志，避免结算阶段覆盖根因。
          failure: currentTask?.failure ?? {
            code: 'SECTION_FAILED',
            message: '章节执行失败',
            phase: sectionLog.failure_phase,
          },
        }, now)
        continue
      }
      let checks: RevisionIssueCheck[] = []
      try {
        const paragraphOnly = task.issue_ids.map(id => currentQueue.issues.find(issue => issue.issue_id === id))
          .every(issue => issue?.scope === 'paragraphs')
        const fastReview = paragraphOnly
          ? await readParagraphRevisionReview(workspace, batch.batch_id, task.task_id)
          : null
        if (fastReview !== null) checks = fastReview.issue_checks
        else {
          const reviewRaw: unknown = JSON.parse(await readFile(
            within(workspace.projectRoot, `chapters/reviews/${serial}.json`), 'utf8',
          ))
          const review = parseChapterReviewArtifact(reviewRaw)
          checks = review.revision_issue_checks ?? []
        }
      } catch {
        throw new Error(`BID_REVISION_REVIEW_INCOMPLETE: 无法读取审查报告 ${serial}`)
      }
      const result = settleRevisionBatchIssues(currentQueue, task.issue_ids, checks, now)
      currentQueue = result.queue
      currentBatch = updateRevisionBatchTaskStatus(currentBatch, task.task_id, {
        status: result.taskStatus,
      }, now)
    }
    return { queue: currentQueue, batch: currentBatch }
  }

  /**
   * Read the live S5 writing and per-chapter review state without disclosing workspace paths.
   * @param session Bid Session whose writing workbench is requested.
   * @returns Browser-safe chapter workbench rows and aggregate progress.
   */
  @Remote('getReviewWorkbench')
  async getReviewWorkbench(session: Session): Promise<BidReviewWorkbenchView> {
    const workspace = this.requireReviewWorkspace(session)
    const task = bidSessionTaskState(session)
    let schemaWarningAppended = false
    const outlinePath = within(workspace.projectRoot, 'outline/confirmed-outline.json')
    const logPath = within(workspace.projectRoot, 'chapters/execution-log.json')
    await Promise.all([assertNoLinkedPath(workspace.root, outlinePath), assertNoLinkedPath(workspace.root, logPath)])
    const outlineRaw = await readFile(outlinePath, 'utf8')
    const outlineValue: unknown = JSON.parse(outlineRaw)
    schemaWarningAppended = appendBidSchemaWarning(session, createBidSchemaWarning(
      'outline/confirmed-outline.json', OUTLINE_GENERATION_SCHEMA_VERSION,
      typeof outlineValue === 'object' && outlineValue !== null ? (outlineValue as { schema_version?: unknown }).schema_version : undefined,
      task.stage,
    )) || schemaWarningAppended
    const outline = parseOutlineArtifact(outlineValue)
    let log: ReturnType<typeof parseOrMigrateChapterExecutionLog> | undefined
    try {
      const logValue: unknown = JSON.parse(await readFile(logPath, 'utf8'))
      schemaWarningAppended = appendBidSchemaWarning(session, createBidSchemaWarning(
        'chapters/execution-log.json', CHAPTER_EXECUTION_LOG_SCHEMA_VERSION,
        typeof logValue === 'object' && logValue !== null ? (logValue as { schema_version?: unknown }).schema_version : undefined,
        task.stage,
      )) || schemaWarningAppended
      log = parseOrMigrateChapterExecutionLog(logValue)
    } catch { log = undefined }
    const worklist = buildChapterWorklist(outline)
    const locations = await readChapterLocations(workspace)
    const rowContents = await Promise.all(outline.sections.map(async (section) => {
      const index = worklist.findIndex(item => item.id === section.id)
      const assigned = locations.get(section.id)
      const serial = assigned === undefined ? null : String(assigned.storageSerial).padStart(4, '0')
      const execution = log?.sections.find(item => item.section_id === section.id)
      let contentAvailable = !section.writable && section.summary !== undefined
      let markdown = !section.writable ? section.summary ?? '' : ''
      let review: BidReviewChapterView['review'] = { status: 'not_started', issues: [] }
      if (section.writable && index >= 0 && assigned !== undefined && serial !== null) {
        try {
          markdown = await readFile(within(workspace.projectRoot, assigned.contentPath), 'utf8')
          contentAvailable = markdown.trim().length > 0
        } catch { markdown = ''; contentAvailable = false }
        let artifact: ChapterReviewArtifact | undefined
        try {
          const reviewValue: unknown = JSON.parse(await readFile(within(workspace.projectRoot, assigned.reviewPath), 'utf8'))
          schemaWarningAppended = appendBidSchemaWarning(session, createBidSchemaWarning(
            assigned.reviewPath, CHAPTER_REVIEW_SCHEMA_VERSION,
            typeof reviewValue === 'object' && reviewValue !== null ? (reviewValue as { schema_version?: unknown }).schema_version : undefined,
            task.stage,
          )) || schemaWarningAppended
          artifact = parseChapterReviewArtifact(reviewValue)
        } catch { /* 章节可能仍在写作，或已保存报告暂不可用。 */ }
        if (artifact !== undefined && (!contentAvailable
          || !await chapterReviewMatches(workspace, serial, section.id, markdown, artifact))) {
          artifact = undefined
        }
        review = projectChapterReview(section.id, artifact, execution)
      }
      const writingStatus: BidReviewWorkbenchView['outline'][number]['writing_status'] = !section.writable || execution === undefined || execution.status === 'pending'
        ? 'not_started'
        : execution.status === 'running'
          ? execution.phase === 'writing' || execution.phase === 'repairing' ? 'writing'
            : contentAvailable ? 'content_ready' : 'not_started'
          : execution.status
      const chapterIndicator = !section.writable
        ? { status: 'not_started' as const, tooltip: section.summary === undefined ? '概述待补充' : '章节概述' }
        : projectChapterIndicator(
          contentAvailable,
          review,
          execution,
          execution?.depends_on.some(sectionId => log?.sections.find(item => item.section_id === sectionId)?.status !== 'completed') ?? false,
        )
      return { markdown, row: {
        section_id: section.id,
        parent_id: section.parent_id,
        order: section.order,
        title: normalizeOutlineSectionTitle(section.title) || section.title,
        ...(section.summary === undefined ? {} : { summary: section.summary }),
        writable: section.writable,
        writing_status: writingStatus,
        review_status: review.status,
        chapter_indicator: chapterIndicator,
        content_available: contentAvailable,
      } }
    }))
    type SectionOverlay = { batch_id: string; task_id: string; status: BidRevisionTaskStatus; issue_count: number }
    const revisionOverlayBySection = new Map<string, SectionOverlay>()
    let revisionBatchSummary: BidReviewWorkbenchView['revision_batch'] | undefined
    try {
      const revisionQueue = await readRevisionQueue(workspace)
      const batchIssues = revisionQueue.issues.filter(issue => issue.batch_id !== null)
      const batchIds = [...new Set(
        revisionQueue.issues.map(issue => issue.batch_id).filter((id): id is string => id !== null),
      )]
      for (const batchId of batchIds) {
        const batch = await readRevisionBatch(workspace, batchId)
        if (batch === null) continue
        if (batch.status === 'running' || batch.status === 'suspended' || batch.status === 'planning') {
          for (const task of batch.tasks) {
            revisionOverlayBySection.set(task.section_id, {
              batch_id: batch.batch_id,
              task_id: task.task_id,
              status: task.status,
              issue_count: task.issue_ids.length,
            })
          }
          const statusCounts = { completed: 0, running: 0, pending: 0, needs_input: 0, failed: 0, conflict: 0 }
          for (const issue of batchIssues.filter(issue => issue.batch_id === batchId)) {
            if (issue.status === 'completed') statusCounts.completed += 1
            else if (issue.status === 'failed') statusCounts.failed += 1
            else if (issue.status === 'needs_input') statusCounts.needs_input += 1
            else if (issue.status === 'conflict') statusCounts.conflict += 1
            else if (issue.status === 'scheduled' || issue.status === 'running') statusCounts.running += 1
            else statusCounts.pending += 1
          }
          revisionBatchSummary = {
            batch_id: batch.batch_id,
            status: batch.status,
            total_issues: batch.issue_ids.length,
            ...statusCounts,
          }
        }
      }
    } catch { /* revision queue/batch 不可读时不阻塞 workbench。 */ }
    let rows = rowContents.map((item) => {
      const revision = revisionOverlayBySection.get(item.row.section_id)
      return revision === undefined ? item.row : { ...item.row, revision }
    })
    let pageEstimate: BidReviewWorkbenchView['summary']['page_estimate'] = { status: 'unavailable' }
    let writingPlan: Awaited<ReturnType<typeof currentWritingPlan>>
    let pageTarget: BidReviewWorkbenchView['summary']['page_target']
    try {
      writingPlan = await currentWritingPlan(workspace)
      const criterion = writingPlan?.document_acceptance.find(item =>
        item.evaluator.kind === 'deterministic' && item.evaluator.metric === 'estimated_pages')
      const target = criterion?.evaluator.kind === 'deterministic' ? {
        kind: criterion.evaluator.min === null ? 'maximum' as const
          : criterion.evaluator.max === null ? 'minimum' as const : 'range' as const,
        min_pages: criterion.evaluator.min,
        max_pages: criterion.evaluator.max,
        estimate_basis: 'Host estimated_pages metric',
      } : null
      pageTarget = writingPlan === undefined ? { status: 'not_set' }
        : target === null ? { status: 'not_required' }
          : { status: 'unavailable', target, reason: '当前篇幅无法核验。' }
    } catch (error) {
      pageTarget = { status: 'unavailable', target: null, reason: `写作计划无法读取：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      const estimate = await estimateChapterWritingPages(workspace, outline, {
        method: task.status === 'running' ? 'fast' : 'rendered',
      })
      const basis = {
        source: estimate.format.source,
        method: estimate.method,
        template: estimate.format.template_id === null ? null : {
          id: estimate.format.template_id,
          name: estimate.format.template_name ?? estimate.format.template_id,
          revision: estimate.format.revision,
        },
      } as const
      pageEstimate = estimate.total > 0
        ? { status: 'available', pages: Math.ceil(estimate.total), ...basis }
        : { status: 'empty', ...basis }
      const criterion = writingPlan?.document_acceptance.find(item =>
        item.evaluator.kind === 'deterministic' && item.evaluator.metric === 'estimated_pages')
      if (criterion?.evaluator.kind === 'deterministic') {
        const target = {
          kind: criterion.evaluator.min === null ? 'maximum' as const
            : criterion.evaluator.max === null ? 'minimum' as const : 'range' as const,
          min_pages: criterion.evaluator.min,
          max_pages: criterion.evaluator.max,
          estimate_basis: 'Host estimated_pages metric',
        }
        const assessment = assessBoundedMetric(criterion.evaluator.min, criterion.evaluator.max, estimate.total)
        pageTarget = {
          status: assessment.status,
          target,
          estimated_pages: estimate.total,
          difference: assessment.difference,
          format_revision: estimate.format.revision,
          format_source: estimate.format.source,
          format_template_id: estimate.format.template_id,
          estimate_method: estimate.method,
        }
      }
      const children = new Set(outline.sections.flatMap(section => section.parent_id === null ? [] : [section.parent_id]))
      rows = rows.map((row) => {
        if (!children.has(row.section_id)) return row
        const section = estimate.sections.get(row.section_id)
        const sectionBasis = { ...basis, method: 'fast' as const }
        if (section === undefined || !section.hasContent) return { ...row, page_estimate: { status: 'empty' as const, ...sectionBasis } }
        return { ...row, page_estimate: { status: 'available' as const, pages: Math.ceil(section.pages),
          ...sectionBasis, ...(section.incomplete ? { incomplete: true } : {}) } }
      })
    } catch { rows = rows.map(row => ({
      ...row,
      ...(outline.sections.some(section => section.parent_id === row.section_id) ? { page_estimate: { status: 'unavailable' as const } } : {}),
    })) }
    const writable = rows.filter(row => row.writable)
    let globalCompliance: BidReviewWorkbenchView['global_compliance'] = outline.global_compliance_ids.length === 0
      ? { status: 'not_required', reviewed_count: 0, total_count: 0, document_issues: [], delivery_todos: [] }
      : { status: 'reviewing', reviewed_count: 0, total_count: outline.global_compliance_ids.length, document_issues: [], delivery_todos: [] }
    if (outline.global_compliance_ids.length > 0) {
      try {
        const [report, compliance, bidManifest] = await Promise.all([
          readFile(within(workspace.projectRoot, 'chapters/global-compliance-review.json'), 'utf8')
            .then(value => parseGlobalComplianceReviewArtifact(JSON.parse(value))),
          readFile(within(workspace.projectRoot, 'analysis/compliance.json'), 'utf8')
            .then(value => parseTenderComplianceArtifact(JSON.parse(value))),
          workspace.readManifest(),
        ])
        const globalChapters: GlobalComplianceChapter[] = rowContents.flatMap(({ row, markdown }) => (
          row.writable && row.content_available
            ? [{ section_id: row.section_id, title: row.title, markdown, candidate_sha256: chapterCandidateSha256(markdown) }]
            : []
        ))
        const globalReviewChapters: GlobalComplianceChapter[] = []
        for (const chapter of globalChapters) {
          const expectedHashes = [...new Set(report.items.flatMap(item => item.checked_chapters
            .filter(checked => checked.section_id === chapter.section_id).map(checked => checked.candidate_sha256)))]
          if (expectedHashes.length > 1) throw new Error('stale-global-compliance-review')
          const expected = expectedHashes[0] ?? chapter.candidate_sha256
          if (expected === chapter.candidate_sha256) {
            globalReviewChapters.push(chapter)
            continue
          }
          const index = worklist.findIndex(section => section.id === chapter.section_id)
          if (index < 0) throw new Error('stale-global-compliance-review')
          const assigned = locations.get(chapter.section_id)
          if (assigned === undefined) throw new Error('stale-global-compliance-review')
          const serial = String(assigned.storageSerial).padStart(4, '0')
          const semantic = await resolveSemanticRevisionPath(
            workspace, serial, chapter.section_id, expected, chapter.candidate_sha256,
          )
          if (!semantic.valid || semantic.from_markdown === undefined) throw new Error('stale-global-compliance-review')
          globalReviewChapters.push({ ...chapter, markdown: semantic.from_markdown, candidate_sha256: expected })
        }
        if (report.confirmed_outline_sha256 !== outlineArtifactSha256(outline)
          || validateGlobalComplianceReview(report, outline, compliance, globalReviewChapters, bidManifest).length > 0) {
          throw new Error('stale-global-compliance-review')
        }
        const findings = report.items.flatMap(item => item.status === 'fail' || item.status === 'pending' ? [{
          compliance_id: item.compliance_id,
          status: item.status,
          detail: item.issue ?? item.item,
          affected_section_ids: item.affected_section_ids,
          delivery: item.category === 'delivery_requirement' || item.owners.some(owner => owner.kind === 'delivery'),
        }] : [])
        globalCompliance = {
          status: findings.length === 0 ? 'pass' : 'needs_attention',
          reviewed_count: report.items.length,
          total_count: outline.global_compliance_ids.length,
          document_issues: findings.filter(item => !item.delivery).map(({ delivery: _delivery, ...item }) => item),
          delivery_todos: findings.filter(item => item.delivery).map(({ delivery: _delivery, ...item }) => item),
        }
      } catch { /* S5 写作或文档级核验尚未形成当前版本结果。 */ }
    }
    if (schemaWarningAppended) {
      await this.ctx.sessions.flush(session)
    }
    return {
      schema_version: 6,
      outline: rows,
      summary: {
        chapter_count: writable.length,
        content_count: writable.filter(row => row.content_available).length,
        reviewed_count: writable.filter(row => row.review_status === 'pass' || row.review_status === 'needs_input'
          || row.review_status === 'needs_attention').length,
        needs_attention_count: writable.filter(row => row.review_status === 'needs_input'
          || row.review_status === 'needs_attention' || row.review_status === 'failed').length,
        page_estimate: pageEstimate,
        page_target: pageTarget,
      },
      global_compliance: globalCompliance,
      ...(revisionBatchSummary !== undefined ? { revision_batch: revisionBatchSummary } : {}),
    }
  }

  /**
   * 读取 S5 叶节正文及审查结果，或父节点在确认目录中保存的概述。
   * @param session 持有章节产物的 Bid 会话。
   * @param sectionId 确认目录中的章节 ID。
   * @returns 浏览器可展示的章节正文、证据和审查状态。
   */
  @Remote('getReviewChapter')
  async getReviewChapter(session: Session, sectionId: string): Promise<BidReviewChapterView> {
    const workspace = this.requireReviewWorkspace(session)
    const outlinePath = within(workspace.projectRoot, 'outline/confirmed-outline.json')
    await assertNoLinkedPath(workspace.root, outlinePath)
    const outlineRaw = await readFile(outlinePath, 'utf8')
    const outline = parseOutlineArtifact(JSON.parse(outlineRaw))
    const section = outline.sections.find(item => item.id === sectionId)
    if (section === undefined) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    const chain = reviewHeadingPath(outline, section.id)
    if (!section.writable) return { section_id: section.id, title: normalizeOutlineSectionTitle(section.title) || section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: false, markdown: section.summary ?? null, flowcharts: [], content_sha256: null, requirement_ids: [], scoring_response_point_ids: [], evidence_status: 'not_applicable', review: { status: 'not_started', issues: [] } }
    const index = buildChapterWorklist(outline).findIndex(item => item.id === section.id)
    if (index < 0) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    const assigned = await readChapterLocation(workspace, section.id)
    const serial = assigned === null ? null : String(assigned.storageSerial).padStart(4, '0')
    let markdown: string | null = null
    if (assigned !== null) {
      try { markdown = await readFile(within(workspace.projectRoot, assigned.contentPath), 'utf8') } catch { markdown = null }
    }
    let flowcharts: import('./flowchart.ts').FlowchartSpec[] = []
    if (assigned !== null) try {
      const metadata = parseChapterMetadata(JSON.parse(await readFile(within(workspace.projectRoot, assigned.metadataPath), 'utf8')))
      flowcharts = metadata.flowcharts.filter(flowchart => validateFlowchartSpec(flowchart).length === 0)
    } catch { /* 旧章节没有流程图 metadata，或章节仍在写作。 */ }
    const logPath = within(workspace.projectRoot, 'chapters/execution-log.json')
    await assertNoLinkedPath(workspace.root, logPath)
    let execution: ChapterExecutionLog['sections'][number] | undefined
    try {
      execution = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8'))).sections.find(item => item.section_id === section.id)
    } catch { /* S5 初始化时执行日志可能尚不可用。 */ }
    let artifact: ChapterReviewArtifact | undefined
    if (assigned !== null) try {
      artifact = parseChapterReviewArtifact(JSON.parse(await readFile(within(workspace.projectRoot, assigned.reviewPath), 'utf8')))
    } catch { /* 章节可能仍在写作，或已保存报告暂不可用。 */ }
    if (artifact !== undefined && (markdown === null || serial === null
      || !await chapterReviewMatches(workspace, serial, section.id, markdown, artifact))) {
      artifact = undefined
    }
    const review = projectChapterReview(section.id, artifact, execution)
    let evidenceStatus: BidReviewChapterView['evidence_status'] = 'missing'
    let materials: BidReviewMaterialView[] = []
    try {
      const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(within(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      const mapping = evidence.section_mappings.find(item => item.section_id === section.id)
      evidenceStatus = mapping !== undefined && mapping.local_materials.length + mapping.web_materials.length > 0 ? 'available' : 'missing'
      if (mapping !== undefined) {
        materials = [
          ...mapping.local_materials.map(m => ({
            source_kind: m.source_kind,
            source_label: m.source_kind === 'reference_bid' ? '参考旧标' : '技术资料',
            file_id: m.file_id,
            usage: m.usage,
            summary: m.summary,
          })),
          ...mapping.web_materials.map(m => ({
            source_kind: 'web' as const,
            source_label: '公开资料',
            file_id: m.source_id,
            usage: m.usage,
            summary: m.summary,
          })),
        ]
      }
    } catch { evidenceStatus = 'missing' }
    return { section_id: section.id, title: normalizeOutlineSectionTitle(section.title) || section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: true, markdown, flowcharts, content_sha256: markdown === null ? null : chapterContentSha256(markdown), requirement_ids: section.requirement_ids, scoring_response_point_ids: section.scoring_response_point_ids ?? [], evidence_status: evidenceStatus, materials, review }
  }

  /** Admit the S5 workbench while writing is running or after its last result. */
  private requireReviewWorkspace(session: Session): BidWorkspace {
    if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
    return new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
  }

  /** 读取当前章节正文与可写性；审批意见队列与单次修订共用。 */
  private async readChapterMarkdownForRevision(
    workspace: BidWorkspace,
    sectionId: string,
  ): Promise<{ section: OutlineArtifact['sections'][number]; markdown: string; serial: string }> {
    const outline = (await confirmedOutline(workspace)).outline
    const section = outline.sections.find(item => item.id === sectionId)
    if (section === undefined) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    if (!section.writable) throw new Error('BID_CHAPTER_REVISION_NOT_WRITABLE')
    const index = buildChapterWorklist(outline).findIndex(item => item.id === sectionId)
    if (index < 0) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    const assigned = await readChapterLocation(workspace, sectionId)
    if (assigned === null) throw new Error(`BID_CHAPTER_STORAGE_LOCATION_MISSING: ${sectionId}`)
    const serial = String(assigned.storageSerial).padStart(4, '0')
    const markdown = await readFile(within(workspace.projectRoot, assigned.contentPath), 'utf8')
    return { section, markdown, serial }
  }

  /** 把持久化队列投影为浏览器安全视图。 */
  private projectRevisionQueueView(queue: RevisionQueueArtifact): BidRevisionQueueView {
    return {
      schema_version: 1,
      revision: queue.revision,
      issues: queue.issues.map(issue => ({
        issue_id: issue.issue_id,
        section_id: issue.section_id,
        section_title: issue.section_title,
        scope: issue.scope,
        reference: issue.reference,
        instruction: issue.instruction,
        suggestion: issue.suggestion,
        status: issue.status,
        batch_id: issue.batch_id,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      })),
    }
  }

  /** 在项目锁内执行审批意见队列变更并返回浏览器安全视图。 */
  private async executeRevisionQueueMutation(
    session: Session,
    expectedRevision: number | undefined,
    mutate: (queue: RevisionQueueArtifact, workspace: BidWorkspace) => RevisionQueueArtifact | Promise<RevisionQueueArtifact>,
  ): Promise<BidRevisionQueueResult> {
    const reject = (code: BidRevisionQueueErrorCode, message: string): BidRevisionQueueResult =>
      ({ ok: false, error: { code, message } })
    if (!isBidMainSession(session)) return reject('BID_SESSION_REQUIRED', '审批意见需要标书项目会话。')
    if (this.inFlight.has(projectKey(session))) return reject('BID_OPERATION_IN_PROGRESS', '当前项目仍有操作正在执行。')
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('revise_chapter')) {
        return reject('BID_REVISION_QUEUE_NOT_ALLOWED', '正文编写完成后才能收集审批意见。')
      }
      const queue = await commitRevisionQueueMutation(operation.workspace, expectedRevision, current =>
        mutate(current, operation.workspace))
      return { ok: true, value: this.projectRevisionQueueView(queue) }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : ''
      if (reason.includes('BID_REVISION_QUEUE_CONFLICT')) return reject('BID_REVISION_QUEUE_CONFLICT', '审批意见队列已被更新，请刷新后重试。')
      if (reason.includes('BID_REVISION_ISSUE_NOT_FOUND')) return reject('BID_REVISION_ISSUE_NOT_FOUND', '审批意见不存在或已被删除。')
      if (reason.includes('BID_REVISION_ISSUE_NOT_EDITABLE')) return reject('BID_REVISION_ISSUE_NOT_EDITABLE', '只有待处理意见可以编辑。')
      if (reason.includes('BID_REVISION_ISSUE_NOT_DELETABLE')) return reject('BID_REVISION_ISSUE_NOT_DELETABLE', '只有待处理意见可以删除。')
      if (reason.includes('BID_REVISION_ISSUE_SCOPE_MISMATCH')) return reject('BID_REVISION_ISSUE_SCOPE_MISMATCH', '选区类型与引用类型不一致。')
      if (reason.includes('BID_REVISION_ISSUE_INSTRUCTION_EMPTY')) return reject('BID_REVISION_ISSUE_INSTRUCTION_EMPTY', '修改意见不能为空。')
      if (reason.includes('BID_CHAPTER_REVISION_CONFLICT')) return reject('BID_CHAPTER_REVISION_CONFLICT', '章节正文已变化，请重新选择章节或段落。')
      if (reason.includes('BID_CHAPTER_REVISION_SELECTION_INVALID')) return reject('BID_CHAPTER_REVISION_SELECTION_INVALID', '请选择同一章节中的一个或相邻多个完整段落。')
      if (reason.includes('BID_CHAPTER_REVISION_NOT_WRITABLE')) return reject('BID_CHAPTER_REVISION_NOT_WRITABLE', '目录分组标题不能编写，请选择有正文的章节。')
      if (reason.includes('BID_REVIEW_SECTION_UNKNOWN')) return reject('BID_REVIEW_SECTION_UNKNOWN', '章节不存在或尚未生成正文。')
      return reject('BID_REVISION_ISSUE_INVALID', '审批意见校验未通过，请重新选择章节或段落。')
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /**
   * 读取当前审批意见队列；不持有项目锁，仅读取持久化文件。
   * @param session Bid 会话。
   * @returns 浏览器安全的审批意见队列视图。
   */
  @Remote('getRevisionQueue')
  async getRevisionQueue(session: Session): Promise<BidRevisionQueueView> {
    const workspace = this.requireReviewWorkspace(session)
    const queue = await readRevisionQueue(workspace)
    return this.projectRevisionQueueView(queue)
  }

  /**
   * 读取一条已完成审批意见所属 batch task 的完整前后正文。
   * @param session Bid 会话。
   * @param issueId 审批意见身份。
   * @returns 精确历史 comparison；旧记录不伪造缺失快照。
   */
  @Remote('getRevisionComparison')
  async getRevisionComparison(session: Session, issueId: string): Promise<BidRevisionComparisonResult> {
    const workspace = this.requireReviewWorkspace(session)
    try {
      const queue = await readRevisionQueue(workspace)
      const issue = queue.issues.find(candidate => candidate.issue_id === issueId)
      if (issue === undefined) {
        return { ok: false, error: { code: 'BID_REVISION_COMPARISON_NOT_FOUND', message: '未找到该审批意见。' } }
      }
      if (issue.status !== 'completed' || issue.batch_id === null) {
        return { ok: false, error: { code: 'BID_REVISION_COMPARISON_NOT_AVAILABLE', message: '该审批意见没有可用的成功修订快照。' } }
      }
      const batch = await readRevisionBatch(workspace, issue.batch_id)
      if (batch === null) {
        return { ok: false, error: { code: 'BID_REVISION_COMPARISON_NOT_FOUND', message: '未找到该审批意见所属批次。' } }
      }
      const tasks = batch.tasks.filter(task => task.issue_ids.includes(issue.issue_id))
      if (tasks.length !== 1) throw new Error('BID_REVISION_COMPARISON_CORRUPT')
      const task = tasks[0]
      if (task === undefined || task.section_id !== issue.section_id || task.status !== 'completed') {
        throw new Error('BID_REVISION_COMPARISON_CORRUPT')
      }
      const comparison = await readRevisionComparison(workspace, batch.batch_id, task.task_id)
      if (comparison === null) {
        return {
          ok: false,
          error: {
            code: 'BID_REVISION_COMPARISON_NOT_AVAILABLE',
            message: '该修复记录创建于历史对比快照功能启用前，无法还原完整修改前版本。',
          },
        }
      }
      if (comparison.batch_id !== batch.batch_id
        || comparison.task_id !== task.task_id
        || comparison.section_id !== task.section_id
        || JSON.stringify(comparison.issue_ids) !== JSON.stringify(task.issue_ids)) {
        throw new Error('BID_REVISION_COMPARISON_CORRUPT')
      }
      return {
        ok: true,
        value: {
          issue_id: issue.issue_id,
          batch_id: comparison.batch_id,
          task_id: comparison.task_id,
          section_id: comparison.section_id,
          section_title: issue.section_title,
          before_markdown: comparison.before_markdown,
          after_markdown: comparison.after_markdown,
          before_sha256: comparison.before_sha256,
          after_sha256: comparison.after_sha256,
        },
      }
    } catch {
      return { ok: false, error: { code: 'BID_REVISION_COMPARISON_CORRUPT', message: '该修复记录的历史对比快照已损坏。' } }
    }
  }

  /**
   * 向队列追加一条 `pending` 审批意见；不启动任何 Writer。
   * @param session Bid 会话。
   * @param request 浏览器提交的意见输入。
   * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
   */
  @Remote('addRevisionIssue')
  async addRevisionIssue(session: Session, request: BidAddRevisionIssueRequest): Promise<BidRevisionQueueResult> {
    const parsed = revisionIssueSchema.safeParse({
      issue_id: 'pending',
      section_id: request.section_id,
      section_title: 'pending',
      scope: request.scope,
      reference: request.reference,
      instruction: request.instruction,
      suggestion: request.suggestion,
      status: 'pending',
      batch_id: null,
      created_at: 0,
      updated_at: 0,
    })
    if (!parsed.success) return { ok: false, error: { code: 'BID_REVISION_ISSUE_INVALID', message: '审批意见校验未通过，请重新选择章节或段落。' } }
    return this.executeRevisionQueueMutation(session, undefined, async (queue, workspace) => {
      const { section, markdown } = await this.readChapterMarkdownForRevision(workspace, request.section_id)
      validateRevisionIssueReference(request.reference, markdown)
      return addRevisionIssueToQueue(queue, {
        section_id: request.section_id,
        scope: request.scope,
        reference: request.reference,
        instruction: request.instruction,
        suggestion: request.suggestion,
      }, section.title, Date.now())
    })
  }

  /**
   * 编辑一条 `pending` 审批意见的 instruction/suggestion/reference。
   * @param session Bid 会话。
   * @param request 浏览器提交的编辑输入。
   * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
   */
  @Remote('updateRevisionIssue')
  async updateRevisionIssue(session: Session, request: BidUpdateRevisionIssueRequest): Promise<BidRevisionQueueResult> {
    return this.executeRevisionQueueMutation(session, request.expected_queue_revision, async (queue, workspace) => {
      const current = queue.issues.find(issue => issue.issue_id === request.issue_id)
      if (current === undefined) throw new Error('BID_REVISION_ISSUE_NOT_FOUND')
      if (current.status !== 'pending') throw new Error('BID_REVISION_ISSUE_NOT_EDITABLE')
      const nextScope = request.scope ?? current.scope
      const nextReference = request.reference ?? current.reference
      if (nextScope !== nextReference.scope) throw new Error('BID_REVISION_ISSUE_SCOPE_MISMATCH')
      const instruction = request.instruction !== undefined ? request.instruction.trim() : current.instruction
      if (instruction.length === 0) throw new Error('BID_REVISION_ISSUE_INSTRUCTION_EMPTY')
      if (request.reference !== undefined) {
        const { markdown } = await this.readChapterMarkdownForRevision(workspace, current.section_id)
        validateRevisionIssueReference(request.reference, markdown)
      }
      return updateRevisionIssueInQueue(queue, request, Date.now())
    })
  }

  /**
   * 物理删除一条 `pending` 审批意见；其他状态拒绝浏览器直接删除。
   * @param session Bid 会话。
   * @param request 浏览器提交的删除输入。
   * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
   */
  @Remote('deleteRevisionIssue')
  async deleteRevisionIssue(session: Session, request: BidDeleteRevisionIssueRequest): Promise<BidRevisionQueueResult> {
    return this.executeRevisionQueueMutation(session, request.expected_queue_revision, queue =>
      deleteRevisionIssueFromQueue(queue, request))
  }

  /**
   * 读取有效能力计划，导出尾步骤的完成状态来自正式导出回执。
   * @param session 项目公开主会话。
   * @returns 最近任务的只读摘要；尚无能力任务或历史任务已清理时为 null。
   */
  @Remote('getCapabilityTaskPlan')
  async getCapabilityTaskPlan(session: Session): Promise<BidCapabilityPlanView | null> {
    if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const task = bidSessionTaskState(session)
    const current = task.status === 'running' || task.status === 'suspended' ? task.run : null
    if (current?.work.kind !== 'capability_task') {
      for (const workId of await pendingCapabilityWorkIds(workspace)) {
        const pending = (await readPendingCapabilityRequests(workspace, workId))[0]
        if (pending === undefined || pending.request.authorization.session_id !== String(session.id)) continue
        return { workId: pending.request.queue_id, title: pending.request.task.goal,
          scope: pending.request.task.scope.kind === 'project' ? 'project'
            : pending.request.task.scope.kind === 'sections' ? pending.request.task.scope.section_ids.join(', ')
              : pending.request.task.scope.reference.section_id,
          status: 'queued', steps: pending.request.task.steps.map((step, index) => ({
            id: `${pending.request.queue_id}:${index}`, capability: step.call.capability, description: step.description,
            status: 'pending', detail: null,
          })) }
      }
    }
    const lastStarted = session.events.findLast(event => event.type === 'bid.run.started' && event.data.run.work.kind === 'capability_task')
    const run = current?.work.kind === 'capability_task' ? current
      : lastStarted?.type === 'bid.run.started' && lastStarted.data.run.work.kind === 'capability_task'
        ? lastStarted.data.run : null
    if (run !== null) {
      let requestValue: unknown
      try { requestValue = await readBidWorkRequest(workspace, run.work) }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current?.work.kind !== 'capability_task') return null
        throw error
      }
      const request = capabilityTaskRequestSchema.parse(requestValue)
      const path = within(workspace.projectRoot, `runs/${run.work.workId}/task-checkpoint.json`)
      await assertNoLinkedPath(workspace.root, path)
      let checkpoint: ReturnType<typeof capabilityTaskCheckpointSchema.parse> | null = null
      try { checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (checkpoint !== null && (checkpoint.work_id !== run.work.workId
        || checkpoint.request_sha256 !== run.work.requestSha256)) {
        throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
      }
      const publication = await readCapabilityPublicationRecord(workspace, run.work.workId, run.work.requestSha256)
      const steps = checkpoint?.steps ?? (request.complete_task ?? request.task).steps.map((step, index) => ({
        step_id: `${run.work.workId}:${index}`, step, status: 'pending' as const,
      }))
      const completed = session.events.some(event => event.type === 'bid.run.completed'
        && event.data.run.runId === run.runId && event.data.run.work.workId === run.work.workId)
        && steps.every(record => record.status === 'completed'
          || record.step.call.capability === 'docx.export' && publication?.export_receipt !== undefined)
        && publication?.goal_met !== false
      const status: BidCapabilityPlanView['status'] = current?.work.workId === run.work.workId
        ? task.status === 'suspended'
          ? task.run.cause === 'awaiting_input' ? 'awaiting_input' : 'suspended'
          : 'running'
        : completed ? 'completed'
          : this.docxInFlight.has(projectKey(session)) && publication?.verification?.deferred_export === true
            ? 'running' : 'failed'
      const firstUnfinished = steps.findIndex(step => step.status !== 'completed')
      return {
        workId: run.work.workId, title: request.task.goal,
        scope: request.task.scope.kind === 'project' ? 'project'
          : request.task.scope.kind === 'sections' ? request.task.scope.section_ids.join(', ')
            : request.task.scope.reference.section_id,
        status,
        steps: steps.map((record, index) => ({
          id: record.step_id, capability: record.step.call.capability, description: record.step.description,
          status: record.step.call.capability === 'docx.export' && publication?.export_receipt !== undefined
            ? 'completed' : index === firstUnfinished && (status === 'failed' || status === 'awaiting_input')
              ? status : status === 'suspended' && record.status === 'running' ? 'suspended' as const : record.status,
          detail: [
            ...'result' in record ? [record.result.change_summary, ...record.result.missing_topics, ...record.result.warnings] : [],
            ...task.status === 'suspended' && current?.work.workId === run.work.workId
              && index === firstUnfinished
              ? [task.run.error?.message ?? '当前任务已暂停，等待继续执行。'] : [],
          ].join('；') || null,
        })),
      }
    }
    return null
  }

  /**
   * 读取当前阶段或当前能力 Work 的资料研究进度与诊断。
   * @param session 研究 Work 所属公开会话。
   * @param observed 调用方观察到的项目状态，用于拒绝过期读取。
   * @returns 对应执行日志的统计；尚无日志或身份不匹配时为 null。
   */
  @Remote('getEvidenceMappingProgress')
  async getEvidenceMappingProgress(
    session: Session,
    observed?: BidClientProjection,
  ): Promise<BidEvidenceMappingProgress | null> {
    if (!isBidMainSession(session)) throw new Error('Bid Session with a workspace is required.')
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const { task, observedMatches } = await this.syncEvidenceMappingProjection(session, workspace, observed)
    if (!observedMatches) return null
    const completed = bidCompletedCapabilityRun(session, task)
    const latestRun = session.events.findLast(event => event.type === 'bid.run.started')
    const current = task.status === 'running' || task.status === 'suspended' ? task.run
      : bidRecoverableRun(session, task) ?? (latestRun?.data.run.runId === completed?.runId ? completed : undefined)
    let source = workspace
    if (current?.work.kind === 'capability_task') {
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, current.work))
      if (request.authorization.session_id !== String(session.id)) return null
      const candidate = await activeCapabilityMappingWorkspace(workspace, current.work)
      if (candidate === null) return null
      source = candidate
    } else if (task.stage !== 'evidence_mapping' || task.status === 'ready') return null
    const details = await this.getDetails(session)
    return readEvidenceMappingProgress(source, { outline: details.outline, evidence: details.outlinePresentation?.evidence ?? null })
  }

  /**
   * 组装 Bid 详情页可读取的已发布阶段产物。
   * @param session 持有已恢复项目状态的 Bid 会话。
   * @returns 已发布的招标信息、目录和正文入口；S4 等待确认时使用已生成目录，执行中保留 S3 确认目录。
   */
  @Remote('getDetails')
  async getDetails(session: Session): Promise<BidDetailsView> {
    if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
    await this.reconcileDocxExport(session)
    const task = bidSessionTaskState(session)
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const body = (await readChapterLocations(workspace)).size > 0
    const confirmedPath = within(workspace.projectRoot, 'outline/confirmed-outline.json')
    await assertNoLinkedPath(workspace.root, confirmedPath)
    let confirmedExists = false
    try { await readFile(confirmedPath); confirmedExists = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const finalOutline = confirmedExists || (task.stage === 'evidence_mapping' && task.status === 'completed')
    const reviewingOutline = task.stage === 'evidence_mapping' && task.status === 'waiting_user'
    const initialOutline = task.stage === 'evidence_mapping' || (task.stage === 'outline_generation' && task.status === 'completed')
    const tenderReady = task.stage !== 'file_intake' && (task.stage !== 'tender_analysis' || task.status === 'waiting_user' || task.status === 'completed')
    const [tender, outline] = await Promise.all([
      tenderReady ? this.getTenderAnalysisForConfirmation(session) : null,
      finalOutline || initialOutline
        ? readStageJson(workspace, finalOutline ? 'outline/confirmed-outline.json' : reviewingOutline ? 'outline/outline.json' : 'outline/initial-confirmed-outline.json').then(parseOutlineArtifact)
        : null,
    ])
    const source = finalOutline ? 'final_confirmed' : reviewingOutline ? 'final_candidate' : 'initial_confirmed'
    const errors: string[] = []
    const readContext = async <T>(artifact: string, parse: (value: unknown) => T): Promise<T | null> => {
      let value: T
      try { value = parse(await readStageJson(workspace, artifact)) } catch (error) {
        errors.push(`${artifact} 读取失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      return value
    }
    const [baseline, evidence] = finalOutline || reviewingOutline ? await Promise.all([
      readContext('outline/initial-confirmed-outline.json', parseOutlineArtifact),
      readContext('analysis/evidence-map.json', parseEvidenceMapArtifact),
    ]) : [null, null]
    const writingRequest = task.stage === 'chapter_writing' && !await hasCurrentWritingPlan(workspace)
      ? (await readWritingRequest(workspace)) ?? null
      : null
    return { tender, outline, body, outlinePresentation: outline === null ? null : { source, baseline, evidence, errors }, writingRequest }
  }

  /**
   * 读取 S2 待确认或已确认结论；编辑准入仍由 confirmTenderAnalysis 校验。
   * @param session 持有招标分析产物的 Bid 会话。
   * @returns 分析产物及评分响应项选择状态。
   */
  @Remote('getTenderAnalysisForConfirmation')
  async getTenderAnalysisForConfirmation(session: Session): Promise<TenderAnalysisConfirmationView> {
    if (!isBidMainSession(session)) throw new Error('Bid Session with a workspace is required.')
    const task = bidSessionTaskState(session)
    if (task.stage === 'file_intake' || (task.stage === 'tender_analysis' && task.status !== 'waiting_user' && task.status !== 'completed')) throw new Error('Tender-analysis details are not available in the current Bid stage state.')
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    return readTenderAnalysisConfirmationView(workspace)
  }

  /**
   * Persist one S2 scoring-response decision before final confirmation.
   * @param session Bid Session waiting at the S2 confirmation gate.
   * @param scoringId Stable original scoring item id.
   * @param selected Whether the item enters the downstream response workflow.
   * @returns Updated S2 confirmation view.
   */
  @Remote('setTenderScoringSelection')
  async setTenderScoringSelection(
    session: Session,
    scoringId: string,
    selected: boolean,
  ): Promise<TenderAnalysisConfirmationView> {
    if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
    if (this.inFlight.has(projectKey(session))) throw new Error('BID_OPERATION_IN_PROGRESS')
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_tender_analysis')) throw new Error('BID_CONFIRM_NOT_ALLOWED')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const current = await readTenderAnalysisConfirmationView(workspace)
      const next = setTenderScoringSelection(current, scoringId, selected)
      const selectionPath = within(workspace.projectRoot, 'analysis/tender-analysis-selection.json')
      await assertNoLinkedPath(workspace.root, selectionPath)
      await this.mutateProject(operation, lease => lease.writeJson(selectionPath, {
        schema_version: 1,
        selected_scoring_ids: next.selected_scoring_ids,
      }))
      return next
    } finally { await this.finishOperation(session, operation) }
  }

  /**
   * Apply controlled S2 edits, revalidate canonical artifacts, and continue only after explicit confirmation.
   * @param session Bid Session waiting at the S2 confirmation gate.
   * @param operations Validated edits to canonical tender-analysis artifacts.
   * @returns Confirmation result and resulting runtime state, or a stable rejection.
   */
  @Remote('confirmTenderAnalysis')
  async confirmTenderAnalysis(
    session: Session,
    operations: readonly TenderAnalysisEditOperation[],
  ): Promise<BidTenderAnalysisConfirmationResult> {
    if (!isBidMainSession(session)) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Tender-analysis confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_tender_analysis')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Tender-analysis confirmation is not allowed in the current Bid stage state.' } }
      const agent = await this.executionAgent(operation, runtime.stage)
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const projectPath = within(workspace.projectRoot, 'analysis/project.json')
      const requirementsPath = within(workspace.projectRoot, 'analysis/requirements.json')
      const scoringPath = within(workspace.projectRoot, 'analysis/scoring.json')
      const compliancePath = within(workspace.projectRoot, 'analysis/compliance.json')
      await Promise.all([projectPath, requirementsPath, scoringPath, compliancePath].map(path => assertNoLinkedPath(workspace.root, path)))
      const source = await readTenderAnalysisConfirmationView(workspace)
      let candidate: TenderAnalysisConfirmationView
      try {
        candidate = applyTenderAnalysisEdits(
          source,
          parseTenderAnalysisEditOperations(operations),
        )
      } catch (error: unknown) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The requested tender-analysis edits are invalid.', issues: [{ code: 'TENDER_ANALYSIS_EDIT_INVALID', message: error instanceof Error ? error.message : 'The requested tender-analysis edits are invalid.' }] } }
      }
      const validationIssues = await validateTenderAnalysisCandidate(workspace, {
        project: candidate.project,
        requirements: candidate.requirements,
        scoring: candidate.scoring,
        compliance: candidate.compliance,
      })
      if (validationIssues.length > 0) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The edited tender analysis does not satisfy S2 validation.', issues: validationIssues } }
      }
      await this.mutateProject(operation, async (lease) => {
        await lease.writeJson(projectPath, candidate.project)
        await lease.writeJson(requirementsPath, candidate.requirements)
        await lease.writeJson(scoringPath, createConfirmedTenderScoring(candidate))
        await lease.writeJson(compliancePath, candidate.compliance)
        await Promise.all([
          'analysis/scoring-response-points.candidate.json',
          'analysis/scoring-response-points.json',
          'outline/generation-inputs.json',
          'outline/outline.json',
          'outline/quality-report.json',
          'outline/initial-confirmed-outline.json',
        ].map(async (relative) => {
          const path = within(workspace.projectRoot, relative)
          await assertNoLinkedPath(workspace.root, path)
          await lease.remove(path)
        }))
      })
      const artifacts: StageArtifact[] = [
        { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
        { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
        { stage: 'tender_analysis', type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
        { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
      ]
      const validation = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
      if (!validation.ok) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The edited tender analysis does not satisfy S2 validation.', issues: validation.issues } }
      }
      const confirmation = await this.automaticOrchestrator(agent, workspace, operation.controller.signal, operation).confirmValidatedStage('tender_analysis', artifacts)
      if (!confirmation.ok) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The edited tender analysis does not satisfy S2 validation.', issues: confirmation.validation.issues } }
      }
      await this.ctx.sessions.flush(session)
      return { ok: true, value: confirmation.state }
    } catch {
      return { ok: false, error: { code: 'BID_CONFIRM_FAILED', message: 'The Bid Host could not confirm the tender analysis.' } }
    } finally { await this.finishOperation(session, operation) }
  }

  /**
   * Read the S4 draft only while its user-confirmation stage owns the session.
   * @param session Bid Session waiting for outline confirmation.
   * @returns Current editable outline artifact.
   */
  @Remote('getOutlineForConfirmation')
  async getOutlineForConfirmation(session: Session): Promise<OutlineArtifact> {
    return (await this.getOutlineDraft(session)).outline
  }

  /**
   * 读取或初始化 S3/S4 等待用户确认的持久化 Draft。
   * @param session 等待目录确认的 Bid 会话。
   * @returns 当前 Draft 及用于 CAS 编辑的身份。
   */
  @Remote('getOutlineDraft')
  async getOutlineDraft(session: Session): Promise<OutlineDraftView> {
    if (!isBidMainSession(session)) throw new Error('Bid Session with a workspace is required.')
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) await active.done
    const workspace = new BidWorkspace(key, workspaceConfig(this.config))
    const state = await readBidProjectState(workspace)
    const task = state === undefined ? BID_INITIAL_TASK_STATE : bidProjectTaskState(state)
    if ((task.stage !== 'outline_generation' && task.stage !== 'evidence_mapping') || task.status !== 'waiting_user') throw new Error('Outline confirmation is not allowed in the current Bid stage state.')
    return getOrCreateOutlineDraft(workspace)
  }

  /**
   * 读取目录差异审阅所需的上游事实和基线。
   * @param session 等待目录确认的 Bid 会话。
   * @returns S3 确认基线及已有章节关联资料；不运行生成或映射。
   */
  @Remote('getOutlineReviewContext')
  async getOutlineReviewContext(session: Session): Promise<OutlineReviewContext> {
    if (!isBidMainSession(session)) throw new Error('Bid Session with a workspace is required.')
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) await active.done
    const workspace = new BidWorkspace(key, workspaceConfig(this.config))
    const state = await readBidProjectState(workspace)
    const task = state === undefined ? BID_INITIAL_TASK_STATE : bidProjectTaskState(state)
    if ((task.stage !== 'outline_generation' && task.stage !== 'evidence_mapping') || task.status !== 'waiting_user') throw new Error('Outline review is not allowed in the current Bid stage state.')
    const [requirements, scoring, baseline, evidence] = await Promise.all([
      readStageJson(workspace, 'analysis/requirements.json').then(parseTenderRequirementsArtifact),
      readStageJson(workspace, 'analysis/scoring.json').then(parseTenderScoringArtifact),
      task.stage === 'evidence_mapping' ? readStageJson(workspace, 'outline/initial-confirmed-outline.json').then(parseOutlineArtifact) : null,
      task.stage === 'evidence_mapping' ? readStageJson(workspace, 'analysis/evidence-map.json').then(parseEvidenceMapArtifact) : null,
    ])
    return { requirements, scoring, baseline, evidence }
  }

  /**
   * 使用 CAS 保存目录编辑；仅校验结构和覆盖，S4 语义复核留到最终确认。
   * @param session 等待目录确认的 Bid 会话。
   * @param request 携带 Draft 身份的结构编辑操作。
   * @returns 更新后的 Draft，或冲突及校验问题。
   */
  @Remote('applyOutlineDraftOperations')
  async applyOutlineDraftOperations(session: Session, request: OutlineDraftMutationRequest): Promise<OutlineDraftMutationResult> {
    if (!isBidMainSession(session)) throw new Error('Bid Session with a workspace is required.')
    if (this.inFlight.has(projectKey(session))) throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前阶段已有操作正在执行。')
    const operation = this.beginOperation(session)
    try {
      const task = await this.prepareOperation(operation)
      if ((task.stage !== 'outline_generation' && task.stage !== 'evidence_mapping') || task.status !== 'waiting_user') throw new Error('Outline draft editing is not allowed in the current Bid stage state.')
      let result: OutlineDraftMutationResult | undefined
      await this.mutateProject(operation, async (lease) => {
        result = await mutateOutlineDraft(operation.workspace, request, lease)
        if (!result.ok) throw Object.assign(new Error('BID_OUTLINE_MUTATION_REJECTED'), { result })
      }).catch((error: unknown) => {
        const rejected = (error as { result?: OutlineDraftMutationResult }).result
        if (rejected !== undefined) result = rejected
        else throw error
      })
      if (result === undefined) throw new Error('BID_OUTLINE_MUTATION_MISSING')
      return result
    } finally { await this.finishOperation(session, operation) }
  }

  /**
   * 确认 Draft 前仅复核语义变化的 S4 可写章节；校验失败恢复已发布产物并保留 Draft。
   * @param session 等待目录确认的 Bid 会话。
   * @param request 用于拒绝过期提交的 Draft 身份。
   * @returns 确认后的运行状态，或稳定拒绝。
   */
  @Remote('confirmOutline')
  async confirmOutline(session: Session, request: OutlineDraftIdentityRequest): Promise<BidOutlineConfirmationResult> {
    if (!isBidMainSession(session)) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const operation = this.beginOperation(session)
    let run: BidRunContext | undefined
    let workSettled = false
    let suspensionError: unknown
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_outline')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Outline confirmation is not allowed in the current Bid stage state.' } }
      const agent = await this.executionAgent(operation, runtime.stage)
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      const workRequest = outlineConfirmationRequestSchema.parse(request)
      const work = await persistHostWork(workspace, 'outline_confirmation', runtime.stage, workRequest)
      const admittedRun = await operation.runs.start(work)
      run = admittedRun
      const candidate = await admittedRun.activities.track(() => executeOutlineConfirmationCandidate(
        agent,
        workspace,
        workRequest,
        admittedRun,
        this.config,
      ))
      workSettled = true
      if (!candidate.ok) {
        await operation.runs.complete(run, () => {
          session.append('bid.task.changed', { state: runtime })
        })
        return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The persisted draft does not satisfy outline validation.', issues: candidate.issues } }
      }
      const next = await this
        .automaticOrchestrator(agent, workspace, operation.controller.signal, operation)
        .commitPrevalidatedStage(
          runtime.stage,
          candidate.artifacts,
          commitWorkflow => operation.runs.complete(admittedRun, commitWorkflow),
        )
      await this.ctx.sessions.flush(session)
      return { ok: true, value: next }
    } catch (error) {
      suspensionError = error
      return { ok: false, error: { code: 'BID_CONFIRM_FAILED', message: error instanceof Error ? error.message : String(error), ...(error instanceof BidStageExecutionError ? { issues: error.issues } : {}) } }
    } finally {
      if (run !== undefined && operation.runs.current === run) {
        const failure = safeRecoverableBidFailure(run.work, suspensionError ?? {
          code: 'BID_CONFIRM_FAILED', message: workSettled ? '目录确认未完成状态提交。' : '目录确认候选未完成，已保留供恢复。',
        })
        await operation.runs.suspend(run.signal.aborted ? 'user_stop'
          : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure)
      }
      await this.finishOperation(session, operation)
    }
  }

  /**
   * Regenerate a temporary S4-quality candidate from the current persisted S5 draft.
   * @param session Bid Session waiting for outline confirmation.
   * @param request Current draft identity and the user's regeneration feedback.
   * @returns Updated draft candidate and change set, or a stable rejection.
   */
  @Remote('regenerateOutline')
  async regenerateOutline(
    session: Session,
    request: OutlineDraftIdentityRequest & { readonly feedback: string },
  ): Promise<BidOutlineRegenerationResult> {
    if (!isBidMainSession(session)) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline regeneration requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const normalized = request.feedback.trim()
    if (normalized.length === 0) return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
    const operation = this.beginOperation(session)
    let run: BidRunContext | undefined
    let workSettled = false
    let suspensionError: unknown
    let suspensionIssues: readonly StageValidationIssue[] | undefined
    let task = BID_INITIAL_TASK_STATE
    try {
      task = await this.prepareOperation(operation)
      if (!getBidClientProjection(task).allowedActions.includes('regenerate_outline')) return { ok: false, error: { code: 'BID_REGENERATE_NOT_ALLOWED', message: 'Outline regeneration is not allowed in the current Bid stage state.' } }
      const agent = await this.executionAgent(operation, task.stage)
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      const workRequest = outlineRegenerationRequestSchema.parse({ ...request, feedback: normalized })
      const work = await persistHostWork(workspace, 'outline_regeneration', task.stage, workRequest)
      const admittedRun = await operation.runs.start(work)
      run = admittedRun
      const result = await admittedRun.activities.track(() => executeOutlineRegenerationCandidate(
        agent,
        workspace,
        workRequest,
        admittedRun,
        this.config,
      ))
      workSettled = result.ok
      if (!result.ok) {
        suspensionError = result.error
        suspensionIssues = result.error.issues
      }
      return result
    } catch (error: unknown) {
      suspensionError = error
      if (error instanceof BidOrchestratorError && error.code === 'BID_OUTLINE_FEEDBACK_REQUIRED') return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
      return { ok: false, error: { code: 'BID_REGENERATE_FAILED', message: 'The Bid Host could not regenerate the outline.' } }
    } finally {
      if (run !== undefined && operation.runs.current === run) {
        if (workSettled && !run.signal.aborted) {
          await operation.runs.complete(run, () => {
            session.append('bid.task.changed', {
              state: { stage: task.stage, status: 'waiting_user', run: null },
            })
          })
        } else {
          const failure = safeRecoverableBidFailure(run.work, suspensionError ?? {
            code: 'BID_REGENERATE_FAILED', message: '目录重生成未完成，已保留工作候选供恢复。',
          }, suspensionIssues)
          await operation.runs.suspend(run.signal.aborted ? 'user_stop'
            : failure.recovery?.kind === 'repair' ? 'retry_exhausted' : 'executor_error', failure)
        }
      }
      try { await this.ctx.sessions.flush(session) } finally { await this.finishOperation(session, operation) }
    }
  }
}

export default BidHostRuntime

/** Build the visible title and ordinal path for one confirmed outline section. */
function reviewHeadingPath(outline: OutlineArtifact, sectionId: string): { titles: string[]; numbers: number[] } {
  const sections = new Map(outline.sections.map(section => [section.id, section]))
  const titles: string[] = []
  const numbers: number[] = []
  let current = sections.get(sectionId)
  while (current !== undefined) {
    titles.unshift(normalizeOutlineSectionTitle(current.title) || current.title)
    numbers.unshift(current.order)
    current = current.parent_id === null ? undefined : sections.get(current.parent_id)
  }
  return { titles, numbers }
}

function reviewIssuesFromArtifact(sectionId: string, artifact: ChapterReviewArtifact): BidReviewIssueView[] {
  const issues: BidReviewIssueView[] = artifact.blocking_issues.map((detail, index) => ({
    issue_id: `${sectionId}-review-blocking-${String(index + 1)}`,
    section_id: sectionId,
    source: 'review',
    category: 'blocking_issues',
    severity: 'high',
    status: 'open',
    title: '审核结论',
    detail,
  }))
  const coverage = [
    ['must_answer_coverage', artifact.must_answer_coverage],
    ['requirement_coverage', artifact.requirement_coverage],
    ['response_point_coverage', artifact.response_point_coverage],
    ['compliance_coverage', artifact.compliance_coverage],
  ] as const
  for (const [category, checks] of coverage) {
    for (const [index, check] of checks.entries()) {
      if (check.status !== 'missing') continue
      issues.push({
        issue_id: `${sectionId}-${category}-${String(index + 1)}`,
        section_id: sectionId,
        source: 'review',
        category,
        severity: artifact.verdict === 'attention' ? 'medium' : 'high',
        status: 'open',
        title: `覆盖缺口：${check.item}`,
        detail: check.issue ?? '审核报告未提供具体说明。',
      })
    }
  }
  for (const [index, check] of artifact.claim_checks.entries()) {
    if (check.status !== 'unsupported') continue
    issues.push({
      issue_id: `${sectionId}-claim-check-${String(index + 1)}`,
      section_id: sectionId,
      source: 'review',
      category: 'claim_checks',
      severity: 'high',
      status: 'open',
      title: '事实或承诺未获支持',
      detail: [check.claim_quote, check.issue].filter((value): value is string => value !== null).join('：'),
    })
  }
  for (const [index, check] of artifact.global_compliance_checks.entries()) {
    if (check.status !== 'violates') continue
    issues.push({
      issue_id: `${sectionId}-global-compliance-${String(index + 1)}`,
      section_id: sectionId,
      source: 'review',
      category: 'global_compliance_checks',
      severity: 'high',
      status: 'open',
      title: `违反全局约束：${check.compliance_id}`,
      detail: check.issue ?? check.item,
    })
  }
  for (const [index, conflict] of artifact.assignment_conflicts.entries()) {
    issues.push({
      issue_id: `${sectionId}-assignment-conflict-${String(index + 1)}`,
      section_id: sectionId,
      source: 'review',
      category: 'assignment_conflicts',
      severity: 'medium',
      status: 'open',
      title: `任务分配冲突：${conflict.task}`,
      detail: conflict.basis,
    })
  }
  for (const [index, gap] of artifact.external_input_gaps.entries()) {
    issues.push({
      issue_id: `${sectionId}-external-input-${String(index + 1)}`,
      section_id: sectionId,
      source: 'review',
      category: 'external_input_gaps',
      severity: 'medium',
      status: 'open',
      title: `待补项目资料：${gap.required_material}`,
      detail: gap.reason,
    })
  }
  for (const [name, passed] of Object.entries(artifact.quality_checks)) {
    if (passed) continue
    issues.push({
      issue_id: `${sectionId}-quality-${name}`,
      section_id: sectionId,
      source: 'review',
      category: 'quality_checks',
      severity: 'medium',
      status: 'open',
      title: `质量检查未通过：${name}`,
      detail: `${name}：false`,
    })
  }
  return issues
}

async function chapterReviewMatches(
  workspace: BidWorkspace,
  serial: string,
  sectionId: string,
  markdown: string,
  artifact: ChapterReviewArtifact,
): Promise<boolean> {
  if (artifact.section_id !== sectionId) return false
  const current = chapterCandidateSha256(markdown)
  return artifact.candidate_sha256 === current
    || (await resolveSemanticRevisionPath(workspace, serial, sectionId, artifact.candidate_sha256, current)).valid
}

function reviewIssuesFromExecution(sectionId: string, execution: ChapterExecutionLog['sections'][number]): BidReviewIssueView[] {
  const attempt = execution.attempts.findLast(item => !item.accepted)
  if (attempt === undefined) return []
  const source = attempt.role === 'writer' ? 'writing_execution' : 'review_execution'
  const title = attempt.role === 'writer' ? '章节编写执行失败' : '章节审核执行失败'
  return attempt.issues.length > 0
    ? attempt.issues.map((issue, index) => ({
      issue_id: `${sectionId}-${source}-${String(index + 1)}`,
      section_id: sectionId,
      source,
      category: issue.code,
      severity: 'high',
      status: 'open',
      title,
      detail: issue.message,
    }))
    : [{
      issue_id: `${sectionId}-${source}-stop-reason`,
      section_id: sectionId,
      source,
      category: 'stop_reason',
      severity: 'high',
      status: 'open',
      title,
      detail: `执行停止原因：${attempt.stop_reason}`,
    }]
}

function projectChapterReview(
  sectionId: string,
  artifact: ChapterReviewArtifact | undefined,
  execution: ChapterExecutionLog['sections'][number] | undefined,
): BidReviewChapterView['review'] {
  const reportIssues = artifact === undefined ? [] : reviewIssuesFromArtifact(sectionId, artifact)
  if (execution?.status === 'failed') {
    return { status: 'failed', issues: [...reviewIssuesFromExecution(sectionId, execution), ...reportIssues] }
  }
  if (execution?.phase === 'reviewing') return { status: 'reviewing', issues: [] }
  if (artifact !== undefined) return {
    status: artifact.verdict === 'pass' ? 'pass'
      : artifact.verdict === 'attention' && artifact.external_input_gaps.length > 0 ? 'needs_input' : 'needs_attention',
    issues: reportIssues,
  }
  return { status: 'not_started', issues: [] }
}

function projectChapterIndicator(
  contentAvailable: boolean,
  review: BidReviewChapterView['review'],
  execution: ChapterExecutionLog['sections'][number] | undefined,
  waitingForDependency: boolean,
): BidReviewWorkbenchView['outline'][number]['chapter_indicator'] {
  if (execution?.status === 'failed') {
    switch (execution.failure_phase) {
      case 'queued': return { status: 'failed', tooltip: '章节启动或调度失败' }
      case 'reviewing': return { status: 'failed', tooltip: '章节审核执行失败' }
      case 'repairing': return { status: 'failed', tooltip: '章节修复执行失败' }
      case 'blocked': return { status: 'failed', tooltip: '前置章节执行失败' }
      case 'writing': return { status: 'failed', tooltip: '章节编写执行失败' }
      case null: return { status: 'failed', tooltip: '章节执行失败' }
      default: return { status: 'failed', tooltip: '章节执行失败' }
    }
  }
  if (execution?.phase === 'queued') return { status: 'queued', tooltip: waitingForDependency ? '等待前置章节完成' : '等待执行' }
  if (execution?.phase === 'writing') return { status: 'writing', tooltip: '正在编写' }
  if (execution?.phase === 'repairing') return { status: 'repairing', tooltip: '正在修复' }
  if (execution?.phase === 'reviewing') return { status: 'reviewing', tooltip: '正在审核' }
  if (review.status === 'needs_attention') {
    return { status: 'needs_attention', tooltip: review.issues.length === 0 ? '正文需要修复' : `正文需要修复：${review.issues.length} 个问题` }
  }
  if (review.status === 'needs_input') return { status: 'needs_input', tooltip: '缺少项目资料，正文无需重写' }
  if (review.status === 'pass') return { status: 'passed', tooltip: '审核通过' }
  if (contentAvailable) return { status: 'content_ready', tooltip: '正文已编写，等待审核' }
  return { status: 'not_started', tooltip: '未开始' }
}

/** Durable manifest entry for one imported file. */
export interface ManifestFile {
  id: BidFileId
  /** `tender` supplies S2 requirements; later stages use every persisted role. */
  role: import('./control-plane-contract.ts').BidDocumentRole
  originalName: string
  inputPath: string
  corpusPath: string | null
  documentPath: string | null
  structurePath: string | null
  metadataPath: string | null
  chunksPath: string | null
  chunkIndexPath: string | null
  mediaType: string
  size: number
  sha256: string
  parseStatus: ParseStatus
  parseError: string | null
}

/** Versioned project manifest for imported bid files. */
export interface BidManifest { version: typeof BID_MANIFEST_VERSION; files: ManifestFile[] }

/** File bytes and browser-supplied metadata accepted by the importer. */
export interface IncomingFile { name: string; role?: import('./control-plane-contract.ts').BidDocumentRole; type?: string; bytes: Uint8Array }

/** Manifest entry plus absolute paths available to the importing process. */
export interface ImportedFile extends ManifestFile {
  absoluteInputPath: string
  absoluteDocumentPath: string | null
  absoluteStructurePath: string | null
  absoluteMetadataPath: string | null
  absoluteChunksPath: string | null
  absoluteChunkIndexPath: string | null
}

const nullablePathSchema = zod.string().min(1).nullable()
const manifestFileSchema = zod.object({
  id: zod.string().min(1),
  role: zod.enum(['tender', 'outline_framework', 'reference_bid', 'reference']),
  originalName: zod.string().min(1),
  inputPath: zod.string().min(1),
  corpusPath: nullablePathSchema,
  documentPath: nullablePathSchema,
  structurePath: nullablePathSchema,
  metadataPath: nullablePathSchema,
  chunksPath: nullablePathSchema,
  chunkIndexPath: nullablePathSchema,
  mediaType: zod.string().min(1),
  size: zod.number().int().positive(),
  sha256: zod.string().min(1),
  parseStatus: zod.enum(['pending', 'success', 'needs_ocr', 'failed']),
  parseError: zod.string().nullable(),
}).strict()
const bidManifestSchema = zod.object({
  version: zod.literal(BID_MANIFEST_VERSION),
  files: zod.array(manifestFileSchema),
}).strict()

/**
 * Parse one durable Bid manifest through the canonical runtime validation.
 * @param value - untrusted JSON-compatible value read from `manifest.json`.
 * @returns a validated current-version manifest.
 * @throws a stable manifest error when the version or required fields are invalid.
 */
export function parseBidManifest(value: unknown): BidManifest {
  const record = typeof value === 'object' && value !== null ? value as { version?: unknown } : undefined
  if (record?.version !== BID_MANIFEST_VERSION) throw new Error('bid-unsupported-manifest-version')
  const parsed = bidManifestSchema.safeParse(value)
  if (!parsed.success) throw new Error('bid-invalid-manifest')
  return parsed.data as BidManifest
}

const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain', '.md': 'text/markdown',
}

/** Chinese model-visible names for all persisted document roles. */
const BID_DOCUMENT_ROLE_NAMES: Record<BidDocumentRole, string> = {
  tender: '招标文件',
  outline_framework: '人工目录框架',
  reference_bid: '参考旧标书',
  reference: '项目相关资料',
}

/**
 * Reject file names that are invalid on supported workspace filesystems.
 * @param name - User-supplied base file name.
 * @returns The normalized safe file name.
 */
export function safeFileName(name: string): string {
  const trimmed = name.normalize('NFC').trim()
  if (trimmed.length === 0 || /[\\/:\x00-\x1f<>"|?*]/u.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('bid-invalid-file-name')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(trimmed)) throw new Error('bid-reserved-file-name')
  return trimmed
}

/**
 * Validate every file in one import batch before any workspace write begins.
 * @param files - complete browser-decoded file batch.
 * @param config - Host-owned import limits and accepted extensions.
 */
export function validateBidFileBatch(files: readonly IncomingFile[], config: BidConfig): void {
  if (files.length === 0 || files.length > config.maxFiles) throw new Error('bid-file-count-limit')
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  if (!Number.isSafeInteger(total) || total > config.maxTotalBytes) throw new Error('bid-total-size-limit')
  for (const file of files) {
    if (file.role !== undefined && !isBidDocumentRole(file.role)) throw new Error('bid-invalid-file-role')
    const originalName = safeFileName(file.name)
    const extension = extname(originalName).toLocaleLowerCase('en-US')
    if (!config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
    if (file.bytes.byteLength === 0) throw new Error('bid-empty-file')
    if (file.bytes.byteLength > config.maxFileBytes) throw new Error('bid-file-size-limit')
  }
}

/**
 * Resolve a user-visible relative path only when it remains inside root.
 * @param root - Absolute directory that owns the resolved path.
 * @param candidate - Relative path supplied by the caller.
 * @returns The resolved absolute path inside root.
 */
export { assertNoLinkedPath, within } from './workspace-path.ts'

function validateConfig(config: BidConfig): void {
  if (!config.projectDirectory || !config.outputDirectory || config.maxFileBytes <= 0
    || config.maxFiles <= 0 || config.maxTotalBytes <= 0 || config.docxTemplateMaxBytes <= 0
    || !Number.isInteger(config.documentChunk.minChars) || !Number.isInteger(config.documentChunk.targetChars)
    || !Number.isInteger(config.documentChunk.maxChars) || config.documentChunk.minChars <= 0
    || config.documentChunk.minChars > config.documentChunk.targetChars
    || config.documentChunk.targetChars > config.documentChunk.maxChars) {
    throw new Error('bid-invalid-config')
  }
}

function bidExportDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}年${value('month')}月${value('day')}日`
}

async function readBidCoverData(workspace: BidWorkspace): Promise<BidCoverData> {
  const path = within(workspace.projectRoot, 'analysis/project.json')
  await assertNoLinkedPath(workspace.root, path)
  let project: ReturnType<typeof parseTenderProjectArtifact> | undefined
  try { project = parseTenderProjectArtifact(JSON.parse(await readFile(path, 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const projectName = project?.project_name ?? project?.tender_name
  const bidderName = workspace.config.bidderName?.trim()
  return {
    ...(typeof projectName === 'string' ? { projectName } : {}),
    ...(bidderName ? { bidderName } : {}),
    date: bidExportDate(),
  }
}


function uniqueName(name: string, used: Set<string>): string {
  const extension = extname(name)
  const stem = basename(name, extension)
  let candidate = name
  let ordinal = 2
  while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${stem} (${ordinal++})${extension}`
  used.add(candidate.toLocaleLowerCase('en-US'))
  return candidate
}

/**
 * Delegate PDF, DOCX, and DOC conversion to the package's sole document parser.
 * @param input - Source file and destination corpus directory.
 * @returns The extraction paths and parse status.
 */
export function parseBidDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> { return extractDocument(input) }

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.replace(/^\uFEFF/u, '')
}

function parseWorkbook(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellText: true })
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]
    /* v8 ignore next -- SheetNames and Sheets are populated together by XLSX.read. */
    if (sheet === undefined) throw new Error(`bid-workbook-missing-sheet:${name}`)
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, { header: 1, defval: '' })
      .filter(row => row.some(value => String(value).trim().length > 0))
    const table = rows.map(row => `| ${row.map(value => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')).join(' | ')} |`).join('\n')
    const [header] = rows
    const divider = header === undefined ? '' : `\n| ${header.map(() => '---').join(' | ')} |`
    return `## 工作表：${name}\n\n${table.slice(0, table.indexOf('\n') >= 0 ? table.indexOf('\n') : table.length)}${divider}${table.includes('\n') ? table.slice(table.indexOf('\n')) : ''}`
  }).join('\n\n')
}

function parseDeterministic(extension: string, bytes: Uint8Array): string {
  if (extension === '.txt' || extension === '.md') return decodeText(bytes)
  if (extension === '.xlsx' || extension === '.xls') return parseWorkbook(bytes)
  throw new Error('bid-unsupported-file-type')
}

/** List regular files produced in one Run's private intake staging directory. */
async function stagedFiles(root: string): Promise<string[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? stagedFiles(path) : entry.isFile() ? [path] : []
  }))
  return paths.flat()
}

/** 同一 Workspace 内所有 Bid Session 共用的项目文件。 */
export class BidWorkspace {
  /** Absolute workspace root. */
  readonly root: string
  /** Absolute directory that owns the Bid project. */
  readonly projectRoot: string
  /** Absolute directory containing original uploads. */
  readonly inputRoot: string
  /** Absolute directory containing parsed document corpora. */
  readonly corpusRoot: string
  /** Absolute directory allowed to receive exports. */
  readonly outputRoot: string
  /** Absolute path to the versioned project manifest. */
  readonly manifestPath: string
  /** 项目进度的持久化文件，不包含聊天上下文。 */
  readonly projectStatePath: string
  /** Validated import and export limits for this workspace. */
  readonly config: BidConfig

  /**
   * @param workspaceRoot 已存在的项目目录；解析目录别名后共享产物。
   * @param options 项目的导入、分块和导出配置。
   */
  constructor(workspaceRoot: string, options?: BidConfig) {
    const config = options ?? DEFAULT_BID_CONFIG
    validateConfig(config)
    this.config = config
    this.root = realpathSync(workspaceRoot)
    this.projectRoot = within(this.root, config.projectDirectory)
    this.inputRoot = resolve(this.projectRoot, 'input')
    this.corpusRoot = resolve(this.projectRoot, 'corpus')
    this.outputRoot = within(this.projectRoot, config.outputDirectory)
    this.manifestPath = resolve(this.projectRoot, 'manifest.json')
    this.projectStatePath = resolve(this.projectRoot, 'project-state.json')
  }

  /**
   * 导入、独立解析并原子发布本批次清单；成功重解析替换此前批次同文件、同角色的失败记录，保留原始文件及本批次全部记录。
   * 新成功记录优先于同身份的不可用记录；本批次返回记录保持上传顺序。
   * @param files - 导入项目的已校验上传字节。
   * @param run - 为 Host 上传提供暂存和发布权限的 Run。
   * @returns 附带当前进程绝对路径的导入清单记录。
   */
  async import(files: readonly IncomingFile[], run?: BidRunContext): Promise<ImportedFile[]> {
    validateBidFileBatch(files, this.config)
    await assertNoLinkedPath(this.root, this.manifestPath)
    const manifest = await this.readManifest()
    const previousFailedRecords = new Set(manifest.files.filter(file => file.parseStatus === 'failed'))
    const stagingRoot = run === undefined ? undefined : resolve(this.projectRoot, 'runs', run.runId, 'staging')
    const destination = (path: string): string => stagingRoot === undefined
      ? within(this.projectRoot, path)
      : resolve(stagingRoot, ...path.split('/'))
    await assertNoLinkedPath(this.root, this.inputRoot)
    let storedInputs: string[]
    try { storedInputs = await readdir(this.inputRoot) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      storedInputs = []
    }
    const used = new Set([...storedInputs, ...manifest.files.map(file => basename(file.inputPath))]
      .map(name => name.toLocaleLowerCase('en-US')))
    const imported: ImportedFile[] = []
    for (const file of files) {
      const originalName = safeFileName(file.name)
      const extension = extname(originalName).toLocaleLowerCase('en-US')
      const storedName = uniqueName(originalName, used)
      const inputPath = `input/${storedName}`
      const input = destination(inputPath)
      await atomicBytes(this.root, input, file.bytes)
      const hash = createHash('sha256').update(file.bytes).digest('hex')
      const record: ManifestFile = { id: hash as BidFileId, role: file.role ?? 'tender', originalName, inputPath, corpusPath: null,
        documentPath: null, structurePath: null, metadataPath: null, chunksPath: null, chunkIndexPath: null,
        mediaType: MEDIA_TYPES[extension] ?? file.type ?? 'application/octet-stream', size: file.bytes.byteLength, sha256: hash, parseStatus: 'pending', parseError: null }
      try {
        const corpusPath = `corpus/${storedName}`
        const documentPath = `${corpusPath}/document.md`
        record.corpusPath = corpusPath
        if (extension === '.pdf' || extension === '.docx' || extension === '.doc') {
          const corpus = destination(corpusPath)
          await assertNoLinkedPath(this.root, corpus)
          const result = await extractDocument({ sourcePath: input, outputDir: corpus })
          if (result.parseStatus === 'failed' || result.parseStatus === 'unsupported_format') {
            /* v8 ignore next -- extractDocument always supplies both fields for a non-success result. */
            throw new Error(`${result.error?.code ?? 'DOCUMENT_PARSE_FAILED'}: ${result.error?.message ?? 'Document extraction failed.'}`)
          }
          record.documentPath = documentPath
          record.structurePath = `${corpusPath}/structure.json`
          record.metadataPath = `${corpusPath}/metadata.json`
          record.parseStatus = result.parseStatus
        } else {
          const document = destination(documentPath)
          await assertNoLinkedPath(this.root, document)
          await writeFileAtomic(
            document,
            parseDeterministic(extension, file.bytes),
            { mode: 0o600, dirMode: 0o700 },
          )
          record.documentPath = documentPath
          record.parseStatus = 'success'
        }
        if (record.parseStatus === 'success') {
          const chunksPath = `${corpusPath}/chunks`
          const chunks = destination(chunksPath)
          await assertNoLinkedPath(this.root, chunks)
          await chunkDocument({
            documentPath: destination(documentPath),
            structurePath: record.structurePath === null ? null : destination(record.structurePath),
            metadataPath: record.metadataPath === null ? null : destination(record.metadataPath),
            outputDir: chunks,
            config: this.config.documentChunk,
          })
          record.chunksPath = chunksPath
          record.chunkIndexPath = `${chunksPath}/index.json`
        }
      } catch (error) {
        record.parseStatus = 'failed'
        /* v8 ignore next -- every parser and filesystem operation in this block throws Error instances. */
        record.parseError = error instanceof Error ? error.message : String(error)
      }
      if (record.parseStatus === 'success') {
        manifest.files = manifest.files.filter(previous => previous.id !== record.id
          || previous.role !== record.role || !previousFailedRecords.has(previous))
        const unavailable = manifest.files.findIndex(previous => previous.id === record.id
          && previous.role === record.role && previous.parseStatus !== 'success')
        if (unavailable === -1) manifest.files.push(record)
        else manifest.files.splice(unavailable, 0, record)
      } else manifest.files.push(record)
      imported.push({
        ...record,
        absoluteInputPath: input,
        absoluteDocumentPath: record.documentPath === null ? null : within(this.projectRoot, record.documentPath),
        absoluteStructurePath: record.structurePath === null ? null : within(this.projectRoot, record.structurePath),
        absoluteMetadataPath: record.metadataPath === null ? null : within(this.projectRoot, record.metadataPath),
        absoluteChunksPath: record.chunksPath === null ? null : within(this.projectRoot, record.chunksPath),
        absoluteChunkIndexPath: record.chunkIndexPath === null ? null : within(this.projectRoot, record.chunkIndexPath),
      })
    }
    await assertNoLinkedPath(this.root, this.manifestPath)
    if (run === undefined || stagingRoot === undefined) {
      await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    } else await run.commits.publish(async (lease) => {
      for (const staged of await stagedFiles(stagingRoot)) {
        const destinationPath = within(this.projectRoot, relative(stagingRoot, staged).replaceAll('\\', '/'))
        await lease.writeBytes(destinationPath, await readFile(staged))
      }
      await lease.writeJson(this.manifestPath, manifest)
    })
    return imported
  }

  /**
   * Read the durable manifest, treating a missing project as empty.
   * @returns The current manifest version.
   */
  async readManifest(): Promise<BidManifest> {
    try {
      return parseBidManifest(JSON.parse(await readFile(this.manifestPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: BID_MANIFEST_VERSION, files: [] }
      throw error
    }
  }

  /**
   * Render the persisted, model-visible file inventory for a user message.
   * @param request - User request that follows the file inventory.
   * @returns The request prefixed by project-relative corpus paths and statuses.
   */
  async messageInventory(request: string): Promise<string> {
    const manifest = await this.readManifest()
    const files = manifest.files.map((file, index) => {
      const document = file.documentPath === null ? '无' : this.relative(file.documentPath)
      const chunks = file.chunksPath === null ? '无' : this.relative(file.chunksPath)
      const structure = file.structurePath === null ? '无' : this.relative(file.structurePath)
      const status = file.parseStatus === 'success' ? '成功' : file.parseStatus === 'needs_ocr' ? '需要 OCR' : `失败：${file.parseError ?? '未知错误'}`
      return `${index + 1}. ${file.originalName}\n   资料类型：${BID_DOCUMENT_ROLE_NAMES[file.role]}\n   原始文件：${this.relative(file.inputPath)}\n   完整正文：${document}\n   搜索语料：${chunks}\n   文档结构：${structure}\n   解析状态：${status}`
    }).join('\n\n')
    return `用户已上传以下项目文件：\n\n${files}\n\n用户要求：\n${request}`
  }

  /**
   * 将项目内 Markdown 导出到项目输出目录。
   * @param source 项目相对 Markdown 源路径。
   * @param destination 输出目录下的项目相对 DOCX 路径。
   * @param templateId 明确的导出模板；仅内部阶段导出可省略并使用 S5 基准。
   * @param commits Long Run 写入时使用的 commit scope；独立 DOCX 操作可省略。
   * @param nativeExport 可选的 Visio/Word 能力注入；省略时使用当前 Windows COM 实现。
   * @returns 向调用方公开的工作区相对路径。
   */
  async exportDocx(
    source: string,
    destination: string = `${this.config.outputDirectory}/技术标.docx`,
    templateId?: DocxTemplateId | null,
    commits?: BidCommitScope,
    nativeExport?: NativeVisioExport,
  ): Promise<string> {
    if (!this.config.enableDocxExport) throw new Error('bid-docx-export-disabled')
    const sourcePath = within(this.projectRoot, source)
    if (!source.endsWith('.md')) throw new Error('bid-source-must-be-markdown')
    await assertNoLinkedPath(this.root, sourcePath)
    return this.exportDocxMarkdown(await readFile(sourcePath, 'utf8'), destination, templateId, commits, undefined, nativeExport)
  }

  /**
   * Render a collected Markdown snapshot and publish its DOCX and format state atomically.
   * @param markdown - Complete source snapshot to render.
   * @param destination - Project-relative DOCX destination below the output directory.
   * @param templateId - Explicit format template or the S5 baseline when omitted.
   * @param commits - Long Run commit scope; independent DOCX operations may omit it.
   * @param sourceSnapshot - Optional project-relative Markdown snapshot published with the DOCX.
   * @param nativeExport - Optional Visio/Word capability injection; defaults to the Windows COM implementation.
   * @param technicalDeviation - Structured rows or an explicit clear operation for the built-in template.
   * @param visualReviewer - Optional final-page reviewer used by product S6 entry points.
   * @param visualReviewSignal - Cancellation for rendering and reviewing visual blocks.
   * @returns Workspace-relative DOCX path.
   */
  async exportDocxMarkdown(
    markdown: string,
    destination: string = `${this.config.outputDirectory}/技术标.docx`,
    templateId?: DocxTemplateId | null,
    commits?: BidCommitScope,
    sourceSnapshot?: string,
    nativeExport?: NativeVisioExport,
    technicalDeviation?: TechnicalDeviationComposition,
    visualReviewer?: VisualReviewModel,
    visualReviewSignal: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    if (!this.config.enableDocxExport) throw new Error('bid-docx-export-disabled')
    const destinationPath = within(this.projectRoot, destination)
    if (!destinationPath.startsWith(`${this.outputRoot}${sep}`)) throw new Error('bid-output-path-required')
    const view = await readDocxFormat(this, templateId)
    const pending = view.state.conflicts.filter(conflict => conflict.status === 'conflict')
    if (pending.length) throw new Error(`当前仍有 ${String(pending.length)} 项格式冲突，请先确认。`)
    const builtInTemplate = view.templateId === null
    const coverData = builtInTemplate ? await readBidCoverData(this) : undefined
    const compose = (
      flowchartMode: 'svg' | 'visio-placeholder' = 'svg',
      visualAdjustments: VisualReviewAdjustments = {},
    ) => buildDocxFromResolvedTemplate(
      this,
      markdown,
      view,
      { flowchartMode, ...(coverData === undefined ? {} : { coverData }),
        ...(technicalDeviation === undefined ? {} : { technicalDeviation }), visualAdjustments },
    )
    const office = nativeExport ?? createNativeVisioExport()
    const flowcharts = extractFlowchartSpecs(markdown)
    if (/\{\{(?:flowchart|flow_ref):/u.test(markdown)) throw new Error('FLOWCHART_MARKER_UNRESOLVED: 正文仍包含未解析的流程图 marker。')
    const nativeFlowchartFiles: Array<{ path: string; bytes: Buffer }> = []
    let exportMode: FlowchartExportMode | undefined
    let exportReasons: readonly string[] | undefined
    let exportSummary: string | undefined
    let editableRoot: string | undefined
    const editablePaths = new Map<string, string>()
    if (flowcharts.length > 0) {
      const env = await detectFlowchartExportEnvironment(office)
      exportMode = env.mode
      exportReasons = env.reasons
      exportSummary = env.summary
      if (env.mode === 'editable') {
        editableRoot = await mkdtemp(resolve(this.root, '.dsh-visio-export-'))
        for (const flowchart of flowcharts) {
          const visioPath = resolve(editableRoot, `${flowchart.id}.vsdx`)
          await office.visio.createDiagram(flowchart, visioPath)
          editablePaths.set(flowchart.id, visioPath)
          nativeFlowchartFiles.push({ path: `flowcharts/${flowchart.id}.vsdx`, bytes: await readFile(visioPath) })
        }
      } else {
        for (const flowchart of flowcharts) {
          const renderedSvg = renderFlowchartSvg(flowchart)
          nativeFlowchartFiles.push({ path: `flowcharts/${flowchart.id}.svg`, bytes: Buffer.from(renderedSvg.svg, 'utf8') })
          nativeFlowchartFiles.push({ path: `flowcharts/${flowchart.id}.json`, bytes: Buffer.from(JSON.stringify(flowchart, null, 2), 'utf8') })
        }
      }
    }
    let tocUpdateDeferred = false
    const finalizer = office.finalizer ?? (nativeExport === undefined ? createNativeWordFinalizer() : undefined)
    const canFinalize = finalizer !== undefined && await finalizer.isAvailable()
    if (!canFinalize) tocUpdateDeferred = true
    let renderCount = 0
    const renderFinal = async (adjustments: VisualReviewAdjustments): Promise<{ bytes: Buffer; assetHash: string }> => {
      const flowchartMode = exportMode === 'editable' ? 'visio-placeholder' : 'svg'
      const rendered = await compose(flowchartMode, adjustments)
      let bytes = rendered.bytes
      if (exportMode === 'editable') {
        if (editableRoot === undefined) throw new Error('DOCX_VISIO_TEMPORARY_ROOT_MISSING')
        const temporaryDocx = resolve(editableRoot, `rendered-${String(++renderCount)}.docx`)
        await writeFile(temporaryDocx, bytes, { flag: 'wx' })
        await office.word.embed(temporaryDocx, flowcharts.map((flowchart) => {
          const adjustment = adjustments[`flowchart_${flowchart.id}`]
          return {
            placeholder: flowchartPlaceholder(flowchart),
            visioPath: editablePaths.get(flowchart.id) as string,
            ...(adjustment !== undefined && 'scale' in adjustment ? { scale: adjustment.scale } : {}),
          }
        }))
        const embeddedCount = await office.word.countVisioObjects(temporaryDocx)
        if (embeddedCount !== flowcharts.length) throw new Error(`DOCX_VISIO_OBJECT_COUNT_MISMATCH: 预期 ${String(flowcharts.length)} 个 Visio 对象，实际检测到 ${String(embeddedCount)} 个。`)
        bytes = await readFile(temporaryDocx)
      }
      if (canFinalize) {
        const temporaryRoot = await mkdtemp(resolve(this.root, '.dsh-word-finalize-'))
        try {
          const temporaryDocx = resolve(temporaryRoot, 'final.docx')
          await writeFile(temporaryDocx, bytes, { flag: 'wx' })
          await finalizer.updateFields(temporaryDocx)
          bytes = await readFile(temporaryDocx)
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true })
        }
      }
      await readDocxXml(bytes)
      return { bytes, assetHash: rendered.assetHash }
    }
    let finalBytes: Buffer
    let assetHash: string
    try {
      if (visualReviewer === undefined) {
        const rendered = await renderFinal({})
        finalBytes = rendered.bytes
        assetHash = rendered.assetHash
      } else {
        let latestAssetHash = ''
        const reviewed = await reviewDocxVisualBlocks(
          this,
          markdown,
          view.values,
          await docxTemplateHash(this, view),
          visualReviewer,
          async (adjustments) => {
            const rendered = await renderFinal(adjustments)
            latestAssetHash = rendered.assetHash
            return rendered.bytes
          },
          visualReviewSignal,
        )
        finalBytes = reviewed.bytes
        assetHash = latestAssetHash
      }
    } finally {
      if (editableRoot !== undefined) await rm(editableRoot, { recursive: true, force: true })
    }
    const nextFormat = { ...view.state,
      lastExport: {
        path: destination,
        fingerprint: docxFingerprint(markdown, view, assetHash),
        ...(tocUpdateDeferred ? { tocUpdateDeferred: true } : {}),
        ...(exportMode !== undefined ? { mode: exportMode, reasons: exportReasons, summary: exportSummary } : {}),
      },
    }
    if (commits === undefined) {
      await publishBidBatch(this.root, this.projectRoot, async (lease) => {
        for (const file of nativeFlowchartFiles) {
          const path = within(this.projectRoot, file.path)
          await assertNoLinkedPath(this.root, path)
          await lease.writeBytes(path, file.bytes)
        }
        await lease.writeBytes(destinationPath, finalBytes)
        if (sourceSnapshot !== undefined) {
          await lease.writeText(within(this.projectRoot, sourceSnapshot), markdown)
        }
        await writeDocxFormat(this, view.templateId, nextFormat, lease)
        await registerDocxExportArtifacts(this, [destination, ...nativeFlowchartFiles.map(file => file.path),
          ...(sourceSnapshot === undefined ? [] : [sourceSnapshot])], lease)
      })
    } else await commits.publish(async (lease) => {
      for (const file of nativeFlowchartFiles) {
        const path = within(this.projectRoot, file.path)
        await assertNoLinkedPath(this.root, path)
        await lease.writeBytes(path, file.bytes)
      }
      await lease.writeBytes(destinationPath, finalBytes)
      if (sourceSnapshot !== undefined) {
        await lease.writeText(within(this.projectRoot, sourceSnapshot), markdown)
      }
      await writeDocxFormat(this, view.templateId, nextFormat, lease)
      await registerDocxExportArtifacts(this, [destination, ...nativeFlowchartFiles.map(file => file.path),
        ...(sourceSnapshot === undefined ? [] : [sourceSnapshot])], lease)
    })
    return this.relative(destination)
  }

  private relative(path: string): string { return `${this.config.projectDirectory}/${path.replaceAll('\\', '/')}` }
}
