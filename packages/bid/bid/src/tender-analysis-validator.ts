import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace, ManifestFile } from './index.ts'
import { within } from './index.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import type {
  BidStage,
  StageArtifact,
  StageValidationIssue,
  StageValidationResult,
} from './control-plane-contract.ts'
import {
  TENDER_ANALYSIS_ARTIFACTS,
  type TenderComplianceArtifact,
  type TenderProjectArtifact,
  type TenderRequirementsArtifact,
  type TenderScoringArtifact,
  type TenderSourceRef,
} from './tender-analysis-artifacts.ts'

type ParsedArtifacts = {
  project: TenderProjectArtifact
  requirements: TenderRequirementsArtifact
  scoring: TenderScoringArtifact
  compliance: TenderComplianceArtifact
}

function reject(issues: StageValidationIssue[], code: string, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function parseArtifact(
  workspace: BidWorkspace,
  path: keyof typeof TENDER_ANALYSIS_ARTIFACTS,
  issues: StageValidationIssue[],
): Promise<unknown> {
  let absolute: string
  try {
    absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not a regular file')
  } catch {
    reject(issues, 'TENDER_ANALYSIS_ARTIFACT_MISSING', 'A required tender-analysis Artifact is missing.', path)
    return undefined
  }
  try {
    return TENDER_ANALYSIS_ARTIFACTS[path].parse(JSON.parse(await readFile(absolute, 'utf8')))
  } catch {
    reject(issues, 'TENDER_ANALYSIS_ARTIFACT_INVALID', 'A tender-analysis Artifact has invalid JSON or fields.', path)
    return undefined
  }
}

function duplicateIds(values: readonly { id: string }[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id)
    seen.add(value.id)
  }
  return [...duplicates]
}

function tenderRecords(manifest: BidManifest): ManifestFile[] {
  return manifest.files.filter(file => file.role === 'tender' && file.parseStatus === 'success')
}

async function validateSourceRef(
  workspace: BidWorkspace,
  manifest: BidManifest,
  ref: TenderSourceRef,
  issues: StageValidationIssue[],
): Promise<string | null> {
  const candidates = manifest.files.filter(file => file.id === ref.file_id)
  if (candidates.length === 0) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_FILE_UNKNOWN', 'A source reference names no manifest file.', ref.chunk)
    return null
  }
  if (candidates.every(file => file.role !== 'tender')) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_ROLE_INVALID', 'A reference file cannot authorize tender requirements.', ref.chunk)
    return null
  }
  if (candidates.every(file => file.parseStatus !== 'success')) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_FILE_INVALID', 'A source reference names an unparsed tender file.', ref.chunk)
    return null
  }
  for (const record of candidates) {
    if (record.role !== 'tender' || record.parseStatus !== 'success'
      || record.chunksPath === null || record.chunkIndexPath === null) continue
    const chunksPath = record.chunksPath
    let index: ReturnType<typeof parseDocumentChunkIndex>
    try {
      const indexPath = within(workspace.sessionRoot, record.chunkIndexPath)
      await assertNoLinkedPath(workspace.root, indexPath)
      index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    } catch {
      continue
    }
    const entry = index.chunks.find(chunk => posix.join(chunksPath, chunk.path) === ref.chunk)
    if (entry === undefined) continue
    try {
      const chunkPath = within(workspace.sessionRoot, ref.chunk)
      await assertNoLinkedPath(workspace.root, chunkPath)
      const chunk = await readFile(chunkPath, 'utf8')
      const lines = chunk.split('\n')
      const lineCount = lines.length
      if (ref.line_start > lineCount || ref.line_end > lineCount) {
        reject(issues, 'TENDER_ANALYSIS_SOURCE_LINE_INVALID', 'A source line range leaves its chunk.', ref.chunk)
      }
      return ref.line_start > lineCount || ref.line_end > lineCount
        ? null
        : lines.slice(ref.line_start - 1, ref.line_end).join('\n')
    } catch {
      break
    }
  }
  reject(issues, 'TENDER_ANALYSIS_SOURCE_CHUNK_INVALID', 'A source reference does not name a real chunk owned by its tender file.', ref.chunk)
  return null
}

function normalizeSourceText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\s+/gu, ' ').trim()
}

async function validateRawText(
  workspace: BidWorkspace,
  manifest: BidManifest,
  artifact: string,
  rawText: string,
  refs: readonly TenderSourceRef[],
  issues: StageValidationIssue[],
): Promise<void> {
  const normalizedRawText = normalizeSourceText(rawText)
  const sourceRanges = await Promise.all(refs.map(ref => validateSourceRef(workspace, manifest, ref, issues)))
  if (sourceRanges.some(range => range !== null && normalizeSourceText(range).includes(normalizedRawText))) return
  if (sourceRanges.some(range => range !== null)) {
    reject(
      issues,
      'TENDER_ANALYSIS_SOURCE_TEXT_MISMATCH',
      'An Artifact raw_text does not occur in its cited tender source range.',
      artifact,
    )
  }
}

