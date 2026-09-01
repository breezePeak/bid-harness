import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import { BID_RUNTIME_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import { applyOutlineEdits, buildOutlineView } from '@deepseek-ai/dsh-bid/control-plane'
import type { BidClientProjection, BidDocumentRole, BidFileIntakeFileResult, BidStage, OutlineArtifact, OutlineEditOperation, StageRunStatus, StageValidationIssue, TenderAnalysisConfirmationView } from '@deepseek-ai/dsh-bid/control-plane'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCheckOutline14,
  IconChecklistOutline14,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  Portal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the input-dock SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BidActionError, type BidSelectedFile, type BidStagePanelInjected } from './index.ts'
import type { BidKey } from './locales.ts'
import { TenderAnalysisReview } from './TenderAnalysisReview.tsx'
import css from './BidStagePanel.module.css'

/** Full props for the Bid input-dock entry. */
export type BidStagePanelProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<BidStagePanelInjected>
  & PropsLocale<'bid'>

type PendingAction = 'upload' | 'retry' | 'confirm_analysis' | 'confirm' | 'revise'
type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string
type SectionEdit = { title?: string; purpose?: string; must_answer?: string[] }
type RequestError = { message: string; issues: readonly StageValidationIssue[] }
type SelectedFile = BidSelectedFile & {
  id: number
  progress: number
  status: 'selected' | 'encoding' | 'uploading' | 'completed' | 'failed'
  error: string | undefined
}

const ABSENT_REVIEW_SURFACE = { host: () => null, subscribe: () => () => {} }

function stageKey(stage: BidStage): BidKey {
  return `stage.${stage}`
}

function statusDot(status: StageRunStatus): 'done' | 'warning' | 'ongoing' | 'error' | undefined {
  switch (status) {
    case 'pending': return undefined
    case 'waiting_user': return 'warning'
    case 'running': return 'ongoing'
    case 'failed': return 'error'
    case 'completed': return 'done'
  }
  const exhaustive: never = status
  return exhaustive
}

function statusKey(status: StageRunStatus): BidKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'running': return 'status.running'
    case 'waiting_user': return 'status.waiting_user'
    case 'failed': return 'status.failed'
    case 'completed': return 'status.completed'
  }
  const exhaustive: never = status
  return exhaustive
}

function promptKey(stage: BidStage, status: StageRunStatus): BidKey {
  switch (stage) {
    case 'file_intake':
      if (status === 'running') return 'prompt.file_intake_running'
      if (status === 'failed') return 'prompt.file_intake_failed'
      return 'prompt.file_intake'
    case 'tender_analysis':
      if (status === 'pending') return 'prompt.tender_analysis_pending'
      return status === 'waiting_user' ? 'prompt.tender_analysis_confirmation' : 'prompt.tender_analysis'
    case 'evidence_mapping': return 'prompt.evidence_mapping'
    case 'outline_generation': return 'prompt.outline_generation'
    case 'outline_confirmation': return 'prompt.outline_confirmation'
    case 'chapter_writing':
    case 'book_review':
    case 'docx_export':
      return 'prompt.later_stage'
  }
  const exhaustive: never = stage
  return exhaustive
}

function composerReason(projection: BidClientProjection, t: TranslateBid): string | undefined {
  if (projection.composer.enabled) return undefined
  switch (projection.composer.reason) {
    case 'bid.upload_required': return t('reason.bid.upload_required')
    case 'bid.stage_running': return t('reason.bid.stage_running')
    case 'bid.stage_pending': return t('reason.bid.stage_pending')
    case 'bid.tender_analysis_confirmation_required': return t('reason.bid.tender_analysis_confirmation_required')
    case 'bid.outline_confirmation_required': return t('reason.bid.outline_confirmation_required')
    case 'bid.stage_failed': return t('reason.bid.stage_failed')
    case 'bid.completed': return t('reason.bid.completed')
    default: return t('composer.disabled')
  }
}

function fileRules(projection: BidClientProjection, t: TranslateBid): string | undefined {
  if (projection.allowedExtensions === undefined && projection.maxFiles === undefined) return undefined
  return t('file.rules', {
    extensions: projection.allowedExtensions?.join(', ') ?? '—',
    maxFiles: projection.maxFiles ?? '—',
  })
}

