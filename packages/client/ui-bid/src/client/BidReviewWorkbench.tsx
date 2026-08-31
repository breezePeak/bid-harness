import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidReviewWorkbench.module.css'

/** Injected S7 Remote actions, kept separate from the generic conversation view. */
export interface BidReviewWorkbenchInjected {
  getWorkbench: () => Promise<BidReviewWorkbenchView>
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  completeReview: () => Promise<void>
  /** Register destinations for the shared ChatView and InputBar React portals. */
  setEmbeddedSurface: (kind: 'chat' | 'composer' | 'review', element: HTMLElement | null) => void
  /** Retry framework preparation after a Host-reported S7 failure. */
  retryStage?: () => Promise<void>
}

export interface BidReviewIssue {
  readonly issue_id: string
  readonly section_id: string
  readonly category: string
  readonly severity: 'blocking' | 'warning' | 'info'
  readonly status: 'open' | 'resolved' | 'dismissed'
  readonly title: string
  readonly detail: string
  readonly suggestion: string
}

export interface BidReviewWorkbenchView {
  readonly schema_version: 1
  readonly outline: readonly {
    readonly section_id: string
    readonly parent_id: string | null
    readonly order: number
    readonly writable: boolean
    readonly has_content: boolean
    readonly review_status: 'not_evaluated'
    readonly title: string
  }[]
  readonly review: {
    readonly review_mode: 'framework_only'
    readonly quality_gate: 'not_evaluated'
    readonly summary: {
      readonly chapter_count: number
      readonly evaluated_chapter_count: 0
      readonly issue_count: number
      readonly blocking_issue_count: number
    }
    readonly limitations: readonly string[]
    readonly issues: readonly BidReviewIssue[]
  }
}

export interface BidReviewChapterView {
  readonly section_id: string
  readonly title: string
  readonly number: string
  readonly heading_path: readonly string[]
  readonly writable: boolean
  readonly markdown: string | null
}

export type BidReviewWorkbenchProps = ConvViewProps & BidReviewWorkbenchInjected

/** Read a bounded persisted pane width without making storage availability a prerequisite for the view. */
function storedWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
  } catch {
    return fallback
  }
}

