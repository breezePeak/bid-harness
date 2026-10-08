import { describe, expect, it } from 'vitest'
import { normalizeOutlineSectionTitle } from '../src/control-plane.ts'
import { applyOutlineEdits, buildOutlineView } from '../src/outline-confirmation-browser.ts'
import { ensureTechnicalDeviationSection } from '../src/outline-generation-normalization.ts'
import { parseOutlineArtifact, type OutlineSection } from '../src/outline-generation-artifacts.ts'

const leaf: OutlineSection = {
  id: 'leaf', parent_id: null, order: 1, level: 1, title: '方案', purpose: '说明实施方案', writable: true,
  must_answer: ['说明实施安排'], requirement_ids: ['REQ-1'], scoring_ids: [], compliance_ids: [],
  origin: 'framework', framework_refs: [{ file_id: 'source', heading_path: ['第一章 原文'] }],
  scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
}

describe('输出章节名称', () => {
  it.each([
    ['项目背景', '项目背景'], ['一、项目背景', '项目背景'], ['二、项目组织管理', '项目组织管理'],
    ['第一章 项目背景', '项目背景'], ['第2章项目背景', '项目背景'], ['（一）项目背景', '项目背景'],
    ['(2) 项目背景', '项目背景'], ['1、项目背景', '项目背景'], ['1. 项目背景', '项目背景'],
    ['1.1 项目背景', '项目背景'], ['1.1.1 项目背景', '项目背景'], ['２．１　１．１　项目背景', '项目背景'],
    ['１．　项目（Ａ）．背景', '项目（Ａ）．背景'], ['第２章　项目背景', '项目背景'],
    ['2.1 1.1 项目背景', '项目背景'], ['第二章 一、项目理解', '项目理解'], ['一、', ''], ['第一章', ''],
    ...['2026年度包7国家……', '2025 年度成果', '3D建模', '5G通信', '1.5米精度控制', 'V1.1接口',
      'GB/T 19001—2016质量管理', '1.1项目背景', '1:500 地形图', '2.1米精度'].map(title => [title, title]),
  ])('净化 %s 为 %s 并保持幂等', (input, expected) => {
    expect(normalizeOutlineSectionTitle(input)).toBe(expected)
    expect(normalizeOutlineSectionTitle(normalizeOutlineSectionTitle(input))).toBe(expected)
  })

  it('混合旧号目录保留原对象和来源路径，程序只从完整树生成当前编号', () => {
    const names = ['一、项目理解与总体技术方案', '1.1 项目背景、目标与范围', '1.2 总体技术路线与作业安排',
      '二、项目组织管理', '2.1 项目组织机构与岗位职责']
    const sections = names.map((title, index) => ({ ...leaf, title, id: `S${index}`,
      parent_id: index === 1 || index === 2 ? 'S0' : index === 4 ? 'S3' : null,
      order: index === 2 || index === 3 ? 2 : 1, level: index === 1 || index === 2 || index === 4 ? 2 : 1,
      writable: index !== 0 && index !== 3, must_answer: index === 0 || index === 3 ? [] : leaf.must_answer,
    }))
    const before = JSON.stringify(sections)
    const view = buildOutlineView(ensureTechnicalDeviationSection(sections))
    expect(view.map(({ section, number }) => `${number} ${normalizeOutlineSectionTitle(section.title)}`)).toEqual([
      '1 技术偏离表', '2 项目理解与总体技术方案', '2.1 项目背景、目标与范围', '2.2 总体技术路线与作业安排',
      '3 项目组织管理', '3.1 项目组织机构与岗位职责',
    ])
    expect(view.find(item => item.section.id === 'S1')?.section).toBe(sections[1])
    expect(JSON.stringify(sections)).toBe(before)
  })

  it.each(['第一章 技术偏离表', '一、技术偏离表', '１．技术偏离表'])('识别现有 %s 而不新增偏离表，真实重复仍拒绝', (title) => {
    const sections = [{ ...leaf, title }]
    expect(ensureTechnicalDeviationSection(sections).map(section => section.title)).toEqual(['技术偏离表'])
    expect(() => ensureTechnicalDeviationSection([...sections, { ...leaf, id: 'another', title: '技术偏离表' }])).toThrow('只能包含一个')
    expect(sections[0]?.id).toBe('leaf')
  })

  it('拆分和合并清理新标题，移动和删除不清理未提交的旧标题或来源', () => {
    const source = parseOutlineArtifact({ schema_version: 3, scope: 'technical_bid', document_title: '技术标',
      global_compliance_ids: [], sections: [{ ...leaf, title: '一、方案' }] })
    const split = applyOutlineEdits(source, [{ type: 'split_section', section_id: 'leaf', children: [
      { title: '1.1 实施', purpose: '实施', must_answer: ['实施'] },
      { title: '1.2 交付', purpose: '交付', must_answer: ['交付'] },
    ] }])
    expect(split.sections.map(section => section.title)).toEqual(['一、方案', '实施', '交付'])
    const merged = applyOutlineEdits(split, [{ type: 'merge_sections', section_ids: ['SEC-001', 'SEC-002'],
      title: '第二章 2.1 实施与交付', purpose: '实施与交付' }])
    expect(merged.sections[1]).toMatchObject({ id: 'SEC-001', title: '实施与交付', framework_refs: leaf.framework_refs })
    const moved = applyOutlineEdits(merged, [{ type: 'move_section', section_id: 'SEC-001', parent_id: null, order: 1 }])
    expect(buildOutlineView(moved.sections).map(item => [item.number, item.section.id])).toEqual([['1', 'SEC-001'], ['2', 'leaf']])
    const deleted = applyOutlineEdits(moved, [{ type: 'delete_section', section_id: 'SEC-001' }])
    expect(deleted.sections[0]).toMatchObject({ id: 'leaf', title: '一、方案', framework_refs: leaf.framework_refs })
    expect(source.sections[0]?.title).toBe('一、方案')
  })
})
