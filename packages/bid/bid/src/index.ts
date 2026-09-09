/**
 * Workspace-local import, parsing, manifest, and DOCX-export primitives for
 * the bid profile. The caller supplies the selected project workspace;
 * this module never stores an ambient current workspace or emits file bytes to
 * a model request.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import * as XLSX from 'xlsx'
import { z as zod } from 'zod'
import { extractDocument, type ExtractDocumentInput, type ExtractDocumentResult } from './document-extract.ts'
import { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, type DocumentChunkConfig } from './document-chunk.ts'
import { validateFileIntake } from './file-intake-validator.ts'
import { executeTenderAnalysis } from './tender-analysis-executor.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'
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
import { DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY, executeEvidenceMapping, executeEvidenceMappingFinalCheck, pruneWebEvidenceArtifacts, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { changedWritableSectionIds, reconcileSectionEvidence } from './section-evidence-context.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { executeOutlineGeneration, generateScopedOutlineOperations } from './outline-generation-executor.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { parseOutlineArtifact, type OutlineArtifact } from './outline-generation-artifacts.ts'
import { inspectBidStage, installStageInteractionTools, isBidMainSession, readStageJson, stageInteractionSchema } from './stage-interaction.ts'
import { parseOutlineEditOperations } from './outline-confirmation-edits.ts'
import { outlineArtifactSha256, parseOutlineConfirmationArtifact, type OutlineDraftView, type OutlineReviewContext } from './outline-confirmation-artifacts.ts'
import { getOrCreateOutlineDraft, mutateOutlineDraft, replaceOutlineDraft, type OutlineDraftIdentityRequest, type OutlineDraftMutationRequest, type OutlineDraftMutationResult } from './outline-draft-store.ts'
import { validateOutlineDraftForConfirmation } from './outline-confirmation-validator.ts'
import { parseOutlineRegenerationChangeSet, regenerationChangeSetMatches } from './outline-regeneration-artifacts.ts'
import { buildChapterWorklist, DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY, executeChapterWriting } from './chapter-writing-executor.ts'
import { validateChapterWriting } from './chapter-writing-validator.ts'
import { suggestDocxFormat } from './docx-format-suggestions.ts'
import { readDocxXml } from './docx-template.ts'
import { renderDocx, docxAssetHash } from './docx-render.ts'
import { readDocxFormat, saveDocxFormat, saveDocxTemplate, writeDocxFormat, docxFingerprint } from './docx-format-store.ts'
import {
  DOCX_TEMPLATE_MAX_BYTES,
  DOCX_TEMPLATE_NAME_HEADER,
  DOCX_TEMPLATE_REVISION_HEADER,
  DOCX_TEMPLATE_SIZE_HEADER,
  DOCX_TEMPLATE_UPLOAD_PATH,
} from './docx-format-contract.ts'
import type { DocxFormatRequest, DocxFormatView, DocxFormatSuggestion, DocxTemplateUploadResult } from './docx-format-contract.ts'
import { executeDocxExport, validateDocxExport, collectDocxChapterBody, collectDocxMarkdown } from './docx-export.ts'
import { estimateReviewPages, type PageEstimateSection } from './page-estimate.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { parseChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { chapterContentSha256, chapterRevisionRequestSchema } from './chapter-revision.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseWebEvidenceSourcesArtifact } from './web-evidence-source-artifacts.ts'
import { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS } from './model-stage-repair.ts'
import { BidOrchestrator, BidOrchestratorError } from './orchestrator.ts'
import { registerBidRuntimeProjection } from './projection.ts'
import { BID_INITIAL_RUNTIME_STATE, buildBidStageTask, getBidClientProjection, reduceBidRuntimeState } from './runtime-state.ts'
import { checkpointBidProjectState, readBidProjectState, type BidProjectState } from './project-state.ts'
import { assertNoLinkedPath, within, atomicBytes } from './workspace-path.ts'
import { BID_STAGES, BidStageExecutionError, isBidDocumentRole } from './control-plane-contract.ts'
import { BID_BINARY_UPLOAD_PATH, BID_UPLOAD_FILES_HEADER, BID_UPLOAD_SESSION_HEADER } from './control-plane-contract.ts'
import type {
  BidDetailsView,
  BidChapterRevisionRequest,
  BidChapterRevisionResult,
  BidEvidenceMappingProgress,
  BidDocxExportErrorCode,
  BidDocxExportResult,
  BidFileIntakeErrorCode,
  BidFileIntakeFileResult,
  BidFileIntakeResult,
  BidOutlineConfirmationResult,
  BidOutlineRegenerationResult,
  BidTenderAnalysisConfirmationResult,
  BidRetryErrorCode,
  BidRetryResult,
  BidStageStartErrorCode,
  BidStageStartResult,
  BidReviewWorkbenchView,
  BidReviewChapterView,
  BidReviewMaterialView,
  BidRuntimeState,
  BidStage,
  BidDocumentRole,
  BidBinaryUploadFile,
  BidUploadFile,
  StageArtifact,
  StageValidationIssue,
} from './control-plane-contract.ts'

export { extractDocument } from './document-extract.ts'
export type { DocumentMetadata, DocumentParseStatus, DocumentSection, ExtractDocumentInput, ExtractDocumentResult } from './document-extract.ts'
export { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, parseDocumentChunkIndex } from './document-chunk.ts'
export type { ChunkDocumentInput, ChunkDocumentResult, DocumentChunkConfig, DocumentChunkEntry, DocumentChunkIndex } from './document-chunk.ts'
export { BID_CLIENT_ACTIONS, BID_DOCUMENT_ROLES, BID_RUNTIME_PROJECTION_KEY, BID_STAGES, STAGE_RUN_STATUSES, isBidDocumentRole, parseBidReviewWorkbenchView } from './control-plane-contract.ts'
export type {
  BidChapterRevisionReference,
  BidChapterRevisionRequest,
  BidChapterRevisionResult,
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
  BidRetryErrorCode,
  BidRetryFailure,
  BidRetryResult,
  BidStageStartErrorCode,
  BidStageStartResult,
  BidReviewWorkbenchView,
  BidPageEstimate,
  BidReviewChapterView,
  BidReviewMaterialView,

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
export { BID_SESSION_EVENT_TYPES } from './bid-events.ts'
export type { BidSessionEventMap, BidSessionEventType } from './bid-events.ts'
export {
  BID_INITIAL_RUNTIME_STATE,
  buildBidStageTask,
  getBidClientProjection,
  getBidStagePolicy,
  reduceBidRuntimeState,
} from './runtime-state.ts'
export { BidOrchestrator, BidOrchestratorError }
export type {
  BidOrchestratorErrorCode,
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
export type { ModelStageExecutionOptions } from './model-stage-repair.ts'
export { validateTenderAnalysis, validateTenderAnalysisDraft } from './tender-analysis-validator.ts'
export type { TenderAnalysisArtifacts } from './tender-analysis-validator.ts'
export * from './evidence-mapping-artifacts.ts'
export * from './section-evidence-context.ts'
export * from './evidence-mapping-corpus.ts'
export * from './web-evidence-source-artifacts.ts'
export * from './web-evidence-snapshot.ts'
export {
  DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
  executeEvidenceMapping,
  executeEvidenceMappingFinalCheck,
  mergeEvidenceMappingPartialResults,
  readEvidenceMappingProgress,
  renderEvidenceMappingSubagentTask,
  buildEvidenceMappingPlan,
  type MergedEvidenceMappingResults,
} from './evidence-mapping-executor.ts'
export type { EvidenceMappingExecutionOptions } from './evidence-mapping-executor.ts'
export { validateEvidenceMapping } from './evidence-mapping-validator.ts'
export * from './outline-generation-artifacts.ts'
export * from './outline-confirmation-artifacts.ts'
export * from './outline-confirmation-edits.ts'
export * from './outline-confirmation-issues.ts'
export * from './outline-draft-store.ts'
export * from './outline-regeneration-artifacts.ts'
export { executeOutlineGeneration, renderOutlineGenerationRepairTask, renderOutlineGenerationTask, renderResponsePointSemanticReviewTask } from './outline-generation-executor.ts'
export { validateOutlineGeneration } from './outline-generation-validator.ts'
export { validateOutlineGenerationQuality } from './outline-generation-quality-validator.ts'
export { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
export { validateConfirmedOutline } from './outline-confirmation-validator.ts'
export * from './chapter-writing-artifacts.ts'
export * from './chapter-writing-review-artifacts.ts'
export * from './chapter-writing-plan-artifacts.ts'
export {
  DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
  buildChapterWorklist,
  executeChapterWriting,
  pickChapterContext,
  renderChapterExecutionPlanRepairTask,
  renderChapterExecutionPlanTask,
  renderChapterSubagentRepairTask,
  renderChapterSubagentTask,
  validateChapterCandidate,
} from './chapter-writing-executor.ts'
export type { ChapterWritingExecutionOptions } from './chapter-writing-executor.ts'
export { validateChapterWriting } from './chapter-writing-validator.ts'
export { executeDocxExport, validateDocxExport } from './docx-export.ts'
export { registerBidRuntimeProjection } from './projection.ts'
export { readBidProjectState, writeBidProjectState, checkpointBidProjectState } from './project-state.ts'
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
  /** Non-loopback browser authorities admitted to the direct binary S1 endpoint. */
  trustedHosts: string[]
  /** Word 自然语言格式建议的输出 token 上限。 */
  wordFormatMaxTokens: number
  /** Word 格式建议超时毫秒数。 */
  wordFormatTimeoutMs: number
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
  trustedHosts: [],
  wordFormatMaxTokens: 8192,
  wordFormatTimeoutMs: 120000,
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
  trustedHosts: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.trustedHosts),
  wordFormatMaxTokens: z.natural().min(256).max(32768).default(DEFAULT_HOST_RUNTIME_CONFIG.wordFormatMaxTokens),
  wordFormatTimeoutMs: z.natural().min(1000).max(600000).default(DEFAULT_HOST_RUNTIME_CONFIG.wordFormatTimeoutMs),
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
function intakeSuccess(value: BidRuntimeState, files?: readonly BidFileIntakeFileResult[]): BidFileIntakeResult {
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

/** Build one immutable, sanitized retry rejection. */
function retryRejected(code: BidRetryErrorCode, message: string): BidRetryResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
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

/** Build one immutable retry success result from the Host's log-derived state. */
function retrySuccess(value: BidRuntimeState): BidRetryResult {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) })
}

