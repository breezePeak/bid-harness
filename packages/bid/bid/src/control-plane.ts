/**
 * Browser-safe Bid control-plane data contracts and pure state rules.
 *
 * @module @deepseek-ai/dsh-bid/control-plane
 */

export {
  BID_CLIENT_ACTIONS,
  BID_STAGES,
  STAGE_RUN_STATUSES,
} from './control-plane-contract.ts'
export type {
  BidClientAction,
  BidClientProjection,
  BidComposerReason,
  BidPromptAdmission,
  BidRuntimeState,
  BidStage,
  BidStageExecutor,
  BidStagePolicy,
  BidStageTask,
  StageArtifact,
  StageRunStatus,
  StageValidationIssue,
  StageValidationResult,
} from './control-plane-contract.ts'
export { BID_SESSION_EVENT_TYPES } from './bid-events.ts'
export type { BidSessionEventMap, BidSessionEventType } from './bid-events.ts'
export {
  BID_INITIAL_RUNTIME_STATE,
  buildBidStageTask,
  getBidClientProjection,
  getBidStagePolicy,
  reduceBidRuntimeState,
} from './runtime-state.ts'
