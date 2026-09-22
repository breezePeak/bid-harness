import { z } from 'zod'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { BidClientProjection, BidTaskState } from './control-plane-contract.ts'
import { BID_CLIENT_ACTIONS, BID_RUNTIME_PROJECTION_KEY } from './control-plane-contract.ts'
import {
  BID_INITIAL_TASK_STATE,
  bidTaskStateSchema,
  getBidClientProjection,
  reduceBidTaskState,
} from './runtime-state.ts'
import {
  BID_WRITING_ENTRY_PROJECTION_KEY,
  writingEntryViewSchema,
  type WritingEntryView,
} from './writing-entry-contract.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Client-visible Bid runtime projection. */
    [BID_RUNTIME_PROJECTION_KEY]: BidClientProjection
    /** Client-visible S5 writing entry view. */
    [BID_WRITING_ENTRY_PROJECTION_KEY]: WritingEntryView | null
  }

  interface SessionProjectionStateMap {
    /** Replayable Bid state derived from the shared session log. */
    [BID_RUNTIME_PROJECTION_KEY]: BidTaskState
    /** Replayable S5 writing entry view derived from bid.writing_entry.changed events. */
    [BID_WRITING_ENTRY_PROJECTION_KEY]: WritingEntryView | null
  }

}

const clientProjectionSchema = z.object({
  task: bidTaskStateSchema,
  allowedActions: z.array(z.enum(BID_CLIENT_ACTIONS)),
  composer: z.union([
    z.object({ enabled: z.literal(true) }),
    z.object({
      enabled: z.literal(false),
      reason: z.enum([
        'bid.upload_required',
        'bid.stage_pending',
        'bid.stage_running',
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
    stateSchema: bidTaskStateSchema,
    init: () => BID_INITIAL_TASK_STATE,
    apply: reduceBidTaskState,
    wire: {
      viewSchema: clientProjectionSchema,
      view: state => getBidClientProjection(state, fileLimits),
    },
    stateVersion: 12,
  })
}
/**
 * Register the S5 writing entry projection with the shared session projection registry.
 * @param registry - host projection registry that owns event driving and client delivery.
 * @returns the registration disposer.
 */
export function registerBidWritingEntryProjection(
  registry: SessionProjectionRegistry,
): () => void {
  return registry.register({
    key: BID_WRITING_ENTRY_PROJECTION_KEY,
    stateSchema: writingEntryViewSchema.nullable(),
    init: () => null,
    apply: (state: WritingEntryView | null, event): WritingEntryView | null =>
      event.type === 'bid.writing_entry.changed' ? event.data.view : state,
    wire: {
      viewSchema: writingEntryViewSchema.nullable(),
      view: (state: WritingEntryView | null) => state,
    },
    stateVersion: 1,
  })
}
