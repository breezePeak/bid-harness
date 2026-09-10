/** The Bid reference rail routes chapter feedback to the original writer through the Host action. */
import { useEffect, useRef, useState } from 'react'
import type { BidChapterRevisionRequest, BidReviewChapterView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ComposerSubmitHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAPTER_DRAG_TYPE, type createBidRevisionStore } from './revision-reference.ts'
import css from './BidComposerContext.module.css'

/** Host actions and the conversation-owned submission registration. */
export interface BidComposerContextInjected {
  getChapter: (sectionId: string) => Promise<BidReviewChapterView>
  reviseChapter: (request: BidChapterRevisionRequest) => Promise<void>
  registerSubmit: (handler: ComposerSubmitHandler) => () => void
}

export type BidComposerContextProps = PropsRuntime<'conversation.input.context'>
  & PropsStore<ReturnType<typeof createBidRevisionStore>> & BidComposerContextInjected

/**
 * Show one scoped reference without inserting source material into the user's draft.
 * @param props - Session state, reference store, and Host revision actions.
 * @returns The reference rail and chapter drag invitation for Bid writing sessions.
 */
export function BidComposerContext({
  sessionId, useSessions, useProjection, useStore, actions, disabled, getChapter, reviseChapter, registerSubmit,
}: BidComposerContextProps) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const reference = useStore(state => state.reference)
  const enabled = isBid && (projection?.runtime.stage === 'docx_export'
    || projection?.runtime.stage === 'chapter_writing' && projection.runtime.status === 'completed')
  const rootRef = useRef<HTMLDivElement>(null)
  const requestVersion = useRef(0)
  const [loading, setLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    return registerSubmit((text, imageIds) => {
      if (reference === null && !loading) return undefined
      if (loading) return Promise.resolve({ kind: 'error', text: '正在读取章节，请稍后发送。' })
      if (reference === null) return undefined
      if (imageIds.length > 0) return Promise.resolve({ kind: 'error', text: '章节修改暂不支持图片附件，请先移除图片。' })
      if (text.trim() === '') return Promise.resolve({ kind: 'error', text: '请填写针对所选章节或段落的修改意见。' })
      return reviseChapter({ instruction: text, reference: reference.reference }).then(() => {
        actions.clearReference(reference)
        setError(null)
        return { kind: 'success' as const }
      })
    })
  }, [actions, enabled, loading, reference, registerSubmit, reviseChapter])

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
          preview: '按编写意见调整章节；可要求全量重写或最小修改。',
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
  return <div ref={rootRef} className={css.root} data-bid-composer-context="">
    {reference === null ? <p className={css.hint}>{loading ? '正在读取章节…' : dragActive ? '松开以引用章节' : '拖入章节，或选中正文段落后右键添加编写意见'}</p> : <div className={css.reference}>
      <div className={css.copy} title={`${reference.label}\n${reference.preview}`}>
        <strong>{reference.reference.scope === 'chapter' ? '章节' : '选中段落'} · {reference.label}</strong>
        <span>{reference.preview}</span>
      </div>
      <button type="button" className={css.remove} disabled={disabled || loading} aria-label="移除章节引用" onClick={() => { actions.setReference(null) }}>×</button>
    </div>}
    {reference?.reference.scope === 'paragraphs' && <p className={css.hint}>仅修改选中段落，其他正文保持不变。</p>}
    {error !== null && <p role="alert" className={css.error}>{error}</p>}
  </div>
}
