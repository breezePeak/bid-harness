import { z } from 'zod'

/** Version of the document-level S5 global-compliance review. */
export const GLOBAL_COMPLIANCE_REVIEW_SCHEMA_VERSION = 1 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

const checkedChapterSchema = z.object({
  section_id: z.string().min(1),
  candidate_sha256: sha256Schema,
}).strict()

const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chapter_quote'),
    section_id: z.string().min(1),
    quote: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('material'),
    file_id: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(['tender', 'outline_framework', 'reference_bid', 'reference']),
  }).strict(),
])

const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chapter'), section_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('document') }).strict(),
  z.object({ kind: z.literal('delivery') }).strict(),
])

/** One global requirement with its semantic owner, conclusion, and current evidence. */
export const globalComplianceReviewItemSchema = z.object({
  compliance_id: z.string().min(1),
  item: z.string().min(1),
  category: z.enum(['cross_chapter_constraint', 'document_requirement', 'delivery_requirement']),
  owners: z.array(ownerSchema).min(1),
  status: z.enum(['pass', 'fail', 'pending', 'not_applicable']),
  checked_chapters: z.array(checkedChapterSchema),
  evidence: z.array(evidenceSchema),
  affected_section_ids: z.array(z.string().min(1)),
  issue: z.string().trim().min(1).nullable(),
}).strict()

/** Durable document-level S5 global-compliance record. */
export const globalComplianceReviewArtifactSchema = z.object({
  schema_version: z.literal(GLOBAL_COMPLIANCE_REVIEW_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  confirmed_outline_sha256: sha256Schema,
  items: z.array(globalComplianceReviewItemSchema),
}).strict()

/** Parsed result for one global requirement. */
export type GlobalComplianceReviewItem = z.infer<typeof globalComplianceReviewItemSchema>
/** Parsed durable document-level review. */
export type GlobalComplianceReviewArtifact = z.infer<typeof globalComplianceReviewArtifactSchema>

/**
 * Parse a document-level global-compliance record.
 * @param value Untrusted JSON value.
 * @returns Strict current-version record.
 */
export function parseGlobalComplianceReviewArtifact(value: unknown): GlobalComplianceReviewArtifact {
  return globalComplianceReviewArtifactSchema.parse(value)
}
