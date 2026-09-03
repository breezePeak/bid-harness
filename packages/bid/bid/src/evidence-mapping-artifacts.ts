import { z } from 'zod'

/** Version of the technical-evidence mapping Artifact. */
export const EVIDENCE_MAPPING_SCHEMA_VERSION = 10 as const

/** Allowed ways a later technical proposal may use a local material. */
export const MATERIAL_USAGES = ['reuse', 'adapt', 'reference', 'background'] as const

/** Allowed ways a later technical proposal may use public Web material. */
export const WEB_MATERIAL_USAGES = ['reference', 'background'] as const

/** Strict local-material reference shared by S4 and later evidence consumers. */
export const localEvidenceMaterialSchema = z.object({
  source_kind: z.enum(['reference', 'reference_bid']),
  file_id: z.string().min(1),
  chunk: z.string().regex(/^chunk_\d{4}$/u),
  usage: z.enum(MATERIAL_USAGES),
  summary: z.string().min(1),
}).strict().superRefine((material, context) => {
  if (material.source_kind === 'reference' && (material.usage === 'reuse' || material.usage === 'adapt')) {
    context.addIssue({ code: 'custom', path: ['usage'], message: 'reference material usage must be reference or background' })
  }
})

/** Whether a Web source uses one of the supported network protocols. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** URL-shaped Web material returned before the Host binds a durable snapshot. */
export const transientWebEvidenceMaterialSchema = z.object({
  url: z.url().refine(isHttpUrl, { message: 'Web material URL must use http or https' }),
  usage: z.enum(WEB_MATERIAL_USAGES),
  summary: z.string().trim().min(1),
  supports: z.string().trim().min(1),
}).strict()

/** Durable Web material bound to one Host-owned snapshot. */
export const webEvidenceMaterialSchema = z.object({
  source_id: z.string().regex(/^WEB-[a-f0-9]{16}$/u),
  snapshot_path: z.string().regex(/^analysis\/web-sources\/WEB-[a-f0-9]{16}\.md$/u),
  usage: z.enum(WEB_MATERIAL_USAGES),
  summary: z.string().trim().min(1),
  supports: z.string().trim().min(1),
}).strict().superRefine((material, context) => {
  if (material.snapshot_path !== `analysis/web-sources/${material.source_id}.md`) {
    context.addIssue({ code: 'custom', path: ['snapshot_path'], message: 'snapshot path must be owned by source id' })
  }
})

const mappingSchema = z.object({
  local_materials: z.array(localEvidenceMaterialSchema),
  web_materials: z.array(webEvidenceMaterialSchema),
  missing_topics: z.array(z.string().min(1)),
}).strict()

const partialMappingSchema = z.object({
  local_materials: z.array(localEvidenceMaterialSchema),
  web_materials: z.array(transientWebEvidenceMaterialSchema),
  missing_topics: z.array(z.string().min(1)),
}).strict()

/** Evidence available to one final writable outline section. */
export const sectionEvidenceMappingSchema = mappingSchema.extend({
  section_id: z.string().min(1),
  writing_dimensions: z.array(z.string().min(1)),
}).strict()

const evidenceMapSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_SCHEMA_VERSION),
  section_mappings: z.array(sectionEvidenceMappingSchema),
}).strict()

/** Version of the Host-private S4 task plan. */
export const EVIDENCE_MAPPING_PLAN_SCHEMA_VERSION = 5 as const

const evidenceMappingTaskSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().min(1),
  phase: z.literal('initial'),
  section_ids: z.array(z.string().min(1)).min(1),
  heading_path: z.array(z.string().min(1)).min(1),
}).strict()

const evidenceMappingPlanSchema = z.object({
  schema_version: z.literal(EVIDENCE_MAPPING_PLAN_SCHEMA_VERSION),
  tasks: z.array(evidenceMappingTaskSchema),
}).strict()

const partialSectionMappingSchema = partialMappingSchema.extend({
  section_id: z.string().min(1),
  writing_dimensions: z.array(z.string().min(1)),
}).strict()

/** Strict URL-bearing result returned by one Mapping Subagent before Host binding. */
export const evidenceMappingPartialResultSchema = z.object({
  task_id: z.string().min(1),
  section_mappings: z.array(partialSectionMappingSchema),
  refinement_suggestions: z.array(z.string().min(1)),
}).strict()

/** Parsed local material reference. */
export type LocalEvidenceMaterial = z.infer<typeof localEvidenceMaterialSchema>
/** URL-shaped public technical reference awaiting Host snapshot binding. */
export type TransientWebEvidenceMaterial = z.infer<typeof transientWebEvidenceMaterialSchema>
/** Public technical reference bound to a durable Host snapshot. */
export type WebEvidenceMaterial = z.infer<typeof webEvidenceMaterialSchema>
/** Parsed section-to-evidence mapping. */
export type SectionEvidenceMapping = z.infer<typeof sectionEvidenceMappingSchema>
/** Parsed evidence-map Artifact. */
export type EvidenceMapArtifact = z.infer<typeof evidenceMapSchema>
/** Host 按目录业务分支生成的 S4 执行批次，包含多个章节。 */
export type EvidenceMappingTask = z.infer<typeof evidenceMappingTaskSchema>
/** Host 私有的确定性 S4 任务计划。 */
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

/**
 * Parse a Host-private S4 task plan.
 * @param value - decoded JSON value.
 * @returns strict current-version S4 plan.
 */
export function parseEvidenceMappingPlan(value: unknown): EvidenceMappingPlan {
  return evidenceMappingPlanSchema.parse(value)
}

/**
 * Parse one Mapping Subagent result before Web Snapshot binding.
 * @param value - decoded structured Child result.
 * @returns strict URL-bearing partial result.
 */
export function parseEvidenceMappingPartialResult(value: unknown): EvidenceMappingPartialResult {
  return evidenceMappingPartialResultSchema.parse(value)
}
