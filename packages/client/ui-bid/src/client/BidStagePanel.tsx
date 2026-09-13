import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import { applyOutlineEdits, BID_RUNTIME_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import type { BidClientProjection, BidDocumentRole, BidEvidenceMappingProgress, BidFileIntakeFileResult, BidStage, OutlineDraftView, OutlineReviewContext, OutlineEditOperation, StageRunStatus, StageValidationIssue, TenderAnalysisConfirmationView } from '@deepseek-ai/dsh-bid/control-plane'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconBrowseOutline16,
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconChecklistOutline14,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  Menu,
  Portal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the input-dock SlotMap merge.
import { BidActionError, type BidSelectedFile, type BidStagePanelInjected } from './index.ts'
import type { BidKey } from './locales.ts'
import { OutlineConfirmationReview } from './OutlineConfirmationReview.tsx'
import { TenderAnalysisReview } from './TenderAnalysisReview.tsx'
import { createBidConfirmationModeStore, type BidConfirmationMode } from './confirmation-mode.ts'
import css from './BidStagePanel.module.css'

/** Full props for the Bid input-dock entry. */
export type BidStagePanelProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsStore<ReturnType<typeof createBidConfirmationModeStore>>
  & InjectFace<BidStagePanelInjected>
  & PropsLocale<'bid'>

/** Full props for the Bid confirmation-mode control in the composer tool row. */
export type BidConfirmationModeControlProps =
  PropsRuntime<'conversation.input.left'>
  & PropsStore<ReturnType<typeof createBidConfirmationModeStore>>
  & PropsLocale<'bid'>

type PendingAction = 'upload' | 'start' | 'confirm_analysis' | 'confirm' | 'revise' | 'request_requirements' | 'auto_start'
type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string
type SectionEdit = { title?: string; purpose?: string; must_answer?: string[] }
type RequestError = { message: string; issues: readonly StageValidationIssue[] }
type SelectedFile = BidSelectedFile & {
  id: number
  progress: number
  status: 'selected' | 'encoding' | 'uploading' | 'completed' | 'failed'
  error: string | undefined
}
type SelectedTemplate = Omit<SelectedFile, 'role'> & { role: 'docx_template' }

/** Select manual or automatic confirmation for the current Bid Session. */
export function BidConfirmationModeControl({ sessionId, useSessions, useStore, actions, t }: BidConfirmationModeControlProps) {
  const isBidSession = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const mode = useStore(state => state.mode)
  const [open, setOpen] = useState(false)
  if (!isBidSession) return null
  const label = t(`confirmation.mode.${mode}`)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={(['manual', 'automatic'] as const).map(id => ({ id, label: t(`confirmation.mode.${id}`) }))}
      selectedId={mode}
      onSelect={(id) => {
        setOpen(false)
        actions.setMode(id as BidConfirmationMode)
      }}
      portal
      anchor={(
        <button
          type="button"
          className={css.confirmationModeButton}
          aria-label={t('confirmation.mode.label')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('confirmation.mode.label')}
          onClick={() => { setOpen(!open) }}
        >
          {label}
          <IconChevronDownOutline14 className={css.confirmationModeChevron} />
        </button>
      )}
    />
  )
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0 || Number.isNaN(bytes)) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function stageKey(stage: BidStage): BidKey {
  return `stage.${stage}`
}

function statusDot(status: StageRunStatus): 'done' | 'warning' | 'ongoing' | 'error' | undefined {
  switch (status) {
    case 'pending': return undefined
    case 'waiting_start': return 'warning'
    case 'waiting_user': return 'warning'
    case 'running': return 'ongoing'
    case 'attention_required': return 'warning'
    case 'failed': return 'error'
    case 'completed': return 'done'
  }
  const exhaustive: never = status
  return exhaustive
}

function statusKey(status: StageRunStatus): BidKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'waiting_start': return 'status.waiting_start'
    case 'running': return 'status.running'
    case 'waiting_user': return 'status.waiting_user'
    case 'attention_required': return 'status.failed'
    case 'failed': return 'status.failed'
    case 'completed': return 'status.completed'
  }
  const exhaustive: never = status
  return exhaustive
}

