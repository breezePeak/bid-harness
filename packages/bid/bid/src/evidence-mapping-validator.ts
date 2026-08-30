import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import { within } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type EvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const ARTIFACT = 'analysis/evidence-map.json'
const S2_REQUIREMENTS = 'analysis/requirements.json'
const S2_SCORING = 'analysis/scoring.json'

function reject(
  issues: StageValidationIssue[], code: string, message: string, artifact?: string,
): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[], code: string): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    reject(issues, code, 'A required evidence-mapping Artifact is missing or invalid.', path)
    return undefined
  }
}

function validateCoverage(
  expected: readonly { id: string }[], actual: readonly string[], kind: string, issues: StageValidationIssue[],
): void {
  const expectedIds = new Set(expected.map(item => item.id))
  const actualIds = new Set(actual)
  if (actual.length !== actualIds.size) reject(issues, `EVIDENCE_MAPPING_${kind}_DUPLICATE`, `Each ${kind.toLowerCase()} mapping must occur once.`, ARTIFACT)
  for (const id of actualIds) if (!expectedIds.has(id)) {
    reject(issues, `EVIDENCE_MAPPING_${kind}_UNKNOWN`, `Evidence mapping references unknown ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, ARTIFACT)
  }
  for (const id of expectedIds) if (!actualIds.has(id)) {
    reject(issues, `EVIDENCE_MAPPING_${kind}_MISSING`, `Evidence mapping omits ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, ARTIFACT)
  }
}

async function validateMaterial(
  workspace: BidWorkspace, manifest: BidManifest, material: EvidenceMaterial, issues: StageValidationIssue[],
): Promise<void> {
  const matchingFiles = manifest.files.filter(record => record.id === material.file_id)
  if (matchingFiles.length === 0) { reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_UNKNOWN', 'A material references no manifest file.', material.chunk); return }
  const file = matchingFiles.find(record => record.role === 'reference')
  if (file === undefined) {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_NOT_REFERENCE', 'A material must reference a reference-role file.', material.chunk)
    return
  }
  if (file.parseStatus !== 'success' || file.chunksPath === null || file.chunkIndexPath === null) {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_INVALID', 'A material references an unparsed file.', material.chunk)
    return
  }
  const chunksPath = file.chunksPath
  try {
    const indexPath = within(workspace.sessionRoot, file.chunkIndexPath)
    await assertNoLinkedPath(workspace.root, indexPath)
    const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    if (!index.chunks.some(chunk => posix.join(chunksPath, chunk.path) === material.chunk)) throw new Error('chunk')
    const chunkPath = within(workspace.sessionRoot, material.chunk)
    await assertNoLinkedPath(workspace.root, chunkPath)
    const lineCount = (await readFile(chunkPath, 'utf8')).split('\n').length
    if (material.line_end > lineCount) reject(issues, 'EVIDENCE_MAPPING_SOURCE_LINE_INVALID', 'A material line range leaves its chunk.', material.chunk)
  } catch {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_CHUNK_INVALID', 'A material does not name a real chunk owned by its file.', material.chunk)
  }
}

/** Validate S3 mappings against S2 identifiers and the local session corpus. */
export async function validateEvidenceMapping(
  workspace: BidWorkspace, stage: BidStage, artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'evidence_mapping') reject(issues, 'EVIDENCE_MAPPING_STAGE_INVALID', 'The evidence-mapping validator only accepts evidence_mapping.')
  const matching = artifacts.filter(artifact => artifact.stage === 'evidence_mapping' && artifact.path === ARTIFACT)
  if (matching.length !== 1 || artifacts.length !== 1) {
    reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_SET_INVALID', 'The executor must return evidence-map.json exactly once.', ARTIFACT)
  }
  let manifest: BidManifest
  try { manifest = await workspace.readManifest() } catch {
    reject(issues, 'EVIDENCE_MAPPING_MANIFEST_INVALID', 'The current Bid manifest cannot be read.', 'manifest.json')
    return { ok: false, issues }
  }
  const [rawMap, rawRequirements, rawScoring] = await Promise.all([
    parseJson(workspace, ARTIFACT, issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID'),
    parseJson(workspace, S2_REQUIREMENTS, issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID'),
    parseJson(workspace, S2_SCORING, issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID'),
  ])
  if (rawMap === undefined || rawRequirements === undefined || rawScoring === undefined) return { ok: false, issues }
  let map
  let requirements
  let scoring
  try {
    map = parseEvidenceMapArtifact(rawMap)
    requirements = parseTenderRequirementsArtifact(rawRequirements)
    scoring = parseTenderScoringArtifact(rawScoring)
  } catch {
    reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID', 'An evidence-mapping Artifact has invalid fields.', ARTIFACT)
    return { ok: false, issues }
  }
  validateCoverage(requirements.requirements, map.requirement_mappings.map(item => item.requirement_id), 'REQUIREMENT', issues)
  validateCoverage(scoring.scoring_items, map.scoring_mappings.map(item => item.scoring_id), 'SCORING', issues)
  await Promise.all(
    [...map.requirement_mappings, ...map.scoring_mappings]
      .flatMap(mapping => mapping.materials.map(material => validateMaterial(workspace, manifest, material, issues))),
  )
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
