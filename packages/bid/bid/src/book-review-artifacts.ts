import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Version of the deterministic S7 review report. */
export const BOOK_REVIEW_SCHEMA_VERSION = 2 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const issueSchema = z.object({
  issue_id: z.string().min(1),
  section_id: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(['blocking', 'warning', 'info']),
  status: z.enum(['open', 'resolved', 'dismissed']),
  title: z.string().min(1),
  detail: z.string().min(1),
  suggestion: z.string().min(1),
}).strict()

const chapterSchema = z.object({
  section_id: z.string().min(1),
  content_path: z.string().regex(/^chapters\/sections\/\d{4}\.md$/u),
  content_sha256: sha256Schema,
  status: z.literal('not_evaluated'),
  issue_ids: z.array(z.string().min(1)),
}).strict()

const responsePointCoverageSchema = z.object({
  response_point_id: z.string().regex(/^RP-\d{6}$/u),
  scoring_id: z.string().min(1),
  text: z.string().min(1),
  section_id: z.string().min(1),
  status: z.enum(['covered', 'missing', 'duplicate', 'mismatch']),
}).strict()

/** Strict durable report produced by the S7 program executor. */
export const bookReviewReportSchema = z.object({
  schema_version: z.literal(BOOK_REVIEW_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  review_mode: z.literal('framework_only'),
  quality_gate: z.literal('not_evaluated'),
  confirmed_outline_sha256: sha256Schema,
  chapters: z.array(chapterSchema),
  response_point_coverage: z.array(responsePointCoverageSchema),
  issues: z.array(issueSchema),
  summary: z.object({
    chapter_count: z.number().int().nonnegative(),
    evaluated_chapter_count: z.literal(0),
    issue_count: z.number().int().nonnegative(),
    blocking_issue_count: z.number().int().nonnegative(),
  }).strict(),
  limitations: z.array(z.string().min(1)).min(1),
}).strict()

/** Parsed S7 report. */
export type BookReviewReport = z.infer<typeof bookReviewReportSchema>
/** One generic future review issue. */
export type BookReviewIssue = z.infer<typeof issueSchema>

/** Parse one strict S7 report. */
export function parseBookReviewReport(value: unknown): BookReviewReport {
  return bookReviewReportSchema.parse(value)
}

/** Hash exact UTF-8 chapter content for the immutable S7 review snapshot. */
export function chapterContentSha256(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

/** Explicit limitation carried by every framework-only review report. */
export const DETAILED_REVIEW_NOT_IMPLEMENTED = 'DETAILED_REVIEW_NOT_IMPLEMENTED' as const
/** Scope statement for the deterministic S7 response-point audit. */
export const STRUCTURED_RESPONSE_POINT_COVERAGE_ONLY = 'STRUCTURED_RESPONSE_POINT_COVERAGE_ONLY' as const
