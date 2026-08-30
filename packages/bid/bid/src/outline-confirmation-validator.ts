import type { StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import { validateOutlineReferences, validateOutlineTree } from './outline-generation-validator.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'

/** Validate a user-edited candidate with the same mechanical S4 rules. */
export function validateConfirmedOutline(
  outline: OutlineArtifact,
  requirementsRaw: unknown,
  scoringRaw: unknown,
  complianceRaw: unknown,
): StageValidationResult {
  const issues: StageValidationIssue[] = []
  try {
    validateOutlineTree(outline.sections, issues)
    validateOutlineReferences(
      outline.sections,
      outline.global_compliance_ids,
      parseTenderRequirementsArtifact(requirementsRaw),
      parseTenderScoringArtifact(scoringRaw),
      parseTenderComplianceArtifact(complianceRaw),
      issues,
    )
  } catch {
    issues.push({ code: 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', message: 'The confirmed outline or its required analysis artifacts are invalid.', artifact: 'outline/confirmed-outline.json' })
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
