import { z } from 'zod'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { BidClientProjection, BidRuntimeState } from './control-plane-contract.ts'
import { BID_CLIENT_ACTIONS, BID_RUNTIME_PROJECTION_KEY, BID_STAGES, STAGE_RUN_STATUSES } from './control-plane-contract.ts'
import {
  BID_INITIAL_RUNTIME_STATE,
  getBidClientProjection,
  reduceBidRuntimeState,
} from './runtime-state.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Replayable Bid state derived from the shared session log. */
    [BID_RUNTIME_PROJECTION_KEY]: BidRuntimeState
  }

}

const runtimeSchema = z.object({
  stage: z.enum(BID_STAGES),
  status: z.enum(STAGE_RUN_STATUSES),
  failureReason: z.string().optional(),
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
  allowedExtensions: z.array(z.string()).optional(),
  maxFiles: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxTotalBytes: z.number().int().positive().optional(),
})

/**
 * Register the whole-value `bid.runtime` unit with the shared session projection registry.
 * @param registry - host projection registry that owns event driving and client delivery.
 * @param fileLimits - Host-configured file constraints included in every client view.
 * @returns the registration disposer.
 */
export function registerBidRuntimeProjection(
  registry: SessionProjectionRegistry,
  fileLimits: Pick<
    BidClientProjection,
    'allowedExtensions' | 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes'
  > = {},
): () => void {
  return registry.register({
    key: BID_RUNTIME_PROJECTION_KEY,
    stateSchema: runtimeSchema,
    init: () => BID_INITIAL_RUNTIME_STATE,
    apply: reduceBidRuntimeState,
    wire: {
      viewSchema: clientProjectionSchema,
      view: state => getBidClientProjection(state, fileLimits),
    },
    stateVersion: 4,
  })
}
