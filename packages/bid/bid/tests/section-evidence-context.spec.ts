import { expect, it } from 'vitest'
import { buildEvidenceMappingPlan, buildChapterWorklist, buildWritableSectionWorklist, validateSectionEvidenceCoverage, reconcileSectionEvidence, type EvidenceMapArtifact, type OutlineArtifact, type OutlineSection } from '@deepseek-ai/dsh-bid'

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
  return { schema_version: 10, section_mappings: buildWritableSectionWorklist(value).map(section => ({ section_id: section.id, local_materials: [], web_materials: [], missing_topics: ['没有可靠资料'], writing_dimensions: [] })) }
}

it('14 个可写叶子按两个业务分支分为 2 个 Task，S5 仍逐章节写作', () => {
  const value: OutlineArtifact = { ...outline(), sections: [
    { ...section('ROOT', null, 1), writable: false, must_answer: [] },
    ...['TECH', 'DELIVERY'].flatMap((id, index) => [
      { ...section(id, 'ROOT', index + 1), writable: false, must_answer: [] },
      ...Array.from({ length: 7 }, (_, leaf) => ({ ...section(`${id}-${leaf}`, id, leaf + 1), level: 3 })),
    ]),
  ] }
  const plan = buildEvidenceMappingPlan(value)
  expect(plan.tasks).toHaveLength(2)
  expect(plan.tasks.map(task => task.section_ids.length)).toEqual([7, 7])
  expect(plan.tasks.flatMap(task => task.section_ids)).toEqual(buildChapterWorklist(value).map(section => section.id))
  expect(buildChapterWorklist(value)).toEqual(buildWritableSectionWorklist(value))
  expect(buildEvidenceMappingPlan({ ...value, sections: [...value.sections].reverse() })).toEqual(plan)
  value.sections.find(section => section.id === 'ROOT')!.writable = true
  expect(() => buildEvidenceMappingPlan(value)).toThrow('OUTLINE_SHARED_WRITABLE_NOT_LEAF')
})

it('单根目录直属的 14 个叶子合为一个执行批次', () => {
  const value: OutlineArtifact = { ...outline(), sections: [
    { ...section('ROOT', null, 1), writable: false, must_answer: [] },
    ...Array.from({ length: 14 }, (_, index) => section(`SEC-${index}`, 'ROOT', index + 1)),
  ] }
  expect(buildEvidenceMappingPlan(value).tasks.map(task => task.section_ids.length)).toEqual([14])
})

it('标题、父级、写作提示和合规变化不会使 Evidence stale', () => {
  const value = outline()
  const before = evidence(value)
  value.sections.find(section => section.id === 'ROOT')!.title = '新标题'
  value.sections.find(section => section.id === 'A')!.writing_notes.push('新提示')
  value.global_compliance_ids.push('COMP-NEW')
  expect(validateSectionEvidenceCoverage(value, before)).toEqual([])
  expect(reconcileSectionEvidence(value, before)).toEqual(before)
})

it('新增、删除和拆分章节确定性 reconcile，不丢失保留章节的材料', () => {
  const value = outline()
  const before = evidence(value)
  before.section_mappings[0]!.local_materials.push({ source_kind: 'reference', file_id: 'REF', chunk: 'chunk_0001', usage: 'reference', summary: '原资料' })
  value.sections = value.sections.filter(section => section.id !== 'B')
  const parent = value.sections.find(section => section.id === 'A')!
  parent.writable = false
  parent.must_answer = []
  value.sections.push(...[1, 2].map(order => ({ ...section(`A-${order}`, 'A', order), level: 3 })), section('NEW', null, 3))
  const result = reconcileSectionEvidence(value, before)
  expect(result.section_mappings.map(mapping => mapping.section_id)).toEqual(['A-1', 'A-2', 'C', 'NEW'])
  expect(result.section_mappings[0]!.local_materials).toEqual(before.section_mappings[0]!.local_materials)
  expect(result.section_mappings[0]!.missing_topics.join()).toContain('重新筛选')
  expect(result.section_mappings.at(-1)).toMatchObject({ local_materials: [], web_materials: [], missing_topics: [expect.any(String)] })
  expect(validateSectionEvidenceCoverage(value, result)).toEqual([])
})

it.each(['missing', 'duplicate', 'unknown'] as const)('拒绝 %s Evidence', (scenario) => {
  const value = outline()
  const map = evidence(value)
  if (scenario === 'missing') map.section_mappings.pop()
  if (scenario === 'duplicate') map.section_mappings.push(map.section_mappings[0]!)
  if (scenario === 'unknown') map.section_mappings[0]!.section_id = 'UNKNOWN'
  expect(validateSectionEvidenceCoverage(value, map).map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SECTION_' + scenario.toUpperCase())
})
