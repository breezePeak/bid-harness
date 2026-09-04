import { describe, expect, it } from 'vitest'
import {
  applyOutlineEdits,
  buildOutlineView,
  outlineArtifactSha256,
  parseOutlineEditOperations,
  parseOutlineConfirmationArtifact,
  type OutlineArtifact,
} from '@deepseek-ai/dsh-bid'

const outline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术标',
  global_compliance_ids: [],
  sections: [{
    id: 'SEC-001', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付要求', writable: true,
    must_answer: ['交付计划'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated', scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

describe('outline confirmation artifacts', () => {
  it('拆分和合并保留稳定父 ID、引用覆盖和可写叶子规则', () => {
    const split = applyOutlineEdits(outline, parseOutlineEditOperations([{ type: 'split_section', section_id: 'SEC-001', children: [
      { title: '交付准备', purpose: '准备', must_answer: ['交付准备计划'] },
      { title: '交付实施', purpose: '实施', must_answer: ['交付实施计划'] },
    ] }]))
    expect(split.sections[0]).toMatchObject({ id: 'SEC-001', writable: false, must_answer: [] })
    expect(split.sections.slice(1).map(item => item.requirement_ids)).toEqual([['REQ-1'], ['REQ-1']])
    const merged = applyOutlineEdits(split, parseOutlineEditOperations([{ type: 'merge_sections', section_ids: ['SEC-002', 'SEC-003'], title: '交付细则', purpose: '准备与实施' }]))
    expect(merged.sections).toHaveLength(2)
    expect(merged.sections[1]).toMatchObject({ id: 'SEC-002', parent_id: 'SEC-001', requirement_ids: ['REQ-1'], must_answer: ['交付准备计划', '交付实施计划'] })
    expect(outline.sections[0]!.writable).toBe(true)
    expect(() => applyOutlineEdits(split, [{ type: 'merge_sections', section_ids: ['SEC-001', 'SEC-002'], title: '无效', purpose: '无效' }])).toThrow()
  })
  it('parses only the complete durable confirmation record', () => {
    const hash = outlineArtifactSha256(outline)
    expect(parseOutlineConfirmationArtifact({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: hash, confirmed_outline_sha256: hash, confirmed_draft_revision: 1, confirmed_draft_sha256: hash }))
      .toMatchObject({ decision: 'confirmed' })
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: hash }))
      .toThrow()
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 2, scope: 'commercial_bid', decision: 'confirmed', source_outline_sha256: hash, confirmed_outline_sha256: hash, confirmed_draft_revision: 1, confirmed_draft_sha256: hash }))
      .toThrow()
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 2, scope: 'technical_bid', decision: 'rejected', source_outline_sha256: hash, confirmed_outline_sha256: hash, confirmed_draft_revision: 1, confirmed_draft_sha256: hash }))
      .toThrow()
  })

  it('updates user-editable fields without changing coverage identifiers', () => {
    const edited = applyOutlineEdits(outline, parseOutlineEditOperations([{ type: 'update_section', section_id: 'SEC-001', title: '已确认交付方案', purpose: '更新说明', summary: '说明交付计划及对应的保障措施。', must_answer: ['交付计划', '保障措施'] }]))
    expect(edited.sections[0]).toMatchObject({ title: '已确认交付方案', purpose: '更新说明', summary: '说明交付计划及对应的保障措施。', must_answer: ['交付计划', '保障措施'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'] })
    expect(outline.sections[0]?.title).toBe('交付方案')
  })

  it('assigns Host-controlled ids to added sections', () => {
    const edited = applyOutlineEdits(outline, [{ type: 'add_section', parent_id: null, order: 2, writable: true, title: '新增章节', purpose: '补充响应', must_answer: ['补充内容'] }])
    expect(edited.sections[1]).toMatchObject({ id: 'SEC-002', parent_id: null, level: 1 })
  })

  it('rejects malformed browser operations and unknown edits', () => {
    expect(() => parseOutlineEditOperations([{ type: 'add_section', parent_id: null, order: 1, writable: true, title: '新增', purpose: '补充', must_answer: [] }])).toThrow()
    expect(() => parseOutlineEditOperations([{ type: 'unknown', section_id: 'SEC-001' }])).toThrow()
    expect(() => applyOutlineEdits(outline, [{ type: 'delete_section', section_id: 'SEC-404' }])).toThrow('unknown outline section')
  })

  it('updates every descendant level and keeps sibling orders unique after a move', () => {
    const tree: OutlineArtifact = { ...outline, sections: [
      { ...outline.sections[0]!, id: 'A', order: 1, level: 1 },
      { ...outline.sections[0]!, id: 'B', parent_id: 'A', order: 1, level: 2 },
      { ...outline.sections[0]!, id: 'C', parent_id: 'B', order: 1, level: 3 },
      { ...outline.sections[0]!, id: 'D', parent_id: null, order: 2, level: 1 },
      { ...outline.sections[0]!, id: 'E', parent_id: 'D', order: 1, level: 2 },
    ] }
    const moved = applyOutlineEdits(tree, [{ type: 'move_section', section_id: 'B', parent_id: 'E', order: 1 }])
    expect(moved.sections.find(section => section.id === 'B')).toMatchObject({ parent_id: 'E', level: 3 })
    expect(moved.sections.find(section => section.id === 'C')).toMatchObject({ level: 4 })
    expect(() => applyOutlineEdits(tree, [{ type: 'move_section', section_id: 'A', parent_id: 'C', order: 1 }])).toThrow('descendant')
  })

  it('inserts moved and added siblings at their requested positions', () => {
    const tree: OutlineArtifact = { ...outline, sections: [
      { ...outline.sections[0]!, id: 'A', title: 'A', order: 1 },
      { ...outline.sections[0]!, id: 'B', title: 'B', order: 2 },
      { ...outline.sections[0]!, id: 'C', title: 'C', order: 3 },
    ] }
    const moved = applyOutlineEdits(tree, [{ type: 'move_section', section_id: 'C', parent_id: null, order: 2 }])
    expect(buildOutlineView(moved.sections).map(item => `${item.number} ${item.section.title}`)).toEqual(['1 A', '2 C', '3 B'])
    const added = applyOutlineEdits(tree, [{ type: 'add_section', parent_id: null, order: 2, writable: true, title: '新增', purpose: '补充', must_answer: ['待补充'] }])
    expect(buildOutlineView(added.sections).map(item => `${item.number} ${item.section.title}`)).toEqual(['1 A', '2 新增', '3 B', '4 C'])
  })
})
