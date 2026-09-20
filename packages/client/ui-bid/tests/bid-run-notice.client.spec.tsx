// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BidRunNotice as BidRunNoticeData } from '@deepseek-ai/dsh-bid/control-plane'
import { afterEach, describe, expect, it } from 'vitest'
import { BidRunNotice } from '../src/client/BidRunNotice.tsx'
import { bidRunNoticeDefinition } from '../src/client/bid-run-notice-definition.ts'

const data = {
  noticeId: 'run:one:suspended', supersedesTurn: null, runId: 'one', stage: 'evidence_mapping' as const,
  kind: 'interrupted' as const, severity: 'error' as const, message: '当前阶段已中断，已保存已完成进度。',
}

afterEach(cleanup)

function event(): SessionEvent {
  return { type: 'bid.run.notice', seq: 12, time: 1, data } as unknown as SessionEvent
}

function match(): ConversationMatch {
  return { event: event(), view: undefined, role: 'start', location: { kind: 'session' } }
}

describe('Bid Run conversation notice', () => {
  it('projects one durable notice by its stable identity', () => {
    const accepted = bidRunNoticeDefinition.match(event())
    expect(accepted).toEqual({ id: data.noticeId, role: 'start' })
    const state = bidRunNoticeDefinition.start({} as ConversationNodeContext<BidRunNoticeData>, match(), {} as never)
    const node = bidRunNoticeDefinition.buildViewNode!({
      key: 'bid-run-notice', kind: 'bid-run-notice', id: data.noticeId,
      matches: [match()], start: match(), state, current: new Map(),
    })
    expect(node).toMatchObject({ id: data.noticeId, anchorSeq: 12, data })
  })

  it('collapses an error notice to its important summary and expands the full diagnostic', () => {
    const message = 'BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。；CHAPTER_REVIEW_TEXT_INVALID: 覆盖记录文本必须匹配当前章节 canonical 条目。'
    const props = { node: { data: { ...data, message } } } as unknown as Parameters<typeof BidRunNotice>[0]
    render(<BidRunNotice {...props} />)
    const row = screen.getByRole('button', { name: /阶段运行失败/u })
    expect(row.textContent).toContain('BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。')
    expect(screen.queryByText(message)).toBeNull()

    fireEvent.click(row)
    expect(screen.getByText(message)).toBeTruthy()
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a stopped notice neutral and non-expandable', () => {
    const props = { node: { data: { ...data, severity: 'info', kind: 'stopped' } } } as unknown as Parameters<typeof BidRunNotice>[0]
    render(<BidRunNotice {...props} />)
    expect(screen.getByRole('status').textContent).toBe(data.message)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
