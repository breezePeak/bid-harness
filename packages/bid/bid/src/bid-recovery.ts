/** S2–S5 recovery decisions derived from Host-owned failures. */
import { createHash } from 'node:crypto'
import type { BidRunData, BidRunProgress, BidTaskFailure, BidTaskState, BidWorkDescriptor, StageValidationIssue } from './control-plane-contract.ts'
import { BidStageExecutionError } from './control-plane-contract.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from './runtime-state.ts'
import { DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS, type ModelStageExecutionOptions } from './model-stage-repair.ts'
import { safeBidRunError, sanitizeBidErrorText } from './safe-error.ts'

type Recovery = NonNullable<BidTaskFailure['recovery']>

/**
 * 从当前失败通知恢复原 Run 身份；自动修复保留同一 Work，不把执行故障保存成挂起。
 * @param session 保存 Run 和失败通知的原会话。
 * @param task 当前项目状态。
 * @returns 当前挂起 Run 或与失败通知严格对应的原 Run，其他状态不授予恢复。
 */
export function bidRecoverableRun(session: Session, task: BidTaskState):
  Extract<BidTaskState, { status: 'suspended' }>['run'] | undefined {
  if (task.status === 'suspended') return task.run
  if (task.status !== 'failed') return
  const notice = session.events.findLast(event => event.type === 'bid.run.notice')
  const started = notice?.type === 'bid.run.notice' ? session.events.findLast(event => event.type === 'bid.run.started'
    && event.data.run.runId === notice.data.runId) : undefined
  if (started?.type !== 'bid.run.started' || notice?.type !== 'bid.run.notice'
    || started.data.run.work.stage !== task.stage
    || notice.data.noticeId !== `run:${started.data.run.runId}:failed` || notice.data.stage !== task.stage) return
  return { ...started.data.run, cause: 'executor_error', error: task.failure }
}

/**
 * 读取当前完成通知对应的原能力 Run，供原会话追加纠正步骤。
 * @param session 保存该 Work 的公开 Main 会话。
 * @param task 已核对的当前项目状态。
 * @returns 已实际完成且与当前完成通知对应的原 Run；停止、失败及其他任务返回 undefined。
 */
export function bidCompletedCapabilityRun(session: Session, task: BidTaskState): BidRunData | undefined {
  if (task.status !== 'ready' && task.status !== 'waiting_user' && task.status !== 'completed') return
  const started = session.events.findLast(event => event.type === 'bid.run.started'
    && event.data.run.work.kind === 'capability_task')
  const notice = started?.type === 'bid.run.started' ? session.events.findLast(event => event.type === 'bid.run.notice'
    && event.data.runId === started.data.run.runId) : undefined
  const completed = started?.type === 'bid.run.started' ? session.events.findLast(event => event.type === 'bid.run.completed'
    && event.data.run.runId === started.data.run.runId) : undefined
  if (started?.type !== 'bid.run.started' || notice?.type !== 'bid.run.notice'
    || completed?.type !== 'bid.run.completed' || completed.data.run.runId !== started.data.run.runId
    || completed.data.run.work.workId !== started.data.run.work.workId
    || started.data.run.work.kind !== 'capability_task' || started.data.run.work.stage !== task.stage
    || notice.data.kind !== 'completed' || notice.data.runId !== started.data.run.runId
    || notice.data.workId !== started.data.run.work.workId) return
  return started.data.run
}

/**
 * 查找当前可由新用户目标接管的能力 Run；不授予恢复或消息权限。
 * @param session 拥有原 Run 记录的 Main 会话。
 * @param task 项目锁内读取或会话投影的当前状态。
 * @returns 当前挂起 Run 或与当前失败通知对应的最后一个能力 Run。
 */
export function bidCapabilityTakeoverRun(session: Session, task: BidTaskState): BidRunData | undefined {
  if (task.status === 'suspended') {
    return task.run.work.kind === 'capability_task' && task.run.cause !== 'awaiting_input' ? task.run : undefined
  }
  if (task.status !== 'failed') return
  const started = session.events.findLast(event => event.type === 'bid.run.started')
  const notice = session.events.findLast(event => event.type === 'bid.run.notice')
  if (started?.type !== 'bid.run.started' || notice?.type !== 'bid.run.notice'
    || started.data.run.work.kind !== 'capability_task' || started.data.run.work.stage !== task.stage
    || notice.data.noticeId !== `run:${started.data.run.runId}:failed` || notice.data.stage !== task.stage) return
  return started.data.run
}

/**
 * 选择可由新的直接用户授权补修的失败 S4 阶段；不重置原 Work 的恢复预算。
 * @param session 保存原 Run 及失败通知的公开会话。
 * @param task 当前项目状态。
 * @returns 与当前结构失败对应的阶段 Run；其他失败和用户停止不授予接管。
 */
