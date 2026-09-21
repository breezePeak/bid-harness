import {
  useLayoutEffect, useMemo, useRef, useState,
  type FocusEvent, type MouseEvent, type ReactNode,
} from 'react'
import { DisclosureRow, type DisclosureRowProps } from './DisclosureRow.tsx'
import { IconChevronRightOutline14 } from './icons/index.tsx'
import { StateDot, type StateDotState } from './StateDot.tsx'
import css from './RunProgressCard.module.css'

/** Status shown for a durable run, phase, or member. */
export type RunProgressStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** One execution member shown inside a run phase. */
export interface RunProgressMemberData {
  readonly key: string | number
  readonly label: string
  readonly sessionId?: string
  readonly status: RunProgressStatus
}

/** One phase shown inside a durable run. */
export interface RunProgressPhaseData {
  readonly key: string
  readonly label: string
  readonly members: readonly RunProgressMemberData[]
}

/** Presentation data for one durable run. */
export interface RunProgressCardData {
  readonly name: string
  readonly status: RunProgressStatus
  readonly phases: readonly RunProgressPhaseData[]
}

/** Product-owned copy used by the shared run card. */
export interface RunProgressCardLabels {
  readonly runTitle: (name: string) => string
  readonly memberCount: (count: number) => string
  readonly emptyRun: string
  readonly status: (status: RunProgressStatus) => string
  readonly statusCount: (status: RunProgressStatus, count: number) => string
  readonly openMember: (name: string) => string
}

/** Props for the durable run progress card. */
export interface RunProgressCardProps {
  readonly data: RunProgressCardData
  readonly labels: RunProgressCardLabels
  readonly navigableSessionIds: readonly string[]
  readonly onOpenSession: (sessionId: string) => void
}

function dotState(status: RunProgressStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled':
    case 'interrupted': return 'warning'
    /* v8 ignore next -- RunProgressStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

type DisclosureMode = 'clean' | 'running' | 'abnormal'

interface DisclosureFacts {
  readonly mode: DisclosureMode
  readonly activityCount: number
}

interface DisclosureState extends DisclosureFacts {
  readonly open: boolean
  readonly pendingCleanCollapse: boolean
}

interface RunDisclosureState {
  readonly run: DisclosureState
  readonly phases: ReadonlyMap<string, DisclosureState>
}

type StatusDisclosureProps = Omit<DisclosureRowProps, 'expandable'>

function StatusDisclosure(props: StatusDisclosureProps) {
  return <DisclosureRow {...props} expandable />
}

function abnormal(status: RunProgressStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function phaseDisclosureFacts(phase: RunProgressPhaseData): DisclosureFacts {
  const mode = phase.members.some(member => abnormal(member.status))
    ? 'abnormal'
    : phase.members.some(member => member.status === 'running') ? 'running' : 'clean'
  return { mode, activityCount: phase.members.length }
}

function runDisclosureFacts(
  status: RunProgressStatus,
  phases: readonly (readonly [string, DisclosureFacts])[],
): DisclosureFacts {
  const mode = abnormal(status) || phases.some(([, facts]) => facts.mode === 'abnormal')
    ? 'abnormal'
    : status === 'running' || phases.some(([, facts]) => facts.mode === 'running')
      ? 'running'
      : 'clean'
  const activityCount = phases.reduce((count, [, facts]) => count + facts.activityCount, 0)
  return { mode, activityCount }
}

function initialDisclosureState(facts: DisclosureFacts): DisclosureState {
  return { ...facts, open: facts.mode !== 'clean', pendingCleanCollapse: false }
}

function advanceDisclosureState(
  current: DisclosureState,
  facts: DisclosureFacts,
  focusWithin: boolean,
): DisclosureState {
  const sameFacts = current.mode === facts.mode && current.activityCount === facts.activityCount
  if (sameFacts) {
    if (!current.pendingCleanCollapse || focusWithin) return current
    return { ...current, open: false, pendingCleanCollapse: false }
  }
  if (facts.mode === 'clean') {
    const deferCollapse = current.open && focusWithin
    return { ...facts, open: deferCollapse, pendingCleanCollapse: deferCollapse }
  }
  if (current.mode === 'clean' || (facts.mode === 'abnormal' && current.mode !== 'abnormal')) {
    return { ...facts, open: true, pendingCleanCollapse: false }
  }
  return { ...facts, open: current.open, pendingCleanCollapse: false }
}

function focusIsWithin(element: HTMLElement | null | undefined): boolean {
  if (element === null || element === undefined) return false
  return element.contains(element.ownerDocument.activeElement)
}

function collapsePending(state: DisclosureState): DisclosureState {
  if (!state.pendingCleanCollapse) return state
  return { ...state, open: false, pendingCleanCollapse: false }
}

function existingPhaseState(
  phases: ReadonlyMap<string, DisclosureState>,
  key: string,
): DisclosureState {
  const phase = phases.get(key)
  /* v8 ignore next -- mounted phase callbacks are created from this owner map. */
  if (phase === undefined) throw new Error(`Missing disclosure state for phase ${key}`)
  return phase
}

