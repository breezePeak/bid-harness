/** 研究诊断来自真实工具结果与材料提交，充分性判断只提供语义需求和理由。 */
import { z } from 'zod'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { type BidResearchDiagnostics, type ResearchObservation, researchRequirementSchema } from './research-diagnostics-contract.ts'
export { type BidResearchDiagnostics, type ResearchObservation, researchDiagnosticsSchema, researchObservationSchema,
  researchRequirementSchema } from './research-diagnostics-contract.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
function unique(values: readonly string[]): string[] { return [...new Set(values)] }

/**
 * 从工具的实际接受参数与结果提取诊断；模型文本不产生执行或阅读记录。
 * @param exec 工具调用身份和参数。
 * @param result 工具执行结果。
 * @returns 查询、实际候选及经过工具确认的正文定位。
 */
export function observeResearchTool(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ResearchObservation {
  const args = object(exec.arguments)
  const value = result.isError ? undefined : object(result.value)
  const sources = Array.isArray(value?.sources) ? value.sources : []
  const materials = Array.isArray(value?.materials) ? value.materials : []
  const readRefs = exec.name === 'read_source' && typeof value?.body === 'string' && value.body.trim().length > 0
    ? [typeof value.chunk_ref === 'string' ? value.chunk_ref : '',
      ...materials.flatMap((material) => {
        const chunk = object(material)?.chunk
        return typeof value.file_id === 'string' && typeof chunk === 'string' ? [`L:${value.file_id}:${chunk}`] : []
      })].filter(Boolean)
    : []
  return {
    call_id: String(exec.callId), tool: exec.name,
    queries: exec.name === 'web_search' ? strings(args?.queries) : exec.name === 'search_sources' ? strings(args?.keywords) : [],
    candidate_urls: sources.flatMap((source) => {
      const url = object(source)?.url
      return typeof url === 'string' ? [url] : []
    }),
    read_refs: readRefs,
    fetched_source_ref: exec.name === 'web_fetch' && typeof value?.source_ref === 'string' ? value.source_ref : null,
    succeeded: !result.isError, failure_reason: result.isError ? result.error.message : null,
    ...(result.isError && result.error.info !== undefined ? { error_info: result.error.info } : {}),
  }
}

/**
 * 根据实际执行与各交接点生成可对账的诊断；不把招标条款当作参考资料。
 * @param observations 当前任务持久化的真实工具结果。
 * @param assessment 最新语义资料需求、缺口与排除理由。
 * @param adoptedRefs Child 已接纳的材料身份。
 * @param boundRefs 已持久化到章节映射的材料身份。
 * @param displayedRefs 展示契约实际返回的材料身份。
 * @returns 实际执行与交接诊断；历史观察缺失时次数为 null。
 */
export function deriveResearchDiagnostics(
  observations: readonly ResearchObservation[] | undefined,
  assessment: {
    evidence_requirement: z.infer<typeof researchRequirementSchema>
    sufficient_for_blueprint?: boolean
    unresolved_gaps: readonly { topic: string }[]
    excluded_materials?: readonly { material_ref: string; reason: string }[] | undefined
  } | undefined,
  adoptedRefs: readonly string[] = [], boundRefs: readonly string[] = [], displayedRefs: readonly string[] = [],
): BidResearchDiagnostics {
  const historyKnown = observations !== undefined
  observations = [...new Map((observations ?? []).map(item => [item.call_id, item])).values()]
  const adopted = unique(adoptedRefs), bound = unique(boundRefs), displayed = unique(displayedRefs)
  const read = unique(observations.flatMap(item => item.read_refs))
  const fetched = unique(observations.flatMap(item => item.fetched_source_ref === null ? [] : [item.fetched_source_ref]))
  const searches = observations.filter(item => item.tool === 'web_search')
  const candidates = unique(observations.flatMap(item => item.candidate_urls))
  const failures = observations.filter(item => !item.succeeded)
  let status: BidResearchDiagnostics['status'] = !historyKnown ? 'history_unknown'
    : observations.some(item => item.queries.length > 0 || item.read_refs.length > 0
      || item.tool === 'web_fetch' || !item.succeeded) ? 'researching' : 'not_started'
  if (bound.length > 0) status = bound.some(ref => !displayed.includes(ref)) ? 'display_omitted' : 'bound'
  else if (adopted.length > 0 || fetched.length > 0 && read.length === 0) status = 'saved_unbound'
  else if (read.length > 0) status = 'read_excluded'
  else if (failures.some(item => item.tool === 'web_fetch')) status = 'fetch_failed'
  else if (searches.length > 0 && candidates.length === 0) status = searches.some(item => item.succeeded) ? 'search_empty' : 'search_failed'
  return {
    status, requirement: assessment?.evidence_requirement ?? null,
    queries: unique(observations.flatMap(item => item.queries)), candidate_urls: candidates,
    searches: historyKnown ? searches.length : null,
    local_searches: historyKnown ? observations.filter(item => item.tool === 'search_sources').length : null,
    fetched: historyKnown ? fetched.length : null, read: historyKnown ? read.length : null,
    adopted: adopted.length, bound: bound.length, displayed: displayed.length,
    unresolved_gaps: assessment?.unresolved_gaps.map(item => item.topic) ?? [],
    failure_reasons: unique(failures.flatMap(item => item.failure_reason === null ? [] : [item.failure_reason])),
    exclusions: [...assessment?.excluded_materials ?? []], adopted_refs: adopted, bound_refs: bound, displayed_refs: displayed,
  }
}
