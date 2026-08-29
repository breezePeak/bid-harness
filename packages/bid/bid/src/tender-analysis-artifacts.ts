import { z } from 'zod'

/** Version shared by every tender-analysis Artifact. */
export const TENDER_ANALYSIS_SCHEMA_VERSION = 1 as const

/** Machine-checkable citation into one tender corpus chunk. */
export interface TenderSourceRef {
  file_id: string
  chunk: string
  line_start: number
  line_end: number
}

const sourceRefSchema = z.object({
  file_id: z.string().min(1),
  chunk: z.string().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
}).strict().refine(ref => ref.line_end >= ref.line_start, {
  message: 'source line range must be ordered',
})

const sourceRefsSchema = z.array(sourceRefSchema).min(1)
const nullableFactSchema = z.string().min(1).nullable()

const projectSchema = z.object({
  schema_version: z.literal(TENDER_ANALYSIS_SCHEMA_VERSION),
  project_name: nullableFactSchema,
  tender_name: nullableFactSchema,
  purchaser: nullableFactSchema,
  owner: nullableFactSchema,
  project_scope: z.array(z.string().min(1)),
  technical_scope: z.array(z.string().min(1)),
  delivery_scope: z.array(z.string().min(1)),
  source_refs: sourceRefsSchema,
  analyzed_tender_files: z.array(z.string().min(1)),
}).strict()

const requirementSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  raw_text: z.string().min(1),
  normalized_requirement: z.string().min(1),
  mandatory: z.boolean(),
  source_refs: sourceRefsSchema,
}).strict()

const requirementsSchema = z.object({
  schema_version: z.literal(TENDER_ANALYSIS_SCHEMA_VERSION),
  requirements: z.array(requirementSchema),
}).strict()

const scoreRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
}).strict().refine(range => range.max >= range.min, {
  message: 'score range must be ordered',
})

const scoringItemSchema = z.object({
  id: z.string().min(1),
  parent: z.string().min(1).nullable(),
  group: z.string().min(1).nullable(),
  title: z.string().min(1),
  raw_text: z.string().min(1),
  criterion: z.string().min(1),
  score: z.number().nullable(),
  score_range: scoreRangeSchema.nullable(),
  must_answer: z.boolean(),
  source_refs: sourceRefsSchema,
}).strict()

const scoringSchema = z.object({
  schema_version: z.literal(TENDER_ANALYSIS_SCHEMA_VERSION),
  scoring_items: z.array(scoringItemSchema),
}).strict()

const complianceItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  raw_text: z.string().min(1),
  normalized_rule: z.string().min(1),
  severity: z.enum(['fatal', 'mandatory', 'warning']),
  source_refs: sourceRefsSchema,
}).strict()

const complianceSchema = z.object({
  schema_version: z.literal(TENDER_ANALYSIS_SCHEMA_VERSION),
  compliance_items: z.array(complianceItemSchema),
}).strict()

/** Parsed project facts and tender-file coverage. */
export type TenderProjectArtifact = z.infer<typeof projectSchema>
/** Parsed atomic tender requirements. */
export type TenderRequirementsArtifact = z.infer<typeof requirementsSchema>
/** Parsed atomic scoring criteria. */
export type TenderScoringArtifact = z.infer<typeof scoringSchema>
/** Parsed tender validity and mandatory-response rules. */
export type TenderComplianceArtifact = z.infer<typeof complianceSchema>

/** Tender-analysis Artifact path and runtime parser. */
export const TENDER_ANALYSIS_ARTIFACTS = {
  'analysis/project.json': projectSchema,
  'analysis/requirements.json': requirementsSchema,
  'analysis/scoring.json': scoringSchema,
  'analysis/compliance.json': complianceSchema,
} as const

/**
 * Parse project facts through the current tender-analysis schema.
 * @param value Candidate JSON value.
 * @returns Validated project Artifact.
 */
export function parseTenderProjectArtifact(value: unknown): TenderProjectArtifact {
  return projectSchema.parse(value)
}

/**
 * Parse atomic requirements through the current tender-analysis schema.
 * @param value Candidate JSON value.
 * @returns Validated requirements Artifact.
 */
export function parseTenderRequirementsArtifact(value: unknown): TenderRequirementsArtifact {
  return requirementsSchema.parse(value)
}

/**
 * Parse atomic scoring criteria through the current tender-analysis schema.
 * @param value Candidate JSON value.
 * @returns Validated scoring Artifact.
 */
export function parseTenderScoringArtifact(value: unknown): TenderScoringArtifact {
  return scoringSchema.parse(value)
}

/**
 * Parse validity and mandatory-response rules through the current tender-analysis schema.
 * @param value Candidate JSON value.
 * @returns Validated compliance Artifact.
 */
export function parseTenderComplianceArtifact(value: unknown): TenderComplianceArtifact {
  return complianceSchema.parse(value)
}
