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

/** Browser-safe view of the four S2 artifacts exposed for user confirmation. */
export interface TenderAnalysisConfirmationView {
  readonly project: TenderProjectArtifact
  readonly requirements: TenderRequirementsArtifact
  readonly scoring: TenderScoringArtifact
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

/** Parse untrusted browser operations before they can affect canonical S2 artifacts. */
export function parseTenderAnalysisEditOperations(value: unknown): TenderAnalysisEditOperation[] {
  return z.array(operationSchema).parse(value) as TenderAnalysisEditOperation[]
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
  return { project, requirements, scoring, compliance }
}
