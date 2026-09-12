import {
  useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  indexSubagentDescendants, type SessionId, type SessionListState, type SessionProjectionMap,
  type SessionSummary, type SubagentAddress, type SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconRefreshOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import css from './SubagentHeaderLineage.module.css'

type CatalogEntry = SubagentCatalogSnapshot['entries'][number]
type Catalogs = SessionListState['subagentsByParent']
type ChildCatalogEntry = Extract<CatalogEntry, { kind: 'child' }>

/** Business actions supplied by the slot registration. */
export interface SubagentCatalogInjected {
  openChild: (address: SubagentAddress) => void
  refresh: (parentSessionId: SessionId) => void
  setCatalogOpen: (parentSessionId: SessionId, open: boolean) => void
}

/** Full props for the session-header lineage renderer. */
export type SubagentHeaderLineageProps =
  PropsRuntime<'conversation.session.header.lineage'> & SubagentCatalogInjected & PropsLocale<typeof NS>

interface CatalogTreeNode {
  entry: ChildCatalogEntry
  parentSessionId: SessionId
  /** Ancestor labels retained when a row crosses a status-section boundary. */
  path: readonly string[]
  children: CatalogTreeNode[]
}

interface CatalogRowProps {
  node: CatalogTreeNode
  reserveDisclosure: boolean
  currentSessionId: SessionId | undefined
  catalogs: Catalogs
  summaries: Readonly<Record<SessionId, SessionSummary>>
  expanded: ReadonlySet<SessionId>
  level: number
  now: number
  openChild: (address: SubagentAddress) => void
  refresh: (parentSessionId: SessionId) => void
  toggleBranch: (childSessionId: SessionId) => void
  closeCatalog: () => void
}

/** Build one status-specific forest from the loaded catalog graph. */
function catalogSectionNodes(
  rootSessionId: SessionId,
  catalogs: Catalogs,
  activity: ChildCatalogEntry['activity'],
): readonly CatalogTreeNode[] {
  const roots: CatalogTreeNode[] = []
  const seen = new Set<SessionId>()
  const visit = (
    parentSessionId: SessionId,
    path: readonly string[],
    parent: CatalogTreeNode | undefined,
    visiting: ReadonlySet<SessionId>,
  ): void => {
    if (visiting.has(parentSessionId)) return
    const catalog = catalogs[parentSessionId]
    if (catalog === undefined) return
    const nextVisiting = new Set(visiting).add(parentSessionId)
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child' || seen.has(entry.id)) continue
      seen.add(entry.id)
      const nextPath = [...path, entry.label ?? entry.id]
      if (entry.activity !== activity) {
        visit(entry.id, nextPath, undefined, nextVisiting)
        continue
      }
      const node: CatalogTreeNode = {
        entry,
        parentSessionId,
        path,
        children: [],
      }
      if (parent === undefined) roots.push(node)
      else parent.children.push(node)
      visit(entry.id, nextPath, node, nextVisiting)
    }
  }
  visit(rootSessionId, [], undefined, new Set())
  return roots
}

function catalogNodeCount(nodes: readonly CatalogTreeNode[]): number {
  return nodes.reduce((count, node) => count + 1 + catalogNodeCount(node.children), 0)
}

function diagnosticReason(
  entry: Extract<CatalogEntry, { kind: 'diagnostic' }>,
  t: TranslateNS<typeof NS>,
): string {
  switch (entry.reason) {
    case 'corrupt': return t('diagnostic.corrupt')
    case 'unsupported': return t('diagnostic.unsupported')
    case 'unavailable': return t('diagnostic.unavailable')
  }
}

function treeItems(root: HTMLDivElement | null): HTMLElement[] {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'))
}

