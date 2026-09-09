import { z } from 'zod'

/** Version of the technical-writing blueprint Artifact. */
export const OUTLINE_GENERATION_SCHEMA_VERSION = 3 as const

/** Version of the internal Blueprint Quality Review record. */
export const OUTLINE_QUALITY_REPORT_SCHEMA_VERSION = 4 as const

/** Stable reference from one generated Section to an imported framework heading. */
export const outlineFrameworkRefSchema = z.object({
  file_id: z.string().min(1),
  heading_path: z.array(z.string().min(1)).min(1),
}).strict()

/** Strict schema shared by generated and user-confirmed technical-bid sections. */
export const outlineSectionSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
  order: z.number().int().positive(),
  level: z.number().int().positive(),
  title: z.string().min(1),
  purpose: z.string().min(1),
  /** 可直接用于标书正文的父节点总述，依据最终子章节任务与已确认信息；S4 发布前生成并复核。 */
  summary: z.string().trim().min(1).optional(),
  writable: z.boolean(),
  must_answer: z.array(z.string().min(1)),
  requirement_ids: z.array(z.string().min(1)),
  scoring_ids: z.array(z.string().min(1)),
  compliance_ids: z.array(z.string().min(1)),
  origin: z.enum(['framework', 'generated', 'mixed']),
  framework_refs: z.array(outlineFrameworkRefSchema).optional(),
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

/** S3 模型候选可省略派生快照；规范化后仍须通过正式目录 Schema。 */
export const outlineCandidateSchema = outlineArtifactSchema.extend({
  sections: z.array(z.object({
    ...outlineSectionSchema.shape,
    scoring_response_points: z.array(z.object({ scoring_id: z.string().min(1), response_point: z.string() }).strict()).optional(),
  }).strict()).min(1),
})

/** Non-blocking semantic finding retained by the S3 Blueprint Quality Review. */
export const outlineQualityIssueSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/u),
  severity: z.literal('advisory'),
  message: z.string().trim().min(1),
}).strict()

/** Strict record of the mandatory quality review performed after S3 drafting. */
export const outlineQualityReportSchema = z.object({
  schema_version: z.literal(OUTLINE_QUALITY_REPORT_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  checked_requirement_ids: z.array(z.string().min(1)),
  checked_scoring_ids: z.array(z.string().min(1)),
  checked_scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  reviewed_section_ids: z.array(z.string().min(1)),
  issues: z.array(outlineQualityIssueSchema),
}).strict()

/** One independently writable or structural node in a technical bid outline. */
export type OutlineSection = z.infer<typeof outlineSectionSchema>
/** Stable reference to one source heading in an imported outline framework. */
export type OutlineFrameworkRef = z.infer<typeof outlineFrameworkRefSchema>
/** Parsed technical-writing blueprint. */
export type OutlineArtifact = z.infer<typeof outlineArtifactSchema>
/** One non-blocking semantic finding from Blueprint Quality Review. */
export type OutlineQualityIssue = z.infer<typeof outlineQualityIssueSchema>
/** Parsed internal Blueprint Quality Review record. */
export type OutlineQualityReport = z.infer<typeof outlineQualityReportSchema>

/**
 * Parse a technical-writing blueprint through the current strict schema.
 * @param value Untrusted generated or persisted outline value.
 * @returns Validated technical-writing blueprint.
 */
export function parseOutlineArtifact(value: unknown): OutlineArtifact {
  return outlineArtifactSchema.parse(value)
}

/** Parse the internal S3 quality-review record through its strict schema.
 * @param value Untrusted JSON value read from `outline/quality-report.json`.
 * @returns Validated quality-review record.
 */
export function parseOutlineQualityReport(value: unknown): OutlineQualityReport {
  return outlineQualityReportSchema.parse(value)
}
