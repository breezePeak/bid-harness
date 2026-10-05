import { describe, expect, it } from 'vitest'
import { bindOutlineModelCandidate, bindOutlineModelCandidateRepairs, bindOutlineModelRepairOperations,
  bindOutlineModelStructuralOperations, outlineModelInputView, outlineModelView, outlineModelRepairOperationSchema,
  type OutlineModelBindingInputs } from '../src/outline-model-bindings.ts'
import { outlineModelCandidateSchema } from '../src/outline-generation-artifacts.ts'
import { bindScoringResponsePointModelCandidate, createScoringResponsePointCatalog,
  scoringResponsePointModelCandidateSchema } from '../src/scoring-response-point-artifacts.ts'
import { normalizeOutlineCandidate } from '../src/outline-generation-normalization.ts'
import { applyOutlineRepair } from '../src/outline-generation-repair.ts'
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

function modelSection(parent: number | null, writable = true) {
  return { parent_position: parent, title: '实施方案', purpose: '说明实施责任和安排', writable,
    must_answer: writable ? ['说明责任和安排'] : [],
    requirement_positions: writable ? [0] : [], scoring_positions: [], compliance_positions: [],
    response_point_positions: writable ? [1] : [], origin: 'generated' as const, framework_refs: [],
    suggested_tables: [], suggested_figures: [], writing_notes: [] }
}

function modelCandidate() {
  return { document_title: '技术投标文件', global_compliance_positions: [0],
    sections: [modelSection(null, false), modelSection(0), { ...modelSection(0), title: '进度安排' }] }
}

function outline() {
  return normalizeOutlineCandidate(bindOutlineModelCandidate(modelCandidate(), inputs), catalog, scoring)
}

describe('S3 程序绑定身份', () => {
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
      for (const field of ['id', 'parent_id', 'section_id', 'scoring_id', 'requirement_ids', 'scoring_ids', 'compliance_ids', 'scoring_response_point_ids', 'file_id', 'schema_version', 'scope', 'level', 'order']) {
        expect(wire).not.toContain(`"${field}"`)
      }
    }
  })

  it.each(['id', 'parent_id', 'level', 'order', 'scoring_ids', 'scoring_response_points'])('首稿拒绝模型补写 %s', (field) => {
    const candidate = modelCandidate()
    const value = { ...candidate, sections: [{ ...candidate.sections[0], [field]: 'model-owned' }, ...candidate.sections.slice(1)] }
    expect(() => bindOutlineModelCandidate(value, inputs)).toThrow()
  })

  it.each(['schema_version', 'scope'])('首稿拒绝模型提交根确定性字段 %s', (field) => {
    expect(() => bindOutlineModelCandidate({ ...modelCandidate(), [field]: 'model-owned' }, inputs)).toThrow()
  })

  it.each(['parent_position', 'requirement_positions', 'scoring_positions', 'compliance_positions', 'response_point_positions'])('首稿 %s 越界时不产生目录', (field) => {
    const candidate = modelCandidate()
    const invalid = { ...candidate, sections: candidate.sections.map((section, index) => index === 1
      ? { ...section, [field]: field === 'parent_position' ? 99 : [99] } : section) }
    expect(() => bindOutlineModelCandidate(invalid, inputs)).toThrow(/POSITION_INVALID/u)
  })

  it('父位置循环被程序拒绝，不递归生成非法层级', () => {
    const candidate = modelCandidate()
    candidate.sections[0]!.parent_position = 1
    expect(() => bindOutlineModelCandidate(candidate, inputs)).toThrow('BID_OUTLINE_MODEL_PARENT_CYCLE')
  })

  it('框架文件和标题路径从真实框架位置绑定', () => {
    const candidate = modelCandidate()
    const value = { ...candidate, sections: candidate.sections.map((section, index) => index === 1
      ? { ...section, origin: 'mixed', framework_refs: [{ framework_position: 0, heading_position: 0 }] } : section) }
    expect(bindOutlineModelCandidate(value, inputs).sections[1]?.framework_refs).toEqual([
      { file_id: 'framework-original', heading_path: ['实施方案'] },
    ])
    value.sections[1]!.framework_refs = [{ framework_position: 0, heading_position: 4 }]
    expect(() => bindOutlineModelCandidate(value, inputs)).toThrow('BID_OUTLINE_MODEL_FRAMEWORK_POSITION_INVALID')
  })

  it('重生成按 source_position 保留旧身份，新增节点从旧序列之后由程序分配', () => {
    const baseline = outline()
    const candidate = modelCandidate()
    const value = { ...candidate, sections: [
      ...candidate.sections.map((section, index) => ({ ...section, source_position: index })),
      { ...modelSection(0), title: '风险控制' },
    ] }
    const result = bindOutlineModelCandidate(value, inputs, baseline)
    expect(result.sections.map(section => section.id)).toEqual(['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004'])
    expect(() => bindOutlineModelCandidate({ ...candidate, sections: [
      { ...modelSection(null), source_position: 1 }, { ...modelSection(null), source_position: 1 },
    ] }, inputs, baseline)).toThrow('BID_OUTLINE_MODEL_SOURCE_POSITION_DUPLICATE')
  })

  it('复核位置操作经过正式操作器绑定并重建所属评分与响应点快照', () => {
    const original = outline()
    const operations = bindOutlineModelRepairOperations([
      { type: 'update_section', section_position: 1, response_point_positions: [0], must_answer: ['说明组织职责'] },
      { type: 'add_section', parent_position: 0, sibling_position: 2, title: '质量保障', purpose: '说明质量核验', writable: true,
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
