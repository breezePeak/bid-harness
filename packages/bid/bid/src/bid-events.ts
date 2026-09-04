import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { BidRuntimeState, BidStage, StageArtifact, StageValidationIssue } from './control-plane-contract.ts'

/** Bid events persisted in the shared DSH session log. */
export const BID_SESSION_EVENT_TYPES = [
  'bid.project.resumed',
  'bid.stage.started',
  'bid.stage.completed',
  'bid.stage.failed',
  'bid.stage.reset',
  'bid.user_confirmation.required',
  'bid.user_confirmation.received',
] as const

/** One Bid Harness event type persisted in the shared DSH session log. */
export type BidSessionEventType = typeof BID_SESSION_EVENT_TYPES[number]

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 将 Workspace 的项目进度应用到当前聊天的 Bid 投影，不附带聊天历史。
     * @param runtime 已持久化的项目控制状态。
     * @param revision 项目状态文件的修订号。
     */
    'bid.project.resumed': { runtime: BidRuntimeState; revision: number }
    /** A stage began execution and is the control plane's current running stage. */
    'bid.stage.started': { stage: BidStage; status: 'running' }
    /** A stage passed validation; artifacts remain in the workspace at these references. */
    'bid.stage.completed': { stage: BidStage; status: 'completed'; artifacts: StageArtifact[] }
    /**
     * A stage failed before validation could authorize a transition.
     * @param stage Failed stage.
     * @param status Stable failed status.
     * @param reason Short user-visible summary.
     * @param issues Browser-safe validation details when validation rejected Artifacts.
     */
    'bid.stage.failed': { stage: BidStage; status: 'failed'; reason: string; issues?: StageValidationIssue[] }
    /**
     * A user command cleared the current and later stages and now waits for an explicit start.
     * @param stage Current stage selected by the scoped reset command.
     * @param status Stable post-reset user gate.
     */
    'bid.stage.reset': { stage: BidStage; status: 'pending' | 'waiting_start' }
    /** A stage is waiting for an explicit user decision. */
    'bid.user_confirmation.required': { stage: BidStage; status: 'waiting_user' }
    /**
     * The explicit user decision received for a stage.
     * @param stage Stage receiving the decision.
     * @param confirmed Whether the user accepts the current artifact.
     * @param feedback Required outline changes when the current outline is rejected.
     */
    'bid.user_confirmation.received':
      | { stage: BidStage; confirmed: true }
      | { stage: 'outline_generation' | 'evidence_mapping'; confirmed: false; feedback: string }
  }
}

/** Bid-owned projection of the declaration-merged DSH session event map. */
export type BidSessionEventMap = Pick<SessionEventMap, BidSessionEventType>
