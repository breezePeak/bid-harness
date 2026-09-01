import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact, parseOutlineConfirmationArtifact, parseOutlineDraft } from './outline-confirmation-artifacts.ts'
import type { OutlineConfirmationIssueCode } from './outline-confirmation-issues.ts'
import { validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const CONFIRMED_OUTLINE = 'outline/confirmed-outline.json'
const CONFIRMATION = 'outline/confirmation.json'
const SOURCE_OUTLINE = 'outline/outline.json'
const DRAFT = 'outline/draft.json'

function reject(issues: StageValidationIssue[], code: OutlineConfirmationIssueCode, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch { reject(issues, 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', 'A required S5 Artifact is missing or invalid.', path) }
}

/** Validate one S5 draft with shared structure and coverage rules only. */
export function validateOutlineDraftForConfirmation(
  outlineRaw: unknown,
  requirementsRaw: unknown,
  scoringRaw: unknown,
  complianceRaw: unknown,
  evidenceRaw: unknown,
  catalogRaw: unknown,
): StageValidationResult {
  const issues: StageValidationIssue[] = []
  try {
    const outline = parseConfirmedOutlineArtifact(outlineRaw)
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(
      outline,
      parseTenderRequirementsArtifact(requirementsRaw), parseTenderScoringArtifact(scoringRaw),
      parseTenderComplianceArtifact(complianceRaw), parseEvidenceMapArtifact(evidenceRaw),
      parseScoringResponsePointCatalog(catalogRaw), issues,
    )
  } catch { reject(issues, 'OUTLINE_CONFIRMATION_DRAFT_INVALID', 'The outline draft or required analysis Artifacts are invalid.', DRAFT) }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

/** Backward-compatible name for callers validating an in-memory S5 candidate. */
export const validateConfirmedOutline = validateOutlineDraftForConfirmation

/** Validate S5 persistence, hashes, revision binding, shared structure, and coverage. */
export async function validateOutlineConfirmation(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'outline_confirmation') reject(issues, 'OUTLINE_CONFIRMATION_STAGE_INVALID', 'The S5 validator only accepts outline_confirmation.')
  const expected = new Map([[CONFIRMED_OUTLINE, 'confirmed_outline'], [CONFIRMATION, 'outline_confirmation']])
  if (artifacts.length !== expected.size || artifacts.some(artifact => artifact.stage !== 'outline_confirmation' || expected.get(artifact.path) !== artifact.type)
    || new Set(artifacts.map(artifact => artifact.path)).size !== expected.size) reject(issues, 'OUTLINE_CONFIRMATION_ARTIFACT_SET_INVALID', 'S5 must return confirmed-outline.json and confirmation.json exactly once.')
  const values = await Promise.all([
    parseJson(workspace, SOURCE_OUTLINE, issues), parseJson(workspace, DRAFT, issues),
    parseJson(workspace, CONFIRMED_OUTLINE, issues), parseJson(workspace, CONFIRMATION, issues),
    parseJson(workspace, 'analysis/requirements.json', issues), parseJson(workspace, 'analysis/scoring.json', issues),
    parseJson(workspace, 'analysis/compliance.json', issues), parseJson(workspace, 'analysis/evidence-map.json', issues),
    parseJson(workspace, 'analysis/scoring-response-points.json', issues),
  ])
  if (values.some(value => value === undefined)) return { ok: false, issues }
  try {
    const [sourceRaw, draftRaw, confirmedRaw, confirmationRaw, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw, catalogRaw] = values
    const source = parseConfirmedOutlineArtifact(sourceRaw)
    const draft = parseOutlineDraft(draftRaw)
    const confirmed = parseConfirmedOutlineArtifact(confirmedRaw)
    const confirmation = parseOutlineConfirmationArtifact(confirmationRaw)
    const sourceHash = outlineArtifactSha256(source)
    const draftHash = outlineArtifactSha256(draft.outline)
    const confirmedHash = outlineArtifactSha256(confirmed)
    if (draft.source_outline_sha256 !== sourceHash || confirmation.source_outline_sha256 !== sourceHash) reject(issues, 'OUTLINE_CONFIRMATION_SOURCE_HASH_INVALID', 'S5 lineage does not match the current S4 outline.', CONFIRMATION)
    if (draft.draft_outline_sha256 !== draftHash || confirmation.confirmed_draft_sha256 !== draftHash) reject(issues, 'OUTLINE_CONFIRMATION_DRAFT_HASH_INVALID', 'S5 draft hash does not match the persisted draft.', DRAFT)
    if (confirmation.confirmed_outline_sha256 !== confirmedHash || confirmedHash !== draftHash) reject(issues, 'OUTLINE_CONFIRMATION_CONFIRMED_HASH_INVALID', 'Confirmed outline bytes must match the current draft.', CONFIRMATION)
    if (confirmation.confirmed_draft_revision !== draft.revision) reject(issues, 'OUTLINE_CONFIRMATION_DRAFT_HASH_INVALID', 'Confirmation revision does not match the current draft.', CONFIRMATION)
    const shared = validateOutlineDraftForConfirmation(confirmed, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw, catalogRaw)
    if (!shared.ok) issues.push(...shared.issues)
  } catch { reject(issues, 'OUTLINE_CONFIRMATION_ARTIFACT_INVALID', 'The S5 Artifacts have invalid fields.') }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
