// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BidRunCard } from '../src/client/BidRunCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const PARENT_ID = 'main' as SessionId
const CHILD_ID = 'execution' as SessionId

const sessions: SessionListState = {
  ids: [PARENT_ID, CHILD_ID],
  byId: {
    [PARENT_ID]: {
      id: PARENT_ID, displayTitle: 'main', running: true, blank: false, updatedAt: 0,
    },
    [CHILD_ID]: {
      id: CHILD_ID, displayTitle: 'execution', parentId: PARENT_ID, origin: 'subagent',
      running: false, blank: false, updatedAt: 0,
    },
  },
  current: PARENT_ID,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

describe('BidRunCard', () => {
  it('opens the real execution child from a durable terminal Run card', () => {
    const openSession = vi.fn()
    const props = {
      node: {
        key: 'bid-run:run-1', kind: 'bid-run', id: 'run-1', target: 'chat',
        anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible',
        data: {
          name: 'S4 · 资料映射与目录深化',
          status: 'completed',
          phases: [{
            key: 'evidence_mapping', label: '映射完成 · 5/5',
            members: [{
              key: 1, label: 'S4 · 资料映射与目录深化',
              sessionId: CHILD_ID, status: 'completed',
            }],
          }],
        },
      },
      sessionId: PARENT_ID,
      useSessions: (selector: (value: SessionListState) => unknown) => selector(sessions),
      openSession,
      t: makeTranslate(zh),
    } as unknown as ComponentProps<typeof BidRunCard>
    render(<BidRunCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /后台任务：S4/ }))
    fireEvent.click(screen.getByRole('button', { name: /映射完成/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开 S4 · 资料映射与目录深化' }))
    expect(openSession).toHaveBeenCalledWith(CHILD_ID)
  })
})
