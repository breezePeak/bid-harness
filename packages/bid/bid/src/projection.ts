import { z } from 'zod'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { BidClientProjection, BidControlState } from './control-plane-contract.ts'
import { BID_CLIENT_ACTIONS, BID_RUNTIME_PROJECTION_KEY } from './control-plane-contract.ts'
import {
  BID_INITIAL_CONTROL_STATE,
  bidControlStateSchema,
  bidRunSchema,
  bidWorkflowSchema,
  getBidClientProjection,
  reduceBidControlState,
} from './runtime-state.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Replayable Bid state derived from the shared session log. */
    [BID_RUNTIME_PROJECTION_KEY]: BidControlState
  }

}

const clientProjectionSchema = z.object({
  workflow: bidWorkflowSchema,
  run: bidRunSchema.nullable(),
  runtime: z.object({
    stage: z.enum(['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export']),
    status: z.enum(['pending', 'waiting_start', 'running', 'waiting_user', 'attention_required', 'failed', 'completed']),
    failureReason: z.string().optional(),
    failureIssues: z.array(z.object({
      code: z.string(), message: z.string(), artifact: z.string().optional(), path: z.string().optional(),
    }).strict()).readonly().optional(),
  }).strict(),
  allowedActions: z.array(z.enum(BID_CLIENT_ACTIONS)),
  composer: z.union([
    z.object({ enabled: z.literal(true) }),
    z.object({
      enabled: z.literal(false),
      reason: z.enum([
        'bid.upload_required',
        'bid.stage_pending',
        'bid.stage_running',
        'bid.stage_start_required',
        'bid.tender_analysis_confirmation_required',
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
    stateSchema: bidControlStateSchema,
    init: () => BID_INITIAL_CONTROL_STATE,
    apply: reduceBidControlState,
    wire: {
      viewSchema: clientProjectionSchema,
      view: state => getBidClientProjection(state, fileLimits),
    },
    stateVersion: 10,
  })
}
