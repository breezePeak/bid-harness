import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  BidDeleteRevisionIssueRequest,
  BidRevisionIssueView,
  BidRevisionQueueView,
  BidUpdateRevisionIssueRequest,
} from '@deepseek-ai/dsh-bid/control-plane'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  Modal,
  Portal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidRevisionFloatingPanel.module.css'

function classes(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ')
}

export interface BidRevisionFloatingPanelProps {
  readonly sessionId?: string | undefined
  readonly getRevisionQueue: () => Promise<BidRevisionQueueView>
  readonly revisionQueue?: BidRevisionQueueView | null | undefined
  readonly updateRevisionIssue?: ((request: BidUpdateRevisionIssueRequest) => Promise<BidRevisionQueueView>) | undefined
  readonly deleteRevisionIssue?: ((request: BidDeleteRevisionIssueRequest) => Promise<BidRevisionQueueView>) | undefined
  readonly startRevisionBatch?: (() => Promise<void>) | undefined
  readonly onLocate?: ((sectionId: string) => void) | undefined
  readonly onCompare?: ((issueId: string, sectionId: string) => void) | undefined
  readonly isRunning?: boolean | undefined
  readonly refreshSignal?: number | undefined
  readonly onQueueChanged?: ((queue?: BidRevisionQueueView) => void) | undefined
  readonly floatingMode?: 'fixed' | 'absolute' | undefined
  readonly className?: string | undefined
}