function preventPendingHeaderFocus(event: MouseEvent<HTMLElement>): void {
  const header = event.currentTarget.querySelector('[data-disclosure-row]')
  /* v8 ignore next -- DisclosureRow always renders its header before the content. */
  if (header === null) throw new Error('Missing disclosure header')
  if (header.contains(event.target as Node)) event.preventDefault()
}

function phaseStatusSummary(
  members: readonly RunProgressMemberData[],
  labels: RunProgressCardLabels,
): string {
  const counts = new Map<RunProgressStatus, number>()
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const count = (status: RunProgressStatus): number => counts.get(status) ?? 0
  const active = (['running', 'failed', 'cancelled', 'interrupted'] as const)
    .filter(status => count(status) > 0)
  if (active.length === 0) return labels.statusCount('completed', count('completed'))
  const visible = active.includes('interrupted') && count('completed') > 0
    ? ['completed' as const, ...active]
    : active
  return visible.map(status => labels.statusCount(status, count(status))).join(' · ')
}

function RunHeader({ children, count, labels, name, onToggle, open, status }: {
  readonly children: ReactNode
  readonly count: number
  readonly labels: RunProgressCardLabels
  readonly name: string
  readonly onToggle: () => void
  readonly open: boolean
  readonly status: RunProgressStatus
}) {
  return (
    <StatusDisclosure
      icon={<IconChevronRightOutline14 />}
      title={labels.runTitle(name)}
      open={open}
      onToggle={onToggle}
      expandOnRowClick
      previewChevron={false}
      keepContentWhenOpen
      rowClassName={css.runHeader}
      leadingClassName={css.runLeading}
      titleClassName={css.runTitle}
      collapsedContent={(
        <>
          <span className={css.separator} aria-hidden />
          <span className={css.runSummary}>{labels.memberCount(count)}</span>
          <span className={css.statusTail} data-status={status}>
            <StateDot state={dotState(status)} />
            <span>{labels.status(status)}</span>
          </span>
        </>
      )}
    >
      {children}
    </StatusDisclosure>
  )
}

function MemberRow({ labels, member, navigable, onOpenSession }: {
  readonly labels: RunProgressCardLabels
  readonly member: RunProgressMemberData
  readonly navigable: boolean
  readonly onOpenSession: RunProgressCardProps['onOpenSession']
}) {
  const [focused, setFocused] = useState(false)
  const renderButton = navigable || focused
  const content = (
    <>
      <span className={css.dotSlot}><StateDot state={dotState(member.status)} /></span>
      <span className={css.memberLabelWrap} data-member-label-wrap>
        <span className={css.memberLabel} data-member-label>{member.label}</span>
      </span>
      <span className={css.memberStatus} data-member-status-text>{labels.status(member.status)}</span>
    </>
  )
  if (!renderButton) {
    return <div className={css.memberRow} data-member-status={member.status}>{content}</div>
  }
  return (
    <button
      type="button"
      className={navigable ? css.memberButton : css.memberRow}
      data-member-status={member.status}
      aria-disabled={navigable ? undefined : true}
      aria-label={navigable ? labels.openMember(member.label) : member.label}
      tabIndex={navigable ? undefined : -1}
      onFocus={() => { setFocused(true) }}
      onBlur={() => { setFocused(false) }}
      onClick={navigable && member.sessionId !== undefined
        ? () => { onOpenSession(member.sessionId as string) }
        : undefined}
    >
      {content}
    </button>
  )
}

function PhaseSection({
  contentRef, labels, navigableSessionIds, onContentBlur, onOpenSession, onToggle,
  open, pendingCleanCollapse, phase,
}: {
  readonly contentRef: (element: HTMLDivElement | null) => void
  readonly labels: RunProgressCardLabels
  readonly navigableSessionIds: readonly string[]
  readonly onContentBlur: (event: FocusEvent<HTMLDivElement>) => void
  readonly onOpenSession: RunProgressCardProps['onOpenSession']
  readonly onToggle: () => void
  readonly open: boolean
  readonly pendingCleanCollapse: boolean
  readonly phase: RunProgressPhaseData
}) {
  return (
    <div
      className={css.phase}
      onMouseDownCapture={pendingCleanCollapse ? preventPendingHeaderFocus : undefined}
    >
      <StatusDisclosure
        icon={<IconChevronRightOutline14 />}
        title={phase.label}
        open={open}
        onToggle={onToggle}
        expandOnRowClick
        previewChevron={false}
        keepContentWhenOpen
        rowClassName={css.phaseHeader}
        leadingClassName={css.phaseLeading}
        titleClassName={css.phaseTitle}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.phaseCount} data-phase-count>{labels.memberCount(phase.members.length)}</span>
            <span className={css.phaseStatus} data-phase-status-text>
              {phaseStatusSummary(phase.members, labels)}
            </span>
          </>
        )}
      >
        <div ref={contentRef} className={css.members} onBlur={onContentBlur}>
          {phase.members.map(member => (
            <MemberRow
              key={member.key}
              member={member}
              navigable={member.sessionId !== undefined
                && navigableSessionIds.includes(member.sessionId)}
              onOpenSession={onOpenSession}
              labels={labels}
            />
          ))}
        </div>
      </StatusDisclosure>
    </div>
  )
}