/** Three-column, read-only S7 workspace over Host-owned review DTOs. */
export function BidReviewWorkbench({
  sessionId, useSessions, useProjection, getWorkbench, getChapter, completeReview, retryStage,
  setEmbeddedSurface = () => {},
}: BidReviewWorkbenchProps) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [workbench, setWorkbench] = useState<BidReviewWorkbenchView | null>(null)
  const [chapter, setChapter] = useState<BidReviewChapterView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [leftWidth, setLeftWidth] = useState(() => storedWidth('dsh.bid-review.left-width', 360, 300, 440))
  const [rightWidth, setRightWidth] = useState(() => storedWidth('dsh.bid-review.right-width', 320, 280, 380))
  const [outlineHeight, setOutlineHeight] = useState(() => storedWidth('dsh.bid-review.outline-height', 40, 25, 65))
  const [zoom, setZoom] = useState(() => storedWidth('dsh.bid-review.zoom', 100, 75, 150))
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    try { return window.localStorage.getItem('dsh.bid-review.right-collapsed') === 'true' } catch { return false }
  })
  const [narrowPane, setNarrowPane] = useState<'outline' | 'chat'>('outline')
  const selectedSectionId = useRef<string | null>(null)
  const chatSurfaceRef = useCallback(
    (element: HTMLDivElement | null) => { setEmbeddedSurface('chat', element) },
    [setEmbeddedSurface],
  )
  const composerSurfaceRef = useCallback(
    (element: HTMLDivElement | null) => { setEmbeddedSurface('composer', element) },
    [setEmbeddedSurface],
  )
  const reviewSurfaceRef = useCallback(
    (element: HTMLDivElement | null) => { setEmbeddedSurface('review', element) },
    [setEmbeddedSurface],
  )
  const ready = projection?.runtime.stage === 'book_review' && projection.runtime.status === 'waiting_user'
  const confirmationReady = projection?.runtime.status === 'waiting_user'
    && (projection.runtime.stage === 'tender_analysis' || projection.runtime.stage === 'outline_confirmation')

  const refresh = useCallback((): void => {
    if (!ready) return
    setError(null)
    void getWorkbench().then((value) => {
      setWorkbench(value)
      const selected = selectedSectionId.current === null
        ? value.outline.find(section => section.writable && section.has_content)
        : value.outline.find(section => section.section_id === selectedSectionId.current)
      if (selected !== undefined) {
        return getChapter(selected.section_id).then((value) => {
          selectedSectionId.current = value.section_id
          setChapter(value)
        })
      }
    }).catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [getChapter, getWorkbench, ready])
  useEffect(() => {
    refresh()
  }, [refresh])

  const outline = useMemo(() => {
    const items = workbench?.outline ?? []
    const children = new Map<string | null, typeof items>()
    for (const item of items) children.set(item.parent_id, [...(children.get(item.parent_id) ?? []), item])
    for (const [parent, siblings] of children) children.set(parent, [...siblings].sort((left, right) => left.order - right.order))
    const rows: { section: (typeof items)[number]; depth: number; hasChildren: boolean }[] = []
    const visit = (parent: string | null, depth: number): void => {
      for (const section of children.get(parent) ?? []) {
        rows.push({ section, depth, hasChildren: (children.get(section.section_id)?.length ?? 0) > 0 })
        if (!collapsed.has(section.section_id)) visit(section.section_id, depth + 1)
      }
    }
    visit(null, 0)
    return rows
  }, [collapsed, workbench])
  const chapters = useMemo(
    () => outline.filter(({ section }) => section.writable && section.has_content).map(({ section }) => section),
    [outline],
  )
  if (!isBid || projection === undefined) return null
  if (confirmationReady) return <section className={css.loading} aria-label="审核项">
    <h1>审核项</h1>
    <p>请核对详情后确认，主对话页也可直接确认。</p>
    <div ref={reviewSurfaceRef} />
  </section>
  if (projection.runtime.stage !== 'book_review') return null
  if (projection.runtime.status === 'pending') return <section className={css.loading}>等待准备整本审核框架。</section>
  if (projection.runtime.status === 'running') return <section className={css.loading}>正在读取章节并准备审核工作台。</section>
  if (projection.runtime.status === 'failed') {
    return <section className={css.loading}>
      <p>审核框架准备失败：{projection.runtime.failureReason ?? '未知错误'}</p>
      <button type="button" disabled={retryStage === undefined} onClick={() => { void retryStage?.().catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }}>重试</button>
      {error !== null && <p className={css.error}>{error}</p>}
    </section>
  }
  if (!ready) return <section className={css.loading}>S7 已完成，正在进入 DOCX 导出阶段。</section>

  const select = (sectionId: string): void => {
    setError(null)
    void getChapter(sectionId).then(
      (value) => { selectedSectionId.current = value.section_id; setChapter(value) },
      (reason) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    )
  }
  const finish = (): void => {
    const confirmation = [
      '当前版本仅完成审核工作台与流程框架，详细审核规则尚未启用。',
      '继续后将进入 DOCX 导出阶段。',
    ].join('')
    if (!window.confirm(confirmation)) return
    setBusy(true); setError(null)
    void completeReview()
      .catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { setBusy(false) })
  }
  const resize = (edge: 'left' | 'right', start: number): void => {
    const move = (event: PointerEvent): void => {
      const delta = event.clientX - start
      if (edge === 'left') setLeftWidth(value => Math.max(300, Math.min(440, value + delta)))
      else setRightWidth(value => Math.max(280, Math.min(380, value - delta)))
      start = event.clientX
    }
    const end = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  const adjustWidth = (edge: 'left' | 'right', amount: number): void => {
    if (edge === 'left') setLeftWidth((value) => {
      const next = Math.max(300, Math.min(440, value + amount))
      window.localStorage.setItem('dsh.bid-review.left-width', String(next))
      return next
    })
    else setRightWidth((value) => {
      const next = Math.max(280, Math.min(380, value + amount))
      window.localStorage.setItem('dsh.bid-review.right-width', String(next))
      return next
    })
  }
  const adjustZoom = (amount: number): void => {
    setZoom((value) => {
      const next = Math.max(75, Math.min(150, value + amount))
      window.localStorage.setItem('dsh.bid-review.zoom', String(next))
      return next
    })
  }
  const adjustOutlineHeight = (amount: number): void => {
    setOutlineHeight((value) => {
      const next = Math.max(25, Math.min(65, value + amount))
      window.localStorage.setItem('dsh.bid-review.outline-height', String(next))
      return next
    })
  }
  const resizeOutlineHeight = (): void => {
    const move = (event: PointerEvent): void => {
      const leftPane = document.querySelector(`.${css.left}`)
      if (leftPane === null) return
      const bounds = leftPane.getBoundingClientRect()
      const next = ((event.clientY - bounds.top) / bounds.height) * 100
      if (!Number.isFinite(next)) return
      const bounded = Math.max(25, Math.min(65, next))
      setOutlineHeight(bounded)
      window.localStorage.setItem('dsh.bid-review.outline-height', String(bounded))
    }
    const end = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  const moveChapter = (direction: -1 | 1): void => {
    const current = chapters.findIndex(item => item.section_id === chapter?.section_id)
    const next = chapters[current + direction]
    if (next !== undefined) select(next.section_id)
  }
  return <section className={css.root}>
    <header className={css.header}><span>技术标整本审核</span><span>状态：等待完成审核</span><span>章节：{workbench?.review.summary.chapter_count ?? 0}</span><span>framework_only · not_evaluated</span><span className={css.zoom}><button type="button" aria-label="缩小正文" onClick={() => { adjustZoom(-10) }}>−</button><output>{zoom}%</output><button type="button" aria-label="放大正文" onClick={() => { adjustZoom(10) }}>＋</button></span><button type="button" onClick={refresh}>刷新</button><button type="button" onClick={() => { setRightCollapsed((value) => { const next = !value; window.localStorage.setItem('dsh.bid-review.right-collapsed', String(next)); return next }) }}>{rightCollapsed ? '展开审核栏' : '折叠审核栏'}</button><button type="button" disabled={busy} onClick={finish}>完成本轮审核，进入导出</button></header>
    {error !== null && <div className={css.error}>{error}</div>}
    <div className={css.columns} style={{ gridTemplateColumns: `${leftWidth}px 8px minmax(520px, 1fr) ${rightCollapsed ? '0px' : '8px'} ${rightCollapsed ? '0px' : `${rightWidth}px`}` }}>
      <aside className={css.left} data-narrow-pane={narrowPane}><div className={css.narrowTabs}><button type="button" aria-pressed={narrowPane === 'outline'} onClick={() => { setNarrowPane('outline') }}>目录</button><button type="button" aria-pressed={narrowPane === 'chat'} onClick={() => { setNarrowPane('chat') }}>对话</button></div><nav className={css.outline} style={{ height: `${outlineHeight}%` }}>{outline.map(({ section, depth, hasChildren }) => <div key={section.section_id} className={css.treeRow} style={{ paddingInlineStart: `${8 + depth * 16}px` }}><button type="button" className={css.disclosure} disabled={!hasChildren} aria-label={hasChildren ? (collapsed.has(section.section_id) ? '展开目录' : '折叠目录') : undefined} onClick={() => { setCollapsed((current) => { const next = new Set(current); if (next.has(section.section_id)) next.delete(section.section_id); else next.add(section.section_id); return next }) }}>{hasChildren ? (collapsed.has(section.section_id) ? '▸' : '▾') : '·'}</button><button type="button" className={chapter?.section_id === section.section_id ? css.active : undefined} onClick={() => { select(section.section_id) }}>{section.title}{section.has_content ? '' : '（结构）'} · {section.review_status}</button></div>)}</nav><div className={css.horizontalResizer} role="separator" aria-label="调整目录与聊天高度" aria-orientation="horizontal" tabIndex={0} onPointerDown={() => { resizeOutlineHeight() }} onKeyDown={(event) => { if (event.key === 'ArrowUp') { event.preventDefault(); adjustOutlineHeight(-5) } if (event.key === 'ArrowDown') { event.preventDefault(); adjustOutlineHeight(5) } }} /><div className={css.chat}><div ref={chatSurfaceRef} className={css.chatTranscript} data-conversation-scroll="" /><div ref={composerSurfaceRef} className={css.composerSurface} /></div></aside>
      <div className={css.resizer} role="separator" aria-label="调整目录与正文宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => { resize('left', event.clientX) }} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWidth('left', -16) } if (event.key === 'ArrowRight') { event.preventDefault(); adjustWidth('left', 16) } }} />
      <main className={css.reader}>{chapter === null ? '选择一个章节。' : chapter.markdown === null ? <div>这是目录结构节点，没有独立正文。下级章节：{outline.filter(({ section }) => section.parent_id === chapter.section_id).map(({ section }) => section.title).join('、') || '无'}。</div> : <article style={{ fontSize: `${zoom}%` }}><div className={css.readerActions}><button type="button" disabled={chapters.findIndex(item => item.section_id === chapter.section_id) <= 0} onClick={() => { moveChapter(-1) }}>上一章</button><button type="button" disabled={chapters.findIndex(item => item.section_id === chapter.section_id) === chapters.length - 1} onClick={() => { moveChapter(1) }}>下一章</button></div><p>{chapter.number}</p><h1>{chapter.title}</h1><p>{chapter.heading_path.join(' / ')}</p><MarkdownText text={chapter.markdown} /></article>}</main>
      {!rightCollapsed && <div className={css.resizer} role="separator" aria-label="调整正文与审核栏宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => { resize('right', event.clientX) }} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWidth('right', 16) } if (event.key === 'ArrowRight') { event.preventDefault(); adjustWidth('right', -16) } }} />}
      <aside className={css.review}>{!rightCollapsed && <><h2>审核概览</h2><p>review_mode: {workbench?.review.review_mode ?? 'framework_only'}</p><p>quality_gate: {workbench?.review.quality_gate ?? 'not_evaluated'}</p><p>章节数量：{workbench?.review.summary.chapter_count ?? 0}</p><p>已评估章节：{workbench?.review.summary.evaluated_chapter_count ?? 0}</p><p>问题数量：{workbench?.review.summary.issue_count ?? 0}</p><p>阻断问题：{workbench?.review.summary.blocking_issue_count ?? 0}</p><h3>限制</h3><ul>{workbench?.review.limitations.map(item => <li key={item}>{item}</li>)}</ul><h3>问题列表</h3>{(workbench?.review.issues.length ?? 0) === 0 ? <p>尚未执行详细检查。当前问题列表为空不代表审核通过。</p> : <ul>{workbench?.review.issues.map(issue => <li key={issue.issue_id}><button type="button" onClick={() => { select(issue.section_id) }}>{issue.title}</button><p>{issue.detail}</p><p>{issue.suggestion}</p></li>)}</ul>}</>}</aside>
    </div>
  </section>
}
