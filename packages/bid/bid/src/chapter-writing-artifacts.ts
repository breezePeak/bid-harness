import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import {
  localEvidenceMaterialSchema,
  transientWebEvidenceMaterialSchema,
  webEvidenceMaterialSchema,
  type LocalEvidenceMaterial,
  type WebEvidenceMaterial,
  webMaterialIdentity,
} from './evidence-mapping-artifacts.ts'
import { normalizeWebEvidenceUrl } from './web-evidence-source-artifacts.ts'
import { FLOWCHART_SCHEMA_VERSION, FLOWCHART_MAX_EDGES, FLOWCHART_MAX_NODES, type FlowchartDraft, type FlowchartSpec } from './flowchart.ts'

/** Version of the durable S6 chapter manifest and chapter metadata records. */
export const CHAPTER_WRITING_SCHEMA_VERSION = 6 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function localIdentity(material: LocalEvidenceMaterial): string {
  return `${material.source_kind}\u0000${material.file_id}\u0000${material.chunk}`
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

const flowchartNodeTypeSchema = z.enum(['start', 'end', 'process', 'decision', 'document', 'subprocess'])
const flowchartDraftNodeSchema = z.object({
  key: z.string().trim().min(1).max(64), type: flowchartNodeTypeSchema, text: z.string().trim().min(1).max(200),
}).strict()
const flowchartDraftEdgeSchema = z.object({
  from: z.string().trim().min(1).max(64), to: z.string().trim().min(1).max(64), label: z.string().trim().min(1).max(100).optional(),
}).strict()
const flowchartDraftSchema = z.object({
  type: z.literal('flowchart').optional(), key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(), title: z.string().trim().min(1).max(200), purpose: z.string().trim().min(1).max(500).optional(),
  direction: z.enum(['TB', 'LR']).optional(),
  nodes: z.array(flowchartDraftNodeSchema).min(1).max(FLOWCHART_MAX_NODES),
  edges: z.array(flowchartDraftEdgeSchema).max(FLOWCHART_MAX_EDGES),
}).strict()
const flowchartSpecSchema = z.object({
  type: z.literal('flowchart'), schema_version: recordOnlySchemaVersion(FLOWCHART_SCHEMA_VERSION),
  id: z.string().regex(/^FLOW-[A-Za-z0-9_-]+$/u),
  key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(),
  title: z.string().trim().min(1).max(200), purpose: z.string().trim().min(1).max(500).optional(), direction: z.enum(['TB', 'LR']),
  nodes: z.array(z.object({
    id: z.string().regex(/^N\d+$/u), type: flowchartNodeTypeSchema, text: z.string().trim().min(1).max(200),
  }).strict()).min(1).max(FLOWCHART_MAX_NODES),
  edges: z.array(flowchartDraftEdgeSchema).max(FLOWCHART_MAX_EDGES),
}).strict()
const flowchartInputSchema = z.union([flowchartDraftSchema, flowchartSpecSchema])

function flowchartInput(value: unknown): FlowchartDraft | FlowchartSpec {
  return flowchartInputSchema.parse(value)
}

const chapterMetadataFields = {
  section_id: z.string().min(1),
  covered_must_answer: z.array(z.string().min(1)),
  covered_scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  covered_scoring_response_points: z.array(responsePointSnapshotSchema),
  local_materials_used: z.array(localEvidenceMaterialSchema),
  web_materials_used: z.array(webEvidenceMaterialSchema),
  unresolved_topics: z.array(z.string().min(1)),
  handoff: chapterHandoffSchema,
  flowcharts: z.array(flowchartSpecSchema).default([]),
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
  if (duplicate(metadata.web_materials_used.map(webMaterialIdentity))) {
    context.addIssue({ code: 'custom', message: 'Web material identities must be unique' })
  }
}

/** Agent-produced metadata persisted for one independently written outline section. */
export const chapterMetadataSchema = z.object(chapterMetadataFields).strict().superRefine(addDurableEvidenceIssues)

const chapterCandidateMetadataSchema = z.object({
  ...chapterMetadataFields,
  additional_web_materials: z.array(transientWebEvidenceMaterialSchema),
  flowcharts: z.array(flowchartInputSchema).default([]).transform(values => values.map(flowchartInput)),
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
  schema_version: recordOnlySchemaVersion(CHAPTER_WRITING_SCHEMA_VERSION),
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
export type AcceptedChapterCandidate = Omit<ChapterCandidate, 'metadata'> & {
  metadata: Omit<ChapterMetadata, 'flowcharts'> & { flowcharts: FlowchartSpec[] }
}
/** Candidate after Host normalization, before transient Web materials are persisted. */
export type BoundChapterCandidate = Omit<AcceptedChapterCandidate, 'metadata'> & {
  metadata: AcceptedChapterCandidate['metadata'] & Pick<ChapterCandidate['metadata'], 'additional_web_materials'>
}

/**
 * Parse a chapter sidecar file.
 * @param value - decoded JSON value.
 * @returns Strict chapter metadata business structure.
 */
export function parseChapterMetadata(value: unknown): ChapterMetadata {
  return chapterMetadataSchema.parse(value)
}

/**
 * Parse the durable S6 manifest.
 * @param value - decoded JSON value.
 * @returns Strict chapter manifest business structure.
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
