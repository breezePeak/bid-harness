// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutlineArtifact } from '@deepseek-ai/dsh-bid/control-plane'
import { OutlineConfirmationReview } from '../src/client/OutlineConfirmationReview.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let value = zh[key] ?? String(key)
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
  it('renders stats dashboard and section cards with level distinctions', () => {
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
    expect(screen.getAllByText('正文编写').length).toBe(2)

    // 章节编号与输入框
    expect(screen.getByLabelText('SEC-001 标题')).toBeTruthy()
    expect(screen.getByLabelText('SEC-002 标题')).toBeTruthy()
    expect(screen.getByLabelText('SEC-003 标题')).toBeTruthy()
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
