// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidReviewWorkbench, type BidReviewWorkbenchProps } from '../src/client/BidReviewWorkbench.tsx'

afterEach(cleanup)

const workbench = {
  schema_version: 1 as const,
  outline: [
    { section_id: 'ROOT', parent_id: null, order: 1, title: '技术方案', summary: '说明项目实施流程、人员分工与质量控制措施。', writable: false, writing_status: 'not_started' as const, review_status: 'not_started' as const, content_available: false },
    { section_id: 'SEC-1', parent_id: 'ROOT', order: 1, title: '实施方案', writable: true, writing_status: 'content_ready' as const, review_status: 'reviewing' as const, content_available: true },
  ],
  summary: { chapter_count: 1, content_count: 1, reviewed_count: 0, needs_attention_count: 0 },
}

const chapter = {
  section_id: 'SEC-1', title: '实施方案', number: '1.1', heading_path: ['技术方案', '实施方案'], writable: true,
  markdown: '章节正文', requirement_ids: ['REQ-1'], scoring_response_point_ids: ['RP-000001'], evidence_status: 'available' as const,
  materials: [{ source_kind: 'reference_bid' as const, source_label: '参考旧标', file_id: 'ref-01.docx', usage: 'adapt', summary: '历史同类实施方案' }],
  review: { status: 'reviewing' as const, issues: [] },
}

function props(patch: Partial<BidReviewWorkbenchProps> = {}): BidReviewWorkbenchProps {
  return {
    sessionId: 'bid' as SessionId,
    useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'bid' } } } as never),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'running' } }),
    renderSlot: (name: string) => <div data-slot={name} />,
    getWorkbench: async () => workbench,
    getChapter: async () => chapter,
    setEmbeddedSurface: () => {},
    ...patch,
  } as BidReviewWorkbenchProps
}

describe('BidReviewWorkbench', () => {
  it('成功刷新后清除之前的请求错误', async () => {
    const getWorkbench = vi.fn(async () => workbench).mockRejectedValueOnce(new Error('BID_REVIEW_NOT_ALLOWED'))
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    expect(await screen.findByText('BID_REVIEW_NOT_ALLOWED')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.queryByText('BID_REVIEW_NOT_ALLOWED')).toBeNull()
  })

  it('较早请求的迟到错误不会覆盖成功刷新的页面', async () => {
    let rejectOld!: (reason: Error) => void
    const pending = new Promise<typeof workbench>((_resolve, reject) => { rejectOld = reject })
    const getWorkbench = vi.fn(async () => workbench).mockReturnValueOnce(pending)
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('章节正文')).toBeTruthy()
    await act(async () => { rejectOld(new Error('旧请求失败')) })
    expect(screen.queryByText('旧请求失败')).toBeNull()
    expect(screen.getByText('章节正文')).toBeTruthy()
  })

  it('shows chapter content as soon as the writer publishes it', async () => {
    render(<BidReviewWorkbench {...props()} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.getByText('正文 1/1')).toBeTruthy()
    expect(screen.getByText('参考资料')).toBeTruthy()
    expect(screen.getByText('历史同类实施方案')).toBeTruthy()
    expect(screen.getByText('Evidence：available')).toBeTruthy()
  })

  it('disables sections whose content is not available', async () => {
    render(<BidReviewWorkbench {...props()} />)
    const root = await screen.findByRole('button', { name: /技术方案/ })
    expect(root).toHaveProperty('disabled', true)
    expect(screen.queryByText('说明项目实施流程、人员分工与质量控制措施。')).toBeNull()
  })

  it('polls the live S5 state and supports an explicit refresh', async () => {
    vi.useFakeTimers()
    const getWorkbench = vi.fn(async () => workbench)
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(3) })
  })

  it('offers retry when S5 fails', async () => {
    const retryStage = vi.fn(async () => {})
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'failed', failureReason: 'writer failed' } }), retryStage })} />)
    expect(screen.getByText('章节写作失败：writer failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
  })

  it('keeps the review workbench mounted and exports Word repeatedly after S5 completes', async () => {
    const exportDocx = vi.fn()
      .mockResolvedValueOnce({ path: 'output/bid-1.docx' })
      .mockResolvedValueOnce({ path: 'output/bid-2.docx' })
    render(<BidReviewWorkbench {...props({
      useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' }, allowedActions: ['export_docx'] }),
      exportDocx,
    })} />)

    expect(await screen.findByText('章节正文')).toBeTruthy()
    const button = screen.getByRole('button', { name: '导出 Word' })
    fireEvent.click(button)
    await waitFor(() => { expect(exportDocx).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('Word 已导出：output/bid-1.docx')).toHaveProperty('title', 'output/bid-1.docx')
    fireEvent.click(button)
    await waitFor(() => { expect(exportDocx).toHaveBeenCalledTimes(2) })
    expect(screen.getByText('Word 已导出：output/bid-2.docx')).toHaveProperty('title', 'output/bid-2.docx')
  })

  it('keeps legacy completed S6 projects in the S5 review workbench', async () => {
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ runtime: { stage: 'docx_export', status: 'completed' } }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
  })

  it('does not render for a non-Bid Session', () => {
    const { container } = render(<BidReviewWorkbench {...props({ useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'standard' } } } as never) })} />)
    expect(container.innerHTML).toBe('')
  })
})
