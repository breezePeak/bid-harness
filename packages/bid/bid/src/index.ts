/**
 * Workspace-local import, parsing, manifest, and DOCX-export primitives for
 * the bid profile.  The caller supplies the selected workspace and session;
 * this module never stores an ambient current workspace or emits file bytes to
 * a model request.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { Session } from '@deepseek-ai/dsh-session'
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
import { executeEvidenceMapping } from './evidence-mapping-executor.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { BidOrchestrator, BidOrchestratorError } from './orchestrator.ts'
import { registerBidRuntimeProjection } from './projection.ts'
import { BID_INITIAL_RUNTIME_STATE, getBidClientProjection, reduceBidRuntimeState } from './runtime-state.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import type {
  BidFileIntakeErrorCode,
  BidFileIntakeResult,
  BidRetryErrorCode,
  BidRetryResult,
  BidRuntimeState,
  BidUploadFile,
  StageArtifact,
} from './control-plane-contract.ts'

export { extractDocument } from './document-extract.ts'
export type { DocumentMetadata, DocumentParseStatus, DocumentSection, ExtractDocumentInput, ExtractDocumentResult } from './document-extract.ts'
export { chunkDocument, DEFAULT_DOCUMENT_CHUNK_CONFIG, parseDocumentChunkIndex } from './document-chunk.ts'
export type { ChunkDocumentInput, ChunkDocumentResult, DocumentChunkConfig, DocumentChunkEntry, DocumentChunkIndex } from './document-chunk.ts'
export { BID_CLIENT_ACTIONS, BID_RUNTIME_PROJECTION_KEY, BID_STAGES, STAGE_RUN_STATUSES } from './control-plane-contract.ts'
export type {
  BidClientAction,
  BidClientProjection,

  BidComposerReason,
  BidPromptAdmission,
  BidComposerCapability,
  BidFileIntakeErrorCode,
  BidFileIntakeFailure,
  BidFileIntakeResult,
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
export { executeTenderAnalysis, renderTenderAnalysisTask } from './tender-analysis-executor.ts'
export { validateTenderAnalysis } from './tender-analysis-validator.ts'
export * from './evidence-mapping-artifacts.ts'
export { executeEvidenceMapping, renderEvidenceMappingTask } from './evidence-mapping-executor.ts'
export { validateEvidenceMapping } from './evidence-mapping-validator.ts'
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
  maxFileBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  maxTotalBytes: 200 * 1024 * 1024,
  sessionDirectory: '.bid-harness/sessions',
  outputDirectory: 'output',
  enableDocxExport: true,
  font: 'Microsoft YaHei',
  bodySize: 22,
  headingSize: 32,
  documentChunk: DEFAULT_DOCUMENT_CHUNK_CONFIG,
}

/** Client-visible file limits configured for the Bid Host runtime. */
export interface Config {
  allowedExtensions: string[]
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

const DEFAULT_HOST_RUNTIME_CONFIG: Config = {
  allowedExtensions: [...DEFAULT_BID_CONFIG.allowedExtensions],
  maxFiles: DEFAULT_BID_CONFIG.maxFiles,
  maxFileBytes: DEFAULT_BID_CONFIG.maxFileBytes,
  maxTotalBytes: DEFAULT_BID_CONFIG.maxTotalBytes,
}

/** Validated Bid Host runtime configuration. */
export const Config: z<Config> = z.object({
  allowedExtensions: z.array(z.string()).default(DEFAULT_HOST_RUNTIME_CONFIG.allowedExtensions),
  maxFiles: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFiles),
  maxFileBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxFileBytes),
  maxTotalBytes: z.natural().min(1).default(DEFAULT_HOST_RUNTIME_CONFIG.maxTotalBytes),
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
function intakeSuccess(value: BidRuntimeState): BidFileIntakeResult {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) })
}

/** Build one immutable, sanitized business rejection. */
function intakeRejected(code: BidFileIntakeErrorCode, message: string): BidFileIntakeResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/** Build one immutable, sanitized retry rejection. */
function retryRejected(code: BidRetryErrorCode, message: string): BidRetryResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/** Build one immutable retry success result from the Host's log-derived state. */
function retrySuccess(value: BidRuntimeState): BidRetryResult {
  return Object.freeze({ ok: true, value: Object.freeze({ ...value }) })
}

/** Convert canonical browser base64 into importer bytes after size admission. */
function decodeUploadFiles(files: readonly BidUploadFile[], config: Config): IncomingFile[] {
  if (files.length === 0 || files.length > config.maxFiles) throw new Error('bid-file-count-limit')
  let declaredTotal = 0
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > config.maxFileBytes) {
      throw new Error('bid-file-size-limit')
    }
    declaredTotal += file.size
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > config.maxTotalBytes) {
      throw new Error('bid-total-size-limit')
    }
  }
  return files.map((file) => {
    const extension = extname(safeFileName(file.name)).toLocaleLowerCase('en-US')
    if (!config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
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
  })
}

