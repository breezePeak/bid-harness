import { useMemo } from 'react'
import { shallowEqual, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  RunProgressCard, type RunProgressCardLabels, type RunProgressStatus,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface BidRunCardInjected {
  readonly openSession: (id: SessionId) => void
}

/** Props supplied by the keyed Bid Run renderer. */
type BidRunCardProps = PropsRuntime<'conversation.chat.node', 'bid-run'>
  & PropsLocale<'bid'>
  & BidRunCardInjected

const STATUS_KEYS = {
  running: 'run.status.running',
  completed: 'run.status.completed',
  failed: 'run.status.failed',
  cancelled: 'run.status.cancelled',
  interrupted: 'run.status.interrupted',
} as const satisfies Record<RunProgressStatus, string>

/** Render a Bid Run with the shared durable run card. */
export function BidRunCard({ node, sessionId, useSessions, openSession, t }: BidRunCardProps) {
  const labels = useMemo<RunProgressCardLabels>(() => ({
    runTitle: name => t('run.card.title', { name }),
    memberCount: count => t('run.card.members', { count }),
    emptyRun: t('run.card.empty'),
    status: status => t(STATUS_KEYS[status]),
    statusCount: (status, count) => t('run.card.status_count', {
      status: t(STATUS_KEYS[status]), count,
    }),
    openMember: name => t('run.card.open', { name }),
  }), [t])
  const navigable = useSessions((sessions) => {
    const ordinary = new Set(sessions.ids)
    const result: SessionId[] = []
    for (const phase of node.data.phases) {
      for (const member of phase.members) {
        if (member.sessionId === undefined) continue
        const childId = member.sessionId as SessionId
        const summary = sessions.byId[childId]
        if (ordinary.has(childId)
          && summary?.origin === 'subagent'
          && summary.parentId === sessionId) result.push(childId)
      }
    }
    return result
  }, shallowEqual)
  return (
    <RunProgressCard
      data={node.data}
      labels={labels}
      navigableSessionIds={navigable}
      onOpenSession={(id) => { openSession(id as SessionId) }}
    />
  )
}
