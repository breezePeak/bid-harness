/** Bounded S2–S5 recovery decisions derived from Host-owned failures. */
import { createHash } from 'node:crypto'
import type { BidRunProgress, BidTaskFailure, BidWorkDescriptor, StageValidationIssue } from './control-plane-contract.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from './runtime-state.ts'
import type { ModelStageExecutionOptions } from './model-stage-repair.ts'
import { safeBidRunError, sanitizeBidErrorText } from './safe-error.ts'

type Recovery = NonNullable<BidTaskFailure['recovery']>

const STAGES = new Set(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'])
const BLOCKED_CODE = new RegExp(
  'INPUT_(?:INVALID|CHANGED|MISMATCH)|FILE_(?:MISSING|CORRUPT)|PERMISSION|DENIED|UNAUTHORIZED|FORBIDDEN|'
  + 'CREDENTIAL|QUOTA|PROVIDER|VALIDATOR_FAILED|FATAL|FINGERPRINT|SEMANTIC_BLOCKED', 'iu',
)
const REPAIR_CODE = new RegExp(
  'CANDIDATE_INVALID|SUBMISSION_(?:REQUIRED|INCOMPLETE)|NOT_COMMITTED|VALIDATION_FAILED|SCHEMA_INVALID|'
  + 'CONTENT_INVALID|STRUCTURE_INVALID|SEMANTIC_INVALID|EVIDENCE_MAPPING_(?:PARTIAL|FINAL_REVIEW|FINAL_CHECK|'
  + 'REVIEW_PENDING|REFINED_SCOPE)|CHAPTER_(?:REVIEWER_RESULT|WRITING_|SUBAGENT_STRUCTURED)', 'iu',
)
const RETRY_CODE = /^(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|EVIDENCE_MAPPING_SUBAGENT_INFRASTRUCTURE_ERROR)$/u

/**
 * Classify only a known failed business candidate or idempotent transient operation.
 * @param work - Failed S2–S5 work identity.
 * @param failure - Host-owned failure details.
 * @param validationRejected - Whether final artifact validation rejected the result.
 * @returns Automatic recovery class, or none outside S2–S5.
 */
export function classifyBidRecovery(
  work: BidWorkDescriptor,
  failure: BidTaskFailure,
  validationRejected = false,
): Recovery | undefined {
  if (!STAGES.has(work.stage) || work.kind === 'file_intake') return undefined
  const issue = failure.issues?.[0]
  const code = issue?.code ?? failure.code ?? ''
  const unit = sanitizeBidErrorText(issue?.artifact ?? issue?.path ?? work.workId)
  const reason = sanitizeBidErrorText(issue?.message ?? failure.message)
  const kind = BLOCKED_CODE.test(code) ? 'blocked'
    : validationRejected ? 'repair'
      : RETRY_CODE.test(code) ? 'retry'
        : REPAIR_CODE.test(code) ? 'repair' : 'blocked'
  return { kind, unit, reason }
}

/**
 * Sanitize an actual executor or validator failure before saving its recovery decision.
 * @param work - Failed work identity.
 * @param error - Thrown executor or validator error.
 * @param issues - Structured issues from the failing operation.
 * @param validationRejected - Whether final artifact validation rejected the result.
 * @returns Durable browser-safe failure.
 */
export function safeRecoverableBidFailure(
  work: BidWorkDescriptor,
  error: unknown,
  issues?: readonly StageValidationIssue[],
  validationRejected = false,
): BidTaskFailure {
  const failure = safeBidRunError(error, issues)
  const recovery = classifyBidRecovery(work, failure, validationRejected)
  return recovery === undefined ? failure : { ...failure, recovery }
}

/**
 * Stable work/problem identity without Run ids or timestamps.
 * @param work - Durable input identity.
 * @param failure - Structured problem at the suspended boundary.
 * @param progress - Latest durable business checkpoint, excluding its timestamp.
 * @returns SHA-256 for repeated-problem detection.
 */
export function bidRecoveryFingerprint(work: BidWorkDescriptor, failure: BidTaskFailure, progress?: BidRunProgress): string {
  const issues: readonly StageValidationIssue[] = failure.issues ?? []
  return createHash('sha256').update(JSON.stringify({
    input: work.inputFingerprint,
    unit: failure.recovery?.unit,
    issues: issues.map(issue => [issue.code, issue.artifact ?? issue.path ?? '', issue.message.trim()]).sort(),
    code: failure.code,
    candidate: failure.recovery?.candidateSha256,
    checkpoint: progress === undefined ? null : {
      phase: progress.phase, summary: progress.summary,
      completed: progress.completed, total: progress.total, details: progress.details,
    },
  })).digest('hex')
}

/**
 * Current run target and durable budget shared by admission, inspect, and recovery.
 * @param session - Main Session containing the current Run and audit history.
 * @param goalId - Bound native Goal identity.
 * @returns Exact target, budget and reason for admission.
 */
export function bidRunRecoveryEligibility(session: Session, goalId: string): {
  eligible: boolean
  reason: string
  attempts: number
  target?: { kind: 'run'; runId: string; workId: string }
  fingerprint?: string
} {
  const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  if (task.status !== 'suspended' || !STAGES.has(task.stage) || task.run.work.kind === 'file_intake') {
    return { eligible: false, reason: '当前没有 S2～S5 挂起 Run。', attempts: 0 }
  }
  const { run } = task
  const attempts = session.events.filter(event => event.type === 'bid.goal.recovery.requested'
    && event.data.goalId === goalId && event.data.target.kind === 'run'
    && event.data.target.workId === run.work.workId).length
  const target = { kind: 'run' as const, runId: run.runId, workId: run.work.workId }
  if (run.cause === 'user_stop' || run.cause === 'host_restart') {
    return { eligible: false, reason: '用户停止或 Host 重启需用户明确继续。', attempts, target }
  }
  if (run.error?.recovery === undefined || run.error.recovery.kind === 'blocked') {
    return { eligible: false, reason: run.error?.recovery?.reason ?? run.error?.message ?? '故障未被认定可自动恢复。', attempts, target }
  }
  if (attempts >= 2) return { eligible: false, reason: '当前 work 的自动接管次数已耗尽。', attempts, target }
  const fingerprint = bidRecoveryFingerprint(run.work, run.error, run.progress)
  const unchanged = session.events.some(event => event.type === 'bid.goal.recovery.requested'
    && event.data.goalId === goalId && event.data.target.kind === 'run'
    && event.data.target.workId === run.work.workId
    && event.data.progressFingerprint === fingerprint)
  return unchanged
    ? { eligible: false, reason: '同一问题和检查点没有进展。', attempts, target, fingerprint }
    : { eligible: true, reason: run.error.recovery.reason, attempts, target, fingerprint }
}

/**
 * Bounded model context from a durable Host-accepted recovery request.
 * @param recovery - Host-scoped instruction for one work and unit.
 * @returns Model-visible text or empty text without a recovery request.
 */
export function renderBidRecoveryContext(recovery: ModelStageExecutionOptions['recovery']): string {
  if (recovery === undefined) return ''
  return [
    'Host 已接受当前失败任务的修复要求；只修复这个 work 的失败范围，保留已完成成果。',
    `失败单元：${sanitizeBidErrorText(recovery.unit)}`,
    ...recovery.issues.slice(0, 5).map(issue => `原问题：${sanitizeBidErrorText(issue.code)}${issue.path === undefined && issue.artifact === undefined
      ? '' : ` ${sanitizeBidErrorText(issue.path ?? issue.artifact ?? '')}`} ${sanitizeBidErrorText(issue.message)}`),
    `改进处理办法：${sanitizeBidErrorText(recovery.instruction, 4000)}`,
    '继续使用原提交工具和原校验规则；不得改上游事实或代替用户确认。',
  ].join('\n')
}

/**
 * Durable S5 answered-plan failure visible without opening its on-disk answer.
 * @param session - Main Session containing the writing-entry projection.
 * @param goalId - Bound native Goal identity.
 * @returns Exact answered request and automatic recovery budget.
 */
export function bidWritingPlanRecoveryEligibility(session: Session, goalId: string): {
  eligible: boolean
  reason: string
  attempts: number
  target?: { kind: 'writing_plan'; requestId: string; attemptId: string }
  fingerprint?: string
} {
  const latest = session.events.findLast(event => event.type === 'bid.writing_entry.changed')
  const view = latest?.type === 'bid.writing_entry.changed' ? latest.data.view : undefined
  const requestId = view?.expected.request_id
  const attemptId = view?.expected.attempt_id
  if (requestId === undefined || requestId === null || attemptId === undefined || attemptId === null) {
    return { eligible: false, reason: '没有已保存的 S5 写作要求。', attempts: 0 }
  }
  const target = { kind: 'writing_plan' as const, requestId, attemptId }
  const attempts = session.events.filter(event => event.type === 'bid.goal.recovery.requested'
    && event.data.goalId === goalId && event.data.target.kind === 'writing_plan'
    && event.data.target.requestId === requestId).length
  if (view?.phase !== 'failed' || view.request_state !== 'answered' || view.continuation !== 'allowed'
    || !view.has_answer || view.has_plan || view.owner_session_id !== String(session.id)
    || !['BID_WRITING_PLAN_NOT_COMMITTED', 'BID_WRITING_PLAN_DISPATCH_FAILED'].includes(view.error?.code ?? '')) {
    return { eligible: false, reason: view?.error?.message ?? 'S5 计划不满足自动修复条件。', attempts, target }
  }
  if (attempts >= 2) return { eligible: false, reason: '当前写作要求的自动接管次数已耗尽。', attempts, target }
  const fingerprint = createHash('sha256').update(JSON.stringify([requestId, attemptId, view.error?.code])).digest('hex')
  const unchanged = session.events.some(event => event.type === 'bid.goal.recovery.requested'
    && event.data.goalId === goalId && event.data.target.kind === 'writing_plan'
    && event.data.target.requestId === requestId && event.data.progressFingerprint === fingerprint)
  return unchanged
    ? { eligible: false, reason: 'S5 计划失败没有新进展。', attempts, target, fingerprint }
    : { eligible: true, reason: view.error?.message ?? '已保存答案的计划未提交。', attempts, target, fingerprint }
}
