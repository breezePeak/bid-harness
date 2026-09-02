// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidReviewWorkbench, type BidReviewWorkbenchProps } from '../src/client/BidReviewWorkbench.tsx'

afterEach(cleanup)

const workbench = {
  schema_version: 1 as const,
  outline: [
    { section_id: 'ROOT', parent_id: null, order: 1, title: '技术方案', writable: false, writing_status: 'not_started' as const, review_status: 'not_started' as const, content_available: false },
    { section_id: 'SEC-1', parent_id: 'ROOT', order: 1, title: '实施方案', writable: true, writing_status: 'content_ready' as const, review_status: 'reviewing' as const, content_available: true },
  ],
  summary: { chapter_count: 1, content_count: 1, reviewed_count: 0, needs_attention_count: 0 },
}

const chapter = {
  section_id: 'SEC-1', title: '实施方案', number: '1.1', heading_path: ['技术方案', '实施方案'], writable: true,
  markdown: '章节正文', requirement_ids: ['REQ-1'], scoring_response_point_ids: ['RP-000001'], evidence_status: 'available' as const,
  review: { status: 'reviewing' as const, issues: [] },
}

function props(patch: Partial<BidReviewWorkbenchProps> = {}): BidReviewWorkbenchProps {
  return {
    sessionId: 'bid',
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
  it('shows chapter content as soon as the writer publishes it', async () => {
    render(<BidReviewWorkbench {...props()} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.getByText('正文 1/1')).toBeTruthy()
    expect(screen.getByText('状态：reviewing')).toBeTruthy()
    expect(screen.getByText('Evidence：available')).toBeTruthy()
  })

  it('disables sections whose content is not available', async () => {
    render(<BidReviewWorkbench {...props()} />)
    const root = await screen.findByRole('button', { name: /技术方案/ })
    expect(root).toHaveProperty('disabled', true)
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

  it('does not render for a non-Bid Session', () => {
    const { container } = render(<BidReviewWorkbench {...props({ useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'standard' } } } as never) })} />)
    expect(container.innerHTML).toBe('')
  })
})