function promptKey(stage: BidStage, status: StageRunStatus): BidKey {
  if (status === 'waiting_start') return 'prompt.stage_waiting_start'
  switch (stage) {
    case 'file_intake':
      if (status === 'running') return 'prompt.file_intake_running'
      if (status === 'failed') return 'prompt.file_intake_failed'
      return 'prompt.file_intake'
    case 'tender_analysis':
      if (status === 'pending') return 'prompt.tender_analysis_pending'
      return status === 'waiting_user' ? 'prompt.tender_analysis_confirmation' : 'prompt.tender_analysis'
    case 'evidence_mapping': return status === 'waiting_user' ? 'prompt.outline_confirmation' : 'prompt.evidence_mapping'
    case 'outline_generation': return status === 'waiting_user' ? 'prompt.outline_confirmation' : 'prompt.outline_generation'
    case 'chapter_writing':
      if (status === 'waiting_user') return 'prompt.writing_requirements'
      return 'prompt.later_stage'
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
    case 'bid.stage_start_required': return t('reason.bid.stage_start_required')
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
 * limited to browser-selected files, request feedback, and polled S4 task counts; actions never
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
  reviewSurface,
  getDetails,
  setDetailsAvailable,
  uploadFiles,
  getDocxLibrary,
  uploadDocxTemplate,
  startStage,
  requestWritingRequirements,
  autoStartChapterWriting,
  confirmOutline,
  regenerateOutline,
  getOutlineDraft,
  getOutlineReviewContext,
  applyOutlineDraftOperations,
  confirmTenderAnalysis,
  getTenderAnalysisForConfirmation,
  setTenderScoringSelection,
  getEvidenceMappingProgress,
  useStore,
  actions,
  t,
}: BidStagePanelProps) {
  const isBidSession = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection(BID_RUNTIME_PROJECTION_KEY)
  const [selectedFiles, setSelectedFiles] = useState<readonly SelectedFile[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<SelectedTemplate | null>(null)
  const [docxLibrary, setDocxLibrary] = useState<Awaited<ReturnType<typeof getDocxLibrary>> | null>(null)
  const [docxTemplateMessage, setDocxTemplateMessage] = useState('')
  const [requestPending, setRequestPending] = useState<PendingAction | null>(null)
  const [requestError, setRequestError] = useState<RequestError | null>(null)
  const [reviewContext, setReviewContext] = useState<OutlineReviewContext | null>(null)
  const [draft, setDraft] = useState<OutlineDraftView | null>(null)
  const [tenderAnalysis, setTenderAnalysis] = useState<TenderAnalysisConfirmationView | null>(null)
  const [mappingProgress, setMappingProgress] = useState<BidEvidenceMappingProgress | null>(null)
  const [outlineFeedback, setOutlineFeedback] = useState('')
  const [draftSaveState, setDraftSaveState] = useState<'saved' | 'saving' | 'failed' | 'conflict'>('saved')
  const tenderFileInput = useRef<HTMLInputElement>(null)
  const frameworkFileInput = useRef<HTMLInputElement>(null)
  const referenceBidFileInput = useRef<HTMLInputElement>(null)
  const referenceFileInput = useRef<HTMLInputElement>(null)
  const docxTemplateInput = useRef<HTMLInputElement>(null)
  const selectedFilesRef = useRef<readonly SelectedFile[]>([])
  const selectedTemplateRef = useRef<SelectedTemplate | null>(null)
  const selectedFilesSessionId = useRef(sessionId)
  const nextFileId = useRef(0)
  const pendingAction = useRef<PendingAction | null>(null)
  const requestEpoch = useRef(0)
  const actionErrorVisible = useRef(false)
  const alive = useRef(true)
  const draftRef = useRef<OutlineDraftView | null>(null)
  const draftQueue = useRef<Promise<void>>(Promise.resolve())
  const draftOperation = useRef(0)
  const draftEpoch = useRef(0)
  const reviewReady = useRef<string | null>(null)
  const [updatedForConfirmation, setUpdatedForConfirmation] = useState(false)
  const confirmationMode = useStore(state => state.mode)
  const automaticAttempts = useStore(state => state.attempted)

  const invoke = useCallback((kind: PendingAction, action: (() => Promise<void>) | undefined): void => {
    if (action === undefined || pendingAction.current !== null) return
    const epoch = requestEpoch.current
    pendingAction.current = kind
    actionErrorVisible.current = false
    setRequestPending(kind)
    setRequestError(null)
    void action().then(() => {
      if (!alive.current || requestEpoch.current !== epoch) return
      pendingAction.current = null
      setRequestPending(null)
    }, (reason: unknown) => {
      if (!alive.current || requestEpoch.current !== epoch) return
      pendingAction.current = null
      setRequestPending(null)
      actionErrorVisible.current = true
      setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: reason instanceof BidActionError ? reason.issues : [] })
    })
  }, [t])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    if (projection?.runtime.stage !== 'evidence_mapping' || (projection.runtime.status !== 'running' && projection.runtime.status !== 'waiting_user') || getEvidenceMappingProgress === undefined) {
      setMappingProgress(null)
      return
    }
    let active = true
    const refresh = (): void => {
      void getEvidenceMappingProgress().then((progress) => {
        if (active) setMappingProgress(progress)
      }).catch(() => {
        if (active) setMappingProgress(null)
      })
    }
    refresh()
    const timer = projection.runtime.status === 'running' ? window.setInterval(refresh, 1000) : undefined
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [getEvidenceMappingProgress, projection])

  const blockedReason = useMemo(
    () => projection === undefined ? undefined : composerReason(projection, t),
    [projection, t],
  )
  const canConfirm = projection?.allowedActions.includes('confirm_outline') ?? false
  const canRegenerate = projection?.allowedActions.includes('regenerate_outline') ?? false
  const canConfirmAnalysis = projection?.allowedActions.includes('confirm_tender_analysis') ?? false
  const hasProjection = projection !== undefined && (isBidSession || canConfirm || canConfirmAnalysis)
  const embedConversation = false
  const reviewViewAvailable = hasProjection && (projection.runtime.stage === 'chapter_writing' || projection.runtime.stage === 'docx_export')
  const outlineReviewReady = canConfirm && projection?.runtime.stage === 'evidence_mapping'
  const reviewViewId = canConfirmAnalysis ? 'bid-tender'
    : canConfirm ? outlineReviewReady ? 'bid-outline' : 'bid-confirmation' : 'bid-review'
  const reviewStateKey = (reviewViewAvailable || canConfirmAnalysis || canConfirm) && projection !== undefined ? `${projection.runtime.stage}:${projection.runtime.status}` : null
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
    let active = true
    if (hasProjection) {
      void getDetails().then((details) => {
        if (!active) return
        setDetailsAvailable(details, canConfirm && !outlineReviewReady, canConfirmAnalysis)
        if (reviewStateKey !== null && reviewReady.current !== reviewStateKey) {
          reviewReady.current = reviewStateKey
          selectReviewView(reviewViewId)
        }
      }, (reason: unknown) => {
        if (active) setRequestError({ message: reason instanceof Error ? reason.message : String(reason), issues: [] })
      })
    } else setDetailsAvailable(null)
    return () => { active = false }
  }, [
    hasProjection, sessionId, projection?.runtime.stage, projection?.runtime.status,
    getDetails, setDetailsAvailable, reviewStateKey, reviewViewId, canConfirm, outlineReviewReady, selectReviewView,
  ])

  useEffect(() => {
    setDetailsAvailable(null, false, canConfirmAnalysis)
    reviewReady.current = null
    return () => { setDetailsAvailable(null) }
  }, [sessionId, canConfirmAnalysis, setDetailsAvailable])

  useEffect(() => {
    if (reviewStateKey === null) {
      reviewReady.current = null
      return
    }
    if (!reviewViewAvailable || reviewReady.current === reviewStateKey) return
    reviewReady.current = reviewStateKey
    selectReviewView(reviewViewId)
  }, [reviewStateKey, reviewViewAvailable, selectReviewView, reviewViewId])

  useEffect(() => {
    if (projection?.runtime.stage === 'file_intake' && selectedFilesSessionId.current === sessionId) return
    selectedFilesSessionId.current = sessionId
    selectedFilesRef.current = []
    selectedTemplateRef.current = null
    setSelectedFiles([])
    setSelectedTemplate(null)
    setDocxTemplateMessage('')
  }, [projection?.runtime.stage, sessionId])

  useEffect(() => {
    if (!isBidSession || projection?.runtime.stage !== 'file_intake') { setDocxLibrary(null); return }
    let active = true
    void getDocxLibrary().then((value) => { if (active) setDocxLibrary(value) }, (reason: unknown) => {
      if (active) setDocxTemplateMessage(reason instanceof Error ? reason.message : 'Word 模板库读取失败。')
    })
    return () => { active = false }
  }, [getDocxLibrary, isBidSession, projection?.runtime.stage, sessionId])

  useEffect(() => {
    setOutlineFeedback('')
    setUpdatedForConfirmation(false)
    draftRef.current = null
  }, [sessionId, projection?.runtime.stage])

  useEffect(() => {
    requestEpoch.current += 1
    pendingAction.current = null
    setRequestPending(null)
    if (actionErrorVisible.current) {
      actionErrorVisible.current = false
      setRequestError(null)
    }
  }, [sessionId, projection?.runtime.stage, projection?.runtime.status])

  useEffect(() => {
    setReviewContext(null)
    if (!canConfirm || getOutlineReviewContext === undefined) return
    let active = true
    void getOutlineReviewContext().then((value) => {
      if (active) setReviewContext(value)
    }, (reason: unknown) => {
      if (active) setRequestError({ message: reason instanceof Error ? reason.message : String(reason), issues: [] })
    })
    return () => { active = false }
  }, [canConfirm, getOutlineReviewContext, sessionId, projection?.runtime.stage])

  useEffect(() => {
    if (!canConfirm || getOutlineDraft === undefined) return
    let active = true
    void getOutlineDraft().then((value) => { if (alive.current && active) {
      if (draftRef.current !== null && value.revision > draftRef.current.revision) setUpdatedForConfirmation(true)
      draftRef.current = value
      setDraft(value)
      setDraftSaveState('saved')
    } }, (reason: unknown) => {
      if (alive.current && active) setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: [] })
    })
    return () => { active = false }
  }, [canConfirm, getOutlineDraft, projection, t])

  useEffect(() => {
    if (!canConfirmAnalysis || getTenderAnalysisForConfirmation === undefined) return
    void getTenderAnalysisForConfirmation().then((value) => {
      if (!alive.current) return
      if (!Array.isArray((value as { selected_scoring_ids?: unknown }).selected_scoring_ids)) {
        setRequestError({ message: t('error.action', { message: '确认数据缺少评分项选择状态，请重启服务后重试。' }), issues: [] })
        return
      }
      setTenderAnalysis(value)
    }, (reason: unknown) => {
      if (alive.current) setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: [] })
    })
  }, [canConfirmAnalysis, getTenderAnalysisForConfirmation, t])

  const tenderAutomaticKey = `${sessionId}:tender_analysis`
  const chapterManualKey = `${sessionId}:chapter_writing:manual`
  const chapterAutomaticKey = `${sessionId}:chapter_writing:automatic`
  useEffect(() => {
    if (projection?.runtime.stage !== 'tender_analysis' || projection.runtime.status !== 'waiting_user') {
      actions.clearAttempted(tenderAutomaticKey)
    }
    if (projection?.runtime.stage !== 'chapter_writing' || projection.runtime.status !== 'waiting_user') {
      actions.clearAttempted(chapterManualKey)
      actions.clearAttempted(chapterAutomaticKey)
    }
  }, [actions, chapterAutomaticKey, chapterManualKey, projection?.runtime.stage, projection?.runtime.status, tenderAutomaticKey])

  useEffect(() => {
    if (confirmationMode !== 'automatic' || !canConfirm || confirmOutline === undefined || draft === null
      || draftSaveState !== 'saved' || requestPending !== null) return
    const key = `${sessionId}:${projection?.runtime.stage ?? ''}:${String(draft.revision)}:${draft.draft_outline_sha256}`
    if (automaticAttempts.includes(key)) return
    actions.markAttempted(key)
    invoke('confirm', async () => {
      await draftQueue.current
      const current = draftRef.current
      if (current === null || current.revision !== draft.revision
        || current.draft_outline_sha256 !== draft.draft_outline_sha256) return
      await confirmOutline({ expected_revision: current.revision, expected_draft_sha256: current.draft_outline_sha256 })
    })
  }, [
    actions, automaticAttempts, canConfirm, confirmationMode, confirmOutline, draft,
    draftSaveState, invoke, projection?.runtime.stage, requestPending, sessionId,
  ])

  useEffect(() => {
    if (projection?.runtime.stage !== 'chapter_writing' || projection.runtime.status !== 'waiting_user'
      || requestPending !== null) return
    const automatic = confirmationMode === 'automatic'
    const key = automatic ? chapterAutomaticKey : chapterManualKey
    const action = automatic ? autoStartChapterWriting : requestWritingRequirements
    const admitted = projection.allowedActions.includes(
      automatic ? 'auto_start_chapter_writing' : 'request_writing_requirements',
    )
    if (!admitted || action === undefined || automaticAttempts.includes(key)) return
    actions.markAttempted(key)
    invoke(automatic ? 'auto_start' : 'request_requirements', action)
  }, [
    actions, automaticAttempts, autoStartChapterWriting, chapterAutomaticKey, chapterManualKey,
    confirmationMode, invoke, projection, requestPending, requestWritingRequirements,
  ])

  if (!hasProjection) return null

  const canUpload = projection.allowedActions.includes('upload_files')
  const canStart = projection.allowedActions.includes('start_stage')
  const accept = projection.allowedExtensions?.join(',')
  const rules = fileRules(projection, t)

  const updateSelectedFiles = (update: (files: readonly SelectedFile[]) => readonly SelectedFile[]): void => {
    const next = [...update(selectedFilesRef.current)]
    selectedFilesRef.current = next
    setSelectedFiles(next)
  }

  const updateSelectedTemplate = (update: (file: SelectedTemplate | null) => SelectedTemplate | null): void => {
    const next = update(selectedTemplateRef.current)
    selectedTemplateRef.current = next
    setSelectedTemplate(next)
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
    const template = selectedTemplateRef.current
    if (files.length > 0 && !files.some(file => file.role === 'tender')) {
      throw new BidActionError('BID_TENDER_REQUIRED', t('error.tender_required'))
    }
    if (template !== null) {
      if (docxLibrary === null) throw new Error('Word 模板库尚未就绪。')
      updateSelectedTemplate(file => file === null ? null : { ...file, progress: 50, status: 'uploading', error: undefined })
      setDocxTemplateMessage('正在解析 Word 模板…')
      try {
        const view = await uploadDocxTemplate(template.file, docxLibrary.revision)
        updateSelectedTemplate(file => file === null ? null : { ...file, progress: 100, status: 'completed', error: undefined })
        setDocxLibrary(view.library)
        setDocxTemplateMessage(view.warnings.find(warning => warning.startsWith('模板解析完成；自动格式解释未应用'))
          ?? '模板已加入项目模板库')
      } catch (reason: unknown) {
        updateSelectedTemplate(file => file === null ? null : { ...file, progress: 100, status: 'failed', error: reason instanceof Error ? reason.message : String(reason) })
        throw reason
      }
    }
    if (files.length === 0) return
    updateSelectedFiles(current => current.map(file => ({ ...file, progress: 5, status: 'encoding', error: undefined })))
    try {
      const results = await uploadFiles(
        files.map(({ file, role }) => ({ file, role })),
        (file, progress) => {
          updateSelectedFiles(current => current.map(item => item.file === file.file && item.role === file.role
            ? { ...item, progress, status: progress >= 50 ? 'uploading' : 'encoding' }
            : item))
        },
      )
      applyFileResults(results)
      const failed = results.filter(file => file.status === 'failed')
      if (failed.length > 0) {
        setRequestError({
          message: t('error.file_partial', {
            files: failed.map(file => `${file.name}: ${file.error?.message ?? '文件解析失败'}`).join('；'),
          }),
          issues: [],
        })
      }
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

  const selectedDocxTemplate = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !docxLibrary) return
    if (file.size > docxLibrary.templateMaxBytes) {
      setDocxTemplateMessage(`模板文件不能超过 ${String(Math.floor(docxLibrary.templateMaxBytes / 1024 / 1024))} MiB。`)
      return
    }
    const next: SelectedTemplate = {
      file,
      role: 'docx_template',
      id: ++nextFileId.current,
      progress: 0,
      status: 'selected',
      error: undefined,
    }
    selectedTemplateRef.current = next
    setSelectedTemplate(next)
    setDocxTemplateMessage('')
    setRequestError(null)
  }

  const suspendedRun = projection.run?.status === 'suspended' ? projection.run : undefined
  const hostFailureReason = suspendedRun?.cause !== 'user_stop'
    ? suspendedRun?.error?.message ?? (projection.runtime.status === 'failed' ? projection.runtime.failureReason : undefined)
    : undefined
  const hostFailureIssues = suspendedRun?.error?.issues
    ?? (projection.runtime.status === 'failed' ? projection.runtime.failureIssues ?? [] : [])
  const dotState = statusDot(projection.runtime.status)
  const displayStage = projection.runtime.stage === 'docx_export' ? 'chapter_writing' : projection.runtime.stage

  const persistOperation = (operation: OutlineEditOperation): void => {
    if (applyOutlineDraftOperations === undefined) return
    const token = ++draftOperation.current
    const epoch = draftEpoch.current
    setDraftSaveState('saving')
    draftQueue.current = draftQueue.current.then(async () => {
      if (epoch !== draftEpoch.current) return
      const current = draftRef.current
      if (current === null) return
      const next = await applyOutlineDraftOperations({
        expected_revision: current.revision,
        expected_draft_sha256: current.draft_outline_sha256,
        operations: [operation],
      })
      draftRef.current = next
      if (alive.current && token === draftOperation.current) { setDraft(next); setDraftSaveState('saved') }
    }).catch(async (reason: unknown) => {
      draftEpoch.current++
      if (!alive.current) return
      setDraftSaveState(reason instanceof BidActionError && reason.code === 'BID_OUTLINE_DRAFT_CONFLICT' ? 'conflict' : 'failed')
      setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: reason instanceof BidActionError ? reason.issues : [] })
      if (getOutlineDraft !== undefined) {
        const current = await getOutlineDraft()
        draftRef.current = current
        setDraft(current)
      }
    })
  }

  const updateSection = (sectionId: string, patch: SectionEdit): void => {
    if (draft === null) return
    const operation: OutlineEditOperation = { type: 'update_section', section_id: sectionId, ...patch }
    setDraft(current => current === null ? null : { ...current, outline: {
      ...current.outline,
      sections: current.outline.sections.map(section => section.id === sectionId
        ? { ...section, ...patch, ...(patch.must_answer === undefined ? {} : { must_answer: [...patch.must_answer] }) }
        : section),
    } })
    persistOperation(operation)
  }

  const structureOperation = (operation: OutlineEditOperation): void => {
    if (operation.type === 'move_section') {
      setDraft(current => current === null ? null : { ...current, outline: applyOutlineEdits(current.outline, [operation]) })
    }
    persistOperation(operation)
    setRequestError(null)
  }

  const previewOutline = draft?.outline ?? null

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

  const errorNotice = requestError === null ? null : (<div className={css.error} role="alert"><p>{requestError.message}</p>{requestError.issues.map((issue, index) => <p key={`${String(index)}:${issue.code}:${issue.message}`}>{issue.artifact === undefined && issue.path === undefined ? `${issue.code}: ${issue.message}` : [issue.artifact, issue.path, issue.message].filter(Boolean).join(' · ')}</p>)}</div>)
  const outlineConfirmation = canConfirm ? (
    <>
      <span className={css.decisionHint}>{t('outline.accept.hint')}</span>
      <Button
        size="sm"
        variant="primary"
        icon={<IconCheckOutline14 />}
        disabled={requestPending !== null || confirmOutline === undefined}
        title={confirmOutline === undefined ? t('action.unavailable') : undefined}
        onClick={() => { invoke('confirm', confirmOutline === undefined ? undefined : async () => {
          await draftQueue.current
          const current = draftRef.current
          if (current === null) throw new Error('BID_OUTLINE_DRAFT_INVALID')
          await confirmOutline({ expected_revision: current.revision, expected_draft_sha256: current.draft_outline_sha256 })
        }) }}
      >
        {requestPending === 'confirm' ? t('outline.accept.pending') : t('outline.accept.action')}
      </Button>
    </>
  ) : null
  const outlineRevision = canRegenerate ? (
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
            await draftQueue.current
            const current = draftRef.current
            if (current === null) throw new Error('BID_OUTLINE_DRAFT_INVALID')
            await regenerateOutline({
              feedback,
              expected_revision: current.revision,
              expected_draft_sha256: current.draft_outline_sha256,
            })
            if (alive.current) setOutlineFeedback('')
          })
        }}
      >
        {requestPending === 'revise' ? t('outline.revise.pending') : t('outline.revise.action')}
      </Button>
    </div>
  ) : null

  const mappingPercent = mappingProgress !== null && mappingProgress.total > 0
    ? Math.min(100, Math.round((mappingProgress.completed / mappingProgress.total) * 100))
    : 0
  const queuedFiles: readonly (SelectedFile | SelectedTemplate)[] = selectedTemplate === null
    ? selectedFiles
    : [...selectedFiles, selectedTemplate]

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.body}>
        <div className={css.statusRow}>
          {dotState === undefined
            ? <IconChecklistOutline14 className={css.lead} />
            : <StateDot state={dotState} />}
          <span className={css.stage}>{t(stageKey(displayStage))}</span>
          <span className={css.message} role="status">
            {t(promptKey(displayStage, projection.runtime.status))}
          </span>
          <span className={css.runtimeStatus}>{suspendedRun === undefined ? t(statusKey(projection.runtime.status)) : t('status.suspended')}</span>
        </div>

        {mappingProgress !== null && (
          <div
            className={css.mappingCard}
            role="status"
            aria-label={t('mapping.progress', {
              total: mappingProgress.total,
              initial: mappingProgress.initial,
              supplemental: mappingProgress.supplemental,
              completed: mappingProgress.completed,
              running: mappingProgress.running,
              notStarted: mappingProgress.not_started,
            })}
          >
            <span className={css.srOnly}>
              {t('mapping.progress', {
                total: mappingProgress.total,
                initial: mappingProgress.initial,
                supplemental: mappingProgress.supplemental,
                completed: mappingProgress.completed,
                running: mappingProgress.running,
                notStarted: mappingProgress.not_started,
              })}
            </span>
            <div className={css.mappingHeader}>
              <div className={css.mappingTitleGroup}>
                <span className={css.mappingTitle}>{t('mapping.tasks.title')}</span>
                <span className={css.mappingRatio}>
                  {mappingProgress.completed} / {mappingProgress.total} ({mappingPercent}%)
                </span>
              </div>
              <div className={css.mappingPills}>
                <span className={`${css.pill} ${css.pillDefault}`}>
                  {t('mapping.tasks.initial', { count: mappingProgress.initial })}
                </span>
                {mappingProgress.supplemental > 0 && (
                  <span className={`${css.pill} ${css.pillDefault}`}>
                    {t('mapping.tasks.supplemental', { count: mappingProgress.supplemental })}
                  </span>
                )}
                {mappingProgress.running > 0 && (
                  <span className={`${css.pill} ${css.pillRunning}`}>
                    <span className={css.runningDot} />
                    {t('mapping.tasks.running', { count: mappingProgress.running })}
                  </span>
                )}
                {mappingProgress.completed > 0 && (
                  <span className={`${css.pill} ${css.pillCompleted}`}>
                    {t('mapping.tasks.completed', { count: mappingProgress.completed })}
                  </span>
                )}
                {mappingProgress.not_started > 0 && (
                  <span className={`${css.pill} ${css.pillPending}`}>
                    {t('mapping.tasks.not_started', { count: mappingProgress.not_started })}
                  </span>
                )}
                {mappingProgress.failed > 0 && (
                  <span className={`${css.pill} ${css.pillFailed}`}>
                    {t('mapping.tasks.failed', { count: mappingProgress.failed })}
                  </span>
                )}
              </div>
            </div>
            <div className={css.mappingProgressTrack} aria-hidden="true">
              <div
                className={css.mappingProgressBar}
                style={{ width: `${mappingPercent}%` }}
              />
            </div>
          </div>
        )}

        {suspendedRun?.cause === 'user_stop' && (
          <p className={css.decisionHint} role="status">{t('run.stopped')}</p>
        )}

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

        {(canConfirm || canConfirmAnalysis) && <Portal container={reviewHost}>
          <div style={{ ...(canConfirm ? { height: '100%', minHeight: 0 } : { minHeight: '100%' }), width: '100%', display: 'flex', flexDirection: 'column' }}>
            {((canConfirm && previewOutline === null) || (canConfirmAnalysis && tenderAnalysis === null)) && <div role="status">
              {errorNotice ?? '正在读取审核内容…'}
            </div>}
            {canConfirm && previewOutline !== null && (
              <OutlineConfirmationReview
                outline={previewOutline}
                confirmation={outlineConfirmation}
                feedback={outlineRevision}
                notice={<>{updatedForConfirmation && <p role="status">{t('outline.updated')}</p>}{errorNotice}</>}
                reviewContext={reviewContext}
                stage={projection.runtime.stage}
                displayMode={projection.runtime.stage === 'evidence_mapping' ? 'final_candidate' : 'initial'}
                draftSaveState={draftSaveState}
                revision={draft?.revision}
                onUpdateSection={updateSection}
                onStructureOperation={structureOperation}
                onIndentSection={indentSection}
                onOutdentSection={outdentSection}
                t={t}
              />
            )}

            {canConfirmAnalysis && tenderAnalysis !== null && (
              <TenderAnalysisReview
                value={tenderAnalysis}
                autoConfirm={confirmationMode === 'automatic' && !automaticAttempts.includes(tenderAutomaticKey)}
                notice={errorNotice}
                pending={requestPending === 'confirm_analysis'}
                t={t}
                onScoringSelectionChange={async (scoringId, selected) => {
                  if (setTenderScoringSelection === undefined) throw new Error('评分项选择接口不可用。')
                  setRequestError(null)
                  try {
                    const next = await setTenderScoringSelection(scoringId, selected)
                    if (alive.current) setTenderAnalysis(next)
                    return next
                  } catch (reason: unknown) {
                    if (alive.current) setRequestError({ message: t('error.action', { message: reason instanceof Error ? reason.message : String(reason) }), issues: [] })
                    throw reason
                  }
                }}
                onConfirm={(operations) => {
                  if (confirmationMode === 'automatic') {
                    if (automaticAttempts.includes(tenderAutomaticKey)) return
                    actions.markAttempted(tenderAutomaticKey)
                  }
                  invoke(
                    'confirm_analysis',
                    confirmTenderAnalysis === undefined ? undefined : () => confirmTenderAnalysis(operations),
                  )
                }}
              />
            )}
          </div>
        </Portal>}

        {projection.runtime.stage === 'file_intake' && queuedFiles.length > 0 && (
          <ul className={css.fileList} aria-label={t('file.selected')}>
            {queuedFiles.map(({ file, role, id, progress, status, error }) => {
              const sizeText = formatFileSize(file.size)
              return (
                <li
                  key={id}
                  className={css.fileRow}
                  style={{ '--bid-file-progress': `${String(progress)}%` } as CSSProperties}
                >
                  <div className={css.fileIconBox}>
                    <IconBrowseOutline16 className={css.fileIcon} />
                  </div>
                  <div className={css.fileInfo}>
                    <div
                      className={css.fileNameText}
                      title={error === undefined ? file.name : `${file.name}: ${error}`}
                    >
                      {file.name}
                    </div>
                    <div className={css.fileMeta}>
                      {sizeText !== '' && <span className={css.fileSize}>{sizeText}</span>}
                      {status === 'failed' && error !== undefined && (
                        <span className={css.fileError}>{error}</span>
                      )}
                    </div>
                  </div>
                  <span className={`${css.roleBadge} ${css[`role_${role}`]}`}>
                    {role === 'docx_template' ? t('action.upload_docx_template') : t(`file.role.${role}`)}
                  </span>
                  <button
                    type="button"
                    className={css.removeFile}
                    aria-label={`${t('file.remove')}: ${file.name}`}
                    disabled={requestPending !== null}
                    onClick={() => {
                      if (role === 'docx_template') updateSelectedTemplate(() => null)
                      else updateSelectedFiles(files => files.filter(item => item.id !== id))
                      setRequestError(null)
                    }}
                  >
                    <IconCloseOutline16 />
                  </button>
                  {status === 'uploading' && progress > 0 && progress < 100 && (
                    <div className={css.fileProgressBar} />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {projection.runtime.stage === 'file_intake' && (
          <div aria-label="Word 模板">
            <input ref={docxTemplateInput} className={css.fileInput} type="file" accept=".docx" onChange={selectedDocxTemplate}/>
            {docxTemplateMessage && <p className={css.docxTemplateMessage} role="status">{docxTemplateMessage}</p>}
          </div>
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
                variant="outline"
                icon={<IconPaperclipOutline16 />}
                disabled={requestPending !== null || docxLibrary === null}
                title={
                  docxLibrary?.estimateTemplateId
                    ? `当前页数基准模板：${docxLibrary.templates.find(t => t.id === docxLibrary.estimateTemplateId)?.name ?? '已配置'}（点击更换）`
                    : '用于正文页数估算与排版；模板不会进入招标资料库'
                }
                onClick={() => { docxTemplateInput.current?.click() }}
              >
                {t('action.upload_docx_template')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={
                  requestPending !== null
                  || (selectedFiles.length === 0 && selectedTemplate === null)
                }
                onClick={() => { invoke('upload', uploadSelectedFiles) }}
              >
                {requestPending === 'upload' ? t('action.uploading') : t('action.upload')}
              </Button>
            </>
          )}
          {canStart && (
            <Button
              size="sm"
              variant="primary"
              icon={<IconCheckOutline14 />}
              disabled={requestPending !== null || startStage === undefined}
              title={startStage === undefined ? t('action.unavailable') : undefined}
              onClick={() => { invoke('start', startStage) }}
            >
              {requestPending === 'start' ? t('action.starting') : t('action.start_stage')}
            </Button>
          )}
        </div>

        {!canConfirm && !canConfirmAnalysis && errorNotice}
      </div>
    </section>
  )
}