/** Compact token count shared in shape with the conversation stats strip. */
function formatTokens(value: number): string {
  const scaled = (next: number): string => next >= 100
    ? String(Math.round(next))
    : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** Sum the four disjoint durable provider-usage buckets. */
function tokenTotal(
  usage: SessionProjectionMap['tokenUsage'] | undefined,
): number | undefined {
  return usage === undefined
    ? undefined
    : usage.uncachedInputTokens + usage.outputTokens
      + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Exact whole-second active-turn duration for one catalog row. */
function activityDuration(
  summary: SessionSummary | undefined,
  activity: 'running' | 'inactive',
  now: number,
): number | undefined {
  if (summary === undefined) return undefined
  const timing: SessionProjectionMap['subagentTiming'] | undefined
    = summary.projectionValues?.subagentTiming
  if (timing === undefined) return undefined
  if (timing.active === undefined) return timing.settledMs
  const end = activity === 'running'
    ? now
    : timing.active.through
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

interface DurationParts {
  seconds: number
  minutes: number
  hours: number
  days: number
  totalMinutes: number
  totalHours: number
}

function splitDuration(ms: number): DurationParts {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  return {
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days: Math.floor(totalHours / 24),
    totalMinutes,
    totalHours,
  }
}

/** Format a duration with decreasing visual precision at larger scales. */
function formatDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms)
  if (days >= 365) {
    const years = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return months === 0
      ? t('duration.years', { years })
      : t('duration.yearsMonths', { years, months })
  }
  if (days >= 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays === 0
      ? t('duration.months', { months })
      : t('duration.monthsDays', { months, days: remainingDays })
  }
  if (days > 0) {
    return hours === 0
      ? t('duration.days', { days })
      : t('duration.daysHours', { days, hours })
  }
  if (totalHours > 0) {
    return t('duration.hours', {
      hours: totalHours,
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    })
  }
  if (totalMinutes > 0) {
    return t('duration.minutes', {
      minutes: totalMinutes,
      seconds: String(seconds).padStart(2, '0'),
    })
  }
  return t('duration.seconds', { seconds })
}

/** Preserve exact whole seconds for hover and accessible naming. */
function formatExactDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const { seconds, minutes, hours, days } = splitDuration(ms)
  return days === 0
    ? formatDuration(ms, t)
    : t('duration.exactDays', {
      days,
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    })
}

const NO_DESCENDANTS = { count: 0, runningCount: 0 } as const

function SubagentSwitcherIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/** Render the known direct-child shape while its authoritative catalog hydrates. */
function CatalogLoadingRows({
  parentSessionId,
  summaries,
  level,
  t,
}: {
  parentSessionId: SessionId
  summaries: Readonly<Record<SessionId, SessionSummary>>
  level: number
  t: TranslateNS<typeof NS>
}) {
  const children = Object.values(summaries).filter(summary => (
    summary.origin === 'subagent' && summary.parentId === parentSessionId
  ))
  if (children.length === 0) return <div className={css.notice}>{t('loading.label')}</div>
  return children.map(summary => (
    <div key={summary.id} className={css.node}>
      <div
        role="treeitem"
        aria-disabled="true"
        aria-level={level}
        aria-label={t('loading.aria')}
        className={`${css.row} ${css.disabled} ${css.loadingRow}`}
      >
        <span className={css.disclosureSpace} />
        <span className={css.loadingState} />
        <span className={css.content}>
          <span className={css.label}>{t('loading.label')}</span>
        </span>
      </div>
    </div>
  ))
}

/** Render loading, failure, and diagnostic entries outside the two task groups. */
function CatalogFeedback({
  parentSessionId, catalog, summaries, level, refresh, t,
}: {
  parentSessionId: SessionId
  catalog: SubagentCatalogSnapshot
  summaries: Readonly<Record<SessionId, SessionSummary>>
  level: number
  refresh: (parentSessionId: SessionId) => void
  t: TranslateNS<typeof NS>
}) {
  const emptyLoading = catalog.state === 'loading' && catalog.entries.length === 0
  return (
    <>
      {emptyLoading && (
        <CatalogLoadingRows
          parentSessionId={parentSessionId}
          summaries={summaries}
          level={level}
          t={t}
        />
      )}
      {catalog.state === 'error' && (
        <div className={css.error}>
          <span>{catalog.error?.message ?? t('load.error')}</span>
          <button type="button" className={css.refresh} onClick={() => { refresh(parentSessionId) }}>
            <IconRefreshOutline14 />
            {t('retry')}
          </button>
        </div>
      )}
      {catalog.entries.map((entry) => {
        if (entry.kind !== 'diagnostic') return null
        const reason = diagnosticReason(entry, t)
        return (
          <div key={entry.id} className={css.node}>
            <div
              role="treeitem"
              aria-disabled="true"
              aria-level={level}
              aria-label={`${entry.id} ${reason}`}
              className={`${css.row} ${css.disabled}`}
              title={reason}
            >
              <StateDot state="error" />
              <span className={css.content}>
                <span className={css.label}>{entry.id}</span>
                <span className={css.summary}>{reason}</span>
              </span>
            </div>
          </div>
        )
      })}
    </>
  )
}

