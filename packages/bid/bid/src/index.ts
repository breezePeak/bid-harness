/**
 * Workspace-local import, parsing, manifest, and DOCX-export primitives for
 * the bid profile.  The caller supplies the selected workspace and session;
 * this module never stores an ambient current workspace or emits file bytes to
 * a model request.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Document, Footer, Header, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, AlignmentType } from 'docx'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import * as XLSX from 'xlsx'
import { z as zod } from 'zod'
import { extractDocument, type ExtractDocumentInput, type ExtractDocumentResult } from './document-extract.ts'
import { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, type DocumentChunkConfig } from './document-chunk.ts'
import { validateFileIntake } from './file-intake-validator.ts'
import { executeTenderAnalysis } from './tender-analysis-executor.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'
import { parseTenderProjectArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import {
  applyTenderAnalysisEdits,
  parseTenderAnalysisEditOperations,
  type TenderAnalysisConfirmationView,
  type TenderAnalysisEditOperation,
} from './tender-analysis-confirmation.ts'
import { DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY, executeEvidenceMapping, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { executeOutlineGeneration } from './outline-generation-executor.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { parseOutlineArtifact, type OutlineArtifact } from './outline-generation-artifacts.ts'
import type { OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { getOrCreateOutlineDraft, mutateOutlineDraft, replaceOutlineDraft, type OutlineDraftIdentityRequest, type OutlineDraftMutationRequest, type OutlineDraftMutationResult } from './outline-draft-store.ts'
import { validateOutlineConfirmation, validateOutlineDraftForConfirmation } from './outline-confirmation-validator.ts'
import { parseOutlineRegenerationChangeSet, regenerationChangeSetMatches } from './outline-regeneration-artifacts.ts'
import { DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY, executeChapterWriting } from './chapter-writing-executor.ts'
import { validateChapterWriting } from './chapter-writing-validator.ts'
import { executeBookReview } from './book-review-executor.ts'
import { validateBookReview } from './book-review-validator.ts'
import { parseBookReviewReport } from './book-review-artifacts.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS } from './model-stage-repair.ts'
import { BidOrchestrator, BidOrchestratorError } from './orchestrator.ts'
import { registerBidRuntimeProjection } from './projection.ts'
import { BID_INITIAL_RUNTIME_STATE, buildBidStageTask, getBidClientProjection, reduceBidRuntimeState } from './runtime-state.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { isBidDocumentRole } from './control-plane-contract.ts'
import { BID_BINARY_UPLOAD_PATH, BID_UPLOAD_FILES_HEADER, BID_UPLOAD_SESSION_HEADER } from './control-plane-contract.ts'
import type {
  BidEvidenceMappingProgress,
  BidFileIntakeErrorCode,
  BidFileIntakeFileResult,
  BidFileIntakeResult,
  BidOutlineConfirmationResult,
  BidOutlineRegenerationResult,
  BidTenderAnalysisConfirmationResult,
  BidRetryErrorCode,
  BidRetryResult,
  BidReviewCompletionResult,
  BidReviewWorkbenchView,
  BidReviewChapterView,
  BidRuntimeState,
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
export { BID_CLIENT_ACTIONS, BID_DOCUMENT_ROLES, BID_RUNTIME_PROJECTION_KEY, BID_STAGES, STAGE_RUN_STATUSES, isBidDocumentRole } from './control-plane-contract.ts'
export type {
  BidClientAction,
  BidDocumentRole,
  BidEvidenceMappingProgress,
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
  BidReviewCompletionResult,
  BidReviewWorkbenchView,
  BidReviewChapterView,

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
export * from './scoring-response-point-artifacts.ts'
export { executeTenderAnalysis, renderTenderAnalysisRepairTask, renderTenderAnalysisTask } from './tender-analysis-executor.ts'
export { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS } from './model-stage-repair.ts'
export type { ModelStageExecutionOptions } from './model-stage-repair.ts'
export { validateTenderAnalysis } from './tender-analysis-validator.ts'
export * from './evidence-mapping-artifacts.ts'
export * from './web-evidence-source-artifacts.ts'
export {
  buildEvidenceMappingWebSnapshots,
  collectEvidenceMappingWebObservations,
  DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
  executeEvidenceMapping,
  mergeEvidenceMappingPartialResults,
  readEvidenceMappingProgress,
  renderEvidenceMappingSubagentTask,
  renderEvidenceMappingTask,
  type EvidenceMappingCapturedWebResult,
  type MergedEvidenceMappingResults,
  type EvidenceMappingWebObservation,
  type EvidenceMappingWebSnapshot,
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
export { validateConfirmedOutline, validateOutlineConfirmation } from './outline-confirmation-validator.ts'
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
export * from './book-review-artifacts.ts'
export { executeBookReview } from './book-review-executor.ts'
export { validateBookReview } from './book-review-validator.ts'
export { registerBidRuntimeProjection } from './projection.ts'

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
  sessionDirectory: string
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
  sessionDirectory: '.bid-harness/sessions',
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
  /** Validator-guided repair turns available to each model-authored stage execution. */
  modelStageRepairAttempts: number
  /** Maximum Mapping Subagents running at the same time during S3. */
  evidenceMappingMaxConcurrency: number
  /** Maximum Chapter Subagents running at the same time during S6. */
  chapterWritingMaxConcurrency: number
  /** Non-loopback browser authorities admitted to the direct binary S1 endpoint. */
  trustedHosts: string[]
}

