/** S3 局部修复复用目录编辑操作，响应点归属由模型显式选择。 */
import { z } from 'zod'
import { applyOutlineEdits, outlineEditOperationSchema, parseOutlineEditOperations } from './outline-confirmation-edits.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import { normalizeOutlineCandidate } from './outline-generation-normalization.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'

const ids = z.array(z.string().regex(/^RP-\d{6}$/u))
const [update, add, , split] = outlineEditOperationSchema.options
/** S3 专用候选操作；新增节点的编号仍由现有编辑器分配。 */
export const outlineRepairOperationSchema = z.union([
  update.safeExtend({ scoring_response_point_ids: ids.optional() }),
  add.safeExtend({ scoring_response_point_ids: ids.optional() }),
  split.extend({ children: z.array(split.shape.children.element.extend({ scoring_response_point_ids: ids })).min(2) }),
])

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
  let candidate = outline
  for (const operation of z.array(outlineRepairOperationSchema).parse(value)) {
    const before = candidate
    const priorIds = new Set(before.sections.map(section => section.id))
    if (operation.type === 'split_section') {
      const children = operation.children.map(({ scoring_response_point_ids: _ids, ...child }) => child)
      candidate = applyOutlineEdits(before, [{ ...operation, children }])
      candidate.sections.filter(section => !priorIds.has(section.id)).forEach((section, index) => {
        const input = operation.children[index]
        if (input === undefined) throw new Error('目录拆分产生的章节数量与操作不一致。')
        section.scoring_response_point_ids = input.scoring_response_point_ids
        section.scoring_response_points = []
      })
    } else {
      const { scoring_response_point_ids: selected, ...edit } = operation
      candidate = applyOutlineEdits(before, parseOutlineEditOperations([edit]))
      const section = candidate.sections.find(section => operation.type === 'update_section'
        ? section.id === operation.section_id : !priorIds.has(section.id))
      if (section === undefined) throw new Error('目录编辑未返回指定章节。')
      if (selected !== undefined) {
        if (!section.writable && selected.length > 0) throw new Error('结构章节 ' + section.id + ' 不能承担响应点。')
        if (operation.type === 'update_section' && operation.must_answer === undefined) throw new Error('修改 ' + section.id + ' 的响应点关联时必须同时提交具体 must_answer。')
        section.scoring_response_point_ids = selected
        section.scoring_response_points = []
      }
    }
    candidate = { ...candidate, sections: candidate.sections.map((section) => {
      const previous = before.sections.find(item => item.id === section.id)
      if (previous === undefined) return section
      const order = operation.type === 'add_section' && previous.parent_id === operation.parent_id ? section.order : previous.order
      return { ...section, order, level: previous.level }
    }) }
  }
  return normalizeOutlineCandidate(candidate, catalog, scoring)
}
