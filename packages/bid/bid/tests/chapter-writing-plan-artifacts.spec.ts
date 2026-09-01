import { describe, expect, it } from 'vitest'
import {
  parseChapterExecutionPlan,
  validateChapterExecutionPlan,
  type ChapterExecutionPlan,
  type OutlineArtifact,
} from '@deepseek-ai/dsh-bid'

const hash = 'a'.repeat(64)
const outline: OutlineArtifact = {
  schema_version: 2,
  scope: 'technical_bid',
  document_title: '技术标',
  global_compliance_ids: [],
  sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '结构', purpose: '结构', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', content_mode: null, source_mapping_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...['A', 'B', 'C'].map((id, index) => ({ id, parent_id: 'STRUCT', order: index + 1, level: 2, title: id, purpose: id, writable: true, must_answer: [id], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const, content_mode: 'write_new' as const, source_mapping_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ],
}

function validPlan(): ChapterExecutionPlan {
  return {
    schema_version: 2 as const,
    scope: 'technical_bid' as const,
    confirmed_outline_sha256: hash,
    global_consistency_notes: ['统一术语。'],
    sections: [
      { section_id: 'A', depends_on: [], related_sections: [{ section_id: 'C', strength: 'weak' as const, reason: '共享术语。' }], planning_notes: [] },
      { section_id: 'B', depends_on: [{ section_id: 'A', reason: '复用 A 的架构结论。' }], related_sections: [], planning_notes: [] },
      { section_id: 'C', depends_on: [], related_sections: [], planning_notes: [] },
    ],
  }
}

describe('chapter execution plan', () => {
  it('accepts complete acyclic coverage', () => {
    expect(validateChapterExecutionPlan(parseChapterExecutionPlan(validPlan()), outline, hash)).toEqual([])
  })

  it.each([
    ['hash', (plan: ReturnType<typeof validPlan>) => { plan.confirmed_outline_sha256 = 'b'.repeat(64) }, 'CHAPTER_PLAN_OUTLINE_HASH_INVALID'],
    ['missing', (plan: ReturnType<typeof validPlan>) => { plan.sections.pop() }, 'CHAPTER_PLAN_SECTION_MISSING'],
    ['duplicate', (plan: ReturnType<typeof validPlan>) => { plan.sections[2]!.section_id = 'A' }, 'CHAPTER_PLAN_SECTION_DUPLICATE'],
    ['unknown section', (plan: ReturnType<typeof validPlan>) => { plan.sections[2]!.section_id = 'UNKNOWN' }, 'CHAPTER_PLAN_SECTION_UNKNOWN'],
    ['non-writable section', (plan: ReturnType<typeof validPlan>) => { plan.sections[2]!.section_id = 'STRUCT' }, 'CHAPTER_PLAN_SECTION_UNKNOWN'],
    ['unknown dependency', (plan: ReturnType<typeof validPlan>) => { plan.sections[1]!.depends_on[0]!.section_id = 'UNKNOWN' }, 'CHAPTER_PLAN_DEPENDENCY_UNKNOWN'],
    ['self dependency', (plan: ReturnType<typeof validPlan>) => { plan.sections[1]!.depends_on[0]!.section_id = 'B' }, 'CHAPTER_PLAN_DEPENDENCY_SELF'],
    ['cycle', (plan: ReturnType<typeof validPlan>) => { plan.sections[0]!.depends_on.push({ section_id: 'B', reason: '反向依赖。' }) }, 'CHAPTER_PLAN_DEPENDENCY_CYCLE'],
    ['unknown related', (plan: ReturnType<typeof validPlan>) => { plan.sections[0]!.related_sections[0]!.section_id = 'UNKNOWN' }, 'CHAPTER_PLAN_RELATED_UNKNOWN'],
    ['self related', (plan: ReturnType<typeof validPlan>) => { plan.sections[0]!.related_sections[0]!.section_id = 'A' }, 'CHAPTER_PLAN_RELATED_SELF'],
  ])('rejects %s', (_name, mutate, code) => {
    const plan = validPlan()
    mutate(plan)
    expect(validateChapterExecutionPlan(parseChapterExecutionPlan(plan), outline, hash).map(item => item.code)).toContain(code)
  })

  it('rejects schema versions and empty reasons at strict parsing', () => {
    expect(() => parseChapterExecutionPlan({ ...validPlan(), schema_version: 1 })).toThrow()
    const plan = validPlan()
    plan.sections[1]!.depends_on[0]!.reason = ' '
    expect(() => parseChapterExecutionPlan(plan)).toThrow()
  })
})
