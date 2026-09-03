import { lstat, readFile } from 'node:fs/promises'
import { ZodError } from 'zod'
import { resolveEvidenceChunk } from './evidence-chunk.ts'
import { validateSectionEvidenceCoverage } from './section-evidence-context.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type LocalEvidenceMaterial, type WebEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseOutlineArtifact, parseOutlineQualityReport } from './outline-generation-artifacts.ts'
import { validateOutlineFrameworkRefs } from './outline-framework.ts'
import { validateOutlineGenerationQuality } from './outline-generation-quality-validator.ts'
import { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { catalogMatchesScoring, parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { parseWebEvidenceSourcesArtifact, webEvidenceContentSha256, type WebEvidenceSource } from './web-evidence-source-artifacts.ts'

const MAP_PATH = 'analysis/evidence-map.json'
const WEB_PATH = 'analysis/web-evidence-sources.json'
const OUTLINE_PATH = 'outline/outline.json'
const QUALITY_PATH = 'outline/quality-report.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact?: string, path?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }), ...(path === undefined ? {} : { path }) })
}

async function readJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    reject(issues, 'EVIDENCE_MAPPING_INPUT_INVALID', 'A required evidence-mapping input is missing or invalid.', path)
    return undefined
  }
}

async function validateLocalMaterial(
  workspace: BidWorkspace,
  manifest: BidManifest,
  material: LocalEvidenceMaterial,
  issues: StageValidationIssue[],
): Promise<void> {
  const file = manifest.files.find(record => String(record.id) === material.file_id && record.role === material.source_kind)
  if (file === undefined || file.parseStatus !== 'success' || (file.role !== 'reference' && file.role !== 'reference_bid')) {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_INVALID', 'A local material must reference a parsed reference or reference_bid file.', MAP_PATH)
    return
  }
  try { await resolveEvidenceChunk(workspace, manifest, material) } catch {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_CHUNK_INVALID', 'A local material does not name a real chunk owned by its file.', MAP_PATH)
  }
}

async function validateWebSource(
  workspace: BidWorkspace,
  source: WebEvidenceSource,
  issues: StageValidationIssue[],
): Promise<boolean> {
  try {
    const path = within(workspace.sessionRoot, source.snapshot_path)
    await assertNoLinkedPath(workspace.root, path)
    const content = await readFile(path, 'utf8')
    if (!(await lstat(path)).isFile() || content.trim().length === 0 || webEvidenceContentSha256(content) !== source.content_sha256) throw new Error('invalid')
    return true
  } catch {
    reject(
      issues,
      'EVIDENCE_MAPPING_WEB_SOURCE_INVALID',
      `Web source ${source.source_id} has no valid durable snapshot.`,
      source.snapshot_path,
    )
    return false
  }
}

function validateWebMaterial(
  material: WebEvidenceMaterial,
  sources: ReadonlyMap<string, WebEvidenceSource>,
  valid: ReadonlySet<string>,
  issues: StageValidationIssue[],
): void {
  const source = sources.get(material.source_id)
  if (source === undefined || source.snapshot_path !== material.snapshot_path || !valid.has(material.source_id)) {
    reject(issues, 'EVIDENCE_MAPPING_WEB_MATERIAL_INVALID', `Web material ${material.source_id} does not match a valid source snapshot.`, MAP_PATH)
  }
}

/** Validate the S4 section-to-evidence map and the final outline offered for confirmation. */
export async function validateEvidenceMapping(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'evidence_mapping') reject(issues, 'EVIDENCE_MAPPING_STAGE_INVALID', 'The evidence-mapping validator only accepts evidence_mapping.')
  const expected = new Set([
    `evidence_map:${MAP_PATH}`,
    `web_evidence_sources:${WEB_PATH}`,
    `outline:${OUTLINE_PATH}`,
    `outline_quality_report:${QUALITY_PATH}`,
  ])
  const actual = new Set(artifacts.filter(item => item.stage === stage).map(item => `${item.type}:${item.path}`))
  if (artifacts.length !== expected.size || actual.size !== expected.size || [...expected].some(item => !actual.has(item))) {
    reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_SET_INVALID', 'The executor must return the evidence map, Web ledger, outline, and quality report exactly once.', MAP_PATH)
  }
  let manifest: BidManifest
  try { manifest = await workspace.readManifest() } catch {
    reject(issues, 'EVIDENCE_MAPPING_MANIFEST_INVALID', 'The current Bid manifest cannot be read.', 'manifest.json')
    return { ok: false, issues }
  }
  const values = await Promise.all([
    readJson(workspace, MAP_PATH, issues), readJson(workspace, WEB_PATH, issues),
    readJson(workspace, OUTLINE_PATH, issues), readJson(workspace, QUALITY_PATH, issues),
    readJson(workspace, 'analysis/requirements.json', issues), readJson(workspace, 'analysis/scoring.json', issues),
    readJson(workspace, 'analysis/compliance.json', issues), readJson(workspace, 'analysis/scoring-response-points.json', issues),
  ])
  if (values.some(value => value === undefined)) return { ok: false, issues }
  try {
    const [mapRaw, webRaw, outlineRaw, qualityRaw, requirementsRaw, scoringRaw, complianceRaw, catalogRaw] = values
    const map = parseEvidenceMapArtifact(mapRaw)
    const web = parseWebEvidenceSourcesArtifact(webRaw)
    const outline = parseOutlineArtifact(outlineRaw)
    const quality = parseOutlineQualityReport(qualityRaw)
    const requirements = parseTenderRequirementsArtifact(requirementsRaw)
    const scoring = parseTenderScoringArtifact(scoringRaw)
    const compliance = parseTenderComplianceArtifact(complianceRaw)
    const catalog = parseScoringResponsePointCatalog(catalogRaw)
    if (!catalogMatchesScoring(catalog, scoring)) reject(issues, 'EVIDENCE_MAPPING_RESPONSE_POINT_CATALOG_MISMATCH', 'The response-point catalog does not match scoring.json.', 'analysis/scoring-response-points.json')
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(outline, requirements, scoring, compliance, catalog, issues)
    await validateOutlineFrameworkRefs(workspace, outline, issues)
    validateOutlineGenerationQuality(outline, quality, requirements, scoring, catalog, issues)
    issues.push(...validateSectionEvidenceCoverage(outline, map))
    for (const mapping of map.section_mappings) {
      await Promise.all(mapping.local_materials.map(material => validateLocalMaterial(workspace, manifest, material, issues)))
    }
    const validity = await Promise.all(web.sources.map(async source => [
      source,
      await validateWebSource(workspace, source, issues),
    ] as const))
    const validIds = new Set(validity.filter(([, valid]) => valid).map(([source]) => source.source_id))
    const sources = new Map(web.sources.map(source => [source.source_id, source]))
    for (const mapping of map.section_mappings) {
      for (const material of mapping.web_materials) {
        validateWebMaterial(material, sources, validIds, issues)
      }
    }
  } catch (error) {
    if (error instanceof ZodError) {
      for (const issue of error.issues.slice(0, 12)) reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID', issue.message, MAP_PATH, issue.path.join('.'))
    } else reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID', 'An evidence-mapping Artifact has invalid fields.', MAP_PATH)
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
