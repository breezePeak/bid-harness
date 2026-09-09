// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BidClientProjection, BidDetailsView } from '@deepseek-ai/dsh-bid/control-plane'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BidDetails } from '../src/client/BidDetails.tsx'

afterEach(cleanup)

const details: BidDetailsView = {
  tender: {
    project: { schema_version: 1, project_name: '已确认项目', tender_name: null, purchaser: null, owner: null, project_background: [], project_objectives: [], project_scope: [], technical_scope: [], delivery_scope: [], implementation_constraints: [], key_technical_points: [], source_refs: [], analyzed_tender_files: [] },
    requirements: { schema_version: 1, requirements: [] },
    scoring: { schema_version: 1, scoring_items: [] },
    selected_scoring_ids: [],
    compliance: { schema_version: 1, compliance_items: [] },
  },
  outline: { schema_version: 3, scope: 'technical_bid', document_title: '项目技术标', global_compliance_ids: [], sections: [{
    id: 'SEC-1', parent_id: null, order: 1, level: 1, title: 'S3 已确认目录', purpose: '交付要求', writable: true,
    must_answer: ['按期交付'], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
    scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }] },
  body: false,
  outlinePresentation: { source: 'initial_confirmed', baseline: null, evidence: null, errors: [] },
}

const finalDetails: BidDetailsView = {
  ...details, body: true,
  outline: { ...details.outline!, sections: details.outline!.sections.map(section => ({ ...section, title: 'S4 最终目录', must_answer: ['交付前完成质量核验'] })) },
  outlinePresentation: { source: 'final_confirmed', baseline: details.outline, errors: [], evidence: {
    schema_version: 10, section_mappings: [{ section_id: 'SEC-1', local_materials: [], web_materials: [], missing_topics: ['验收清单'], writing_dimensions: ['已有资料中的质量核验流程'] }],
  } },
}

function expectFinalDetails() {
  const baseline = screen.getByLabelText('S3 已确认目录')
  const current = screen.getByLabelText('技术标目录')
  expect(within(baseline).getByRole('button', { name: 'S3 已确认目录' })).toBeTruthy()
  expect(within(current).getByDisplayValue('S4 最终目录')).toHaveProperty('readOnly', true)
  expect(within(current).queryByDisplayValue('S3 已确认目录')).toBeNull()
  expect(screen.getByLabelText('当前章节详情')).toBeTruthy()
  expect(screen.getByText('最终目录已确认 / 只读')).toBeTruthy()
  expect(screen.getByLabelText('目录差异汇总').textContent).toContain('编写要求更新 1')
  expect(screen.getByLabelText('本章变化').textContent).toContain('交付前完成质量核验')
  expect(screen.getByText('已有资料中的质量核验流程')).toBeTruthy()
  expect(screen.queryByText('已保存')).toBeNull()
  expect(screen.queryByRole('button', { name: /编辑|删除|拖动|新增|上移|下移|缩进|使用该目录/ })).toBeNull()
  expect(current.querySelector('[draggable="true"]')).toBeNull()
}

function props(runtime: BidClientProjection['runtime'], patch: Partial<Parameters<typeof BidDetails>[0]> = {}): Parameters<typeof BidDetails>[0] {
  return {
    sessionId: 'bid', kind: 'outline',
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime, allowedActions: [] }),
    getDetails: vi.fn(async () => details),
    setReviewSurface: vi.fn(),
    ...patch,
  } as Parameters<typeof BidDetails>[0]
}

it('S4 运行时只读 S3 确认目录，后续阶段和重新挂载读取最终目录', async () => {
  const getDetails = vi.fn(async () => details)
  const view = render(<BidDetails {...props({ stage: 'evidence_mapping', status: 'running' }, { getDetails })} />)
  expect(await screen.findByDisplayValue('S3 已确认目录')).toHaveProperty('readOnly', true)
  expect(screen.queryByRole('button', { name: '编辑 S3 已确认目录' })).toBeNull()
  expect(screen.queryByRole('button', { name: '+ 新增一级大章' })).toBeNull()
  expect(screen.getByLabelText('SEC-1 目的')).toHaveProperty('readOnly', true)
  expect(screen.queryByLabelText('S3 已确认目录')).toBeNull()
  getDetails.mockResolvedValue(finalDetails)
  view.rerender(<BidDetails {...props({ stage: 'chapter_writing', status: 'running' }, { getDetails })} />)
  expect(await screen.findByDisplayValue('S4 最终目录')).toBeTruthy()
  expectFinalDetails()
  view.unmount()
  render(<BidDetails {...props({ stage: 'docx_export', status: 'completed' }, { getDetails })} />)
  expect(await screen.findByDisplayValue('S4 最终目录')).toBeTruthy()
  expectFinalDetails()
})

it.each([
  ['chapter_writing', 'running'], ['chapter_writing', 'failed'], ['chapter_writing', 'completed'],
  ['docx_export', 'pending'], ['docx_export', 'running'], ['docx_export', 'failed'], ['docx_export', 'completed'],
] as const)('%s / %s 刷新挂载保持三列、差异和资料，并可继续导航', async (stage, status) => {
  render(<BidDetails {...props({ stage, status }, { getDetails: vi.fn(async () => finalDetails) })} />)
  await screen.findByDisplayValue('S4 最终目录')
  expectFinalDetails()
  fireEvent.click(within(screen.getByLabelText('S3 已确认目录')).getByRole('button', { name: 'S3 已确认目录' }))
  for (const label of ['S3 已确认目录', '技术标目录']) expect(screen.getByLabelText(label).querySelector('[aria-current="true"]')?.getAttribute('data-section-id')).toBe('SEC-1')
  fireEvent.click(screen.getByRole('checkbox', { name: '仅看变化' }))
  fireEvent.click(screen.getByRole('button', { name: '全部折叠' }))
  fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '无此章节' } })
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '无此章节')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  expectFinalDetails()
})

