// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOutlineEdits, type OutlineArtifact } from '@deepseek-ai/dsh-bid/control-plane'
import { OutlineConfirmationReview } from '../src/client/OutlineConfirmationReview.tsx'
import { compareOutlines, outlineDropOperation } from '../src/client/outline-review.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let value = zh[key] ?? key
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}) as (key: string, params?: Record<string, string | number>) => string

const testOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '智慧城市项目技术标书',
  global_compliance_ids: ['COMP-01'],
  sections: [
    {
      id: 'SEC-001',
      parent_id: null,
      order: 1,
      level: 1,
      title: '总体技术方案',
      summary: '说明服务拆分、接口规范与治理策略。',
      purpose: '阐述系统总体架构设计',
      writable: false,
      must_answer: [],
      requirement_ids: ['REQ-01'],
      scoring_ids: ['SCORE-01'],
      compliance_ids: [],
      origin: 'generated',
      scoring_response_points: [{ scoring_id: 'SCORE-01', response_point: '总体架构完整性' }],
      suggested_tables: [],
      suggested_figures: [],
      writing_notes: [],
    },
    {
      id: 'SEC-002',
      parent_id: 'SEC-001',
      order: 1,
      level: 2,
      title: '系统微服务架构设计',
      purpose: '说明微服务拆分与接口规范',
      writable: true,
      must_answer: ['服务拆分原则', '服务治理策略'],
      requirement_ids: ['REQ-01', 'REQ-02'],
      scoring_ids: ['SCORE-01'],
      compliance_ids: [],
      origin: 'generated',
      scoring_response_points: [{ scoring_id: 'SCORE-01', response_point: '微服务架构成熟度' }],
      suggested_tables: [],
      suggested_figures: [],
      writing_notes: [],
    },
    {
      id: 'SEC-003',
      parent_id: null,
      order: 2,
      level: 1,
      title: '实施与交付计划',
      purpose: '提供详细项目进度与里程碑',
      writable: true,
      must_answer: ['进度横道图', '里程碑交付物'],
      requirement_ids: ['REQ-03'],
      scoring_ids: ['SCORE-02'],
      compliance_ids: [],
      origin: 'generated',
      scoring_response_points: [],
      suggested_tables: [],
      suggested_figures: [],
      writing_notes: [],
    },
  ],
}

