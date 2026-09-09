import { z } from 'zod'
import {
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  type TenderComplianceArtifact,
  type TenderProjectArtifact,
  type TenderRequirementsArtifact,
  type TenderScoringArtifact,
} from './tender-analysis-artifacts.ts'

const text = z.string().trim().min(1)
const textList = z.array(text)
const nullableText = z.preprocess(
  value => typeof value === 'string' && value.trim().length === 0 ? null : value,
  z.union([text, z.null()]),
)
const projectFields = z.object({
  project_name: nullableText.optional(),
  tender_name: nullableText.optional(),
  purchaser: nullableText.optional(),
  owner: nullableText.optional(),
  project_background: textList.optional(),
  project_objectives: textList.optional(),
  project_scope: textList.optional(),
  technical_scope: textList.optional(),
  delivery_scope: textList.optional(),
  implementation_constraints: textList.optional(),
  key_technical_points: textList.optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'update_project requires at least one field' })

const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_project'), fields: projectFields }).strict(),
  z.object({ type: z.literal('update_requirement'), requirement_id: text, fields: z.object({
    category: text.optional(), normalized_requirement: text.optional(), mandatory: z.boolean().optional(),
  }).strict().refine(value => Object.keys(value).length > 0, { message: 'update_requirement requires at least one field' }) }).strict(),
  z.object({ type: z.literal('update_scoring_item'), scoring_id: text, fields: z.object({
    title: text.optional(), criterion: text.optional(), must_answer: z.boolean().optional(),
  }).strict().refine(value => Object.keys(value).length > 0, { message: 'update_scoring_item requires at least one field' }) }).strict(),
  z.object({ type: z.literal('update_compliance'), compliance_id: text, fields: z.object({
    type: text.optional(), normalized_rule: text.optional(), severity: z.enum(['fatal', 'mandatory', 'warning']).optional(),
  }).strict().refine(value => Object.keys(value).length > 0, { message: 'update_compliance requires at least one field' }) }).strict(),
])

const selectionSchema = z.object({
  schema_version: z.literal(1),
  selected_scoring_ids: z.array(text).refine(ids => new Set(ids).size === ids.length, {
    message: 'selected_scoring_ids must be unique',
  }),
}).strict()

/** Persistent S2 user decisions kept separate from tender scoring facts. */
export type TenderScoringSelectionArtifact = z.infer<typeof selectionSchema>

/** Browser-safe view of the S2 facts and persisted scoring selection. */
export interface TenderAnalysisConfirmationView {
  readonly project: TenderProjectArtifact
  readonly requirements: TenderRequirementsArtifact
  /** Complete scoring facts from analysis/scoring-origin.json. */
  readonly scoring: TenderScoringArtifact
  /** Scoring ids currently selected for the downstream response workflow. */
  readonly selected_scoring_ids: readonly string[]
  readonly compliance: TenderComplianceArtifact
}

/** Host-controlled edit operation for normalized S2 conclusions, never cited tender text. */
export type TenderAnalysisEditOperation =
  | {
    readonly type: 'update_project'
    readonly fields: Partial<Pick<TenderProjectArtifact,
    | 'project_name' | 'tender_name' | 'purchaser' | 'owner'
    | 'project_background' | 'project_objectives' | 'project_scope' | 'technical_scope'
    | 'delivery_scope' | 'implementation_constraints' | 'key_technical_points'>>
  }
  | {
    readonly type: 'update_requirement'
    readonly requirement_id: string
    readonly fields: Partial<Pick<TenderRequirementsArtifact['requirements'][number], 'category' | 'normalized_requirement' | 'mandatory'>>
  }
  | {
    readonly type: 'update_scoring_item'
    readonly scoring_id: string
    readonly fields: Partial<Pick<TenderScoringArtifact['scoring_items'][number], 'title' | 'criterion' | 'must_answer'>>
  }
  | {
    readonly type: 'update_compliance'
    readonly compliance_id: string
    readonly fields: Partial<Pick<TenderComplianceArtifact['compliance_items'][number], 'type' | 'normalized_rule' | 'severity'>>
  }

/**
 * Parse untrusted browser operations before they can affect canonical S2 artifacts.
 * @param value Untrusted browser operation list.
 * @returns Validated tender-analysis edit operations.
 */
export function parseTenderAnalysisEditOperations(value: unknown): TenderAnalysisEditOperation[] {
  return z.array(operationSchema).parse(value) as TenderAnalysisEditOperation[]
}

/**
 * Create the default all-selected S2 decision record.
 * @param scoring Complete original scoring facts.
 * @returns Persistent selection in original item order.
 */
export function createTenderScoringSelection(scoring: TenderScoringArtifact): TenderScoringSelectionArtifact {
  return { schema_version: 1, selected_scoring_ids: scoring.scoring_items.map(item => item.id) }
}

