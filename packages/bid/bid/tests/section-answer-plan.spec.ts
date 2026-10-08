import { describe, expect, it } from 'vitest'
import { bindSectionAnswerPlan, buildSectionAnswerChecklist, reconcileSectionAnswerPlan, validateSectionAnswerPlan } from '../src/section-answer-plan.ts'

describe('section answer plan', () => {
  const tasks = (must_answer: string[]) => buildSectionAnswerChecklist({
    section: { must_answer }, requirements: [], responsePoints: [], compliance: [],
  })
  const checklist = buildSectionAnswerChecklist({
    section: { must_answer: ['说明实施方法'] },
    requirements: [{ id: 'REQ-1', normalized_requirement: '说明验收参数' }],
    responsePoints: [], compliance: [],
  })

  it('将 R 引用绑定到真实任务，并允许同一目标有方案与缺口', () => {
    const plan = bindSectionAnswerPlan([
      { target_refs: ['R1'], mode: 'proposal', content: '拟采用分阶段核验方法。',
        basis: [{ kind: 'section_responsibility' }], boundary: '具体参数待项目确认。' },
      { target_refs: ['R2'], mode: 'gap', content: '当前没有验收参数。', basis: [],
        boundary: '不能承诺数值。', required_input: '请提供验收参数。' },
    ], checklist, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' })
    expect(plan[0]?.targets).toEqual([{ kind: 'must_answer', position: 0, text: '说明实施方法' }])
    expect(plan[1]?.targets).toEqual([{ kind: 'requirement', id: 'REQ-1' }])
    expect(validateSectionAnswerPlan(plan, checklist, new Set(['section:SEC-1']))).toEqual([])
  })

  it('拒绝仅靠章节职责声称事实已得到支持', () => {
    expect(() => bindSectionAnswerPlan([
      { target_refs: ['R1', 'R2'], mode: 'supported', content: '已有验收能力。',
        basis: [{ kind: 'section_responsibility' }], boundary: '按当前章节实施。' },
    ], checklist, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' }))
      .toThrow('章节职责不能单独证明事实')
  })

  it('拒绝未读材料和遗漏任务，并识别旧 must_answer 位置', () => {
    expect(() => bindSectionAnswerPlan([
      { target_refs: ['R1'], mode: 'supported', content: '资料证明已完成。',
        basis: [{ kind: 'local', material_ref: 'M1:chunk_0001' }], boundary: '仅限资料记录。' },
    ], checklist, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' }))
      .toThrow('ANSWER_PLAN_LOCAL_UNREAD')
    const prior = bindSectionAnswerPlan([
      { target_refs: ['R1', 'R2'], mode: 'proposal', content: '拟按招标任务设计核验流程。',
        basis: [{ kind: 'section_responsibility' }], boundary: '不证明既有指标。' },
    ], checklist, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' })
    const changed = buildSectionAnswerChecklist({ section: { must_answer: ['说明另一种实施方法'] },
      requirements: [{ id: 'REQ-1', normalized_requirement: '说明验收参数' }], responsePoints: [], compliance: [] })
    expect(validateSectionAnswerPlan(prior, changed, new Set(['section:SEC-1']))).toContain(
      'answer_plan.0.targets: 目标不属于当前章节任务。',
    )
  })

  it('唯一必答项重排时保留语义回应，增删只移除失效目标', () => {
    const before = tasks(['实施方法', '验收方法'])
    const plan = bindSectionAnswerPlan(before.map(item => ({ target_refs: [item.item_ref], mode: 'proposal',
      content: item.text, basis: [{ kind: 'section_responsibility' }], boundary: '不证明未经确认的事实。' })),
    before, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' })
    expect(reconcileSectionAnswerPlan(plan, before, before)).toEqual(plan)
    const reordered = tasks(['验收方法', '实施方法'])
    const rebound = reconcileSectionAnswerPlan(plan, before, reordered)!
    expect(rebound.map(item => item.targets)).toEqual([
      [{ kind: 'must_answer', position: 1, text: '实施方法' }],
      [{ kind: 'must_answer', position: 0, text: '验收方法' }],
    ])
    expect(validateSectionAnswerPlan(rebound, reordered, new Set(['section:SEC-1']))).toEqual([])
    const changed = tasks(['实施方法', '质量方法'])
    expect(reconcileSectionAnswerPlan(plan, before, changed)).toEqual([plan[0]])
    const incomplete = reconcileSectionAnswerPlan(plan, before, changed)!
    expect(validateSectionAnswerPlan(incomplete, changed, new Set(['section:SEC-1']))).toEqual(['answer_plan: 未回应 R2。'])
  })

  it('重复必答原文被移动时不猜测计划对应的项', () => {
    const before = tasks(['同名回应', '同名回应', '验收方法'])
    const plan = bindSectionAnswerPlan(before.map(item => ({ target_refs: [item.item_ref], mode: 'proposal',
      content: item.text, basis: [{ kind: 'section_responsibility' }], boundary: '不证明未经确认的事实。' })),
    before, { s2Keys: new Set(), local: new Map(), webChunkRefs: new Set(), sectionId: 'SEC-1' })
    expect(reconcileSectionAnswerPlan(plan, before, tasks(['验收方法', '同名回应', '同名回应']))!.map(item => item.targets))
      .toEqual([[{ kind: 'must_answer', position: 1, text: '同名回应' }], [{ kind: 'must_answer', position: 0, text: '验收方法' }]])
  })
})