/**
 * Render a Bid Session from the current Host projection. Local state is
 * limited to browser-selected files and request feedback; actions never
 * mutate the projected stage or status.
 * @param props - standard projection hook, Host-action callbacks, and locale.
 * @returns the Bid panel, or null for a non-Bid Session or unavailable projection.
 */
export function BidStagePanel({
  sessionId,
  useProjection,
  useSessions,
  setComposerBlock,
  selectReviewView,
  setReviewViewAvailable,
  reviewSurface = ABSENT_REVIEW_SURFACE,
  uploadFiles,
  retryStage,
  confirmOutline,
  regenerateOutline,
  getOutlineForConfirmation,
  confirmTenderAnalysis,
  getTenderAnalysisForConfirmation,
  t,
}: BidStagePanelProps) {
  const isBidSession = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection(BID_RUNTIME_PROJECTION_KEY)
  const [selectedFiles, setSelectedFiles] = useState<readonly SelectedFile[]>([])
  const [requestPending, setRequestPending] = useState<PendingAction | null>(null)
  const [requestError, setRequestError] = useState<RequestError | null>(null)
  const [previewOutline, setPreviewOutline] = useState<OutlineArtifact | null>(null)
  const [tenderAnalysis, setTenderAnalysis] = useState<TenderAnalysisConfirmationView | null>(null)
  const [operations, setOperations] = useState<readonly OutlineEditOperation[]>([])
  const [outlineFeedback, setOutlineFeedback] = useState('')
  const tenderFileInput = useRef<HTMLInputElement>(null)
  const frameworkFileInput = useRef<HTMLInputElement>(null)
  const referenceBidFileInput = useRef<HTMLInputElement>(null)
  const referenceFileInput = useRef<HTMLInputElement>(null)
  const selectedFilesRef = useRef<readonly SelectedFile[]>([])
  const selectedFilesSessionId = useRef(sessionId)
  const nextFileId = useRef(0)
  const pendingAction = useRef<PendingAction | null>(null)
  const alive = useRef(true)
  const temporarySectionId = useRef(0)
  const reviewReady = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const blockedReason = useMemo(
    () => projection === undefined ? undefined : composerReason(projection, t),
    [projection, t],
  )
  const hasProjection = isBidSession && projection !== undefined
  const canConfirm = projection?.allowedActions.includes('confirm_outline') ?? false
  const canRegenerate = projection?.allowedActions.includes('regenerate_outline') ?? false
  const canConfirmAnalysis = projection?.allowedActions.includes('confirm_tender_analysis') ?? false
  const embedConversation = projection?.runtime.stage === 'book_review' && projection.runtime.status === 'waiting_user'
  const reviewViewAvailable = projection?.runtime.status === 'waiting_user'
    && (canConfirm || canConfirmAnalysis || projection.runtime.stage === 'book_review')
  const reviewStateKey = reviewViewAvailable ? `${projection?.runtime.stage}:${projection?.runtime.status}` : null
  const reviewHost = useSyncExternalStore(reviewSurface.subscribe, reviewSurface.host, () => null)
  useEffect(() => {
    if (!hasProjection) return
    setComposerBlock(blockedReason, embedConversation)
    return () => { setComposerBlock(undefined) }
  }, [blockedReason, embedConversation, hasProjection, setComposerBlock])

  useEffect(() => {
    setReviewViewAvailable(reviewViewAvailable)
  }, [reviewViewAvailable, setReviewViewAvailable])

  useEffect(() => {
    if (reviewStateKey === null) {
      reviewReady.current = null
      return
    }
    if (reviewReady.current === reviewStateKey) return
    reviewReady.current = reviewStateKey
    selectReviewView()
  }, [reviewStateKey, selectReviewView])

  useEffect(() => {
    if (projection?.runtime.stage === 'file_intake' && selectedFilesSessionId.current === sessionId) return
    selectedFilesSessionId.current = sessionId
    selectedFilesRef.current = []
    setSelectedFiles([])
  }, [projection?.runtime.stage, sessionId])

  useEffect(() => {
    setOutlineFeedback('')
  }, [sessionId, projection?.runtime.stage])

  useEffect(() => {
    if (!canConfirm || getOutlineForConfirmation === undefined) return
    void getOutlineForConfirmation().then((value) => { if (alive.current) {
      temporarySectionId.current = 0
      setOperations([])
      setPreviewOutline(value)
    } }, (reason: unknown) => {
      if (alive.current) setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: [] })
    })
  }, [canConfirm, getOutlineForConfirmation, t])

  useEffect(() => {
    if (!canConfirmAnalysis || getTenderAnalysisForConfirmation === undefined) return
    void getTenderAnalysisForConfirmation().then((value) => { if (alive.current) setTenderAnalysis(value) }, (reason: unknown) => {
      if (alive.current) setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: [] })
    })
  }, [canConfirmAnalysis, getTenderAnalysisForConfirmation, t])

  if (!isBidSession || projection === undefined) return null

  const canUpload = projection.allowedActions.includes('upload_files')
  const canRetry = projection.allowedActions.includes('retry_stage')
  const accept = projection.allowedExtensions?.join(',')
  const rules = fileRules(projection, t)

  const invoke = (kind: PendingAction, action: (() => Promise<void>) | undefined): void => {
    if (action === undefined || pendingAction.current !== null) return
    pendingAction.current = kind
    setRequestPending(kind)
    setRequestError(null)
    void action().then(() => {
      if (!alive.current) return
      pendingAction.current = null
      setRequestPending(null)
    }, (reason: unknown) => {
      if (!alive.current) return
      pendingAction.current = null
      setRequestPending(null)
      setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: reason instanceof BidActionError ? reason.issues : [] })
    })
  }

  const updateSelectedFiles = (update: (files: readonly SelectedFile[]) => readonly SelectedFile[]): void => {
    const next = [...update(selectedFilesRef.current)]
    selectedFilesRef.current = next
    setSelectedFiles(next)
  }

  const applyFileResults = (results: readonly BidFileIntakeFileResult[]): void => {
    const remaining = [...results]
    updateSelectedFiles(files => files.map((file) => {
      const resultIndex = remaining.findIndex(result => result.name === file.file.name && result.role === file.role)
      const result = resultIndex < 0 ? undefined : remaining.splice(resultIndex, 1)[0]
      if (result === undefined || result.status === 'completed') {
        return { ...file, progress: 100, status: 'completed', error: undefined }
      }
      return { ...file, progress: 100, status: 'failed', error: result.error?.message ?? '文件解析失败' }
    }))
  }

  const uploadSelectedFiles = async (): Promise<void> => {
    const files = selectedFilesRef.current
    updateSelectedFiles(current => current.map(file => ({ ...file, progress: 5, status: 'encoding', error: undefined })))
    try {
      const results = await uploadFiles(
        files.map(({ file, role }) => ({ file, role })),
        (file, progress) => updateSelectedFiles(current => current.map(item => item.file === file.file && item.role === file.role
          ? { ...item, progress, status: progress >= 50 ? 'uploading' : 'encoding' }
          : item)),
      )
      applyFileResults(results ?? [])
    } catch (reason: unknown) {
      if (reason instanceof BidActionError && reason.files.length > 0) applyFileResults(reason.files)
      else updateSelectedFiles(current => current.map(file => ({ ...file, progress: 100, status: 'failed', error: reason instanceof Error ? reason.message : String(reason) })))
      throw reason
    }
  }

  const selected = (role: BidDocumentRole, event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []).map(file => ({
      file,
      role,
      id: ++nextFileId.current,
      progress: 0,
      status: 'selected' as const,
      error: undefined,
    }))
    if (files.length === 0) return
    const single = files[0]
    if (single === undefined) return
    const next = role === 'tender' || role === 'outline_framework'
      ? [...selectedFilesRef.current.filter(item => item.role !== role), single]
      : [...selectedFilesRef.current, ...files]
    selectedFilesRef.current = next
    setSelectedFiles(next)
    setRequestError(null)
    event.currentTarget.value = ''
  }

  const hostFailureReason = projection.runtime.status === 'failed'
    ? projection.runtime.failureReason
    : undefined
  const hostFailureIssues = projection.runtime.status === 'failed'
    ? projection.runtime.failureIssues ?? []
    : []
  const dotState = statusDot(projection.runtime.status)

  const updateSection = (sectionId: string, patch: SectionEdit): void => {
    if (previewOutline === null || sectionId.startsWith('tmp-')) return
    const operation: OutlineEditOperation = { type: 'update_section', section_id: sectionId, ...patch }
    setOperations(current => [...current, operation])
    setPreviewOutline(current => current === null ? null : {
      ...current,
      sections: current.sections.map(section => section.id === sectionId
        ? {
          ...section,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.purpose === undefined ? {} : { purpose: patch.purpose }),
          ...(patch.must_answer === undefined ? {} : { must_answer: [...patch.must_answer] }),
        }
        : section),
    })
  }

  const structureOperation = (operation: OutlineEditOperation): void => {
    setOperations(current => [...current, operation])
    setPreviewOutline(current => current === null ? null : applyOutlineEdits(current, [operation], () => `tmp-${String(++temporarySectionId.current)}`))
    setRequestError(null)
  }

  const indentSection = (sectionId: string): void => {
    const section = previewOutline?.sections.find(candidate => candidate.id === sectionId)
    const siblings = previewOutline?.sections.filter(candidate => candidate.parent_id === section?.parent_id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)) ?? []
    const position = siblings.findIndex(candidate => candidate.id === sectionId)
    const parent = position > 0 ? siblings[position - 1] : undefined
    if (parent !== undefined) structureOperation({ type: 'move_section', section_id: sectionId, parent_id: parent.id, order: 1 })
  }

  const outdentSection = (sectionId: string): void => {
    const section = previewOutline?.sections.find(candidate => candidate.id === sectionId)
    const parent = section?.parent_id === null || section === undefined
      ? undefined
      : previewOutline?.sections.find(candidate => candidate.id === section.parent_id)
    if (parent !== undefined) {
      structureOperation({ type: 'move_section', section_id: sectionId, parent_id: parent.parent_id, order: parent.order + 1 })
    }
  }

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.body}>
        <div className={css.statusRow}>
          {dotState === undefined
            ? <IconChecklistOutline14 className={css.lead} />
            : <StateDot state={dotState} />}
          <span className={css.stage}>{t(stageKey(projection.runtime.stage))}</span>
          <span className={css.message} role="status">
            {t(promptKey(projection.runtime.stage, projection.runtime.status))}
          </span>
          <span className={css.runtimeStatus}>{t(statusKey(projection.runtime.status))}</span>
        </div>

        {hostFailureReason !== undefined && (
          <p className={css.error} role="alert">{t('error.stage', { message: hostFailureReason })}</p>
        )}

        {hostFailureIssues.length > 0 && (
          <div className={css.validationIssues} role="alert">
            <p>{t('validation.count', { count: hostFailureIssues.length })}</p>
            <ol>
              {hostFailureIssues.map((issue, index) => (
                <li key={`${String(index)}:${issue.code}:${issue.artifact ?? ''}:${issue.path ?? ''}`}>
                  {issue.artifact !== undefined && <span>{t('validation.artifact', { artifact: issue.artifact })}</span>}
                  {issue.path !== undefined && <span>{t('validation.path', { path: issue.path })}</span>}
                  <span>{t('validation.message', { message: issue.message })}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {rules !== undefined && canUpload && <p className={css.rules}>{rules}</p>}

        {reviewHost !== null && (canConfirm || canConfirmAnalysis) && <Portal container={reviewHost}>
          <div>
            {canConfirm && previewOutline !== null && (
              <div className={css.outline} aria-label="技术标目录">
                {buildOutlineView(previewOutline.sections).map(({ section, number, depth }) => {
                  const isTemporary = section.id.startsWith('tmp-')
                  const siblings = previewOutline.sections.filter(candidate => candidate.parent_id === section.parent_id)
                    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
                  const index = siblings.findIndex(candidate => candidate.id === section.id)
                  return <article key={section.id} className={css.outlineSection} style={{ marginLeft: `${String((depth - 1) * 16)}px` }}>
                    <span aria-label={`${section.id} 章节编号`}>{number}</span>
                    <input aria-label={`${section.id} 标题`} disabled={isTemporary} value={section.title} onChange={event => updateSection(section.id, { title: event.target.value })} />
                    <textarea aria-label={`${section.id} 目的`} disabled={isTemporary} value={section.purpose} onChange={event => updateSection(section.id, { purpose: event.target.value })} />
                    {section.writable && <textarea aria-label={`${section.id} 必答内容`} disabled={isTemporary} value={section.must_answer.join('\n')} onChange={event => updateSection(section.id, { must_answer: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} />}
                    <div className={css.actions}>
                      <button type="button" disabled={isTemporary} onClick={() => structureOperation({ type: 'add_section', parent_id: section.parent_id, order: section.order + 1, writable: true, title: '新增章节', purpose: '补充响应', must_answer: ['待补充'] })}>新增同级</button>
                      <button type="button" disabled={isTemporary} onClick={() => structureOperation({ type: 'add_section', parent_id: section.id, order: 1, writable: true, title: '新增子级', purpose: '补充响应', must_answer: ['待补充'] })}>新增子级</button>
                      <button type="button" disabled={isTemporary} onClick={() => structureOperation({ type: 'delete_section', section_id: section.id })}>删除</button>
                      <button type="button" disabled={isTemporary || index === 0} onClick={() => structureOperation({ type: 'move_section', section_id: section.id, parent_id: section.parent_id, order: index })}>上移</button>
                      <button type="button" disabled={isTemporary || index === siblings.length - 1} onClick={() => structureOperation({ type: 'move_section', section_id: section.id, parent_id: section.parent_id, order: index + 2 })}>下移</button>
                      <button type="button" disabled={isTemporary || index === 0} onClick={() => indentSection(section.id)}>缩进</button>
                      <button type="button" disabled={isTemporary || section.parent_id === null} onClick={() => outdentSection(section.id)}>取消缩进</button>
                    </div>
                    <span className={css.mapping}>{`Requirement ${String(section.requirement_ids.length)} · Scoring ${String(section.scoring_ids.length)}`}</span>
                  </article>
                })}
              </div>
            )}

            {canConfirmAnalysis && tenderAnalysis !== null && (
              <TenderAnalysisReview
                value={tenderAnalysis}
                pending={requestPending === 'confirm_analysis'}
                t={t}
                onConfirm={(operations) => {
                  invoke(
                    'confirm_analysis',
                    confirmTenderAnalysis === undefined ? undefined : () => confirmTenderAnalysis(operations),
                  )
                }}
              />
            )}
          </div>
        </Portal>}

        {projection.runtime.stage === 'file_intake' && selectedFiles.length > 0 && (
          <ul className={css.fileList} aria-label={t('file.selected')}>
            {selectedFiles.map(({ file, role, id, progress, status, error }, index) => (
              <li key={id} className={css.fileRow}>
                <IconPaperclipOutline16 className={css.fileIcon} />
                <span
                  className={css.fileName}
                  title={error === undefined ? file.name : `${file.name}: ${error}`}
                  style={{ '--bid-file-progress': `${String(progress)}%` } as CSSProperties}
                >
                  <span>{file.name}</span>
                  {status === 'failed' && error !== undefined && <span className={css.fileError}>{error}</span>}
                </span>
                <span>{t(`file.role.${role}`)}</span>
                <button
                  type="button"
                  className={css.removeFile}
                  aria-label={`${t('file.remove')}: ${file.name}`}
                  disabled={requestPending !== null}
                  onClick={() => {
                    updateSelectedFiles(files => files.filter((_, itemIndex) => itemIndex !== index))
                    setRequestError(null)
                  }}
                >
                  <IconCloseOutline16 />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={css.actions}>
          {canUpload && (
            <>
              <input
                ref={tenderFileInput}
                className={css.fileInput}
                type="file"
                accept={accept}
                onChange={(event) => { selected('tender', event) }}
              />
              <input
                ref={frameworkFileInput}
                className={css.fileInput}
                type="file"
                accept={accept}
                onChange={(event) => { selected('outline_framework', event) }}
              />
              <input
                ref={referenceBidFileInput}
                className={css.fileInput}
                type="file"
                multiple
                accept={accept}
                onChange={(event) => { selected('reference_bid', event) }}
              />
              <input
                ref={referenceFileInput}
                className={css.fileInput}
                type="file"
                multiple
                accept={accept}
                onChange={(event) => { selected('reference', event) }}
              />
              <Button
                size="sm"
                variant="outline"
                icon={<IconPaperclipOutline16 />}
                disabled={requestPending !== null}
                onClick={() => { tenderFileInput.current?.click() }}
              >
                {t('action.upload_tender')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                icon={<IconPaperclipOutline16 />}
                disabled={requestPending !== null}
                title={t('file.help.outline_framework')}
                onClick={() => { frameworkFileInput.current?.click() }}
              >
                {t('action.upload_framework')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                icon={<IconPaperclipOutline16 />}
                disabled={requestPending !== null}
                title={t('file.help.reference_bid')}
                onClick={() => { referenceBidFileInput.current?.click() }}
              >
                {t('action.upload_reference_bid')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                icon={<IconPaperclipOutline16 />}
                disabled={requestPending !== null}
                onClick={() => { referenceFileInput.current?.click() }}
              >
                {t('action.upload_reference')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={
                  requestPending !== null
                  || !selectedFiles.some(item => item.role === 'tender')
                }
                onClick={() => { invoke('upload', uploadSelectedFiles) }}
              >
                {requestPending === 'upload' ? t('action.uploading') : t('action.upload')}
              </Button>
              <div className={css.uploadHelp}>
                <span>{t('file.help.outline_framework')}</span>
                <span>{t('file.help.reference_bid')}</span>
                <span>{t('file.help.reference')}</span>
              </div>
            </>
          )}
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              icon={<IconRefreshOutline16 />}
              disabled={requestPending !== null || retryStage === undefined}
              title={retryStage === undefined ? t('action.unavailable') : undefined}
              onClick={() => { invoke('retry', retryStage) }}
            >
              {t('action.retry')}
            </Button>
          )}
          {(canConfirm || canRegenerate) && (
            <div className={css.outlineDecision}>
              <div className={css.decisionRow}>
                <div className={css.decisionCopy}>
                  <span className={css.decisionLabel}>{t('outline.accept.label')}</span>
                  <span className={css.decisionHint}>{t('outline.accept.hint')}</span>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<IconCheckOutline14 />}
                  disabled={requestPending !== null || confirmOutline === undefined}
                  title={confirmOutline === undefined ? t('action.unavailable') : undefined}
                  onClick={() => { invoke('confirm', confirmOutline === undefined ? undefined : () => confirmOutline(operations)) }}
                >
                  {requestPending === 'confirm' ? t('outline.accept.pending') : t('outline.accept.action')}
                </Button>
              </div>
              <div className={css.decisionRow}>
                <div className={css.revisionField}>
                  <label className={css.decisionLabel} htmlFor={`bid-outline-feedback-${sessionId}`}>{t('outline.revise.label')}</label>
                  <span className={css.decisionHint}>{t('outline.revise.hint')}</span>
                  <textarea
                    id={`bid-outline-feedback-${sessionId}`}
                    className={css.revisionTextarea}
                    value={outlineFeedback}
                    placeholder={t('outline.revise.placeholder')}
                    disabled={requestPending !== null}
                    onChange={(event) => { setOutlineFeedback(event.target.value) }}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconRefreshOutline16 />}
                  disabled={requestPending !== null || regenerateOutline === undefined || outlineFeedback.trim().length === 0}
                  title={regenerateOutline === undefined ? t('action.unavailable') : undefined}
                  onClick={() => {
                    const feedback = outlineFeedback.trim()
                    invoke('revise', regenerateOutline === undefined ? undefined : async () => {
                      await regenerateOutline(feedback)
                      if (alive.current) setOutlineFeedback('')
                    })
                  }}
                >
                  {requestPending === 'revise' ? t('outline.revise.pending') : t('outline.revise.action')}
                </Button>
              </div>
            </div>
          )}
          {canConfirmAnalysis && (
            <Button
              size="sm"
              variant="primary"
              icon={<IconCheckOutline14 />}
              disabled={requestPending !== null || confirmTenderAnalysis === undefined}
              title={confirmTenderAnalysis === undefined ? t('action.unavailable') : undefined}
              onClick={() => { invoke('confirm_analysis', confirmTenderAnalysis === undefined ? undefined : () => confirmTenderAnalysis([])) }}
            >
              {t('action.confirm')}
            </Button>
          )}
        </div>

        {requestError !== null && (
          <div className={css.error} role="alert"><p>{requestError.message}</p>{requestError.issues.map((issue, index) => <p key={`${String(index)}:${issue.code}:${issue.message}`}>{issue.artifact === undefined && issue.path === undefined ? `${issue.code}: ${issue.message}` : [issue.artifact, issue.path, issue.message].filter(Boolean).join(' · ')}</p>)}</div>
        )}
      </div>
    </section>
  )
}
