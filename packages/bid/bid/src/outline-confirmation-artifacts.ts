import { createHash } from 'node:crypto'
import { z } from 'zod'
import { outlineArtifactSchema, type OutlineArtifact } from './outline-generation-artifacts.ts'

/** Version of the durable user confirmation record. */
export const OUTLINE_CONFIRMATION_SCHEMA_VERSION = 2 as const
/** Version of the Host-persisted outline draft envelope. */
export const OUTLINE_DRAFT_SCHEMA_VERSION = 1 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

/** Strict schema for the durable S5 decision record. */
export const outlineConfirmationSchema = z.object({
  schema_version: z.literal(OUTLINE_CONFIRMATION_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  decision: z.literal('confirmed'),
  source_outline_sha256: sha256Schema,
  confirmed_outline_sha256: sha256Schema,
  confirmed_draft_revision: z.number().int().positive(),
  confirmed_draft_sha256: sha256Schema,
}).strict()

/** Strict Host draft envelope used as the sole S5 business state. */
export const outlineDraftSchema = z.object({
  schema_version: z.literal(OUTLINE_DRAFT_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  revision: z.number().int().positive(),
  source_outline_sha256: sha256Schema,
  draft_outline_sha256: sha256Schema,
  outline: outlineArtifactSchema,
}).strict()

/** Durable user decision that establishes the S6 outline input. */
export type OutlineConfirmationArtifact = z.infer<typeof outlineConfirmationSchema>
/** Host-persisted S5 draft and optimistic-concurrency identity. */
export type OutlineDraftView = z.infer<typeof outlineDraftSchema>

/** Parse one strict Host outline draft. */
export function parseOutlineDraft(value: unknown): OutlineDraftView {
  return outlineDraftSchema.parse(value)
}

/** Parse one strict S5 confirmation record. */
export function parseOutlineConfirmationArtifact(value: unknown): OutlineConfirmationArtifact {
  return outlineConfirmationSchema.parse(value)
}

/** Return the SHA-256 of the canonical persisted JSON artifact bytes. */
export function outlineArtifactSha256(outline: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(outline, null, 2)}\n`).digest('hex')
}

/** Parse a confirmed outline using the same schema as the S4 draft. */
export function parseConfirmedOutlineArtifact(value: unknown): OutlineArtifact {
  return outlineArtifactSchema.parse(value)
}
