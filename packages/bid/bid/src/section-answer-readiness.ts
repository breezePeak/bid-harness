/** S4 当前候选与 S5 写作准备共用的任务目标及已接纳来源校验。 */
import { buildSectionAnswerChecklist, validateSectionAnswerPlan } from './section-answer-plan.ts'
import type { SectionEvidenceMapping } from './evidence-mapping-artifacts.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'

/**
 * 检查当前章节的逐项计划；历史产物仍可解析，缺失计划在准备阶段补齐。
 * @param section 当前章节职责与覆盖关联。
 * @param mapping 当前章节映射；调用方先过滤不可用来源。
 * @param records 当前章节适用的正式 S2 记录。
 * @returns 缺失、过期目标或未接纳来源的诊断；空数组表示可复用。
 */
export function validateMappingAnswerPlan(
  section: Pick<OutlineArtifact['sections'][number], 'id' | 'must_answer'>,
  mapping: Pick<SectionEvidenceMapping, 'answer_plan' | 'local_materials'> & {
    web_materials: readonly { source_id?: string; chunk_refs: readonly string[] }[]
  },
  records: {
    requirements: readonly { id: string; normalized_requirement: string }[]
    scoring: readonly { id: string }[]
    responsePoints: readonly { id: string; text: string }[]
    compliance: readonly { id: string; normalized_rule: string }[]
  },
): string[] {
  const checklist = buildSectionAnswerChecklist({ section, ...records })
  const sourceKeys = new Set([
    's2:project:', `section:${section.id}`,
    ...records.requirements.map(item => `s2:requirement:${item.id}`),
    ...records.scoring.map(item => `s2:scoring:${item.id}`),
    ...records.responsePoints.map(item => `s2:response_point:${item.id}`),
    ...records.compliance.map(item => `s2:compliance:${item.id}`),
    ...mapping.local_materials.map(item => `local:${item.file_id}:${item.chunk}`),
    ...mapping.answer_plan?.flatMap(item => item.basis.flatMap(basis => basis.kind === 'web'
      && mapping.web_materials.some(material => (material.source_id ?? material.chunk_refs[0]?.slice(2, 22)) === basis.source_id
        && basis.chunk_refs.every(ref => material.chunk_refs.includes(ref)))
      ? [`web:${basis.source_id}:${basis.chunk_refs.join(',')}`] : [])) ?? [],
  ])
  return validateSectionAnswerPlan(mapping.answer_plan, checklist, sourceKeys)
}
