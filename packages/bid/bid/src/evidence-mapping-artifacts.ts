import { z } from 'zod'

/** Version of the local technical-material mapping Artifact. */
export const EVIDENCE_MAPPING_SCHEMA_VERSION = 1 as const

/** Allowed ways a later technical proposal may use a local material. */
export const MATERIAL_USAGES = ['reuse', 'adapt', 'reference', 'background'] as const

const materialSchema = z.object({
  file_id: z.string().min(1),
  chunk: z.string().min(1),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  usage: z.enum(MATERIAL_USAGES),
  summary: z.string().min(1),
}).strict().refine(material => material.line_end >= material.line_start, {
  message: 'material line range must be ordered',
})

const mappingSchema = z.object({
  materials: z.array(materialSchema),
  missing_topics: z.array(z.string().min(1)),
}).strict().refine(mapping => mapping.materials.length > 0 || mapping.missing_topics.length > 0, {
  message: 'a mapping requires material or a missing topic',
})

const requirementMappingSchema = mappingSchema.extend({ requirement_id: z.string().min(1) }).strict()
const scoringMappingSchema = mappingSchema.extend({ scoring_id: z.string().min(1) }).strict()

const evidenceMapSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_SCHEMA_VERSION),
  requirement_mappings: z.array(requirementMappingSchema),
  scoring_mappings: z.array(scoringMappingSchema),
}).strict()

/** Parsed local material reference. */
export type EvidenceMaterial = z.infer<typeof materialSchema>
/** Parsed requirement-to-material mapping. */
export type RequirementMaterialMapping = z.infer<typeof requirementMappingSchema>
/** Parsed scoring-to-material mapping. */
export type ScoringMaterialMapping = z.infer<typeof scoringMappingSchema>
/** Parsed evidence-map Artifact. */
export type EvidenceMapArtifact = z.infer<typeof evidenceMapSchema>

/** Parse an evidence map through the current schema. */
export function parseEvidenceMapArtifact(value: unknown): EvidenceMapArtifact {
  return evidenceMapSchema.parse(value)
}
