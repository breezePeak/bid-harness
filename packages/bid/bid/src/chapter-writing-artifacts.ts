import { z } from 'zod'
import {
  evidenceMaterialSchema,
  externalEvidenceMaterialSchema,
} from './evidence-mapping-artifacts.ts'
import { normalizeWebEvidenceUrl } from './web-evidence-source-artifacts.ts'

/** Version of the durable S6 chapter manifest and chapter metadata records. */
export const CHAPTER_WRITING_SCHEMA_VERSION = 2 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
function localIdentity(material: z.infer<typeof evidenceMaterialSchema>): string {
  return `${material.file_id}\u0000${material.chunk}`
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

/** Agent-produced metadata for one independently written outline section. */
export const chapterMetadataSchema = z.object({
  section_id: z.string().min(1),
  covered_must_answer: z.array(z.string().min(1)),
  evidence_used: z.array(evidenceMaterialSchema),
  additional_materials: z.array(evidenceMaterialSchema),
  external_evidence_used: z.array(externalEvidenceMaterialSchema),
  additional_external_materials: z.array(externalEvidenceMaterialSchema),
  unresolved_topics: z.array(z.string().min(1)),
}).strict().superRefine((metadata, context) => {
  const local = [...metadata.evidence_used, ...metadata.additional_materials].map(localIdentity)
  if (duplicate(local)) context.addIssue({ code: 'custom', message: 'local evidence identities must be unique across chapter evidence arrays' })
  const external = [...metadata.external_evidence_used, ...metadata.additional_external_materials]
    .map(material => normalizeWebEvidenceUrl(material.url) ?? material.url)
  if (duplicate(external)) context.addIssue({ code: 'custom', message: 'external evidence URLs must be unique across chapter evidence arrays' })
})

/** One chapter entry that links a confirmed-outline section to its Markdown body. */
export const chapterManifestEntrySchema = chapterMetadataSchema.extend({
  content_path: z.string().regex(/^chapters\/sections\/\d{4}\.md$/u),
  requirement_ids: z.array(z.string().min(1)),
  scoring_ids: z.array(z.string().min(1)),
  compliance_ids: z.array(z.string().min(1)),
}).strict()

/** Strict durable index for all S6 chapter bodies. */
export const chapterWritingManifestSchema = z.object({
  schema_version: z.literal(CHAPTER_WRITING_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  confirmed_outline_sha256: sha256Schema,
  chapters: z.array(chapterManifestEntrySchema),
}).strict()

/** Parsed sidecar metadata for one chapter. */
export type ChapterMetadata = z.infer<typeof chapterMetadataSchema>
/** Parsed entry in the S6 manifest. */
export type ChapterManifestEntry = z.infer<typeof chapterManifestEntrySchema>
/** Parsed S6 chapter manifest. */
export type ChapterWritingManifest = z.infer<typeof chapterWritingManifestSchema>

/**
 * Parse a chapter sidecar file.
 * @param value - decoded JSON value.
 * @returns strict current-version chapter metadata.
 */
export function parseChapterMetadata(value: unknown): ChapterMetadata {
  return chapterMetadataSchema.parse(value)
}

/**
 * Parse the durable S6 manifest.
 * @param value - decoded JSON value.
 * @returns strict current-version chapter manifest.
 */
export function parseChapterWritingManifest(value: unknown): ChapterWritingManifest {
  return chapterWritingManifestSchema.parse(value)
}