describe('OutlineConfirmationReview', () => {
  it('shows a compact outline with actions and metadata in the selected details', () => {
    const onUpdate = vi.fn()
    const onStructure = vi.fn()
    const onIndent = vi.fn()
    const onOutdent = vi.fn()

    render(
      <OutlineConfirmationReview
        outline={testOutline}
        stage="outline_generation"
        draftSaveState="saved"
        revision={1}
        onUpdateSection={onUpdate}
        onStructureOperation={onStructure}
        onIndentSection={onIndent}
        onOutdentSection={onOutdent}
        t={t as never}
      />,
    )

    // 标题与阶段 Badge
    expect(screen.getByText('智慧城市项目技术标书')).toBeTruthy()
    expect(screen.getByText('S3 · 初步技术标目录审核')).toBeTruthy()
    expect(screen.getByText(/已保存/)).toBeTruthy()

    // 核心指标统计
    expect(screen.getByText('章节总数')).toBeTruthy()
    expect(screen.getByText('2 个一级大章')).toBeTruthy()
    expect(screen.getByText('正文编写章节')).toBeTruthy()
    expect(screen.getByText('1 个分类结构')).toBeTruthy()
    expect(screen.getByText('项 REQ 已分配')).toBeTruthy()

    // 章节徽章区分
    expect(screen.getByText('结构目录')).toBeTruthy()
    expect(screen.getByLabelText('技术标目录').textContent).not.toContain('新增同级')
    fireEvent.focus(screen.getByLabelText('SEC-002 标题'))
    expect(screen.getByLabelText('当前章节详情').textContent).toContain('正文编写')
    fireEvent.click(screen.getByRole('button', { name: '新增同级' }))
    expect(onStructure).toHaveBeenCalledWith(expect.objectContaining({ parent_id: 'SEC-001', order: 2 }))

    // 章节编号与输入框
    expect(screen.getByLabelText('SEC-001 标题')).toBeTruthy()
    expect(screen.getByLabelText('SEC-002 标题')).toBeTruthy()
    expect(screen.getByLabelText('SEC-003 标题')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑 实施与交付计划' }))
    expect(document.activeElement).toBe(screen.getByLabelText('SEC-003 标题'))
    fireEvent.change(document.activeElement!, { target: { value: '交付验收' } })
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByLabelText('SEC-003 标题'))
    expect(onUpdate).toHaveBeenCalledWith('SEC-003', { title: '交付验收' })
    fireEvent.click(screen.getByRole('button', { name: '删除 实施与交付计划' }))
    expect(onStructure).toHaveBeenCalledWith({ type: 'delete_section', section_id: 'SEC-003' })

  })

  it('filters sections using the search bar', () => {
    render(
      <OutlineConfirmationReview
        outline={testOutline}
        stage="evidence_mapping"
        onUpdateSection={vi.fn()}
        onStructureOperation={vi.fn()}
        onIndentSection={vi.fn()}
        onOutdentSection={vi.fn()}
        t={t as never}
      />,
    )

    expect(screen.getByText('S4 · 深化目录与材料审核')).toBeTruthy()
    const search = screen.getByPlaceholderText('搜索章节标题或编号...')
    fireEvent.change(search, { target: { value: '微服务' } })

    expect(screen.getByLabelText('SEC-002 标题')).toBeTruthy()
    expect(screen.queryByLabelText('SEC-003 标题')).toBeNull()
  })

  it('supports collapsing and expanding child branches', () => {
    render(
      <OutlineConfirmationReview
        outline={testOutline}
        onUpdateSection={vi.fn()}
        onStructureOperation={vi.fn()}
        onIndentSection={vi.fn()}
        onOutdentSection={vi.fn()}
        t={t as never}
      />,
    )

    // 折叠第一章的子树
    const toggleBtn = screen.getByRole('button', { name: '折叠 总体技术方案' })
    fireEvent.click(toggleBtn)

    // SEC-002 应该被隐藏
    expect(screen.queryByLabelText('SEC-002 标题')).toBeNull()
    expect(screen.getByText('说明服务拆分、接口规范与治理策略。')).toBeTruthy()

    // 一键全部展开
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
    expect(screen.getByLabelText('SEC-002 标题')).toBeTruthy()
  })

  it('allows adding a new top-level root section from the toolbar', () => {
    const onStructure = vi.fn()
    render(
      <OutlineConfirmationReview
        outline={testOutline}
        onUpdateSection={vi.fn()}
        onStructureOperation={onStructure}
        onIndentSection={vi.fn()}
        onOutdentSection={vi.fn()}
        t={t as never}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '+ 新增一级大章' }))
    expect(onStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'add_section',
        parent_id: null,
        order: 3,
        writable: true,
      }),
    )
  })
})