const DEFAULT_HOST_RUNTIME_CONFIG: Config = {
  allowedExtensions: [...DEFAULT_BID_CONFIG.allowedExtensions],
  maxFiles: DEFAULT_BID_CONFIG.maxFiles,
  maxFileBytes: DEFAULT_BID_CONFIG.maxFileBytes,
  maxTotalBytes: DEFAULT_BID_CONFIG.maxTotalBytes,
  modelStageRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
  evidenceMappingMaxConcurrency: DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
  chapterWritingMaxConcurrency: DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
  trustedHosts: [],
}

/** Validated Bid Host runtime configuration. */
export const Config: z<Config> = z.object({
  allowedExtensions: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.allowedExtensions),
  maxFiles: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFiles),
  maxFileBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFileBytes),
  maxTotalBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxTotalBytes),
  modelStageRepairAttempts: z.natural().min(1).max(20).default(DEFAULT_HOST_RUNTIME_CONFIG.modelStageRepairAttempts),
  evidenceMappingMaxConcurrency: z.natural().min(1).max(8).default(DEFAULT_HOST_RUNTIME_CONFIG.evidenceMappingMaxConcurrency),
  chapterWritingMaxConcurrency: z.natural().min(1).max(8).default(DEFAULT_HOST_RUNTIME_CONFIG.chapterWritingMaxConcurrency),
  trustedHosts: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.trustedHosts),
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

