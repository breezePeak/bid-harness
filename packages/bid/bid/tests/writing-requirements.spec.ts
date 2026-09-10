import { describe, expect, it } from 'vitest'
import {
  applyWritingPlanInput,
  validateWritingPlan,
  validateWritingPlanInput,
  type AcceptanceCriterionInput,
  type ResolvedWritingRequirementMessage,
  type WritingPlan,
  type WritingPlanInput,
} from '../src/writing-requirements.ts'
import { assessBoundedMetric, evaluateHostAcceptanceCriteria } from '../src/acceptance-criteria.ts'
import { outlineFixture, writingPlanFixture } from './fixtures/chapter-writing-inputs.ts'
import { renderStageInteractionPrompt, stageInteractionSchema } from '../src/stage-interaction.ts'

const firstRef = { session_id: 'main', message_id: 'message-1', seq: 1 }
const secondRef = { session_id: 'main', message_id: 'message-2', seq: 2 }

function semantic(description: string, priority: 'required' | 'preferred' = 'required'): AcceptanceCriterionInput {
  return { description, priority, evaluator: { kind: 'semantic' } }
}

function inputFixture(): WritingPlanInput {
  const plan = writingPlanFixture(outlineFixture())
  return {
    update_kind: 'initial',
    user_message_refs: [firstRef],
    global_instructions: plan.global_instructions,
    document_acceptance: [],
    sections: plan.sections.map(section => ({
      section_id: section.section_id,
      task: section.task,
      user_message_refs: [],
      writing_instructions: section.writing_instructions,
      acceptance_criteria: [],
    })),
  }
}

const messages = (...entries: Array<[typeof firstRef, string]>): ResolvedWritingRequirementMessage[] =>
  entries.map(([ref, text]) => ({ ref, text }))

function persisted(input: WritingPlanInput): WritingPlan {
  const materialized = applyWritingPlanInput(input, messages([firstRef, '没有特殊要求，直接开始']))
  return {
    schema_version: 3,
    scope: 'technical_bid',
    plan_version: 1,
    confirmed: true,
    confirmed_outline_sha256: 'a'.repeat(64),
    ...materialized,
    revision: null,
  }
}

describe('S5 通用写作任务契约', () => {
  it('Main Agent 只提交真实消息引用和语义契约，Host 字段不出现在工具输入中', () => {
    const prompt = renderStageInteractionPrompt('chapter_writing')
    expect(prompt).toContain('user_message_refs')
    expect(prompt).toContain('条件 ID、作用域、计划版本和执行状态由 Host 生成')
    expect(prompt).toContain('update_kind=patch')
    const input = inputFixture()
    const parsed = stageInteractionSchema.parse({ action: 'bid_confirm_writing_plan', ...input })
    expect(parsed).toMatchObject({ action: 'bid_confirm_writing_plan', update_kind: 'initial' })
    expect(() => stageInteractionSchema.parse({
      action: 'bid_confirm_writing_plan',
      ...input,
      document_acceptance: [{ ...semantic('正式表达。'), id: 'MODEL-ID' }],
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

  it('Host 生成作用域和全局唯一 ID；patch 保留未变化值和 ID', () => {
    const initial = inputFixture()
    initial.document_acceptance = [semantic('整书术语一致。')]
    initial.sections[0]!.acceptance_criteria = [semantic('不得出现无依据企业能力。')]
    const previous = persisted(initial)
    expect(previous.document_acceptance[0]).toMatchObject({ id: 'AC-000001', scope: { kind: 'document' } })
    expect(previous.sections[0]?.acceptance_criteria[0]).toMatchObject({
      id: 'AC-000002', scope: { kind: 'section', section_id: 'SEC-1' },
    })

    const patch: WritingPlanInput = {
      update_kind: 'patch', base_plan_version: 1,
      user_message_refs: [secondRef], summary: '只细化第二章。', affected_section_ids: [],
      sections: [{
        section_id: 'SEC-2', task: '详细完成第二章。', add_user_message_refs: [secondRef],
        acceptance_criteria: { add: [semantic('正式说明实施责任。')], update: [], delete: [] },
      }],
    }
    const updated = applyWritingPlanInput(patch, messages([secondRef, '第二章写详细一点，其他章节不用动。']), previous)
    expect(updated.sections[0]).toBe(previous.sections[0])
    expect(updated.sections[0]?.acceptance_criteria[0]?.id).toBe('AC-000002')
    expect(updated.sections[1]?.acceptance_criteria[0]?.id).toBe('AC-000003')
    expect(updated.affected_section_ids).toEqual(['SEC-2'])
    expect(updated.user_requirements).toEqual(['没有特殊要求，直接开始', '第二章写详细一点，其他章节不用动。'])
  })

  it('拒绝错误范围、错误作用域和全局重复 AC ID', () => {
    const input = inputFixture()
    input.sections = [
      { ...input.sections[0]!, section_id: 'STRUCT' },
      input.sections[1]!,
    ]
    expect(validateWritingPlanInput(input, outlineFixture())).toEqual(expect.arrayContaining([
      expect.stringContaining('不是已确认目录中的可写叶节'),
      expect.stringContaining('缺少可写叶节：SEC-1'),
      expect.stringContaining('缺少可写叶节：SEC-3'),
    ]))

    const plan = writingPlanFixture(outlineFixture())
    const duplicate = {
      id: 'AC-000001', description: '条件', priority: 'required' as const,
      evaluator: { kind: 'semantic' as const }, scope: { kind: 'document' as const },
    }
    plan.document_acceptance = [duplicate]
    plan.sections[0]!.acceptance_criteria = [{ ...duplicate, scope: { kind: 'section', section_id: 'SEC-2' } }]
    expect(validateWritingPlan(plan, outlineFixture())).toEqual(expect.arrayContaining([
      expect.stringContaining('全局重复'),
      expect.stringContaining('scope 与所在容器不一致'),
    ]))
  })

  it('没有额外动态条件时允许 criteria 为空', () => {
    const input = inputFixture()
    expect(validateWritingPlanInput(input, outlineFixture())).toEqual([])
    const plan = persisted(input)
    expect(plan.document_acceptance).toEqual([])
    expect(plan.sections.every(section => section.acceptance_criteria.length === 0)).toBe(true)
    expect(validateWritingPlan(plan, outlineFixture())).toEqual([])
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