/** Translate an expected admission rejection into the public business vocabulary. */
function intakeError(error: unknown): BidFileIntakeResult {
  const message = error instanceof Error ? error.message : String(error)
  switch (message) {
    case 'bid-file-count-limit':
      return intakeRejected('BID_FILE_COUNT_LIMIT', 'The selected file count exceeds the Bid Host limit.')
    case 'bid-file-size-limit':
    case 'bid-empty-file':
      return intakeRejected('BID_FILE_SIZE_LIMIT', 'A selected file is empty or exceeds the Bid Host size limit.')
    case 'bid-total-size-limit':
      return intakeRejected('BID_TOTAL_SIZE_LIMIT', 'The selected files exceed the Bid Host total-size limit.')
    case 'bid-unsupported-file-type':
      return intakeRejected('BID_FILE_TYPE_UNSUPPORTED', 'A selected file type is not accepted by the Bid Host.')
    case 'bid-invalid-file-name':
    case 'bid-reserved-file-name':
      return intakeRejected('BID_FILE_NAME_INVALID', 'A selected file name is not valid for the Bid workspace.')
    default:
      return intakeRejected('BID_FILE_INTAKE_FAILED', 'The Bid Host could not import and validate the selected files.')
  }
}

/** Host service for Bid projection, prompt admission, and dedicated file intake. */
export class BidHostRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'sessions']
  static Config = Config

  private readonly config: Config
  private readonly inFlight = new Set<string>()

  /**
   * @param ctx - Host Context that owns Sessions and their Bid projection.
   * @param config - validated file limits used for admission and import.
   */
  constructor(ctx: Context, config: Config = DEFAULT_HOST_RUNTIME_CONFIG) {
    super(ctx, 'bid')
    this.config = config
    ctx.effect(
      () => registerBidRuntimeProjection(ctx.sessionProjections, config),
      'bid: runtime projection',
    )
    ctx.on('session/prompt-admission', ({ session }) => {
      if (resolveSessionPreset(session) !== 'bid') return
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      const projection = getBidClientProjection(runtime)
      const reason = projection.composer.enabled ? 'bid.stage_pending' : projection.composer.reason
      return {
        reason,
        message: `Bid session prompt rejected by Host admission: ${reason}`,
      }
    }, { global: true })
    ctx.on('agent/session-start', ({ agent }) => {
      const cwd = agent.session.header.cwd
      if (resolveSessionPreset(agent.session) !== 'bid' || cwd === undefined) return
      return this.driveStartedSession(agent, cwd)
    }, { global: true })
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
        canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping',
        execute: task => task.stage === 'tender_analysis'
          ? executeTenderAnalysis(agent, workspace, task)
          : task.stage === 'evidence_mapping'
            ? executeEvidenceMapping(agent, workspace, task)
            : Promise.reject(new Error(`Bid Host has no executor for ${task.stage}`)),
      },
      {
        validate: (stage, artifacts) => stage === 'tender_analysis'
          ? validateTenderAnalysis(workspace, stage, artifacts)
          : validateEvidenceMapping(workspace, stage, artifacts),
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

      const incoming = decodeUploadFiles(files, this.config)
      const workspace = new BidWorkspace(session.header.cwd, session.id, workspaceConfig(this.config))
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined) throw new Error('Bid Session has no live Agent')
      validateBidFileBatch(incoming, workspace.config)
      let imported: ImportedFile[] = []
      const orchestrator = new BidOrchestrator(
        session,
        {
          canExecute: stage => stage === 'tender_analysis' || stage === 'evidence_mapping',
          execute: async (task) => {
            if (task.stage === 'file_intake') {
              try {
                imported = await workspace.import(incoming)
              } catch {
                throw new Error('file intake could not persist the selected files')
              }
              const artifact: StageArtifact = { stage: 'file_intake', type: 'manifest', path: 'manifest.json' }
              return [artifact]
            }
            if (task.stage === 'tender_analysis') return executeTenderAnalysis(agent, workspace, task)
            if (task.stage === 'evidence_mapping') return executeEvidenceMapping(agent, workspace, task)
            throw new Error(`Bid Host has no executor for ${task.stage}`)
          },
        },
        {
          validate: (stage, artifacts) => stage === 'file_intake'
            ? validateFileIntake(workspace, imported, stage, artifacts)
            : stage === 'tender_analysis'
              ? validateTenderAnalysis(workspace, stage, artifacts)
              : validateEvidenceMapping(workspace, stage, artifacts),
        },
      )
      await orchestrator.runCurrentProgramStage()
      const next = await orchestrator.drive()
      await this.ctx.sessions.flush(session)
      if (next.status === 'failed') {
        if (next.stage === 'file_intake') {
          return intakeRejected(
            'BID_FILE_INTAKE_FAILED',
            next.failureReason ?? 'The Bid Host rejected the imported file artifacts.',
          )
        }
        return intakeSuccess(next)
      }
      return intakeSuccess(next)
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
      const next = await orchestrator.retryCurrentAutomaticStage()
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
}

export default BidHostRuntime

/** Durable manifest entry for one imported file. */
export interface ManifestFile {
  id: BidFileId
  /** `tender` supplies S2 requirements; S3 may use both roles. */
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
  role: zod.enum(['tender', 'reference']),
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
export function within(root: string, candidate: string): string {
  if (isAbsolute(candidate) || /^[a-z]:/iu.test(candidate) || /^\\\\/u.test(candidate)) throw new Error('bid-absolute-path')
  const target = resolve(root, candidate)
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('bid-path-traversal')
  return target
}

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
      return `${index + 1}. ${file.originalName}\n   资料类型：${file.role === 'tender' ? '招标资料' : '参考资料'}\n   原始文件：${this.relative(file.inputPath)}\n   完整正文：${document}\n   搜索语料：${chunks}\n   文档结构：${structure}\n   解析状态：${status}`
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
