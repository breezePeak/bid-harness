import { describe, expect, it } from 'vitest'
import {
  parseChapterExecutionLog,
  parseOrMigrateChapterExecutionLog,
  parseChapterExecutionPlan,
  validateChapterExecutionPlan,
  type ChapterExecutionPlan,
  type OutlineArtifact,
} from '@deepseek-ai/dsh-bid'

const hash = 'a'.repeat(64)
const outline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术标',
  global_compliance_ids: [],
  sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '结构', purpose: '结构', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...['A', 'B', 'C'].map((id, index) => ({ id, parent_id: 'STRUCT', order: index + 1, level: 2, title: id, purpose: id, writable: true, must_answer: [id], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const, scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ],
}

function validPlan(): ChapterExecutionPlan {
  return {
    schema_version: 3 as const,
    scope: 'technical_bid' as const,
    confirmed_outline_sha256: hash,
    writing_plan_version: 7,
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
    expect(validateChapterExecutionPlan(parseChapterExecutionPlan(validPlan()), outline, hash, 7)).toEqual([])
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
    expect(validateChapterExecutionPlan(parseChapterExecutionPlan(plan), outline, hash, 7).map(item => item.code)).toContain(code)
  })

  it('rejects a relation plan bound to an older Writing Plan', () => {
    expect(validateChapterExecutionPlan(validPlan(), outline, hash, 8).map(item => item.code))
      .toContain('CHAPTER_PLAN_WRITING_PLAN_INVALID')
  })

  it('rejects schema versions and empty reasons at strict parsing', () => {
    expect(() => parseChapterExecutionPlan({ ...validPlan(), schema_version: 1 })).toThrow()
    const plan = validPlan()
    plan.sections[1]!.depends_on[0]!.reason = ' '
    expect(() => parseChapterExecutionPlan(plan)).toThrow()
  })

  it('requires phase fields in the current execution log', () => {
    const log = {
      schema_version: 4, scope: 'technical_bid', confirmed_outline_sha256: hash,
      writing_plan_version: 7, max_concurrency: 1, observed_max_concurrency: 1,
      sections: [{
        section_id: 'A', depends_on: [], related_sections: [], epoch: 0, status: 'running',
        phase: 'writing', failure_phase: null, attempts: [],
        final_writer_child_session_id: null, final_reviewer_child_session_id: null,
      }],
    }
    expect(parseChapterExecutionLog(log).sections[0]?.phase).toBe('writing')
    expect(() => parseChapterExecutionLog({ ...log, schema_version: 3 })).toThrow()
    expect(() => parseChapterExecutionLog({ ...log, sections: [{ ...log.sections[0]!, phase: undefined }] })).toThrow()
  })

  it('迁移 v3 执行日志并只让运行中的章节重新排队', () => {
    const base = {
      schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: hash,
      writing_plan_version: 7, max_concurrency: 1, observed_max_concurrency: 1,
      sections: [
        { section_id: 'A', depends_on: [], related_sections: [], epoch: 0, status: 'completed', attempts: [], final_writer_child_session_id: 'writer-a', final_reviewer_child_session_id: 'reviewer-a' },
        { section_id: 'B', depends_on: [], related_sections: [], epoch: 0, status: 'pending', attempts: [], final_writer_child_session_id: null, final_reviewer_child_session_id: null },
        { section_id: 'C', depends_on: [], related_sections: [], epoch: 0, status: 'running', attempts: [], final_writer_child_session_id: 'writer-c', final_reviewer_child_session_id: null },
        { section_id: 'D', depends_on: [], related_sections: [], epoch: 0, status: 'failed', attempts: [{
          role: 'reviewer', attempt: 1, child_session_id: 'reviewer-d', label: 'S5 审核',
          started_at: '2026-09-09T00:00:00.000Z', ended_at: '2026-09-09T00:00:01.000Z', stop_reason: 'error', accepted: false,
          issues: [], input: { plan_version: 7, section_epoch: 0, dependencies: [] },
        }], final_writer_child_session_id: 'writer-d', final_reviewer_child_session_id: null },
      ],
    }
    const migrated = parseOrMigrateChapterExecutionLog(base)
    expect(migrated.schema_version).toBe(4)
    expect(migrated.sections.map(section => [section.status, section.phase, section.failure_phase])).toEqual([
      ['completed', null, null], ['pending', 'queued', null], ['pending', 'queued', null], ['failed', null, 'reviewing'],
    ])
  })
})
