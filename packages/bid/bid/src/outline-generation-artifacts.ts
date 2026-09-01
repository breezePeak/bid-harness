import { z } from 'zod'

/** Version of the technical-writing blueprint Artifact. */
export const OUTLINE_GENERATION_SCHEMA_VERSION = 2 as const

/** Version of the internal Blueprint Quality Review record. */
export const OUTLINE_QUALITY_REPORT_SCHEMA_VERSION = 2 as const

/** Strict schema shared by generated and user-confirmed technical-bid sections. */
export const outlineSectionSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
  order: z.number().int().positive(),
  level: z.number().int().positive(),
  title: z.string().min(1),
  purpose: z.string().min(1),
  writable: z.boolean(),
  must_answer: z.array(z.string().min(1)),
  requirement_ids: z.array(z.string().min(1)),
  scoring_ids: z.array(z.string().min(1)),
  compliance_ids: z.array(z.string().min(1)),
  origin: z.enum(['framework', 'reference_bid', 'generated', 'mixed']),
  content_mode: z.enum(['preserve_and_complete', 'adapt_and_rewrite', 'write_new']).nullable(),
  source_mapping_ids: z.array(z.string().min(1)),
  scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)).optional(),
  scoring_response_points: z.array(z.object({ scoring_id: z.string().min(1), response_point: z.string().min(1) }).strict()),
  suggested_tables: z.array(z.string().min(1)),
  suggested_figures: z.array(z.string().min(1)),
  writing_notes: z.array(z.string().min(1)),
}).strict().superRefine((section, context) => {
  if (section.writable && section.must_answer.length === 0) {
    context.addIssue({ code: 'custom', message: 'a writable section requires must_answer' })
  }
  if (!section.writable && section.must_answer.length !== 0) {
    context.addIssue({ code: 'custom', message: 'a structural section cannot have must_answer' })
  }
})

/** Strict schema shared by generated and user-confirmed technical-bid outlines. */
export const outlineArtifactSchema = z.object({
  schema_version: z.literal(OUTLINE_GENERATION_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  document_title: z.string().min(1),
  global_compliance_ids: z.array(z.string().min(1)),
  sections: z.array(outlineSectionSchema).min(1),
}).strict()

/** Strict record of the mandatory quality review performed after S4 drafting. */
export const outlineQualityReportSchema = z.object({
  schema_version: z.literal(OUTLINE_QUALITY_REPORT_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  checked_requirement_ids: z.array(z.string().min(1)),
  checked_scoring_ids: z.array(z.string().min(1)),
  checked_source_mapping_ids: z.array(z.string().min(1)),
  checked_scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  reviewed_section_ids: z.array(z.string().min(1)),
  issues: z.array(z.string().min(1)),
}).strict()

/** One independently writable or structural node in a technical bid outline. */
export type OutlineSection = z.infer<typeof outlineSectionSchema>
/** Parsed technical-writing blueprint. */
export type OutlineArtifact = z.infer<typeof outlineArtifactSchema>
/** Parsed internal Blueprint Quality Review record. */
export type OutlineQualityReport = z.infer<typeof outlineQualityReportSchema>

/** Parse a technical-writing blueprint through the current strict schema. */
export function parseOutlineArtifact(value: unknown): OutlineArtifact {
  return outlineArtifactSchema.parse(value)
}

/** Parse the internal S4 quality-review record through its strict schema.
 * @param value Untrusted JSON value read from `outline/quality-report.json`.
 * @returns Validated quality-review record.
 */
export function parseOutlineQualityReport(value: unknown): OutlineQualityReport {
  return outlineQualityReportSchema.parse(value)
}
