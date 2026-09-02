import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseOutlineArtifact, parseOutlineQualityReport } from './outline-generation-artifacts.ts'
import { validateOutlineGenerationQuality } from './outline-generation-quality-validator.ts'
import { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { catalogMatchesScoring, parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT = 'outline/quality-report.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact = ARTIFACT): void {
  issues.push({ code, message, artifact })
}

function reportArtifactParseFailure(error: unknown, issues: StageValidationIssue[]): void {
  if (!(error instanceof Error) || !('issues' in error) || !Array.isArray(error.issues)) {
    reject(issues, 'OUTLINE_GENERATION_ARTIFACT_INVALID', 'The outline-generation Artifacts have invalid fields.')
    return
  }
  for (const issue of error.issues.slice(0, 12)) {
    if (typeof issue !== 'object' || issue === null) continue
    const value = issue as { path?: unknown; message?: unknown }
    const path = Array.isArray(value.path) ? value.path.join('.') : 'unknown'
    const message = typeof value.message === 'string' ? value.message : 'invalid field'
    reject(issues, 'OUTLINE_GENERATION_ARTIFACT_INVALID', `Invalid outline-generation field ${path}: ${message}`)
  }
  if (issues.length === 0) reject(issues, 'OUTLINE_GENERATION_ARTIFACT_INVALID', 'The outline-generation Artifacts have invalid fields.')
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
  } catch { reject(issues, 'OUTLINE_GENERATION_INPUT_INVALID', 'A required outline-generation input is missing or invalid.', path) }
  try {
    const absolute = within(workspace.sessionRoot, path)
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON'
    reject(issues, 'OUTLINE_GENERATION_INPUT_INVALID', `Invalid JSON: ${message}`, path)
  }
}

/** Validate S3 with stable response points, shared outline coverage, and quality rules. */
export async function validateOutlineGeneration(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'outline_generation') reject(issues, 'OUTLINE_GENERATION_STAGE_INVALID', 'The outline validator only accepts outline_generation.')
  const expected = new Set([
    'scoring_response_points:analysis/scoring-response-points.json',
    'outline:outline/outline.json',
    'outline_quality_report:outline/quality-report.json',
  ])
  const actual = new Set(artifacts.filter(artifact => artifact.stage === 'outline_generation').map(artifact => `${artifact.type}:${artifact.path}`))
  if (artifacts.length !== expected.size || actual.size !== expected.size || [...expected].some(value => !actual.has(value))) {
    reject(issues, 'OUTLINE_GENERATION_ARTIFACT_SET_INVALID', 'The executor must return the S3 response-point catalog, outline, and quality report exactly once.')
  }
  const values = await Promise.all([
    parseJson(workspace, ARTIFACT, issues), parseJson(workspace, QUALITY_REPORT, issues),
    parseJson(workspace, 'analysis/requirements.json', issues), parseJson(workspace, 'analysis/scoring.json', issues),
    parseJson(workspace, 'analysis/compliance.json', issues), parseJson(workspace, 'analysis/scoring-response-points.json', issues),
  ])
  if (values.some(value => value === undefined)) return { ok: false, issues }
  try {
    const [outlineRaw, reportRaw, requirementsRaw, scoringRaw, complianceRaw, catalogRaw] = values
    const outline = parseOutlineArtifact(outlineRaw)
    const report = parseOutlineQualityReport(reportRaw)
    const requirements = parseTenderRequirementsArtifact(requirementsRaw)
    const scoring = parseTenderScoringArtifact(scoringRaw)
    const compliance = parseTenderComplianceArtifact(complianceRaw)
    const catalog = parseScoringResponsePointCatalog(catalogRaw)
    if (!catalogMatchesScoring(catalog, scoring)) {
      reject(issues, 'OUTLINE_RESPONSE_POINT_CATALOG_INVALID', 'The response-point catalog does not belong to the current scoring Artifact.', 'analysis/scoring-response-points.json')
    }
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(outline, requirements, scoring, compliance, catalog, issues)
    validateOutlineGenerationQuality(outline, report, requirements, scoring, catalog, issues)
  } catch (error) { reportArtifactParseFailure(error, issues) }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
