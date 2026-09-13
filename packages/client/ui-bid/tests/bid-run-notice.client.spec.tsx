// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BidRunNotice as BidRunNoticeData } from '@deepseek-ai/dsh-bid/control-plane'
import { describe, expect, it } from 'vitest'
import { BidRunNotice } from '../src/client/BidRunNotice.tsx'
import { bidRunNoticeDefinition } from '../src/client/bid-run-notice-definition.ts'

const data = {
  noticeId: 'run:one:suspended', supersedesTurn: null, runId: 'one', stage: 'evidence_mapping' as const,
  kind: 'interrupted' as const, severity: 'error' as const, message: '当前阶段已中断，已保存已完成进度。',
}

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

  it('renders severity without turning the notice into an assistant message', () => {
    const props = { node: { data } } as unknown as Parameters<typeof BidRunNotice>[0]
    render(<BidRunNotice {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(data.message)
  })
})
