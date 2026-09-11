/**
 * Bid Session browser plugin. It renders the Host-computed `bid.runtime` projection
 * in `conversation.input.dock`, mirrors `projection.composer` into the existing
 * per-session composer block registry, and carries selected files through
 * dedicated same-origin binary endpoints. It folds no Bid events and owns no
 * Bid business state.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { BID_BINARY_UPLOAD_PATH, BID_UPLOAD_FILES_HEADER, BID_UPLOAD_SESSION_HEADER, DOCX_TEMPLATE_NAME_HEADER, DOCX_TEMPLATE_REVISION_HEADER, DOCX_TEMPLATE_SIZE_HEADER, DOCX_TEMPLATE_UPLOAD_PATH, OUTLINE_CONFIRMATION_ISSUES, parseBidReviewWorkbenchView, type BidDocumentRole, type BidEvidenceMappingProgress, type BidFileIntakeFileResult, type BidFileIntakeResult, type DocxTemplateUploadResult, type OutlineConfirmationIssueCode, type OutlineConfirmationRepairAction, type OutlineDraftMutationRequest, type OutlineDraftView, type OutlineReviewContext, type StageValidationIssue, type TenderAnalysisConfirmationView, type TenderAnalysisEditOperation } from '@deepseek-ai/dsh-bid/control-plane'
// Type-only: pulls the generated Bid Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap and ctx.conversation merges.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale registry merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BidWordExport, type BidWordExportInjected } from './BidWordExport.tsx'
import { BidStagePanel } from './BidStagePanel.tsx'
import { BidDetails } from './BidDetails.tsx'
import type { BidDetailsView } from '@deepseek-ai/dsh-bid/control-plane'
import { BidReviewWorkbench, type BidReviewChapterView } from './BidReviewWorkbench.tsx'
import { BidComposerContext } from './BidComposerContext.tsx'
import { createBidRevisionStore } from './revision-reference.ts'
import { en, zh, type BidKey } from './locales.ts'

export type { BidKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Bid Session panel copy. */
    bid: BidKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'bid'

/** Browser recovery action for every Host-owned S5 issue code. */
export const OUTLINE_CONFIRMATION_REPAIR_ACTIONS = Object.fromEntries(
  Object.entries(OUTLINE_CONFIRMATION_ISSUES).map(([code, definition]) => [code, definition.repair_action]),
) as Readonly<Record<OutlineConfirmationIssueCode, OutlineConfirmationRepairAction>>

/** Callbacks supplied to the Bid panel without exposing client services. */
export interface BidStagePanelInjected {
  /** 读取已发布详情并恢复各标签的可见性。 */
  getDetails: () => Promise<BidDetailsView>
  setDetailsAvailable: (details: BidDetailsView | null, confirmingOutline?: boolean, confirmingTender?: boolean) => void
  /** Mirror the Host composer capability into the existing session block. */
  setComposerBlock: (reason: string | undefined, embedded?: boolean) => void
  /** Switch the current Session to the registered review-items view. */
  selectReviewView: (viewId?: string) => void
  /** Limit the review-items view to a pending user confirmation. */
  setReviewViewAvailable: (available: boolean) => void
  /** Reactive portal destination supplied by the review-items view. */
  reviewSurface: { host: () => HTMLElement | null; subscribe: (listener: () => void) => () => void }
  /**
   * Submit browser-selected files through the dedicated Bid Host action.
   * @param files - complete file batch selected for one intake attempt.
   * @returns after Host admission, import, validation, and persistence settle.
   */
  uploadFiles: (
    files: readonly BidSelectedFile[],
    onProgress?: (file: BidSelectedFile, progress: number) => void,
  ) => Promise<readonly BidFileIntakeFileResult[]>
  /** Host retry action, installed when the Bid action API is composed. */
  retryStage?: () => Promise<void>
  /** Start the current stage after a reset has finished and the user confirms. */
  startStage?: () => Promise<void>
  /** Explicitly stop the running stage without cancelling an unrelated chat response. */
  stopStage?: () => Promise<void>
  /** Host outline-confirmation action, installed when the Bid action API is composed. */
  getOutlineReviewContext?: () => Promise<OutlineReviewContext>
  getOutlineDraft?: () => Promise<OutlineDraftView>
  applyOutlineDraftOperations?: (request: OutlineDraftMutationRequest) => Promise<OutlineDraftView>
  confirmOutline?: (request: { expected_revision: number; expected_draft_sha256: string }) => Promise<void>
  /** Host outline-regeneration action, installed when the Bid action API is composed. */
  regenerateOutline?: (request: { feedback: string; expected_revision: number; expected_draft_sha256: string }) => Promise<void>
  /** Host S4 progress and tender-analysis review actions, installed when the Bid action API is composed. */
  getEvidenceMappingProgress?: () => Promise<BidEvidenceMappingProgress | null>
  getTenderAnalysisForConfirmation?: () => Promise<TenderAnalysisConfirmationView>
  /** Persist one S2 scoring item inclusion decision. */
  setTenderScoringSelection?: (scoringId: string, selected: boolean) => Promise<TenderAnalysisConfirmationView>
  confirmTenderAnalysis?: (operations: readonly TenderAnalysisEditOperation[]) => Promise<void>
}

