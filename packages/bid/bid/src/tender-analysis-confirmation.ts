import { z } from 'zod'
import {
  parseTenderProjectArtifact,
  parseTenderScoringArtifact,
  type TenderProjectArtifact,
  type TenderScoringArtifact,
} from './tender-analysis-artifacts.ts'

const text = z.string().trim().min(1)
const textList = z.array(text)
const projectFields = z.object({
  project_name: text.optional(),
  tender_name: text.optional(),
  purchaser: text.optional(),
  owner: text.optional(),
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
  z.object({
    type: z.literal('update_scoring_item'),
    scoring_id: text,
    title: text.optional(),
    criterion: text.optional(),
    response_points: textList.min(1).optional(),
  }).strict().refine(
    value => value.title !== undefined || value.criterion !== undefined || value.response_points !== undefined,
    { message: 'update_scoring_item requires at least one editable field' },
  ),
])

/** Browser-safe view of the two S2 artifacts exposed for user confirmation. */
export interface TenderAnalysisConfirmationView {
  readonly project: TenderProjectArtifact
  readonly scoring: TenderScoringArtifact
}

/** Host-controlled edit operation for analysis conclusions, never source truth. */
export type TenderAnalysisEditOperation =
  | {
    readonly type: 'update_project'
    readonly fields: Partial<Pick<TenderProjectArtifact,
      | 'project_name' | 'tender_name' | 'purchaser' | 'owner'
      | 'project_background' | 'project_objectives' | 'project_scope' | 'technical_scope'
      | 'delivery_scope' | 'implementation_constraints' | 'key_technical_points'>>
  }
  | {
    readonly type: 'update_scoring_item'
    readonly scoring_id: string
    readonly title?: string
    readonly criterion?: string
    readonly response_points?: string[]
  }

/** Parse untrusted browser operations before they can affect canonical S2 artifacts. */
export function parseTenderAnalysisEditOperations(value: unknown): TenderAnalysisEditOperation[] {
  return z.array(operationSchema).parse(value) as TenderAnalysisEditOperation[]
}

/**
 * Apply the allowed analysis edits while preserving scoring ids, tender facts, citations, and file coverage.
 * @param source Current canonical S2 project and scoring artifacts.
 * @param operations Runtime-validated browser edit operations.
 * @returns Strictly parsed replacement artifacts.
 */
export function applyTenderAnalysisEdits(
  source: TenderAnalysisConfirmationView,
  operations: readonly TenderAnalysisEditOperation[],
): TenderAnalysisConfirmationView {
  let project: TenderProjectArtifact = structuredClone(source.project)
  let scoring: TenderScoringArtifact = structuredClone(source.scoring)
  for (const operation of operations) {
    if (operation.type === 'update_project') {
      project = parseTenderProjectArtifact({ ...project, ...operation.fields })
      continue
    }
    const index = scoring.scoring_items.findIndex(item => item.id === operation.scoring_id)
    if (index < 0) throw new Error(`unknown tender scoring item ${JSON.stringify(operation.scoring_id)}`)
    const items = [...scoring.scoring_items]
    const current = items[index]
    if (current === undefined) throw new Error('tender scoring item disappeared during edit')
    items[index] = {
      ...current,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.criterion === undefined ? {} : { criterion: operation.criterion }),
      ...(operation.response_points === undefined ? {} : { response_points: [...operation.response_points] }),
    }
    scoring = parseTenderScoringArtifact({ ...scoring, scoring_items: items })
  }
  return { project, scoring }
}
