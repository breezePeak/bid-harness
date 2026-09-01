import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseOutlineArtifact, parseOutlineQualityReport } from './outline-generation-artifacts.ts'
import { validateOutlineGenerationQuality } from './outline-generation-quality-validator.ts'
import { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT = 'outline/quality-report.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact = ARTIFACT): void {
  issues.push({ code, message, artifact })
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch { reject(issues, 'OUTLINE_GENERATION_INPUT_INVALID', 'A required outline-generation input is missing or invalid.', path) }
}

/** Validate S4 with shared structure and coverage plus generation-only quality rules. */
export async function validateOutlineGeneration(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'outline_generation') reject(issues, 'OUTLINE_GENERATION_STAGE_INVALID', 'The outline validator only accepts outline_generation.')
  const artifact = artifacts.length === 1 ? artifacts[0] : undefined
  if (artifact === undefined || artifact.stage !== 'outline_generation' || artifact.path !== ARTIFACT) {
    reject(issues, 'OUTLINE_GENERATION_ARTIFACT_SET_INVALID', 'The executor must return outline/outline.json exactly once.')
  }
  const values = await Promise.all([
    parseJson(workspace, ARTIFACT, issues), parseJson(workspace, QUALITY_REPORT, issues),
    parseJson(workspace, 'analysis/requirements.json', issues), parseJson(workspace, 'analysis/scoring.json', issues),
    parseJson(workspace, 'analysis/compliance.json', issues), parseJson(workspace, 'analysis/evidence-map.json', issues),
    parseJson(workspace, 'analysis/scoring-response-points.json', issues),
  ])
  if (values.some(value => value === undefined)) return { ok: false, issues }
  try {
    const [outlineRaw, reportRaw, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw, catalogRaw] = values
    const outline = parseOutlineArtifact(outlineRaw)
    const report = parseOutlineQualityReport(reportRaw)
    const requirements = parseTenderRequirementsArtifact(requirementsRaw)
    const scoring = parseTenderScoringArtifact(scoringRaw)
    const compliance = parseTenderComplianceArtifact(complianceRaw)
    const evidence = parseEvidenceMapArtifact(evidenceRaw)
    const catalog = parseScoringResponsePointCatalog(catalogRaw)
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(outline, requirements, scoring, compliance, evidence, catalog, issues)
    validateOutlineGenerationQuality(outline, report, requirements, scoring, evidence, catalog, issues)
  } catch { reject(issues, 'OUTLINE_GENERATION_ARTIFACT_INVALID', 'The outline-generation Artifacts have invalid fields.') }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
