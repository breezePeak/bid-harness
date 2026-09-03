import { describe, expect, it } from 'vitest'
import { buildEvidenceMappingPlan, buildChapterWorklist, buildWritableSectionWorklist, sectionEvidenceFingerprint, validateSectionEvidenceFreshness, type EvidenceMapArtifact, type OutlineArtifact, type OutlineSection } from '@deepseek-ai/dsh-bid'

function section(id: string, parent_id: string | null, order: number): OutlineSection {
  return { id, parent_id, order, level: parent_id === null ? 1 : 2, title: id, purpose: '说明方案', writable: true, must_answer: ['回答要求'], requirement_ids: [], scoring_ids: [], compliance_ids: [], scoring_response_point_ids: [], origin: 'generated', scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] }
}

function outline(): OutlineArtifact {
  return { schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [
    section('B', 'ROOT', 2), section('C', null, 2),
    { ...section('ROOT', null, 1), writable: false, must_answer: [] }, section('A', 'ROOT', 1),
  ] }
}

function evidence(value: OutlineArtifact): EvidenceMapArtifact {
  return { schema_version: 9, section_mappings: buildWritableSectionWorklist(value).map(section => ({ section_id: section.id, section_fingerprint: sectionEvidenceFingerprint(value, section), local_materials: [], web_materials: [], missing_topics: ['没有可靠资料'], writing_dimensions: [] })) }
}

it('S4 与 S5 按同一个目录遍历定义，一章恰好一个初始任务', () => {
  const value = outline()
  const plan = buildEvidenceMappingPlan(value, 'initial')
  expect(plan.tasks.map(task => task.section_id)).toEqual(['A', 'B', 'C'])
  expect(plan.tasks.map(task => task.task_id)).toEqual(['MAP-INIT-A', 'MAP-INIT-B', 'MAP-INIT-C'])
  expect(plan.tasks.map(task => task.heading_path)).toEqual([['ROOT', 'A'], ['ROOT', 'B'], ['C']])
  expect(buildChapterWorklist(value)).toEqual(buildWritableSectionWorklist(value))
  expect(plan.tasks.every(task => task.title === value.sections.find(section => section.id === task.section_id)!.title)).toBe(true)
  expect(buildEvidenceMappingPlan({ ...value, sections: [...value.sections].reverse() }, 'initial')).toEqual(plan)
  value.sections.find(section => section.id === 'ROOT')!.writable = true
  expect(() => buildEvidenceMappingPlan(value, 'initial')).toThrow('OUTLINE_SHARED_WRITABLE_NOT_LEAF')
})

describe('Section 检索语义指纹', () => {
  it.each(['purpose', 'must_answer', 'requirement_ids', 'scoring_ids', 'scoring_response_point_ids', 'compliance_ids', 'writing_notes', 'suggested_tables', 'suggested_figures'] as const)('%s 改变只补映射对应章节', (field) => {
    const value = outline()
    const before = evidence(value)
    const target = value.sections.find(section => section.id === 'A')!
    if (field === 'purpose') target.purpose = '新的检索目标'
    else target[field] = ['新要求']
    const tasks = buildEvidenceMappingPlan(value, 'supplemental', before).tasks
    expect(tasks.map(task => task.section_id)).toEqual(['A'])
    expect(tasks[0]!.phase).toBe('supplemental')
  })

  it('祖先标题变化使后代过期，兄弟排序与原数组顺序不影响指纹', () => {
    const value = outline()
    const before = evidence(value)
    value.sections.find(section => section.id === 'A')!.order = 2
    value.sections.find(section => section.id === 'B')!.order = 1
    value.sections.reverse()
    expect(buildEvidenceMappingPlan(value, 'supplemental', before).tasks).toEqual([])
    value.sections.find(section => section.id === 'ROOT')!.title = '新的技术主题'
    expect(buildEvidenceMappingPlan(value, 'supplemental', before).tasks.map(task => task.section_id)).toEqual(['B', 'A'])
  })

  it('全局合规变化刷新所有可写章节', () => {
    const value = outline()
    const before = evidence(value)
    value.global_compliance_ids.push('COMP-1')
    expect(buildEvidenceMappingPlan(value, 'supplemental', before).tasks).toHaveLength(3)
  })
})

it.each(['missing', 'duplicate', 'unknown', 'stale'] as const)('拒绝 %s Evidence', (scenario) => {
  const value = outline()
  const map = evidence(value)
  const codes = { missing: 'MISSING', duplicate: 'DUPLICATE', unknown: 'UNKNOWN', stale: 'STALE' }
  if (scenario === 'missing') map.section_mappings.pop()
  if (scenario === 'duplicate') map.section_mappings.push(map.section_mappings[0]!)
  if (scenario === 'unknown') map.section_mappings[0]!.section_id = 'UNKNOWN'
  if (scenario === 'stale') map.section_mappings[0]!.section_fingerprint = '0'.repeat(64)
  expect(validateSectionEvidenceFreshness(value, map).map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SECTION_' + codes[scenario])
})
