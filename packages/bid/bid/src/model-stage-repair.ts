import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StageValidationIssue } from './control-plane-contract.ts'
import type { BidRunContext } from './run-coordinator.ts'

/** Default number of Validator-guided repair turns for one model-produced Bid stage. */
export const DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS = 3

/** Operation-local gate that pauses only future stage task scheduling. */
export interface StageSchedulerControl {
  /** Whether the Host currently holds new stage work. */
  paused(): boolean
  /** Permanently reject new work for a retired Run. */
  close(): void
  /** Wait until scheduling resumes or the owning operation is cancelled. */
  waitUntilRunnable(signal: AbortSignal): Promise<void>
}

/** Host-owned repair limit shared by model-produced Bid stages. */
export interface ModelStageExecutionOptions {
  /** Maximum Validator-guided repair turns after the initial model output. */
  maxRepairAttempts: number
  /** Exact Run authority required for cancellation, scheduling, and formal commits. */
  run: BidRunContext
  /** Host-accepted guidance for the exact failed work, never an Artifact field. */
  recovery?: {
    readonly workId: string
    /** 能力步骤的派生 Work 对应的原任务授权；普通阶段与 workId 相同。 */
    readonly authorizationWorkId?: string
    /** 保存恢复授权的主会话。 */
    readonly ownerSessionId?: string
    /** 已接纳 bid.recovery.requested 事件的序号；续跑复用同一授权。 */
    readonly requestSeq?: number
    readonly unit: string
    readonly instruction: string
    readonly issues: readonly StageValidationIssue[]
  }
}

/**
 * Wait for the live Agent to stop, rejecting before further stage work after cancellation.
 * @param agent - live Agent whose active turn must settle.
 * @param signal - optional Host operation cancellation.
 * @returns when the Agent is idle and the operation remains active.
 */
export async function waitForModelStageIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await agent.whenIdle()
  signal.throwIfAborted()
}

/**
 * Render browser-safe Validator issues without exposing Artifact contents.
 * @param issues - Host-produced validation issues for one model stage.
 * @returns compact lines suitable for a repair assignment.
 */
export function renderStageRepairIssues(issues: readonly StageValidationIssue[]): string[] {
  return issues.map((issue, index) => [
    `${index + 1}. ${issue.code}`,
    issue.artifact === undefined ? undefined : `文件=${issue.artifact}`,
    issue.path === undefined ? undefined : `字段=${issue.path}`,
    issue.message,
  ].filter(value => value !== undefined).join(' | '))
}
