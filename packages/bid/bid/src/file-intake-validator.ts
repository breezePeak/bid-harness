/** Durable artifact validation for the Bid file-intake stage. */

import { lstat, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace, ImportedFile, ManifestFile } from './index.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import type {
  BidStage,
  StageArtifact,
  StageValidationIssue,
  StageValidationResult,
} from './control-plane-contract.ts'

/** Add one explicit validator rejection. */
function reject(
  issues: StageValidationIssue[],
  code: string,
  message: string,
  artifact?: string,
): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

/** Whether one absolute target remains strictly below its owning root. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Resolve an untrusted durable path only when it remains in the Session workspace. */
function resolveStoredPath(sessionRoot: string, base: string, candidate: string): string {
  if (isAbsolute(candidate) || /^[a-z]:/iu.test(candidate) || /^\\\\/u.test(candidate)) {
    throw new Error('absolute path')
  }
  const target = resolve(base, candidate)
  if (!isWithin(sessionRoot, target)) throw new Error('path traversal')
  return target
}

/** Check one required durable path without following a symbolic link. */
async function requireFile(
  root: string,
  absolutePath: string,
  durablePath: string,
  code: string,
  issues: StageValidationIssue[],
): Promise<void> {
  try {
    await assertNoLinkedPath(root, absolutePath)
    if (!(await lstat(absolutePath)).isFile()) {
      reject(issues, code, 'Required file is not a regular file.', durablePath)
    }
  } catch (error: unknown) {
    const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Required file is missing.'
      : 'Required file cannot be inspected.'
    reject(issues, code, detail, durablePath)
  }
}

/** Resolve one manifest path and record traversal as a validation issue. */
function resolveRecordPath(
  workspace: BidWorkspace,
  candidate: string,
  issues: StageValidationIssue[],
): string | null {
  try {
    return resolveStoredPath(workspace.sessionRoot, workspace.sessionRoot, candidate)
  } catch {
    reject(issues, 'FILE_INTAKE_PATH_OUTSIDE_SESSION', 'A manifest path leaves the Bid Session workspace.', candidate)
    return null
  }
}

/** Read the required manifest without treating absence as an empty first import. */
async function readRequiredManifest(
  workspace: BidWorkspace,
  issues: StageValidationIssue[],
): Promise<BidManifest | null> {
  try {
    await assertNoLinkedPath(workspace.root, workspace.manifestPath)
    if (!(await lstat(workspace.manifestPath)).isFile()) {
      reject(issues, 'FILE_INTAKE_MANIFEST_MISSING', 'manifest.json is not a regular file.', 'manifest.json')
      return null
    }
  } catch (error: unknown) {
    reject(
      issues,
      'FILE_INTAKE_MANIFEST_MISSING',
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'manifest.json is missing.'
        : 'manifest.json cannot be inspected.',
      'manifest.json',
    )
    return null
  }
  try {
    return await workspace.readManifest()
  } catch (error: unknown) {
    const code = error instanceof Error && error.message === 'bid-unsupported-manifest-version'
      ? 'FILE_INTAKE_MANIFEST_VERSION_UNSUPPORTED'
      : 'FILE_INTAKE_MANIFEST_INVALID'
    reject(issues, code, 'manifest.json is not a valid current Bid manifest.', 'manifest.json')
    return null
  }
}

/** Whether the durable manifest entry is the exact record returned for this batch. */
function sameRecord(record: ManifestFile, imported: ImportedFile): boolean {
  return record.id === imported.id
    && record.role === imported.role
    && record.originalName === imported.originalName
    && record.inputPath === imported.inputPath
    && record.sha256 === imported.sha256
    && record.size === imported.size
    && record.mediaType === imported.mediaType
    && record.parseStatus === imported.parseStatus
    && record.parseError === imported.parseError
    && record.corpusPath === imported.corpusPath
    && record.documentPath === imported.documentPath
    && record.structurePath === imported.structurePath
    && record.metadataPath === imported.metadataPath
    && record.chunksPath === imported.chunksPath
    && record.chunkIndexPath === imported.chunkIndexPath
}

