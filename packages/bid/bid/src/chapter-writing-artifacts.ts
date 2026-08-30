import { z } from 'zod'
import { type EvidenceMaterial } from './evidence-mapping-artifacts.ts'

/** Version of the durable S6 chapter manifest and chapter metadata records. */
export const CHAPTER_WRITING_SCHEMA_VERSION = 1 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const materialSchema = z.object({
  file_id: z.string().min(1),
  chunk: z.string().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  usage: z.enum(['reuse', 'adapt', 'reference', 'background']),
  summary: z.string().min(1),
}).strict().refine(material => material.line_end >= material.line_start, {
  message: 'material line range must be ordered',
})

/** Agent-produced metadata for one independently written outline section. */
export const chapterMetadataSchema = z.object({
  section_id: z.string().min(1),
  covered_must_answer: z.array(z.string().min(1)),
  evidence_used: z.array(materialSchema),
  additional_materials: z.array(materialSchema),
  unresolved_topics: z.array(z.string().min(1)),
}).strict()

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

/** Parse a chapter sidecar file. */
export function parseChapterMetadata(value: unknown): ChapterMetadata {
  return chapterMetadataSchema.parse(value)
}

/** Parse the durable S6 manifest. */
export function parseChapterWritingManifest(value: unknown): ChapterWritingManifest {
  return chapterWritingManifestSchema.parse(value)
}

/** Treat a parsed chapter material as the shared evidence reference type. */
export function chapterMaterial(material: EvidenceMaterial): EvidenceMaterial {
  return material
}
