import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  BidRunData,
  BidRunDecision,
  BidRunDecisionType,
  BidRunProgress,
  BidRunNotice,
  BidStage,
  BidTaskFailure,
  BidTaskState,
  StageArtifact,
  StageValidationIssue,
} from './control-plane-contract.ts'
import type { LegacyBidControlState, LegacyBidRuntimeState } from './runtime-state.ts'
import type { WritingEntryView } from './writing-entry-contract.ts'
import type { DocxExportOperation } from './docx-export-operation.ts'

/** Bid events persisted in the shared DSH session log. */
export const BID_SESSION_EVENT_TYPES = [
  'bid.project.resumed',
  'bid.task.changed',
  'bid.run.started',
  'bid.run.progress',
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
  'bid.docx_export.changed',
  'bid.schema.warning',
  'bid.goal.bound',
  'bid.goal.recovery.requested',
] as const

/** One Bid Harness event type persisted in the shared DSH session log. */
export type BidSessionEventType = typeof BID_SESSION_EVENT_TYPES[number]

/** 非阻断的 schema_version 诊断原因。 */
export type BidSchemaWarningReason = 'mismatch' | 'missing' | 'invalid'

/** 只记录 schema_version 异常，不参与任何运行时决策。 */
export interface BidSchemaWarning {
  warningId: string
  stage: BidStage | null
  artifact: string
  expected: number
  observed: unknown
  reason: BidSchemaWarningReason
  message: string
}

/**
 * Inspect a record-only schema version at a Host boundary.
 * @param artifact Stable artifact label used for deduplication and display.
 * @param expected Version written by the current implementation.
 * @param observed Raw schema_version value from decoded JSON.
 * @param stage Current Bid stage, when known.
 * @returns A diagnostic payload, or undefined when the value is current.
 */
export function createBidSchemaWarning(
  artifact: string,
  expected: number,
  observed: unknown,
  stage: BidStage | null,
): BidSchemaWarning | undefined {
  const valid = typeof observed === 'number' && Number.isInteger(observed) && observed > 0
  if (valid && observed === expected) return undefined
  const reason: BidSchemaWarningReason = observed === undefined ? 'missing' : valid ? 'mismatch' : 'invalid'
  return {
    warningId: `schema:${artifact}:${String(expected)}:${JSON.stringify(observed)}`,
    stage,
    artifact,
    expected,
    observed,
    reason,
    message: reason === 'missing'
      ? `${artifact} 缺少 schema_version，已按当前版本继续。`
      : `${artifact} 的 schema_version=${JSON.stringify(observed)} 与当前版本 ${String(expected)} 不同或无效，已继续。`,
  }
}

/** Append one schema warning per artifact/version/value tuple in a Session. */
export function appendBidSchemaWarning(
  session: Session,
  warning: BidSchemaWarning | undefined,
): boolean {
  if (warning === undefined) return false
  if (session.events.some(event =>
    event.type === 'bid.schema.warning'
    && event.data.warningId === warning.warningId,
  )) return false

  session.append('bid.schema.warning', warning)
  return true
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 将 Workspace 的项目进度应用到当前聊天的 Bid 投影，不附带聊天历史。
     * @param state 已持久化的项目任务状态。
     * @param revision 项目状态文件的修订号。
     */
    'bid.project.resumed': (
      | { state: BidTaskState }
      | LegacyBidControlState
      | { runtime: LegacyBidRuntimeState }
    ) & { revision: number }
    /** One Host-owned transition of the authoritative task state. */
    'bid.task.changed': { state: BidTaskState }
    /** One exact stage execution attempt became active. */
    'bid.run.started': { run: BidRunData }
    /** Latest bounded milestone for the exact active Run identity. */
    'bid.run.progress': { runId: string; epoch: number; stage: BidStage; progress: BidRunProgress }
    /** The running-state checkpoint failed before execution authority was granted. */
    'bid.run.start_failed': { runId: string; epoch: number }
    /** One exact execution attempt is draining before it can become resumable. */
    'bid.run.cancelling': { runId: string; epoch: number; stage: BidStage }
    /** One exact execution attempt stopped without changing business progress. */
    'bid.run.suspended': { run: BidRunData & { cause: import('./control-plane-contract.ts').BidRunSuspensionCause; error?: BidTaskFailure } }
    /** Model-invisible terminal Run row for the conversation timeline. */
    'bid.run.notice': BidRunNotice
    /** One exact execution attempt settled after committing its stage outcome. */
    'bid.run.completed': { run: BidRunData }
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
    /** Legacy reset event retained only for historical Session replay. */
    'bid.stage.reset': { stage: BidStage; status?: 'pending' | 'waiting_start' | 'ready' | 'waiting_user' }
    /** Native DSH question required before a suspended Run can proceed; stage_start is legacy replay data. */
    'bid.run.decision.required': {
      decisionKey: string
      stage: BidStage
      runId: string
      decisionType: BidRunDecisionType | 'stage_start'
      question: AskUserQuestionItem
    }
    /** The explicit option selected for one previously requested native question. */
    'bid.run.decision.received': {
      decisionKey: string
      stage: BidStage
      runId: string
      decisionType: BidRunDecisionType | 'stage_start'
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
    /**
     * Independent Word export milestone; contains only bounded task metadata.
     * @mode emit
     * @param operation Latest export state, separate from the main Bid task.
     * @dshScopeScan unsupported
     */
    'bid.docx_export.changed': { operation: DocxExportOperation }
    /** schema_version 诊断；不改变 stage、gate、run 或可用动作。 */
    'bid.schema.warning': BidSchemaWarning
    /**
     * Host-bound native Goal for one S2 entry; later stages reuse its identity.
     * @mode emit
     * @param goalId Native Goal identity.
     * @param ownerSessionId Main Session identity.
     * @param initialS2WorkId Admitted S2 work identity.
     */
    'bid.goal.bound': { goalId: string; ownerSessionId: string; initialS2WorkId: string }
    /**
     * One accepted, durable recovery instruction for the exact failed work.
     * @mode emit
     * @param goalId Native Goal authorizing this recovery.
     * @param ownerSessionId Main Session identity.
     * @param target Exact failed Run or writing request.
     * @param unit Failed business unit.
     * @param instruction Bounded sanitized repair instruction.
     * @param progressFingerprint Business problem and checkpoint before recovery.
     */
    'bid.goal.recovery.requested': {
      goalId: string
      ownerSessionId: string
      target: { kind: 'run'; workId: string; runId: string } | { kind: 'writing_plan'; requestId: string; attemptId: string }
      unit: string
      instruction: string
      progressFingerprint: string
    }
  }
}

/** Bid-owned projection of the declaration-merged DSH session event map. */
export type BidSessionEventMap = Pick<SessionEventMap, BidSessionEventType>