function resolveRowPresentation(
  rawLabel: string,
  summaryTitle: string | undefined,
  path: readonly string[],
  mode: string,
): { displayLabel: string; secondary: string } {
  const fullMatch = rawLabel.match(/^S5\s*·\s*\d+\s*·\s*([\d.]+\s*-\s*编写(?: · 修复 \d+| · 运行重试 \d+)*)\s*·\s*(.+)$/)
  if (fullMatch && fullMatch[1] !== undefined && fullMatch[2] !== undefined) {
    return {
      displayLabel: fullMatch[1],
      secondary: fullMatch[2].trim(),
    }
  }

  const oldMatch = rawLabel.match(/^S5\s*·\s*(\d+(?:\.\d+)*)\s*(?:·\s*(修复\s*\d+|运行重试\s*\d+))*\s*·\s*(.+)$/)
  if (oldMatch && oldMatch[1] !== undefined && oldMatch[3] !== undefined) {
    const chapterNo = oldMatch[1].includes('.') ? oldMatch[1] : (oldMatch[1].replace(/^0+/, '') || '0')
    const retryOrRepair = oldMatch[2] ? ` · ${oldMatch[2]}` : ''
    const chapterTitle = oldMatch[3].trim()
    return {
      displayLabel: `${chapterNo} - 编写${retryOrRepair}`,
      secondary: chapterTitle,
    }
  }

  if (/^[\d.]+\s*-\s*(?:编写|审查)/.test(rawLabel)) {
    const isPromptFallback = summaryTitle !== undefined && /^(?:你是|prompt|You are)/i.test(summaryTitle)
    const chapterTitle = !isPromptFallback && summaryTitle ? summaryTitle : ''
    return {
      displayLabel: rawLabel,
      secondary: chapterTitle,
    }
  }

  const secondary = [...path, summaryTitle, mode]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' · ')
  return {
    displayLabel: rawLabel,
    secondary,
  }
}

