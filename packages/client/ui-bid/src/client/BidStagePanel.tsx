import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { BID_RUNTIME_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import { applyOutlineEdits, buildOutlineView } from '@deepseek-ai/dsh-bid/src/outline-confirmation-edits.ts'
import type { BidClientProjection, BidDocumentRole, BidStage, OutlineArtifact, OutlineEditOperation, StageRunStatus } from '@deepseek-ai/dsh-bid/control-plane'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCheckOutline14,
  IconChecklistOutline14,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the input-dock SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BidActionError, type BidSelectedFile, type BidStagePanelInjected } from './index.ts'
import type { BidKey } from './locales.ts'
import css from './BidStagePanel.module.css'

/** Full props for the Bid input-dock entry. */
export type BidStagePanelProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<BidStagePanelInjected>
  & PropsLocale<'bid'>

type PendingAction = 'upload' | 'retry' | 'confirm' | 'revise'
type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string
type SectionEdit = { title?: string; purpose?: string; must_answer?: string[] }
type RequestError = { message: string; issues: readonly { readonly code: string; readonly message: string }[] }

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
      return status === 'pending' ? 'prompt.tender_analysis_pending' : 'prompt.tender_analysis'
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
  uploadFiles,
  retryStage,
  confirmOutline,
  getOutlineForConfirmation,
  t,
}: BidStagePanelProps) {
  const isBidSession = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection(BID_RUNTIME_PROJECTION_KEY)
  const [selectedFiles, setSelectedFiles] = useState<readonly BidSelectedFile[]>([])
  const [requestPending, setRequestPending] = useState<PendingAction | null>(null)
  const [requestError, setRequestError] = useState<RequestError | null>(null)
  const [previewOutline, setPreviewOutline] = useState<OutlineArtifact | null>(null)
  const [operations, setOperations] = useState<readonly OutlineEditOperation[]>([])
  const tenderFileInput = useRef<HTMLInputElement>(null)
  const referenceFileInput = useRef<HTMLInputElement>(null)
  const selectedFilesRef = useRef<readonly BidSelectedFile[]>([])
  const pendingAction = useRef<PendingAction | null>(null)
  const alive = useRef(true)
  const temporarySectionId = useRef(0)

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
  useEffect(() => {
    if (!hasProjection) return
    setComposerBlock(blockedReason)
    return () => { setComposerBlock(undefined) }
  }, [blockedReason, hasProjection, setComposerBlock])

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

  const selected = (role: BidDocumentRole, event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []).map(file => ({ file, role }))
    if (files.length === 0) return
    const tender = files[0]
    if (tender === undefined) return
    const next = role === 'tender'
      ? [...selectedFilesRef.current.filter(item => item.role !== 'tender'), tender]
      : [...selectedFilesRef.current, ...files]
    selectedFilesRef.current = next
    setSelectedFiles(next)
    setRequestError(null)
    event.currentTarget.value = ''
  }

  const hostFailureReason = projection.runtime.status === 'failed'
    ? projection.runtime.failureReason
    : undefined
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

        {rules !== undefined && canUpload && <p className={css.rules}>{rules}</p>}

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

        {selectedFiles.length > 0 && (
          <ul className={css.fileList} aria-label={t('file.selected')}>
            {selectedFiles.map(({ file, role }, index) => (
              <li key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className={css.fileRow}>
                <IconPaperclipOutline16 className={css.fileIcon} />
                <span className={css.fileName} title={file.name}>{file.name}</span>
                <span>{t(`file.role.${role}`)}</span>
                <button
                  type="button"
                  className={css.removeFile}
                  aria-label={`${t('file.remove')}: ${file.name}`}
                  disabled={requestPending !== null}
                  onClick={() => {
                    const next = selectedFilesRef.current.filter((_, itemIndex) => itemIndex !== index)
                    selectedFilesRef.current = next
                    setSelectedFiles(next)
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
                  || !selectedFiles.some(item => item.role === 'reference')
                }
                onClick={() => { invoke('upload', () => uploadFiles(selectedFilesRef.current)) }}
              >
                {requestPending === 'upload' ? t('action.uploading') : t('action.upload')}
              </Button>
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
          {canConfirm && (
            <>
              <Button
                size="sm"
                variant="primary"
                icon={<IconCheckOutline14 />}
                disabled={requestPending !== null || confirmOutline === undefined}
                title={confirmOutline === undefined ? t('action.unavailable') : undefined}
                onClick={() => { invoke('confirm', confirmOutline === undefined ? undefined : () => confirmOutline(operations)) }}
              >
                {t('action.confirm')}
              </Button>
            </>
          )}
        </div>

        {requestError !== null && (
          <div className={css.error} role="alert"><p>{requestError.message}</p>{requestError.issues.map(issue => <p key={`${issue.code}:${issue.message}`}>{`${issue.code}: ${issue.message}`}</p>)}</div>
        )}
      </div>
    </section>
  )
}
