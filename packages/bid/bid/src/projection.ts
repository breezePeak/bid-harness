import { z } from 'zod'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { BidClientProjection, BidRuntimeState } from './control-plane-contract.ts'
import { BID_CLIENT_ACTIONS, BID_STAGES, STAGE_RUN_STATUSES } from './control-plane-contract.ts'
import {
  BID_INITIAL_RUNTIME_STATE,
  getBidClientProjection,
  reduceBidRuntimeState,
} from './runtime-state.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Replayable Bid state derived from the shared session log. */
    'bid.runtime': BidRuntimeState
  }

  interface SessionProjectionMap {
    /** Host-authorized Bid state and client capabilities. */
    'bid.runtime': BidClientProjection
  }
}

const runtimeSchema = z.object({
  stage: z.enum(BID_STAGES),
  status: z.enum(STAGE_RUN_STATUSES),
})

const clientProjectionSchema = z.object({
  runtime: runtimeSchema,
  allowedActions: z.array(z.enum(BID_CLIENT_ACTIONS)),
  composer: z.union([
    z.object({ enabled: z.literal(true) }),
    z.object({
      enabled: z.literal(false),
      reason: z.enum([
        'bid.upload_required',
        'bid.stage_pending',
        'bid.stage_running',
        'bid.outline_confirmation_required',
        'bid.stage_failed',
        'bid.completed',
      ]),
    }),
  ]),
})

/**
 * Register the whole-value `bid.runtime` unit with the shared session projection registry.
 * @param registry - host projection registry that owns event driving and client delivery.
 * @returns the registration disposer.
 */
export function registerBidRuntimeProjection(registry: SessionProjectionRegistry): () => void {
  return registry.register({
    key: 'bid.runtime',
    stateSchema: runtimeSchema,
    init: () => BID_INITIAL_RUNTIME_STATE,
    apply: reduceBidRuntimeState,
    wire: {
      viewSchema: clientProjectionSchema,
      view: getBidClientProjection,
    },
    stateVersion: 1,
  })
}
