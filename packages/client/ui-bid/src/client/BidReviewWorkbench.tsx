import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BidReviewChapterView, BidReviewWorkbenchView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconChevronRightOutline14,
  IconRefreshOutline14,
  IconThinkOutline14,
  MarkdownText,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidReviewWorkbench.module.css'

export type { BidReviewChapterView, BidReviewWorkbenchView } from '@deepseek-ai/dsh-bid/control-plane'

function classes(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ')
}

/** Host actions used by the live S5 writing workbench. */
export interface BidReviewWorkbenchInjected {
  getWorkbench: () => Promise<BidReviewWorkbenchView>
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  exportDocx?: () => Promise<{ path: string }>
  setEmbeddedSurface: (kind: 'chat' | 'composer' | 'review', element: HTMLElement | null) => void
  retryStage?: () => Promise<void>
}

export type BidReviewWorkbenchProps = ConvViewProps & BidReviewWorkbenchInjected


const MATERIAL_USAGE_LABEL: Record<string, string> = {
  reuse: '直接复用',
  adapt: '参考改写',
  reference: '参考借鉴',
  background: '背景支撑',
}

const EVIDENCE_STATUS_LABEL: Record<string, string> = {
  available: '佐证充足',
  missing: '缺少佐证',
  not_applicable: '无需佐证',
}