/** Structured Bid Host rejection retained for actionable panel feedback. */
export class BidActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly issues: readonly StageValidationIssue[] = [],
    public readonly files: readonly BidFileIntakeFileResult[] = [],
  ) { super(message) }
}

/** Required services for the dock registration, copy, composer block, and Bid Host action. */
export const inject = ['slots', 'locale', 'conversation', 'sessions', 'remote', 'remote.bid']

/** Browser material paired with its selected business role. */
export interface BidSelectedFile { readonly file: File; readonly role: BidDocumentRole }

/** Compose the selected original files without base64 expansion or a streaming Fetch body. */
function binaryUploadBody(files: readonly BidSelectedFile[]): Blob {
  return new Blob(files.map(selected => selected.file), { type: 'application/vnd.dsh.bid-upload' })
}

function actionFailure(error: {
  readonly code: string
  readonly message: string
  readonly issues?: readonly StageValidationIssue[] | undefined
  readonly files?: readonly BidFileIntakeFileResult[] | undefined
}): Error {
  return new BidActionError(error.code, `${error.message} (${error.code})`, error.issues, error.files)
}

/**
 * Register the projection-driven Bid panel before the generic input-dock rows.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const revisionStore = createBidRevisionStore()
  const getChapter = async (sessionId: SessionId, sectionId: string): Promise<BidReviewChapterView> => {
    const result = await ctx.remote.bid.getReviewChapter(sessionId, sectionId)
    if (!result.ok) throw actionFailure(result.error)
    return result.value
  }
  const getDetails = async (sessionId: SessionId): Promise<BidDetailsView> => {
    const result = await ctx.remote.bid.getDetails(sessionId)
    if (!result.ok) throw actionFailure(result.error)
    return result.value
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-bid: dictionaries')
  ctx.slots.inject('conversation.input.context', () => ctx.slots.register({
    name: 'conversation.input.context',
    id: 'bid-revision',
    store: revisionStore,
    inject: (sessionId: SessionId) => ({
      getChapter: (sectionId: string) => getChapter(sessionId, sectionId),
      sendMessage: (text: string) => {
        const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
        if (conversation === undefined) return Promise.reject(new Error('当前会话不可用。'))
        return conversation.send(text)
      },
      registerSubmit: (handler: import('@deepseek-ai/dsh-client-ui-conversation/client').ComposerSubmitHandler) =>
        ctx.conversation.submitHandlers.register(sessionId, handler),
    }),
  }, BidComposerContext))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'bid',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): BidStagePanelInjected => ({
      getDetails: () => getDetails(sessionId),
      setDetailsAvailable: (details, confirmingOutline = false, confirmingTender = false) => {
        const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
        conversation?.setViewAvailable('bid-tender', confirmingTender || details?.tender != null)
        conversation?.setViewAvailable('bid-outline', details?.outline != null)
        conversation?.setViewAvailable('bid-confirmation', confirmingOutline)
        if (details) void wordRemote(sessionId).getFormat().then((view) => { conversation?.setViewAvailable('bid-word-export', view.state.opened) }).catch(() => {
          // 配置损坏时仍保留入口，由 Word 页面展示读取错误。
          conversation?.setViewAvailable('bid-word-export', true)
        })
        else conversation?.setViewAvailable('bid-word-export', false)
      },
      setComposerBlock: (reason, embedded) => {
        ctx.conversation.blocks.set(
          sessionId,
          reason === undefined && embedded !== true ? undefined : { reason: reason ?? '', ...(embedded === true ? { embedded: true } : {}) },
        )
      },
      selectReviewView: (viewId = 'bid-review') => {
        const scoped = (ctx.sessions as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined }).scope?.(sessionId)
        const conversation = scoped?.get('conversation') as { selectView?: (viewId: string) => void } | undefined
        conversation?.selectView?.(viewId)
      },
      setReviewViewAvailable: (available) => {
        const scoped = (ctx.sessions as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined }).scope?.(sessionId)
        const conversation = scoped?.get('conversation') as { setViewAvailable?: (viewId: string, next: boolean) => void } | undefined
        conversation?.setViewAvailable?.('bid-review', available)
      },
      reviewSurface: (() => {
        const conversation = (ctx.sessions as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined } | undefined)?.scope?.(sessionId)?.get('conversation') as {
          embeddedSurface?: (kind: 'review') => { host: () => HTMLElement | null; subscribe: (listener: () => void) => () => void }
        } | undefined
        return conversation?.embeddedSurface?.('review') ?? { host: () => null, subscribe: () => () => {} }
      })(),
      retryStage: async () => {
        const result = await ctx.remote.bid.retryStage(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      startStage: async () => {
        const remote = ctx.remote.bid as unknown as {
          startStage(id: SessionId): Promise<{
            ok: boolean
            value: { ok: boolean; error?: Parameters<typeof actionFailure>[0] }
            error: Parameters<typeof actionFailure>[0]
          }>
        }
        const result = await remote.startStage(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error ?? { code: 'BID_STAGE_START_FAILED', message: '阶段启动失败。' })
      },
      stopStage: async () => {
        const remote = ctx.remote.bid as unknown as {
          stopStage(id: SessionId): Promise<{
            ok: boolean
            value: { ok: boolean; error?: Parameters<typeof actionFailure>[0] }
            error: Parameters<typeof actionFailure>[0]
          }>
        }
        const result = await remote.stopStage(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error ?? { code: 'BID_STAGE_STOP_FAILED', message: '阶段停止失败。' })
      },
      getEvidenceMappingProgress: async () => {
        const result = await ctx.remote.bid.getEvidenceMappingProgress(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        return result.value
      },
      getOutlineReviewContext: async () => {
        const result = await ctx.remote.bid.getOutlineReviewContext(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        return result.value
      },
      getOutlineDraft: async () => {
        const result = await ctx.remote.bid.getOutlineDraft(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        return result.value
      },
      applyOutlineDraftOperations: async (request) => {
        const result = await ctx.remote.bid.applyOutlineDraftOperations(sessionId, request)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
        return result.value.value
      },
      confirmOutline: async (request) => {
        const result = await ctx.remote.bid.confirmOutline(sessionId, request)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      regenerateOutline: async (request) => {
        const result = await ctx.remote.bid.regenerateOutline(sessionId, request)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      getTenderAnalysisForConfirmation: async () => {
        const result = await ctx.remote.bid.getTenderAnalysisForConfirmation(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        return result.value
      },
      setTenderScoringSelection: async (scoringId, selected) => {
        const remote = ctx.remote.bid as unknown as {
          setTenderScoringSelection(id: SessionId, itemId: string, included: boolean): Promise<{
            ok: boolean
            value: TenderAnalysisConfirmationView
            error: Parameters<typeof actionFailure>[0]
          }>
        }
        const result = await remote.setTenderScoringSelection(sessionId, scoringId, selected)
        if (!result.ok) throw actionFailure(result.error)
        return result.value
      },
      confirmTenderAnalysis: async (operations) => {
        const result = await ctx.remote.bid.confirmTenderAnalysis(sessionId, operations)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      uploadFiles: async (files, onProgress) => {
        for (const selected of files) onProgress?.(selected, 5)
        const uploadInit: RequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'application/vnd.dsh.bid-upload',
            [BID_UPLOAD_SESSION_HEADER]: sessionId,
            [BID_UPLOAD_FILES_HEADER]: encodeURIComponent(JSON.stringify(files.map(({ file, role }) => ({
              name: file.name,
              role,
              ...(file.type === '' ? {} : { mediaType: file.type }),
              size: file.size,
            })))),
          },
          body: binaryUploadBody(files),
        }
        const response = await fetch(new URL(BID_BINARY_UPLOAD_PATH, window.location.href), uploadInit)
        for (const selected of files) onProgress?.(selected, 95)
        if (!response.ok) throw new Error(`BID_FILE_UPLOAD_HTTP_${String(response.status)}`)
        const result = await response.json() as BidFileIntakeResult
        if (!result.ok) throw actionFailure(result.error)
        const fileResults = result.files ?? files.map(({ file, role }) => ({ name: file.name, role, status: 'completed' as const }))
        for (const file of files) {
          onProgress?.(file, 100)
        }
        return fileResults
      },
    }),
  }, BidStagePanel))
  const wordRemote = (sessionId: SessionId): BidWordExportInjected => {
    type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
    const remote = ctx.remote.bid
    const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw actionFailure(result.error); return result.value }
    return {
      getFormat: async () => unwrap(await remote.getDocxFormat(sessionId)),
      saveFormat: async request => unwrap(await remote.saveDocxFormat(sessionId, request)),
      uploadTemplate: async (file, revision) => {
        const response = await fetch(new URL(DOCX_TEMPLATE_UPLOAD_PATH, window.location.href), {
          method: 'POST',
          headers: {
            'content-type': 'application/vnd.dsh.bid-docx-template',
            [BID_UPLOAD_SESSION_HEADER]: sessionId,
            [DOCX_TEMPLATE_NAME_HEADER]: encodeURIComponent(file.name),
            [DOCX_TEMPLATE_SIZE_HEADER]: String(file.size),
            [DOCX_TEMPLATE_REVISION_HEADER]: String(revision),
          },
          body: file,
        })
        if (!response.ok) throw new Error(`BID_DOCX_TEMPLATE_UPLOAD_HTTP_${String(response.status)}`)
        return unwrap(await response.json() as DocxTemplateUploadResult)
      },
      preview: async () => unwrap(await remote.previewDocx(sessionId)),
      generate: async () => unwrap(unwrap(await remote.exportDocx(sessionId))),
      download: async () => {
        const file = unwrap(await remote.downloadDocx(sessionId))
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
        const link = document.createElement('a'); link.href = url; link.download = file.name; link.click()
        window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
      },
    }
  }
  ctx.slots.register({ name: 'conversation.view', id: 'bid-word-export', order: 11, label: () => '导出 Word', embeddedChat: false, inject: wordRemote }, BidWordExport)
  ctx.slots.register({
    name: 'conversation.view',
    id: 'bid-review',
    order: 10,
    label: () => '正文详情',
    embeddedChat: false,
    store: revisionStore,
    inject: (sessionId: SessionId) => {
      const remote = ctx.remote.bid as unknown as {
        getReviewWorkbench(id: SessionId): Promise<{
          ok: boolean
          value: unknown
          error: Parameters<typeof actionFailure>[0]
        }>
        getReviewChapter(id: SessionId, sectionId: string): Promise<{
          ok: boolean
          value: unknown
          error: Parameters<typeof actionFailure>[0]
        }>
        retryStage(id: SessionId): Promise<{ ok: boolean; value: { ok: boolean; error?: { code: string; message: string } } }>
      }
      return {
        getWorkbench: async () => {
          const result = await remote.getReviewWorkbench(sessionId)
          if (!result.ok) throw actionFailure(result.error)
          return parseBidReviewWorkbenchView(result.value)
        },
        getChapter: async (sectionId: string) => {
          const result = await remote.getReviewChapter(sessionId, sectionId)
          if (!result.ok) throw actionFailure(result.error)
          return result.value as BidReviewChapterView
        },
        openWordExport: () => {
          const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
          conversation?.setViewAvailable('bid-word-export', true)
          conversation?.selectView('bid-word-export')
          return Promise.resolve()
        },
        retryStage: async () => {
          const result = await remote.retryStage(sessionId)
          if (!result.ok) throw new Error('BID_RETRY_FAILED')
          if (!result.value.ok) throw new Error(result.value.error?.message ?? 'BID_RETRY_FAILED')
        },
      }
    },
  }, BidReviewWorkbench)
  for (const [kind, label] of [['tender', '招标书分析'], ['outline', '目录详情'], ['confirmation', '审核项']] as const) {
    ctx.slots.register({
      name: 'conversation.view',
      id: `bid-${kind}`,
      order: kind === 'tender' ? 8 : 9,
      label: () => label,
      embeddedChat: false,
      inject: (sessionId: SessionId) => ({
        kind,
        getDetails: () => getDetails(sessionId),
        setReviewSurface: (element: HTMLElement | null) => {
          ctx.sessions.scope(sessionId)?.get('conversation')?.setEmbeddedSurface('review', element)
        },
      }),
    }, BidDetails)
  }
}
