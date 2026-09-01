import { z } from 'zod'
import {
  parseTenderProjectArtifact,
  parseTenderScoringArtifact,
  type TenderProjectArtifact,
  type TenderScoringArtifact,
} from './tender-analysis-artifacts.ts'
import {
  nextResponsePointId,
  scoringArtifactSha256,
  type ScoringResponsePointCatalog,
} from './scoring-response-point-artifacts.ts'

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
  z.object({
    type: z.literal('update_scoring_item'),
    scoring_id: text,
    title: text.optional(),
    criterion: text.optional(),
  }).strict().refine(
    value => value.title !== undefined || value.criterion !== undefined,
    { message: 'update_scoring_item requires at least one editable field' },
  ),
  z.object({ type: z.literal('update_response_point'), scoring_id: text, response_point_id: text, text }).strict(),
  z.object({ type: z.literal('add_response_point'), scoring_id: text, order: z.number().int().positive(), text }).strict(),
  z.object({ type: z.literal('delete_response_point'), scoring_id: text, response_point_id: text }).strict(),
  z.object({ type: z.literal('move_response_point'), scoring_id: text, response_point_id: text, order: z.number().int().positive() }).strict(),
])

/** Browser-safe view of the two S2 artifacts exposed for user confirmation. */
export interface TenderAnalysisConfirmationView {
  readonly project: TenderProjectArtifact
  readonly scoring: TenderScoringArtifact
  readonly response_point_catalog: ScoringResponsePointCatalog
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
  }
  | { readonly type: 'update_response_point'; readonly scoring_id: string; readonly response_point_id: string; readonly text: string }
  | { readonly type: 'add_response_point'; readonly scoring_id: string; readonly order: number; readonly text: string }
  | { readonly type: 'delete_response_point'; readonly scoring_id: string; readonly response_point_id: string }
  | { readonly type: 'move_response_point'; readonly scoring_id: string; readonly response_point_id: string; readonly order: number }

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
    if (operation.type !== 'update_scoring_item') continue
    const items = [...scoring.scoring_items]
    const current = items[index]
    if (current === undefined) throw new Error('tender scoring item disappeared during edit')
    items[index] = {
      ...current,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.criterion === undefined ? {} : { criterion: operation.criterion }),
    }
    scoring = parseTenderScoringArtifact({ ...scoring, scoring_items: items })
  }
  let points = source.response_point_catalog.points.map(point => ({ ...point }))
  let nextSequence = source.response_point_catalog.next_sequence
  for (const operation of operations) {
    if (operation.type === 'update_project' || operation.type === 'update_scoring_item') continue
    const scoringItem = scoring.scoring_items.find(item => item.id === operation.scoring_id)
    if (scoringItem === undefined) throw new Error(`unknown tender scoring item ${JSON.stringify(operation.scoring_id)}`)
    if (operation.type === 'add_response_point') {
      points.push({
        id: nextResponsePointId({ ...source.response_point_catalog, next_sequence: nextSequence, points }),
        scoring_id: operation.scoring_id,
        order: operation.order,
        text: operation.text.trim(),
      })
      nextSequence += 1
    } else {
      const point = points.find(item => item.id === operation.response_point_id && item.scoring_id === operation.scoring_id)
      if (point === undefined) throw new Error(`unknown scoring response point ${JSON.stringify(operation.response_point_id)}`)
      if (operation.type === 'delete_response_point') points = points.filter(item => item.id !== point.id)
      else if (operation.type === 'update_response_point') point.text = operation.text.trim()
      else point.order = operation.order
    }
    const siblings = points.filter(point => point.scoring_id === operation.scoring_id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    siblings.forEach((point, index) => { point.order = index + 1 })
  }
  const items = scoring.scoring_items.map(item => ({
    ...item,
    response_points: points.filter(point => point.scoring_id === item.id)
      .sort((left, right) => left.order - right.order).map(point => point.text),
  }))
  scoring = parseTenderScoringArtifact({ ...scoring, scoring_items: items })
  const orderedPoints = scoring.scoring_items.flatMap(item => points.filter(point => point.scoring_id === item.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)))
  const catalog: ScoringResponsePointCatalog = {
    ...source.response_point_catalog,
    scoring_sha256: scoringArtifactSha256(scoring),
    next_sequence: nextSequence,
    points: orderedPoints,
  }
  return { project, scoring, response_point_catalog: catalog }
}