/** Live S5 chapter and Reviewer workbench with Host-owned on-demand export. */
export function BidReviewWorkbench({
  sessionId, useSessions, useProjection, getWorkbench, getChapter, exportDocx, retryStage, setEmbeddedSurface,
}: BidReviewWorkbenchProps) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [workbench, setWorkbench] = useState<BidReviewWorkbenchView | null>(null)
  const [chapter, setChapter] = useState<BidReviewChapterView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const selectedSectionId = useRef<string | null>(null)
  const requestVersion = useRef(0)
  const reviewSurfaceRef = useCallback((element: HTMLDivElement | null) => { setEmbeddedSurface('review', element) }, [setEmbeddedSurface])
  const confirmationReady = projection?.runtime.status === 'waiting_user'
    && (projection.runtime.stage === 'tender_analysis' || projection.runtime.stage === 'outline_generation' || projection.runtime.stage === 'evidence_mapping')
  const ready = projection?.runtime.stage === 'chapter_writing' || projection?.runtime.stage === 'docx_export'
  const exportReady = ready && projection?.runtime.status === 'completed'

  const refresh = useCallback((): Promise<void> => {
    if (!ready) return Promise.resolve()
    const version = ++requestVersion.current
    return getWorkbench().then(async (value) => {
      if (version !== requestVersion.current) return
      setWorkbench(value)
      const selected = value.outline.find(item => item.section_id === selectedSectionId.current && item.content_available)
        ?? value.outline.find(item => item.content_available)
      if (selected !== undefined) {
        const next = await getChapter(selected.section_id)
        if (version !== requestVersion.current) return
        selectedSectionId.current = next.section_id
        setChapter(next)
      } else {
        selectedSectionId.current = null
        setChapter(null)
      }
      setError(null)
    }).catch((reason: unknown) => {
      if (version === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [getChapter, getWorkbench, ready])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = (): void => {
      void refresh().then(() => {
        if (!disposed && ready && projection?.runtime.status === 'running') timer = window.setTimeout(poll, 1000)
      })
    }
    poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      requestVersion.current++
    }
  }, [projection?.runtime.status, ready, refresh])

  const rows = useMemo(() => {
    const items = workbench?.outline ?? []
    const children = new Map<string | null, typeof items>()
    for (const item of items) children.set(item.parent_id, [...(children.get(item.parent_id) ?? []), item])
    for (const [parent, siblings] of children) children.set(parent, [...siblings].sort((left, right) => left.order - right.order))
    const result: Array<{ section: (typeof items)[number]; number: string; depth: number; hasChildren: boolean }> = []
    const visit = (parent: string | null, depth: number, prefix: string): void => {
      for (const section of children.get(parent) ?? []) {
        const number = prefix ? `${prefix}.${section.order}` : String(section.order)
        const hasChildren = (children.get(section.section_id)?.length ?? 0) > 0
        result.push({ section, number, depth, hasChildren })
        if (!collapsed.has(section.section_id)) visit(section.section_id, depth + 1, number)
      }
    }
    visit(null, 0, '')
    return result
  }, [collapsed, workbench])

  if (!isBid || projection === undefined) return null
  if (confirmationReady) {
    return (
      <section className={css.confirmationContainer} aria-label="审核项">
        <div ref={reviewSurfaceRef} className={css.reviewSurfaceHost} />
      </section>
    )
  }
  if (!ready) return null
  if (projection.runtime.status === 'pending') return <section className={css.loading}>等待开始章节写作。</section>
  if (projection.runtime.status === 'failed') return (
    <section className={css.loading}>
      <p>章节写作失败：{projection.runtime.failureReason ?? '未知错误'}</p>
      <Button variant="primary" disabled={retryStage === undefined} onClick={() => { void retryStage?.() }}>重试</Button>
    </section>
  )

  const select = (sectionId: string): void => {
    const version = ++requestVersion.current
    selectedSectionId.current = sectionId
    setError(null)
    void getChapter(sectionId).then(
      (value) => {
        if (version !== requestVersion.current) return
        setChapter(value)
      },
      (reason: unknown) => {
        if (version === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  const needsAttention = workbench?.summary.needs_attention_count ?? 0

  const exportWord = (): void => {
    if (!exportReady || exporting || exportDocx === undefined) return
    setExporting(true)
    setError(null)
    void exportDocx().then(
      (value) => { setExportPath(value.path) },
      (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { setExporting(false) })
  }

  return (
    <section className={css.root} data-conversation-composer-overlay="">
      <header className={css.header}>
        <div className={css.headerLeft}>
          <span className={css.headerTitle}>技术标章节写作与审稿</span>
          <div className={css.headerStats}>
            <Pill className={css.statPill}>
              正文 {workbench?.summary.content_count ?? 0}/{workbench?.summary.chapter_count ?? 0}
            </Pill>
            <Pill className={css.statPill}>
              已审核 {workbench?.summary.reviewed_count ?? 0}
            </Pill>
            <Pill className={classes(css.statPill, needsAttention > 0 && css.statPillWarning)}>
              需关注 {needsAttention}
            </Pill>
          </div>
        </div>
        <div className={css.headerStats}>
          {exportPath !== null && <Pill className={css.statPill}><span title={exportPath}>Word 已导出：{exportPath}</span></Pill>}
          <Button variant="primary" size="sm" disabled={!exportReady || exporting || exportDocx === undefined} onClick={exportWord}>
            {exporting ? '正在导出…' : '导出 Word'}
          </Button>
          <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void refresh() }}>
            刷新
          </Button>
        </div>
      </header>

      {error !== null && <div className={css.error}>{error}</div>}

      <div className={css.columns}>
        <div className={css.left}>
          <div className={css.leftHeader}>
            <span>章节目录</span>
            <span>{rows.length} 节</span>
          </div>
          <div className={css.outline} role="navigation" aria-label="章节目录">
            {rows.map(({ section, number, depth, hasChildren }) => {
              const title = `${number} ${section.title}`
              const isSelected = chapter?.section_id === section.section_id
              const isCollapsed = collapsed.has(section.section_id)
              const dotInfo = getChapterDotInfo(section.writing_status, section.review_status)

              return (
                <div
                  key={section.section_id}
                  className={classes(css.treeRow, isSelected && css.activeRow)}
                  style={{ paddingInlineStart: `${4 + depth * 14}px` }}
                >
                  <button
                    type="button"
                    className={classes(css.disclosure, !isCollapsed && hasChildren && css.disclosureExpanded)}
                    disabled={!hasChildren}
                    aria-label={hasChildren ? (isCollapsed ? '展开' : '折叠') : undefined}
                    onClick={() => {
                      setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(section.section_id)) next.delete(section.section_id)
                        else next.add(section.section_id)
                        return next
                      })
                    }}
                  >
                    {hasChildren ? <IconChevronRightOutline14 /> : null}
                  </button>
                  <button
                    type="button"
                    className={css.sectionBtn}
                    disabled={!section.content_available}
                    title={title}
                    onClick={() => { select(section.section_id) }}
                  >
                    <span className={css.sectionTitle}>{title}</span>
                    <span className={css.statusDotContainer} title={`${title}：${dotInfo.title}`}>
                      <span className={dotInfo.className} />
                    </span>
                  </button>
                  {!section.writable && section.summary && <p className={css.branchSummary}>{section.summary}</p>}
                </div>
              )
            })}
          </div>
        </div>

        <div className={css.reader} role="main" aria-label="正文阅读">
          {chapter?.markdown == null ? (
            <div className={css.emptyState}>
              <div className={css.emptyStateIcon}>
                <IconThinkOutline14 size={24} />
              </div>
              <p className={css.emptyStateTitle}>正文生成后即可在此查看。</p>
              <p className={css.emptyStateDesc}>左侧选择已有正文的章节，即可实时预览正文排版并查看关联审查详情。</p>
            </div>
          ) : (
            <article className={css.article}>
              <header className={css.articleHeader}>
                {chapter.heading_path.length > 0 && (
                  <p className={css.breadcrumbs}>{chapter.heading_path.join(' / ')}</p>
                )}
                <div className={titleRowClass(chapter.number)}>
                  {chapter.number && <span className={css.chapterNumber}>{chapter.number}</span>}
                  <h1 className={css.articleTitle}>{chapter.title}</h1>
                </div>
              </header>
              <div className={css.articleBody}>
                <MarkdownText text={chapter.markdown} />
              </div>
            </article>
          )}
        </div>

        <div className={css.review} role="complementary" aria-label="参考资料与审查">
          <div className={css.reviewHeader}>
            <h2>参考资料</h2>
            {chapter?.materials && chapter.materials.length > 0 && (
              <span className={css.miniTag}>
                {chapter.materials.length} 篇参考
              </span>
            )}
          </div>

          {chapter === null ? (
            <div className={css.emptyState}>
              <p className={css.emptyStateTitle}>请选择章节查看对应的参考资料与依据。</p>
            </div>
          ) : (
            <>
              <section className={css.reviewSection}>
                <span className={css.fieldLabel}>关联参考资料 ({chapter.materials?.length ?? 0})</span>
                {(!chapter.materials || chapter.materials.length === 0) ? (
                  <div className={css.card}>
                    <span className={css.fieldLabel}>本章节暂无特定引用资料，按通用技术规范与招标文件要求编写。</span>
                  </div>
                ) : (
                  <ul className={css.issuesList}>
                    {chapter.materials.map((mat, idx) => (
                      <li key={`${mat.file_id}-${idx}`} className={css.materialCard}>
                        <div className={css.materialHeader}>
                          <span className={css.materialLabel}>{mat.source_label}</span>
                          <span className={css.materialUsageTag}>
                            {MATERIAL_USAGE_LABEL[mat.usage] ?? mat.usage}
                          </span>
                        </div>
                        <p className={css.materialSummary}>{mat.summary}</p>
                        <span className={css.materialSource}>来源：{mat.file_id}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={css.reviewSection}>
                <div className={css.fieldRow}>
                  <span className={css.fieldLabel}>招标条款要求 (Requirements)</span>
                  <div className={css.fieldValue}>
                    {chapter.requirement_ids.length === 0 ? (
                      <span className={css.tag}>无明确对应条款</span>
                    ) : (
                      chapter.requirement_ids.map(id => <span key={id} className={css.tag}>{id}</span>)
                    )}
                  </div>
                </div>

                <div className={css.fieldRow}>
                  <span className={css.fieldLabel}>技术评分响应点 (Response Points)</span>
                  <div className={css.fieldValue}>
                    {chapter.scoring_response_point_ids.length === 0 ? (
                      <span className={css.tag}>无明确对应评分点</span>
                    ) : (
                      chapter.scoring_response_point_ids.map(id => <span key={id} className={css.tag}>{id}</span>)
                    )}
                  </div>
                </div>
              </section>

              <section className={css.card}>
                <div className={css.fieldRow}>
                  <span className={css.fieldLabel}>佐证支撑状态 (Evidence)</span>
                  <span className={css.fieldValue}>
                    Evidence：{chapter.evidence_status}
                    <span className={chapter.evidence_status === 'available' ? classes(css.miniTag, css.miniTagSuccess) : (css.miniTag ?? '')}>
                      {EVIDENCE_STATUS_LABEL[chapter.evidence_status] ?? chapter.evidence_status}
                    </span>
                  </span>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function titleRowClass(_num?: string): string {
  return css.titleRow ?? ''
}

function getChapterDotInfo(
  writingStatus: string,
  reviewStatus: string,
): { className: string; title: string } {
  // 1. 异常：显示红色
  if (writingStatus === 'failed' || reviewStatus === 'failed' || reviewStatus === 'needs_attention') {
    return {
      className: classes(css.statusDot, css.statusDotRed),
      title: writingStatus === 'failed' ? '编写失败' : (reviewStatus === 'needs_attention' ? '需关注' : '审核未通过'),
    }
  }

  // 2. 审核了：显示绿色
  if (reviewStatus === 'pass') {
    return {
      className: classes(css.statusDot, css.statusDotGreen),
      title: '审核通过',
    }
  }

  // 3. 编写了：显示蓝色
  if (writingStatus === 'writing' || writingStatus === 'content_ready' || writingStatus === 'completed') {
    return {
      className: classes(css.statusDot, css.statusDotBlue, writingStatus === 'writing' && css.statusDotPulsing),
      title: writingStatus === 'writing' ? '正在编写' : '正文已编写',
    }
  }

  // 4. 没有编写：显示灰色点
  return {
    className: classes(css.statusDot, css.statusDotGray),
    title: '未编写',
  }
}
