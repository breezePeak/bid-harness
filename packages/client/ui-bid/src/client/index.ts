/**
 * Bid Session browser plugin. It renders the Host-computed `bid.runtime` projection
 * in `conversation.input.dock`, mirrors `projection.composer` into the existing
 * per-session composer block registry, and carries selected files through the
 * generated Bid Remote. It folds no Bid events and owns no Bid business state.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BidDocumentRole, BidUploadFile } from '@deepseek-ai/dsh-bid/control-plane'
// Type-only: pulls the generated Bid Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap and ctx.conversation merges.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale registry merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BidStagePanel } from './BidStagePanel.tsx'
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

/** Callbacks supplied to the Bid panel without exposing client services. */
export interface BidStagePanelInjected {
  /** Mirror the Host composer capability into the existing session block. */
  setComposerBlock: (reason: string | undefined) => void
  /**
   * Submit browser-selected files through the dedicated Bid Host action.
   * @param files - complete file batch selected for one intake attempt.
   * @returns after Host admission, import, validation, and persistence settle.
   */
  uploadFiles: (files: readonly BidSelectedFile[]) => Promise<void>
  /** Host retry action, installed when the Bid action API is composed. */
  retryStage?: () => Promise<void>
  /** Host outline-confirmation action, installed when the Bid action API is composed. */
  confirmOutline?: (confirmed: boolean) => Promise<void>
}

/** Required services for the dock registration, copy, composer block, and Bid Host action. */
export const inject = ['slots', 'locale', 'conversation', 'remote', 'remote.bid']

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

async function encodeFile({ file, role }: BidSelectedFile): Promise<BidUploadFile> {
  return {
    name: file.name,
    role,
    ...(file.type === '' ? {} : { mediaType: file.type }),
    size: file.size,
    data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  }
}

/** Encode the selected batch serially so browser memory never holds every source ArrayBuffer at once. */
async function encodeFiles(files: readonly BidSelectedFile[]): Promise<BidUploadFile[]> {
  const encoded: BidUploadFile[] = []
  for (const file of files) encoded.push(await encodeFile(file))
  return encoded
}

function actionFailure(error: { readonly code: string; readonly message: string }): Error {
  return new Error(`${error.message} (${error.code})`)
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
      setComposerBlock: (reason) => {
        ctx.conversation.blocks.set(
          sessionId,
          reason === undefined ? undefined : { reason },
        )
      },
      retryStage: async () => {
        const result = await ctx.remote.bid.retryStage(sessionId)
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
      uploadFiles: async (files) => {
        const result = await ctx.remote.bid.uploadFiles(
          sessionId,
          await encodeFiles(files),
        )
        if (!result.ok) throw actionFailure(result.error)
        if (!result.value.ok) throw actionFailure(result.value.error)
      },
    }),
  }, BidStagePanel))
}
