/** S3 局部修复复用目录编辑操作，响应点归属由模型显式选择。 */
import { z } from 'zod'
import { applyOutlineEdits, outlineEditOperationSchema, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { outlineSectionSchema, type OutlineArtifact, type OutlineSection } from './outline-generation-artifacts.ts'
import { normalizeOutlineCandidate } from './outline-generation-normalization.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { validateOutlineSharedStructure } from './outline-shared-validator.ts'
import type { StageValidationIssue } from './control-plane-contract.ts'

const ids = z.array(z.string().regex(/^RP-\d{6}$/u))
const [update, add, remove, split, merge, move] = outlineEditOperationSchema.options
const references = z.object({
  requirement_ids: outlineSectionSchema.shape.requirement_ids.optional(),
  scoring_ids: outlineSectionSchema.shape.scoring_ids.optional(),
  compliance_ids: outlineSectionSchema.shape.compliance_ids.optional(),
  framework_refs: outlineSectionSchema.shape.framework_refs,
  origin: outlineSectionSchema.shape.origin.optional(),
  scoring_response_point_ids: ids.optional(),
}).strict()
/** S3 专用候选操作；新增节点的编号仍由现有编辑器分配。 */
export const outlineRepairOperationSchema = z.union([
  update.safeExtend({ scoring_response_point_ids: ids.optional() }),
  add.safeExtend({ scoring_response_point_ids: ids.optional() }),
  split.extend({ children: z.array(split.shape.children.element.extend({ scoring_response_point_ids: ids })).min(2) }),
])

/** S3 业务引用与结构修复；普通浏览器编辑 Schema 不包含这些权限。 */
export const outlineAssociationRepairOperationSchema = z.union([
  z.object({ ...update.shape, ...references.shape }).strict().refine(operation => Object.keys(operation).length > 2),
  add.safeExtend(references.shape),
  split.extend({ children: z.array(split.shape.children.element.extend(references.shape)).min(2) }),
  remove, merge, move,
  z.object({ type: z.literal('update_global_compliance'), global_compliance_ids: outlineSectionSchema.shape.compliance_ids }).strict(),
  z.object({ type: z.literal('repair_structure'), section_index: z.number().int().nonnegative(),
    id: outlineSectionSchema.shape.id.optional(), parent_id: outlineSectionSchema.shape.parent_id.optional(),
    order: outlineSectionSchema.shape.order.optional(), level: outlineSectionSchema.shape.level.optional(),
    writable: outlineSectionSchema.shape.writable.optional(),
  }).strict().refine(operation => Object.keys(operation).length > 2),
])

function applyReferences(section: OutlineSection, input: z.infer<typeof references>): void {
  Object.assign(section, input)
  if (input.scoring_response_point_ids !== undefined) section.scoring_response_points = []
}

/**
 * 应用模型选择的局部目录编辑并重建派生引用。
 * @param outline 当前候选。
 * @param value 模型返回的局部操作数组。
 * @param catalog 只读正式响应点。
 * @param scoring 正式评分项。
 * @returns 应用局部编辑并规范化的候选，不改动其他章节内容。
 */
export function applyOutlineRepair(
  outline: OutlineArtifact, value: unknown, catalog: ScoringResponsePointCatalog, scoring: TenderScoringArtifact,
): OutlineArtifact {
  let candidate = structuredClone(outline)
  for (const operation of z.array(outlineAssociationRepairOperationSchema).parse(value)) {
    const before = candidate
    const priorIds = new Set(before.sections.map(section => section.id))
    if (operation.type === 'update_global_compliance') {
      candidate.global_compliance_ids = operation.global_compliance_ids
      continue
    }
    if (operation.type === 'repair_structure') {
      const section = candidate.sections[operation.section_index]
      if (section === undefined) throw new Error('结构修复指定的章节不存在。')
      if (operation.id !== undefined && candidate.sections.filter(item => item.id === section.id).length < 2) throw new Error('只能为重复 ID 的节点分配新标识，不能改写已有稳定 ID。')
      const { type: _type, section_index: _index, ...patch } = operation
      Object.assign(section, patch)
      continue
    }
    const structureIssues: StageValidationIssue[] = []
    validateOutlineSharedStructure(candidate.sections, structureIssues)
    if (structureIssues.some(issue => ['OUTLINE_SHARED_SECTION_ID_DUPLICATE', 'OUTLINE_SHARED_SECTION_CYCLE', 'OUTLINE_SHARED_SECTION_SELF_PARENT'].includes(issue.code))) throw new Error('目录存在重复 ID 或循环，请先用 repair_structure 修正对应节点。')
    if (operation.type === 'split_section') {
      const children = operation.children.map(child => split.shape.children.element.strip().parse(child))
      candidate = applyOutlineEdits(before, [{ ...operation, children }])
      candidate.sections.filter(section => !priorIds.has(section.id)).forEach((section, index) => {
        const input = operation.children[index]
        if (input === undefined) throw new Error('目录拆分产生的章节数量与操作不一致。')
        applyReferences(section, references.strip().parse(input))
      })
    } else if (operation.type === 'update_section' || operation.type === 'add_section') {
      const selected = references.strip().parse(operation)
      const edit = operation.type === 'update_section' ? z.object(update.shape).strip().parse(operation) : add.strip().parse(operation)
      candidate = applyOutlineEdits(before, [edit as OutlineEditOperation])
      const section = candidate.sections.find(section => operation.type === 'update_section'
        ? section.id === operation.section_id : !priorIds.has(section.id))
      if (section === undefined) throw new Error('目录编辑未返回指定章节。')
      if (selected.scoring_response_point_ids !== undefined) {
        if (!section.writable && selected.scoring_response_point_ids.length > 0) throw new Error('结构章节 ' + section.id + ' 不能承担响应点。')
        if (operation.type === 'update_section' && operation.must_answer === undefined) throw new Error('修改 ' + section.id + ' 的响应点关联时必须同时提交具体 must_answer。')
      }
      applyReferences(section, selected)
    } else {
      candidate = applyOutlineEdits(before, [operation])
    }
    candidate = { ...candidate, sections: candidate.sections.map((section) => {
      const previous = before.sections.find(item => item.id === section.id)
      if (previous === undefined) return section
      const structural = operation.type === 'move_section' || operation.type === 'delete_section' || operation.type === 'merge_sections'
      const order = structural || operation.type === 'add_section' && previous.parent_id === operation.parent_id ? section.order : previous.order
      return { ...section, order, level: structural ? section.level : previous.level }
    }) }
  }
  return normalizeOutlineCandidate(candidate, catalog, scoring)
}
