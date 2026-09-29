import { z } from 'zod'
import { applyOutlineEdits, buildOutlineView, type OutlineEditOperation, type OutlineViewSection } from './outline-confirmation-browser.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import type { TenderRequirementsArtifact, TenderScoringArtifact, TenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'

export { applyOutlineEdits, buildOutlineView }
export type { OutlineEditOperation, OutlineViewSection }

const text = z.string().min(1)
/** 模型与浏览器共用的结构化目录编辑参数。 */
export const outlineEditOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_section'), section_id: text, title: text.optional(), purpose: text.optional(), summary: text.optional(), must_answer: z.array(text).optional() }).strict().refine(value => value.title !== undefined || value.purpose !== undefined || value.summary !== undefined || value.must_answer !== undefined),
  z.object({ type: z.literal('add_section'), parent_id: z.string().min(1).nullable(), order: z.number().int().positive(), writable: z.boolean(), title: text, purpose: text, summary: text.optional(), must_answer: z.array(text).optional() }).strict().superRefine((value, context) => {
    if (value.writable && (value.must_answer?.length ?? 0) === 0) context.addIssue({ code: 'custom', message: 'a writable section requires must_answer' })
    if (!value.writable && (value.must_answer?.length ?? 0) !== 0) context.addIssue({ code: 'custom', message: 'a structural section cannot have must_answer' })
  }),
  z.object({ type: z.literal('delete_section'), section_id: text }).strict(),
  z.object({ type: z.literal('split_section'), section_id: text, children: z.array(z.object({ title: text, purpose: text, must_answer: z.array(text).min(1) }).strict()).min(2) }).strict(),
  z.object({ type: z.literal('merge_sections'), section_ids: z.array(text).min(2), title: text, purpose: text }).strict(),
  z.object({ type: z.literal('move_section'), section_id: text, parent_id: z.string().min(1).nullable(), order: z.number().int().positive() }).strict(),
])

/** 目录结构操作之后的业务归属；所有 ID 来自当前招标事实。 */
export const outlineBusinessBindingSchema = z.object({
  section_id: text,
  requirement_ids: z.array(text),
  scoring_ids: z.array(text),
  scoring_response_point_ids: z.array(z.string().regex(/^RP-\d{6}$/u)),
  compliance_ids: z.array(text),
}).strict()

/** 一次候选目录中的显式业务归属。 */
export type OutlineBusinessBinding = z.infer<typeof outlineBusinessBindingSchema>

/**
 * 在同一内存候选中更新真实业务 ID，最终完整性由 shared validator 检查。
 * @param outline 结构编辑后的目录。
 * @param bindings 明确重新分配的章节归属。
 * @param requirements 当前 Requirement 清单。
 * @param scoring 当前评分清单。
 * @param compliance 当前合规清单。
 * @param catalog 当前响应点清单。
 * @returns 业务归属更新后的候选目录。
 */
export function applyOutlineBusinessBindings(
  outline: OutlineArtifact, bindings: readonly OutlineBusinessBinding[],
  requirements: TenderRequirementsArtifact, scoring: TenderScoringArtifact,
  compliance: TenderComplianceArtifact, catalog: ScoringResponsePointCatalog,
): OutlineArtifact {
  const known = {
    requirement_ids: new Set(requirements.requirements.map(item => item.id)),
    scoring_ids: new Set(scoring.scoring_items.map(item => item.id)),
    compliance_ids: new Set(compliance.compliance_items.map(item => item.id)),
    scoring_response_point_ids: new Set(catalog.points.map(item => item.id)),
  }
  const points = new Map(catalog.points.map(point => [point.id, point]))
  const byId = new Map(outline.sections.map(section => [section.id, section]))
  const seen = new Set<string>()
  const updates = bindings.map(raw => outlineBusinessBindingSchema.parse(raw))
  for (const binding of updates) {
    const section = byId.get(binding.section_id)
    if (section === undefined || !section.writable || seen.has(section.id)) throw new Error('BID_OUTLINE_BINDING_SECTION_INVALID')
    seen.add(section.id)
    for (const key of ['requirement_ids', 'scoring_ids', 'compliance_ids', 'scoring_response_point_ids'] as const) {
      const ids = binding[key]
      if (new Set(ids).size !== ids.length || ids.some(id => !known[key].has(id))) {
        throw new Error(`BID_OUTLINE_BINDING_REFERENCE_INVALID: ${section.id}.${key}`)
      }
    }
    if (binding.scoring_response_point_ids.some(id => !binding.scoring_ids.includes(points.get(id)?.scoring_id ?? ''))) {
      throw new Error(`BID_OUTLINE_BINDING_SCORING_INVALID: ${section.id}`)
    }
  }
  const replacements = new Map(updates.map(binding => [binding.section_id, binding]))
  return { ...outline, sections: outline.sections.map((section) => {
    const binding = replacements.get(section.id)
    if (binding === undefined) return section
    return { ...section, requirement_ids: [...binding.requirement_ids], scoring_ids: [...binding.scoring_ids],
      compliance_ids: [...binding.compliance_ids],
      scoring_response_point_ids: [...binding.scoring_response_point_ids],
      scoring_response_points: binding.scoring_response_point_ids.map((id) => {
        const point = points.get(id)
        if (point === undefined) throw new Error(`BID_OUTLINE_BINDING_REFERENCE_INVALID: ${id}`)
        return { scoring_id: point.scoring_id, response_point: point.text }
      }) }
  }) }
}

/**
 * Parse browser-provided edit operations before they can affect an outline Artifact.
 * @param value Untrusted browser operation list.
 * @returns Validated outline edit operations.
 */
export function parseOutlineEditOperations(value: unknown): OutlineEditOperation[] {
  return z.array(outlineEditOperationSchema).parse(value) as OutlineEditOperation[]
}
