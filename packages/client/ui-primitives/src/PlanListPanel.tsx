import { useId, useState } from 'react'
import { IconChecklistOutline14, IconChevronDownOutline14, IconChevronUpOutline14 } from './icons/index.tsx'
import css from './PlanListPanel.module.css'

/** Visual states supported by the shared plan list. */
export type PlanListItemStatus = 'completed' | 'in_progress' | 'pending'

/** One product-owned row rendered by the shared plan list. */
export interface PlanListItem {
  readonly key: string
  readonly content: string
  readonly status: PlanListItemStatus
}

/** Product-owned copy for the shared plan list. */
export interface PlanListLabels {
  readonly title: string
  readonly completed: (count: number) => string
  readonly active: (count: number) => string
  readonly unfinished: (count: number) => string
  readonly pending: (count: number) => string
}

/** Props for the collapsible shared plan list. */
export interface PlanListPanelProps {
  readonly items: readonly PlanListItem[]
  readonly running: boolean
  readonly labels: PlanListLabels
  readonly testId?: string | undefined
}

/** Local exhaustiveness helper for the closed visual status union. */
/* v8 ignore next 3 -- only reached when a caller forges a status at runtime. */
function assertNever(value: never): never {
  throw new Error(`unreachable plan status: ${String(value)}`)
}

function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ProgressGlyph({ running }: { readonly running: boolean }) {
  const gradientId = useId()
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={running ? css.glyphProgress : css.glyphUnfinished}
    >
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

function StatusGlyph({ status, running }: { readonly status: PlanListItemStatus; readonly running: boolean }) {
  switch (status) {
    case 'completed': return <CompletedGlyph />
    case 'in_progress': return <ProgressGlyph running={running} />
    case 'pending': return <PendingGlyph />
    /* v8 ignore next -- PlanListItemStatus is closed. */
    default: return assertNever(status)
  }
}

function progressLabel(items: readonly PlanListItem[], running: boolean, labels: PlanListLabels): string {
  const completed = items.filter(item => item.status === 'completed').length
  const active = items.filter(item => item.status === 'in_progress').length
  const pending = items.length - completed - active
  return [
    ...completed > 0 ? [labels.completed(completed)] : [],
    ...active > 0 ? [(running ? labels.active : labels.unfinished)(active)] : [],
    ...pending > 0 ? [labels.pending(pending)] : [],
  ].join('\u2002·\u2002')
}

/** Render a collapsible plan list without owning the plan lifecycle. */
export function PlanListPanel({ items, running, labels, testId }: PlanListPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  if (items.length === 0) return null

  return (
    <section className={css.root} data-testid={testId} aria-label={labels.title}>
      <div className={css.body}>
        <button
          type="button"
          className={css.header}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
        >
          <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
          <span className={css.title}>{labels.title}</span>
          <span className={css.progress}>{progressLabel(items, running, labels)}</span>
          <span className={css.chevron} aria-hidden>
            {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </button>
        {!collapsed && (
          <ul className={css.list}>
            {items.map(item => (
              <li
                key={item.key}
                className={css.item}
                data-status={item.status}
                data-active={item.status === 'in_progress' ? running : undefined}
              >
                <span className={css.glyph} aria-hidden><StatusGlyph status={item.status} running={running} /></span>
                <span className={css.content}>{item.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
