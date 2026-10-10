import { ToolArgsError, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createChapterObjectPositions } from '../src/chapter-object-positions.ts'

const positions = createChapterObjectPositions([
  { canonical: 'section_id', model: 'section_position', ids: ['SEC-001', 'SEC-002'] },
  { canonical: 'requirement_ids', model: 'requirement_positions', ids: ['REQ-007', 'REQ-009'], many: true },
  { canonical: 'review_ref', model: 'review_position', ids: ['REVIEW-1'] },
])

describe('章节工具的模型对象位置', () => {
  it('材料数组的 Schema 明确引用表，绑定仍由程序完成', () => {
    const selected = createChapterObjectPositions([
      { canonical: 'chunk_refs', model: 'chunk_positions', ids: ['WEB-CHUNK'], many: true, table: 'references' },
    ])
    const schema = selected.schema({ type: 'object', properties: { chunk_refs: { type: 'array', items: { type: 'string' } } } })
    expect(JSON.stringify(schema)).toContain('选择objects.references中的位置数组')
    expect(JSON.stringify(schema)).toContain('选择objects.references中的位置，')
    expect(selected.bind({ chunk_positions: [0] })).toEqual({ chunk_refs: ['WEB-CHUNK'] })
    expect(() => selected.bind({ chunk_positions: [1] })).toThrow(ToolArgsError)
  })

  it('递归 Schema 使用模型字段及位置说明，不保留要求填写身份的描述', () => {
    const schema = positions.schema({ type: 'object', properties: {
      section_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      requirement_ids: { type: 'array', minItems: 1, items: { type: 'string' }, description: '填写真实 Requirement ID。' },
      items: { type: 'array', items: { type: 'object', properties: { review_ref: { type: 'string' } },
        required: ['review_ref'], additionalProperties: false } },
    }, required: ['section_id', 'requirement_ids', 'items'], additionalProperties: false })
    expect(schema).toMatchObject({ properties: {
      section_position: { oneOf: [{ type: 'integer' }, { type: 'null' }],
        description: '选择当前对象表中的位置，实际身份由程序绑定；不得填写 ID 或短引用。' },
      requirement_positions: { type: 'array', minItems: 1, items: { type: 'integer' },
        description: '选择当前对象表中的位置数组，实际身份由程序绑定；不得填写 ID 或短引用。' },
      items: { items: { properties: { review_position: { type: 'integer',
        description: '选择当前对象表中的位置，实际身份由程序绑定；不得填写 ID 或短引用。' } }, required: ['review_position'] } },
    }, required: ['section_position', 'requirement_positions', 'items'] })
    expect(JSON.stringify(schema)).not.toContain('填写真实 Requirement ID')
    expect(validateJsonSchemaValue(schema, {
      section_position: null, requirement_positions: [1], items: [{ review_position: 0 }],
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, { section_id: 'SEC-001', requirement_positions: [1], items: [{ review_position: 0 }] })).not.toEqual([])
  })

  it.each([
    ['section_id', 'SEC-001', 'section_position', '位置'],
    ['requirement_ids', ['REQ-007'], 'requirement_positions', '位置数组'],
    ['review_ref', 'REVIEW-1', 'review_position', '位置'],
  ])('拒绝 %s 并直接指明接受的模型字段', (canonical, value, model, selection) => {
    let failure: unknown
    try { positions.bind({ nested: { [canonical]: value } }) } catch (error: unknown) { failure = error }
    expect(failure).toBeInstanceOf(ToolArgsError)
    expect((failure as ToolArgsError).violations).toEqual([
      `${canonical}: 不得填写 ID 或短引用；请使用 ${model} 选择当前对象表中的${selection}，实际身份由程序绑定。`,
    ])
  })

  it('身份仍由程序绑定，位置范围、数组和确定性字段拒绝规则不变', () => {
    expect(positions.bind({ section_position: 1, requirement_positions: [0], items: [{ review_position: 0 }] })).toEqual({
      section_id: 'SEC-002', requirement_ids: ['REQ-007'], items: [{ review_ref: 'REVIEW-1' }],
    })
    for (const value of [{ section_position: 2 }, { section_position: -1 }, { requirement_positions: 0 },
      { writable: true }, { order: 1 }]) {
      expect(() => positions.bind(value)).toThrow(ToolArgsError)
    }
  })

  it('同级排序也说明模型位置及程序生成顺序，保留可空身份选择', () => {
    const schema = positions.schema({ type: 'object', properties: { order: { type: 'integer' }, writable: { type: 'boolean' } },
      required: ['order', 'writable'], additionalProperties: false })
    assertSupportedJsonSchema(schema)
    expect(schema).toMatchObject({ properties: { sibling_position: { type: 'integer',
      description: '选择同级顺序的位置（从 0 开始），正式顺序由程序生成。' } }, required: ['sibling_position'] })
    expect(positions.bind({ sibling_position: 0 })).toEqual({ order: 1 })
    expect(positions.bind({ section_position: null })).toEqual({ section_id: null })
  })
})
