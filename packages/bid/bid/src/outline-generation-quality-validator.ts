import type { StageValidationIssue } from './control-plane-contract.ts'
import type { OutlineArtifact, OutlineQualityReport } from './outline-generation-artifacts.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderRequirementsArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact = 'outline/outline.json'): void {
  issues.push({ code, message, artifact })
}
function validateExact(kind: string, expected: readonly string[], actual: readonly string[], issues: StageValidationIssue[]): void {
  if (new Set(actual).size !== actual.length) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_DUPLICATE`, `Quality review repeats ${kind.toLowerCase()} ids.`, 'outline/quality-report.json')
  for (const id of actual) if (!expected.includes(id)) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_UNKNOWN`, `Quality review references unknown ${kind.toLowerCase()} id.`, 'outline/quality-report.json')
  for (const id of expected) if (!actual.includes(id)) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_MISSING`, `Quality review omits ${kind.toLowerCase()} id.`, 'outline/quality-report.json')
}

/**
 * @param outline Generated Outline.
 * @param report S4 quality report.
 * @param requirements S2 requirements.
 * @param scoring S2 scoring.
 * @param catalog Stable response points.
 * @param issues Mutable issue sink.
 * @returns Nothing.
 */
export function validateOutlineGenerationQuality(
  outline: OutlineArtifact,
  report: OutlineQualityReport,
  requirements: TenderRequirementsArtifact,
  scoring: TenderScoringArtifact,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): void {
  validateExact('REQUIREMENT', requirements.requirements.map(item => item.id), report.checked_requirement_ids, issues)
  validateExact('SCORING', scoring.scoring_items.map(item => item.id), report.checked_scoring_ids, issues)
  validateExact('SECTION', outline.sections.map(item => item.id), report.reviewed_section_ids, issues)
  validateExact('SCORING_RESPONSE_POINT', catalog.points.map(point => point.id), report.checked_scoring_response_point_ids, issues)
}
