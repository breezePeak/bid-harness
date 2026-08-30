import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { BID_RUNTIME_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import type { BidClientProjection, BidDocumentRole, BidStage, StageRunStatus } from '@deepseek-ai/dsh-bid/control-plane'
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
import type { BidSelectedFile, BidStagePanelInjected } from './index.ts'
import type { BidKey } from './locales.ts'
import css from './BidStagePanel.module.css'

/** Full props for the Bid input-dock entry. */
export type BidStagePanelProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<BidStagePanelInjected>
  & PropsLocale<'bid'>

type PendingAction = 'upload' | 'retry' | 'confirm' | 'revise'
type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

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
  t,
}: BidStagePanelProps) {
  const isBidSession = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection(BID_RUNTIME_PROJECTION_KEY)
  const [selectedFiles, setSelectedFiles] = useState<readonly BidSelectedFile[]>([])
  const [requestPending, setRequestPending] = useState<PendingAction | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const tenderFileInput = useRef<HTMLInputElement>(null)
  const referenceFileInput = useRef<HTMLInputElement>(null)
  const selectedFilesRef = useRef<readonly BidSelectedFile[]>([])
  const pendingAction = useRef<PendingAction | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const blockedReason = useMemo(
    () => projection === undefined ? undefined : composerReason(projection, t),
    [projection, t],
  )
  const hasProjection = isBidSession && projection !== undefined
  useEffect(() => {
    if (!hasProjection) return
    setComposerBlock(blockedReason)
    return () => { setComposerBlock(undefined) }
  }, [blockedReason, hasProjection, setComposerBlock])

  if (!isBidSession || projection === undefined) return null

  const canUpload = projection.allowedActions.includes('upload_files')
  const canRetry = projection.allowedActions.includes('retry_stage')
  const canConfirm = projection.allowedActions.includes('confirm_outline')
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
      setRequestError(t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }))
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
                onClick={() => { invoke('confirm', confirmOutline === undefined ? undefined : () => confirmOutline(true)) }}
              >
                {t('action.confirm')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={requestPending !== null || confirmOutline === undefined}
                title={confirmOutline === undefined ? t('action.unavailable') : undefined}
                onClick={() => { invoke('revise', confirmOutline === undefined ? undefined : () => confirmOutline(false)) }}
              >
                {t('action.revise')}
              </Button>
            </>
          )}
        </div>

        {requestError !== null && (
          <p className={css.error} role="alert">{requestError}</p>
        )}
      </div>
    </section>
  )
}
