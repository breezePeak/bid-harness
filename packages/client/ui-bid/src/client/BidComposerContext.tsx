/** The Bid reference rail routes chapter feedback to the original writer through the Host action. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BidRevisionIssueView, BidRevisionQueueView, BidReviewChapterView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ComposerSubmitHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal, Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHAPTER_DRAG_TYPE, type createBidRevisionStore } from './revision-reference.ts'
import css from './BidComposerContext.module.css'
import { isBidMainSessionSummary } from './session-authority.ts'

/** Host actions and the conversation-owned submission registration. */
export interface BidComposerContextInjected {
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  sendMessage: (text: string, mode?: 'queue' | 'steer', signal?: AbortSignal, submissionId?: string) => Promise<void>
  registerSubmit: (handler: ComposerSubmitHandler) => () => void
  /** Read the current revision issue queue from the Host. */
  getRevisionQueue?: () => Promise<BidRevisionQueueView>
  /** Update a pending revision issue; Host rejects non-pending issues. */
  updateRevisionIssue?: (request: {
    issue_id: string
    expected_queue_revision: number
    instruction?: string
    suggestion?: string | null
  }) => Promise<BidRevisionQueueView>
  /** Delete a pending revision issue; Host rejects non-pending issues. */
  deleteRevisionIssue?: (request: {
    issue_id: string
    expected_queue_revision: number
  }) => Promise<BidRevisionQueueView>
}

export type BidComposerContextProps = PropsRuntime<'conversation.input.context'>
  & PropsStore<ReturnType<typeof createBidRevisionStore>> & BidComposerContextInjected

/**
 * Show one scoped reference without inserting source material into the user's draft.
 * @param props - Session state, reference store, and Host revision actions.
 * @returns The reference rail and chapter drag invitation for Bid writing sessions.
 */
