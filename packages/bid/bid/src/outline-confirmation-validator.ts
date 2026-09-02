import type { StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import type { OutlineConfirmationIssueCode } from './outline-confirmation-issues.ts'
import { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
const DRAFT = 'outline/draft.json'

function reject(issues: StageValidationIssue[], code: OutlineConfirmationIssueCode, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

/** Validate one S5 draft with shared structure and coverage rules only. */
export function validateOutlineDraftForConfirmation(
  outlineRaw: unknown,
  requirementsRaw: unknown,
  scoringRaw: unknown,
  complianceRaw: unknown,
  catalogRaw: unknown,
): StageValidationResult {
  const issues: StageValidationIssue[] = []
  try {
    const outline = parseConfirmedOutlineArtifact(outlineRaw)
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(
      outline,
      parseTenderRequirementsArtifact(requirementsRaw), parseTenderScoringArtifact(scoringRaw),
      parseTenderComplianceArtifact(complianceRaw), parseScoringResponsePointCatalog(catalogRaw), issues,
    )
  } catch { reject(issues, 'OUTLINE_CONFIRMATION_DRAFT_INVALID', 'The outline draft or required analysis Artifacts are invalid.', DRAFT) }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

/** Validate an in-memory S5 candidate through the shared outline rules. */
export const validateConfirmedOutline = validateOutlineDraftForConfirmation