/** One status-grouped catalog row, reused by both sections. */
function CatalogRow({
  node, reserveDisclosure, currentSessionId, catalogs, summaries, expanded, level, now,
  openChild, refresh, toggleBranch, closeCatalog, t,
}: CatalogRowProps & { t: TranslateNS<typeof NS> }) {
  const { entry, parentSessionId, path, children } = node
  const childCatalog = catalogs[entry.id]
  const isCurrent = entry.id === currentSessionId
  const isExpanded = expanded.has(entry.id)
  const knownLeaf = !entry.hasChildren
  const childLoading = childCatalog === undefined
    || (childCatalog.state === 'loading' && childCatalog.entries.length === 0)
  const summary = summaries[entry.id]
  const rawLabel = entry.label ?? entry.id
  const mode = entry.mode === 'one-shot' ? t('mode.oneShot') : t('mode.continuable')
  const { displayLabel, secondary } = resolveRowPresentation(rawLabel, summary?.title, path, mode)
  const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage)
  const durationMs = activityDuration(summary, entry.activity, now)
  const tokenMetric = totalTokens === undefined ? undefined : `${formatTokens(totalTokens)} tok`
  const durationMetric = durationMs === undefined
    ? undefined
    : { compact: formatDuration(durationMs, t), exact: formatExactDuration(durationMs, t) }
  const metrics = [tokenMetric, durationMetric?.exact].filter(value => value !== undefined).join(' · ')
  const open = (): void => {
    openChild({ parentSessionId, childSessionId: entry.id, mode: entry.mode })
    closeCatalog()
  }
  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      open()
    } else if (
      (event.key === 'ArrowRight' && !knownLeaf && !isExpanded)
      || (event.key === 'ArrowLeft' && isExpanded)
    ) {
      event.preventDefault()
      event.stopPropagation()
      toggleBranch(entry.id)
    }
  }
  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    toggleBranch(entry.id)
  }
  return (
    <div className={css.node}>
      <div
        role="treeitem"
        tabIndex={0}
        aria-level={level}
        aria-current={isCurrent || undefined}
        aria-label={[displayLabel, secondary, metrics].filter(value => value !== '').join(' ')}
        {...knownLeaf ? {} : { 'aria-expanded': isExpanded }}
        className={css.row}
        onClick={open}
        onKeyDown={handleKey}
      >
        {knownLeaf
          ? reserveDisclosure && <span className={css.disclosureSpace} />
          : (
            <button
              type="button"
              tabIndex={-1}
              className={`${css.disclosure} ${isExpanded ? css.disclosureOpen : ''}`}
              aria-label={t(isExpanded ? 'branch.collapse' : 'branch.expand', { label: displayLabel })}
              onClick={toggle}
            >
              <IconChevronRightOutline14 />
            </button>
          )}
        <div className={css.clickarea}>
          <StateDot state={entry.activity === 'running' ? 'ongoing' : 'done'} />
          <span className={css.content}>
            <span className={`${css.label} ${isCurrent ? css.currentLabel : ''}`}>{displayLabel}</span>
            {secondary !== '' && <span className={css.summary}>{secondary}</span>}
          </span>
          {metrics !== '' && (
            <span className={css.metrics}>
              {tokenMetric !== undefined && <span className={css.metricToken}>{tokenMetric}</span>}
              {durationMetric !== undefined && (
                <span className={css.metricDuration} title={t('duration.exactTitle', { duration: durationMetric.exact })}>
                  {durationMetric.compact}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {isExpanded && !knownLeaf && (
        <div role="group" className={css.children} aria-busy={childLoading || undefined}>
          {children.map(child => (
            <CatalogRow
              key={child.entry.id}
              node={child}
              reserveDisclosure={children.some(next => next.entry.hasChildren)}
              currentSessionId={currentSessionId}
              catalogs={catalogs}
              summaries={summaries}
              expanded={expanded}
              level={level + 1}
              now={now}
              openChild={openChild}
              refresh={refresh}
              toggleBranch={toggleBranch}
              closeCatalog={closeCatalog}
              t={t}
            />
          ))}
          {childCatalog !== undefined && (
            <CatalogFeedback
              parentSessionId={entry.id}
              catalog={childCatalog}
              summaries={summaries}
              level={level + 1}
              refresh={refresh}
              t={t}
            />
          )}
          {childCatalog === undefined && (
            <CatalogLoadingRows parentSessionId={entry.id} summaries={summaries} level={level + 1} t={t} />
          )}
        </div>
      )}
    </div>
  )
}

/** Render one status section without duplicating catalog rows. */
function CatalogSectionRows({
  nodes, currentSessionId, catalogs, summaries, expanded, now,
  openChild, refresh, toggleBranch, closeCatalog, t,
}: Omit<CatalogRowProps, 'node' | 'level' | 'reserveDisclosure'> & { nodes: readonly CatalogTreeNode[]; t: TranslateNS<typeof NS> }) {
  const reserveDisclosure = nodes.some(node => node.entry.hasChildren)
  return nodes.map(node => (
    <CatalogRow
      key={node.entry.id}
      node={node}
      reserveDisclosure={reserveDisclosure}
      currentSessionId={currentSessionId}
      catalogs={catalogs}
      summaries={summaries}
      expanded={expanded}
      level={1}
      now={now}
      openChild={openChild}
      refresh={refresh}
      toggleBranch={toggleBranch}
      closeCatalog={closeCatalog}
      t={t}
    />
  ))
}

interface CatalogDropdownSharedProps extends SubagentCatalogInjected {
  /** Session whose direct catalog roots the tree. */
  rootSessionId: SessionId
  /** Whether an ordinary title needs a breadcrumb separator before its count. */
  separator?: boolean
  useSessions: SubagentHeaderLineageProps['useSessions']
  t: TranslateNS<typeof NS>
}

type CatalogDropdownProps = CatalogDropdownSharedProps & (
  | {
    /** Descendant-count control. */
    variant: 'count'
    currentSessionId?: never
    displayTitle?: never
    openTitle?: never
  }
  | {
    /** Current-title sibling switcher. */
    variant: 'switcher'
    /** Selected descendant highlighted in the catalog. */
    currentSessionId: SessionId
    /** Visible title included in the switcher's hover target. */
    displayTitle: string
    /** Optional ancestor navigation when the combined title is clicked. */
    openTitle?: () => void
  }
)

const MENU_VIEWPORT_MARGIN = 16

/** Place a portaled catalog below its trigger without crossing the viewport edge. */
function catalogMenuPosition(trigger: HTMLButtonElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(336, window.innerWidth - MENU_VIEWPORT_MARGIN * 2)
  return {
    top: rect.bottom + 5,
    left: Math.min(
      Math.max(MENU_VIEWPORT_MARGIN, rect.left),
      window.innerWidth - width - MENU_VIEWPORT_MARGIN,
    ),
  }
}

/** One trigger-plus-tree dropdown over the catalog rooted at `rootSessionId`. */
function CatalogDropdown({
  rootSessionId, currentSessionId, displayTitle, openTitle, variant, separator = false,
  useSessions, openChild, refresh, setCatalogOpen, t,
}: CatalogDropdownProps) {
  const ancestorSwitcher = variant === 'switcher' && openTitle !== undefined
  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)
  const catalog = catalogs[rootSessionId]
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<CSSProperties>()
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<ReadonlySet<SessionId>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const observedCatalogs = useRef(new Set<SessionId>())
  const requestedInitialCatalog = useRef<SessionId>()
  const setCatalogOpenRef = useRef(setCatalogOpen)
  setCatalogOpenRef.current = setCatalogOpen
  const currentEntry = currentSessionId === undefined
    ? undefined
    : catalog?.entries.find(entry => entry.kind === 'child' && entry.id === currentSessionId)
  const switcherDisplayTitle = currentEntry?.kind === 'child'
    ? currentEntry.label ?? currentEntry.id
    : displayTitle
  const healthy = catalog?.entries.filter(entry => entry.kind === 'child') ?? []
  const descendants = useMemo(
    () => indexSubagentDescendants(summaries).get(rootSessionId) ?? NO_DESCENDANTS,
    [rootSessionId, summaries],
  )
  // The catalog can arrive before the session-list baseline; never undercount
  // the already-visible direct rows during that short bootstrap window.
  const descendantCount = Math.max(healthy.length, descendants.count)
  const totalCountKey = descendantCount === 1 ? 'count.total.one' : 'count.total.other'
  const runningCountKey = descendants.runningCount === 1 ? 'count.running.one' : 'count.running.other'
  // Session summaries can announce membership before the descriptor-backed catalog catches up.
  // Keep that entry point visible through disabled loading rows; only catalog rows are navigable.
  const summaryBackedLoading = (descendants.count > 0 || variant === 'switcher')
    && (catalog === undefined || (catalog.state === 'ready' && catalog.entries.length === 0))
  const presentedCatalog: SubagentCatalogSnapshot | undefined = summaryBackedLoading
    ? {
      entries: [],
      parentAvailable: catalog?.parentAvailable ?? false,
      state: 'loading',
      error: null,
    }
    : catalog
  const runningNodes = useMemo(
    () => catalogSectionNodes(rootSessionId, catalogs, 'running'),
    [catalogs, rootSessionId],
  )
  const historyNodes = useMemo(
    () => catalogSectionNodes(rootSessionId, catalogs, 'inactive'),
    [catalogs, rootSessionId],
  )
  const runningCount = catalogNodeCount(runningNodes)
  const historyCount = catalogNodeCount(historyNodes)

  useEffect(() => {
    if (
      variant !== 'switcher'
      || catalog !== undefined
      || requestedInitialCatalog.current === rootSessionId
    ) return
    requestedInitialCatalog.current = rootSessionId
    refresh(rootSessionId)
  }, [catalog, refresh, rootSessionId, variant])

  const observeCatalog = (parentSessionId: SessionId, next: boolean): void => {
    if (next) observedCatalogs.current.add(parentSessionId)
    else observedCatalogs.current.delete(parentSessionId)
    setCatalogOpen(parentSessionId, next)
  }

  const closeAllCatalogs = (): void => {
    for (const parentSessionId of observedCatalogs.current) {
      setCatalogOpen(parentSessionId, false)
    }
    observedCatalogs.current.clear()
    setExpanded(new Set())
  }

  const cancelHoverClose = (): void => {
    if (hoverCloseTimer.current === undefined) return
    clearTimeout(hoverCloseTimer.current)
    hoverCloseTimer.current = undefined
  }

  const cancelHoverOpen = (): void => {
    if (hoverOpenTimer.current === undefined) return
    clearTimeout(hoverOpenTimer.current)
    hoverOpenTimer.current = undefined
  }

  const changeOpen = (next: boolean, restoreFocus = false): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (next) {
      const trigger = triggerRef.current
      /* v8 ignore next -- a queued callback can outlive the trigger */
      if (trigger === null) return
      setOpen(true)
      setMenuPosition(catalogMenuPosition(trigger))
      setNow(Date.now())
      observeCatalog(rootSessionId, true)
    }
    else {
      setOpen(false)
      setMenuPosition(undefined)
      closeAllCatalogs()
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (open) return
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  const closeBranch = (root: SessionId): void => {
    const closing = new Set<SessionId>()
    const visit = (parentSessionId: SessionId): void => {
      if (closing.has(parentSessionId) || !expanded.has(parentSessionId)) return
      closing.add(parentSessionId)
      const branch = catalogs[parentSessionId]
      for (const entry of branch?.entries ?? []) {
        if (entry.kind === 'child') visit(entry.id)
      }
    }
    visit(root)
    for (const parentSessionId of closing) observeCatalog(parentSessionId, false)
    setExpanded(current => new Set([...current].filter(id => !closing.has(id))))
  }

  const toggleBranch = (childSessionId: SessionId): void => {
    if (expanded.has(childSessionId)) {
      closeBranch(childSessionId)
      return
    }
    setExpanded(current => new Set(current).add(childSessionId))
    observeCatalog(childSessionId, true)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) {
        changeOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const placeMenu = (): void => {
      const trigger = triggerRef.current
      /* v8 ignore next -- native resize or scroll can outlive the trigger */
      if (trigger === null) return
      setMenuPosition(catalogMenuPosition(trigger))
    }
    window.addEventListener('resize', placeMenu)
    document.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      document.removeEventListener('scroll', placeMenu, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || runningCount === 0) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [open, runningCount])

  useEffect(() => () => {
    cancelHoverOpen()
    cancelHoverClose()
    for (const parentSessionId of observedCatalogs.current) {
      setCatalogOpenRef.current(parentSessionId, false)
    }
    observedCatalogs.current.clear()
  }, [])

  // Visibility needs evidence of children (entries, summary-known descendants,
  // or a failed load worth retrying). A bare loading catalog is not evidence:
  // selecting any session schedules a refresh whose loading snapshot would
  // otherwise flash the action in and out on childless sessions.
  const visible = presentedCatalog !== undefined
    && (variant === 'switcher'
      || presentedCatalog.state === 'error'
      || presentedCatalog.entries.length > 0
      || descendantCount > 0)
  useEffect(() => {
    if (visible) return
    cancelHoverOpen()
    cancelHoverClose()
    if (!open) return
    setOpen(false)
    closeAllCatalogs()
  }, [visible, open])

  if (!visible) return null

  const focusAt = (index: number): void => {
    const items = treeItems(menuRef.current)
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = treeItems(menuRef.current)
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      changeOpen(false, true)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    }
  }

  return (
    <div
      className={`${css.root} ${variant === 'switcher' ? css.switcherRoot : ''}`}
      ref={rootRef}
      onKeyDown={navigate}
      onMouseEnter={scheduleHoverOpen}
      onMouseLeave={scheduleHoverClose}
    >
      {separator && <span className={css.separator}>/</span>}
      <button
        ref={triggerRef}
        type="button"
        className={variant === 'switcher'
          ? `${css.switcherTrigger} ${ancestorSwitcher ? css.ancestorSwitcherTrigger : ''}`
          : css.trigger}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={variant === 'switcher'
          ? t('switcher.aria', { title: switcherDisplayTitle })
          : t(
            descendants.runningCount > 0 ? runningCountKey : totalCountKey,
            { count: descendants.runningCount > 0 ? descendants.runningCount : descendantCount },
          )}
        onClick={openTitle === undefined
          ? undefined
          : () => {
            cancelHoverOpen()
            if (open) changeOpen(false)
            openTitle()
          }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          if (!open) changeOpen(true)
          queueMicrotask(() => { focusAt(0) })
        }}
      >
        {variant === 'switcher'
          ? <span className={css.switcherTitle}>{switcherDisplayTitle}</span>
          : (
            <>
              {descendants.runningCount > 0 && (
                <span className={css.activitySlot}>
                  <StateDot state="ongoing" />
                </span>
              )}
              <span className={css.count}>{t(totalCountKey, { count: descendantCount })}</span>
            </>
          )}
        {variant === 'switcher'
          ? <SubagentSwitcherIcon />
          : <IconChevronDownOutline14 className={open ? css.triggerOpen : undefined} />}
      </button>
      {open && createPortal((
        <div
          ref={menuRef}
          className={css.menu}
          style={menuPosition}
          role="tree"
          aria-label={t('tree.aria')}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          {runningCount > 0 && (
            <section className={`${css.section} ${css.runningSection}`}>
              <h2 className={css.sectionTitle}>{t('section.running', { count: runningCount })}</h2>
              <div className={css.sectionBody}>
                <CatalogSectionRows
                  nodes={runningNodes}
                  currentSessionId={currentSessionId}
                  catalogs={catalogs}
                  summaries={summaries}
                  expanded={expanded}
                  now={now}
                  openChild={openChild}
                  refresh={refresh}
                  toggleBranch={toggleBranch}
                  closeCatalog={() => { changeOpen(false) }}
                  t={t}
                />
              </div>
            </section>
          )}
          <section className={`${css.section} ${css.historySection}`}>
            <h2 className={css.sectionTitle}>{t('section.history', { count: historyCount })}</h2>
            <div className={css.sectionBody}>
              {historyCount === 0 && <div className={css.notice}>{t('section.history.empty')}</div>}
              <CatalogSectionRows
                nodes={historyNodes}
                currentSessionId={currentSessionId}
                catalogs={catalogs}
                summaries={summaries}
                expanded={expanded}
                now={now}
                openChild={openChild}
                refresh={refresh}
                toggleBranch={toggleBranch}
                closeCatalog={() => { changeOpen(false) }}
                t={t}
              />
              <CatalogFeedback
                parentSessionId={rootSessionId}
                catalog={presentedCatalog}
                summaries={summaries}
                level={1}
                refresh={refresh}
                t={t}
              />
            </div>
          </section>
        </div>
      ), document.body)}
    </div>
  )
}

/**
 * Render one breadcrumb title together with its subagent navigation.
 * @param props - Breadcrumb title, session standard props, and catalog actions.
 * @returns An ordinary-title descendant count, or a title-and-chevron sibling switcher.
 */
export function SubagentHeaderLineage({
  lineageSessionId, displayTitle, openTitle,
  useSessions, openChild, refresh, setCatalogOpen, t,
}: SubagentHeaderLineageProps) {
  const parentId = useSessions((state) => {
    const summary = state.byId[lineageSessionId]
    return summary?.origin === 'subagent' ? summary.parentId : undefined
  })
  const shared = { useSessions, openChild, refresh, setCatalogOpen, t }
  if (parentId === undefined) {
    return (
      <CatalogDropdown
        key={lineageSessionId}
        rootSessionId={lineageSessionId}
        variant="count"
        separator
        {...shared}
      />
    )
  }
  return (
    <>
      <CatalogDropdown
        key={lineageSessionId}
        rootSessionId={parentId}
        currentSessionId={lineageSessionId}
        variant="switcher"
        displayTitle={displayTitle}
        {...openTitle === undefined ? {} : { openTitle }}
        {...shared}
      />
      {openTitle === undefined && (
        <CatalogDropdown
          key={lineageSessionId}
          rootSessionId={lineageSessionId}
          variant="count"
          {...shared}
        />
      )}
    </>
  )
}
