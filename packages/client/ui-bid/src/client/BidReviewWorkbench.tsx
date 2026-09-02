import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BidReviewChapterView, BidReviewWorkbenchView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidReviewWorkbench.module.css'

export type { BidReviewChapterView, BidReviewWorkbenchView } from '@deepseek-ai/dsh-bid/control-plane'

/** Host actions used by the live S5 writing workbench. */
export interface BidReviewWorkbenchInjected {
  getWorkbench: () => Promise<BidReviewWorkbenchView>
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  setEmbeddedSurface: (kind: 'chat' | 'composer' | 'review', element: HTMLElement | null) => void
  retryStage?: () => Promise<void>
}

export type BidReviewWorkbenchProps = ConvViewProps & BidReviewWorkbenchInjected

/** Live read-only S5 chapter and reviewer workbench. */
export function BidReviewWorkbench({
  sessionId, useSessions, useProjection, getWorkbench, getChapter, retryStage, setEmbeddedSurface = () => {},
}: BidReviewWorkbenchProps) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [workbench, setWorkbench] = useState<BidReviewWorkbenchView | null>(null)
  const [chapter, setChapter] = useState<BidReviewChapterView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const selectedSectionId = useRef<string | null>(null)
  const reviewSurfaceRef = useCallback((element: HTMLDivElement | null) => { setEmbeddedSurface('review', element) }, [setEmbeddedSurface])
  const confirmationReady = projection?.runtime.status === 'waiting_user'
    && (projection.runtime.stage === 'tender_analysis' || projection.runtime.stage === 'outline_generation' || projection.runtime.stage === 'evidence_mapping')
  const ready = projection?.runtime.stage === 'chapter_writing'

  const refresh = useCallback((): void => {
    if (!ready) return
    void getWorkbench().then(async (value) => {
      setWorkbench(value)
      const selected = value.outline.find(item => item.section_id === selectedSectionId.current && item.content_available)
        ?? value.outline.find(item => item.content_available)
      if (selected !== undefined) {
        const next = await getChapter(selected.section_id)
        selectedSectionId.current = next.section_id
        setChapter(next)
      }
    }).catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [getChapter, getWorkbench, ready])

  useEffect(() => {
    refresh()
    if (!ready || projection?.runtime.status !== 'running') return
    const timer = window.setInterval(refresh, 1000)
    return () => { window.clearInterval(timer) }
  }, [projection?.runtime.status, ready, refresh])

  const rows = useMemo(() => {
    const items = workbench?.outline ?? []
    const children = new Map<string | null, typeof items>()
    for (const item of items) children.set(item.parent_id, [...(children.get(item.parent_id) ?? []), item])
    for (const [parent, siblings] of children) children.set(parent, [...siblings].sort((left, right) => left.order - right.order))
    const result: Array<{ section: (typeof items)[number]; depth: number; hasChildren: boolean }> = []
    const visit = (parent: string | null, depth: number): void => {
      for (const section of children.get(parent) ?? []) {
        const hasChildren = (children.get(section.section_id)?.length ?? 0) > 0
        result.push({ section, depth, hasChildren })
        if (!collapsed.has(section.section_id)) visit(section.section_id, depth + 1)
      }
    }
    visit(null, 0)
    return result
  }, [collapsed, workbench])

  if (!isBid || projection === undefined) return null
  if (confirmationReady) return <section className={css.loading} aria-label="审核项"><h1>审核项</h1><p>请核对详情后确认。</p><div ref={reviewSurfaceRef} /></section>
  if (!ready) return null
  if (projection.runtime.status === 'pending') return <section className={css.loading}>等待开始章节写作。</section>
  if (projection.runtime.status === 'failed') return <section className={css.loading}><p>章节写作失败：{projection.runtime.failureReason ?? '未知错误'}</p><button type="button" disabled={retryStage === undefined} onClick={() => { void retryStage?.() }}>重试</button></section>

  const select = (sectionId: string): void => {
    setError(null)
    void getChapter(sectionId).then(
      (value) => {
        selectedSectionId.current = value.section_id
        setChapter(value)
      },
      (reason) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    )
  }
  return <section className={css.root}>
    <header className={css.header}>
      <span>技术标章节写作与审核</span>
      <span>正文 {workbench?.summary.content_count ?? 0}/{workbench?.summary.chapter_count ?? 0}</span>
      <span>已审核 {workbench?.summary.reviewed_count ?? 0}</span>
      <span>需关注 {workbench?.summary.needs_attention_count ?? 0}</span>
      <button type="button" onClick={refresh}>刷新</button>
    </header>
    {error !== null && <div className={css.error}>{error}</div>}
    <div className={css.columns} style={{ gridTemplateColumns: '360px minmax(520px, 1fr) 320px' }}>
      <aside className={css.left}>
        <nav className={css.outline}>
          {rows.map(({ section, depth, hasChildren }) => <div
            key={section.section_id}
            className={css.treeRow}
            style={{ paddingInlineStart: `${8 + depth * 16}px` }}
          >
            <button
              type="button"
              className={css.disclosure}
              disabled={!hasChildren}
              onClick={() => {
                setCollapsed((current) => {
                  const next = new Set(current)
                  if (next.has(section.section_id)) next.delete(section.section_id)
                  else next.add(section.section_id)
                  return next
                })
              }}
            >
              {hasChildren ? collapsed.has(section.section_id) ? '▸' : '▾' : '·'}
            </button>
            <button
              type="button"
              className={chapter?.section_id === section.section_id ? css.active : undefined}
              disabled={!section.content_available}
              onClick={() => { select(section.section_id) }}
            >
              {section.title} · {section.writing_status} · {section.review_status}
            </button>
          </div>)}
        </nav>
      </aside>
      <main className={css.reader}>{chapter?.markdown == null ? '正文生成后即可在此查看。' : <article><p>{chapter.number}</p><h1>{chapter.title}</h1><p>{chapter.heading_path.join(' / ')}</p><MarkdownText text={chapter.markdown} /></article>}</main>
      <aside className={css.review}><h2>章节审核</h2>{chapter === null ? <p>请选择已有正文的章节。</p> : <><p>状态：{chapter.review.status}</p><p>Requirements：{chapter.requirement_ids.join('、') || '无'}</p><p>Response Points：{chapter.scoring_response_point_ids.join('、') || '无'}</p><p>Evidence：{chapter.evidence_status}</p>{chapter.review.issues.length === 0 ? <p>暂无审查问题。</p> : <ul>{chapter.review.issues.map(issue => <li key={issue.issue_id}><strong>{issue.title}</strong><p>{issue.detail}</p><p>{issue.suggestion}</p></li>)}</ul>}</>}</aside>
    </div>
  </section>
}
