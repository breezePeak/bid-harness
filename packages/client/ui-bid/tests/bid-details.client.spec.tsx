// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BidClientProjection, BidDetailsView } from '@deepseek-ai/dsh-bid/control-plane'
import { BidDetails } from '../src/client/BidDetails.tsx'

afterEach(cleanup)

const details: BidDetailsView = {
  tender: {
    project: { schema_version: 1, project_name: '已确认项目', tender_name: null, purchaser: null, owner: null, project_background: [], project_objectives: [], project_scope: [], technical_scope: [], delivery_scope: [], implementation_constraints: [], key_technical_points: [], source_refs: [], analyzed_tender_files: [] },
    requirements: { schema_version: 1, requirements: [] },
    scoring: { schema_version: 1, scoring_items: [] },
    compliance: { schema_version: 1, compliance_items: [] },
  },
  outline: { schema_version: 3, scope: 'technical_bid', document_title: '项目技术标', global_compliance_ids: [], sections: [{
    id: 'SEC-1', parent_id: null, order: 1, level: 1, title: 'S3 已确认目录', purpose: '交付要求', writable: true,
    must_answer: ['按期交付'], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
    scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }] },
  body: false,
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
  getDetails.mockResolvedValue({ ...details, body: true, outline: { ...details.outline!, sections: details.outline!.sections.map(section => ({ ...section, title: 'S4 最终目录' })) } })
  view.rerender(<BidDetails {...props({ stage: 'chapter_writing', status: 'running' }, { getDetails })} />)
  expect(await screen.findByDisplayValue('S4 最终目录')).toBeTruthy()
  expect(screen.queryByDisplayValue('S3 已确认目录')).toBeNull()
  view.unmount()
  render(<BidDetails {...props({ stage: 'docx_export', status: 'completed' }, { getDetails })} />)
  expect(await screen.findByDisplayValue('S4 最终目录')).toBeTruthy()
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
