import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  BidControlState,
  BidRunDecision,
  BidRunDecisionType,
  BidRunSnapshot,
  BidRunNotice,
  BidRuntimeState,
  BidStage,
  StageArtifact,
  StageValidationIssue,
} from './control-plane-contract.ts'
import type { WritingEntryView } from './writing-entry-contract.ts'

/** Bid events persisted in the shared DSH session log. */
export const BID_SESSION_EVENT_TYPES = [
  'bid.project.resumed',
  'bid.run.started',
  'bid.run.start_failed',
  'bid.run.cancelling',
  'bid.run.suspended',
  'bid.run.notice',
  'bid.run.completed',
  'bid.workflow.failed',
  'bid.stage.started',
  'bid.stage.completed',
  'bid.stage.attention_required',
  'bid.stage.failed',
  'bid.stage.reset',
  'bid.run.decision.required',
  'bid.run.decision.received',
  'bid.user_confirmation.required',
  'bid.user_confirmation.received',
  'bid.writing_entry.changed',
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
    'bid.project.resumed': ({ runtime: BidRuntimeState } | BidControlState) & { revision: number }
    /** One exact stage execution attempt became active. */
    'bid.run.started': { run: BidRunSnapshot }
    /** The running-state checkpoint failed before execution authority was granted. */
    'bid.run.start_failed': { runId: string; epoch: number }
    /** One exact execution attempt is draining before it can become resumable. */
    'bid.run.cancelling': { run: BidRunSnapshot & { status: 'cancelling' } }
    /** One exact execution attempt stopped without changing business progress. */
    'bid.run.suspended': { run: BidRunSnapshot & { status: 'suspended' } }
    /** Model-invisible terminal Run row for the conversation timeline. */
    'bid.run.notice': BidRunNotice
    /** One exact execution attempt settled after committing its stage outcome. */
    'bid.run.completed': { run: BidRunSnapshot & { status: 'completed' } }
    /** Project progress cannot be continued or reconciled safely. */
    'bid.workflow.failed': { stage: BidStage; reason: string; issues?: StageValidationIssue[] }
    /** A stage began execution and is the control plane's current running stage. */
    'bid.stage.started': { stage: BidStage; status: 'running' }
    /** A stage passed validation; artifacts remain in the workspace at these references. */
    'bid.stage.completed': { stage: BidStage; status: 'completed'; artifacts: StageArtifact[] }
    /**
     * A stage retained usable artifacts but exhausted a bounded business correction.
     * @param stage Stage whose current artifacts remain readable.
     * @param status Stable recoverable status.
     * @param reason Short user-visible summary.
     * @param issues Browser-safe unmet business conditions.
     */
    'bid.stage.attention_required': { stage: BidStage; status: 'attention_required'; reason: string; issues: StageValidationIssue[] }
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
    /** Native DSH question required before a suspended Run or reset stage can proceed. */
    'bid.run.decision.required': {
      decisionKey: string
      stage: BidStage
      runId: string
      decisionType: BidRunDecisionType
      question: AskUserQuestionItem
    }
    /** The explicit option selected for one previously requested native question. */
    'bid.run.decision.received': {
      decisionKey: string
      stage: BidStage
      runId: string
      decisionType: BidRunDecisionType
      decision: BidRunDecision
    }
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
    /** S5 写作入口状态变更；广播安全摘要，不包含答案原文。 */
    'bid.writing_entry.changed': { view: WritingEntryView }
  }
}

/** Bid-owned projection of the declaration-merged DSH session event map. */
export type BidSessionEventMap = Pick<SessionEventMap, BidSessionEventType>