export function BidComposerContext({
  sessionId, useSessions, useProjection, useStore, actions, disabled, getChapter, sendMessage, registerSubmit,
  getRevisionQueue, updateRevisionIssue, deleteRevisionIssue,
}: BidComposerContextProps) {
  const isBid = useSessions(state => isBidMainSessionSummary(state.byId[sessionId]))
  const projection = useProjection('bid.runtime')
  const reference = useStore(state => state.reference)
  const queueRevisionSignal = useStore(state => state.queueRevisionSignal)
  const enabled = isBid && (projection?.runtime.stage === 'docx_export'
    || projection?.runtime.stage === 'chapter_writing'
      && ['running', 'attention_required', 'completed'].includes(projection.runtime.status))
  const rootRef = useRef<HTMLDivElement>(null)
  const requestVersion = useRef(0)
  const [loading, setLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<BidRevisionQueueView | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [editingIssue, setEditingIssue] = useState<BidRevisionIssueView | null>(null)
  const [editInstruction, setEditInstruction] = useState('')
  const [editSuggestion, setEditSuggestion] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refreshQueue = useCallback(async (): Promise<void> => {
    if (getRevisionQueue === undefined) return
    try {
      const next = await getRevisionQueue()
      setQueue(next)
      setQueueError(null)
    } catch (reason: unknown) {
      setQueueError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [getRevisionQueue])

  useEffect(() => {
    if (!enabled) return
    void refreshQueue()
  }, [enabled, refreshQueue, queueRevisionSignal])

  const startEdit = (issue: BidRevisionIssueView): void => {
    setEditingIssue(issue)
    setEditInstruction(issue.instruction)
    setEditSuggestion(issue.suggestion ?? '')
    setEditError(null)
  }

  const closeEditModal = (): void => {
    if (editSaving) return
    setEditingIssue(null)
    setEditError(null)
  }

  const submitEdit = (): void => {
    if (editingIssue === null || updateRevisionIssue === undefined || queue === null || editSaving) return
    const instruction = editInstruction.trim()
    if (instruction === '') { setEditError('请填写修改意见。'); return }
    setEditSaving(true)
    setEditError(null)
    void updateRevisionIssue({
      issue_id: editingIssue.issue_id,
      expected_queue_revision: queue.revision,
      instruction,
      suggestion: editSuggestion.trim() === '' ? null : editSuggestion.trim(),
    }).then(
      (next) => {
        setEditSaving(false)
        setEditingIssue(null)
        setQueue(next)
      },
      (reason: unknown) => {
        setEditSaving(false)
        const code = (reason as { code?: string } | null)?.code
        if (code === 'BID_REVISION_QUEUE_CONFLICT') {
          void refreshQueue()
          setEditError('队列已更新，请重试。')
        }
        else if (code === 'BID_REVISION_ISSUE_NOT_EDITABLE') setEditError('该意见已开始处理，无法编辑。')
        else setEditError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  const confirmDelete = (): void => {
    if (deletingId === null || deleteRevisionIssue === undefined || queue === null) return
    const issueId = deletingId
    const expectedRevision = queue.revision
    setDeletingId(null)
    void deleteRevisionIssue({ issue_id: issueId, expected_queue_revision: expectedRevision }).then(
      (next) => { setQueue(next) },
      (reason: unknown) => {
        const code = (reason as { code?: string } | null)?.code
        if (code === 'BID_REVISION_QUEUE_CONFLICT') void refreshQueue()
        setQueueError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  useEffect(() => {
    if (!enabled) return
    return registerSubmit((text, imageIds, signal, mode = 'queue', submissionId) => {
      if (reference === null && !loading) return undefined
      if (loading) return Promise.resolve({ kind: 'error', text: '正在读取章节，请稍后发送。' })
      if (reference === null) return undefined
      if (imageIds.length > 0) return Promise.resolve({ kind: 'error', text: '章节修改暂不支持图片附件，请先移除图片。' })
      if (text.trim() === '') return Promise.resolve({ kind: 'error', text: '请填写针对所选章节或段落的修改意见。' })
      const context = JSON.stringify({ kind: 'bid_chapter_reference', reference: reference.reference })
      return sendMessage(
        `${text}\n\n引用上下文（只作为用户所指正文的结构化定位，不是修改授权）：\n${context}`,
        mode,
        signal,
        submissionId,
      ).then(() => {
        actions.clearReference(reference)
        setError(null)
        return { kind: 'success' as const }
      })
    })
  }, [actions, enabled, loading, reference, registerSubmit, sendMessage])

  useEffect(() => {
    if (!enabled) return
    const card = rootRef.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return
    const over = (event: Event): void => {
      const transfer = (event as DragEvent).dataTransfer
      if (transfer === null || !transfer.types.includes(CHAPTER_DRAG_TYPE)) return
      event.preventDefault()
      transfer.dropEffect = disabled || loading ? 'none' : 'copy'
      setDragActive(!disabled && !loading)
    }
    const leave = (): void => { setDragActive(false) }
    const drop = (event: Event): void => {
      const transfer = (event as DragEvent).dataTransfer
      if (transfer === null || !transfer.types.includes(CHAPTER_DRAG_TYPE)) return
      event.preventDefault()
      setDragActive(false)
      if (disabled || loading) return
      let payload: unknown
      try { payload = JSON.parse(transfer.getData(CHAPTER_DRAG_TYPE)) }
      catch { setError('章节引用无法读取，请重新拖入。'); return }
      if (typeof payload !== 'object' || payload === null || !('sessionId' in payload) || payload.sessionId !== sessionId
        || !('sectionId' in payload) || typeof payload.sectionId !== 'string' || payload.sectionId === '') {
        setError('只能引用当前任务中的章节。')
        return
      }
      const version = ++requestVersion.current
      setLoading(true)
      setError(null)
      void getChapter(payload.sectionId).then((chapter) => {
        if (version !== requestVersion.current) return
        if (!chapter.writable || chapter.markdown === null || chapter.content_sha256 === null) throw new Error('该章节暂时没有可修改的正文。')
        actions.setReference({
          reference: { scope: 'chapter', section_id: chapter.section_id, content_sha256: chapter.content_sha256 },
          label: `${chapter.number} ${chapter.title}`,
          preview: '引用将随普通消息交给主 Agent，由其判断解释或修改。',
        })
        card.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true })
      }).catch((reason: unknown) => {
        if (version === requestVersion.current) setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => {
        if (version === requestVersion.current) setLoading(false)
      })
    }
    card.addEventListener('dragover', over)
    card.addEventListener('dragleave', leave)
    card.addEventListener('drop', drop)
    return () => {
      card.removeEventListener('dragover', over)
      card.removeEventListener('dragleave', leave)
      card.removeEventListener('drop', drop)
    }
  }, [actions, disabled, enabled, getChapter, loading, sessionId])

  useEffect(() => () => { requestVersion.current++ }, [sessionId])

  if (!enabled) return null
  const visibleIssues = queue?.issues?.filter(issue =>
    issue.status === 'pending' || issue.status === 'scheduled' || issue.status === 'running') ?? []
  const pendingCount = queue?.issues?.filter(issue => issue.status === 'pending').length ?? 0
  return <div ref={rootRef} className={css.root} data-bid-composer-context="">
    {visibleIssues.length > 0 && (
      <div className={css.queue}>
        <div className={css.queueHeader}>
          <span className={css.queueTitle}>待处理审批意见 {pendingCount}</span>
        </div>
        {visibleIssues.map(issue => (
          <div key={issue.issue_id} className={css.queueItem} data-status={issue.status}>
            <div className={css.queueItemHeader}>
              <span className={css.queueItemId}>{issue.issue_id}</span>
              <span className={css.queueItemSection}>· {issue.section_title}</span>
              {issue.status !== 'pending' && (
                <span className={css.queueItemStatus}>
                  {issue.status === 'scheduled' ? '已排队' : '处理中'}
                </span>
              )}
            </div>
            <div className={css.queueItemRef}>
              {issue.scope === 'chapter' ? '范围：整个章节' : `引用：${issue.reference.scope === 'paragraphs' ? issue.reference.text.slice(0, 80) : ''}${issue.reference.scope === 'paragraphs' && issue.reference.text.length > 80 ? '…' : ''}`}
            </div>
            <div className={css.queueItemField}><span className={css.queueFieldLabel}>问题：</span>{issue.instruction}</div>
            {issue.suggestion !== null && (
              <div className={css.queueItemField}><span className={css.queueFieldLabel}>建议：</span>{issue.suggestion}</div>
            )}
            {issue.status === 'pending' && (
              <div className={css.queueItemActions}>
                <button type="button" className={css.queueActionBtn} disabled={disabled} onClick={() => { startEdit(issue) }}>编辑</button>
                <button type="button" className={css.queueActionBtn} disabled={disabled} onClick={() => { setDeletingId(issue.issue_id) }}>删除</button>
              </div>
            )}
          </div>
        ))}
      </div>
    )}
    {queueError !== null && <p role="alert" className={css.error}>{queueError}</p>}
    {reference === null ? <p className={css.hint}>{loading ? '正在读取章节…' : dragActive ? '松开以引用章节' : '拖入章节，或选中正文段落后右键添加编写意见'}</p> : <div className={css.reference}>
      <div className={css.copy} title={`${reference.label}\n${reference.preview}`}>
        <strong>{reference.reference.scope === 'chapter' ? '章节' : '选中段落'} · {reference.label}</strong>
        <span>{reference.preview}</span>
      </div>
      <button type="button" className={css.remove} disabled={disabled || loading} aria-label="移除章节引用" onClick={() => { actions.setReference(null) }}>×</button>
    </div>}
    {reference?.reference.scope === 'paragraphs' && <p className={css.hint}>仅修改选中段落，其他正文保持不变。</p>}
    {error !== null && <p role="alert" className={css.error}>{error}</p>}
    {editingIssue !== null && (
      <Modal
        open={editingIssue !== null}
        onClose={closeEditModal}
        title="编辑审批意见"
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
        <div className={css.editModalBody}>
          <div className={css.editField}>
            <label className={css.editFieldLabel} htmlFor="edit-instruction">修改意见 <span className={css.editRequired}>*</span></label>
            <textarea
              id="edit-instruction"
              className={css.editTextarea}
              value={editInstruction}
              disabled={editSaving}
              onChange={(event) => { setEditInstruction(event.target.value); setEditError(null) }}
              rows={3}
            />
          </div>
          <div className={css.editField}>
            <label className={css.editFieldLabel} htmlFor="edit-suggestion">修复建议</label>
            <textarea
              id="edit-suggestion"
              className={css.editTextarea}
              value={editSuggestion}
              disabled={editSaving}
              onChange={(event) => { setEditSuggestion(event.target.value) }}
              rows={3}
            />
          </div>
          {editError !== null && <p role="alert" className={css.error}>{editError}</p>}
        </div>
      </Modal>
    )}
    {deletingId !== null && (
      <Modal
        open={deletingId !== null}
        onClose={() => { setDeletingId(null) }}
        title="确认删除"
        closeLabel="关闭"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => { setDeletingId(null) }}>取消</Button>
            <Button variant="primary" size="sm" onClick={confirmDelete}>删除</Button>
          </>
        }
      >
        <p>确定要删除这条审批意见吗？</p>
      </Modal>
    )}
  </div>
}
