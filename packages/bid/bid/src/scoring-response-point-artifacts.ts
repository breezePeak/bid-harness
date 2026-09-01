import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'

/** Version of the Host-owned stable scoring response-point catalog. */
export const SCORING_RESPONSE_POINT_CATALOG_SCHEMA_VERSION = 1 as const

const pointSchema = z.object({
  id: z.string().regex(/^RP-\d{6}$/u),
  scoring_id: z.string().min(1),
  order: z.number().int().positive(),
  text: z.string().trim().min(1),
}).strict()

const catalogSchema = z.object({
  schema_version: z.literal(SCORING_RESPONSE_POINT_CATALOG_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  scoring_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  next_sequence: z.number().int().positive(),
  points: z.array(pointSchema),
}).strict()

/** One stable response point owned by the Host. */
export type ScoringResponsePoint = z.infer<typeof pointSchema>
/** Stable response-point identity projected beside the S2 scoring Artifact. */
export type ScoringResponsePointCatalog = z.infer<typeof catalogSchema>

/** @param value Decoded catalog JSON. @returns A strict scoring response-point catalog. */
export function parseScoringResponsePointCatalog(value: unknown): ScoringResponsePointCatalog {
  return catalogSchema.parse(value)
}

/** @param scoring Canonical scoring Artifact. @returns SHA-256 of its persisted JSON bytes. */
export function scoringArtifactSha256(scoring: TenderScoringArtifact): string {
  return createHash('sha256').update(`${JSON.stringify(scoring, null, 2)}\n`).digest('hex')
}

/** @param scoring Canonical scoring Artifact. @returns Initial Host-owned response-point catalog. */
export function createScoringResponsePointCatalog(scoring: TenderScoringArtifact): ScoringResponsePointCatalog {
  let next = 0
  const points = scoring.scoring_items.flatMap(item => item.response_points.map((text, index) => ({
    id: `RP-${String(++next).padStart(6, '0')}`,
    scoring_id: item.id,
    order: index + 1,
    text,
  })))
  return {
    schema_version: SCORING_RESPONSE_POINT_CATALOG_SCHEMA_VERSION,
    scope: 'technical_bid',
    scoring_sha256: scoringArtifactSha256(scoring),
    next_sequence: next + 1,
    points,
  }
}

/**
 * @param catalog Stable response-point catalog.
 * @param scoring Canonical scoring Artifact.
 * @returns Whether identity, ordering, and text agree exactly.
 */
export function catalogMatchesScoring(
  catalog: ScoringResponsePointCatalog,
  scoring: TenderScoringArtifact,
): boolean {
  if (catalog.scoring_sha256 !== scoringArtifactSha256(scoring)) return false
  if (new Set(catalog.points.map(point => point.id)).size !== catalog.points.length) return false
  const expected = scoring.scoring_items.flatMap(item => item.response_points.map((text, index) => ({
    scoring_id: item.id,
    order: index + 1,
    text,
  })))
  return expected.length === catalog.points.length && expected.every((point, index) => {
    const actual = catalog.points[index]
    return actual !== undefined && actual.scoring_id === point.scoring_id
      && actual.order === point.order && actual.text === point.text
  })
}

/** @param catalog Current response-point catalog. @returns Its next monotonically increasing point id. */
export function nextResponsePointId(catalog: ScoringResponsePointCatalog): string {
  return `RP-${String(catalog.next_sequence).padStart(6, '0')}`
}
