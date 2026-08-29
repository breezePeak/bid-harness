import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BidClientProjection, BidStage, StageRunStatus } from '@deepseek-ai/dsh-bid/control-plane'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCheckOutline14,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the input-dock SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BidStagePanelInjected } from './index.ts'
import type { BidKey } from './locales.ts'
import css from './BidStagePanel.module.css'

/** Full props for the Bid input-dock entry. */
export type BidStagePanelProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<BidStagePanelInjected>
  & PropsLocale<'bid'>

const MVP_STAGES = [
  'file_intake',
  'tender_analysis',
  'evidence_mapping',
  'outline_generation',
  'outline_confirmation',
] as const satisfies readonly BidStage[]

type PendingAction = 'retry' | 'confirm' | 'revise'
type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

function stageKey(stage: typeof MVP_STAGES[number]): BidKey {
  return `stage.${stage}`
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

function promptKey(stage: BidStage): BidKey {
  switch (stage) {
    case 'file_intake': return 'prompt.file_intake'
    case 'tender_analysis': return 'prompt.tender_analysis'
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
    case 'bid.confirmation_required': return t('reason.bid.confirmation_required')
    case undefined: return t('composer.disabled')
    default: return projection.composer.reason
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
 * @returns the Bid panel, or null when the `bid` projection is absent.
 */
export function BidStagePanel({
  useProjection,
  setComposerBlock,
  retryStage,
  confirmOutline,
  t,
}: BidStagePanelProps) {
  const projection = useProjection('bid')
  const [files, setFiles] = useState<readonly File[]>([])
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const blockedReason = useMemo(
    () => projection === undefined ? undefined : composerReason(projection, t),
    [projection, t],
  )
  const hasProjection = projection !== undefined
  useEffect(() => {
    if (!hasProjection) return
    setComposerBlock(blockedReason)
    return () => { setComposerBlock(undefined) }
  }, [blockedReason, hasProjection, setComposerBlock])

  if (projection === undefined) return null

  const canUpload = projection.allowedActions.includes('upload_files')
  const canRetry = projection.allowedActions.includes('retry_stage')
  const canConfirm = projection.allowedActions.includes('confirm_outline')
  const accept = projection.allowedExtensions?.join(',')
  const rules = fileRules(projection, t)

  const invoke = (kind: PendingAction, action: (() => Promise<void>) | undefined): void => {
    if (action === undefined || pending !== null) return
    setPending(kind)
    setError(null)
    void action().then(() => {
      if (!alive.current) return
      setPending(null)
    }, (reason: unknown) => {
      if (!alive.current) return
      setPending(null)
      setError(t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
  }

  const selected = (event: ChangeEvent<HTMLInputElement>): void => {
    setFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }

  return (
    <section className={css.panel} aria-labelledby="bid-stage-title">
      <header className={css.header}>
        <h2 id="bid-stage-title" className={css.title}>{t('title')}</h2>
        <span className={css.runtimeStatus}>{t(statusKey(projection.runtime.status))}</span>
      </header>

      <ol className={css.stages}>
        {MVP_STAGES.map((stage, index) => {
          const active = stage === projection.runtime.stage
          return (
            <li
              key={stage}
              className={active ? `${css.stage} ${css.stageActive}` : css.stage}
              aria-current={active ? 'step' : undefined}
            >
              <span className={css.stageNumber}>{index + 1}</span>
              <span className={css.stageLabel}>{t(stageKey(stage))}</span>
              {active && <span className={css.stageDot} aria-hidden />}
              {active && <span className={css.stageStatus}>{t(statusKey(projection.runtime.status))}</span>}
            </li>
          )
        })}
      </ol>

      <div className={css.message} role="status">
        {t(promptKey(projection.runtime.stage))}
      </div>

      {rules !== undefined && <p className={css.rules}>{rules}</p>}

      {files.length > 0 && (
        <div className={css.files}>
          <div className={css.filesTitle}>{t('file.selected')}</div>
          <ul className={css.fileList}>
            {files.map((file, index) => (
              <li key={`${file.name}:${file.size}:${file.lastModified}`} className={css.fileRow}>
                <IconPaperclipOutline16 className={css.fileIcon} />
                <span className={css.fileName} title={file.name}>{file.name}</span>
                <button
                  type="button"
                  className={css.removeFile}
                  aria-label={`${t('file.remove')}: ${file.name}`}
                  onClick={() => { setFiles(current => current.filter((_, itemIndex) => itemIndex !== index)) }}
                >
                  <IconCloseOutline16 />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={css.actions}>
        {canUpload && (
          <>
            <input
              ref={fileInput}
              className={css.fileInput}
              type="file"
              multiple
              accept={accept}
              onChange={selected}
            />
            <Button
              variant="primary"
              icon={<IconPaperclipOutline16 />}
              onClick={() => { fileInput.current?.click() }}
            >
              {t('action.upload')}
            </Button>
          </>
        )}
        {canRetry && (
          <Button
            variant="outline"
            icon={<IconRefreshOutline16 />}
            disabled={pending !== null || retryStage === undefined}
            title={retryStage === undefined ? t('action.unavailable') : undefined}
            onClick={() => { invoke('retry', retryStage) }}
          >
            {t('action.retry')}
          </Button>
        )}
        {canConfirm && (
          <>
            <Button
              variant="primary"
              icon={<IconCheckOutline14 />}
              disabled={pending !== null || confirmOutline === undefined}
              title={confirmOutline === undefined ? t('action.unavailable') : undefined}
              onClick={() => { invoke('confirm', confirmOutline === undefined ? undefined : () => confirmOutline(true)) }}
            >
              {t('action.confirm')}
            </Button>
            <Button
              variant="outline"
              disabled={pending !== null || confirmOutline === undefined}
              title={confirmOutline === undefined ? t('action.unavailable') : undefined}
              onClick={() => { invoke('revise', confirmOutline === undefined ? undefined : () => confirmOutline(false)) }}
            >
              {t('action.revise')}
            </Button>
          </>
        )}
      </div>

      {error !== null && <p className={css.error} role="alert">{error}</p>}
    </section>
  )
}
