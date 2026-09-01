import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseConfirmedOutlineArtifact, parseOutlineConfirmationArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { validateOutlineEvidenceReferences, validateOutlineReferences, validateOutlineTree } from './outline-generation-validator.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const CONFIRMED_OUTLINE = 'outline/confirmed-outline.json'
const CONFIRMATION = 'outline/confirmation.json'
const SOURCE_OUTLINE = 'outline/outline.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown | undefined> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    reject(issues, 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', 'A required outline-confirmation Artifact is missing or invalid.', path)
    return undefined
  }
}

/** Validate a user-edited candidate's structure and identifier coverage. */
export function validateConfirmedOutline(
  outlineRaw: unknown,
  requirementsRaw: unknown,
  scoringRaw: unknown,
  complianceRaw: unknown,
  evidenceRaw?: unknown,
): StageValidationResult {
  const issues: StageValidationIssue[] = []
  try {
    const outline = parseConfirmedOutlineArtifact(outlineRaw)
    validateOutlineTree(outline.sections, issues)
    validateOutlineReferences(
      outline.sections,
      outline.global_compliance_ids,
      parseTenderRequirementsArtifact(requirementsRaw),
      parseTenderScoringArtifact(scoringRaw),
      parseTenderComplianceArtifact(complianceRaw),
      issues,
    )
    if (evidenceRaw !== undefined) validateOutlineEvidenceReferences(outline.sections, parseEvidenceMapArtifact(evidenceRaw), issues)
  } catch {
    issues.push({ code: 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', message: 'The confirmed outline or its required analysis artifacts are invalid.', artifact: 'outline/confirmed-outline.json' })
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

/** Validate the persisted S5 artifacts before authorizing stage completion. */
export async function validateOutlineConfirmation(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  const expected = new Map([[CONFIRMED_OUTLINE, 'confirmed_outline'], [CONFIRMATION, 'outline_confirmation']])
  if (stage !== 'outline_confirmation') reject(issues, 'OUTLINE_CONFIRMATION_STAGE_INVALID', 'The outline-confirmation validator only accepts outline_confirmation.')
  if (artifacts.length !== expected.size || artifacts.some(artifact => artifact.stage !== 'outline_confirmation' || expected.get(artifact.path) !== artifact.type)
    || new Set(artifacts.map(artifact => artifact.path)).size !== expected.size) {
    reject(
      issues, 'OUTLINE_CONFIRMATION_ARTIFACT_SET_INVALID',
      'The executor must return confirmed-outline.json and confirmation.json exactly once.',
    )
  }
  const [sourceRaw, confirmedRaw, confirmationRaw, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw] = await Promise.all([
    parseJson(workspace, SOURCE_OUTLINE, issues),
    parseJson(workspace, CONFIRMED_OUTLINE, issues),
    parseJson(workspace, CONFIRMATION, issues),
    parseJson(workspace, 'analysis/requirements.json', issues), parseJson(workspace, 'analysis/scoring.json', issues),
    parseJson(workspace, 'analysis/compliance.json', issues),
    parseJson(workspace, 'analysis/evidence-map.json', issues),
  ])
  const inputs = [sourceRaw, confirmedRaw, confirmationRaw, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw]
  if (inputs.some(value => value === undefined)) return { ok: false, issues }
  try {
    const source = parseConfirmedOutlineArtifact(sourceRaw)
    const confirmed = parseConfirmedOutlineArtifact(confirmedRaw)
    const confirmation = parseOutlineConfirmationArtifact(confirmationRaw)
    if (confirmation.source_outline_sha256 !== outlineArtifactSha256(source)) reject(issues, 'OUTLINE_CONFIRMATION_SOURCE_HASH_INVALID', 'The confirmation does not match the S4 outline draft.', CONFIRMATION)
    if (confirmation.confirmed_outline_sha256 !== outlineArtifactSha256(confirmed)) reject(issues, 'OUTLINE_CONFIRMATION_CONFIRMED_HASH_INVALID', 'The confirmation does not match the confirmed outline.', CONFIRMATION)
    validateOutlineTree(confirmed.sections, issues)
    validateOutlineReferences(
      confirmed.sections,
      confirmed.global_compliance_ids,
      parseTenderRequirementsArtifact(requirementsRaw),
      parseTenderScoringArtifact(scoringRaw),
      parseTenderComplianceArtifact(complianceRaw),
      issues,
    )
    validateOutlineEvidenceReferences(confirmed.sections, parseEvidenceMapArtifact(evidenceRaw), issues)
  } catch {
    reject(issues, 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', 'The outline-confirmation Artifacts have invalid fields.')
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