/** Build one immutable post-reset start result. */
function stageStartResult(
  result: { readonly ok: true; readonly value: BidRuntimeState }
    | { readonly ok: false; readonly code: BidStageStartErrorCode; readonly message: string },
): BidStageStartResult {
  return result.ok
    ? Object.freeze({ ok: true, value: Object.freeze({ ...result.value }) })
    : Object.freeze({ ok: false, error: Object.freeze({ code: result.code, message: result.message }) })
}

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
  interaction?: boolean
}

type BidProjectKey = string & { readonly __bidProjectKey: unique symbol }

/** 同一目录的符号链接及 Windows 大小写别名共用一把项目锁。 */
function projectKey(session: Pick<Session, 'header'>): BidProjectKey {
  if (session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
  const path = realpathSync(session.header.cwd)
  return (process.platform === 'win32' ? path.toLowerCase() : path) as BidProjectKey
}

/**
 * Replace model-visible messages produced by one Bid stage and every later stage.
 * The durable log remains intact for replay and audit.
 * @param session Live Bid session whose model-visible history is reset.
 * @param stage First stage whose context is discarded.
 * @param notice Model-visible replacement for the discarded context.
 */
function clearStageContext(
  session: Session,
  stage: BidStage,
  notice = `阶段 ${stage} 已重置。此前该阶段及后续阶段的上下文已清除；仅依据当前工作区文件和后续阶段指令重新执行。`,
): void {
  const stageIndex = BID_STAGES.indexOf(stage)
  const predecessor = stageIndex === 0 ? undefined : BID_STAGES[stageIndex - 1]
  const completedPredecessor = predecessor === undefined ? undefined : session.events.findLast(event => (
    event.type === 'bid.stage.completed' && event.data.stage === predecessor
  ))
  const nodes = session.surface.nodes
  const start = nodes.findIndex(seq => seq > (completedPredecessor?.seq ?? -1))
  if (start < 0) return
  const shadowed = nodes.slice(start)
  const first = shadowed[0]
  const last = shadowed.at(-1)
  if (first === undefined || last === undefined) return
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: notice }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice', summary: `已清除 ${stage} 及后续阶段上下文。` },
  }), {
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: [...shadowed],
  })
}

