import { z } from 'zod'

/** Version of the technical-evidence mapping Artifact. */
export const EVIDENCE_MAPPING_SCHEMA_VERSION = 3 as const

/** Allowed ways a later technical proposal may use a local material. */
export const MATERIAL_USAGES = ['reuse', 'adapt', 'reference', 'background'] as const

/** Allowed ways a later technical proposal may use public external material. */
export const EXTERNAL_MATERIAL_USAGES = ['reference', 'background'] as const

/** Strict schema shared by S3 and later evidence-consuming stages. */
export const evidenceMaterialSchema = z.object({
  file_id: z.string().min(1),
  chunk: z.string().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  usage: z.enum(MATERIAL_USAGES),
  summary: z.string().min(1),
}).strict().refine(material => material.line_end >= material.line_start, {
  message: 'material line range must be ordered',
})

/** Whether an external source uses the only supported network protocols. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Strict schema shared by S3 and later external-evidence consumers. */
export const externalEvidenceMaterialSchema = z.object({
  title: z.string().trim().min(1),
  url: z.url().refine(isHttpUrl, { message: 'external material URL must use http or https' }),
  publisher: z.string().trim().min(1),
  retrieved_at: z.iso.datetime({ offset: true }),
  retrieval_method: z.literal('web_search'),
  usage: z.enum(EXTERNAL_MATERIAL_USAGES),
  summary: z.string().trim().min(1),
  supports: z.string().trim().min(1),
}).strict()

const mappingSchema = z.object({
  materials: z.array(evidenceMaterialSchema),
  external_materials: z.array(externalEvidenceMaterialSchema),
  missing_topics: z.array(z.string().min(1)),
}).strict()

const requirementMappingSchema = mappingSchema.extend({ requirement_id: z.string().min(1) }).strict()
const scoringMappingSchema = mappingSchema.extend({ scoring_id: z.string().min(1) }).strict()
const relatedScoringPointSchema = z.object({
  scoring_id: z.string().min(1),
  response_point: z.string().min(1),
}).strict()
const researchTopicSchema = mappingSchema.extend({
  topic_id: z.string().min(1),
  topic: z.string().min(1),
  relevance: z.string().min(1),
  related_requirement_ids: z.array(z.string().min(1)),
  related_scoring_points: z.array(relatedScoringPointSchema),
  findings: z.array(z.string().min(1)).min(1),
  writing_dimensions: z.array(z.string().min(1)).min(1),
}).strict()

const evidenceMapSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_SCHEMA_VERSION),
  research_topics: z.array(researchTopicSchema),
  requirement_mappings: z.array(requirementMappingSchema),
  scoring_mappings: z.array(scoringMappingSchema),
}).strict()

/** Parsed local material reference. */
export type EvidenceMaterial = z.infer<typeof evidenceMaterialSchema>
/** Parsed public technical reference discovered by search and admitted only after a successful source fetch. */
export type ExternalEvidenceMaterial = z.infer<typeof externalEvidenceMaterialSchema>
/** Parsed requirement-to-material mapping. */
export type RequirementMaterialMapping = z.infer<typeof requirementMappingSchema>
/** Parsed scoring-to-material mapping. */
export type ScoringMaterialMapping = z.infer<typeof scoringMappingSchema>
/** Parsed Agent-authored research that may inform multiple later sections. */
export type EvidenceResearchTopic = z.infer<typeof researchTopicSchema>
/** Parsed evidence-map Artifact. */
export type EvidenceMapArtifact = z.infer<typeof evidenceMapSchema>

/**
 * Parse an evidence map through the current schema.
 * @param value - decoded JSON value.
 * @returns strict current-version evidence map.
 */
export function parseEvidenceMapArtifact(value: unknown): EvidenceMapArtifact {
  return evidenceMapSchema.parse(value)
}