/**
 * Parse a persisted selection and reject ids absent from the original scoring facts.
 * @param value Candidate persisted JSON value.
 * @param scoring Complete original scoring facts.
 * @returns Validated selection ordered like the original scoring items.
 */
export function parseTenderScoringSelection(
  value: unknown,
  scoring: TenderScoringArtifact,
): TenderScoringSelectionArtifact {
  const parsed = selectionSchema.parse(value)
  const selected = new Set(parsed.selected_scoring_ids)
  const known = new Set(scoring.scoring_items.map(item => item.id))
  const unknown = parsed.selected_scoring_ids.find(id => !known.has(id))
  if (unknown !== undefined) throw new Error(`unknown tender scoring selection ${JSON.stringify(unknown)}`)
  return {
    schema_version: 1,
    selected_scoring_ids: scoring.scoring_items.filter(item => selected.has(item.id)).map(item => item.id),
  }
}

/**
 * Change one user selection without changing scoring facts or must_answer.
 * @param source Current Host confirmation view.
 * @param scoringId Stable scoring item id.
 * @param selected Whether the item enters the downstream response workflow.
 * @returns Updated view with a canonical selection order.
 */
export function setTenderScoringSelection(
  source: TenderAnalysisConfirmationView,
  scoringId: string,
  selected: boolean,
): TenderAnalysisConfirmationView {
  if (!source.scoring.scoring_items.some(item => item.id === scoringId)) {
    throw new Error(`unknown tender scoring item ${JSON.stringify(scoringId)}`)
  }
  const ids = new Set(source.selected_scoring_ids)
  if (selected) ids.add(scoringId)
  else ids.delete(scoringId)
  return {
    ...source,
    selected_scoring_ids: source.scoring.scoring_items.filter(item => ids.has(item.id)).map(item => item.id),
  }
}

/**
 * Build the sole downstream scoring Artifact from the original facts and user selection.
 * @param source Current Host confirmation view after allowed normalization edits.
 * @returns Selected scoring items with stable ids and original order.
 */
export function createConfirmedTenderScoring(source: TenderAnalysisConfirmationView): TenderScoringArtifact {
  const selected = new Set(source.selected_scoring_ids)
  return parseTenderScoringArtifact({
    ...source.scoring,
    scoring_items: source.scoring.scoring_items.filter(item => selected.has(item.id)),
  })
}

/**
 * Apply normalized S2 edits while preserving ids, tender source text, citations, and file coverage.
 * @param source Current canonical S2 artifacts.
 * @param operations Runtime-validated browser edit operations.
 * @returns Strictly parsed replacement artifacts.
 */
export function applyTenderAnalysisEdits(
  source: TenderAnalysisConfirmationView,
  operations: readonly TenderAnalysisEditOperation[],
): TenderAnalysisConfirmationView {
  let project = structuredClone(source.project)
  let requirements = structuredClone(source.requirements)
  let scoring = structuredClone(source.scoring)
  let compliance = structuredClone(source.compliance)
  for (const operation of operations) {
    if (operation.type === 'update_project') {
      project = parseTenderProjectArtifact({ ...project, ...operation.fields })
      continue
    }
    if (operation.type === 'update_requirement') {
      const index = requirements.requirements.findIndex(item => item.id === operation.requirement_id)
      const current = requirements.requirements[index]
      if (current === undefined) throw new Error(`unknown tender requirement ${JSON.stringify(operation.requirement_id)}`)
      const items = [...requirements.requirements]
      items[index] = { ...current, ...operation.fields }
      requirements = parseTenderRequirementsArtifact({ ...requirements, requirements: items })
      continue
    }
    if (operation.type === 'update_scoring_item') {
      const index = scoring.scoring_items.findIndex(item => item.id === operation.scoring_id)
      const current = scoring.scoring_items[index]
      if (current === undefined) throw new Error(`unknown tender scoring item ${JSON.stringify(operation.scoring_id)}`)
      const items = [...scoring.scoring_items]
      items[index] = { ...current, ...operation.fields }
      scoring = parseTenderScoringArtifact({ ...scoring, scoring_items: items })
      continue
    }
    const index = compliance.compliance_items.findIndex(item => item.id === operation.compliance_id)
    const current = compliance.compliance_items[index]
    if (current === undefined) throw new Error(`unknown tender compliance item ${JSON.stringify(operation.compliance_id)}`)
    const items = [...compliance.compliance_items]
    items[index] = { ...current, ...operation.fields }
    compliance = parseTenderComplianceArtifact({ ...compliance, compliance_items: items })
  }
  return { project, requirements, scoring, selected_scoring_ids: [...source.selected_scoring_ids], compliance }
}