/** Host-owned Bid RPC runtime that serializes project mutations and publishes durable stage state. */
export class BidHostRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'sessions', 'subagents']
  static Config = Config

  private readonly config: Config
  private readonly inFlight = new Map<BidProjectKey, ActiveBidOperation>()

  /** 在第一次异步操作前占用项目，直到落盘和所有执行器完成。 */
  private beginOperation(session: Session): ActiveBidOperation {
    const key = projectKey(session)
    if (this.inFlight.has(key)) {
      throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Bid 操作正在执行。')
    }
    const settled = Promise.withResolvers<void>()
    const operation: ActiveBidOperation = {
      key,
      session,
      workspace: new BidWorkspace(key, workspaceConfig(this.config)),
      ready: false,
      controller: new AbortController(),
      done: settled.promise,
      settle: settled.resolve,
      reservedForReset: false,
    }
    this.inFlight.set(key, operation)
    return operation
  }

  /** 先持久化稳定状态，再释放项目；重置接管期间保留锁。 */
  private async finishOperation(session: Session, operation: ActiveBidOperation, persist = true): Promise<void> {
    const key = operation.key
    try {
      if (operation.ready && persist) {
        const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
        if (runtime.status === 'running' && this.inFlight.get(key) === operation) session.append('bid.stage.failed', {
          stage: runtime.stage, status: 'failed', reason: '阶段执行因后端停止而中断，请重试当前阶段。',
        })
        await this.checkpoint(operation)
      }
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
      operation.settle()
    }
  }

  /** 项目文件是操作授权依据，旧 Session 的投影在持锁后重新加载。 */
  private async prepareOperation(operation: ActiveBidOperation): Promise<BidRuntimeState> {
    const saved = await readBidProjectState(operation.workspace)
    const runtime: BidRuntimeState = saved?.runtime.status === 'running'
      ? { stage: saved.runtime.stage, status: 'failed', failureReason: '阶段执行因后端停止而中断，请重试当前阶段。' }
      : saved?.runtime ?? BID_INITIAL_RUNTIME_STATE
    const state = saved === undefined || saved.runtime.status === 'running'
      ? await checkpointBidProjectState(operation.workspace, runtime)
      : saved
    operation.session.append('bid.project.resumed', { runtime: state.runtime, revision: state.revision })
    operation.ready = true
    await this.publishProjectState(operation, state)
    return state.runtime
  }

  /** 只广播控制状态；每个 Session 保留独立的聊天、工具及模型上下文。 */
  private async publishProjectState(operation: ActiveBidOperation, state: BidProjectState): Promise<void> {
    const key = operation.key
    const sessions = [operation.session, ...this.ctx.sessions.list().filter((session) => {
      if (session === operation.session) return false
      if (!isBidMainSession(session) || session.header.cwd === undefined) return false
      try { return projectKey(session) === key } catch (error) {
        // 已删除或不可访问的其他工作区不参与当前项目的实时投影。
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
      }
    })]
    for (const session of sessions) {
      const last = session.events.at(-1)
      if (last?.type !== 'bid.project.resumed' || last.data.revision !== state.revision) {
        session.append('bid.project.resumed', { runtime: state.runtime, revision: state.revision })
      }
    }
    await Promise.all(sessions.map(session => this.ctx.sessions.flush(session)))
  }

  /** 执行器启动前及 Host 操作结束后共用的原子项目检查点。 */
  private async checkpoint(operation: ActiveBidOperation): Promise<void> {
    const runtime = operation.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    const state = await checkpointBidProjectState(operation.workspace, runtime)
    await this.publishProjectState(operation, state)
  }

  /**
   * @param ctx - Host Context that owns Sessions and their Bid projection.
   * @param config - validated file limits, model-stage recovery budget, and Subagent concurrency limits.
   */
  constructor(ctx: Context, config: Config = DEFAULT_HOST_RUNTIME_CONFIG) {
    super(ctx, 'bid')
    this.config = config
    for (const authority of config.trustedHosts) assertBidUploadTrustedAuthority(authority)
    ctx.effect(
      () => registerBidRuntimeProjection(ctx.sessionProjections, config),
      'bid: runtime projection',
    )
    ctx.on('session/prompt-admission', ({ session }) => {
      if (resolveSessionPreset(session) !== 'bid') return
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      const projection = getBidClientProjection(runtime)
      if (session.header.cwd !== undefined && this.inFlight.has(projectKey(session))) return { reason: 'bid.stage_running', message: '当前阶段操作尚未完成。' }
      if (projection.composer.enabled) return
      const reason = projection.composer.reason
      return {
        reason,
        message: `Bid session prompt rejected by Host admission: ${reason}`,
      }
    }, { global: true })
    installStageInteractionTools(ctx,
      (agent, request, signal) => this.executeStageInteraction(agent, request, signal),
      session => session.header.cwd !== undefined && this.inFlight.get(projectKey(session))?.interaction === true)
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => toolCtx.tools.guard((execution) => {
        const session = execution.agent?.session
        if (session === undefined || !isBidMainSession(session) || session.header.cwd === undefined) return
        const operation = this.inFlight.get(projectKey(session))
        if (operation !== undefined && operation.session !== session) return 'BID_OPERATION_IN_PROGRESS'
      }))
    })
    ctx.on('agent/session-start', ({ agent }) => {
      const cwd = agent.session.header.cwd
      if (agent.session.header.origin === 'subagent' || resolveSessionPreset(agent.session) !== 'bid' || cwd === undefined) return
      void this.driveStartedSession(agent, cwd).catch(error => ctx.logger.warn(`Bid 项目启动失败：${String(error)}`))
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
  }

  /** Main Agent 的阶段动作使用项目锁；失败恢复已保存产物，不产生确认事件。 */
  private async executeStageInteraction(agent: Agent, input: unknown, callerSignal: AbortSignal): Promise<unknown> {
    const { session } = agent
    const request = stageInteractionSchema.parse(input)
    if (!isBidMainSession(session) || session.header.cwd === undefined) throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '阶段工具只供 Bid Main Agent 使用。')
    if (this.inFlight.has(projectKey(session))) throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前阶段已有操作正在执行。')
    callerSignal.throwIfAborted()
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const operation = this.beginOperation(session)
    operation.interaction = true
    const signal = AbortSignal.any([callerSignal, operation.controller.signal])
    let started = false
    let runtime = BID_INITIAL_RUNTIME_STATE
    let restored = true
    const backup = new Map<string, string | null>()
    try {
      runtime = await this.prepareOperation(operation)
      if (runtime.status !== 'waiting_user' || (request.action !== 'bid_stage_inspect' && runtime.stage !== 'outline_generation' && runtime.stage !== 'evidence_mapping') || (request.action === 'bid_evidence_remap' && runtime.stage !== 'evidence_mapping')) throw new BidOrchestratorError('BID_ACTION_NOT_ALLOWED', '当前阶段不允许该操作。')
      if (request.action === 'bid_stage_inspect') return await inspectBidStage(workspace, session)
      const base = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== base.revision || request.expected_draft_sha256 !== base.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', current: base } }
      for (const path of ['outline/draft.json', 'outline/outline.json', 'outline/quality-report.json', ...(runtime.stage === 'evidence_mapping' ? ['analysis/evidence-map.json', 'analysis/evidence-map.candidate.json', 'analysis/evidence-mapping-quality.candidate.json', 'outline/refined-outline.candidate.json', 'analysis/web-evidence-sources.json', 'analysis/evidence-mapping-plan.json', 'analysis/evidence-mapping-log.json', 'analysis/evidence-mapping-checkpoint.json'] : [])]) {
        const absolute = within(workspace.projectRoot, path)
        await assertNoLinkedPath(workspace.root, absolute)
        try { backup.set(absolute, await readFile(absolute, 'utf8')) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          backup.set(absolute, null)
        }
      }
      signal.throwIfAborted()
      session.append('bid.stage.started', { stage: runtime.stage, status: 'running' })
      started = true
      await this.checkpoint(operation)
      const operations = request.action === 'bid_outline_regenerate_scope'
        ? await generateScopedOutlineOperations(agent, base, request.section_ids, request.feedback, signal)
        : request.action === 'bid_outline_apply_operations' ? parseOutlineEditOperations(request.operations) : []
      signal.throwIfAborted()
      restored = false
      const mutation = await mutateOutlineDraft(workspace, { ...request, operations })
      if (!mutation.ok) { restored = true; return mutation }
      signal.throwIfAborted()
      const draft = mutation.value
      if (request.action !== 'bid_evidence_remap') {
        restored = true
        return { ok: true, message: '已更新，请重新确认。', draft }
      }
      const persist = async (path: string, value: unknown): Promise<void> => {
        const absolute = within(workspace.projectRoot, path)
        await assertNoLinkedPath(workspace.root, absolute)
        await writeFileAtomic(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      const previousOutline = parseOutlineArtifact(await readStageJson(workspace, 'outline/outline.json'))
      await persist('outline/outline.json', draft.outline)
      await executeEvidenceMapping(agent, workspace, buildBidStageTask('evidence_mapping'), {
        maxRepairAttempts: this.config.modelStageRepairAttempts, maxConcurrency: this.config.evidenceMappingMaxConcurrency, signal,
        remap: {
          section_ids: request.section_ids,
          mode: request.mode,
          previous_outline: previousOutline,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      })
      signal.throwIfAborted()
      const checkedOutline = parseOutlineArtifact(await readStageJson(workspace, 'outline/outline.json'))
      for (const relative of ['outline/outline.json', 'outline/quality-report.json']) {
        const path = within(workspace.projectRoot, relative)
        const content = backup.get(path)
        if (content === undefined || content === null) throw new Error(`Missing research Artifact ${relative}`)
        await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
      }
      const updated = { ...draft, revision: Math.max(base.revision + 1, draft.revision),
        outline: checkedOutline, draft_outline_sha256: outlineArtifactSha256(checkedOutline) }
      await persist('outline/draft.json', updated)
      restored = true
      return { ok: true, message: '已更新，请重新确认。', draft: updated }
    } catch (error) {
      if (!restored) {
        for (const [path, content] of backup) {
          if (content === null) await rm(path, { force: true })
          else await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
        }
        restored = true
      }
      throw error
    } finally {
      if (started) {
        if (restored) session.append('bid.user_confirmation.required', { stage: runtime.stage, status: 'waiting_user' })
        else session.append('bid.stage.failed', { stage: runtime.stage, status: 'failed', reason: '阶段交互失败且产物恢复未完成，请重试。' })
      }
      try { await this.ctx.sessions.flush(session) } finally { await this.finishOperation(session, operation) }
    }
  }

  /** 新聊天仅从项目文件恢复控制状态，等待中的项目不重复运行阶段。 */
  private async driveStartedSession(agent: Agent, cwd: string): Promise<void> {
    const { session } = agent
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) {
      const checkpoint = active.session.events.findLast(event => event.type === 'bid.project.resumed')
      if (checkpoint !== undefined) {
        const runtime = active.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
        session.append('bid.project.resumed', { runtime, revision: checkpoint.data.revision })
        await this.ctx.sessions.flush(session)
      }
      await active.done
    }
    const operation = this.beginOperation(session)
    let driven = false
    try {
      const runtime = await this.prepareOperation(operation)
      if (runtime.status !== 'pending' || runtime.stage === 'file_intake') return
      driven = true
      const workspace = new BidWorkspace(cwd, workspaceConfig(this.config))
      await this.automaticOrchestrator(agent, workspace, operation.controller.signal).drive()
      await this.ctx.sessions.flush(session)
    } finally {
      await this.finishOperation(session, operation, driven)
    }
  }

  /** Build the production executor and Validator for implemented automatic stages. */
  private automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator {
    return new BidOrchestrator(
      agent.session,
      {
        canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping' || stage === 'outline_generation' || stage === 'chapter_writing',
        execute: async (task) => {
          const operation = this.inFlight.get(projectKey(agent.session))
          if (operation !== undefined) await this.checkpoint(operation)
          if (task.stage === 'docx_export') return executeDocxExport(workspace, signal)
          return task.stage === 'tender_analysis'
            ? executeTenderAnalysis(agent, workspace, task, { maxRepairAttempts: this.config.modelStageRepairAttempts, signal })
            : task.stage === 'evidence_mapping'
              ? executeEvidenceMapping(agent, workspace, task, {
                maxRepairAttempts: this.config.modelStageRepairAttempts,
                maxConcurrency: this.config.evidenceMappingMaxConcurrency,
                signal,
              })
              : task.stage === 'outline_generation'
                ? executeOutlineGeneration(agent, workspace, task, { maxRepairAttempts: this.config.modelStageRepairAttempts, signal })
                : task.stage === 'chapter_writing'
                  ? executeChapterWriting(agent, workspace, task, {
                    maxRepairAttempts: this.config.modelStageRepairAttempts,
                    maxConcurrency: this.config.chapterWritingMaxConcurrency,
                    signal,
                  })
                  : Promise.reject(new Error(`Bid Host has no executor for ${task.stage}`))
        },
      },
      {
        validate: (stage, artifacts) => stage === 'docx_export'
          ? validateDocxExport(workspace, stage, artifacts)
          : stage === 'tender_analysis'
            ? validateTenderAnalysis(workspace, stage, artifacts)
            : stage === 'evidence_mapping'
              ? validateEvidenceMapping(workspace, stage, artifacts)
              : stage === 'chapter_writing' ? validateChapterWriting(workspace, stage, artifacts)
                : validateOutlineGeneration(workspace, stage, artifacts),
      },
      signal,
    )
  }

  /**
   * Rewind to the current or an earlier Bid stage and stop before its Host driver starts.
   * Active work is cancelled and drained before artifacts owned by the selected
   * stage and every later stage are removed.
   * @param agent - live Bid Agent receiving the scoped command.
   * @param stage - current or earlier stage named by that command.
   * @returns the state at the explicit post-reset start gate.
   */
  async resetStage(agent: Agent, stage: BidStage): Promise<BidRuntimeState> {
    const { session } = agent
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
      throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', 'Stage reset requires a Bid Session with a Host workspace.')
    }
    const key = projectKey(session)
    const prior = this.inFlight.get(key)
    if (prior !== undefined) {
      if (prior.reservedForReset || prior.session !== session) {
        throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前项目已有 Bid 操作正在执行。')
      }
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (BID_STAGES.indexOf(stage) > BID_STAGES.indexOf(runtime.stage)) throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', '不能重置尚未开始的阶段。')
      this.inFlight.delete(key)
    }
    const operation = this.beginOperation(session)
    operation.reservedForReset = true
    try {
      prior?.controller.abort()
      agent.cancel({ kind: 'hook', reason: 'bid-stage-reset' })
      await Promise.all([prior?.done ?? Promise.resolve(), agent.whenIdle()])
      const runtime = await this.prepareOperation(operation)
      if (BID_STAGES.indexOf(stage) > BID_STAGES.indexOf(runtime.stage)) throw new BidOrchestratorError('BID_STAGE_RESET_NOT_ALLOWED', '不能重置尚未开始的阶段。')
      agent.inbox.clear()
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const resetPaths: Readonly<Record<BidStage, readonly string[]>> = {
        file_intake: ['analysis', 'outline', 'chapters', 'output'],
        tender_analysis: ['analysis', 'outline', 'chapters', 'output'],
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
          'output',
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
          'output',
        ],
        chapter_writing: ['chapters', 'output'],
        docx_export: ['output'],
      }
      const paths = resetPaths[stage].map(path => within(workspace.projectRoot, path))
      for (const path of paths) await assertNoLinkedPath(workspace.root, path)
      await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })))
      clearStageContext(session, stage)
      session.append('bid.stage.reset', { stage, status: stage === 'file_intake' ? 'pending' : 'waiting_start' })
      await this.ctx.sessions.flush(session)
      return session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    } finally {
      operation.reservedForReset = false
      await this.finishOperation(session, operation)
    }
  }

  /**
   * Start the stage that a completed reset left at its explicit user gate.
   * @param session - Host-resolved Bid Session whose reset state authorizes execution.
   * @returns the stage state after normal execution reaches validation, failure, or completion.
   */
  @Remote('startStage')
  async startStage(session: Session): Promise<BidStageStartResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
      return stageStartResult({ ok: false, code: 'BID_SESSION_REQUIRED', message: 'Stage start requires a Bid Session with a Host workspace.' })
    }
    if (this.inFlight.has(projectKey(session))) {
      return stageStartResult({ ok: false, code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' })
    }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('start_stage')) {
        return stageStartResult({ ok: false, code: 'BID_STAGE_START_NOT_ALLOWED', message: 'The current stage is not waiting for a post-reset start.' })
      }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) {
        return stageStartResult({ ok: false, code: 'BID_STAGE_START_FAILED', message: 'Bid Session has no live Agent.' })
      }
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const next = await this.automaticOrchestrator(agent, workspace, operation.controller.signal).startResetStage()
      await this.ctx.sessions.flush(session)
      return stageStartResult({ ok: true, value: next })
    } catch (error: unknown) {
      if (error instanceof BidOrchestratorError) {
        const code = error.code === 'BID_OPERATION_IN_PROGRESS'
          ? 'BID_OPERATION_IN_PROGRESS'
          : 'BID_STAGE_START_NOT_ALLOWED'
        return stageStartResult({ ok: false, code, message: error.message })
      }
      return stageStartResult({ ok: false, code: 'BID_STAGE_START_FAILED', message: 'The Bid Host could not start the reset stage.' })
    } finally {
      await this.finishOperation(session, operation)
    }
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
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
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      validateBidFileBatch(incoming, workspace.config)
      let imported: ImportedFile[] = []
      const orchestrator = new BidOrchestrator(
        session,
        {
          canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping' || stage === 'outline_generation' || stage === 'chapter_writing',
          execute: async (task) => {
            await this.checkpoint(operation)
            if (task.stage === 'file_intake') {
              try {
                imported = await workspace.import(incoming)
              } catch {
                throw new Error('file intake could not persist the selected files')
              }
              if (failures.length > 0) {
                throw new Error('file intake could not decode every selected file')
              }
              const artifact: StageArtifact = { stage: 'file_intake', type: 'manifest', path: 'manifest.json' }
              return [artifact]
            }
            if (task.stage === 'docx_export') return executeDocxExport(workspace, operation.controller.signal)
            const repair = { maxRepairAttempts: this.config.modelStageRepairAttempts, signal: operation.controller.signal }
            if (task.stage === 'tender_analysis') return executeTenderAnalysis(agent, workspace, task, repair)
            if (task.stage === 'evidence_mapping') return executeEvidenceMapping(agent, workspace, task, {
              ...repair,
              maxConcurrency: this.config.evidenceMappingMaxConcurrency,
            })
            if (task.stage === 'outline_generation') return executeOutlineGeneration(agent, workspace, task, repair)
            if (task.stage === 'chapter_writing') return executeChapterWriting(agent, workspace, task, {
              ...repair,
              maxConcurrency: this.config.chapterWritingMaxConcurrency,
            })
            throw new Error(`Bid Host has no executor for ${task.stage}`)
          },
        },
        {
          validate: (stage, artifacts) => stage === 'docx_export'
            ? validateDocxExport(workspace, stage, artifacts)
            : stage === 'file_intake'
              ? validateFileIntake(workspace, imported, stage, artifacts, incoming)
              : stage === 'tender_analysis'
                ? validateTenderAnalysis(workspace, stage, artifacts)
                : stage === 'evidence_mapping'
                  ? validateEvidenceMapping(workspace, stage, artifacts)
                  : stage === 'outline_generation'
                    ? validateOutlineGeneration(workspace, stage, artifacts)
                    : stage === 'chapter_writing'
                      ? validateChapterWriting(workspace, stage, artifacts)
                      : validateOutlineGeneration(workspace, stage, artifacts),
        },
        operation.controller.signal,
      )
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
            next.failureReason ?? 'The Bid Host rejected the imported file artifacts.',
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
      if (session === undefined || metadata === undefined) throw new Error('bid-invalid-file-data')
      const files = parseBinaryUploadFiles(decodeURIComponent(metadata))
      const incoming = await readBinaryUpload(req, files, this.config)
      result = await this.uploadIncomingFiles(session, incoming)
    } catch (error) {
      result = session === undefined ? intakeError(error) : await this.recordBinaryUploadFailure(session, error)
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
      if (session === undefined || resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
        throw new Error('Word 模板需要标书项目会话。')
      }
      const bytes = await readExactRequestBody(req, size, 'DOCX 模板内容与声明大小不一致。')
      const operation = this.beginOperation(session)
      try {
        result = { ok: true, value: await saveDocxTemplate(operation.workspace, {
          revision,
          name: decodeURIComponent(nameHeader),
          bytes,
        }) }
      } finally { await this.finishOperation(session, operation, false) }
    } catch (error) {
      result = docxTemplateUploadFailure(error)
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  }

  /** Record an S1 failure when a selected binary upload cannot be fully reconstructed. */
  private async recordBinaryUploadFailure(session: Session, error: unknown): Promise<BidFileIntakeResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return intakeError(error)
    if (this.inFlight.has(projectKey(session))) return intakeRejected('BID_OPERATION_IN_PROGRESS', 'A file-intake operation is already running for this Bid Session.')
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('upload_files')) {
        return intakeRejected('BID_FILE_INTAKE_NOT_ALLOWED', 'File intake is not allowed in the current Bid stage state.')
      }
      const orchestrator = new BidOrchestrator(
        session,
        {
          canExecute: () => false,
          execute: async () => {
            await this.checkpoint(operation)
            throw new Error('file intake could not reconstruct every selected file')
          },
        },
        { validate: () => Promise.resolve({ ok: true }) },
      )
      const failed = await orchestrator.runCurrentProgramStage()
      await this.ctx.sessions.flush(session)
      return intakeRejected('BID_FILE_INTAKE_FAILED', failed.failureReason ?? intakeFailure(error).message)
    } catch (caught) {
      return intakeError(caught)
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /**
   * Retry the failed tender-analysis stage through the live Bid Agent.
   * @param session - Host-resolved live Session whose event log authorizes the retry.
   * @returns the post-retry runtime state, including a failed S2 state when validation rejects again.
   */
  @Remote('retryStage')
  async retryStage(session: Session): Promise<BidRetryResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
      return retryRejected('BID_SESSION_REQUIRED', 'Retry requires a Bid Session with a Host workspace.')
    }
    if (this.inFlight.has(projectKey(session))) {
      return retryRejected('BID_OPERATION_IN_PROGRESS', 'A Bid operation is already running for this Session.')
    }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('retry_stage')) {
        return retryRejected('BID_RETRY_NOT_ALLOWED', 'Retry is not allowed in the current Bid stage state.')
      }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) return retryRejected('BID_RETRY_FAILED', 'Bid Session has no live Agent.')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const orchestrator = this.automaticOrchestrator(agent, workspace, operation.controller.signal)
      const next = await orchestrator.retry()
      await this.ctx.sessions.flush(session)
      return retrySuccess(next)
    } catch (error: unknown) {
      if (error instanceof BidOrchestratorError) {
        if (error.code === 'BID_OPERATION_IN_PROGRESS') {
          return retryRejected('BID_OPERATION_IN_PROGRESS', error.message)
        }
        return retryRejected('BID_RETRY_NOT_ALLOWED', error.message)
      }
      return retryRejected('BID_RETRY_FAILED', 'The Bid Host could not retry the current stage.')
    } finally {
      await this.finishOperation(session, operation)
    }
  }

  /** 读取项目 Word 配置，不解析模板或生成文件。
   * @param session 当前标书会话。
   * @returns 已保存格式与来源。
   */
  @Remote('getDocxFormat')
  async getDocxFormat(session: Session): Promise<DocxFormatView> {
    if (resolveSessionPreset(session) !== 'bid' || !session.header.cwd) throw new Error('Word 配置需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const view = await readDocxFormat(workspace)
    const project = await readBidProjectState(workspace)
    if (project?.runtime.stage === 'docx_export' && project.runtime.status !== 'running' || project?.runtime.stage === 'chapter_writing' && project.runtime.status === 'completed') {
      return collectDocxMarkdown(workspace).then(async markdown => ({
        ...view, fingerprint: docxFingerprint(markdown, view, await docxAssetHash(workspace, markdown)),
      })).catch(() => ({
        ...view, warnings: [...view.warnings, '当前正文或图片无法用于导出，请在更新预览时检查具体错误；已保存配置和旧文件仍可使用。'],
      }))
    }
    return view
  }

  /** 保存项目格式，独立于 S1—S5 的资料与阶段状态。
   * @param session 当前标书会话。
   * @param request 包含版本及用户配置的请求；模板字节使用独立二进制端点。
   * @returns 保存后的格式。
   */
  @Remote('saveDocxFormat')
  async saveDocxFormat(session: Session, request: DocxFormatRequest): Promise<DocxFormatView> {
    if (resolveSessionPreset(session) !== 'bid' || !session.header.cwd) throw new Error('Word 配置需要标书项目会话。')
    const operation = this.beginOperation(session)
    try { return await saveDocxFormat(operation.workspace, request) }
    finally { await this.finishOperation(session, operation, false) }
  }

  /** 使用已保存配置和固定正文快照生成浏览器预览，不完成 S6。
   * @param session 当前标书会话。
   * @returns 带内容标识的样式预览。
   */
  @Remote('previewDocx')
  async previewDocx(session: Session): Promise<DocxFormatView> {
    if (resolveSessionPreset(session) !== 'bid' || !session.header.cwd) throw new Error('Word 预览需要标书项目会话。')
    const operation = this.beginOperation(session)
    try {
      const view = await readDocxFormat(operation.workspace)
      const markdown = await collectDocxMarkdown(operation.workspace)
      const rendered = await renderDocx(operation.workspace, markdown, view.values, true)
      return { ...view, fingerprint: docxFingerprint(markdown, view, rendered.assetHash), previewHtml: rendered.html }
    } finally { await this.finishOperation(session, operation, false) }
  }

  /** 生成待确认的格式建议，不修改模板、正文或生效配置。
   * @param session 当前标书会话。
   * @returns 带来源原文的建议。
   */
  @Remote('suggestDocxFormat')
  async suggestDocxFormat(session: Session): Promise<DocxFormatSuggestion> {
    if (resolveSessionPreset(session) !== 'bid' || !session.header.cwd) throw new Error('格式建议需要标书项目会话。')
    const operation = this.beginOperation(session)
    try {
      return await suggestDocxFormat(
        this.ctx, session, await readDocxFormat(operation.workspace),
        AbortSignal.any([operation.controller.signal, AbortSignal.timeout(this.config.wordFormatTimeoutMs)]),
        this.config.wordFormatMaxTokens,
      )
    }
    finally { await this.finishOperation(session, operation, false) }
  }

  /** 下载当前项目最近一次成功的 Word，不接受浏览器文件路径。
   * @param session 当前标书会话。
   * @returns 下载名称和文件字节。
   */
  @Remote('downloadDocx')
  async downloadDocx(session: Session): Promise<{ data: string; name: string }> {
    if (resolveSessionPreset(session) !== 'bid' || !session.header.cwd) throw new Error('下载需要标书项目会话。')
    const workspace = new BidWorkspace(projectKey(session), workspaceConfig(this.config))
    const view = await readDocxFormat(workspace)
    if (!view.state.lastExport) throw new Error('请先生成 Word。')
    const path = within(workspace.projectRoot, view.state.lastExport.path)
    if (!path.startsWith(workspace.outputRoot + sep)) throw new Error('Word 文件不在输出目录中。')
    await assertNoLinkedPath(workspace.root, path)
    return { data: (await readFile(path)).toString('base64'), name: basename(path) }
  }

  /**
   * Generate a fresh Word file from completed S5 artifacts without leaving the review stage.
   * @param session Bid Session whose completed chapter artifacts are exported.
   * @returns Export result containing either the generated file metadata or a stable rejection.
   */
  @Remote('exportDocx')
  async exportDocx(session: Session): Promise<BidDocxExportResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
      return docxExportRejected('BID_SESSION_REQUIRED', 'Word 导出需要标书项目会话。')
    }
    if (this.inFlight.has(projectKey(session))) {
      return docxExportRejected('BID_OPERATION_IN_PROGRESS', 'A Bid operation is already running for this Session.')
    }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('export_docx')) {
        return docxExportRejected('BID_DOCX_EXPORT_NOT_ALLOWED', '正文编写完成后才能生成 Word。')
      }
      const destination = `${operation.workspace.config.outputDirectory}/bid-${String(Date.now())}-${randomBytes(3).toString('hex')}.docx`
      const artifacts = await executeDocxExport(operation.workspace, operation.controller.signal, destination)
      const validation = await validateDocxExport(operation.workspace, 'docx_export', artifacts)
      if (!validation.ok) {
        return docxExportRejected('BID_DOCX_EXPORT_FAILED', '生成的 Word 文件结构无效。', validation.issues)
      }
      if (runtime.stage === 'docx_export' && runtime.status !== 'completed') {
        session.append('bid.stage.started', { stage: 'docx_export', status: 'running' })
        session.append('bid.stage.completed', { stage: 'docx_export', status: 'completed', artifacts })
        await this.checkpoint(operation)
      }
      return { ok: true, value: { path: destination } }
    } catch (error: unknown) {
      if (error instanceof BidStageExecutionError) {
        return docxExportRejected('BID_DOCX_EXPORT_FAILED', '已完成章节无法导出，请检查正文完整性。', error.issues)
      }
      return docxExportRejected('BID_DOCX_EXPORT_FAILED', error instanceof Error ? error.message : 'Word 生成失败，请重试。')
    } finally {
      await this.finishOperation(session, operation, false)
    }
  }

  /**
   * 将用户意见交给目标章节原 Writer；整个操作互斥，失败保留正文。
   * @param session 发起修订的 Bid 会话。
   * @param request 章节或完整连续段落引用与编写意见。
   * @returns 新正文，或可重新选择原文后重试的业务错误。
   */
  @Remote('reviseChapter')
  async reviseChapter(session: Session, request: BidChapterRevisionRequest): Promise<BidChapterRevisionResult> {
    const reject = (code: string, message: string): BidChapterRevisionResult => ({ ok: false, error: { code, message } })
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) {
      return reject('BID_SESSION_REQUIRED', '章节修订需要标书项目会话。')
    }
    if (this.inFlight.has(projectKey(session))) return reject('BID_OPERATION_IN_PROGRESS', '当前项目仍有操作正在执行。')
    const parsed = chapterRevisionRequestSchema.safeParse(request)
    if (!parsed.success) return reject('BID_CHAPTER_REVISION_INVALID', '请选择章节或完整相邻段落，并填写编写意见。')
    const operation = this.beginOperation(session)
    let resumedParent: AgentHandle | undefined
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('revise_chapter')) {
        return reject('BID_CHAPTER_REVISION_NOT_ALLOWED', '正文编写完成后才能提交修订意见。')
      }
      const logPath = within(operation.workspace.projectRoot, 'chapters/execution-log.json')
      await assertNoLinkedPath(operation.workspace.root, logPath)
      const log = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
      const writerId = log.sections.find(section => section.section_id === parsed.data.reference.section_id)?.final_writer_child_session_id
      if (writerId == null) return reject('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE', '该章节缺少原编写会话，无法保留上下文继续修订。')
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) return reject('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE', '原编写会话的持久化存储不可用。')
      const writer = await persistence.inspect(SessionId(writerId), operation.controller.signal)
      const parentId = writer.meta.parentSession
      if (parentId === undefined || writer.meta.cwd === undefined
        || projectKey({ header: writer.meta }) !== projectKey(session)) {
        return reject('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE', '原编写会话不属于当前标书项目。')
      }
      let parent = this.ctx.agents.get(parentId)
      if (parent === undefined) {
        resumedParent = await this.ctx.agents.resume({
          resumeSessionId: parentId, signal: operation.controller.signal,
          setup(parentContext) {
            parentContext.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
          },
        })
        parent = resumedParent.agent
      }
      if (parent.session.header.cwd === undefined || projectKey(parent.session) !== projectKey(session)) {
        return reject('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE', '原编写会话的父会话不属于当前标书项目。')
      }
      await executeChapterWriting(parent, operation.workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: this.config.modelStageRepairAttempts,
        maxConcurrency: this.config.chapterWritingMaxConcurrency,
        signal: operation.controller.signal,
        revision: parsed.data,
      })
      return { ok: true, value: await this.getReviewChapter(session, parsed.data.reference.section_id) }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : ''
      if (reason.includes('BID_CHAPTER_REVISION_CONFLICT')) return reject('BID_CHAPTER_REVISION_CONFLICT', '章节正文已变化，请重新选择章节或段落。')
      if (reason.includes('BID_CHAPTER_REVISION_SELECTION_INVALID')) return reject('BID_CHAPTER_REVISION_SELECTION_INVALID', '请选择同一章节中的一个或相邻多个完整段落。')
      if (reason.includes('BID_CHAPTER_REVISION_NOT_WRITABLE')) return reject('BID_CHAPTER_REVISION_NOT_WRITABLE', '目录分组标题不能编写，请选择有正文的章节。')
      if (reason.includes('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')) return reject('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE', '章节原编写会话或已完成产物不可恢复，未创建替代 Writer。')
      return reject('BID_CHAPTER_REVISION_FAILED', '原章节 Writer 未完成修订，正文已保留，请重试。')
    } finally {
      try { await resumedParent?.dispose() } finally { await this.finishOperation(session, operation, false) }
    }
  }

  /**
   * Read the live S5 writing and per-chapter review state without disclosing workspace paths.
   * @param session Bid Session whose writing workbench is requested.
   * @returns Browser-safe chapter workbench rows and aggregate progress.
   */
  @Remote('getReviewWorkbench')
  async getReviewWorkbench(session: Session): Promise<BidReviewWorkbenchView> {
    const workspace = this.requireReviewWorkspace(session)
    const outlinePath = within(workspace.projectRoot, 'outline/confirmed-outline.json')
    const logPath = within(workspace.projectRoot, 'chapters/execution-log.json')
    await Promise.all([assertNoLinkedPath(workspace.root, outlinePath), assertNoLinkedPath(workspace.root, logPath)])
    const outlineRaw = await readFile(outlinePath, 'utf8')
    const outline = parseOutlineArtifact(JSON.parse(outlineRaw))
    let log: ReturnType<typeof parseChapterExecutionLog> | undefined
    try { log = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8'))) } catch { log = undefined }
    const worklist = buildChapterWorklist(outline)
    const rowContents = await Promise.all(outline.sections.map(async (section) => {
      const index = worklist.findIndex(item => item.id === section.id)
      const serial = String(index + 1).padStart(4, '0')
      const execution = log?.sections.find(item => item.section_id === section.id)
      let contentAvailable = !section.writable && section.summary !== undefined
      let markdown = !section.writable ? section.summary ?? '' : ''
      let reviewStatus: BidReviewWorkbenchView['outline'][number]['review_status'] = 'not_started'
      if (section.writable && index >= 0) {
        try {
          markdown = await readFile(within(workspace.projectRoot, `chapters/sections/${serial}.md`), 'utf8')
          contentAvailable = markdown.trim().length > 0
        } catch { markdown = ''; contentAvailable = false }
        try {
          const review = parseChapterReviewArtifact(JSON.parse(await readFile(within(workspace.projectRoot, `chapters/reviews/${serial}.json`), 'utf8')))
          reviewStatus = review.verdict === 'pass' ? 'pass' : 'needs_attention'
        } catch {
          reviewStatus = execution?.status === 'failed' ? 'failed' : contentAvailable ? 'reviewing' : 'not_started'
        }
      }
      const writingStatus: BidReviewWorkbenchView['outline'][number]['writing_status'] = !section.writable || execution === undefined || execution.status === 'pending'
        ? 'not_started'
        : execution.status === 'running' ? contentAvailable ? 'content_ready' : 'writing' : execution.status
      return { markdown, row: {
        section_id: section.id,
        parent_id: section.parent_id,
        order: section.order,
        title: section.title,
        ...(section.summary === undefined ? {} : { summary: section.summary }),
        writable: section.writable,
        writing_status: writingStatus,
        review_status: reviewStatus,
        content_available: contentAvailable,
      } }
    }))
    let rows = rowContents.map(item => item.row)
    let pageEstimate: BidReviewWorkbenchView['summary']['page_estimate'] = { status: 'unavailable' }
    try {
      const positions = new Map(buildOutlineView(outline.sections).map(item => [item.section.id, item]))
      const estimateSections: PageEstimateSection[] = outline.sections.map((section, index) => {
        const position = positions.get(section.id)
        if (position === undefined) throw new Error('目录章节缺少导出位置。')
        const source = rowContents[index]?.markdown ?? ''
        return {
          section_id: section.id, parent_id: section.parent_id, number: position.number, depth: position.depth, title: section.title,
          writable: section.writable,
          markdown: section.writable && source.trim() !== ''
            ? collectDocxChapterBody(source, section.title, section.id, position.number, Math.min(6, position.depth))
            : source,
        }
      })
      const estimate = await estimateReviewPages(
        workspace,
        outline.document_title,
        estimateSections,
        (await readDocxFormat(workspace)).values,
      )
      pageEstimate = estimate.total > 0 ? { status: 'available', pages: Math.ceil(estimate.total) } : { status: 'empty' }
      const children = new Set(outline.sections.flatMap(section => section.parent_id === null ? [] : [section.parent_id]))
      rows = rows.map((row) => {
        if (!children.has(row.section_id)) return row
        const section = estimate.sections.get(row.section_id)
        if (section === undefined || !section.hasContent) return { ...row, page_estimate: { status: 'empty' as const } }
        return { ...row, page_estimate: { status: 'available' as const, pages: Math.ceil(section.pages), ...(section.incomplete ? { incomplete: true } : {}) } }
      })
    } catch { rows = rows.map(row => ({
      ...row,
      ...(outline.sections.some(section => section.parent_id === row.section_id) ? { page_estimate: { status: 'unavailable' as const } } : {}),
    })) }
    const writable = rows.filter(row => row.writable)
    return {
      schema_version: 1,
      outline: rows,
      summary: {
        chapter_count: writable.length,
        content_count: writable.filter(row => row.content_available).length,
        reviewed_count: writable.filter(row => row.review_status === 'pass' || row.review_status === 'needs_attention').length,
        needs_attention_count: writable.filter(row => row.review_status === 'needs_attention').length,
        page_estimate: pageEstimate,
      },
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
    if (!section.writable) return { section_id: section.id, title: section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: false, markdown: section.summary ?? null, content_sha256: null, requirement_ids: [], scoring_response_point_ids: [], evidence_status: 'not_applicable', review: { status: 'not_started', issues: [] } }
    const index = buildChapterWorklist(outline).findIndex(item => item.id === section.id)
    if (index < 0) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    const serial = String(index + 1).padStart(4, '0')
    let markdown: string | null = null
    try { markdown = await readFile(within(workspace.projectRoot, `chapters/sections/${serial}.md`), 'utf8') } catch { markdown = null }
    let review: BidReviewChapterView['review'] = { status: markdown === null ? 'not_started' : 'reviewing', issues: [] }
    try {
      const artifact = parseChapterReviewArtifact(JSON.parse(await readFile(within(workspace.projectRoot, `chapters/reviews/${serial}.json`), 'utf8')))
      review = {
        status: artifact.verdict === 'pass' ? 'pass' : 'needs_attention',
        issues: artifact.blocking_issues.map((detail, issueIndex) => ({
          issue_id: `${section.id}-${String(issueIndex + 1)}`, section_id: section.id, category: 'chapter_review', severity: 'blocking', status: 'open', title: '章节审查问题', detail, suggestion: '根据审查意见人工确认或修订。',
        })),
      }
    } catch { /* Review is not available until its independent reviewer finishes. */ }
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
    return { section_id: section.id, title: section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: true, markdown, content_sha256: markdown === null ? null : chapterContentSha256(markdown), requirement_ids: section.requirement_ids, scoring_response_point_ids: section.scoring_response_point_ids ?? [], evidence_status: evidenceStatus, materials, review }
  }

  /** Admit the S5 workbench while writing is running or after its last result. */
  private requireReviewWorkspace(session: Session): BidWorkspace {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'chapter_writing' && runtime.stage !== 'docx_export') throw new Error('BID_REVIEW_NOT_ALLOWED')
    return new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
  }

  /**
   * Read the current S4 Mapping Task counts while evidence mapping runs.
   * @param session - Bid Session that owns the S4 execution log.
   * @returns task counts, or null when S4 is not running or has not produced its log.
   */
  @Remote('getEvidenceMappingProgress')
  async getEvidenceMappingProgress(session: Session): Promise<BidEvidenceMappingProgress | null> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'evidence_mapping' || runtime.status !== 'running') return null
    return readEvidenceMappingProgress(new BidWorkspace(session.header.cwd, workspaceConfig(this.config)))
  }

  /**
   * 组装 Bid 详情页可读取的已发布阶段产物。
   * @param session 持有已恢复项目状态的 Bid 会话。
   * @returns 已发布的招标信息、目录和正文入口；S4 等待确认时使用已生成目录，执行中保留 S3 确认目录。
   */
  @Remote('getDetails')
  async getDetails(session: Session): Promise<BidDetailsView> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
    const body = runtime.stage === 'chapter_writing' || runtime.stage === 'docx_export'
    const finalOutline = body || (runtime.stage === 'evidence_mapping' && runtime.status === 'completed')
    const reviewingOutline = runtime.stage === 'evidence_mapping' && runtime.status === 'waiting_user'
    const initialOutline = runtime.stage === 'evidence_mapping' || (runtime.stage === 'outline_generation' && runtime.status === 'completed')
    const tenderReady = runtime.stage !== 'file_intake' && (runtime.stage !== 'tender_analysis' || runtime.status === 'waiting_user' || runtime.status === 'completed')
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
    return { tender, outline, body, outlinePresentation: outline === null ? null : { source, baseline, evidence, errors } }
  }

  /**
   * 读取 S2 待确认或已确认结论；编辑准入仍由 confirmTenderAnalysis 校验。
   * @param session 持有招标分析产物的 Bid 会话。
   * @returns 分析产物及评分响应项选择状态。
   */
  @Remote('getTenderAnalysisForConfirmation')
  async getTenderAnalysisForConfirmation(session: Session): Promise<TenderAnalysisConfirmationView> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage === 'file_intake' || (runtime.stage === 'tender_analysis' && runtime.status !== 'waiting_user' && runtime.status !== 'completed')) throw new Error('Tender-analysis details are not available in the current Bid stage state.')
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
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
      await writeFileAtomic(selectionPath, `${JSON.stringify({ schema_version: 1, selected_scoring_ids: next.selected_scoring_ids }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Tender-analysis confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_tender_analysis')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Tender-analysis confirmation is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const projectPath = within(workspace.projectRoot, 'analysis/project.json')
      const requirementsPath = within(workspace.projectRoot, 'analysis/requirements.json')
      const scoringPath = within(workspace.projectRoot, 'analysis/scoring.json')
      const compliancePath = within(workspace.projectRoot, 'analysis/compliance.json')
      await Promise.all([projectPath, requirementsPath, scoringPath, compliancePath].map(path => assertNoLinkedPath(workspace.root, path)))
      const [source, projectRaw, requirementsRaw, complianceRaw] = await Promise.all([
        readTenderAnalysisConfirmationView(workspace),
        readFile(projectPath, 'utf8'),
        readFile(requirementsPath, 'utf8'),
        readFile(compliancePath, 'utf8'),
      ])
      let candidate: TenderAnalysisConfirmationView
      try {
        candidate = applyTenderAnalysisEdits(
          source,
          parseTenderAnalysisEditOperations(operations),
        )
      } catch (error: unknown) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The requested tender-analysis edits are invalid.', issues: [{ code: 'TENDER_ANALYSIS_EDIT_INVALID', message: error instanceof Error ? error.message : 'The requested tender-analysis edits are invalid.' }] } }
      }
      const restore = async (): Promise<void> => {
        await writeFileAtomic(projectPath, projectRaw, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(requirementsPath, requirementsRaw, { mode: 0o600, dirMode: 0o700 })
        await rm(scoringPath, { force: true })
        await writeFileAtomic(compliancePath, complianceRaw, { mode: 0o600, dirMode: 0o700 })
      }
      try {
        await writeFileAtomic(projectPath, `${JSON.stringify(candidate.project, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(requirementsPath, `${JSON.stringify(candidate.requirements, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(scoringPath, `${JSON.stringify(createConfirmedTenderScoring(candidate), null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(compliancePath, `${JSON.stringify(candidate.compliance, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
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
          await rm(path, { force: true })
        }))
      } catch (error: unknown) {
        await restore()
        throw error
      }
      const artifacts: StageArtifact[] = [
        { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
        { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
        { stage: 'tender_analysis', type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
        { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
      ]
      const validation = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
      if (!validation.ok) {
        await restore()
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The edited tender analysis does not satisfy S2 validation.', issues: validation.issues } }
      }
      clearStageContext(
        session,
        'tender_analysis',
        `招标分析已确认。后续目录生成只能读取 analysis/scoring.json 中的正式评分：${JSON.stringify(createConfirmedTenderScoring(candidate).scoring_items.map(item => item.id))}。此前 S2 的原始评分、选择和对话均不得作为 S3 输入。`,
      )
      const confirmation = await this.automaticOrchestrator(agent, workspace, operation.controller.signal).confirmValidatedStage('tender_analysis', artifacts)
      if (!confirmation.ok) {
        await restore()
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) await active.done
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if ((runtime.stage !== 'outline_generation' && runtime.stage !== 'evidence_mapping') || runtime.status !== 'waiting_user') throw new Error('Outline confirmation is not allowed in the current Bid stage state.')
      return await getOrCreateOutlineDraft(operation.workspace)
    } finally { await this.finishOperation(session, operation, false) }
  }

  /**
   * 读取目录差异审阅所需的上游事实和基线。
   * @param session 等待目录确认的 Bid 会话。
   * @returns S3 确认基线及已有章节关联资料；不运行生成或映射。
   */
  @Remote('getOutlineReviewContext')
  async getOutlineReviewContext(session: Session): Promise<OutlineReviewContext> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const key = projectKey(session)
    for (let active = this.inFlight.get(key); active !== undefined; active = this.inFlight.get(key)) await active.done
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if ((runtime.stage !== 'outline_generation' && runtime.stage !== 'evidence_mapping') || runtime.status !== 'waiting_user') throw new Error('Outline review is not allowed in the current Bid stage state.')
      const workspace = operation.workspace
      const [requirements, scoring, baseline, evidence] = await Promise.all([
        readStageJson(workspace, 'analysis/requirements.json').then(parseTenderRequirementsArtifact),
        readStageJson(workspace, 'analysis/scoring.json').then(parseTenderScoringArtifact),
        runtime.stage === 'evidence_mapping' ? readStageJson(workspace, 'outline/initial-confirmed-outline.json').then(parseOutlineArtifact) : null,
        runtime.stage === 'evidence_mapping' ? readStageJson(workspace, 'analysis/evidence-map.json').then(parseEvidenceMapArtifact) : null,
      ])
      return { requirements, scoring, baseline, evidence }
    } finally { await this.finishOperation(session, operation, false) }
  }

  /**
   * 使用 CAS 保存目录编辑；仅校验结构和覆盖，S4 语义复核留到最终确认。
   * @param session 等待目录确认的 Bid 会话。
   * @param request 携带 Draft 身份的结构编辑操作。
   * @returns 更新后的 Draft，或冲突及校验问题。
   */
  @Remote('applyOutlineDraftOperations')
  async applyOutlineDraftOperations(session: Session, request: OutlineDraftMutationRequest): Promise<OutlineDraftMutationResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    if (this.inFlight.has(projectKey(session))) throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', '当前阶段已有操作正在执行。')
    const operation = this.beginOperation(session)
    try {
      const runtime = await this.prepareOperation(operation)
      if ((runtime.stage !== 'outline_generation' && runtime.stage !== 'evidence_mapping') || runtime.status !== 'waiting_user') throw new Error('Outline draft editing is not allowed in the current Bid stage state.')
      return await mutateOutlineDraft(new BidWorkspace(session.header.cwd, workspaceConfig(this.config)), request)
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const operation = this.beginOperation(session)
    const backup = new Map<string, string | null>()
    const restore = async (): Promise<void> => {
      for (const [path, content] of backup) {
        if (content === null) await rm(path, { force: true })
        else await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
      }
      backup.clear()
    }
    try {
      const runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_outline')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Outline confirmation is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      let candidate = draft.outline
      const sharedInputs = await Promise.all([
        'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json', 'analysis/scoring-response-points.json',
      ].map(async (path): Promise<unknown> => JSON.parse(
        await readFile(within(workspace.projectRoot, path), 'utf8'),
      ) as unknown))
      const prevalidation = validateOutlineDraftForConfirmation(
        candidate,
        sharedInputs[0],
        sharedInputs[1],
        sharedInputs[2],
        sharedInputs[3],
      )
      if (!prevalidation.ok) return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The current draft does not satisfy S5 validation.', issues: prevalidation.issues } }
      const confirmedRelative = runtime.stage === 'outline_generation'
        ? 'outline/initial-confirmed-outline.json'
        : 'outline/confirmed-outline.json'
      const confirmedPath = within(workspace.projectRoot, confirmedRelative)
      const outlinePath = within(workspace.projectRoot, 'outline/outline.json')
      const qualityPath = within(workspace.projectRoot, 'outline/quality-report.json')
      for (const relative of [
        'outline/outline.json', 'outline/quality-report.json', confirmedRelative,
        ...(runtime.stage === 'evidence_mapping' ? ['analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/confirmation.json'] : []),
      ]) {
        const path = within(workspace.projectRoot, relative)
        await assertNoLinkedPath(workspace.root, path)
        try { backup.set(path, await readFile(path, 'utf8')) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          backup.set(path, null)
        }
      }
      try {
        operation.controller.signal.throwIfAborted()
        if (runtime.stage === 'evidence_mapping') {
          const researched = parseOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
          const affected = changedWritableSectionIds(researched, candidate)
          const summarySectionIds = candidate.sections.filter(section => !section.writable
            && researched.sections.find(previous => previous.id === section.id)?.summary !== section.summary).map(section => section.id)
          const evidencePath = within(workspace.projectRoot, 'analysis/evidence-map.json')
          let evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(evidencePath, 'utf8')))
          if (affected.length > 0 || summarySectionIds.length > 0) {
            const checked = await executeEvidenceMappingFinalCheck(agent, workspace, candidate, affected, {
              maxRepairAttempts: this.config.modelStageRepairAttempts,
              maxConcurrency: this.config.evidenceMappingMaxConcurrency,
              summarySectionIds,
              signal: operation.controller.signal,
            })
            candidate = checked.outline
            evidence = checked.evidence
          }
          const reconciled = reconcileSectionEvidence(candidate, evidence)
          operation.controller.signal.throwIfAborted()
          await writeFileAtomic(evidencePath, `${JSON.stringify(reconciled, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
          const ledger = parseWebEvidenceSourcesArtifact(await readStageJson(workspace, 'analysis/web-evidence-sources.json'))
          const referenced = new Set(
            reconciled.section_mappings.flatMap(mapping => mapping.web_materials.map(material => material.source_id)),
          )
          for (const source of ledger.sources.filter(source => !referenced.has(source.source_id))) {
            const path = within(workspace.projectRoot, source.snapshot_path)
            await assertNoLinkedPath(workspace.root, path)
            backup.set(path, await readFile(path, 'utf8'))
          }
          await pruneWebEvidenceArtifacts(workspace, reconciled)
        }
        const quality = JSON.parse(await readFile(qualityPath, 'utf8')) as Record<string, unknown>
        quality.reviewed_section_ids = candidate.sections.map(section => section.id)
        await writeFileAtomic(outlinePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(qualityPath, `${JSON.stringify(quality, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        if (runtime.stage === 'evidence_mapping') {
          const validation = await validateEvidenceMapping(workspace, 'evidence_mapping', [
            { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
            { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
            { stage: 'evidence_mapping', type: 'outline', path: 'outline/outline.json' },
            { stage: 'evidence_mapping', type: 'outline_quality_report', path: 'outline/quality-report.json' },
          ])
          if (!validation.ok) throw new BidStageExecutionError(validation.issues)
        }
        operation.controller.signal.throwIfAborted()
        await writeFileAtomic(confirmedPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        if (runtime.stage === 'evidence_mapping') {
          const confirmationPath = within(workspace.projectRoot, 'outline/confirmation.json')
          await assertNoLinkedPath(workspace.root, confirmationPath)
          const confirmation = parseOutlineConfirmationArtifact({
            schema_version: 2, scope: 'technical_bid', decision: 'confirmed',
            source_outline_sha256: draft.source_outline_sha256,
            confirmed_outline_sha256: outlineArtifactSha256(candidate),
            confirmed_draft_revision: draft.revision,
            confirmed_draft_sha256: draft.draft_outline_sha256,
          })
          await writeFileAtomic(confirmationPath, `${JSON.stringify(confirmation, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        }
      } catch (error) {
        await restore()
        throw error
      }
      const artifactRefs: StageArtifact[] = runtime.stage === 'outline_generation' ? [
        { stage: 'outline_generation', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
        { stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' },
        { stage: 'outline_generation', type: 'outline_quality_report', path: 'outline/quality-report.json' },
      ] : [
        { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
        { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
        { stage: 'evidence_mapping', type: 'outline', path: 'outline/outline.json' },
        { stage: 'evidence_mapping', type: 'outline_quality_report', path: 'outline/quality-report.json' },
      ]
      const confirmation = await this
        .automaticOrchestrator(agent, workspace, operation.controller.signal)
        .confirmValidatedStage(runtime.stage, artifactRefs)
      if (!confirmation.ok) {
        await restore()
        return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The persisted draft does not satisfy outline validation.', issues: confirmation.validation.issues } }
      }
      backup.clear()
      await rm(within(workspace.projectRoot, 'outline/draft.json'), { force: true })
      await this.ctx.sessions.flush(session)
      return { ok: true, value: confirmation.state }
    } catch (error) {
      await restore()
      return { ok: false, error: { code: 'BID_CONFIRM_FAILED', message: error instanceof Error ? error.message : String(error), ...(error instanceof BidStageExecutionError ? { issues: error.issues } : {}) } }
    } finally { await this.finishOperation(session, operation) }
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
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline regeneration requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(projectKey(session))) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const normalized = request.feedback.trim()
    if (normalized.length === 0) return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
    const operation = this.beginOperation(session)
    let started = false
    let runtime = BID_INITIAL_RUNTIME_STATE
    try {
      runtime = await this.prepareOperation(operation)
      if (!getBidClientProjection(runtime).allowedActions.includes('regenerate_outline')) return { ok: false, error: { code: 'BID_REGENERATE_NOT_ALLOWED', message: 'Outline regeneration is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      session.append('bid.stage.started', { stage: runtime.stage, status: 'running' })
      started = true
      await this.checkpoint(operation)
      const outlinePath = within(workspace.projectRoot, 'outline/outline.json')
      const qualityPath = within(workspace.projectRoot, 'outline/quality-report.json')
      const changeSetPath = within(workspace.projectRoot, 'outline/regeneration/change-set.json')
      await Promise.all([outlinePath, qualityPath, changeSetPath].map(path => assertNoLinkedPath(workspace.root, path)))
      const [originalOutline, originalQuality] = await Promise.all([readFile(outlinePath, 'utf8'), readFile(qualityPath, 'utf8')])
      let candidate: OutlineArtifact | undefined
      let candidateRaw: string | undefined
      let qualityRaw: string | undefined
      let changeSetRaw: string | undefined
      let validationIssues: readonly StageValidationIssue[] = []
      try {
        const artifacts = await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
          maxRepairAttempts: this.config.modelStageRepairAttempts,
          signal: operation.controller.signal,
          regeneration: { feedback: normalized, revision: draft.revision, draftSha256: draft.draft_outline_sha256 },
        })
        const validation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
        if (!validation.ok) { validationIssues = validation.issues; throw new Error('candidate-validation') }
        ;[candidateRaw, qualityRaw, changeSetRaw] = await Promise.all([
          readFile(outlinePath, 'utf8'), readFile(qualityPath, 'utf8'), readFile(changeSetPath, 'utf8'),
        ])
        candidate = parseOutlineArtifact(JSON.parse(candidateRaw))
        const changeSet = parseOutlineRegenerationChangeSet(JSON.parse(changeSetRaw))
        if (!regenerationChangeSetMatches(changeSet, draft.outline, candidate, draft.revision, draft.draft_outline_sha256)) throw new Error('change-set-mismatch')
      } catch (error: unknown) {
        await writeFileAtomic(outlinePath, originalOutline, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(qualityPath, originalQuality, { mode: 0o600, dirMode: 0o700 })
        return { ok: false, error: { code: 'BID_REGENERATE_FAILED', message: error instanceof Error && error.message === 'change-set-mismatch' ? 'The regeneration change set does not match the candidate.' : `The regenerated outline candidate is invalid: ${error instanceof Error ? error.message : String(error)}`, issues: validationIssues, current: draft } }
      }
      await writeFileAtomic(outlinePath, originalOutline, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(qualityPath, originalQuality, { mode: 0o600, dirMode: 0o700 })
      const regenerationRoot = within(workspace.projectRoot, 'outline/regeneration')
      await assertNoLinkedPath(workspace.root, regenerationRoot)
      await mkdir(regenerationRoot, { recursive: true, mode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'candidate-outline.json'), candidateRaw, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'quality-report.json'), qualityRaw, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'change-set.json'), changeSetRaw, { mode: 0o600, dirMode: 0o700 })
      const replacement = await replaceOutlineDraft(workspace, request, candidate)
      if (!replacement.ok) return { ok: false, error: { ...replacement.error, code: replacement.error.code === 'BID_OUTLINE_DRAFT_CONFLICT' ? 'BID_OUTLINE_DRAFT_CONFLICT' : 'BID_REGENERATE_FAILED' } }
      return { ok: true, value: { stage: runtime.stage, status: 'waiting_user' } }
    } catch (error: unknown) {
      if (error instanceof BidOrchestratorError && error.code === 'BID_OUTLINE_FEEDBACK_REQUIRED') return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
      return { ok: false, error: { code: 'BID_REGENERATE_FAILED', message: 'The Bid Host could not regenerate the outline.' } }
    } finally {
      if (started) session.append('bid.user_confirmation.required', { stage: runtime.stage, status: 'waiting_user' })
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
    titles.unshift(current.title)
    numbers.unshift(current.order)
    current = current.parent_id === null ? undefined : sections.get(current.parent_id)
  }
  return { titles, numbers }
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
export { within } from './workspace-path.ts'

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
   * Import, parse independently, and atomically publish this batch's manifest.
   * @param files - Validated upload bytes to import into the project.
   * @returns Manifest entries with process-local absolute paths.
   */
  async import(files: readonly IncomingFile[]): Promise<ImportedFile[]> {
    validateBidFileBatch(files, this.config)
    await assertNoLinkedPath(this.root, this.manifestPath)
    const manifest = await this.readManifest()
    const used = new Set(manifest.files.map(file => basename(file.inputPath).toLocaleLowerCase('en-US')))
    const imported: ImportedFile[] = []
    for (const file of files) {
      const originalName = safeFileName(file.name)
      const extension = extname(originalName).toLocaleLowerCase('en-US')
      const storedName = uniqueName(originalName, used)
      const inputPath = `input/${storedName}`
      const input = within(this.projectRoot, inputPath)
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
          const corpus = within(this.projectRoot, corpusPath)
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
          const document = within(this.projectRoot, documentPath)
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
          const chunks = within(this.projectRoot, chunksPath)
          await assertNoLinkedPath(this.root, chunks)
          await chunkDocument({
            documentPath: within(this.projectRoot, documentPath),
            structurePath: record.structurePath === null ? null : within(this.projectRoot, record.structurePath),
            metadataPath: record.metadataPath === null ? null : within(this.projectRoot, record.metadataPath),
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
      manifest.files.push(record)
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
    await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
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
   * Export a project-local Markdown file to the output directory only.
   * @param source - Project-relative Markdown source path.
   * @param destination - Project-relative DOCX destination below the output directory.
   * @returns The workspace-relative path exposed to the caller.
   */
  async exportDocx(source: string, destination = `${this.config.outputDirectory}/技术标.docx`): Promise<string> {
    if (!this.config.enableDocxExport) throw new Error('bid-docx-export-disabled')
    const sourcePath = within(this.projectRoot, source)
    if (!source.endsWith('.md')) throw new Error('bid-source-must-be-markdown')
    const destinationPath = within(this.projectRoot, destination)
    if (!destinationPath.startsWith(`${this.outputRoot}${sep}`)) throw new Error('bid-output-path-required')
    await assertNoLinkedPath(this.root, sourcePath)
    const markdown = await readFile(sourcePath, 'utf8')
    const view = await readDocxFormat(this)
    if (Object.values(view.sources).includes('待确认')) throw new Error('模板存在待确认的格式变体，请选择样式或明确使用默认方案。')
    const rendered = await renderDocx(this, markdown, view.values)
    await readDocxXml(rendered.bytes)
    await atomicBytes(this.root, destinationPath, rendered.bytes)
    await writeDocxFormat(this, { ...view.state,
      lastExport: { path: destination, fingerprint: docxFingerprint(markdown, view, rendered.assetHash) },
    })
    return this.relative(destination)
  }

  private relative(path: string): string { return `${this.config.projectDirectory}/${path.replaceAll('\\', '/')}` }
}