describe('目录拖拽与差异', () => {
  it('移动完整父章节，保留关联内容并重排编号', () => {
    const operation = outlineDropOperation(testOutline, 'SEC-001', 'SEC-003', 'after')!
    const moved = applyOutlineEdits(testOutline, [operation])
    expect(moved.sections.find(section => section.id === 'SEC-002')).toEqual(testOutline.sections[1])
    expect(moved.sections.find(section => section.id === 'SEC-001')?.order).toBe(2)
    expect(compareOutlines(testOutline, moved).get('SEC-001')).toMatchObject({ moved: true, modified: false })
    expect(testOutline.sections[0]?.order).toBe(1)
  })

  it('跨父移动和提升层级保留叶子业务字段，禁止非法落点', () => {
    const outline = { ...testOutline, sections: [
      ...testOutline.sections, { ...testOutline.sections[1]!, id: 'SEC-004', title: '补充架构', order: 2 },
    ] }
    const operation = outlineDropOperation(outline, 'SEC-004', 'SEC-003', 'after')!
    const moved = applyOutlineEdits(outline, [operation])
    expect(moved.sections.find(section => section.id === 'SEC-004')).toMatchObject({ parent_id: null, level: 1, requirement_ids: ['REQ-01', 'REQ-02'] })
    expect(outlineDropOperation(moved, 'SEC-004', 'SEC-001', 'inside')).toMatchObject({ parent_id: 'SEC-001', order: 1 })
    expect(outlineDropOperation(outline, 'SEC-001', 'SEC-002', 'inside')).toBeNull()
    expect(outlineDropOperation(outline, 'SEC-001', 'SEC-002', 'before')).toBeNull()
    expect(outlineDropOperation(outline, 'SEC-004', 'SEC-003', 'inside')).toBeNull()
    expect(outlineDropOperation(outline, 'REQ-01', 'SEC-001', 'inside')).toBeNull()
    expect(outlineDropOperation(outline, 'SEC-001', 'REQ-01', 'inside')).toBeNull()
    expect(outlineDropOperation(testOutline, 'SEC-002', 'SEC-003', 'after')).toBeNull()
    expect(outlineDropOperation(outline, 'SEC-001', 'SEC-001', 'inside')).toBeNull()
  })

  it('显示四类差异，过滤保留祖先，基线只读且联动选中', () => {
    const outline = { ...testOutline, sections: [testOutline.sections[0]!, { ...testOutline.sections[1]!, title: '修改后的架构', order: 2 }, { ...testOutline.sections[2]!, id: 'SEC-NEW' }] }
    const changes = compareOutlines(testOutline, outline)
    expect(changes.get('SEC-002')).toMatchObject({ modified: true, moved: true })
    expect(changes.get('SEC-003')?.deleted).toBe(true)
    expect(changes.get('SEC-NEW')?.added).toBe(true)
    render(<OutlineConfirmationReview outline={outline} stage="evidence_mapping"
      reviewContext={{ baseline: testOutline, requirements: { schema_version: 1, requirements: [] },
        scoring: { schema_version: 1, scoring_items: [] }, evidence: null }}
      onUpdateSection={vi.fn()} onStructureOperation={vi.fn()} onIndentSection={vi.fn()} onOutdentSection={vi.fn()} t={t as never} />)
    fireEvent.click(screen.getByLabelText('只看变化'))
    expect(screen.getByLabelText('SEC-001 标题')).toBeTruthy()
    fireEvent.focus(screen.getByLabelText('SEC-002 标题'))
    const baseline = screen.getByLabelText('S3 已确认目录')
    expect(baseline.querySelector('[aria-current="true"]')?.textContent).toContain('系统微服务架构设计')
    expect(baseline.querySelectorAll('[draggable="true"], input, textarea').length).toBe(0)
    expect(screen.getByLabelText('当前章节详情').textContent).toContain('修改后的架构')
  })

  it('只允许有效章节落点触发结构操作', async () => {
    const onStructure = vi.fn()
    render(<OutlineConfirmationReview outline={testOutline} onUpdateSection={vi.fn()} onStructureOperation={onStructure}
      onIndentSection={vi.fn()} onOutdentSection={vi.fn()} t={t as never} />)
    const dataTransfer = { setDragImage: vi.fn(), setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(screen.getByLabelText('拖动 总体技术方案'), { dataTransfer })
    await waitFor(() => { expect(screen.getByLabelText('SEC-002 inside').getAttribute('aria-disabled')).toBe('true') })
    expect(screen.queryByText('放在前面')).toBeNull()
    expect(screen.getByLabelText('SEC-001 章节编号').textContent).toBe('1')
    fireEvent.drop(screen.getByLabelText('SEC-002 inside'), { dataTransfer })
    expect(onStructure).not.toHaveBeenCalled()
    fireEvent.dragOver(screen.getByLabelText('SEC-003 after'), { dataTransfer })
    fireEvent.drop(screen.getByLabelText('SEC-003 after'), { dataTransfer })
    expect(onStructure).toHaveBeenCalledWith({ type: 'move_section', section_id: 'SEC-001', parent_id: null, order: 2 })
    expect(screen.getByLabelText('当前章节详情').querySelector('[draggable="true"]')).toBeNull()
  })
})
