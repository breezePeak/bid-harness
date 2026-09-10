import { describe, expect, it } from 'vitest'
import {
  materializeAcceptanceCriteria,
  validateWritingPlan,
  type AcceptanceCriterionInput,
  type WritingPlanInput,
} from '../src/writing-requirements.ts'
import { assessBoundedMetric, evaluateHostAcceptanceCriteria } from '../src/acceptance-criteria.ts'
import { outlineFixture, writingPlanFixture } from './fixtures/chapter-writing-inputs.ts'
import { renderStageInteractionPrompt, stageInteractionSchema } from '../src/stage-interaction.ts'

function semantic(description: string, priority: 'required' | 'preferred' = 'required'): AcceptanceCriterionInput {
  return { description, priority, evaluator: { kind: 'semantic' } }
}

function inputFixture(): WritingPlanInput {
  const plan = writingPlanFixture(outlineFixture())
  return {
    user_requirements: plan.user_requirements,
    global_instructions: plan.global_instructions,
    document_acceptance: plan.document_acceptance.map(({ id: _id, scope: _scope, ...criterion }) => criterion),
    sections: plan.sections.map(section => ({
      ...section,
      acceptance_criteria: section.acceptance_criteria.map(({ id: _id, scope: _scope, ...criterion }) => criterion),
    })),
    revision: null,
  }
}

describe('S5 通用写作任务契约', () => {
  it('Main Agent 只提交语义契约，Host 字段不出现在工具输入中', () => {
    const prompt = renderStageInteractionPrompt('chapter_writing')
    expect(prompt).toContain('自然语言要求')
    expect(prompt).toContain('global_instructions')
    expect(prompt).toContain('条件 ID、作用域、计划版本和执行状态由 Host 生成')
    const input = inputFixture()
    const parsed = stageInteractionSchema.parse({ action: 'bid_confirm_writing_plan', ...input })
    expect(parsed).toMatchObject({ action: 'bid_confirm_writing_plan', global_instructions: input.global_instructions })
    expect(() => stageInteractionSchema.parse({
      action: 'bid_confirm_writing_plan',
      ...input,
      document_acceptance: [{ ...input.document_acceptance[0], id: 'MODEL-ID' }],
    })).toThrow()
  })

  it('不同自然语言要求使用同一任务与验收协议', () => {
    const requirements: AcceptanceCriterionInput[] = [
      { description: '整本至少 200 页', priority: 'required', evaluator: { kind: 'deterministic', metric: 'estimated_pages', min: 200, max: null } },
      semantic('第三章详细一点，其他章节保持现在这样'),
      semantic('最好多使用一些表格', 'preferred'),
      semantic('不要出现没有资料证明的企业能力'),
      semantic('重点突出实施风险控制'),
    ]
    for (const criterion of requirements) {
      const input = { ...inputFixture(), document_acceptance: [criterion] }
      expect(stageInteractionSchema.parse({ action: 'bid_confirm_writing_plan', ...input }).document_acceptance)
        .toEqual([criterion])
    }
  })

  it('Host 生成作用域和 ID，并为未变化条件复用 ID', () => {
    const input = inputFixture()
    const first = materializeAcceptanceCriteria(input)
    expect(first.document_acceptance[0]).toMatchObject({ id: 'AC-000001', scope: { kind: 'document' } })
    expect(first.sections[0]?.acceptance_criteria[0]).toMatchObject({
      id: 'AC-000002', scope: { kind: 'section', section_id: 'SEC-1' },
    })
    const previous = writingPlanFixture(outlineFixture())
    const updated = materializeAcceptanceCriteria({
      ...input,
      sections: input.sections.map(section => section.section_id === 'SEC-2' ? {
        ...section, acceptance_criteria: [semantic('第二章采用新的验收条件。')],
      } : section),
    }, previous)
    expect(updated.sections[0]?.acceptance_criteria[0]?.id).toBe('AC-000002')
    expect(updated.sections[1]?.acceptance_criteria[0]?.id).toBe('AC-000005')
    expect(updated.sections[2]?.acceptance_criteria[0]?.id).toBe('AC-000004')
  })

  it('只接受覆盖全部可写叶节的契约和最小显式影响范围', () => {
    const input = inputFixture()
    const invalid: WritingPlanInput = {
      ...input,
      sections: [
        { ...input.sections[0]!, section_id: 'STRUCT' },
        input.sections[1]!,
      ],
      revision: { summary: '只调整第二章。', affected_section_ids: ['SEC-2', 'SEC-2', 'STRUCT'] },
    }
    expect(validateWritingPlan(invalid, outlineFixture())).toEqual(expect.arrayContaining([
      expect.stringContaining('不是已确认目录中的可写叶节'),
      expect.stringContaining('缺少可写叶节：SEC-1'),
      expect.stringContaining('缺少可写叶节：SEC-3'),
      expect.stringContaining('重复：SEC-2'),
      expect.stringContaining('非可写叶节：STRUCT'),
    ]))
  })

  it('确定性执行只读取 evaluator 判别标签，不读取条件描述', () => {
    const semanticCriterion = {
      ...semantic('整本至少 200 页'), id: 'AC-000001', scope: { kind: 'document' as const },
    }
    const deterministicCriterion = {
      description: '任意描述', priority: 'required' as const,
      evaluator: { kind: 'deterministic' as const, metric: 'estimated_pages' as const, min: 200, max: null },
      id: 'AC-000002', scope: { kind: 'document' as const },
    }
    expect(evaluateHostAcceptanceCriteria([semanticCriterion], { estimatedPages: 199.999 })).toEqual([])
    expect(evaluateHostAcceptanceCriteria([deterministicCriterion], { estimatedPages: 199.999 })[0])
      .toMatchObject({ criterion_id: 'AC-000002', status: 'unmet', measured: 199.999 })
    const below = assessBoundedMetric(200, null, 199.999)
    const above = assessBoundedMetric(null, 200, 200.001)
    expect(below.status).toBe('below')
    expect(below.difference).toBeCloseTo(0.001)
    expect(above.status).toBe('above')
    expect(above.difference).toBeCloseTo(0.001)
  })
})
