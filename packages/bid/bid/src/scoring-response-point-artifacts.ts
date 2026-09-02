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

const candidateSchema = z.object({
  schema_version: z.literal(SCORING_RESPONSE_POINT_CATALOG_SCHEMA_VERSION),
  points: z.array(z.object({
    scoring_id: z.string().min(1),
    order: z.number().int().positive(),
    text: z.string().trim().min(1),
  }).strict()),
}).strict()

/** One stable response point owned by the Host. */
export type ScoringResponsePoint = z.infer<typeof pointSchema>
/** Stable response-point identity projected beside the S2 scoring Artifact. */
export type ScoringResponsePointCatalog = z.infer<typeof catalogSchema>
/** S3 Agent analysis before the Host assigns stable response-point ids. */
export type ScoringResponsePointCandidate = z.infer<typeof candidateSchema>

/** @param value Decoded catalog JSON. @returns A strict scoring response-point catalog. */
export function parseScoringResponsePointCatalog(value: unknown): ScoringResponsePointCatalog {
  return catalogSchema.parse(value)
}

/** @param value Decoded S3 candidate JSON. @returns Strict response-point candidates. */
export function parseScoringResponsePointCandidate(value: unknown): ScoringResponsePointCandidate {
  return candidateSchema.parse(value)
}

/** @param scoring Canonical scoring Artifact. @returns SHA-256 of its persisted JSON bytes. */
export function scoringArtifactSha256(scoring: TenderScoringArtifact): string {
  return createHash('sha256').update(`${JSON.stringify(scoring, null, 2)}\n`).digest('hex')
}

/**
 * Assign stable ids to one S3 Agent analysis.
 * @param scoring Canonical S2 scoring Artifact.
 * @param candidate S3 response-point candidates ordered within each scoring item.
 * @returns Initial Host-owned response-point catalog.
 */
export function createScoringResponsePointCatalog(
  scoring: TenderScoringArtifact,
  candidate: ScoringResponsePointCandidate,
): ScoringResponsePointCatalog {
  const scoringIds = new Set(scoring.scoring_items.map(item => item.id))
  if (candidate.points.some(point => !scoringIds.has(point.scoring_id))) throw new Error('scoring-response-point-candidate-unknown-scoring')
  for (const scoringId of scoringIds) {
    const points = candidate.points.filter(point => point.scoring_id === scoringId)
    if (points.length === 0 || points.some((point, index) => point.order !== index + 1)) {
      throw new Error('scoring-response-point-candidate-order-invalid')
    }
  }
  let next = 0
  const points = candidate.points.map(point => ({
    id: `RP-${String(++next).padStart(6, '0')}`,
    ...point,
  }))
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
 * @returns Whether the catalog belongs to the scoring Artifact and has valid identities and per-item ordering.
 */
export function catalogMatchesScoring(
  catalog: ScoringResponsePointCatalog,
  scoring: TenderScoringArtifact,
): boolean {
  if (catalog.scoring_sha256 !== scoringArtifactSha256(scoring)) return false
  if (new Set(catalog.points.map(point => point.id)).size !== catalog.points.length) return false
  const scoringIds = new Set(scoring.scoring_items.map(item => item.id))
  if (catalog.points.some(point => !scoringIds.has(point.scoring_id))) return false
  for (const scoringId of scoringIds) {
    const points = catalog.points.filter(point => point.scoring_id === scoringId)
    if (points.some((point, index) => point.order !== index + 1)) return false
  }
  const maxSequence = catalog.points.reduce((max, point) => Math.max(max, Number(point.id.slice(3))), 0)
  return catalog.next_sequence > maxSequence
}

/** @param catalog Current response-point catalog. @returns Its next monotonically increasing point id. */
export function nextResponsePointId(catalog: ScoringResponsePointCatalog): string {
  return `RP-${String(catalog.next_sequence).padStart(6, '0')}`
}
