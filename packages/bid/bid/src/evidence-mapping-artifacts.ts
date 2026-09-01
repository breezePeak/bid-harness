import { z } from 'zod'

/** Version of the technical-evidence mapping Artifact. */
export const EVIDENCE_MAPPING_SCHEMA_VERSION = 6 as const

/** Allowed ways a later technical proposal may use a local material. */
export const MATERIAL_USAGES = ['reuse', 'adapt', 'reference', 'background'] as const

/** Allowed ways a later technical proposal may use public external material. */
export const EXTERNAL_MATERIAL_USAGES = ['reference', 'background'] as const

/** Strict schema shared by S3 and later evidence-consuming stages. */
export const evidenceMaterialSchema = z.object({
  file_id: z.string().min(1),
  chunk: z.string().regex(/^chunk_\d{4}$/u),
  usage: z.enum(MATERIAL_USAGES),
  summary: z.string().min(1),
}).strict()

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

export const requirementMappingSchema = mappingSchema.extend({
  requirement_id: z.string().min(1),
  writing_dimensions: z.array(z.string().min(1)).min(1),
}).strict()
export const scoringMappingSchema = mappingSchema.extend({ scoring_id: z.string().min(1) }).strict()
export const relatedScoringPointSchema = z.object({
  response_point_id: z.string().regex(/^RP-\d{6}$/u),
  scoring_id: z.string().min(1),
  response_point: z.string().min(1),
}).strict()
export const researchTopicSchema = mappingSchema.extend({
  topic_id: z.string().min(1),
  topic: z.string().min(1),
  relevance: z.string().min(1),
  related_requirement_ids: z.array(z.string().min(1)),
  related_scoring_points: z.array(relatedScoringPointSchema),
  findings: z.array(z.string().min(1)).min(1),
  writing_dimensions: z.array(z.string().min(1)).min(1),
}).strict()

export const sourceStrategySchema = z.object({
  mode: z.enum(['framework_and_reference_bid', 'framework_only', 'reference_bid_only', 'generated_from_scratch']),
  framework_file_id: z.string().min(1).nullable(),
  reference_bid_file_ids: z.array(z.string().min(1)),
}).strict()

const sourceMappingSchema = z.object({
  file_id: z.string().min(1),
  source_section_id: z.string().min(1),
  related_requirement_ids: z.array(z.string().min(1)),
  related_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  content_materials: z.array(evidenceMaterialSchema),
  writing_dimensions: z.array(z.string().min(1)).min(1),
  missing_topics: z.array(z.string().min(1)),
}).strict()

const frameworkMappingResultSchema = sourceMappingSchema.extend({
  action: z.enum(['preserve', 'expand', 'adjust', 'exclude']),
  reason: z.string().min(1),
}).strict()

const referenceBidMappingResultSchema = sourceMappingSchema.extend({
  action: z.enum(['reuse', 'adapt', 'reference', 'background']),
  summary: z.string().min(1),
  adaptation_notes: z.array(z.string().min(1)),
  risk_notes: z.array(z.string().min(1)),
}).strict()

export const frameworkMappingSchema = frameworkMappingResultSchema.extend({ mapping_id: z.string().min(1) }).strict()
export const referenceBidMappingSchema = referenceBidMappingResultSchema.extend({ mapping_id: z.string().min(1) }).strict()

export const responsePointMappingSchema = mappingSchema.extend({
  response_point_id: z.string().regex(/^RP-\d{6}$/u),
  scoring_id: z.string().min(1),
  response_point: z.string().min(1),
  writing_dimensions: z.array(z.string().min(1)).min(1),
}).strict()

const evidenceMapSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_SCHEMA_VERSION),
  source_strategy: sourceStrategySchema,
  framework_mappings: z.array(frameworkMappingSchema),
  reference_bid_mappings: z.array(referenceBidMappingSchema),
  research_topics: z.array(researchTopicSchema),
  requirement_mappings: z.array(requirementMappingSchema),
  scoring_mappings: z.array(scoringMappingSchema),
  response_point_mappings: z.array(responsePointMappingSchema),
}).strict()

/** Version of the Host-private S3 task plan. */
export const EVIDENCE_MAPPING_PLAN_SCHEMA_VERSION = 1 as const

const evidenceMappingTaskSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  requirement_ids: z.array(z.string().min(1)),
  scoring_ids: z.array(z.string().min(1)),
  response_point_ids: z.array(z.string().min(1)),
  compliance_ids: z.array(z.string().min(1)),
  source_focus: z.array(z.string().min(1)),
  research_topics: z.array(z.string().min(1)),
}).strict().refine(task => task.requirement_ids.length + task.scoring_ids.length
  + task.response_point_ids.length + task.research_topics.length > 0, {
  message: 'mapping task must own at least one business item or research topic',
})

const evidenceMappingPlanSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_PLAN_SCHEMA_VERSION),
  global_analysis: z.array(z.string().min(1)).min(1),
  source_strategy_notes: z.array(z.string().min(1)),
  tasks: z.array(evidenceMappingTaskSchema).min(1),
}).strict()

export const evidenceMappingPartialResultSchema = z.object({
  task_id: z.string().min(1),
  requirement_mappings: z.array(requirementMappingSchema),
  scoring_mappings: z.array(scoringMappingSchema),
  response_point_mappings: z.array(responsePointMappingSchema),
  research_topics: z.array(researchTopicSchema),
  framework_mappings: z.array(frameworkMappingResultSchema),
  reference_bid_mappings: z.array(referenceBidMappingResultSchema),
  findings: z.array(z.string().min(1)),
  missing_topics: z.array(z.string().min(1)),
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
/** Host-derived source strategy for successfully parsed special writing assets. */
export type EvidenceSourceStrategy = z.infer<typeof sourceStrategySchema>
/** Parsed mapping from an artificial framework heading to this bid. */
export type FrameworkMapping = z.infer<typeof frameworkMappingSchema>
/** Parsed mapping from a reference-bid heading to this bid. */
export type ReferenceBidMapping = z.infer<typeof referenceBidMappingSchema>
/** Parsed mapping from one scoring response point to writing materials and dimensions. */
export type ScoringResponsePointMapping = z.infer<typeof responsePointMappingSchema>
/** Parsed evidence-map Artifact. */
export type EvidenceMapArtifact = z.infer<typeof evidenceMapSchema>
/** One Main-Agent-authored S3 work item executed in an independent Child Session. */
export type EvidenceMappingTask = z.infer<typeof evidenceMappingTaskSchema>
/** Host-private Main-Agent task plan for S3. */
export type EvidenceMappingPlan = z.infer<typeof evidenceMappingPlanSchema>
/** Strict partial Evidence Map returned by one Mapping Subagent. */
export type EvidenceMappingPartialResult = z.infer<typeof evidenceMappingPartialResultSchema>

/**
 * Parse an evidence map through the current schema.
 * @param value - decoded JSON value.
 * @returns strict current-version evidence map.
 */
export function parseEvidenceMapArtifact(value: unknown): EvidenceMapArtifact {
  return evidenceMapSchema.parse(value)
}

/** Parse a Host-private S3 task plan. */
export function parseEvidenceMappingPlan(value: unknown): EvidenceMappingPlan {
  return evidenceMappingPlanSchema.parse(value)
}

/** Parse one Mapping Subagent result through the existing Evidence schemas. */
export function parseEvidenceMappingPartialResult(value: unknown): EvidenceMappingPartialResult {
  return evidenceMappingPartialResultSchema.parse(value)
}
