/** 阶段界面和后端共享的纯研究诊断契约，不依赖 Host 工具或会话服务。 */
import { z } from 'zod'

/** 本章是否需要外部证据及其语义理由。 */
export const researchRequirementSchema = z.object({
  kind: z.enum(['not_required', 'local_sufficient', 'external_required']),
  reason: z.string().trim().min(1),
}).strict()

/** 一次真实工具执行的查询、来源、阅读定位及失败字段。 */
export const researchObservationSchema = z.object({
  call_id: z.string().min(1), tool: z.string().min(1),
  queries: z.array(z.string()), candidate_urls: z.array(z.string()), read_refs: z.array(z.string()),
  fetched_source_ref: z.string().nullable(), succeeded: z.boolean(), failure_reason: z.string().nullable(),
  error_info: z.object({ name: z.string(), code: z.string(),
    statusCode: z.number().optional(), retryAfter: z.string().optional() }).strict().optional(),
}).strict()

/** 程序观测与当前章节材料发布事实组成的研究诊断。 */
export const researchDiagnosticsSchema = z.object({
  status: z.enum(['history_unknown', 'not_started', 'not_required', 'local_sufficient', 'researching', 'search_empty', 'search_failed', 'fetch_failed',
    'read_excluded', 'saved_unbound', 'bound', 'display_omitted', 'insufficient']),
  requirement: researchRequirementSchema.nullable(),
  queries: z.array(z.string()), candidate_urls: z.array(z.string()),
  searches: z.number().int().nonnegative().nullable(), local_searches: z.number().int().nonnegative().nullable().optional(),
  fetched: z.number().int().nonnegative().nullable(), read: z.number().int().nonnegative().nullable(),
  adopted: z.number().int().nonnegative(), bound: z.number().int().nonnegative(), displayed: z.number().int().nonnegative(),
  unresolved_gaps: z.array(z.string()), failure_reasons: z.array(z.string()),
  exclusions: z.array(z.object({ material_ref: z.string(), reason: z.string() }).strict()),
  adopted_refs: z.array(z.string()), bound_refs: z.array(z.string()), displayed_refs: z.array(z.string()),
}).strict()

/** 已校验的工具研究记录。 */
export type ResearchObservation = z.infer<typeof researchObservationSchema>
/** 发布到阶段与独立研究界面的研究诊断。 */
export type BidResearchDiagnostics = z.infer<typeof researchDiagnosticsSchema>
