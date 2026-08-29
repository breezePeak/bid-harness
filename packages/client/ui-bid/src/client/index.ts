/**
 * Bid Session browser plugin. It renders the Host-computed `bid` projection
 * in `conversation.input.dock` and mirrors only `projection.composer` into the
 * existing per-session composer block registry. It folds no Bid events and
 * owns no Bid stage, status, or permission state.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
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
  /** Host retry action, installed when the Bid action API is composed. */
  retryStage?: () => Promise<void>
  /** Host outline-confirmation action, installed when the Bid action API is composed. */
  confirmOutline?: (confirmed: boolean) => Promise<void>
}

/** Required services for the dock registration, copy, and composer block. */
export const inject = ['slots', 'locale', 'conversation']

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
      setComposerBlock: reason => ctx.conversation.blocks.set(
        sessionId,
        reason === undefined ? undefined : { reason },
      ),
    }),
  }, BidStagePanel))
}