/** Build one immutable retry success result from the Host's log-derived state. */
function retrySuccess(value: BidRuntimeState): BidRetryResult {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) })
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
      name: record.name as string,
      role: record.role as BidDocumentRole,
      ...(record.mediaType === undefined ? {} : { mediaType: record.mediaType as string }),
      size: record.size as number,
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
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array)
    received += bytes.byteLength
    if (received > expected) throw new Error('bid-invalid-file-data')
    chunks.push(bytes)
  }
  if (received !== expected) throw new Error('bid-invalid-file-data')
  const body = Buffer.concat(chunks, expected)
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
export class BidHostRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'sessions', 'subagents']
  static Config = Config

  private readonly config: Config
  private readonly inFlight = new Set<string>()

  /**
   * @param ctx - Host Context that owns Sessions and their Bid projection.
   * @param config - validated file limits, model-stage recovery budget, and S6 concurrency limit.
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
      if (projection.composer.enabled) return
      const reason = projection.composer.reason
      return {
        reason,
        message: `Bid session prompt rejected by Host admission: ${reason}`,
      }
    }, { global: true })
    ctx.on('agent/session-start', ({ agent }) => {
      const cwd = agent.session.header.cwd
      if (agent.session.header.origin === 'subagent' || resolveSessionPreset(agent.session) !== 'bid' || cwd === undefined) return
      void this.driveStartedSession(agent, cwd)
    }, { global: true })
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer') as unknown as BidBinaryUploadWebServer
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: BID_BINARY_UPLOAD_PATH,
        handler: (req, res) => this.handleBinaryUpload(req, res),
      }), 'bid: binary file intake route')
    })
  }

  /** Continue implemented automatic stages after a Bid Session starts or resumes. */
  private async driveStartedSession(agent: Agent, cwd: string): Promise<void> {
    const { session } = agent
    if (this.inFlight.has(session.id)) return
    this.inFlight.add(session.id)
    try {
      const workspace = new BidWorkspace(cwd, session.id, workspaceConfig(this.config))
      await this.automaticOrchestrator(agent, workspace).drive()
      await this.ctx.sessions.flush(session)
    } finally {
      this.inFlight.delete(session.id)
    }
  }

  /** Build the production executor and Validator for implemented automatic stages. */
  private automaticOrchestrator(agent: Agent, workspace: BidWorkspace): BidOrchestrator {
    return new BidOrchestrator(
      agent.session,
      {
        canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping' || stage === 'outline_generation' || stage === 'chapter_writing' || stage === 'book_review',
        execute: task => task.stage === 'tender_analysis'
          ? executeTenderAnalysis(agent, workspace, task, { maxRepairAttempts: this.config.modelStageRepairAttempts })
          : task.stage === 'evidence_mapping'
            ? executeEvidenceMapping(agent, workspace, task, {
              maxRepairAttempts: this.config.modelStageRepairAttempts,
              maxConcurrency: this.config.evidenceMappingMaxConcurrency,
            })
            : task.stage === 'outline_generation'
              ? executeOutlineGeneration(agent, workspace, task, { maxRepairAttempts: this.config.modelStageRepairAttempts })
              : task.stage === 'chapter_writing'
                ? executeChapterWriting(agent, workspace, task, {
                  maxRepairAttempts: this.config.modelStageRepairAttempts,
                  maxConcurrency: this.config.chapterWritingMaxConcurrency,
                })
                : task.stage === 'book_review'
                  ? executeBookReview(workspace, task)
                  : Promise.reject(new Error(`Bid Host has no executor for ${task.stage}`)),
      },
      {
        validate: (stage, artifacts) => stage === 'tender_analysis'
          ? validateTenderAnalysis(workspace, stage, artifacts)
          : stage === 'evidence_mapping'
            ? validateEvidenceMapping(workspace, stage, artifacts)
            : stage === 'outline_confirmation' ? validateOutlineConfirmation(workspace, stage, artifacts)
              : stage === 'chapter_writing' ? validateChapterWriting(workspace, stage, artifacts)
                : stage === 'book_review' ? validateBookReview(workspace, stage, artifacts)
                  : validateOutlineGeneration(workspace, stage, artifacts),
      },
    )
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
    if (this.inFlight.has(session.id)) {
      return intakeRejected('BID_OPERATION_IN_PROGRESS', 'A file-intake operation is already running for this Bid Session.')
    }
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
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
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      validateBidFileBatch(incoming, workspace.config)
      let imported: ImportedFile[] = []
      const orchestrator = new BidOrchestrator(
        session,
        {
          canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping' || stage === 'outline_generation' || stage === 'chapter_writing' || stage === 'book_review',
          execute: async (task) => {
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
            const repair = { maxRepairAttempts: this.config.modelStageRepairAttempts }
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
            if (task.stage === 'book_review') return executeBookReview(workspace, task)
            throw new Error(`Bid Host has no executor for ${task.stage}`)
          },
        },
        {
          validate: (stage, artifacts) => stage === 'file_intake'
            ? validateFileIntake(workspace, imported, stage, artifacts, incoming)
            : stage === 'tender_analysis'
              ? validateTenderAnalysis(workspace, stage, artifacts)
              : stage === 'evidence_mapping'
                ? validateEvidenceMapping(workspace, stage, artifacts)
                : stage === 'outline_generation'
                  ? validateOutlineGeneration(workspace, stage, artifacts)
                  : stage === 'chapter_writing'
                    ? validateChapterWriting(workspace, stage, artifacts)
                    : stage === 'book_review'
                      ? validateBookReview(workspace, stage, artifacts)
                      : validateOutlineConfirmation(workspace, stage, artifacts),
        },
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
      this.inFlight.delete(session.id)
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

  /** Record an S1 failure when a selected binary upload cannot be fully reconstructed. */
  private async recordBinaryUploadFailure(session: Session, error: unknown): Promise<BidFileIntakeResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return intakeError(error)
    if (this.inFlight.has(session.id)) return intakeRejected('BID_OPERATION_IN_PROGRESS', 'A file-intake operation is already running for this Bid Session.')
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (!getBidClientProjection(runtime).allowedActions.includes('upload_files')) {
        return intakeRejected('BID_FILE_INTAKE_NOT_ALLOWED', 'File intake is not allowed in the current Bid stage state.')
      }
      const orchestrator = new BidOrchestrator(
        session,
        {
          canExecute: () => false,
          execute: async () => { throw new Error('file intake could not reconstruct every selected file') },
        },
        { validate: async () => ({ ok: true }) },
      )
      const failed = await orchestrator.runCurrentProgramStage()
      await this.ctx.sessions.flush(session)
      return intakeRejected('BID_FILE_INTAKE_FAILED', failed.failureReason ?? intakeFailure(error).message)
    } catch (caught) {
      return intakeError(caught)
    } finally {
      this.inFlight.delete(session.id)
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
    if (this.inFlight.has(session.id)) {
      return retryRejected('BID_OPERATION_IN_PROGRESS', 'A Bid operation is already running for this Session.')
    }
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (!getBidClientProjection(runtime).allowedActions.includes('retry_stage')) {
        return retryRejected('BID_RETRY_NOT_ALLOWED', 'Retry is not allowed in the current Bid stage state.')
      }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) return retryRejected('BID_RETRY_FAILED', 'Bid Session has no live Agent.')
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const orchestrator = this.automaticOrchestrator(agent, workspace)
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
      this.inFlight.delete(session.id)
    }
  }

  /** Revalidate the deterministic report and record the user's S7 completion decision. */
  @Remote('completeReview')
  async completeReview(session: Session): Promise<BidReviewCompletionResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Review completion requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(session.id)) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (!getBidClientProjection(runtime).allowedActions.includes('complete_review')) return { ok: false, error: { code: 'BID_REVIEW_NOT_ALLOWED', message: 'Review completion is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const artifacts: StageArtifact[] = [{ stage: 'book_review', type: 'book_review_report', path: 'review/report.json' }]
      const confirmation = await this.automaticOrchestrator(agent, workspace).confirmValidatedStage('book_review', artifacts)
      if (!confirmation.ok) {
        const contentChanged = confirmation.validation.issues.some(issue => issue.code === 'BOOK_REVIEW_CONTENT_CHANGED')
        return { ok: false, error: { code: contentChanged ? 'BID_REVIEW_CONTENT_CHANGED' : 'BID_REVIEW_REPORT_INVALID', message: 'The review report no longer matches the technical chapters.', issues: confirmation.validation.issues } }
      }
      await this.ctx.sessions.flush(session)
      return { ok: true, value: confirmation.state }
    } catch { return { ok: false, error: { code: 'BID_REVIEW_COMPLETE_FAILED', message: 'The Bid Host could not complete the review.' } } }
    finally { this.inFlight.delete(session.id) }
  }

  /** Read the S7 outline and framework-only summary without disclosing workspace paths. */
  @Remote('getReviewWorkbench')
  async getReviewWorkbench(session: Session): Promise<BidReviewWorkbenchView> {
    const workspace = this.requireReviewWorkspace(session)
    const outlinePath = within(workspace.sessionRoot, 'outline/confirmed-outline.json')
    const manifestPath = within(workspace.sessionRoot, 'chapters/manifest.json')
    const reportPath = within(workspace.sessionRoot, 'review/report.json')
    await Promise.all([
      assertNoLinkedPath(workspace.root, outlinePath),
      assertNoLinkedPath(workspace.root, manifestPath),
      assertNoLinkedPath(workspace.root, reportPath),
    ])
    const [outlineRaw, manifestRaw, reportRaw] = await Promise.all([
      readFile(outlinePath, 'utf8'),
      readFile(manifestPath, 'utf8'),
      readFile(reportPath, 'utf8'),
    ])
    const outline = parseOutlineArtifact(JSON.parse(outlineRaw))
    const manifest = parseChapterWritingManifest(JSON.parse(manifestRaw))
    const report = parseBookReviewReport(JSON.parse(reportRaw))
    const chapterIds = new Set(manifest.chapters.map(chapter => chapter.section_id))
    return {
      schema_version: 1,
      outline: outline.sections.map(section => ({
        section_id: section.id,
        parent_id: section.parent_id,
        order: section.order,
        title: section.title,
        writable: section.writable,
        has_content: chapterIds.has(section.id),
        review_status: 'not_evaluated',
      })),
      review: {
        review_mode: report.review_mode,
        quality_gate: report.quality_gate,
        summary: report.summary,
        limitations: [...report.limitations],
        issues: report.issues.map(issue => ({ ...issue })),
      },
    }
  }

  /** Read one S7 section through its confirmed identity and manifest entry. */
  @Remote('getReviewChapter')
  async getReviewChapter(session: Session, sectionId: string): Promise<BidReviewChapterView> {
    const workspace = this.requireReviewWorkspace(session)
    const outlinePath = within(workspace.sessionRoot, 'outline/confirmed-outline.json')
    const manifestPath = within(workspace.sessionRoot, 'chapters/manifest.json')
    await Promise.all([
      assertNoLinkedPath(workspace.root, outlinePath),
      assertNoLinkedPath(workspace.root, manifestPath),
    ])
    const [outlineRaw, manifestRaw] = await Promise.all([
      readFile(outlinePath, 'utf8'),
      readFile(manifestPath, 'utf8'),
    ])
    const outline = parseOutlineArtifact(JSON.parse(outlineRaw))
    const section = outline.sections.find(item => item.id === sectionId)
    if (section === undefined) throw new Error('BID_REVIEW_SECTION_UNKNOWN')
    const chain = reviewHeadingPath(outline, section.id)
    if (!section.writable) return { section_id: section.id, title: section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: false, markdown: null, review: { status: 'not_evaluated', issues: [] } }
    const manifest = parseChapterWritingManifest(JSON.parse(manifestRaw))
    const chapter = manifest.chapters.find(item => item.section_id === section.id)
    if (chapter === undefined) throw new Error('BID_REVIEW_CHAPTER_MISSING')
    const target = within(workspace.sessionRoot, chapter.content_path)
    await assertNoLinkedPath(workspace.root, target)
    return { section_id: section.id, title: section.title, number: chain.numbers.join('.'), heading_path: chain.titles, writable: true, markdown: await readFile(target, 'utf8'), review: { status: 'not_evaluated', issues: [] } }
  }

  /** Admit only an active S7 workbench request. */
  private requireReviewWorkspace(session: Session): BidWorkspace {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('BID_SESSION_REQUIRED')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'book_review' || runtime.status !== 'waiting_user') throw new Error('BID_REVIEW_NOT_ALLOWED')
    return new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
  }

  /**
   * Read the current S3 Mapping Task counts while evidence mapping runs.
   * @param session - Bid Session that owns the S3 execution log.
   * @returns task counts, or null when S3 is not running or has not produced its log.
   */
  @Remote('getEvidenceMappingProgress')
  async getEvidenceMappingProgress(session: Session): Promise<BidEvidenceMappingProgress | null> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'evidence_mapping' || runtime.status !== 'running') return null
    return readEvidenceMappingProgress(new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config)))
  }

  /** Read the editable S2 conclusions only while tender analysis waits for confirmation. */
  @Remote('getTenderAnalysisForConfirmation')
  async getTenderAnalysisForConfirmation(session: Session): Promise<TenderAnalysisConfirmationView> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'tender_analysis' || runtime.status !== 'waiting_user') throw new Error('Tender-analysis confirmation is not allowed in the current Bid stage state.')
    const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
    const projectPath = within(workspace.sessionRoot, 'analysis/project.json')
    const scoringPath = within(workspace.sessionRoot, 'analysis/scoring.json')
    const catalogPath = within(workspace.sessionRoot, 'analysis/scoring-response-points.json')
    await assertNoLinkedPath(workspace.root, projectPath)
    await assertNoLinkedPath(workspace.root, scoringPath)
    await assertNoLinkedPath(workspace.root, catalogPath)
    const [project, scoring, catalog] = await Promise.all([readFile(projectPath, 'utf8'), readFile(scoringPath, 'utf8'), readFile(catalogPath, 'utf8')])
    return {
      project: parseTenderProjectArtifact(JSON.parse(project)),
      scoring: parseTenderScoringArtifact(JSON.parse(scoring)),
      response_point_catalog: parseScoringResponsePointCatalog(JSON.parse(catalog)),
    }
  }

  /** Apply controlled S2 edits, revalidate canonical artifacts, and continue only after explicit confirmation. */
  @Remote('confirmTenderAnalysis')
  async confirmTenderAnalysis(
    session: Session,
    operations: readonly TenderAnalysisEditOperation[],
  ): Promise<BidTenderAnalysisConfirmationResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Tender-analysis confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(session.id)) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_tender_analysis')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Tender-analysis confirmation is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const projectPath = within(workspace.sessionRoot, 'analysis/project.json')
      const scoringPath = within(workspace.sessionRoot, 'analysis/scoring.json')
      const catalogPath = within(workspace.sessionRoot, 'analysis/scoring-response-points.json')
      await assertNoLinkedPath(workspace.root, projectPath)
      await assertNoLinkedPath(workspace.root, scoringPath)
      await assertNoLinkedPath(workspace.root, catalogPath)
      const [projectRaw, scoringRaw, catalogRaw] = await Promise.all([readFile(projectPath, 'utf8'), readFile(scoringPath, 'utf8'), readFile(catalogPath, 'utf8')])
      let candidate: TenderAnalysisConfirmationView
      try {
        candidate = applyTenderAnalysisEdits(
          {
            project: parseTenderProjectArtifact(JSON.parse(projectRaw)),
            scoring: parseTenderScoringArtifact(JSON.parse(scoringRaw)),
            response_point_catalog: parseScoringResponsePointCatalog(JSON.parse(catalogRaw)),
          },
          parseTenderAnalysisEditOperations(operations),
        )
      } catch (error: unknown) {
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The requested tender-analysis edits are invalid.', issues: [{ code: 'TENDER_ANALYSIS_EDIT_INVALID', message: error instanceof Error ? error.message : 'The requested tender-analysis edits are invalid.' }] } }
      }
      const restore = async (): Promise<void> => {
        await writeFileAtomic(projectPath, projectRaw, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(scoringPath, scoringRaw, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(catalogPath, catalogRaw, { mode: 0o600, dirMode: 0o700 })
      }
      try {
        await writeFileAtomic(projectPath, `${JSON.stringify(candidate.project, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(scoringPath, `${JSON.stringify(candidate.scoring, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(catalogPath, `${JSON.stringify(candidate.response_point_catalog, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      } catch (error: unknown) {
        await restore()
        throw error
      }
      const artifacts: StageArtifact[] = [
        { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
        { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
        { stage: 'tender_analysis', type: 'tender_scoring', path: 'analysis/scoring.json' },
        { stage: 'tender_analysis', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
        { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
      ]
      const confirmation = await this.automaticOrchestrator(agent, workspace).confirmValidatedStage('tender_analysis', artifacts)
      if (!confirmation.ok) {
        await restore()
        return { ok: false, error: { code: 'BID_INVALID_TENDER_ANALYSIS_EDIT', message: 'The edited tender analysis does not satisfy S2 validation.', issues: confirmation.validation.issues } }
      }
      await this.ctx.sessions.flush(session)
      return { ok: true, value: confirmation.state }
    } catch {
      return { ok: false, error: { code: 'BID_CONFIRM_FAILED', message: 'The Bid Host could not confirm the tender analysis.' } }
    } finally { this.inFlight.delete(session.id) }
  }

  /** Read the S4 draft only while its user-confirmation stage owns the session. */
  @Remote('getOutlineForConfirmation')
  async getOutlineForConfirmation(session: Session): Promise<OutlineArtifact> {
    return (await this.getOutlineDraft(session)).outline
  }

  /** Read or initialize the Host-persisted S5 draft. */
  @Remote('getOutlineDraft')
  async getOutlineDraft(session: Session): Promise<OutlineDraftView> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'outline_confirmation' || runtime.status !== 'waiting_user') throw new Error('Outline confirmation is not allowed in the current Bid stage state.')
    const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
    return getOrCreateOutlineDraft(workspace)
  }

  /** Apply one CAS-protected edit batch to the Host-persisted S5 draft. */
  @Remote('applyOutlineDraftOperations')
  async applyOutlineDraftOperations(session: Session, request: OutlineDraftMutationRequest): Promise<OutlineDraftMutationResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) throw new Error('Bid Session with a workspace is required.')
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (runtime.stage !== 'outline_confirmation' || runtime.status !== 'waiting_user') throw new Error('Outline draft editing is not allowed in the current Bid stage state.')
    if (this.inFlight.has(session.id)) throw new Error('BID_OPERATION_IN_PROGRESS')
    this.inFlight.add(session.id)
    try {
      return await mutateOutlineDraft(new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config)), request)
    } finally { this.inFlight.delete(session.id) }
  }

  /** Apply and validate user operations before atomically publishing S5 artifacts. */
  @Remote('confirmOutline')
  async confirmOutline(session: Session, request: OutlineDraftIdentityRequest): Promise<BidOutlineConfirmationResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline confirmation requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(session.id)) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    this.inFlight.add(session.id)
    try {
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (!getBidClientProjection(runtime).allowedActions.includes('confirm_outline')) return { ok: false, error: { code: 'BID_CONFIRM_NOT_ALLOWED', message: 'Outline confirmation is not allowed in the current Bid stage state.' } }
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      const candidate = draft.outline
      const sharedInputs = await Promise.all([
        'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json', 'analysis/evidence-map.json', 'analysis/scoring-response-points.json',
      ].map(async (path): Promise<unknown> => JSON.parse(
        await readFile(within(workspace.sessionRoot, path), 'utf8'),
      ) as unknown))
      const prevalidation = validateOutlineDraftForConfirmation(
        candidate,
        sharedInputs[0],
        sharedInputs[1],
        sharedInputs[2],
        sharedInputs[3],
        sharedInputs[4],
      )
      if (!prevalidation.ok) return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The current draft does not satisfy S5 validation.', issues: prevalidation.issues } }
      const confirmedPath = within(workspace.sessionRoot, 'outline/confirmed-outline.json')
      const confirmationPath = within(workspace.sessionRoot, 'outline/confirmation.json')
      await assertNoLinkedPath(workspace.root, confirmedPath)
      await assertNoLinkedPath(workspace.root, confirmationPath)
      try {
        await writeFileAtomic(confirmedPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        const confirmation = {
          schema_version: 2,
          scope: 'technical_bid',
          decision: 'confirmed',
          source_outline_sha256: draft.source_outline_sha256,
          confirmed_outline_sha256: draft.draft_outline_sha256,
          confirmed_draft_revision: draft.revision,
          confirmed_draft_sha256: draft.draft_outline_sha256,
        }
        await writeFileAtomic(
          confirmationPath,
          `${JSON.stringify(confirmation, null, 2)}\n`,
          { mode: 0o600, dirMode: 0o700 },
        )
      } catch (error) {
        await Promise.all([rm(confirmedPath, { force: true }), rm(confirmationPath, { force: true })])
        throw error
      }
      const artifactRefs: StageArtifact[] = [
        { stage: 'outline_confirmation', type: 'confirmed_outline', path: 'outline/confirmed-outline.json' },
        { stage: 'outline_confirmation', type: 'outline_confirmation', path: 'outline/confirmation.json' },
      ]
      const validation = await validateOutlineConfirmation(workspace, 'outline_confirmation', artifactRefs)
      if (!validation.ok) {
        await rm(confirmedPath, { force: true })
        await rm(confirmationPath, { force: true })
        return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The persisted draft does not satisfy S5 validation.', issues: validation.issues } }
      }
      const next = await this.automaticOrchestrator(agent, workspace).confirm()
      await this.ctx.sessions.flush(session)
      return { ok: true, value: next }
    } catch {
      return { ok: false, error: { code: 'BID_CONFIRM_FAILED', message: 'The Bid Host could not confirm the outline.' } }
    } finally { this.inFlight.delete(session.id) }
  }

  /** Regenerate a temporary S4-quality candidate from the current persisted S5 draft. */
  @Remote('regenerateOutline')
  async regenerateOutline(
    session: Session,
    request: OutlineDraftIdentityRequest & { readonly feedback: string },
  ): Promise<BidOutlineRegenerationResult> {
    if (resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return { ok: false, error: { code: 'BID_SESSION_REQUIRED', message: 'Outline regeneration requires a Bid Session with a Host workspace.' } }
    if (this.inFlight.has(session.id)) return { ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS', message: 'A Bid operation is already running for this Session.' } }
    const normalized = request.feedback.trim()
    if (normalized.length === 0) return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
    const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
    if (!getBidClientProjection(runtime).allowedActions.includes('regenerate_outline')) return { ok: false, error: { code: 'BID_REGENERATE_NOT_ALLOWED', message: 'Outline regeneration is not allowed in the current Bid stage state.' } }
    this.inFlight.add(session.id)
    try {
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const draft = await getOrCreateOutlineDraft(workspace)
      if (request.expected_revision !== draft.revision || request.expected_draft_sha256 !== draft.draft_outline_sha256) return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current: draft } }
      const outlinePath = within(workspace.sessionRoot, 'outline/outline.json')
      const qualityPath = within(workspace.sessionRoot, 'outline/quality-report.json')
      const changeSetPath = within(workspace.sessionRoot, 'outline/regeneration/change-set.json')
      await Promise.all([outlinePath, qualityPath, changeSetPath].map(path => assertNoLinkedPath(workspace.root, path)))
      const [originalOutline, originalQuality] = await Promise.all([readFile(outlinePath, 'utf8'), readFile(qualityPath, 'utf8')])
      let candidate: OutlineArtifact | undefined
      let candidateRaw: string | undefined
      let qualityRaw: string | undefined
      let changeSetRaw: string | undefined
      let validationIssues: readonly StageValidationIssue[] = []
      try {
        const artifacts = await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
          maxRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
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
      const regenerationRoot = within(workspace.sessionRoot, 'outline/regeneration')
      await assertNoLinkedPath(workspace.root, regenerationRoot)
      await mkdir(regenerationRoot, { recursive: true, mode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'candidate-outline.json'), candidateRaw, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'quality-report.json'), qualityRaw, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(within(regenerationRoot, 'change-set.json'), changeSetRaw, { mode: 0o600, dirMode: 0o700 })
      const replacement = await replaceOutlineDraft(workspace, request, candidate)
      if (!replacement.ok) return { ok: false, error: { ...replacement.error, code: replacement.error.code === 'BID_OUTLINE_DRAFT_CONFLICT' ? 'BID_OUTLINE_DRAFT_CONFLICT' : 'BID_REGENERATE_FAILED' } }
      return { ok: true, value: { stage: 'outline_confirmation', status: 'waiting_user' } }
    } catch (error: unknown) {
      if (error instanceof BidOrchestratorError && error.code === 'BID_OUTLINE_FEEDBACK_REQUIRED') return { ok: false, error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED', message: '请输入目录修改意见。' } }
      return { ok: false, error: { code: 'BID_REGENERATE_FAILED', message: 'The Bid Host could not regenerate the outline.' } }
    } finally { this.inFlight.delete(session.id) }
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

/** Versioned session manifest for imported bid files. */
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
  outline_framework: '人工框架或半成品标书',
  reference_bid: '参考旧标书',
  reference: '其他技术资料',
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
  if (!config.sessionDirectory || !config.outputDirectory || config.maxFileBytes <= 0
    || config.maxFiles <= 0 || config.maxTotalBytes <= 0
    || !Number.isInteger(config.documentChunk.minChars) || !Number.isInteger(config.documentChunk.targetChars)
    || !Number.isInteger(config.documentChunk.maxChars) || config.documentChunk.minChars <= 0
    || config.documentChunk.minChars > config.documentChunk.targetChars
    || config.documentChunk.targetChars > config.documentChunk.maxChars) {
    throw new Error('bid-invalid-config')
  }
}

async function atomicBytes(root: string, target: string, bytes: Uint8Array): Promise<void> {
  await assertNoLinkedPath(root, target)
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
  await assertNoLinkedPath(root, target)
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
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

/** Session-isolated workspace importer. */
export class BidWorkspace {
  /** Absolute workspace root. */
  readonly root: string
  /** Absolute directory that owns the session. */
  readonly sessionRoot: string
  /** Absolute directory containing original uploads. */
  readonly inputRoot: string
  /** Absolute directory containing parsed document corpora. */
  readonly corpusRoot: string
  /** Absolute directory allowed to receive exports. */
  readonly outputRoot: string
  /** Absolute path to the versioned session manifest. */
  readonly manifestPath: string
  /** Validated import and export limits for this workspace. */
  readonly config: BidConfig

  constructor(workspaceRoot: string, sessionId: string, options?: BidConfig) {
    const config = options ?? DEFAULT_BID_CONFIG
    validateConfig(config)
    this.config = config
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(sessionId)) throw new Error('bid-invalid-session-id')
    this.root = resolve(workspaceRoot)
    this.sessionRoot = within(this.root, `${config.sessionDirectory}/${sessionId}`)
    this.inputRoot = resolve(this.sessionRoot, 'input')
    this.corpusRoot = resolve(this.sessionRoot, 'corpus')
    this.outputRoot = resolve(this.sessionRoot, config.outputDirectory)
    this.manifestPath = resolve(this.sessionRoot, 'manifest.json')
  }

  /**
   * Import, parse independently, and atomically publish this batch's manifest.
   * @param files - Validated upload bytes to import into the session.
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
      const input = within(this.sessionRoot, inputPath)
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
          const corpus = within(this.sessionRoot, corpusPath)
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
          const document = within(this.sessionRoot, documentPath)
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
          const chunks = within(this.sessionRoot, chunksPath)
          await assertNoLinkedPath(this.root, chunks)
          await chunkDocument({
            documentPath: within(this.sessionRoot, documentPath),
            structurePath: record.structurePath === null ? null : within(this.sessionRoot, record.structurePath),
            metadataPath: record.metadataPath === null ? null : within(this.sessionRoot, record.metadataPath),
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
        absoluteDocumentPath: record.documentPath === null ? null : within(this.sessionRoot, record.documentPath),
        absoluteStructurePath: record.structurePath === null ? null : within(this.sessionRoot, record.structurePath),
        absoluteMetadataPath: record.metadataPath === null ? null : within(this.sessionRoot, record.metadataPath),
        absoluteChunksPath: record.chunksPath === null ? null : within(this.sessionRoot, record.chunksPath),
        absoluteChunkIndexPath: record.chunkIndexPath === null ? null : within(this.sessionRoot, record.chunkIndexPath),
      })
    }
    await assertNoLinkedPath(this.root, this.manifestPath)
    await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return imported
  }

  /**
   * Read the durable manifest, treating a missing session as empty.
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
   * @returns The request prefixed by session-relative corpus paths and statuses.
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
   * Export a session-local Markdown file to the output directory only.
   * @param source - Session-relative Markdown source path.
   * @param destination - Session-relative DOCX destination below the output directory.
   * @returns The workspace-relative path exposed to the caller.
   */
  async exportDocx(source: string, destination = `${this.config.outputDirectory}/技术标.docx`): Promise<string> {
    if (!this.config.enableDocxExport) throw new Error('bid-docx-export-disabled')
    const sourcePath = within(this.sessionRoot, source)
    if (!source.endsWith('.md')) throw new Error('bid-source-must-be-markdown')
    const destinationPath = within(this.sessionRoot, destination)
    if (!destinationPath.startsWith(`${this.outputRoot}${sep}`)) throw new Error('bid-output-path-required')
    const markdown = await readFile(sourcePath, 'utf8')
    const body = markdownToDocx(markdown, this.config)
    const document = new Document({ sections: [{ headers: { default: new Header({ children: [new Paragraph('技术标') ] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')],
      })] }) }, children: body }] })
    await atomicBytes(this.root, destinationPath, await Packer.toBuffer(document))
    return this.relative(destination)
  }

  private relative(path: string): string { return `${this.config.sessionDirectory}/${basename(this.sessionRoot)}/${path.replaceAll('\\', '/')}` }
}

function markdownToDocx(markdown: string, config: BidConfig): (Paragraph | Table)[] {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const blocks: (Paragraph | Table)[] = []
  for (const node of root.children) {
    if (node.type === 'heading') blocks.push(new Paragraph({ heading: node.depth === 1 ? 'Heading1' : node.depth === 2 ? 'Heading2' : 'Heading3', children: [new TextRun({ text: textOf(node), font: config.font, size: config.headingSize })] }))
    else if (node.type === 'paragraph') blocks.push(new Paragraph({ spacing: { after: 160, line: 360 }, children: [new TextRun({ text: textOf(node), font: config.font, size: config.bodySize })] }))
    else if (node.type === 'list') for (const item of node.children) blocks.push(new Paragraph({
      ...node.ordered ? { numbering: { reference: 'default-numbering', level: 0 } } : { bullet: { level: 0 } },
      children: [new TextRun({ text: textOf(item), font: config.font, size: config.bodySize })],
    }))
    else if (node.type === 'table') blocks.push(new Table({ rows: node.children.map(row => new TableRow({ children: row.children.map(cell => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(cell), font: config.font, size: config.bodySize })] })] })) })) }))
    /* v8 ignore next -- unsupported mdast block kinds are intentionally omitted from the DOCX subset. */
  }
  return blocks.length > 0 ? blocks : [new Paragraph('')]
}

function textOf(node: { children?: unknown[]; value?: string }): string {
  if (typeof node.value === 'string') return node.value
  /* v8 ignore next -- supported mdast containers always provide children. */
  return (node.children ?? []).map(child => textOf(child as { children?: unknown[]; value?: string })).join('')
}
