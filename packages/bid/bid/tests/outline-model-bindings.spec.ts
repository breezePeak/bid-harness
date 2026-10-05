import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { bindOutlineModelCandidate, bindOutlineModelCandidateRepairs, bindOutlineModelRepairOperations,
  bindOutlineModelStructuralOperations, outlineModelInputView, outlineModelView, outlineModelRepairOperationSchema,
  type OutlineModelBindingInputs } from '../src/outline-model-bindings.ts'
import { outlineModelCandidateSchema } from '../src/outline-generation-artifacts.ts'
import { bindScoringResponsePointModelCandidate, createScoringResponsePointCatalog,
  scoringResponsePointModelCandidateSchema } from '../src/scoring-response-point-artifacts.ts'
import { normalizeOutlineCandidate } from '../src/outline-generation-normalization.ts'
import { applyOutlineRepair, applyOutlineModelRepair } from '../src/outline-generation-repair.ts'
import { parseTenderRequirementsArtifact, parseTenderScoringArtifact, parseTenderComplianceArtifact } from '../src/tender-analysis-artifacts.ts'
import { zodJsonSchema } from '../src/zod-json-schema.ts'

const sourceRefs = [{ file_id: 'tender-source', chunk: 'corpus/tender-source/chunks/0001.md', line_start: 1, line_end: 1 }]
const requirements = parseTenderRequirementsArtifact({ schema_version: 1, requirements: [
  { id: 'requirement-not-an-array-index', category: 'implementation', raw_text: '明确组织职责', normalized_requirement: '明确组织职责', mandatory: true, source_refs: sourceRefs },
] })
const scoring = parseTenderScoringArtifact({ schema_version: 1, scoring_items: [
  { id: 'scoring-original-a', parent: null, group: '技术', title: '组织', raw_text: '组织与职责', criterion: '组织与职责', score: 5, score_range: null, must_answer: true, source_refs: sourceRefs },
  { id: 'scoring-original-b', parent: null, group: '技术', title: '进度', raw_text: '进度控制', criterion: '进度控制', score: 5, score_range: null, must_answer: true, source_refs: sourceRefs },
] })
const compliance = parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [
  { id: 'compliance-original', type: 'mandatory_response', raw_text: '按期交付', normalized_rule: '按期交付', severity: 'mandatory', source_refs: sourceRefs },
] })
const catalog = createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [
  { scoring_id: 'scoring-original-a', order: 1, text: '明确组织职责' },
  { scoring_id: 'scoring-original-b', order: 1, text: '说明进度控制' },
] })
const inputs: OutlineModelBindingInputs = { requirements, scoring, compliance, catalog,
  frameworks: [{ file_id: 'framework-original', name: '用户框架', headings: [
    { title: '实施方案', level: 1, heading_path: ['实施方案'], order: 1 },
  ] }] }

type ModelSection = z.infer<typeof outlineModelCandidateSchema>['sections'][number]

function modelSection(writable = true): ModelSection {
  return { title: '实施方案', purpose: '说明实施责任和安排',
    must_answer: writable ? ['说明责任和安排'] : [],
    requirement_positions: writable ? [0] : [], scoring_positions: [], compliance_positions: [],
    response_point_positions: writable ? [1] : [], origin: 'generated' as const, framework_refs: [],
    suggested_tables: [], suggested_figures: [], writing_notes: [], children: [] as ModelSection[] }
}

function modelCandidate() {
  return { document_title: '技术投标文件', global_compliance_positions: [0],
    sections: [{ ...modelSection(false), children: [modelSection(), { ...modelSection(), title: '进度安排' }] }] }
}

function outline() {
  return normalizeOutlineCandidate(bindOutlineModelCandidate(modelCandidate(), inputs), catalog, scoring)
}