/** Validate the durable files and chunk index belonging to one successful record. */
async function validateSuccessfulRecord(
  workspace: BidWorkspace,
  record: ManifestFile,
  issues: StageValidationIssue[],
): Promise<void> {
  const input = resolveRecordPath(workspace, record.inputPath, issues)
  if (input !== null) await requireFile(workspace.root, input, record.inputPath, 'FILE_INTAKE_INPUT_MISSING', issues)

  if (record.documentPath === null) {
    reject(issues, 'FILE_INTAKE_DOCUMENT_MISSING', 'A successful import has no document path.', record.inputPath)
    return
  }
  const document = resolveRecordPath(workspace, record.documentPath, issues)
  if (document !== null) {
    await requireFile(workspace.root, document, record.documentPath, 'FILE_INTAKE_DOCUMENT_MISSING', issues)
  }

  if (record.chunksPath === null || record.chunkIndexPath === null) {
    reject(issues, 'FILE_INTAKE_CHUNK_INDEX_MISSING', 'A successful import has no chunk index.', record.inputPath)
    return
  }
  const chunksRoot = resolveRecordPath(workspace, record.chunksPath, issues)
  const indexPath = resolveRecordPath(workspace, record.chunkIndexPath, issues)
  if (chunksRoot === null || indexPath === null) return
  if (dirname(indexPath) !== chunksRoot) {
    reject(issues, 'FILE_INTAKE_CHUNK_INDEX_INVALID', 'The chunk index is not inside its declared chunk directory.', record.chunkIndexPath)
    return
  }
  await requireFile(workspace.root, indexPath, record.chunkIndexPath, 'FILE_INTAKE_CHUNK_INDEX_MISSING', issues)

  let index: ReturnType<typeof parseDocumentChunkIndex>
  try {
    index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
  } catch {
    reject(issues, 'FILE_INTAKE_CHUNK_INDEX_INVALID', 'The chunk index has invalid JSON or fields.', record.chunkIndexPath)
    return
  }

  try {
    const indexedDocument = resolveStoredPath(workspace.sessionRoot, chunksRoot, index.source_document)
    if (document !== null && indexedDocument !== document) {
      reject(issues, 'FILE_INTAKE_CHUNK_INDEX_INVALID', 'The chunk index names a different source document.', record.chunkIndexPath)
    }
  } catch {
    reject(issues, 'FILE_INTAKE_PATH_OUTSIDE_SESSION', 'The chunk index source path leaves the Bid Session workspace.', record.chunkIndexPath)
  }

  const chunkPaths = new Set(index.chunks.map(chunk => chunk.path))
  for (const chunk of index.chunks) {
    try {
      const chunkPath = resolveStoredPath(workspace.sessionRoot, chunksRoot, chunk.path)
      if (!isWithin(chunksRoot, chunkPath)) throw new Error('chunk path leaves chunk directory')
      await requireFile(workspace.root, chunkPath, `${record.chunksPath}/${chunk.path}`, 'FILE_INTAKE_CHUNK_MISSING', issues)
    } catch {
      reject(issues, 'FILE_INTAKE_PATH_OUTSIDE_SESSION', 'A chunk path leaves its Bid corpus directory.', chunk.path)
    }
    for (const adjacent of [chunk.prev_chunk, chunk.next_chunk]) {
      if (adjacent !== null && !chunkPaths.has(adjacent)) {
        reject(issues, 'FILE_INTAKE_CHUNK_INDEX_INVALID', 'A chunk adjacency reference is not present in the index.', adjacent)
      }
    }
  }

  const extension = extname(record.originalName).toLocaleLowerCase('en-US')
  if (extension === '.pdf' || extension === '.docx' || extension === '.doc') {
    for (const [path, code] of [
      [record.structurePath, 'FILE_INTAKE_STRUCTURE_MISSING'],
      [record.metadataPath, 'FILE_INTAKE_METADATA_MISSING'],
    ] as const) {
      if (path === null) {
        reject(issues, code, 'A parsed document is missing a required extraction sidecar.', record.inputPath)
        continue
      }
      const absolute = resolveRecordPath(workspace, path, issues)
      if (absolute !== null) await requireFile(workspace.root, absolute, path, code, issues)
    }
  }
}