it.each(['unchanged', 'must_answer', 'evidence'] as const)('结构相同且 %s 时仍按最终目录来源展示三列', async (kind) => {
  const value = structuredClone(finalDetails)
  value.outline = structuredClone(details.outline)
  if (kind === 'must_answer') value.outline!.sections[0]!.must_answer = ['深化后的核验要求']
  if (kind === 'evidence') value.outlinePresentation!.evidence!.section_mappings[0]!.local_materials = [{ source_kind: 'reference', file_id: 'FILE-QUALITY', chunk: 'chunk_0001', usage: 'reference', summary: '核验流程资料' }]
  if (kind === 'unchanged') value.outlinePresentation!.evidence = { schema_version: 10, section_mappings: [] }
  render(<BidDetails {...props({ stage: 'chapter_writing', status: 'running' }, { getDetails: async () => value })} />)
  await screen.findByText('最终目录已确认 / 只读')
  expect(screen.getByLabelText('S3 已确认目录')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'S4 最终确认目录' })).toBeTruthy()
  if (kind === 'must_answer' || kind === 'evidence') expect(screen.getByText('目录结构未变，章节信息已更新')).toBeTruthy()
  else expect(screen.getByText('目录与章节信息一致')).toBeTruthy()
  if (kind === 'evidence') {
    expect(screen.getByText('已有资料中的质量核验流程')).toBeTruthy()
    expect(screen.getByLabelText('本章变化').textContent).toContain('核验流程资料')
    expect(screen.getByLabelText('目录差异汇总').textContent).toContain('关联信息更新 1')
  }
})

it('基线或资料读取异常明确显示错误，不能退回两列', async () => {
  const value: BidDetailsView = { ...finalDetails, outlinePresentation: { source: 'final_confirmed', baseline: null, evidence: null, errors: ['initial-confirmed-outline.json 读取失败', 'evidence-map.json 读取失败'] } }
  render(<BidDetails {...props({ stage: 'chapter_writing', status: 'running' }, { getDetails: async () => value })} />)
  await screen.findByText('最终目录已确认 / 只读')
  expect(screen.getAllByRole('alert').map(element => element.textContent)).toEqual(value.outlinePresentation!.errors)
  expect(screen.getByLabelText('S3 已确认目录')).toBeTruthy()
  expect(screen.getByLabelText('当前章节详情')).toBeTruthy()
})

it('旧异步详情不能覆盖新会话；阶段重置恢复初步目录模式', async () => {
  let finishOld!: (value: BidDetailsView) => void
  const old = new Promise<BidDetailsView>((resolve) => { finishOld = resolve })
  const view = render(<BidDetails {...props({ stage: 'chapter_writing', status: 'running' }, { getDetails: () => old })} />)
  view.rerender(<BidDetails {...props({ stage: 'docx_export', status: 'completed' }, {
    sessionId: SessionId('new'), useSessions: ((selector: (state: unknown) => unknown) => selector({ byId: { new: { agentPreset: 'bid' } } })) as Parameters<typeof BidDetails>[0]['useSessions'],
    getDetails: async () => finalDetails,
  })} />)
  await screen.findByText('最终目录已确认 / 只读')
  await act(async () => { finishOld(details); await old })
  expectFinalDetails()
  view.rerender(<BidDetails {...props({ stage: 'evidence_mapping', status: 'running' })} />)
  await screen.findByDisplayValue('S3 已确认目录')
  expect(screen.queryByLabelText('S3 已确认目录')).toBeNull()
  expect(screen.queryByText('最终目录已确认 / 只读')).toBeNull()
})

it('S6 恢复最终招标信息并隐藏确认和编辑操作', async () => {
  render(<BidDetails {...props({ stage: 'docx_export', status: 'completed' }, { kind: 'tender' })} />)
  await screen.findByRole('region', { name: '招标详情' })
  fireEvent.click(screen.getByRole('button', { name: /项目整体情况/ }))
  expect(screen.getAllByText('已确认项目').length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: '确认技术标分析' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑 / })).toBeNull()
})

it.each([
  ['tender', 'tender_analysis', 'confirm_tender_analysis'],
  ['outline', 'evidence_mapping', 'confirm_outline'],
] as const)('待确认 %s 详情继续承载原确认面板', async (kind, stage, action) => {
  const setReviewSurface = vi.fn()
  const getDetails = vi.fn(async () => details)
  const view = render(<BidDetails {...props({ stage, status: 'waiting_user' }, {
    kind, setReviewSurface, getDetails,
    useProjection: (() => ({ runtime: { stage, status: 'waiting_user' }, allowedActions: [action] })),
  })} />)
  await waitFor(() => { expect(setReviewSurface).toHaveBeenCalledWith(expect.any(HTMLDivElement)) })
  expect(getDetails).not.toHaveBeenCalled()
  view.unmount()
  expect(setReviewSurface).toHaveBeenLastCalledWith(null)
})