describe('S3 程序绑定身份', () => {
  it('Host 按树派生可写状态，清空父节作答与 RP，并拒绝缺少叶节语义', () => {
    const candidate = modelCandidate()
    candidate.sections[0] = { ...candidate.sections[0]!, must_answer: ['父节错误作答'], response_point_positions: [0] }
    const result = bindOutlineModelCandidate(candidate, inputs)
    expect(result.sections[0]).toMatchObject({ writable: false, must_answer: [], scoring_response_point_ids: [] })
    expect(result.sections[1]).toMatchObject({ writable: true, must_answer: ['说明责任和安排'], scoring_response_point_ids: ['RP-000002'] })
    const missing = modelCandidate()
    missing.sections[0]!.children[0]!.must_answer = []
    expect(() => normalizeOutlineCandidate(bindOutlineModelCandidate(missing, inputs), catalog, scoring)).toThrow('可写章节必须包含具体 must_answer')
    expect(candidate.sections[0].must_answer).toEqual(['父节错误作答'])
  })

  it('模型移动章节后 Host 同步父节状态，canonical 修复仍拒绝直接填写错误状态', () => {
    const before = outline()
    const operations = bindOutlineModelRepairOperations([
      { type: 'move_section', section_position: 1, parent_position: 2, sibling_position: 0 },
    ], before, inputs)
    const result = applyOutlineModelRepair(before, operations, catalog, scoring)
    expect(result.sections[2]).toMatchObject({ writable: false, must_answer: [],
      scoring_response_point_ids: [], scoring_response_points: [] })
    expect(result.sections[1]).toMatchObject({ parent_id: 'SEC-003', writable: true, must_answer: ['说明责任和安排'] })
    expect(() => bindOutlineModelRepairOperations([
      { type: 'repair_structure', section_index: 0, writable: false },
    ], before, inputs)).toThrow()
    expect(() => applyOutlineRepair(before, [{ type: 'repair_structure', section_index: 0, writable: true }], catalog, scoring)).toThrow('可写章节必须包含具体 must_answer')
  })

  it('模型只选择位置，程序生成节点身份、父关系、同级顺序、层级和正式业务引用', () => {
    const value = outline()
    expect(value).toMatchObject({ schema_version: 3, scope: 'technical_bid', global_compliance_ids: ['compliance-original'] })
    expect(value.sections.map(section => [section.id, section.parent_id, section.order, section.level])).toEqual([
      ['SEC-001', null, 1, 1], ['SEC-002', 'SEC-001', 1, 2], ['SEC-003', 'SEC-001', 2, 2],
    ])
    expect(value.sections[1]).toMatchObject({ requirement_ids: ['requirement-not-an-array-index'],
      scoring_ids: ['scoring-original-b'], scoring_response_point_ids: ['RP-000002'],
      scoring_response_points: [{ scoring_id: 'scoring-original-b', response_point: '说明进度控制' }] })
  })

  it('输入与目录位置视图不暴露章节、业务或框架身份供模型复写', () => {
    const view = JSON.stringify([outlineModelInputView(inputs), outlineModelView(outline(), inputs)])
    for (const identity of ['SEC-001', 'requirement-not-an-array-index', 'scoring-original-a', 'scoring-original-b', 'compliance-original', 'framework-original', 'RP-000002']) {
      expect(view).not.toContain(identity)
    }
    expect(view).toContain('明确组织职责')
    expect(view).toContain('response_point_positions')
  })

  it('模型输出 schema 不含 ID、版本、scope、树层级或持久顺序字段', () => {
    for (const schema of [outlineModelCandidateSchema, outlineModelRepairOperationSchema, scoringResponsePointModelCandidateSchema]) {
      const wire = JSON.stringify(zodJsonSchema(schema))
      for (const field of ['id', 'parent_id', 'section_id', 'scoring_id', 'requirement_ids', 'scoring_ids', 'compliance_ids', 'scoring_response_point_ids', 'file_id', 'schema_version', 'scope', 'level', 'order', 'writable']) {
        expect(wire).not.toContain(`"${field}"`)
      }
    }
  })

  it.each(['id', 'parent_id', 'parent_position', 'level', 'order', 'writable', 'scoring_ids', 'scoring_response_points'])('首稿拒绝模型补写 %s', (field) => {
    const candidate = modelCandidate()
    const value = { ...candidate, sections: [{ ...candidate.sections[0], [field]: 'model-owned' }, ...candidate.sections.slice(1)] }
    expect(() => bindOutlineModelCandidate(value, inputs)).toThrow()
  })

  it.each(['schema_version', 'scope'])('首稿拒绝模型提交根确定性字段 %s', (field) => {
    expect(() => bindOutlineModelCandidate({ ...modelCandidate(), [field]: 'model-owned' }, inputs)).toThrow()
  })

  it.each(['requirement_positions', 'scoring_positions', 'compliance_positions', 'response_point_positions'])('首稿 %s 越界时不产生目录', (field) => {
    const candidate = modelCandidate()
    const invalid = { ...candidate, sections: [{ ...candidate.sections[0], children: [
      { ...candidate.sections[0]!.children[0], [field]: [99] }, candidate.sections[0]!.children[1],
    ] }] }
    expect(() => bindOutlineModelCandidate(invalid, inputs)).toThrow(/POSITION_INVALID/u)
  })

  it('19 个新节点的父关系由嵌套位置派生，模型无需计算扁平下标', () => {
    const candidate = { document_title: '技术投标文件', global_compliance_positions: [], sections: [
      ...Array.from({ length: 6 }, (_unused, index) => ({ ...modelSection(false), title: `专题${index + 1}`,
        children: [modelSection(), modelSection()] })), modelSection(),
    ] }
    const result = bindOutlineModelCandidate(candidate, inputs)
    expect(result.sections).toHaveLength(19)
    expect(result.sections.filter(section => !section.writable).map(section => section.id)).toEqual([
      'SEC-001', 'SEC-004', 'SEC-007', 'SEC-010', 'SEC-013', 'SEC-016',
    ])
    for (const section of result.sections.filter(section => section.parent_id !== null)) {
      expect(section.parent_id).not.toBe(section.id)
      expect(section.level).toBe(2)
    }
  })

  it('嵌套候选逐层校验，不增加目录深度上限', () => {
    let root = modelSection()
    for (let level = 0; level < 8; level++) root = { ...modelSection(false), children: [root] }
    const result = bindOutlineModelCandidate({ document_title: '技术投标文件', global_compliance_positions: [], sections: [root] }, inputs)
    expect(result.sections.map(section => section.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.sections.at(-1)).toMatchObject({ id: 'SEC-009', parent_id: 'SEC-008', writable: true })
  })

  it('框架文件和标题路径从真实框架位置绑定', () => {
    const candidate = modelCandidate()
    const value = { ...candidate, sections: [{ ...candidate.sections[0], children: [
      { ...candidate.sections[0]!.children[0], origin: 'mixed', framework_refs: [{ framework_position: 0, heading_position: 0 }] },
      candidate.sections[0]!.children[1],
    ] }] }
    expect(bindOutlineModelCandidate(value, inputs).sections[1]?.framework_refs).toEqual([
      { file_id: 'framework-original', heading_path: ['实施方案'] },
    ])
    value.sections[0]!.children[0]!.framework_refs = [{ framework_position: 0, heading_position: 4 }]
    expect(() => bindOutlineModelCandidate(value, inputs)).toThrow('BID_OUTLINE_MODEL_FRAMEWORK_POSITION_INVALID')
  })

  it('重生成按 source_position 保留旧身份，新增节点从旧序列之后由程序分配', () => {
    const baseline = outline()
    const candidate = modelCandidate()
    const value = { ...candidate, sections: [{ ...candidate.sections[0], source_position: 0, children: [
      ...candidate.sections[0]!.children.map((section, index) => ({ ...section, source_position: index + 1 })),
      { ...modelSection(), title: '风险控制' },
    ] }] }
    const result = bindOutlineModelCandidate(value, inputs, baseline)
    expect(result.sections.map(section => section.id)).toEqual(['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004'])
    expect(() => bindOutlineModelCandidate({ ...candidate, sections: [
      { ...modelSection(), source_position: 1 }, { ...modelSection(), source_position: 1 },
    ] }, inputs, baseline)).toThrow('BID_OUTLINE_MODEL_SOURCE_POSITION_DUPLICATE')
  })

  it('复核位置操作经过正式操作器绑定并重建所属评分与响应点快照', () => {
    const original = outline()
    const operations = bindOutlineModelRepairOperations([
      { type: 'update_section', section_position: 1, response_point_positions: [0], must_answer: ['说明组织职责'] },
      { type: 'add_section', parent_position: 0, sibling_position: 2, title: '质量保障', purpose: '说明质量核验',
        must_answer: ['说明核验措施'], requirement_positions: [0], response_point_positions: [1] },
    ], original, inputs)
    const result = applyOutlineRepair(original, operations, catalog, scoring)
    expect(result.sections[1]).toMatchObject({ id: 'SEC-002', scoring_response_point_ids: ['RP-000001'],
      scoring_response_points: [{ scoring_id: 'scoring-original-a', response_point: '明确组织职责' }] })
    expect(result.sections.at(-1)).toMatchObject({ id: 'SEC-004', parent_id: 'SEC-001', order: 3,
      scoring_ids: ['scoring-original-b'], scoring_response_point_ids: ['RP-000002'] })
  })

  it('复核或普通修复都拒绝模型原始身份；越界位置不产生正式操作', () => {
    expect(() => bindOutlineModelRepairOperations([{ type: 'update_section', section_id: 'SEC-002', title: '组织安排' }], outline(), inputs)).toThrow()
    expect(() => bindOutlineModelRepairOperations([{ type: 'update_section', section_position: 99, title: '组织安排' }], outline(), inputs)).toThrow('BID_OUTLINE_MODEL_POSITION_INVALID')
    expect(() => bindOutlineModelRepairOperations([{ type: 'repair_structure', section_index: 1, id: 'invented' }], outline(), inputs)).toThrow()
    const repaired = bindOutlineModelRepairOperations([{ type: 'repair_structure', section_index: 1, regenerate_id: true }], outline(), inputs)
    expect(repaired).toEqual([{ type: 'repair_structure', section_index: 1, id: 'SEC-004' }])
  })

  it('局部重生成仅绑定结构位置，业务引用写入被拒绝', () => {
    expect(bindOutlineModelStructuralOperations([{ type: 'move_section', section_position: 2, parent_position: 0, sibling_position: 0 }], outline()))
      .toEqual([{ type: 'move_section', section_id: 'SEC-003', parent_id: 'SEC-001', order: 1 }])
    expect(() => bindOutlineModelStructuralOperations([{ type: 'update_section', section_position: 1, requirement_positions: [0] }], outline())).toThrow()
  })

  it('字段修复只选择位置，不允许补写原始身份或版本', () => {
    expect(bindOutlineModelCandidateRepairs([{ section_index: 1, field: 'response_point_positions', value: [0] }], outline().sections, inputs))
      .toEqual([{ section_index: 1, field: 'scoring_response_point_ids', value: ['RP-000001'] }])
    for (const field of ['id', 'scoring_ids', 'schema_version', 'scope', 'level', 'order']) {
      expect(() => bindOutlineModelCandidateRepairs([{ section_index: 1, field, value: 'invented' }], outline().sections, inputs)).toThrow('BID_OUTLINE_MODEL_ID_FIELD_FORBIDDEN')
    }
  })
})

describe('评分响应点程序绑定', () => {
  it('按冻结评分位置绑定原评分身份，版本和各评分连续顺序由程序生成', () => {
    const candidate = bindScoringResponsePointModelCandidate(scoring, { points: [
      { scoring_position: 1, text: '进度控制' }, { scoring_position: 0, text: '组织职责' }, { scoring_position: 1, text: '进度纠偏' },
    ] })
    expect(candidate).toEqual({ schema_version: 1, points: [
      { scoring_id: 'scoring-original-b', order: 1, text: '进度控制' },
      { scoring_id: 'scoring-original-a', order: 1, text: '组织职责' },
      { scoring_id: 'scoring-original-b', order: 2, text: '进度纠偏' },
    ] })
  })

  it('评分选择越界或提交旧评分身份、order、版本时拒绝', () => {
    expect(() => bindScoringResponsePointModelCandidate(scoring, { points: [{ scoring_position: 2, text: '未知' }] })).toThrow('scoring-response-point-candidate-position-invalid')
    for (const field of ['id', 'scoring_id', 'order']) {
      expect(() => bindScoringResponsePointModelCandidate(scoring, { points: [{ scoring_position: 0, text: '组织职责', [field]: 'invented' }] })).toThrow()
    }
    expect(() => bindScoringResponsePointModelCandidate(scoring, { schema_version: 1, points: [] })).toThrow()
  })
})
