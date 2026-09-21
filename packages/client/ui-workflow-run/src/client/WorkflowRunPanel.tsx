import { useMemo } from 'react'
import { shallowEqual, type SessionId, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  RunProgressCard,
  type RunProgressCardData, type RunProgressCardLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowRunKey } from './locales.ts'
import type {
  WorkflowRunChatData, WorkflowRunPhaseData, WorkflowRunStatus,
} from './workflow-definition.ts'

/** Navigation action injected from the plugin's own SessionRuntime access. */
export interface WorkflowRunInjected {
  readonly openSession: (id: SessionId) => void
}

/** Complete keyed Chat renderer props. */
export type WorkflowRunPanelProps =
  PropsRuntime<'conversation.chat.node', 'workflow-run'>
  & PropsLocale<'workflowRun'>
  & WorkflowRunInjected

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  interrupted: 'status.interrupted',
} as const satisfies Record<WorkflowRunStatus, WorkflowRunKey>

function readablePhase(phase: string | null, t: WorkflowRunPanelProps['t']): string {
  if (phase === null) return t('phase.unassigned')
  return phase === '' ? t('phase.empty') : phase
}

function readableMember(label: string, t: WorkflowRunPanelProps['t']): string {
  return label === '' ? t('member.empty') : label
}

function projectData(data: WorkflowRunChatData, t: WorkflowRunPanelProps['t']): RunProgressCardData {
  return {
    name: data.name,
    status: data.status,
    phases: data.phases.map(phase => ({
      key: phase.key,
      label: readablePhase(phase.phase, t),
      members: phase.members.map(member => ({
        key: member.seq,
        label: readableMember(member.label, t),
        sessionId: member.childId,
        status: member.status,
      })),
    })),
  }
}

function navigableMembers(
  sessions: SessionListState,
  phases: readonly WorkflowRunPhaseData[],
  parentId: SessionId,
): readonly SessionId[] {
  const ordinary = new Set(sessions.ids)
  const result: SessionId[] = []
  for (const phase of phases) {
    for (const member of phase.members) {
      const summary = sessions.byId[member.childId]
      if (member.status === 'running'
        && ordinary.has(member.childId)
        && summary?.origin === 'subagent'
        && summary.parentId === parentId
        && summary.running) {
        result.push(member.childId)
      }
    }
  }
  return result
}

/** Render the workflow-run node through the shared durable run card. */
export function WorkflowRunPanel({ node, sessionId, useSessions, openSession, t }: WorkflowRunPanelProps) {
  const data = useMemo(() => projectData(node.data, t), [node.data, t])
  const labels = useMemo<RunProgressCardLabels>(() => ({
    runTitle: name => t('run.title', { name }),
    memberCount: count => t(count === 1 ? 'run.members.one' : 'run.members.other', { count }),
    emptyRun: t('run.empty'),
    status: status => t(STATUS_KEYS[status]),
    statusCount: (status, count) => t(`statusCount.${status}`, { count }),
    openMember: name => t('member.open', { name }),
  }), [t])
  const navigable = useSessions(
    sessions => navigableMembers(sessions, node.data.phases, sessionId),
    shallowEqual,
  )
  return (
    <RunProgressCard
      data={data}
      labels={labels}
      navigableSessionIds={navigable}
      onOpenSession={(id) => { openSession(id as SessionId) }}
    />
  )
}
