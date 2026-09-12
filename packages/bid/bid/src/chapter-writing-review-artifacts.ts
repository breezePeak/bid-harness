import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Version of an independent Chapter Reviewer report. */
export const CHAPTER_REVIEW_SCHEMA_VERSION = 7 as const

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

const globalComplianceCheckSchema = z.object({
  compliance_id: z.string().min(1),
  item: z.string().min(1),
  status: z.enum(['conforms', 'violates', 'not_applicable']),
  evidence_quotes: z.array(z.string().trim().min(1)),
  issue: z.string().trim().min(1).nullable(),
}).strict()

const acceptanceCriterionResultSchema = z.object({
  criterion_id: z.string().min(1),
  evaluator: z.enum(['semantic', 'deterministic']),
  status: z.enum(['met', 'unmet', 'unavailable']),
  evidence_quotes: z.array(z.string().trim().min(1)),
  measured: z.union([z.number(), z.string()]).nullable(),
  reason: z.string().trim().min(1),
}).strict()

const assignmentConflictSchema = z.object({
  task: z.string().trim().min(1),
  basis: z.string().trim().min(1),
  related_section_ids: z.array(z.string().min(1)),
}).strict()

const externalInputGapSchema = z.object({
  item_ref: z.string().trim().min(1),
  required_material: z.string().trim().min(1),
  reason: z.string().trim().min(1),
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
  verdict: z.enum(['pass', 'repair', 'attention']),
  must_answer_coverage: z.array(coverageSchema),
  requirement_coverage: z.array(identifiedCoverageSchema),
  response_point_coverage: z.array(responsePointCoverageSchema),
  compliance_coverage: z.array(complianceCoverageSchema),
  acceptance_criteria_results: z.array(acceptanceCriterionResultSchema),
  global_compliance_checks: z.array(globalComplianceCheckSchema),
  assignment_conflicts: z.array(assignmentConflictSchema),
  external_input_gaps: z.array(externalInputGapSchema),
  claim_checks: z.array(claimCheckSchema),
  quality_checks: z.object({
    bidder_response_voice: z.boolean(),
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

/**
 * Parse one review conclusion at the model-output boundary.
 * @param value Untrusted structured reviewer output.
 * @returns Strict review result.
 */
export function parseChapterReview(value: unknown): ChapterReview {
  return chapterReviewSchema.parse(value)
}

/**
 * Parse one durable chapter-review record.
 * @param value Untrusted durable reviewer record.
 * @returns Strict review artifact.
 */
export function parseChapterReviewArtifact(value: unknown): ChapterReviewArtifact {
  return chapterReviewArtifactSchema.parse(value)
}

/**
 * Compute the identity recorded for an accepted chapter candidate.
 * @param markdown Accepted chapter Markdown.
 * @returns SHA-256 of its persisted bytes.
 */
export function chapterCandidateSha256(markdown: string): string {
  return createHash('sha256').update(`${markdown.trim()}\n`).digest('hex')
}