function validateCoverage(
  project: TenderProjectArtifact,
  manifest: BidManifest,
  issues: StageValidationIssue[],
): void {
  const expected = new Set(tenderRecords(manifest).map(file => file.id))
  const actual = new Set(project.analyzed_tender_files)
  if (project.analyzed_tender_files.length !== actual.size
    || expected.size !== actual.size
    || [...expected].some(id => !actual.has(id))) {
    reject(
      issues,
      'TENDER_ANALYSIS_COVERAGE_INCOMPLETE',
      'analyzed_tender_files must cover every successfully parsed tender file exactly once.',
      'analysis/project.json',
    )
  }
}

/**
 * Validate all S2 Artifacts and their citations against the current Bid Session workspace.
 * @param workspace Session-scoped Bid workspace.
 * @param stage Orchestrator stage that declares the expected Artifact paths.
 * @param artifacts Artifact references returned by the executor.
 * @returns Validation success or all detected schema and citation issues.
 */
export async function validateTenderAnalysis(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'tender_analysis') {
    reject(issues, 'TENDER_ANALYSIS_STAGE_INVALID', 'The tender-analysis validator only accepts tender_analysis.')
  }
  const expectedPaths = Object.keys(TENDER_ANALYSIS_ARTIFACTS)
  for (const path of expectedPaths) {
    const matches = artifacts.filter(artifact => artifact.stage === 'tender_analysis' && artifact.path === path)
    if (matches.length !== 1) {
      reject(issues, 'TENDER_ANALYSIS_ARTIFACT_SET_INVALID', 'Each required tender-analysis Artifact must be returned exactly once.', path)
    }
  }
  for (const artifact of artifacts) {
    if (artifact.stage !== 'tender_analysis' || !expectedPaths.includes(artifact.path)) {
      reject(issues, 'TENDER_ANALYSIS_ARTIFACT_SET_INVALID', 'The executor returned an unexpected tender-analysis Artifact.', artifact.path)
    }
  }

  let manifest: BidManifest
  try {
    manifest = await workspace.readManifest()
  } catch {
    reject(issues, 'TENDER_ANALYSIS_MANIFEST_INVALID', 'The current Bid manifest cannot be read.', 'manifest.json')
    return { ok: false, issues }
  }
  if (tenderRecords(manifest).length === 0) {
    reject(issues, 'TENDER_ANALYSIS_TENDER_MISSING', 'The Bid Session has no successfully parsed tender file.', 'manifest.json')
  }

  const [project, requirements, scoring, compliance] = await Promise.all([
    parseArtifact(workspace, 'analysis/project.json', issues),
    parseArtifact(workspace, 'analysis/requirements.json', issues),
    parseArtifact(workspace, 'analysis/scoring.json', issues),
    parseArtifact(workspace, 'analysis/compliance.json', issues),
  ])
  if (project === undefined || requirements === undefined || scoring === undefined || compliance === undefined) {
    return { ok: false, issues }
  }
  const parsed: ParsedArtifacts = {
    project: project as TenderProjectArtifact,
    requirements: requirements as TenderRequirementsArtifact,
    scoring: scoring as TenderScoringArtifact,
    compliance: compliance as TenderComplianceArtifact,
  }
  validateCoverage(parsed.project, manifest, issues)
  for (const [path, values] of [
    ['analysis/requirements.json', parsed.requirements.requirements],
    ['analysis/scoring.json', parsed.scoring.scoring_items],
    ['analysis/compliance.json', parsed.compliance.compliance_items],
  ] as const) {
    for (const id of duplicateIds(values)) {
      reject(issues, 'TENDER_ANALYSIS_DUPLICATE_ID', `Artifact contains duplicate id ${JSON.stringify(id)}.`, path)
    }
  }
  await Promise.all([
    ...parsed.project.source_refs.map(ref => validateSourceRef(workspace, manifest, ref, issues)),
    ...parsed.requirements.requirements.map(item => validateRawText(
      workspace, manifest, 'analysis/requirements.json', item.raw_text, item.source_refs, issues,
    )),
    ...parsed.scoring.scoring_items.map(item => validateRawText(
      workspace, manifest, 'analysis/scoring.json', item.raw_text, item.source_refs, issues,
    )),
    ...parsed.compliance.compliance_items.map(item => validateRawText(
      workspace, manifest, 'analysis/compliance.json', item.raw_text, item.source_refs, issues,
    )),
  ])
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
