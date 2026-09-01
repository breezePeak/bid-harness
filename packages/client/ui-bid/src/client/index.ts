/**
 * Bid Session browser plugin. It renders the Host-computed `bid.runtime` projection
 * in `conversation.input.dock`, mirrors `projection.composer` into the existing
 * per-session composer block registry, and carries selected files through the
 * generated Bid Remote. It folds no Bid events and owns no Bid business state.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { OUTLINE_CONFIRMATION_ISSUES, type BidDocumentRole, type BidFileIntakeFileResult, type BidUploadFile, type OutlineConfirmationIssueCode, type OutlineConfirmationRepairAction, type OutlineDraftMutationRequest, type OutlineDraftView, type StageValidationIssue, type TenderAnalysisConfirmationView, type TenderAnalysisEditOperation } from '@deepseek-ai/dsh-bid/control-plane'
// Type-only: pulls the generated Bid Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap and ctx.conversation merges.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale registry merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BidStagePanel } from './BidStagePanel.tsx'
import { BidReviewWorkbench, type BidReviewChapterView, type BidReviewWorkbenchView } from './BidReviewWorkbench.tsx'
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
  /** Mirror the Host composer capability into the existing session block. */
  setComposerBlock: (reason: string | undefined, embedded?: boolean) => void
  /** Switch the current Session to the registered review-items view. */
  selectReviewView: () => void
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
  /** Host outline-confirmation action, installed when the Bid action API is composed. */
  getOutlineDraft?: () => Promise<OutlineDraftView>
  applyOutlineDraftOperations?: (request: OutlineDraftMutationRequest) => Promise<OutlineDraftView>
  confirmOutline?: (request: { expected_revision: number; expected_draft_sha256: string }) => Promise<void>
  /** Host outline-regeneration action, installed when the Bid action API is composed. */
  regenerateOutline?: (request: { feedback: string; expected_revision: number; expected_draft_sha256: string }) => Promise<void>
  /** Host tender-analysis review actions, installed when the Bid action API is composed. */
  getTenderAnalysisForConfirmation?: () => Promise<TenderAnalysisConfirmationView>
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

/** Encode arbitrary bytes without overflowing `String.fromCharCode` argument limits. */
function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(parts.join(''))
}

/** Encode one immutable browser File for the JSON-safe Bid Remote request. */
/** Browser material paired with its selected business role. */
export interface BidSelectedFile { readonly file: File; readonly role: BidDocumentRole }

async function encodeFile({ file, role }: BidSelectedFile, onProgress?: (progress: number) => void): Promise<BidUploadFile> {
  onProgress?.(10)
  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress?.(30)
  return {
    name: file.name,
    role,
    ...(file.type === '' ? {} : { mediaType: file.type }),
    size: file.size,
    data: bytesToBase64(bytes),
  }
}

/** Encode the selected batch serially so browser memory never holds every source ArrayBuffer at once. */
async function encodeFiles(
  files: readonly BidSelectedFile[],
  onProgress?: (file: BidSelectedFile, progress: number) => void,
): Promise<BidUploadFile[]> {
  const encoded: BidUploadFile[] = []
  for (const file of files) {
    encoded.push(await encodeFile(file, progress => onProgress?.(file, progress)))
    onProgress?.(file, 40)
  }
  return encoded
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-bid: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'bid',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): BidStagePanelInjected => ({
      setComposerBlock: (reason, embedded) => {
        ctx.conversation.blocks.set(
          sessionId,
          reason === undefined && embedded !== true ? undefined : { reason: reason ?? '', ...(embedded === true ? { embedded: true } : {}) },
        )
      },
      selectReviewView: () => {
        const scoped = (ctx.sessions as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined }).scope?.(sessionId)
        const conversation = scoped?.get('conversation') as { selectView?: (viewId: string) => void } | undefined
        conversation?.selectView?.('bid-review')
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
      confirmTenderAnalysis: async (operations) => {
        const result = await ctx.remote.bid.confirmTenderAnalysis(sessionId, operations)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      uploadFiles: async (files, onProgress) => {
        const encoded = await encodeFiles(files, onProgress)
        for (const file of files) onProgress?.(file, 50)
        const result = await ctx.remote.bid.uploadFiles(
          sessionId,
          encoded,
        )
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) {
          throw actionFailure(result.value.error)
        }
        const fileResults = result.value.files ?? files.map(({ file, role }) => ({ name: file.name, role, status: 'completed' as const }))
        for (const file of files) {
          onProgress?.(file, 100)
        }
        return fileResults
      },
    }),
  }, BidStagePanel))
  ctx.slots.register({
    name: 'conversation.view',
    id: 'bid-review',
    order: 10,
    label: () => '审核项',
    embeddedChat: true,
    inject: (sessionId: SessionId) => {
      const remote = ctx.remote.bid as unknown as {
        getReviewWorkbench(id: SessionId): Promise<{ ok: boolean; value: unknown }>
        getReviewChapter(id: SessionId, sectionId: string): Promise<{ ok: boolean; value: unknown }>
        completeReview(id: SessionId): Promise<{ ok: boolean; value: { ok: boolean; error?: { code: string; message: string } } }>
        retryStage(id: SessionId): Promise<{ ok: boolean; value: { ok: boolean; error?: { code: string; message: string } } }>
      }
      const conversation = (ctx.sessions as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined }).scope?.(sessionId)?.get('conversation') as {
        setEmbeddedSurface?: (kind: 'chat' | 'composer' | 'review', element: HTMLElement | null) => void
      } | undefined
      return {
        getWorkbench: async () => {
          const result = await remote.getReviewWorkbench(sessionId)
          if (!result.ok) throw new Error('BID_REVIEW_NOT_ALLOWED')
          return result.value as BidReviewWorkbenchView
        },
        getChapter: async (sectionId: string) => {
          const result = await remote.getReviewChapter(sessionId, sectionId)
          if (!result.ok) throw new Error('BID_REVIEW_NOT_ALLOWED')
          return result.value as BidReviewChapterView
        },
        completeReview: async () => {
          const result = await remote.completeReview(sessionId)
          if (!result.ok) throw new Error('BID_REVIEW_COMPLETE_FAILED')
          if (!result.value.ok) throw new Error(result.value.error?.message ?? 'BID_REVIEW_COMPLETE_FAILED')
        },
        retryStage: async () => {
          const result = await remote.retryStage(sessionId)
          if (!result.ok) throw new Error('BID_RETRY_FAILED')
          if (!result.value.ok) throw new Error(result.value.error?.message ?? 'BID_RETRY_FAILED')
        },
        setEmbeddedSurface: (kind, element) => { conversation?.setEmbeddedSurface?.(kind, element) },
      }
    },
  }, BidReviewWorkbench)
}
