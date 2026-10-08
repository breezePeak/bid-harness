import { describe, expect, it } from 'vitest'
import { createMappingReferencePositions } from '../src/mapping-reference-positions.ts'
import { sectionAnswerPlanInputSchema } from '../src/section-answer-plan.ts'
import { zodJsonSchema } from '../src/zod-json-schema.ts'

const references = [
  { id: 'REQ-007', kind: 'requirement' },
  { id: 'SC-001', kind: 'scoring' },
  { id: 'COM-001', kind: 'compliance' },
  { id: 's2:project:', kind: 'project' },
  { id: 'M1:chunk_0001', kind: 'local_material' },
]
const positions = createMappingReferencePositions(references, ['requirement', 'scoring', 'local_material'])

describe('S4 统一依据引用位置', () => {
  it('REQ 全局业务位置 6 与 SC 业务位置 0 不改变统一表 0/1 的 Host 身份和类别', () => {
    expect(positions.bind([{ reference_position: 0 }, { reference_position: 1 }])).toEqual([
      { kind: 'requirement', ref: 'REQ-007' }, { kind: 'scoring', ref: 'SC-001' },
    ])
    expect(() => positions.bind({ reference_position: 6 })).toThrow('未知对象位置 6（objects.references）')
  })

  it('S2 artifact 从真实引用派生，项目事实保持正式无 record_id 格式', () => {
    expect(positions.bind([{ kind: 's2', record_position: 0 }, { kind: 's2', record_position: 1 },
      { kind: 's2', record_position: 3 }])).toEqual([
      { kind: 's2', artifact: 'requirement', record_id: 'REQ-007' },
      { kind: 's2', artifact: 'scoring', record_id: 'SC-001' }, { kind: 's2', artifact: 'project' },
    ])
  })

  it.each([
    { kind: 'scoring', reference_position: 0 }, { kind: 'requirement', ref: 'REQ-007' },
    { kind: 's2', artifact: 'scoring', record_position: 0 }, { kind: 's2', record_id: 'REQ-007' },
    { reference_position: -1 }, { kind: 's2', record_position: 1.5 },
  ])('拒绝模型原始身份、重复派生标签及非法位置：%j', (value) => {
    expect(() => positions.bind(value)).toThrow()
  })

  it('研究依据与 S2 记录分别验证对象适用用途', () => {
    expect(() => positions.bind({ reference_position: 2 })).toThrow('不适用于研究依据')
    expect(() => positions.bind({ reference_position: 3 })).toThrow('不适用于研究依据')
    expect(() => positions.bind({ kind: 's2', record_position: 4 })).toThrow('不是 S2 记录')
  })

  it('公开用途和纠正位置来自同一接纳规则，未读材料不能作为研究依据', () => {
    const scoped = createMappingReferencePositions(references, ['requirement', 'scoring', 'local_material'], {
      research: new Set(['REQ-007', 'SC-001']),
      s2: new Set(['REQ-007', 'COM-001', 's2:project:']),
    })
    expect(scoped.choices()).toEqual({ research: [0, 1], s2: [0, 2, 3] })
    expect(scoped.uses(2)).toEqual(['s2'])
    expect(scoped.uses(3)).toEqual(['s2'])
    expect(scoped.uses(4)).toEqual([])
    for (const position of scoped.choices().research) expect(() => scoped.bind({ reference_position: position })).not.toThrow()
    for (const position of scoped.choices().s2) expect(() => scoped.bind({ kind: 's2', record_position: position })).not.toThrow()
    expect(() => scoped.bind({ reference_position: 4 })).toThrow('可选位置：[0,1]')
    expect(() => scoped.bind({ kind: 's2', record_position: 1 })).toThrow('可选位置：[0,2,3]')
  })

  it('S2 模型 Schema 只要求 kind=s2 和统一表位置', () => {
    const schema = positions.schema(zodJsonSchema(sectionAnswerPlanInputSchema))
    expect(JSON.stringify(schema)).not.toContain('"artifact"')
    expect(JSON.stringify(schema)).not.toContain('"record_id"')
    expect(JSON.stringify(schema)).toContain('"required":["kind","record_position"]')
  })
})
