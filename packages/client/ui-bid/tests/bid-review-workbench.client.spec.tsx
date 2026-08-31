// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidReviewWorkbench, type BidReviewWorkbenchProps } from '../src/client/BidReviewWorkbench.tsx'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const workbench = {
  schema_version: 1 as const,
  outline: [
    { section_id: 'ROOT', parent_id: null, order: 1, title: '技术方案', writable: false, has_content: false, review_status: 'not_evaluated' as const },
    { section_id: 'SEC-1', parent_id: 'ROOT', order: 1, title: '实施方案', writable: true, has_content: true, review_status: 'not_evaluated' as const },
  ],
  review: {
    review_mode: 'framework_only' as const,
    quality_gate: 'not_evaluated' as const,
    summary: { chapter_count: 1, evaluated_chapter_count: 0 as const, issue_count: 0, blocking_issue_count: 0 },
    limitations: ['DETAILED_REVIEW_NOT_IMPLEMENTED'],
    issues: [],
  },
}

function props(patch: Partial<BidReviewWorkbenchProps> = {}): BidReviewWorkbenchProps {
  return {
    sessionId: 'bid',
    useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'bid' } } } as never),
    useProjection: () => ({ runtime: { stage: 'book_review', status: 'waiting_user' } }),
    renderSlot: (name: string) => <div data-slot={name} />,
    getWorkbench: async () => workbench,
    getChapter: async (sectionId: string) => ({ section_id: sectionId, title: '实施方案', number: '1.1', heading_path: ['技术方案', '实施方案'], writable: true, markdown: '章节正文' }),
    completeReview: vi.fn(async () => {}),
    ...patch,
  } as unknown as BidReviewWorkbenchProps
}

describe('BidReviewWorkbench', () => {
  it('renders the three work areas, loads a writable chapter, and collapses an outline parent', async () => {
    render(<BidReviewWorkbench {...props()} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.getAllByText(/framework_only/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/not_evaluated/).length).toBeGreaterThan(0)
    expect(screen.getByText('尚未执行详细检查。当前问题列表为空不代表审核通过。')).toBeTruthy()
    expect(screen.getByText('实施方案')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '折叠目录' }))
    expect(screen.queryByRole('button', { name: /实施方案/ })).toBeNull()
  })

  it('shows a structural node without asking Host for a Markdown path', async () => {
    const getChapter = vi.fn(async (sectionId: string) => ({ section_id: sectionId, title: '技术方案', number: '1', heading_path: ['技术方案'], writable: false, markdown: null }))
    render(<BidReviewWorkbench {...props({ getChapter })} />)
    fireEvent.click(await screen.findByRole('button', { name: /技术方案/ }))
    expect(await screen.findByText('这是目录结构节点，没有独立正文。下级章节：实施方案。')).toBeTruthy()
    expect(getChapter).toHaveBeenCalledWith('ROOT')
  })

  it('loads the default writable chapter once until the user explicitly refreshes', async () => {
    const getChapter = vi.fn(async (sectionId: string) => ({ section_id: sectionId, title: '实施方案', number: '1.1', heading_path: ['技术方案', '实施方案'], writable: true, markdown: '章节正文' }))
    render(<BidReviewWorkbench {...props({ getChapter })} />)
    await screen.findByText('章节正文')
    expect(getChapter).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(getChapter).toHaveBeenCalledTimes(2) })
  })

  it('requires browser confirmation before completing the review', async () => {
    const completeReview = vi.fn(async () => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<BidReviewWorkbench {...props({ completeReview })} />)
    fireEvent.click(await screen.findByRole('button', { name: '完成本轮审核，进入导出' }))
    await waitFor(() => { expect(completeReview).toHaveBeenCalledOnce() })
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('registers the shared transcript and composer destinations while S7 is open', async () => {
    const setEmbeddedSurface = vi.fn()
    const { unmount } = render(<BidReviewWorkbench {...props({ setEmbeddedSurface })} />)
    await screen.findByText('章节正文')
    expect(setEmbeddedSurface).toHaveBeenCalledWith('chat', expect.any(HTMLDivElement))
    expect(setEmbeddedSurface).toHaveBeenCalledWith('composer', expect.any(HTMLDivElement))
    unmount()
    expect(setEmbeddedSurface).toHaveBeenCalledWith('chat', null)
    expect(setEmbeddedSurface).toHaveBeenCalledWith('composer', null)
  })

  it('does not render for a non-Bid Session', () => {
    const { container } = render(<BidReviewWorkbench {...props({
      useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'standard' } } } as never),
    })} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the S7 screen visible on Host failure and offers retry', async () => {
    const retryStage = vi.fn(async () => {})
    render(<BidReviewWorkbench {...props({
      useProjection: () => ({ runtime: { stage: 'book_review', status: 'failed', failureReason: 'report invalid' } }),
      retryStage,
    })} />)
    expect(screen.getByText('审核框架准备失败：report invalid')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
  })
})
