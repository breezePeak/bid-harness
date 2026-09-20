import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BidAddRevisionIssueRequest,
  BidDeleteRevisionIssueRequest,
  BidRevisionComparisonView,
  BidRevisionQueueView,
  BidRevisionTaskStatus,
  BidReviewChapterView,
  BidReviewWorkbenchView,
  BidUpdateRevisionIssueRequest,
} from '@deepseek-ai/dsh-bid/control-plane'
import { renderFlowchartSvg, type FlowchartSpec } from '@deepseek-ai/dsh-bid/flowchart'
import { Fragment } from 'react'
import type { JSX } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAPTER_DRAG_TYPE, selectedParagraphReference, type createBidRevisionStore, type BidRevisionReference } from './revision-reference.ts'
import {
  Button,
  IconChevronRightOutline14,
  IconRefreshOutline14,
  IconThinkOutline14,
  MarkdownText,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidReviewWorkbench.module.css'
import { BidProgressBar } from './BidProgressBar.tsx'
import { isBidMainSessionSummary } from './session-authority.ts'
import { buildRevisionDiffRows } from './revision-diff.ts'

export type { BidReviewChapterView, BidReviewWorkbenchView } from '@deepseek-ai/dsh-bid/control-plane'

function classes(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ')
}

function pageTargetInfo(
  value: BidReviewWorkbenchView['summary']['page_target'] | undefined,
  estimate: BidReviewWorkbenchView['summary']['page_estimate'] | undefined,
): {
  label: string
  title: string
  warning: boolean
} {
  if (value === undefined || value.status === 'not_set') return { label: '页数目标未设置', title: '尚未保存整书页数目标。', warning: false }
  if (value.status === 'not_required') return { label: '无页数目标', title: '当前写作计划没有整书硬性页数目标。', warning: false }
  if (value.status === 'unavailable') {
    if (value.target === null) return { label: '页数目标无法读取', title: value.reason, warning: true }
    const bounds = value.target.min_pages === null ? `不超过 ${value.target.max_pages} 页`
      : value.target.max_pages === null ? `至少 ${value.target.min_pages} 页`
        : `${value.target.min_pages}–${value.target.max_pages} 页`
    return { label: `目标 ${bounds} · 无法核验`, title: value.reason, warning: true }
  }
  const bounds = value.target.min_pages === null ? `不超过 ${value.target.max_pages} 页`
    : value.target.max_pages === null ? `至少 ${value.target.min_pages} 页`
      : `${value.target.min_pages}–${value.target.max_pages} 页`
  const result = value.status === 'met' ? '已达估算目标'
    : value.status === 'below' ? `尚差 ${value.difference.toFixed(2)} 页`
      : `超出 ${Math.abs(value.difference).toFixed(2)} 页`
  return {
    label: `目标 ${bounds} · ${result}`,
    title: `当前正文估算 ${value.estimated_pages.toFixed(2)} 页；${pageEstimateBasis(estimate)}；${value.target.estimate_basis}`,
    warning: value.status !== 'met',
  }
}

/** Host actions used by the live S5 writing workbench. */
export interface BidReviewWorkbenchInjected {
  getWorkbench: () => Promise<BidReviewWorkbenchView>
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  getRevisionComparison?: (issueId: string) => Promise<BidRevisionComparisonView>
  openWordExport?: () => Promise<void>
  /** Read the current revision issue queue from the Host. */
  getRevisionQueue?: () => Promise<BidRevisionQueueView>
  /** Submit a new revision issue to the Host queue; does not start a Writer. */
  addRevisionIssue?: (request: BidAddRevisionIssueRequest) => Promise<BidRevisionQueueView>
  /** Update a pending revision issue; Host rejects issues already assigned to a batch. */
  updateRevisionIssue?: (request: BidUpdateRevisionIssueRequest) => Promise<BidRevisionQueueView>
  /** Delete a pending revision issue; Host rejects issues already assigned to a batch. */
  deleteRevisionIssue?: (request: BidDeleteRevisionIssueRequest) => Promise<BidRevisionQueueView>
  /** Ask the current Bid Main Agent to plan and execute every pending revision issue. */
  startRevisionBatch?: () => Promise<void>
  /** Register external chapter locate requests triggered from chat or floating panel. */
  onLocateChapter?: (listener: (sectionId: string) => void) => () => void
  /** Register historical revision comparison requests from the floating panel. */
  onCompareRevision?: (listener: (target: { readonly issueId: string; readonly sectionId: string }) => void) => () => void
  /** Notify parent dock/panel when review workbench mounts or unmounts. */
  notifyWorkbenchMount?: (active: boolean) => void
}

export type BidReviewWorkbenchProps = ConvViewProps & BidReviewWorkbenchInjected & PropsStore<ReturnType<typeof createBidRevisionStore>>

/** Discriminated target for context menu and review issue modal: paragraph selection or whole chapter. */
type ApprovalTarget =
  | { readonly kind: 'paragraphs'; readonly reference: BidRevisionReference }
  | { readonly kind: 'chapter'; readonly sectionId: string; readonly baseContentSha256: string; readonly title: string; readonly number: string }

type ContextMenuState = {
  readonly x: number
  readonly y: number
  readonly target: ApprovalTarget
}

type ReaderMode =
  | { readonly kind: 'normal' }
  | { readonly kind: 'compare-loading'; readonly issueId: string; readonly sectionId: string }
  | { readonly kind: 'compare'; readonly comparison: BidRevisionComparisonView }
  | { readonly kind: 'compare-error'; readonly issueId: string; readonly sectionId: string; readonly message: string }


const MATERIAL_USAGE_LABEL: Record<string, string> = {
  reuse: '直接复用',
  reference: '参考依据',
  inspiration: '框架启发',
  compliance: '合规准则',
}

const EVIDENCE_STATUS_LABEL: Record<string, string> = {
  available: '已具备',
  partial: '部分具备',
  missing: '缺失',
  unmapped: '未映射',
}

/** Live S5 chapter and Reviewer workbench with Host-owned on-demand export. */
export function BidReviewWorkbench({
  sessionId, useSessions, useProjection, getWorkbench, getChapter, openWordExport,
  getRevisionComparison, addRevisionIssue, onLocateChapter, onCompareRevision, notifyWorkbenchMount, actions, useStore,
}: BidReviewWorkbenchProps) {
  const isBid = useSessions(state => isBidMainSessionSummary(state.byId[sessionId]))
  const projection = useProjection('bid.runtime')
  const revision = useStore(state => state.revision)
  const [workbench, setWorkbench] = useState<BidReviewWorkbenchView | null>(null)
  const [chapter, setChapter] = useState<BidReviewChapterView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readerMode, setReaderMode] = useState<ReaderMode>({ kind: 'normal' })
  const compareRequestVersion = useRef(0)
  const [exporting, setExporting] = useState(false)
  const [complianceModalOpen, setComplianceModalOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const selectedSectionId = useRef<string | null>(null)
  const requestVersion = useRef(0)
  const articleBody = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [reviewModal, setReviewModal] = useState<ApprovalTarget | null>(null)
  const [reviewInstruction, setReviewInstruction] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const ready = projection?.runtime.stage === 'chapter_writing' || projection?.runtime.stage === 'docx_export'
  const exportReady = ready && projection.allowedActions.includes('export_docx')

  useEffect(() => { setContextMenu(null) }, [chapter, sessionId])
  useEffect(() => {
    if (contextMenu === null) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const dismiss = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setContextMenu(null)
    }
    const escape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', escape)
    }
  }, [contextMenu])

  const latestWorkbenchRef = useRef<BidReviewWorkbenchView | null>(workbench)
  latestWorkbenchRef.current = workbench

  const refresh = useCallback((exitCompare = true): Promise<void> => {
    if (!ready) return Promise.resolve()
    if (exitCompare) {
      compareRequestVersion.current++
      setReaderMode({ kind: 'normal' })
    }
    const version = ++requestVersion.current
    return getWorkbench().then(async (value) => {
      if (version !== requestVersion.current) return
      latestWorkbenchRef.current = value
      setWorkbench(value)
      const selected = value.outline.find(item => item.section_id === selectedSectionId.current && isChapterSelectable(item))
        ?? value.outline.find(item => item.writable && isChapterSelectable(item))
        ?? value.outline.find(isChapterSelectable)
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
    }, (reason: unknown) => {
      if (version !== requestVersion.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [getChapter, getWorkbench, ready])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = (): void => {
      void refresh(false).then(() => {
        const currentWorkbench = latestWorkbenchRef.current
        const revisionBatchActive = currentWorkbench?.revision_batch?.status === 'planning'
          || currentWorkbench?.revision_batch?.status === 'running'
        const shouldPoll = ready && (projection.runtime.status === 'running' || revisionBatchActive)
        if (!disposed && shouldPoll) timer = window.setTimeout(poll, 1000)
      })
    }
    poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      requestVersion.current++
    }
  }, [projection?.runtime.status, ready, refresh, revision])

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
  if (!ready) return null

  const select = (sectionId: string): void => {
    compareRequestVersion.current++
    setReaderMode({ kind: 'normal' })
    const version = ++requestVersion.current
    selectedSectionId.current = sectionId
    setError(null)
    void getChapter(sectionId).then(
      (value) => {
        if (version !== requestVersion.current) return
        setChapter(value)
        if (articleBody.current !== null) articleBody.current.scrollTop = 0
      },
      (reason: unknown) => {
        if (version === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  const openRevisionCompare = (issueId: string, sectionId: string): void => {
    const version = ++compareRequestVersion.current
    selectedSectionId.current = sectionId
    setError(null)
    setReaderMode({ kind: 'compare-loading', issueId, sectionId })
    if (getRevisionComparison === undefined) {
      setReaderMode({ kind: 'compare-error', issueId, sectionId, message: '历史对比接口不可用。' })
      return
    }
    void Promise.all([getChapter(sectionId), getRevisionComparison(issueId)]).then(
      ([nextChapter, comparison]) => {
        if (version !== compareRequestVersion.current) return
        if (comparison.section_id !== sectionId) {
          setReaderMode({ kind: 'compare-error', issueId, sectionId, message: '历史对比记录与章节不一致。' })
          return
        }
        setChapter(nextChapter)
        setReaderMode({ kind: 'compare', comparison })
      },
      (reason: unknown) => {
        if (version !== compareRequestVersion.current) return
        const code = typeof reason === 'object' && reason !== null && 'code' in reason ? String(reason.code) : ''
        const message = code === 'BID_REVISION_COMPARISON_NOT_AVAILABLE'
          ? '该修复记录创建于历史对比快照功能启用前，无法还原完整修改前版本。'
          : reason instanceof Error ? reason.message : String(reason)
        setReaderMode({ kind: 'compare-error', issueId, sectionId, message })
      },
    )
  }

  useEffect(() => {
    notifyWorkbenchMount?.(true)
    return () => { notifyWorkbenchMount?.(false) }
  }, [notifyWorkbenchMount])

  useEffect(() => {
    if (!onLocateChapter) return
    return onLocateChapter((sectionId) => {
      select(sectionId)
    })
  }, [onLocateChapter])

  useEffect(() => {
    if (!onCompareRevision) return
    return onCompareRevision(({ issueId, sectionId }) => { openRevisionCompare(issueId, sectionId) })
  }, [onCompareRevision])

  const comparisonRows = useMemo(() => readerMode.kind === 'compare'
    ? buildRevisionDiffRows(readerMode.comparison.before_markdown, readerMode.comparison.after_markdown)
    : [], [readerMode])

  const targetSectionId = useStore(state => state.selectedSectionId)
  useEffect(() => {
    if (targetSectionId) {
      select(targetSectionId)
      actions.setSelectedSectionId(null)
    }
  }, [targetSectionId, actions])

  const needsAttention = workbench?.summary.needs_attention_count ?? 0
  const documentPages = getDocumentPageInfo(
    workbench?.summary.page_estimate,
    (workbench?.summary.content_count ?? 0) >= (workbench?.summary.chapter_count ?? 1),
  )
  const targetInfo = pageTargetInfo(workbench?.summary.page_target, workbench?.summary.page_estimate)
  const progressStats = resolveS5Progress(workbench)
  const batchInfo = getRevisionBatchInfo(workbench?.revision_batch)

  const exportWord = (): void => {
    if (!exportReady || exporting || openWordExport === undefined) return
    setExporting(true)
    setError(null)
    void openWordExport().then(
      () => {},
      (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { setExporting(false) })
  }

  const openParagraphReview = (reference: BidRevisionReference): void => {
    setReviewModal({ kind: 'paragraphs', reference })
    setReviewInstruction('')
    setReviewError(null)
    setContextMenu(null)
    window.getSelection()?.removeAllRanges()
  }

  const openChapterReview = (target: { sectionId: string; baseContentSha256: string; title: string; number: string }): void => {
    setReviewModal({ kind: 'chapter', ...target })
    setReviewInstruction('')
    setReviewError(null)
    setContextMenu(null)
  }

  const closeReviewModal = (): void => {
    if (reviewSaving) return
    setReviewModal(null)
    setReviewError(null)
  }

  const submitReviewIssue = (): void => {
    if (reviewModal === null || addRevisionIssue === undefined || reviewSaving) return
    const instruction = reviewInstruction.trim()
    if (instruction === '') { setReviewError('请填写修改意见。'); return }
    const request: BidAddRevisionIssueRequest = reviewModal.kind === 'paragraphs'
      ? (() => {
        const ref = reviewModal.reference.reference
        if (ref.scope !== 'paragraphs') throw new Error('引用范围不匹配。')
        return {
          section_id: ref.section_id,
          scope: 'paragraphs' as const,
          reference: {
            scope: 'paragraphs' as const,
            base_content_sha256: ref.content_sha256,
            start: ref.start,
            end: ref.end,
            text: ref.text,
          },
          instruction,
          suggestion: null,
        }
      })()
      : {
        section_id: reviewModal.sectionId,
        scope: 'chapter' as const,
        reference: { scope: 'chapter' as const, base_content_sha256: reviewModal.baseContentSha256 },
        instruction,
        suggestion: null,
      }
    setReviewSaving(true)
    setReviewError(null)
    void addRevisionIssue(request).then(
      () => {
        setReviewSaving(false)
        setReviewModal(null)
        setReviewError(null)
        actions.notifyRevisionQueueChanged()
      },
      (reason: unknown) => {
        setReviewSaving(false)
        const code = (reason as { code?: string } | null)?.code
        if (code === 'BID_CHAPTER_REVISION_CONFLICT') setReviewError('正文已变化，请重新选择内容。')
        else if (code === 'BID_REVISION_QUEUE_CONFLICT') {
          actions.notifyRevisionQueueChanged()
          setReviewError('队列已更新，请重试。')
        }
        else if (code === 'BID_CHAPTER_REVISION_SELECTION_INVALID') setReviewError('请选择完整段落。')
        else setReviewError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  return (
    <section className={css.root} data-conversation-composer-overlay="">
      <header className={css.header}>
        <div className={css.headerLeft}>
          <span className={css.headerTitle}>技术标章节写作与审稿</span>
          <div className={css.headerStats}>
            <div className={classes(css.s5Progress, progressStats.warning && css.s5ProgressWarning)} title={progressStats.title}>
              <span className={css.s5ProgressLabel}>{progressStats.label}</span>
              <BidProgressBar
                ariaLabel={progressStats.title}
                value={progressStats.value}
                max={progressStats.total}
                warning={progressStats.warning}
              />
            </div>
            <Pill className={css.statPill}>
              已审核 {workbench?.summary.reviewed_count ?? 0}
            </Pill>
            <Pill className={classes(css.statPill, needsAttention > 0 && css.statPillWarning)}>
              需关注 {needsAttention}
            </Pill>
            <Pill className={css.statPill} title={documentPages.title}>
              {documentPages.label}
            </Pill>
            <Pill className={classes(css.statPill, targetInfo.warning && css.statPillWarning)}>
              <span title={targetInfo.title}>{targetInfo.label}</span>
            </Pill>
            {batchInfo !== null && (
              <Pill
                className={classes(css.statPill, css.revisionBatchPill, batchInfo.warning && css.statPillWarning)}
                title={batchInfo.title}
              >
                {batchInfo.label}
              </Pill>
            )}
            {workbench !== null && (
              <Pill
                className={classes(
                  css.statPill,
                  css.compliancePill,
                  workbench.global_compliance.document_issues.length > 0 && css.compliancePillWarning,
                )}
                onClick={() => { setComplianceModalOpen(true) }}
                title="点击查看文档级合规检查详情"
              >
                <span>文档级合规检查</span>
                {workbench.global_compliance.document_issues.length > 0 && (
                  <span className={css.complianceBadge}>
                    {workbench.global_compliance.document_issues.length}
                  </span>
                )}
              </Pill>
            )}
          </div>
        </div>
        <div className={css.headerStats}>
          <Button variant="primary" size="sm" disabled={!exportReady || exporting || openWordExport === undefined} onClick={exportWord}>
            {exporting ? '正在打开…' : '导出 Word'}
          </Button>
          <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void refresh() }}>
            刷新
          </Button>
        </div>
      </header>

      {error !== null && <div className={css.error}>{error}</div>}
      {projection.runtime.status === 'pending' && <p>等待开始章节写作。</p>}

      {workbench !== null && (
        <Modal
          open={complianceModalOpen}
          onClose={() => { setComplianceModalOpen(false) }}
          title="文档级合规核验"
          closeLabel="关闭"
          className={css.complianceModal ?? ''}
          contentClassName={css.complianceModalContent ?? ''}
        >
          <div className={css.complianceModalBody}>
            {(() => {
              const allIssues = [
                ...workbench.global_compliance.document_issues.map(issue => ({ ...issue, kind: 'document' as const })),
                ...workbench.global_compliance.delivery_todos.map(todo => ({ ...todo, kind: 'delivery' as const })),
              ]
              if (allIssues.length === 0) {
                return (
                  <div className={css.complianceEmpty}>
                    暂无文档级合规问题
                  </div>
                )
              }
              return (
                <div className={css.tableWrapper}>
                  <table className={css.complianceTable}>
                    <thead>
                      <tr>
                        <th style={{ width: '120px' }}>编号</th>
                        <th style={{ width: '90px' }}>状态</th>
                        <th>问题详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allIssues.map(issue => (
                        <tr key={issue.compliance_id}>
                          <td className={css.tableCellCode}>{issue.compliance_id}</td>
                          <td>
                            <span className={classes(
                              css.cellTag,
                              issue.status === 'fail' ? css.cellTagError
                                : issue.kind === 'delivery' ? css.cellTagInfo
                                  : css.cellTagPending,
                            )}>
                              {issue.kind === 'delivery' ? '待确认'
                                : issue.status === 'pending' ? '待核验' : '高风险'}
                            </span>
                          </td>
                          <td className={css.tableCellDetail}>
                            <div className={css.detailText}>{issue.detail}</div>
                            {issue.affected_section_ids.length > 0 && (
                              <div className={css.affectedSections}>
                                受影响章节：{issue.affected_section_ids.join('、')}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>
        </Modal>
      )}

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
              const dotInfo = getChapterDotInfo(section)

              return (
                <div
                  key={section.section_id}
                  className={classes(css.treeRow, isSelected && css.activeRow)}
                  style={{ paddingInlineStart: `${4 + depth * 14}px` }}
                  onContextMenu={(event) => {
                    if (!section.writable || !section.content_available || addRevisionIssue === undefined) return
                    event.preventDefault()
                    const clientX = event.clientX
                    const clientY = event.clientY
                    const menuWidth = 160
                    const menuHeight = 50
                    const padding = 8
                    void getChapter(section.section_id).then((freshChapter) => {
                      if (!freshChapter.writable || freshChapter.content_sha256 === null) return
                      setContextMenu({
                        x: Math.max(padding, Math.min(clientX, window.innerWidth - menuWidth - padding)),
                        y: Math.max(padding, Math.min(clientY, window.innerHeight - menuHeight - padding)),
                        target: {
                          kind: 'chapter',
                          sectionId: freshChapter.section_id,
                          title: freshChapter.title,
                          number: freshChapter.number,
                          baseContentSha256: freshChapter.content_sha256,
                        },
                      })
                    })
                  }}
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
                    disabled={!isChapterSelectable(section)}
                    title={title}
                    draggable={section.content_available && section.writable}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(CHAPTER_DRAG_TYPE, JSON.stringify({ sessionId, sectionId: section.section_id }))
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => { select(section.section_id) }}
                  >
                    <span className={css.sectionTitle}>{title}</span>
                    {hasChildren ? (() => {
                      const page = getSectionPageInfo(section.page_estimate)
                      return <span className={css.pageEstimate} title={page.title} aria-hidden="true">{page.label}</span>
                    })() : (
                      <span className={css.statusDotContainer} title={`${title}：${dotInfo.title}`}>
                        {dotInfo.label === undefined
                          ? <span className={dotInfo.className} />
                          : <span className={css.overviewIndicator}>{dotInfo.label}</span>}
                        {section.revision !== undefined && (
                          <span className={css.revisionBadge} title={getRevisionTaskTitle(section.revision)}>
                            修
                          </span>
                        )}
                      </span>
                    )}
                    {hasChildren && section.revision !== undefined && (
                      <span className={css.revisionBadge} title={getRevisionTaskTitle(section.revision)}>
                        修
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div className={css.reader} role="main" aria-label="正文阅读">
          {readerMode.kind !== 'normal' ? (
            <section className={css.compareSurface} aria-label="本次修改对比">
              <header className={css.compareToolbar}>
                <div>
                  <h1 className={css.compareTitle}>本次修改对比</h1>
                  <p className={css.breadcrumbs}>章节：{readerMode.kind === 'compare' ? readerMode.comparison.section_title : chapter?.title ?? readerMode.sectionId}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const sectionId = readerMode.kind === 'compare' ? readerMode.comparison.section_id : readerMode.sectionId
                    select(sectionId)
                  }}
                >
                  返回正文
                </Button>
              </header>
              {readerMode.kind === 'compare-loading' ? (
                <p className={css.compareNotice} role="status">正在读取历史对比…</p>
              ) : readerMode.kind === 'compare-error' ? (
                <p className={css.compareNotice} role="alert">{readerMode.message}</p>
              ) : (
                <>
                  <div className={css.compareColumnHeaders} aria-hidden="true">
                    <strong>修改后</strong>
                    <strong>修改前</strong>
                  </div>
                  <div className={css.diffRows}>
                    {comparisonRows.map(row => (
                      <div className={css.diffRow} data-kind={row.kind} key={row.id}>
                        <div className={classes(
                          css.diffCell,
                          row.after === null ? css.diffCellPlaceholder
                            : row.kind === 'insert' ? css.diffCellInsert
                              : row.kind === 'modify' ? css.diffCellModify : css.diffCellEqual,
                        )}>
                          {row.after !== null && <MarkdownText text={row.after} />}
                        </div>
                        <div className={classes(
                          css.diffCell,
                          row.before === null ? css.diffCellPlaceholder
                            : row.kind === 'delete' ? css.diffCellDelete
                              : row.kind === 'modify' ? css.diffCellModify : css.diffCellEqual,
                        )}>
                          {row.before !== null && <MarkdownText text={row.before} />}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          ) : chapter?.markdown == null ? (
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
                <div
                  className={titleRowClass(chapter.number)}
                  onContextMenu={(event) => {
                    if (!chapter.writable || chapter.content_sha256 === null || addRevisionIssue === undefined) return
                    event.preventDefault()
                    const menuWidth = 160
                    const menuHeight = 50
                    const padding = 8
                    setContextMenu({
                      x: Math.max(padding, Math.min(event.clientX, window.innerWidth - menuWidth - padding)),
                      y: Math.max(padding, Math.min(event.clientY, window.innerHeight - menuHeight - padding)),
                      target: {
                        kind: 'chapter',
                        sectionId: chapter.section_id,
                        title: chapter.title,
                        number: chapter.number,
                        baseContentSha256: chapter.content_sha256,
                      },
                    })
                  }}
                >
                  {chapter.number && <span className={css.chapterNumber}>{chapter.number}</span>}
                  <h1 className={css.articleTitle}>{chapter.title}</h1>
                </div>
              </header>
              <div className={css.articleBody} ref={articleBody}
                onContextMenu={(event) => {
                  const targetNode = event.target instanceof Node ? event.target : null
                  const reference = selectedParagraphReference(event.currentTarget, window.getSelection(), chapter, targetNode)
                  if (reference === null || !chapter.writable) return
                  event.preventDefault()
                  const menuWidth = 160
                  const menuHeight = 88
                  const padding = 8
                  setContextMenu({
                    x: Math.max(padding, Math.min(event.clientX, window.innerWidth - menuWidth - padding)),
                    y: Math.max(padding, Math.min(event.clientY, window.innerHeight - menuHeight - padding)),
                    target: {
                      kind: 'paragraphs',
                      reference,
                    },
                  })
                }}
              >
                <AnchoredFlowcharts chapter={chapter} />
              </div>
            </article>
          )}
        </div>

        <div className={css.review} role="complementary" aria-label="章节审核与参考资料">
          <div className={css.reviewHeader}>
            <h2>章节审核</h2>
            {chapter !== null && (
              <span className={classes(css.miniTag, getReviewStatusInfo(chapter.review).className)}>
                {getReviewStatusInfo(chapter.review).label}
              </span>
            )}
          </div>

          {chapter === null ? (
            <div className={css.emptyState}>
              <p className={css.emptyStateTitle}>请选择章节查看审核结果、参考资料与依据。</p>
            </div>
          ) : !chapter.writable ? (
            <div className={css.card}>
              <p className={css.fieldLabel}>本章概述下属章节的主要内容。请选择子章节查看具体方案、参考资料与依据。</p>
            </div>
          ) : (
            <>
              <section className={css.reviewSection} aria-label="章节审核详情">
                <div className={css.fieldRow}>
                  <span className={css.fieldLabel}>审核状态</span>
                  <span className={css.fieldValue}>{getReviewStatusInfo(chapter.review).label}</span>
                </div>
                <div className={css.fieldRow}>
                  <span className={css.fieldLabel}>问题数量</span>
                  <span className={css.fieldValue}>{chapter.review.issues.length} 个</span>
                </div>
                {chapter.review.issues.length > 0 ? (
                  <ul className={classes(css.issuesList, css.reviewIssuesList)} aria-label={`审核问题列表，共 ${String(chapter.review.issues.length)} 个问题`}>
                    {chapter.review.issues.map(issue => (
                      <li key={issue.issue_id}>
                        <details className={css.issueCard} data-severity={issue.severity}>
                          <summary className={css.issueHeader}>
                            <span className={css.issueTitle}>{issue.title}</span>
                            <span className={css.miniTag}>{getSeverityLabel(issue.severity)}</span>
                          </summary>
                          <div className={css.issueBody}>
                            <p className={css.issueDetail}>问题详情：{issue.detail}</p>
                            <p className={css.issueDetail}>严重程度：{getSeverityLabel(issue.severity)}</p>
                            {issue.suggestion !== undefined && <p className={css.issueSuggestion}>修改建议：{issue.suggestion}</p>}
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : chapter.review.status === 'failed' || chapter.review.status === 'needs_attention' ? (
                  <div className={css.card}>
                    <span className={css.fieldLabel}>未取得具体原因。请重新加载章节状态；该操作只读取当前已保存的结果。</span>
                    <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 />} onClick={() => { void refresh() }}>重新加载</Button>
                  </div>
                ) : (
                  <div className={css.card}>
                    <span className={css.fieldLabel}>{getReviewEmptyMessage(chapter.review.status)}</span>
                  </div>
                )}
              </section>

              <section className={css.reviewSection}>
                <div className={css.reviewHeader}>
                  <h2>参考资料</h2>
                  {chapter.materials && chapter.materials.length > 0 && <span className={css.miniTag}>{chapter.materials.length} 篇参考</span>}
                </div>
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

      {contextMenu !== null && <div
        ref={menuRef} role="menu" aria-label={contextMenu.target.kind === 'paragraphs' ? '选中段落操作' : '章节操作'} className={css.selectionMenu}
        style={{ left: Math.max(0, contextMenu.x), top: Math.max(0, contextMenu.y) }}
      >
        {contextMenu.target.kind === 'paragraphs' && (
          <button type="button" role="menuitem" onClick={() => {
            if (contextMenu.target.kind === 'paragraphs') {
              actions.setReference(contextMenu.target.reference)
            }
            setContextMenu(null)
            window.getSelection()?.removeAllRanges()
          }}>添加到对话框</button>
        )}
        {addRevisionIssue !== undefined && (
          <button type="button" role="menuitem" onClick={() => {
            const target = contextMenu.target
            setContextMenu(null)
            if (target.kind === 'paragraphs') {
              openParagraphReview(target.reference)
            } else {
              openChapterReview(target)
            }
          }}>
            添加审批意见
          </button>
        )}
      </div>}
      {reviewModal !== null && (
        <Modal
          open
          onClose={closeReviewModal}
          title="添加审批意见"
          closeLabel="关闭"
          className={css.reviewModal ?? ''}
          contentClassName={css.reviewModalContent ?? ''}
          footer={
            <>
              <Button variant="ghost" size="sm" disabled={reviewSaving} onClick={closeReviewModal}>取消</Button>
              <Button variant="primary" size="sm" disabled={reviewSaving} onClick={submitReviewIssue}>
                {reviewSaving ? '正在保存…' : '添加到待处理意见'}
              </Button>
            </>
          }
        >
          <div className={css.reviewModalBody}>
            <div className={css.reviewReference}>
              <span className={css.reviewReferenceLabel}>
                {reviewModal.kind === 'chapter'
                  ? `${reviewModal.number} ${reviewModal.title} · 整个章节`
                  : reviewModal.reference.label}
              </span>
              {reviewModal.kind === 'paragraphs' && (
                <pre className={css.reviewReferencePreview}>{reviewModal.reference.preview}</pre>
              )}
            </div>
            <div className={css.reviewField}>
              <label className={css.reviewFieldLabel} htmlFor="review-instruction">修改意见 <span className={css.reviewRequired}>*</span></label>
              <textarea
                id="review-instruction"
                className={css.reviewTextarea}
                value={reviewInstruction}
                disabled={reviewSaving}
                onChange={(event) => { setReviewInstruction(event.target.value); setReviewError(null) }}
                placeholder="例如：这里结构太散，改成分步骤描述。"
                rows={3}
              />
            </div>
            {reviewError !== null && <p role="alert" className={css.reviewError}>{reviewError}</p>}
          </div>
        </Modal>
      )}

    </section>
  )
}



function AnchoredFlowcharts({ chapter }: { chapter: BidReviewChapterView }): JSX.Element {
  const source = chapter.markdown ?? ''
  const heading = source.match(/^# [^\n]*(?:\n|$)\s*/u)?.[0] ?? ''
  const markdown = source.slice(heading.length)
  const flowcharts = chapter.flowcharts ?? []
  const byKey = new Map(flowcharts.map(flowchart => [flowchart.key ?? flowchart.id, flowchart]))
  const parts: JSX.Element[] = []
  let cursor = 0
  let index = 0
  for (const match of markdown.matchAll(/\{\{flowchart:([A-Za-z0-9_-]{1,64})\}\}/gu)) {
    const start = match.index
    if (start > cursor) parts.push(<MarkdownText key={`text-${index++}`} text={markdown.slice(cursor, start)} paragraphSourceOffset={heading.length + cursor} />)
    const flowchart = byKey.get(match[1] ?? '')
    if (flowchart === undefined) parts.push(<MarkdownText key={`unknown-${index++}`} text={match[0]} paragraphSourceOffset={heading.length + start} />)
    else parts.push(<FlowchartPreview key={flowchart.id} spec={flowchart} />)
    cursor = start + match[0].length
  }
  if (cursor < markdown.length) parts.push(<MarkdownText key={`text-${index}`} text={markdown.slice(cursor)} paragraphSourceOffset={heading.length + cursor} />)
  if (parts.length === 0) {
    return <Fragment>
      <MarkdownText text={markdown} paragraphSourceOffset={heading.length} />
      {flowcharts.map(flowchart => <FlowchartPreview key={flowchart.id} spec={flowchart} />)}
    </Fragment>
  }
  return <Fragment>{parts}</Fragment>
}

function FlowchartPreview({ spec }: { spec: FlowchartSpec }): JSX.Element {
  try {
    const rendered = renderFlowchartSvg(spec)
    return <figure className={css.flowchart} aria-label={spec.title}>
      <figcaption>{spec.title}</figcaption>
      <div className={css.flowchartCanvas} dangerouslySetInnerHTML={{ __html: rendered.svg }} />
    </figure>
  } catch (error: unknown) {
    return <p role="alert" className={css.flowchartError}>流程图暂时无法渲染：{error instanceof Error ? error.message : String(error)}</p>
  }
}


function titleRowClass(_num?: string): string {
  return css.titleRow ?? ''
}

function getChapterDotInfo(
  section: BidReviewWorkbenchView['outline'][number],
): { className: string; label?: string; title: string } {
  if (!section.writable) return {
    className: '',
    label: section.content_available ? '概述' : '待补充',
    title: section.content_available ? '章节概述' : '概述待补充',
  }
  const { status, tooltip } = section.chapter_indicator
  switch (status) {
    case 'queued': return { className: classes(css.statusDot, css.statusDotQueued, css.statusDotWeakPulsing), title: tooltip }
    case 'writing': return { className: classes(css.statusDot, css.statusDotBlue, css.statusDotPulsing), title: tooltip }
    case 'repairing': return { className: classes(css.statusDot, css.statusDotBlue, css.statusDotPulsing), title: tooltip }
    case 'content_ready': return { className: classes(css.statusDot, css.statusDotBlue), title: tooltip }
    case 'reviewing': return { className: classes(css.statusDot, css.statusDotYellow, css.statusDotPulsing), title: tooltip }
    case 'needs_input': return { className: classes(css.statusDot, css.statusDotYellow), title: tooltip }
    case 'needs_attention': return { className: classes(css.statusDot, css.statusDotOrange), title: tooltip }
    case 'passed': return { className: classes(css.statusDot, css.statusDotGreen), title: tooltip }
    case 'failed': return { className: classes(css.statusDot, css.statusDotRed), title: tooltip }
    case 'not_started': return { className: classes(css.statusDot, css.statusDotGray), title: tooltip }
  }
}

function isChapterSelectable(section: BidReviewWorkbenchView['outline'][number]): boolean {
  return section.content_available || section.writing_status === 'failed' || section.review_status === 'failed'
    || section.review_status === 'needs_input' || section.review_status === 'needs_attention'
}

function getReviewStatusInfo(review: BidReviewChapterView['review']): { label: string; className: string | undefined } {
  switch (review.status) {
    case 'pass': return { label: '审核通过', className: css.miniTagSuccess }
    case 'needs_input': return { label: '待补项目资料', className: css.miniTagWarning }
    case 'needs_attention': return { label: '正文需要修复', className: css.miniTagWarning }
    case 'failed': return { label: '审核执行失败', className: css.miniTagError }
    case 'reviewing': return { label: '审核中', className: css.miniTagWriting }
    case 'not_started': return { label: '等待审核', className: undefined }
  }
}

function getReviewEmptyMessage(status: BidReviewChapterView['review']['status']): string {
  switch (status) {
    case 'pass': return '本次已保存的审核报告未列出问题。'
    case 'needs_input': return '审核发现需要补充项目资料，正文无需重新编写。'
    case 'needs_attention': return '审核标记为正文需要修复，但未取得具体原因。请重新加载章节状态。'
    case 'reviewing': return '审核尚在进行中，暂未产生已保存的审核结果。'
    case 'not_started': return '等待正文和审核结果；当前没有已保存的审核报告。'
    case 'failed': return '未取得具体原因。'
  }
}

function getSeverityLabel(severity: BidReviewChapterView['review']['issues'][number]['severity']): string {
  if (severity === 'high') return '高风险'
  if (severity === 'medium') return '中风险'
  return '低风险'
}

function pageEstimateBasis(estimate: BidReviewWorkbenchView['summary']['page_estimate'] | undefined): string {
  const basis = estimate?.status === 'unavailable' ? estimate.basis : estimate
  if (basis === undefined) return '页数基准与统计方式暂不可用'
  const template = basis.template?.name ?? '系统默认格式'
  const method = basis.method === 'rendered'
    ? 'LibreOffice 渲染分页，结果更接近当前导出文件'
    : '快速排版估算，实际分页以 Word 为准'
  return `页数基准：${template}；统计方式：${method}`
}

function getSectionPageInfo(estimate: BidReviewWorkbenchView['outline'][number]['page_estimate']): { label: string; title: string } {
  if (estimate?.status === 'available') return {
    label: `约 ${estimate.pages} 页`,
    title: `${pageEstimateBasis(estimate)}${estimate.incomplete ? '；仅统计已生成内容' : ''}`,
  }
  if (estimate?.status === 'empty') return { label: '—', title: `${pageEstimateBasis(estimate)}；正文尚未生成` }
  return { label: '暂不可用', title: pageEstimateBasis(estimate) }
}

function getDocumentPageInfo(
  estimate: BidReviewWorkbenchView['summary']['page_estimate'] | undefined,
  complete: boolean,
): { label: string; title: string } {
  if (estimate?.status === 'available') return {
    label: estimate.method === 'rendered'
      ? `${complete ? '' : '已生成正文'}预计导出 ${estimate.pages} 页`
      : `${complete ? '正文共' : '已生成正文'}约 ${estimate.pages} 页`,
    title: pageEstimateBasis(estimate),
  }
  if (estimate?.status === 'empty') return { label: '正文尚未生成', title: `${pageEstimateBasis(estimate)}；正文尚未生成` }
  return { label: '页数暂不可用', title: pageEstimateBasis(estimate) }
}
const REVISION_TASK_STATUS_LABEL: Record<BidRevisionTaskStatus, string> = {
  queued: '排队中',
  running: '修订中',
  reviewing: '审核中',
  repairing: '修复中',
  completed: '修订完成',
  conflict: '正文冲突',
  failed: '修订失败',
  needs_input: '待补资料',
  blocked: '依赖阻塞',
}

function getRevisionTaskTitle(revision: NonNullable<BidReviewWorkbenchView['outline'][number]['revision']>): string {
  if (revision.status === 'conflict') {
    return '正文在审批意见创建后已发生变化，请重新选择该条内容。'
  }
  return `批量修订：${REVISION_TASK_STATUS_LABEL[revision.status]}（${revision.issue_count} 条意见）`
}

interface S5ProgressStats {
  readonly label: string
  readonly value: number
  readonly total: number
  readonly warning: boolean
  readonly title: string
}

function resolveS5Progress(workbench: BidReviewWorkbenchView | null): S5ProgressStats {
  const batch = workbench?.revision_batch
  if (batch !== undefined) {
    const processed = batch.completed + batch.needs_input + batch.failed + batch.conflict
    const total = batch.total_issues
    return {
      label: `修订进度 ${processed}/${total}`,
      value: processed,
      total,
      title: `批量修订进度：${processed}/${total} 条审批意见已处理`,
      warning: batch.status === 'failed' || batch.failed > 0 || batch.conflict > 0 || batch.status === 'suspended',
    }
  }
  const completed = workbench?.summary.content_count ?? 0
  const total = workbench?.summary.chapter_count ?? 0
  return {
    label: `正文 ${completed}/${total}`,
    value: completed,
    total,
    warning: false,
    title: `S5 正文进度：${completed}/${total} 章已生成`,
  }
}

function getRevisionBatchInfo(
  batch: BidReviewWorkbenchView['revision_batch'] | undefined,
): { label: string; title: string; warning: boolean } | null {
  if (batch === undefined) return null
  const statusLabel: Record<typeof batch.status, string> = {
    planning: '规划中',
    running: '执行中',
    suspended: '已暂停',
    completed: '已完成',
    failed: '已失败',
  }
  const parts: string[] = []
  if (batch.running > 0) parts.push(`进行中 ${batch.running}`)
  if (batch.pending > 0) parts.push(`待处理 ${batch.pending}`)
  if (batch.needs_input > 0) parts.push(`待补资料 ${batch.needs_input}`)
  if (batch.conflict > 0) parts.push(`正文冲突 ${batch.conflict}`)
  if (batch.failed > 0) parts.push(`失败 ${batch.failed}`)
  const activeCount = [batch.running, batch.pending, batch.needs_input, batch.failed, batch.conflict].filter(n => n > 0).length
  const summaryText = parts.length > 0 ? parts.join(' · ') : '全部完成'
  return {
    label: `批量修订 ${statusLabel[batch.status]}${parts.length > 0 ? ` · ${summaryText}` : ''}`,
    title: `批量修订 ${statusLabel[batch.status]}；完成 ${batch.completed}；${parts.join('；')}${activeCount > 0 ? '' : '，全部完成'}`,
    warning: batch.status === 'failed' || batch.failed > 0 || batch.conflict > 0 || batch.status === 'suspended',
  }
}