/** Render a durable run with status-driven run and phase disclosure. */
export function RunProgressCard({ data, labels, navigableSessionIds, onOpenSession }: RunProgressCardProps) {
  const phaseFacts = useMemo(() => data.phases.map(phase => (
    [phase.key, phaseDisclosureFacts(phase)] as const
  )), [data.phases])
  const runFacts = useMemo(
    () => runDisclosureFacts(data.status, phaseFacts),
    [data.status, phaseFacts],
  )
  const [disclosures, setDisclosures] = useState<RunDisclosureState>(() => ({
    run: initialDisclosureState(runFacts),
    phases: new Map(phaseFacts.map(([key, facts]) => [key, initialDisclosureState(facts)])),
  }))
  const runContentRef = useRef<HTMLDivElement>(null)
  const phaseContentRefs = useRef(new Map<string, HTMLDivElement>())

  // Outer hiding unmounts Phase content without a dependable blur event, so this edge settles deferred closes.
  useLayoutEffect(() => {
    setDisclosures((current) => {
      const phases = new Map<string, DisclosureState>()
      let phasesChanged = current.phases.size !== phaseFacts.length
      let phaseStartedCycle = false
      for (const [key, facts] of phaseFacts) {
        const previous = current.phases.get(key)
        const next = previous === undefined
          ? initialDisclosureState(facts)
          : advanceDisclosureState(previous, facts, focusIsWithin(phaseContentRefs.current.get(key)))
        phases.set(key, next)
        if (next !== previous) phasesChanged = true
        if (previous?.mode === 'clean'
          && (facts.mode !== 'clean' || facts.activityCount !== previous.activityCount)) {
          phaseStartedCycle = true
        }
      }
      const advancedRun = advanceDisclosureState(
        current.run,
        runFacts,
        focusIsWithin(runContentRef.current),
      )
      const run = phaseStartedCycle && runFacts.mode !== 'clean' && !advancedRun.open
        ? { ...advancedRun, open: true, pendingCleanCollapse: false }
        : advancedRun
      return run !== current.run || phasesChanged ? { run, phases } : current
    })
  }, [disclosures.run.open, phaseFacts, runFacts])

  const toggleRun = (): void => {
    setDisclosures(current => ({
      ...current,
      run: { ...current.run, open: !current.run.open, pendingCleanCollapse: false },
    }))
  }
  const togglePhase = (key: string): void => {
    setDisclosures((current) => {
      const phases = new Map(current.phases)
      const phase = existingPhaseState(phases, key)
      phases.set(key, { ...phase, open: !phase.open, pendingCleanCollapse: false })
      return { ...current, phases }
    })
  }
  const settleRunBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setDisclosures((current) => {
      const run = collapsePending(current.run)
      return run === current.run ? current : { ...current, run }
    })
  }
  const settlePhaseBlur = (key: string, event: FocusEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setDisclosures((current) => {
      const phase = existingPhaseState(current.phases, key)
      const next = collapsePending(phase)
      if (next === phase) return current
      const phases = new Map(current.phases)
      phases.set(key, next)
      return { ...current, phases }
    })
  }

  return (
    <section
      className={css.root}
      data-run-progress-card
      data-run-status={data.status}
      onMouseDownCapture={disclosures.run.pendingCleanCollapse
        ? preventPendingHeaderFocus
        : undefined}
    >
      <RunHeader
        count={runFacts.activityCount}
        labels={labels}
        name={data.name}
        open={disclosures.run.open}
        onToggle={toggleRun}
        status={data.status}
      >
        <div ref={runContentRef} className={css.phaseList} onBlur={settleRunBlur}>
          {data.phases.length === 0
            ? <span className={css.empty}>{labels.emptyRun}</span>
            : data.phases.map((phase) => {
              const facts = phaseDisclosureFacts(phase)
              const disclosure = disclosures.phases.get(phase.key) ?? initialDisclosureState(facts)
              return (
                <PhaseSection
                  key={phase.key}
                  contentRef={(element) => {
                    if (element === null) phaseContentRefs.current.delete(phase.key)
                    else phaseContentRefs.current.set(phase.key, element)
                  }}
                  labels={labels}
                  navigableSessionIds={navigableSessionIds}
                  onContentBlur={(event) => { settlePhaseBlur(phase.key, event) }}
                  onOpenSession={onOpenSession}
                  onToggle={() => { togglePhase(phase.key) }}
                  open={disclosure.open}
                  pendingCleanCollapse={disclosure.pendingCleanCollapse}
                  phase={phase}
                />
              )
            })}
        </div>
      </RunHeader>
    </section>
  )
}
