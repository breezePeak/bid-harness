import { z } from 'zod'
import {
  localEvidenceMaterialSchema,
  transientWebEvidenceMaterialSchema,
  webEvidenceMaterialSchema,
  type LocalEvidenceMaterial,
  type WebEvidenceMaterial,
} from './evidence-mapping-artifacts.ts'
import { normalizeWebEvidenceUrl } from './web-evidence-source-artifacts.ts'

/** Version of the durable S6 chapter manifest and chapter metadata records. */
export const CHAPTER_WRITING_SCHEMA_VERSION = 5 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function localIdentity(material: LocalEvidenceMaterial): string {
  return `${material.source_kind}\u0000${material.file_id}\u0000${material.chunk}`
}

function webIdentity(material: WebEvidenceMaterial): string {
  return material.source_id
}

const responsePointSnapshotSchema = z.object({
  scoring_id: z.string().min(1),
  response_point: z.string().min(1),
}).strict()

const chapterHandoffSchema = z.object({
  section_id: z.string().min(1),
  decisions: z.array(z.string().min(1)),
  terminology: z.array(z.string().min(1)),
  numbers_and_parameters: z.array(z.string().min(1)),
  interfaces: z.array(z.string().min(1)),
  deployment_constraints: z.array(z.string().min(1)),
  cross_reference_targets: z.array(z.string().min(1)),
  unresolved_topics: z.array(z.string().min(1)),
}).strict()

const chapterMetadataFields = {
  section_id: z.string().min(1),
  covered_must_answer: z.array(z.string().min(1)),
  covered_scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  covered_scoring_response_points: z.array(responsePointSnapshotSchema),
  local_materials_used: z.array(localEvidenceMaterialSchema),
  web_materials_used: z.array(webEvidenceMaterialSchema),
  unresolved_topics: z.array(z.string().min(1)),
  handoff: chapterHandoffSchema,
} as const

function addDurableEvidenceIssues(
  metadata: {
    covered_scoring_response_point_ids: string[]
    local_materials_used: LocalEvidenceMaterial[]
    web_materials_used: WebEvidenceMaterial[]
  },
  context: z.RefinementCtx,
): void {
  if (duplicate(metadata.covered_scoring_response_point_ids)) {
    context.addIssue({ code: 'custom', message: 'covered response-point ids must be unique' })
  }
  if (duplicate(metadata.local_materials_used.map(localIdentity))) {
    context.addIssue({ code: 'custom', message: 'local material identities must be unique' })
  }
  if (duplicate(metadata.web_materials_used.map(webIdentity))) {
    context.addIssue({ code: 'custom', message: 'Web source ids must be unique' })
  }
}

/** Agent-produced metadata persisted for one independently written outline section. */
export const chapterMetadataSchema = z.object(chapterMetadataFields).strict().superRefine(addDurableEvidenceIssues)

const chapterCandidateMetadataSchema = z.object({
  ...chapterMetadataFields,
  additional_web_materials: z.array(transientWebEvidenceMaterialSchema),
}).strict().superRefine((metadata, context) => {
  addDurableEvidenceIssues(metadata, context)
  const urls = metadata.additional_web_materials.map(material => normalizeWebEvidenceUrl(material.url) ?? material.url)
  if (duplicate(urls)) context.addIssue({ code: 'custom', message: 'additional Web material URLs must be unique' })
})

/** Structured Chapter Subagent result validated before Host snapshot binding. */
export const chapterCandidateSchema = z.object({
  section_id: z.string().min(1),
  markdown: z.string().trim().min(1),
  metadata: chapterCandidateMetadataSchema,
}).strict()

/** One chapter entry that links a confirmed-outline section to its Markdown body. */
export const chapterManifestEntrySchema = z.object({
  ...chapterMetadataFields,
  content_path: z.string().regex(/^chapters\/sections\/\d{4}\.md$/u),
  requirement_ids: z.array(z.string().min(1)),
  scoring_ids: z.array(z.string().min(1)),
  compliance_ids: z.array(z.string().min(1)),
  review_path: z.string().regex(/^chapters\/reviews\/\d{4}\.json$/u),
  review_sha256: sha256Schema,
}).strict().superRefine(addDurableEvidenceIssues)

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
/** Parsed structured result from one Chapter Subagent before Web snapshot binding. */
export type ChapterCandidate = z.infer<typeof chapterCandidateSchema>
/** Chapter candidate after the Host has bound every transient Web source. */
export type AcceptedChapterCandidate = Omit<ChapterCandidate, 'metadata'> & { metadata: ChapterMetadata }

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

/**
 * Parse one structured Chapter Subagent result.
 * @param value - decoded structured result.
 * @returns strict chapter candidate awaiting Host Web snapshot binding.
 */
export function parseChapterCandidate(value: unknown): ChapterCandidate {
  return chapterCandidateSchema.parse(value)
}