export function BidRevisionFloatingPanel({
  getRevisionQueue,
  revisionQueue: externalRevisionQueue,
  updateRevisionIssue,
  deleteRevisionIssue,
  startRevisionBatch,
  onLocate,
  onCompare,
  isRunning = false,
  refreshSignal = 0,
  onQueueChanged,
  floatingMode = 'fixed',
  className,
}: BidRevisionFloatingPanelProps): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)
  const [revisionQueue, setRevisionQueue] = useState<BidRevisionQueueView | null>(externalRevisionQueue ?? null)
  const [revisionQueueError, setRevisionQueueError] = useState<string | null>(null)
  const [repairStarting, setRepairStarting] = useState(false)
  const [editingIssue, setEditingIssue] = useState<BidRevisionIssueView | null>(null)
  const [editInstruction, setEditInstruction] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [deletingIssue, setDeletingIssue] = useState<BidRevisionIssueView | null>(null)

  const latestRevisionQueueRef = useRef<BidRevisionQueueView | null>(revisionQueue)
  latestRevisionQueueRef.current = revisionQueue

  useEffect(() => {
    if (externalRevisionQueue !== undefined) {
      setRevisionQueue(externalRevisionQueue)
      latestRevisionQueueRef.current = externalRevisionQueue
    }
  }, [externalRevisionQueue])

  const refreshRevisionQueue = useCallback(async (): Promise<void> => {
    try {
      const next = await getRevisionQueue()
      latestRevisionQueueRef.current = next
      setRevisionQueue(next)
      setRevisionQueueError(null)
    } catch (reason: unknown) {
      setRevisionQueueError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [getRevisionQueue])

  useEffect(() => {
    void refreshRevisionQueue()
  }, [refreshRevisionQueue, refreshSignal])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = (): void => {
      void refreshRevisionQueue().then(() => {
        const queueRunning = latestRevisionQueueRef.current?.issues?.some(
          issue => issue.status === 'scheduled' || issue.status === 'running',
        ) ?? false
        if (!disposed && (isRunning || queueRunning)) {
          timer = window.setTimeout(poll, 1000)
        }
      })
    }
    poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [isRunning, refreshRevisionQueue])

  const revisionIssues = revisionQueue?.issues ?? []
  const activeRevisionIssues = revisionIssues.filter(
    issue => issue.status === 'pending' || issue.status === 'scheduled' || issue.status === 'running',
  )
  const revisionHistory = revisionIssues.filter(
    issue => issue.status === 'completed' || issue.status === 'needs_input' || issue.status === 'conflict' || issue.status === 'failed',
  )
  const pendingRevisionCount = activeRevisionIssues.filter(issue => issue.status === 'pending').length
  const revisionRunning = activeRevisionIssues.some(issue => issue.status === 'scheduled' || issue.status === 'running')
  const queueProgress = resolveRevisionQueueProgress(revisionQueue)

  const startAllRepairs = (): void => {
    if (startRevisionBatch === undefined || repairStarting) return
    setRepairStarting(true)
    setRevisionQueueError(null)
    void startRevisionBatch()
      .then(() => { void refreshRevisionQueue() })
      .catch((reason: unknown) => {
        setRevisionQueueError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setRepairStarting(false) })
  }

  const startEdit = (issue: BidRevisionIssueView): void => {
    setEditingIssue(issue)
    setEditInstruction(issue.instruction)
    setEditError(null)
  }

  const closeEditModal = (): void => {
    if (editSaving) return
    setEditingIssue(null)
    setEditError(null)
  }

  const submitEdit = (): void => {
    if (editingIssue === null || updateRevisionIssue === undefined || revisionQueue === null || editSaving) return
    const instruction = editInstruction.trim()
    if (instruction === '') { setEditError('请填写修改意见。'); return }
    setEditSaving(true)
    setEditError(null)
    void updateRevisionIssue({
      issue_id: editingIssue.issue_id,
      expected_queue_revision: revisionQueue.revision,
      instruction,
    }).then(
      (next) => {
        setEditSaving(false)
        setEditingIssue(null)
        latestRevisionQueueRef.current = next
        setRevisionQueue(next)
        onQueueChanged?.(next)
      },
      (reason: unknown) => {
        setEditSaving(false)
        const code = (reason as { code?: string } | null)?.code
        if (code === 'BID_REVISION_QUEUE_CONFLICT') {
          void refreshRevisionQueue()
          setEditError('队列已更新，请重试。')
        } else if (code === 'BID_REVISION_ISSUE_NOT_EDITABLE') {
          setEditError('该意见已开始处理，无法编辑。')
        } else {
          setEditError(reason instanceof Error ? reason.message : String(reason))
        }
      },
    )
  }

  const confirmDelete = (): void => {
    if (deletingIssue === null || deleteRevisionIssue === undefined || revisionQueue === null) return
    const issue = deletingIssue
    setDeletingIssue(null)
    void deleteRevisionIssue({
      issue_id: issue.issue_id,
      expected_queue_revision: revisionQueue.revision,
    }).then(
      (next) => {
        latestRevisionQueueRef.current = next
        setRevisionQueue(next)
        onQueueChanged?.(next)
      },
      (reason: unknown) => {
        const code = (reason as { code?: string } | null)?.code
        if (code === 'BID_REVISION_QUEUE_CONFLICT') void refreshRevisionQueue()
        setRevisionQueueError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  const content = (
    <div
      className={classes(
        floatingMode === 'fixed' ? css.floatingContainer : css.floatingContainerAbsolute,
        className,
      )}
    >
      <div className={css.interactive}>
        <button
          type="button"
          className={css.toggleButton}
          aria-label={isOpen ? '折叠批量审核修改' : '展开批量审核修改'}
          aria-expanded={isOpen}
          aria-controls="bid-revision-panel"
          onClick={() => { setIsOpen(open => !open) }}
        >
          {isOpen ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
          {!isOpen && pendingRevisionCount > 0 && (
            <span className={css.badge} title={`有 ${pendingRevisionCount} 条待修复意见`}>
              {pendingRevisionCount > 99 ? '99+' : pendingRevisionCount}
            </span>
          )}
        </button>

        {isOpen && (
          <section id="bid-revision-panel" className={css.popover} aria-label="批量审核修改">
            <div className={css.header}>
              <h2>批量审核修改</h2>
              <Button
                variant="primary"
                size="sm"
                disabled={pendingRevisionCount === 0 || revisionRunning || repairStarting || startRevisionBatch === undefined}
                onClick={startAllRepairs}
              >
                {revisionRunning ? '修复中…' : repairStarting ? '正在启动…' : '一键修复'}
              </Button>
            </div>

            {queueProgress !== null && (
              <div className={css.progress} title={queueProgress.title}>
                <span>{queueProgress.label}</span>
                <progress aria-label={queueProgress.title} value={queueProgress.processed} max={queueProgress.total} />
              </div>
            )}

            {revisionQueueError !== null && <p role="alert" className={css.error}>{revisionQueueError}</p>}

            <div className={css.group}>
              <div className={css.groupHeader}>
                <h3>待修复与修复中</h3>
                <span>{activeRevisionIssues.length}</span>
              </div>
              {activeRevisionIssues.length === 0 ? (
                <p className={css.empty}>暂无待修复意见</p>
              ) : (
                <FloatingRevisionIssueTable
                  issues={activeRevisionIssues}
                  onLocate={onLocate}
                  updateRevisionIssue={updateRevisionIssue}
                  deleteRevisionIssue={deleteRevisionIssue}
                  startEdit={startEdit}
                  setDeletingIssue={setDeletingIssue}
                  ariaLabel={`待修复与修复中，共 ${String(activeRevisionIssues.length)} 条`}
                />
              )}
            </div>

            <div className={css.group}>
              <div className={css.groupHeader}>
                <h3>历史记录</h3>
                <span>{revisionHistory.length}</span>
              </div>
              {revisionHistory.length === 0 ? (
                <p className={css.empty}>暂无修复记录</p>
              ) : (
                <FloatingRevisionIssueTable
                  issues={revisionHistory}
                  onLocate={onLocate}
                  onCompare={onCompare}
                  ariaLabel={`历史记录，共 ${String(revisionHistory.length)} 条`}
                />
              )}
            </div>
          </section>
        )}
      </div>

      {editingIssue !== null && (
        <Modal
          open
          onClose={closeEditModal}
          title="编辑审核意见"
          closeLabel="关闭"
          footer={
            <>
              <Button variant="ghost" size="sm" disabled={editSaving} onClick={closeEditModal}>取消</Button>
              <Button variant="primary" size="sm" disabled={editSaving} onClick={submitEdit}>
                {editSaving ? '正在保存…' : '保存'}
              </Button>
            </>
          }
        >
          <div className={css.modalBody}>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="floating-edit-instruction">修改意见</label>
              <textarea
                id="floating-edit-instruction"
                className={css.textarea}
                value={editInstruction}
                disabled={editSaving}
                onChange={(event) => { setEditInstruction(event.target.value); setEditError(null) }}
                rows={3}
              />
            </div>
            {editError !== null && <p role="alert" className={css.error}>{editError}</p>}
          </div>
        </Modal>
      )}

      {deletingIssue !== null && (
        <Modal
          open
          onClose={() => { setDeletingIssue(null) }}
          title="确认删除"
          closeLabel="关闭"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => { setDeletingIssue(null) }}>取消</Button>
              <Button variant="primary" size="sm" onClick={confirmDelete}>删除</Button>
            </>
          }
        >
          <p>确定要删除这条待修复意见吗？</p>
        </Modal>
      )}
    </div>
  )

  if (floatingMode === 'fixed') {
    const container = typeof document !== 'undefined' ? document.body : null
    if (container === null) return null
    return <Portal container={container}>{content}</Portal>
  }

  return content
}

function cleanReferenceText(raw: string | undefined | null): string {
  if (!raw) return ''
  const cleaned = raw
    .replace(/^位置[：:]\s*/i, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length > 50) return cleaned.slice(0, 50) + '…'
  return cleaned
}

function resolveSectionTitle(issue: BidRevisionIssueView): string {
  if (issue.section_title && issue.section_title.trim() !== '') {
    return issue.section_title.trim()
  }
  if (issue.section_id && issue.section_id.trim() !== '') {
    return `章节 ${issue.section_id}`
  }
  return '当前章节'
}

function FloatingRevisionIssueTable({
  issues,
  onLocate,
  onCompare,
  updateRevisionIssue,
  deleteRevisionIssue,
  startEdit,
  setDeletingIssue,
  ariaLabel,
}: {
  readonly issues: readonly BidRevisionIssueView[]
  readonly onLocate?: ((sectionId: string) => void) | undefined
  readonly onCompare?: ((issueId: string, sectionId: string) => void) | undefined
  readonly updateRevisionIssue?: ((request: BidUpdateRevisionIssueRequest) => Promise<BidRevisionQueueView>) | undefined
  readonly deleteRevisionIssue?: ((request: BidDeleteRevisionIssueRequest) => Promise<BidRevisionQueueView>) | undefined
  readonly startEdit?: ((issue: BidRevisionIssueView) => void) | undefined
  readonly setDeletingIssue?: ((issue: BidRevisionIssueView) => void) | undefined
  readonly ariaLabel: string
}): JSX.Element {
  return (
    <div className={css.tableWrapper}>
      <table className={css.table} role="list" aria-label={ariaLabel}>
        <thead>
          <tr>
            <th style={{ width: '25%' }}>所属章节</th>
            <th style={{ width: '45%' }}>修改意见</th>
            <th style={{ width: '15%' }}>状态</th>
            <th style={{ width: '15%' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => {
            const canEdit = issue.status === 'pending' && updateRevisionIssue !== undefined && startEdit !== undefined
            const canDelete = issue.status === 'pending' && deleteRevisionIssue !== undefined && setDeletingIssue !== undefined
            const sectionTitle = resolveSectionTitle(issue)
            const quoteText = issue.scope === 'chapter'
              ? '整个章节'
              : issue.reference.scope === 'paragraphs'
                ? cleanReferenceText(issue.reference.text)
                : ''

            return (
              <Fragment key={issue.issue_id}>
                <tr
                  role="listitem"
                  data-status={issue.status}
                  className={quoteText !== '' ? css.rowWithDetail : undefined}
                >
                  <td>
                    <div className={css.locationCell}>
                      <button
                        type="button"
                        className={css.issueLocation}
                        onClick={() => { onLocate?.(issue.section_id) }}
                        title={`点击查看章节：${sectionTitle}`}
                      >
                        {sectionTitle}
                      </button>
                      <span className={css.issueIdHidden} aria-hidden="true" title={issue.issue_id}>
                        {issue.issue_id}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className={css.instructionCell}>
                      <div className={css.instructionText}>{issue.instruction}</div>
                      {issue.suggestion !== null && issue.suggestion.trim() !== '' && (
                        <div className={css.suggestionText}>说明：{issue.suggestion}</div>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={css.statusCell}>
                      <span className={css.issueStatus} data-status={issue.status}>
                        <span className={css.statusDot} />
                        {getFloatingRevisionIssueStatusLabel(issue.status)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className={css.actionsCell}>
                      <button
                        type="button"
                        className={css.btnAction}
                        onClick={() => {
                          if (issue.status === 'completed') onCompare?.(issue.issue_id, issue.section_id)
                          else onLocate?.(issue.section_id)
                        }}
                      >
                        {issue.status === 'completed' ? '对比查看' : '查看位置'}
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className={css.btnAction}
                          onClick={() => { startEdit(issue) }}
                        >
                          编辑
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          className={classes(css.btnAction, css.btnActionDanger)}
                          onClick={() => { setDeletingIssue(issue) }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {quoteText !== '' && (
                  <tr className={css.detailRow} data-status={issue.status}>
                    <td colSpan={4} className={css.detailCell}>
                      <div className={css.detailBar} title={quoteText}>
                        <span className={css.detailLabel}>详情：</span>
                        <span className={css.detailContent}>{quoteText}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function getFloatingRevisionIssueStatusLabel(status: BidRevisionIssueView['status']): string {
  switch (status) {
    case 'pending': return '待修复'
    case 'scheduled': return '已排队'
    case 'running': return '修复中'
    case 'completed': return '已修复'
    case 'needs_input': return '未修复 · 需补充'
    case 'conflict': return '未修复 · 内容冲突'
    case 'failed': return '未修复 · 失败'
  }
}

function resolveRevisionQueueProgress(queue: BidRevisionQueueView | null): {
  readonly processed: number
  readonly total: number
  readonly label: string
  readonly title: string
} | null {
  const active = queue?.issues?.find(issue => issue.status === 'scheduled' || issue.status === 'running')
  if (active?.batch_id === null || active?.batch_id === undefined) return null
  const issues = queue?.issues?.filter(issue => issue.batch_id === active.batch_id) ?? []
  const processed = issues.filter(
    issue => issue.status === 'completed' || issue.status === 'needs_input' || issue.status === 'conflict' || issue.status === 'failed',
  ).length
  return {
    processed,
    total: issues.length,
    label: `修复进度 ${String(processed)}/${String(issues.length)}`,
    title: `批量修复进度：${String(processed)}/${String(issues.length)} 条审核意见已处理`,
  }
}