export function bidEvidenceMappingTakeoverRun(session: Session, task: BidTaskState): BidRunData | undefined {
  if (task.status !== 'failed' || task.stage !== 'evidence_mapping'
    || !task.failure.issues?.some(issue => issue.code === 'OUTLINE_REFINEMENT_STRUCTURE_UNRESOLVED')) return
  const run = bidRecoverableRun(session, task)
  return run?.work.kind === 'stage_execution' ? run : undefined
}

const STAGES = new Set(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'])
const BLOCKED_CODE = new RegExp(
  'INPUT_(?:INVALID|CHANGED|MISMATCH|MISSING|CORRUPT)|FILE_(?:MISSING|CORRUPT)|REVISION_(?:CONFLICT|MISMATCH)|RUN_RETIRED|EACCES|EPERM|'
  + 'CHAPTER_REVISION_(?:NOT_WRITABLE|SELECTION_INVALID|CONTEXT_UNAVAILABLE)|CREDENTIAL|QUOTA|PROVIDER|INFRASTRUCTURE|'
  + '^(?:AUTH|NO_ADAPTER|INVALID_REQUEST|PI_AI_ERROR)$|'
  + 'CONTEXT_WINDOW_EXCEEDED|OUTLINE_REVIEW_INPUT_BUDGET_EXCEEDED|FATAL|CORRUPTION|FINGERPRINT|SEMANTIC_BLOCKED|CATALOG_MISMATCH|'
  + 'SCOPE_STALE|DEPENDENCY_STALE|STALE_BASE|PREVIOUS_TARGET_INVALID|INVARIANT|DOCX_FORMAT_CORRUPT|^EVIDENCE_MAPPING_GUARD_ERROR$', 'iu',
)

/**
 * 识别固定 12,000 token 上限产生的旧 S4 本地组包失败，其他 blocked 保持阻断。
 * @param work 原失败阶段的 Work。
 * @param failure 已持久化的 Host 诊断。
 * @returns 当前分组程序是否能重新核验这类旧失败；不授予跳过输入或候选检查的权限。
 */
export function isLegacyOutlineReviewBudgetFailure(work: BidWorkDescriptor, failure: BidTaskFailure): boolean {
  const legacy = (code: string | undefined, message: string) => code === 'CONTEXT_WINDOW_EXCEEDED'
    && /^目录审查对象超过输入预算：位置 (?:\d+|undefined)，估算 \d+ token，预算 12000 token。$/u.test(message)
  if (work.kind !== 'stage_execution' || work.stage !== 'evidence_mapping'
    || !failure.issues?.some(issue => legacy(issue.code, issue.message))) return false
  return [failure, ...failure.issues, ...failure.cause === undefined ? [] : [failure.cause]]
    .every(item => item.code === undefined || item.code === 'BID_EXECUTOR_ERROR'
      || !BLOCKED_CODE.test(item.code) || legacy(item.code, item.message))
}
const RETRY_CODE = new RegExp(
  '^(?:EIO|ETIMEDOUT|ECONNRESET|EAI_AGAIN|TRANSPORT|TIMEOUT|SERVER|EMPTY_RESPONSE|RATE_LIMIT|'
  + '(?:EVIDENCE_MAPPING|CHAPTER)_SUBAGENT_INFRASTRUCTURE_ERROR|'
  + 'EVIDENCE_MAPPING_INFRASTRUCTURE_ERROR|WEB_PROVIDER_RATE_LIMITED|WEB_SEARCH_TIMEOUT|WEB_FETCH_TIMEOUT|TOOL_TIMEOUT|EVIDENCE_MAPPING_WEB_PROVIDER_BACKOFF)$', 'u',
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
  const transientWebCause = failure.cause?.code === 'WEB_PROVIDER_ERROR' && failure.cause.retryable === true
    && (failure.cause.status === undefined || failure.cause.status === 429 || failure.cause.status >= 500)
  const retryCode = (code: string) => RETRY_CODE.test(code) || transientWebCause && code === 'WEB_PROVIDER_ERROR'
  const blockedCode = (code: string) => BLOCKED_CODE.test(code) && !retryCode(code)
  const blockedIssue = failure.issues?.find(issue => blockedCode(issue.code))
  const issue = blockedIssue ?? failure.issues?.[0]
  const unit = sanitizeBidErrorText(issue?.artifact ?? issue?.path ?? work.workId)
  const reason = sanitizeBidErrorText(issue?.message ?? failure.message)
  const codes = [failure.code, failure.cause?.code, ...failure.issues?.map(item => item.code) ?? []]
    .filter((value): value is string => value !== undefined)
  const kind = codes.some(blockedCode)
    || (codes.every(value => value === 'BID_EXECUTOR_ERROR') && PROVIDER_FAILURE.test(failure.message))
    ? 'blocked' : codes.some(retryCode) ? 'retry' : 'repair'
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
 * @param budget 原 Work 可执行的有限恢复次数。
 * @returns Exact target, history and reason for admission.
 */
export function bidRunRecoveryEligibility(session: Session, budget?: number): {
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
  const run = bidRecoverableRun(session, task)
  const taskProblem = run?.work.kind === 'capability_task'
    && ['BID_TASK_PLAN_MISMATCH', 'BID_TASK_RESULT_UNMET'].includes(run.error?.code ?? '')
  if (run === undefined || !STAGES.has(task.stage) && !taskProblem || run.work.kind === 'file_intake') {
    return { eligible: false, reason: '当前没有可修复的原 Run。', attempts: 0, sameProblemCount: 0, previousInstructions: [], requiresStrategyChange: false }
  }
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
  const legacyBudget = run.error !== undefined && isLegacyOutlineReviewBudgetFailure(run.work, run.error)
  if (run.error?.recovery === undefined || run.error.recovery.kind === 'blocked' && !legacyBudget) {
    return { eligible: false, reason: run.error?.recovery?.reason ?? run.error?.message ?? '故障未被认定可自动恢复。', ...details }
  }
  const settled = session.events.findLast(event => event.type === 'bid.recovery.round' && event.data.target.kind === 'run'
    && event.data.target.workId === run.work.workId)
  const storedBudget = settled?.type === 'bid.recovery.round' ? settled.data.budget : undefined
  const limit = Math.min(budget ?? storedBudget ?? DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS, storedBudget ?? Infinity)
  if (attempts >= limit) return { eligible: false, reason: 'BID_RECOVERY_BUDGET_EXHAUSTED: 原 Work 的执行恢复预算已耗尽。', ...details }
  if (settled?.type === 'bid.recovery.round' && settled.data.state === 'blocked'
    && !(legacyBudget && settled.data.round < limit && settled.data.reason === run.error.recovery.reason)) {
    return { eligible: false, reason: settled.data.reason, ...details }
  }
  return { eligible: true, reason: legacyBudget
    ? '原 S4 审查包可按当前模型预算重组；恢复时核对原输入和已完成检查点。' : run.error.recovery.reason, ...details }
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
 * @param budget 已保存请求可执行的有限计划恢复次数。
 * @returns Exact answered request and automatic recovery budget.
 */
export function bidWritingPlanRecoveryEligibility(session: Session, budget?: number): {
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
  const fingerprint = createHash('sha256').update(JSON.stringify([requestId, view?.error?.code])).digest('hex')
  const sameProblemCount = history.slice().reverse().findIndex(event => event.progressFingerprint !== fingerprint)
  const repeated = sameProblemCount < 0 ? attempts : sameProblemCount
  const details = { attempts, target, fingerprint, sameProblemCount: repeated,
    previousInstructions: history.slice(-3).map(event => sanitizeBidErrorText(event.instruction, 400)),
    ...(repeated > 0 ? { lastInstruction: history.at(-1)?.instruction ?? '' } : {}),
    requiresStrategyChange: repeated > 0 }
  if (view?.phase !== 'failed' || view.request_state !== 'answered' || view.continuation !== 'allowed'
    || !view.has_answer || view.has_plan || view.owner_session_id !== String(session.id)
    || !isBidWritingPlanRecoverableFailure(view.error)) {
    return { eligible: false, reason: view?.error?.message ?? 'S5 计划不满足自动修复条件。', ...details }
  }
  const settled = session.events.findLast(event => event.type === 'bid.recovery.round' && event.data.target.kind === 'writing_plan'
    && event.data.target.requestId === requestId)
  const storedBudget = settled?.type === 'bid.recovery.round' ? settled.data.budget : undefined
  const limit = Math.min(budget ?? storedBudget ?? DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS, storedBudget ?? Infinity)
  if (attempts >= limit) return { eligible: false, reason: 'BID_RECOVERY_BUDGET_EXHAUSTED: 已保存写作要求的计划恢复预算已耗尽。', ...details }
  if (settled?.type === 'bid.recovery.round' && settled.data.state === 'blocked') return { eligible: false, reason: settled.data.reason, ...details }
  return { eligible: true, reason: view.error?.message ?? '已保存答案的计划未提交。', ...details }
}

/**
 * 按计划提交问题与模型错误分类判断恢复，鉴权、配额和输入错误优先阻断。
 * @param failure 已保存写作要求后的真实执行错误。
 * @returns 暂态执行故障或 Main 可纠正的提交问题是否可恢复。
 */
export function isBidWritingPlanRecoverableFailure(failure: { code: string; message: string } | null | undefined): boolean {
  if (failure === undefined || failure === null) return false
  return ['BID_WRITING_PLAN_NOT_COMMITTED', 'BID_WRITING_PLAN_DISPATCH_FAILED'].includes(failure.code)
    || RETRY_CODE.test(failure.code) && !BLOCKED_CODE.test(failure.code)
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
