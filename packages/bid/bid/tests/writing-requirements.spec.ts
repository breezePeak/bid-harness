import { describe, expect, it } from 'vitest'
import { outlineArtifactSha256, parseWritingPlan, validateWritingPlan } from '@deepseek-ai/dsh-bid'
import { outlineFixture, writingPlanFixture } from './fixtures/chapter-writing-inputs.ts'
import { renderStageInteractionPrompt, stageInteractionSchema } from '../src/stage-interaction.ts'

describe('S5 整体写作要求计划', () => {
  it('向 Main Agent 开放自然语言计划确认，而不是固定选项或直接写作', () => {
    const prompt = renderStageInteractionPrompt('chapter_writing')
    expect(prompt).toContain('自然语言要求')
    expect(prompt).toContain('没有特殊要求，直接开始')
    expect(prompt).toContain('bid_confirm_writing_plan')
    expect(prompt).toContain('不要直接 write Artifact 或调用其他工具启动章节任务')
    const { schema_version: _schema, scope: _scope, plan_version: _version, confirmed: _confirmed,
      confirmed_outline_sha256: _hash, ...input } = writingPlanFixture(outlineFixture())
    expect(stageInteractionSchema.parse({ action: 'bid_confirm_writing_plan', ...input }))
      .toMatchObject({ action: 'bid_confirm_writing_plan', overall_goal: input.overall_goal })
  })

  it('只汇总可写叶节预算，并保持整书目标口径一致', () => {
    const outline = outlineFixture()
    const plan = {
      ...writingPlanFixture(outline),
      user_requirements: ['整份约 200 页，重点展开第一章，按这些要求直接开始'],
      page_target: { kind: 'approximate' as const, min_pages: 190, max_pages: 210, estimate_basis: '按用户提供的 Word 模板版式估算，实际页数排版后核对。' },
      priorities: [{ section_ids: ['SEC-1'], instruction: '重点展开技术路线。' }],
      sections: [
        { section_id: 'SEC-1', emphasis: 'detailed' as const, page_budget: { min_pages: 100, max_pages: 110 }, instructions: ['展开技术路线。'] },
        { section_id: 'SEC-2', emphasis: 'standard' as const, page_budget: { min_pages: 60, max_pages: 65 }, instructions: [] },
        { section_id: 'SEC-3', emphasis: 'concise' as const, page_budget: { min_pages: 30, max_pages: 35 }, instructions: [] },
      ],
    }

    expect(validateWritingPlan(plan, outline)).toEqual([])
    expect(parseWritingPlan({ ...plan, confirmed_outline_sha256: outlineArtifactSha256(outline) }).user_requirements)
      .toEqual(plan.user_requirements)

    const minimum = {
      ...plan,
      user_requirements: ['至少 200 页，按这些要求直接开始'],
      page_target: { kind: 'minimum' as const, min_pages: 200, max_pages: null, estimate_basis: '按现有版式估算下限。' },
      sections: [
        { section_id: 'SEC-1', emphasis: 'detailed' as const, page_budget: { min_pages: 100, max_pages: null }, instructions: [] },
        { section_id: 'SEC-2', emphasis: 'standard' as const, page_budget: { min_pages: 60, max_pages: null }, instructions: [] },
        { section_id: 'SEC-3', emphasis: 'standard' as const, page_budget: { min_pages: 40, max_pages: null }, instructions: [] },
      ],
    }
    expect(validateWritingPlan(minimum, outline)).toEqual([])
    expect(parseWritingPlan({ ...minimum, confirmed_outline_sha256: outlineArtifactSha256(outline) }).page_target)
      .toMatchObject({ kind: 'minimum', min_pages: 200, max_pages: null })
  })

  it('拒绝父节点预算、叶节遗漏和不一致的整书汇总', () => {
    const outline = outlineFixture()
    const plan = writingPlanFixture(outline)
    const invalid = {
      ...plan,
      page_target: { kind: 'range' as const, min_pages: 11, max_pages: 21, estimate_basis: '排版估算。' },
      sections: [
        { section_id: 'STRUCT', emphasis: 'standard' as const, page_budget: { min_pages: 5, max_pages: 10 }, instructions: [] },
        { section_id: 'SEC-1', emphasis: 'standard' as const, page_budget: { min_pages: 5, max_pages: 10 }, instructions: [] },
      ],
    }

    expect(validateWritingPlan(invalid, outline)).toEqual(expect.arrayContaining([
      expect.stringContaining('不是已确认目录中的可写叶节'),
      expect.stringContaining('缺少可写叶节：SEC-2'),
      expect.stringContaining('叶节最小页数预算汇总'),
    ]))
  })

  it('变更影响范围只接受可写叶节且不能重复', () => {
    const outline = outlineFixture()
    const plan = {
      ...writingPlanFixture(outline),
      revision: { base_plan_version: 1, summary: '只调整第二章。', affected_section_ids: ['SEC-2', 'SEC-2', 'STRUCT'] },
      plan_version: 2,
    }

    expect(validateWritingPlan(plan, outline)).toEqual(expect.arrayContaining([
      expect.stringContaining('重复：SEC-2'),
      expect.stringContaining('非可写叶节：STRUCT'),
    ]))
  })
})
