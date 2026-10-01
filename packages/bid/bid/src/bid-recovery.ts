/** S2–S5 recovery decisions derived from Host-owned failures. */
import { createHash } from 'node:crypto'
import type { BidRunProgress, BidTaskFailure, BidWorkDescriptor, StageValidationIssue } from './control-plane-contract.ts'
import { BidStageExecutionError } from './control-plane-contract.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from './runtime-state.ts'
import type { ModelStageExecutionOptions } from './model-stage-repair.ts'
import { safeBidRunError, sanitizeBidErrorText } from './safe-error.ts'

type Recovery = NonNullable<BidTaskFailure['recovery']>

const STAGES = new Set(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'])
const BLOCKED_CODE = new RegExp(
  'INPUT_(?:INVALID|CHANGED|MISMATCH|MISSING|CORRUPT)|FILE_(?:MISSING|CORRUPT)|REVISION_(?:CONFLICT|MISMATCH)|RUN_RETIRED|EACCES|EPERM|'
  + 'CHAPTER_REVISION_(?:NOT_WRITABLE|SELECTION_INVALID|CONTEXT_UNAVAILABLE)|CREDENTIAL|QUOTA|PROVIDER|INFRASTRUCTURE|'
  + 'CONTEXT_WINDOW_EXCEEDED|FATAL|CORRUPTION|FINGERPRINT|SEMANTIC_BLOCKED|CATALOG_MISMATCH|'
  + 'SCOPE_STALE|DEPENDENCY_STALE|STALE_BASE|PREVIOUS_TARGET_INVALID|INVARIANT', 'iu',
)
const RETRY_CODE = new RegExp(
  '^(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|(?:EVIDENCE_MAPPING|CHAPTER)_SUBAGENT_INFRASTRUCTURE_ERROR|'
  + 'EVIDENCE_MAPPING_INFRASTRUCTURE_ERROR|WEB_PROVIDER_RATE_LIMITED|EVIDENCE_MAPPING_WEB_PROVIDER_BACKOFF)$', 'u',
)
const PROVIDER_FAILURE = new RegExp(
  '\\b(?:provider unavailable|model service unavailable|quota (?:exceeded|exhausted)|authentication failed|'
  + 'credential missing|context (?:window|length) exceeded)\\b', 'iu',
)

/**
 * Classify S2–S5 failures for repair, retry, or an explicit blocked boundary.
 * @param work - Failed S2–S5 work identity.
 * @param failure - Host-owned failure details.
 * @returns Automatic recovery class, or none outside S2–S5.
 */
export function classifyBidRecovery(
  work: BidWorkDescriptor,
  failure: BidTaskFailure,
): Recovery | undefined {
  const taskProblem = work.kind === 'capability_task' && ['BID_TASK_PLAN_MISMATCH', 'BID_TASK_RESULT_UNMET'].includes(failure.code ?? '')
  if ((!STAGES.has(work.stage) && !taskProblem) || work.kind === 'file_intake') return undefined
  if (['BID_TASK_SCOPE_AUTHORIZATION_REQUIRED', 'BID_TASK_SOURCE_ISSUE_CHANGED'].includes(failure.code ?? '')) {
    return { kind: 'blocked', unit: work.workId, reason: failure.message }
  }
  const blockedIssue = failure.issues?.find(issue => BLOCKED_CODE.test(issue.code))
  const issue = blockedIssue ?? failure.issues?.[0]
  const unit = sanitizeBidErrorText(issue?.artifact ?? issue?.path ?? work.workId)
  const reason = sanitizeBidErrorText(issue?.message ?? failure.message)
  const codes = [failure.code, ...failure.issues?.map(item => item.code) ?? []].filter((value): value is string => value !== undefined)
  const kind = codes.some(value => BLOCKED_CODE.test(value) && !RETRY_CODE.test(value))
    || (codes.every(value => value === 'BID_EXECUTOR_ERROR') && PROVIDER_FAILURE.test(failure.message))
    ? 'blocked' : codes.some(value => RETRY_CODE.test(value)) ? 'retry' : 'repair'
  return { kind, unit, reason }
}

/**
 * Sanitize an actual executor or validator failure before saving its recovery decision.
 * @param work - Failed work identity.
 * @param error - Thrown executor or validator error.
 * @param issues - Structured issues from the failing operation.
 * @returns Durable browser-safe failure.
 */
export function safeRecoverableBidFailure(
  work: BidWorkDescriptor,
  error: unknown,
  issues?: readonly StageValidationIssue[],
): BidTaskFailure {
  const details = issues ?? (error instanceof BidStageExecutionError ? error.issues : undefined)
  const failure = safeBidRunError(error, details)
  const recovery = classifyBidRecovery(work, failure)
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
 * Current run target and durable history shared by admission, inspect, and recovery.
 * @param session - Main Session containing the current Run and audit history.
 * @returns Exact target, history and reason for admission.
 */
export function bidRunRecoveryEligibility(session: Session): {
  eligible: boolean
  reason: string
  attempts: number
  sameProblemCount: number
  previousInstructions: string[]
  requiresStrategyChange: boolean
  lastInstruction?: string
  target?: { kind: 'run'; runId: string; workId: string }
  fingerprint?: string
} {
  const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const taskProblem = task.status === 'suspended' && task.run.work.kind === 'capability_task'
    && ['BID_TASK_PLAN_MISMATCH', 'BID_TASK_RESULT_UNMET'].includes(task.run.error?.code ?? '')
  if (task.status !== 'suspended' || !STAGES.has(task.stage) && !taskProblem || task.run.work.kind === 'file_intake') {
    return { eligible: false, reason: '当前没有 S2～S5 挂起 Run。', attempts: 0, sameProblemCount: 0, previousInstructions: [], requiresStrategyChange: false }
  }
  const { run } = task
  const history = session.events.flatMap(event => event.type === 'bid.recovery.requested'
    && event.data.target.kind === 'run'
    && event.data.target.workId === run.work.workId ? [event.data] : [])
  const attempts = history.length
  const target = { kind: 'run' as const, runId: run.runId, workId: run.work.workId }
  const fingerprint = run.error === undefined ? undefined : bidRecoveryFingerprint(run.work, run.error, run.progress)
  const sameProblemCount = fingerprint === undefined ? 0 : history.slice().reverse()
    .findIndex(event => event.progressFingerprint !== fingerprint)
  const repeated = sameProblemCount < 0 ? history.length : sameProblemCount
  const details = { attempts, target, ...(fingerprint === undefined ? {} : { fingerprint }), sameProblemCount: repeated,
    previousInstructions: history.slice(-3).map(event => sanitizeBidErrorText(event.instruction, 400)),
    ...(repeated > 0 ? { lastInstruction: history.at(-1)?.instruction ?? '' } : {}),
    requiresStrategyChange: repeated > 0 }
  if (run.cause === 'user_stop' || run.cause === 'host_restart' || run.cause === 'awaiting_input') {
    return { eligible: false, reason: '用户停止、Host 重启或等待输入由各自边界处理。', ...details }
  }
  if (run.error?.recovery === undefined || run.error.recovery.kind === 'blocked') {
    return { eligible: false, reason: run.error?.recovery?.reason ?? run.error?.message ?? '故障未被认定可自动恢复。', ...details }
  }
  return { eligible: true, reason: run.error.recovery.reason, ...details }
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
 * @returns Exact answered request and automatic recovery budget.
 */
export function bidWritingPlanRecoveryEligibility(session: Session): {
  eligible: boolean
  reason: string
  attempts: number
  sameProblemCount: number
  previousInstructions: string[]
  requiresStrategyChange: boolean
  lastInstruction?: string
  target?: { kind: 'writing_plan'; requestId: string; attemptId: string }
  fingerprint?: string
} {
  const latest = session.events.findLast(event => event.type === 'bid.writing_entry.changed')
  const view = latest?.type === 'bid.writing_entry.changed' ? latest.data.view : undefined
  const requestId = view?.expected.request_id
  const attemptId = view?.expected.attempt_id
  if (requestId === undefined || requestId === null || attemptId === undefined || attemptId === null) {
    return { eligible: false, reason: '没有已保存的 S5 写作要求。', attempts: 0, sameProblemCount: 0, previousInstructions: [], requiresStrategyChange: false }
  }
  const target = { kind: 'writing_plan' as const, requestId, attemptId }
  const history = session.events.flatMap(event => event.type === 'bid.recovery.requested'
    && event.data.target.kind === 'writing_plan'
    && event.data.target.requestId === requestId ? [event.data] : [])
  const attempts = history.length
  const fingerprint = createHash('sha256').update(JSON.stringify([requestId, attemptId, view?.error?.code])).digest('hex')
  const sameProblemCount = history.slice().reverse().findIndex(event => event.progressFingerprint !== fingerprint)
  const repeated = sameProblemCount < 0 ? attempts : sameProblemCount
  const details = { attempts, target, fingerprint, sameProblemCount: repeated,
    previousInstructions: history.slice(-3).map(event => sanitizeBidErrorText(event.instruction, 400)),
    ...(repeated > 0 ? { lastInstruction: history.at(-1)?.instruction ?? '' } : {}),
    requiresStrategyChange: repeated > 0 }
  if (view?.phase !== 'failed' || view.request_state !== 'answered' || view.continuation !== 'allowed'
    || !view.has_answer || view.has_plan || view.owner_session_id !== String(session.id)
    || !['BID_WRITING_PLAN_NOT_COMMITTED', 'BID_WRITING_PLAN_DISPATCH_FAILED'].includes(view.error?.code ?? '')) {
    return { eligible: false, reason: view?.error?.message ?? 'S5 计划不满足自动修复条件。', ...details }
  }
  return { eligible: true, reason: view.error?.message ?? '已保存答案的计划未提交。', ...details }
}

/**
 * 检查主 Agent 是否对相同问题重复提交已经接纳的方案。
 * @param session 保存恢复审计的主会话。
 * @param target 当前失败 Work 或写作请求。
 * @param fingerprint 当前失败与检查点指纹。
 * @param instruction 待接纳的模型方案。
 * @returns 该问题已有相同方案时为 true。
 */
export function bidRecoveryInstructionRepeated(session: Session,
  target: { kind: 'run'; workId: string; runId: string } | { kind: 'writing_plan'; requestId: string; attemptId: string },
  fingerprint: string | undefined, instruction: string): boolean {
  return session.events.some(event => event.type === 'bid.recovery.requested'
    && (target.kind === 'run'
      ? event.data.target.kind === 'run' && event.data.target.workId === target.workId
      : event.data.target.kind === 'writing_plan' && event.data.target.requestId === target.requestId)
    && event.data.progressFingerprint === fingerprint && event.data.instruction.trim() === instruction.trim())
}
