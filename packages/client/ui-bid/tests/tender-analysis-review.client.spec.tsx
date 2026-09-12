// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TenderAnalysisConfirmationView } from '@deepseek-ai/dsh-bid/control-plane'
import { TenderAnalysisReview } from '../src/client/TenderAnalysisReview.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const source = { file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 1 }
const value: TenderAnalysisConfirmationView = {
  project: { schema_version: 1, project_name: '项目', tender_name: null, purchaser: null, owner: null, project_background: [], project_objectives: [], project_scope: [], technical_scope: [], delivery_scope: [], implementation_constraints: [], key_technical_points: [], source_refs: [source], analyzed_tender_files: ['tender'] },
  requirements: { schema_version: 1, requirements: [] },
  scoring: { schema_version: 1, scoring_items: ['总体方案', '实施方案'].map((title, index) => ({
    id: `SC-${String(index + 1)}`, parent: null, group: '技术评分', title, raw_text: `${title}原文`,
    criterion: `${title}标准`, score: 10 - index, score_range: null, must_answer: true, source_refs: [source],
  })) },
  selected_scoring_ids: ['SC-1', 'SC-2'],
  compliance: { schema_version: 1, compliance_items: [] },
}

it('单独持久化是否纳入响应，不修改 must_answer，并在确认时保留规范化操作', async () => {
  const saveSelection = vi.fn(async (_id: string, _selected: boolean): Promise<TenderAnalysisConfirmationView> => ({
    ...value,
    selected_scoring_ids: ['SC-1'],
  }))
  const confirm = vi.fn()
  render(<TenderAnalysisReview
    value={value} pending={false} onScoringSelectionChange={saveSelection}
    onConfirm={confirm} t={key => zh[key]}
  />)

  fireEvent.click(screen.getByRole('button', { name: /技术评分要点/ }))
  const row = screen.getByText('实施方案').closest('tr')!
  fireEvent.click(within(row).getByRole('checkbox', { name: /已纳入后续响应/ }))

  await waitFor(() => { expect(saveSelection).toHaveBeenCalledWith('SC-2', false) })
  expect(within(row).getByRole('checkbox', { name: /未纳入后续响应/ })).toHaveProperty('checked', false)
  expect(within(row).getByRole('checkbox', { name: /必答评分点/ })).toHaveProperty('checked', true)
  fireEvent.click(screen.getByRole('button', { name: '确认技术标分析' }))
  expect(confirm).toHaveBeenCalledWith([])
})

it('切换自动确认时提交当前已编辑内容而不是空操作', async () => {
  const confirm = vi.fn()
  const shared = {
    value,
    pending: false,
    onConfirm: confirm,
    t: (key: keyof typeof zh) => zh[key],
  }
  const view = render(<TenderAnalysisReview {...shared} />)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '自动确认后的项目名称' } })

  view.rerender(<TenderAnalysisReview {...shared} autoConfirm />)

  await waitFor(() => {
    expect(confirm).toHaveBeenCalledWith([
      { type: 'update_project', fields: { project_name: '自动确认后的项目名称' } },
    ])
  })
})

it('默认选中项目整体情况，并以表格形式展示 11 项要素', () => {
  render(<TenderAnalysisReview
    value={value} pending={false}
    onConfirm={vi.fn()} t={key => zh[key]}
  />)

  const projectTab = screen.getByRole('button', { name: /项目整体情况/ })
  expect(projectTab.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('项目整体情况要素表')).toBeTruthy()
  expect(screen.getByLabelText('项目名称')).toBeTruthy()
  expect(screen.getByLabelText('项目背景')).toBeTruthy()
})
