/** 当前研究候选与写作防御准备使用同一目标、覆盖及来源判断。 */
import { describe, expect, it } from 'vitest'
import { validateMappingAnswerPlan } from '../src/section-answer-readiness.ts'
import type { SectionAnswerPlan } from '../src/section-answer-plan.ts'

const section = { id: 'chapter', must_answer: ['说明实施方法。'] }
const records = { requirements: [], scoring: [], responsePoints: [], compliance: [] }
const plan: SectionAnswerPlan = [{ targets: [{ kind: 'must_answer', position: 0, text: section.must_answer[0]! }],
  mode: 'supported', content: '参考材料明确说明实施方法。', boundary: '仅证明参考资料中的方法。',
  basis: [{ kind: 'web', source_id: 'WEB-0123456789abcdef', chunk_refs: ['W:WEB-0123456789abcdef:C0001'] }],
}]

describe('章节依据就绪判断', () => {
  it('缺计划和真实新增目标需要补齐，等价任务保留原回应', () => {
    const mapping = { local_materials: [], web_materials: [] }
    expect(validateMappingAnswerPlan(section, mapping, records)).toEqual(['answer_plan: 当前章节尚未完成任务级依据准备。'])
    const ready = { ...mapping, answer_plan: [{ ...plan[0]!, mode: 'proposal' as const,
      basis: [{ kind: 'section_responsibility' as const, section_id: section.id }] }] }
    expect(validateMappingAnswerPlan(section, ready, records)).toEqual([])
    expect(validateMappingAnswerPlan({ ...section, must_answer: [...section.must_answer, '补充验收方法。'] }, ready, records))
      .toEqual(['answer_plan: 未回应 R2。'])
  })
  it('Web 计划同时要求来源与片段匹配，正式和中间映射共用判断', () => {
    const material = { source_id: 'WEB-0123456789abcdef', chunk_refs: ['W:WEB-0123456789abcdef:C0001'] }
    const mapping = { local_materials: [], web_materials: [material], answer_plan: plan }
    expect(validateMappingAnswerPlan(section, mapping, records)).toEqual([])
    expect(validateMappingAnswerPlan(section, { ...mapping,
      web_materials: [{ chunk_refs: material.chunk_refs }] }, records)).toEqual([])
    expect(validateMappingAnswerPlan(section, { ...mapping,
      web_materials: [{ ...material, source_id: 'WEB-fedcba9876543210' }] }, records)[0]).toContain('未接受的依据')
    expect(validateMappingAnswerPlan(section, { ...mapping,
      web_materials: [{ ...material, chunk_refs: ['W:WEB-0123456789abcdef:C0002'] }] }, records)[0]).toContain('未接受的依据')
  })
})
