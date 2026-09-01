import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Version of an independent Chapter Reviewer report. */
export const CHAPTER_REVIEW_SCHEMA_VERSION = 1 as const

const coverageSchema = z.object({
  item: z.string().min(1),
  status: z.enum(['covered', 'missing']),
  evidence_quotes: z.array(z.string().trim().min(1)),
  issue: z.string().min(1).nullable(),
}).strict()

const identifiedCoverageSchema = coverageSchema.extend({
  requirement_id: z.string().min(1),
}).strict()

const responsePointCoverageSchema = coverageSchema.extend({
  response_point_id: z.string().regex(/^RP-\d{6}$/u),
}).strict()

const complianceCoverageSchema = coverageSchema.extend({
  compliance_id: z.string().min(1),
}).strict()

const sourceMappingReviewSchema = z.object({
  mapping_id: z.string().min(1),
  status: z.enum(['used', 'not_used']),
  evidence_quotes: z.array(z.string().trim().min(1)),
  issue: z.string().min(1).nullable(),
}).strict()

const claimCheckSchema = z.object({
  claim_quote: z.string().trim().min(1),
  kind: z.enum(['project_fact', 'technical_fact', 'commitment']),
  status: z.enum(['supported', 'unsupported']),
  source_reference: z.string().min(1).nullable(),
  issue: z.string().min(1).nullable(),
}).strict()

/** Strict structured result returned by the isolated Chapter Reviewer Child. */
export const chapterReviewSchema = z.object({
  schema_version: z.literal(CHAPTER_REVIEW_SCHEMA_VERSION),
  section_id: z.string().min(1),
  verdict: z.enum(['pass', 'repair']),
  must_answer_coverage: z.array(coverageSchema),
  requirement_coverage: z.array(identifiedCoverageSchema),
  response_point_coverage: z.array(responsePointCoverageSchema),
  compliance_coverage: z.array(complianceCoverageSchema),
  source_mapping_review: z.array(sourceMappingReviewSchema),
  claim_checks: z.array(claimCheckSchema),
  quality_checks: z.object({
    content_mode_respected: z.boolean(),
    project_specific: z.boolean(),
    structure_complete: z.boolean(),
    legacy_project_pollution_free: z.boolean(),
    placeholder_free: z.boolean(),
    obvious_repetition_free: z.boolean(),
  }).strict(),
  blocking_issues: z.array(z.string().trim().min(1)),
}).strict()

/** Persisted reviewer report bound to the accepted chapter bytes. */
export const chapterReviewArtifactSchema = chapterReviewSchema.extend({
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  writer_child_session_id: z.string().min(1),
  reviewer_child_session_id: z.string().min(1),
}).strict()

/** Parsed review conclusion. */
export type ChapterReview = z.infer<typeof chapterReviewSchema>
/** Parsed durable review record. */
export type ChapterReviewArtifact = z.infer<typeof chapterReviewArtifactSchema>

/** @param value Untrusted structured reviewer output. @returns Strict review result. */
export function parseChapterReview(value: unknown): ChapterReview {
  return chapterReviewSchema.parse(value)
}

/** @param value Untrusted durable reviewer record. @returns Strict review artifact. */
export function parseChapterReviewArtifact(value: unknown): ChapterReviewArtifact {
  return chapterReviewArtifactSchema.parse(value)
}

/** @param markdown Accepted chapter Markdown. @returns SHA-256 of its persisted bytes. */
export function chapterCandidateSha256(markdown: string): string {
  return createHash('sha256').update(`${markdown.trim()}\n`).digest('hex')
}
