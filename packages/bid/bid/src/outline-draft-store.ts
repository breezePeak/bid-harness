import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { StageValidationIssue } from './control-plane-contract.ts'
import { outlineArtifactSha256, parseOutlineDraft, type OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { applyOutlineEdits, parseOutlineEditOperations, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { validateOutlineDraftForConfirmation } from './outline-confirmation-validator.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** Host workspace paths needed by the draft store without importing the Host entrypoint. */
interface OutlineDraftWorkspace {
  readonly root: string
  readonly sessionRoot: string
}

/** CAS identity and operations required for one S5 mutation. */
export interface OutlineDraftMutationRequest {
  readonly expected_revision: number
  readonly expected_draft_sha256: string
  readonly operations: readonly OutlineEditOperation[]
}

/** CAS identity required for confirmation or regeneration. */
export interface OutlineDraftIdentityRequest {
  readonly expected_revision: number
  readonly expected_draft_sha256: string
}

/** Result of a Host draft mutation without changing stage state. */
export type OutlineDraftMutationResult =
  | { readonly ok: true; readonly value: OutlineDraftView }
  | { readonly ok: false; readonly error: { readonly code: 'BID_OUTLINE_DRAFT_CONFLICT' | 'BID_INVALID_USER_OUTLINE' | 'BID_OUTLINE_DRAFT_PERSIST_FAILED'; readonly message: string; readonly issues?: readonly StageValidationIssue[]; readonly current: OutlineDraftView } }

async function readJson(workspace: OutlineDraftWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.sessionRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8'))
}

/** @param workspace Session Bid workspace. @returns Existing or initialized Host-owned S5 draft. */
export async function getOrCreateOutlineDraft(workspace: OutlineDraftWorkspace): Promise<OutlineDraftView> {
  const source = parseOutlineArtifact(await readJson(workspace, 'outline/outline.json'))
  const sourceHash = outlineArtifactSha256(source)
  const path = within(workspace.sessionRoot, 'outline/draft.json')
  await assertNoLinkedPath(workspace.root, path)
  try {
    const existing = parseOutlineDraft(JSON.parse(await readFile(path, 'utf8')))
    if (existing.source_outline_sha256 === sourceHash) return existing
    const replacement: OutlineDraftView = {
      schema_version: 1, scope: 'technical_bid', revision: existing.revision + 1,
      source_outline_sha256: sourceHash, draft_outline_sha256: sourceHash, outline: source,
    }
    await writeFileAtomic(path, `${JSON.stringify(replacement, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return replacement
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const initial: OutlineDraftView = {
      schema_version: 1, scope: 'technical_bid', revision: 1,
      source_outline_sha256: sourceHash, draft_outline_sha256: sourceHash, outline: source,
    }
    await writeFileAtomic(path, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return initial
  }
}

/**
 * @param workspace Session Bid workspace.
 * @param request CAS identity and edit batch.
 * @returns Persisted draft or a recoverable rejection.
 */
export async function mutateOutlineDraft(
  workspace: OutlineDraftWorkspace,
  request: OutlineDraftMutationRequest,
): Promise<OutlineDraftMutationResult> {
  const current = await getOrCreateOutlineDraft(workspace)
  if (request.expected_revision !== current.revision || request.expected_draft_sha256 !== current.draft_outline_sha256) {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed in another browser.', current } }
  }
  let candidate
  try { candidate = applyOutlineEdits(current.outline, parseOutlineEditOperations(request.operations)) } catch (error) {
    return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: error instanceof Error ? error.message : 'The requested outline edit is invalid.', current } }
  }
  const hash = outlineArtifactSha256(candidate)
  if (hash === current.draft_outline_sha256) return { ok: true, value: current }
  const [requirements, scoring, compliance, evidence, catalog] = await Promise.all([
    readJson(workspace, 'analysis/requirements.json'), readJson(workspace, 'analysis/scoring.json'),
    readJson(workspace, 'analysis/compliance.json'), readJson(workspace, 'analysis/evidence-map.json'),
    readJson(workspace, 'analysis/scoring-response-points.json'),
  ])
  const validation = validateOutlineDraftForConfirmation(candidate, requirements, scoring, compliance, evidence, catalog)
  if (!validation.ok) {
    const candidateIds = new Set(candidate.sections.flatMap(section => section.scoring_response_point_ids ?? []))
    const missingPoint = parseScoringResponsePointCatalog(catalog).points.find(point => !candidateIds.has(point.id))
    const carrier = missingPoint === undefined
      ? undefined
      : current.outline.sections.find(section => section.scoring_response_point_ids?.includes(missingPoint.id))
    const issues = missingPoint === undefined ? validation.issues : [{
      code: 'OUTLINE_CONFIRMATION_RESPONSE_POINT_MISSING',
      message: `${missingPoint.id} (${missingPoint.text}) is uniquely carried by section ${carrier?.id ?? 'unknown'}; the rejected edit would remove that coverage.`,
      artifact: 'outline/draft.json',
    }]
    return { ok: false, error: { code: 'BID_INVALID_USER_OUTLINE', message: 'The edit violates S5 structure or coverage rules.', issues, current } }
  }
  const next: OutlineDraftView = { ...current, revision: current.revision + 1, draft_outline_sha256: hash, outline: candidate }
  const path = within(workspace.sessionRoot, 'outline/draft.json')
  try {
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_PERSIST_FAILED', message: 'The Host could not persist the outline draft.', current } }
  }
  return { ok: true, value: next }
}

/**
 * @param workspace Session Bid workspace.
 * @param request Expected draft identity.
 * @param candidate S4-validated candidate.
 * @returns Persisted replacement or a recoverable rejection.
 */
export async function replaceOutlineDraft(
  workspace: OutlineDraftWorkspace,
  request: OutlineDraftIdentityRequest,
  candidate: ReturnType<typeof parseOutlineArtifact>,
): Promise<OutlineDraftMutationResult> {
  const current = await getOrCreateOutlineDraft(workspace)
  if (request.expected_revision !== current.revision || request.expected_draft_sha256 !== current.draft_outline_sha256) {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', message: 'The outline draft changed during regeneration.', current } }
  }
  const parsed = parseOutlineArtifact(candidate)
  const hash = outlineArtifactSha256(parsed)
  if (hash === current.draft_outline_sha256) return { ok: true, value: current }
  const next: OutlineDraftView = { ...current, revision: current.revision + 1, draft_outline_sha256: hash, outline: parsed }
  const path = within(workspace.sessionRoot, 'outline/draft.json')
  try {
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch {
    return { ok: false, error: { code: 'BID_OUTLINE_DRAFT_PERSIST_FAILED', message: 'The Host could not persist the regenerated outline draft.', current } }
  }
  return { ok: true, value: next }
}
