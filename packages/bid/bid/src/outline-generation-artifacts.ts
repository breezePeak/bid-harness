import { z } from 'zod'

/** Version of the technical-writing blueprint Artifact. */
export const OUTLINE_GENERATION_SCHEMA_VERSION = 1 as const

const sectionSchema = z.object({
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

const outlineSchema = z.object({
  schema_version: z.literal(OUTLINE_GENERATION_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  document_title: z.string().min(1),
  global_compliance_ids: z.array(z.string().min(1)),
  sections: z.array(sectionSchema).min(1),
}).strict()

/** One independently writable or structural node in a technical bid outline. */
export type OutlineSection = z.infer<typeof sectionSchema>
/** Parsed technical-writing blueprint. */
export type OutlineArtifact = z.infer<typeof outlineSchema>

/** Parse a technical-writing blueprint through the current strict schema. */
export function parseOutlineArtifact(value: unknown): OutlineArtifact {
  return outlineSchema.parse(value)
}