/**
 * Validate the current file-intake batch against its durable workspace artifacts.
 * @param workspace - Session-isolated Bid workspace selected by the Host.
 * @param batch - records returned by this exact import attempt.
 * @param stage - orchestrator stage requesting validation.
 * @param artifacts - session-relative artifacts returned by the executor.
 * @returns explicit issues, or authorization for the stage to complete.
 */
export async function validateFileIntake(
  workspace: BidWorkspace,
  batch: readonly ImportedFile[],
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'file_intake') {
    reject(issues, 'FILE_INTAKE_STAGE_INVALID', 'The file-intake validator only accepts the file_intake stage.')
  }
  for (const artifact of artifacts) {
    if (artifact.stage !== 'file_intake') {
      reject(issues, 'FILE_INTAKE_ARTIFACT_INVALID', 'A file-intake artifact names another stage.', artifact.path)
      continue
    }
    try {
      resolveStoredPath(workspace.sessionRoot, workspace.sessionRoot, artifact.path)
    } catch {
      reject(issues, 'FILE_INTAKE_PATH_OUTSIDE_SESSION', 'A stage artifact path leaves the Bid Session workspace.', artifact.path)
    }
  }
  if (!artifacts.some(artifact => (
    artifact.stage === 'file_intake'
    && artifact.type === 'manifest'
    && artifact.path === 'manifest.json'
  ))) {
    reject(issues, 'FILE_INTAKE_MANIFEST_ARTIFACT_MISSING', 'The file-intake stage did not return manifest.json.', 'manifest.json')
  }
  if (batch.length === 0) {
    reject(issues, 'FILE_INTAKE_BATCH_EMPTY', 'The current file-intake batch is empty.')
  }

  const manifest = await readRequiredManifest(workspace, issues)
  if (manifest !== null) {
    for (const imported of batch) {
      const record = manifest.files.find(file => file.inputPath === imported.inputPath)
      if (record === undefined) {
        reject(issues, 'FILE_INTAKE_MANIFEST_RECORD_MISSING', 'The current import is not recorded exactly in manifest.json.', imported.inputPath)
        continue
      }
      for (const path of [
        record.inputPath,
        record.corpusPath,
        record.documentPath,
        record.structurePath,
        record.metadataPath,
        record.chunksPath,
        record.chunkIndexPath,
      ]) {
        if (path !== null) resolveRecordPath(workspace, path, issues)
      }
      if (!sameRecord(record, imported)) {
        reject(issues, 'FILE_INTAKE_MANIFEST_RECORD_MISSING', 'The current import is not recorded exactly in manifest.json.', imported.inputPath)
        continue
      }
      const input = resolveRecordPath(workspace, record.inputPath, issues)
      if (record.parseStatus !== 'success') {
        if (input !== null) await requireFile(workspace.root, input, record.inputPath, 'FILE_INTAKE_INPUT_MISSING', issues)
        const code = record.parseStatus === 'needs_ocr'
          ? 'FILE_INTAKE_NEEDS_OCR'
          : record.parseStatus === 'pending'
            ? 'FILE_INTAKE_PARSE_PENDING'
            : 'FILE_INTAKE_PARSE_FAILED'
        const message = record.parseStatus === 'needs_ocr'
          ? 'The file requires OCR before Bid intake can complete.'
          : record.parseStatus === 'pending'
            ? 'File parsing did not settle.'
            : 'File parsing failed.'
        reject(issues, code, message, record.inputPath)
        continue
      }
      await validateSuccessfulRecord(workspace, record, issues)
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
