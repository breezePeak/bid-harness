import { describe, expect, it } from 'vitest'
import {
  applyOutlineEdits,
  outlineArtifactSha256,
  parseOutlineConfirmationArtifact,
  type OutlineArtifact,
} from '@deepseek-ai/dsh-bid'

const outline: OutlineArtifact = {
  schema_version: 1,
  scope: 'technical_bid',
  document_title: '技术标',
  global_compliance_ids: [],
  sections: [{
    id: 'SEC-001', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付要求', writable: true,
    must_answer: ['交付计划'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

describe('outline confirmation artifacts', () => {
  it('parses only the complete durable confirmation record', () => {
    const hash = outlineArtifactSha256(outline)
    expect(parseOutlineConfirmationArtifact({ schema_version: 1, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: hash, confirmed_outline_sha256: hash }))
      .toMatchObject({ decision: 'confirmed' })
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 1, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: hash }))
      .toThrow()
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 1, scope: 'commercial_bid', decision: 'confirmed', source_outline_sha256: hash, confirmed_outline_sha256: hash }))
      .toThrow()
    expect(() => parseOutlineConfirmationArtifact({ schema_version: 1, scope: 'technical_bid', decision: 'rejected', source_outline_sha256: hash, confirmed_outline_sha256: hash }))
      .toThrow()
  })

  it('updates user-editable fields without changing mapped identifiers', () => {
    const edited = applyOutlineEdits(outline, [{ type: 'update_section', section_id: 'SEC-001', title: '已确认交付方案', purpose: '更新说明', must_answer: ['交付计划', '保障措施'] }])
    expect(edited.sections[0]).toMatchObject({ title: '已确认交付方案', purpose: '更新说明', must_answer: ['交付计划', '保障措施'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'] })
    expect(outline.sections[0]?.title).toBe('交付方案')
  })

  it('assigns Host-controlled ids to added sections', () => {
    const edited = applyOutlineEdits(outline, [{ type: 'add_section', parent_id: null, order: 2, writable: true, title: '新增章节', purpose: '补充响应', must_answer: ['补充内容'] }])
    expect(edited.sections[1]).toMatchObject({ id: 'SEC-002', parent_id: null, level: 1 })
  })
})
