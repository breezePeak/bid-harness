import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser-only confirmation behavior for one Bid Session. */
export type BidConfirmationMode = 'manual' | 'automatic'

/** UI preference and submitted automatic identities for one mounted Session. */
export interface BidConfirmationModeState {
  mode: BidConfirmationMode
  attempted: string[]
}

type BidConfirmationModeActions = {
  setMode: (draft: BidConfirmationModeState, mode: BidConfirmationMode) => void
  markAttempted: (draft: BidConfirmationModeState, key: string) => void
  clearAttempted: (draft: BidConfirmationModeState, key: string) => void
}

/**
 * Declare the per-session Bid confirmation preference.
 * @returns a Session-scoped store handle with manual mode as its default.
 */
export function createBidConfirmationModeStore(): EngineStoreHandle<BidConfirmationModeState, BidConfirmationModeActions> {
  return defineStore({
    init: (): BidConfirmationModeState => ({ mode: 'manual', attempted: [] }),
    actions: {
      setMode: (draft, mode: BidConfirmationMode) => { draft.mode = mode },
      markAttempted: (draft, key: string) => {
        if (!draft.attempted.includes(key)) draft.attempted.push(key)
      },
      clearAttempted: (draft, key: string) => {
        const index = draft.attempted.indexOf(key)
        if (index >= 0) draft.attempted.splice(index, 1)
      },
    },
  })
}
