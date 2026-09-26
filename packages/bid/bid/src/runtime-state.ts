import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import {
  BID_STAGES,
  BID_WORK_KINDS,
  type BidStage,
} from './control-plane-contract.ts'
import type {
  BidClientProjection,
  BidRunData,
  BidRunProgress,
  BidStagePolicy,
  BidStageTask,
  BidTaskFailure,
  BidTaskState,
  StageValidationIssue,
} from './control-plane-contract.ts'
import { defaultBidNextStage, defaultBidUserGate } from './default-route.ts'

const stageValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  artifact: z.string().optional(),
  path: z.string().optional(),
}).strict()

/** Durable bounded Run progress shared by Session replay and project checkpoints. */
export const bidRunProgressSchema: z.ZodType<BidRunProgress> = z.object({
  phase: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  summary: z.string().min(1).max(240),
  completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  details: z.array(z.string().min(1).max(160)).max(5).readonly().optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict().refine(progress => progress.completed === undefined || progress.total === undefined
  || progress.completed <= progress.total, { message: 'completed must not exceed total' })

const bidTaskFailureSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  issues: z.array(stageValidationIssueSchema).readonly().optional(),
  recovery: z.object({ kind: z.enum(['retry', 'repair', 'blocked']), unit: z.string().min(1), reason: z.string().min(1),
    candidateSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().optional(),
}).strict()

/** Durable execution-data schema for one Bid Run. */
export const bidRunDataSchema = z.object({
  runId: z.string().min(1),
  interactionSessionId: z.string().min(1).optional(),
  executionSessionId: z.string().min(1).optional(),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  controlRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  work: z.object({
    kind: z.enum(BID_WORK_KINDS),
    workId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    stage: z.enum(BID_STAGES),
    requestRef: z.string().min(1),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  resumeOf: z.object({
    runId: z.string().min(1),
    cause: z.enum(['user_stop', 'retry_exhausted', 'executor_error', 'host_restart', 'awaiting_input']),
  }).strict().optional(),
  progress: bidRunProgressSchema.optional(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** Authoritative task schema; impossible Run combinations fail at the persistence and wire boundaries. */
export const bidTaskStateSchema: z.ZodType<BidTaskState> = z.discriminatedUnion('status', [
  z.object({ stage: z.enum(BID_STAGES), status: z.literal('ready'), run: z.null() }).strict(),
  z.object({ stage: z.enum(BID_STAGES), status: z.literal('running'), run: bidRunDataSchema }).strict(),
  z.object({
    stage: z.enum(BID_STAGES), status: z.literal('waiting_user'), run: z.null(),
    reason: z.string().optional(), issues: z.array(stageValidationIssueSchema).readonly().optional(),
  }).strict(),
  z.object({
    stage: z.enum(BID_STAGES), status: z.literal('suspended'),
    run: bidRunDataSchema.extend({
      cause: z.enum(['user_stop', 'retry_exhausted', 'executor_error', 'host_restart', 'awaiting_input']),
      error: bidTaskFailureSchema.optional(),
    }),
  }).strict(),
  z.object({
    stage: z.enum(BID_STAGES), status: z.literal('failed'), run: z.null(), failure: bidTaskFailureSchema,
  }).strict(),
  z.object({ stage: z.enum(BID_STAGES), status: z.literal('completed'), run: z.null() }).strict(),
]).superRefine((task, context) => {
  if ((task.status === 'running' || task.status === 'suspended') && task.run.work.stage !== task.stage) {
    context.addIssue({ code: 'custom', path: ['run', 'work', 'stage'], message: 'run work stage must match task stage' })
  }
})

/** Task state produced by an empty Bid Session log. */
export const BID_INITIAL_TASK_STATE: BidTaskState = Object.freeze({
  stage: 'file_intake', status: 'waiting_user', run: null,
})

/** 重放旧版项目与 Session 记录时接纳的运行态结构。 @deprecated 仅用于 v3 兼容读取。 */
export const legacyBidRuntimeSchema = z.object({
  stage: z.enum(BID_STAGES),
  status: z.enum(['pending', 'waiting_start', 'running', 'waiting_user', 'suspended', 'attention_required', 'failed', 'completed']),
  failureReason: z.string().optional(),
  failureIssues: z.array(stageValidationIssueSchema).readonly().optional(),
}).strict()

const legacyBidRunSchema = bidRunDataSchema.extend({
  stage: z.enum(BID_STAGES),
  status: z.enum(['running', 'cancelling', 'suspended', 'completed']),
  cause: z.enum(['user_stop', 'retry_exhausted', 'executor_error', 'host_restart', 'awaiting_input']).optional(),
  error: bidTaskFailureSchema.optional(),
}).strict()

/** 旧版项目控制记录的读取结构。 @deprecated 仅用于 v3 兼容读取。 */
export const legacyBidControlStateSchema = z.object({
  workflow: z.object({
    stage: z.enum(BID_STAGES),
    gate: z.enum(['ready', 'waiting_start', 'waiting_user', 'attention_required', 'completed', 'failed']),
    failureReason: z.string().optional(),
    failureIssues: z.array(stageValidationIssueSchema).readonly().optional(),
  }).strict(),
  run: legacyBidRunSchema.nullable(),
  lastRun: legacyBidRunSchema.nullable(),
}).strict()

/** 旧版 Session 投影中的阶段运行态，仅供兼容读取。 */
export type LegacyBidRuntimeState = z.infer<typeof legacyBidRuntimeSchema>
/** 旧版项目控制记录，仅供兼容读取。 */
export type LegacyBidControlState = z.infer<typeof legacyBidControlStateSchema>

const POLICIES: { readonly [K in BidStage]: Readonly<BidStagePolicy> } = {
  file_intake: {
    stage: 'file_intake', executor: 'program', requiredInputs: [], allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'], requiredArtifacts: ['manifest.json'],
    validator: 'file-intake-validator', userGate: defaultBidUserGate('file_intake'), nextStage: defaultBidNextStage('file_intake'),
  },
  tender_analysis: {
    stage: 'tender_analysis', executor: 'agent', requiredInputs: ['manifest.json'], allowedTools: ['grep', 'read', 'view_pdf_page'],
    forbiddenTools: ['write', 'bash', 'web_search', 'web_fetch', 'subagent'], requiredArtifacts: [
      'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring-origin.json', 'analysis/compliance.json',
    ], validator: 'tender-analysis-validator', userGate: defaultBidUserGate('tender_analysis'), nextStage: defaultBidNextStage('tender_analysis'),
  },
  outline_generation: {
    stage: 'outline_generation', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json',
    ], allowedTools: ['read', 'write'], forbiddenTools: ['grep', 'bash', 'web_search'], requiredArtifacts: [
      'analysis/scoring-response-points.json', 'outline/outline.json', 'outline/quality-report.json',
    ], validator: 'outline-generation-validator', userGate: defaultBidUserGate('outline_generation'), nextStage: defaultBidNextStage('outline_generation'),
  },
  evidence_mapping: {
    stage: 'evidence_mapping', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json',
      'analysis/scoring-response-points.json', 'analysis/compliance.json', 'outline/initial-confirmed-outline.json',
    ], allowedTools: ['read', 'write'], forbiddenTools: ['bash'], requiredArtifacts: [
      'analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/outline.json', 'outline/quality-report.json',
    ], validator: 'evidence-mapping-validator', userGate: defaultBidUserGate('evidence_mapping'), nextStage: defaultBidNextStage('evidence_mapping'),
  },
  chapter_writing: {
    stage: 'chapter_writing', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json',
      'analysis/scoring-response-points.json', 'analysis/compliance.json', 'analysis/evidence-map.json',
      'analysis/web-evidence-sources.json', 'outline/confirmed-outline.json',
    ], allowedTools: ['grep', 'read', 'web_search', 'web_fetch'], forbiddenTools: ['bash', 'write'], requiredArtifacts: [
      'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json', 'chapters/global-compliance-review.json',
    ], validator: 'chapter-writing-validator', userGate: defaultBidUserGate('chapter_writing'), nextStage: defaultBidNextStage('chapter_writing'),
  },
  docx_export: {
    stage: 'docx_export', executor: 'program', requiredInputs: ['outline/confirmed-outline.json', 'chapters/manifest.json'],
    allowedTools: [], forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'], requiredArtifacts: ['output/bid.docx'],
    validator: 'docx-export-validator', userGate: defaultBidUserGate('docx_export'), nextStage: defaultBidNextStage('docx_export'),
  },
}

const OBJECTIVES: { readonly [K in BidStage]: string } = {
  file_intake: '校验已入库的投标语料和分块索引。',
  tender_analysis: '提取并规范化招标项目、技术要求、技术评分原文和合规规则。',
  outline_generation: '分析评分响应点，并结合人工框架和旧标书结构生成初步技术标目录。',
  evidence_mapping: '按初步目录逐章节映射本地与 Web 资料，并据研究结果深化目录。',
  chapter_writing: '以最终确认目录为结构来源，编写并实时审核全部技术标章节。',
  docx_export: '把章节内容导出为 DOCX。',
}

const CONSTRAINTS: { readonly [K in BidStage]: readonly string[] } = {
  file_intake: ['只使用已入库的工作区文件。', '不得调用 Agent。'],
  tender_analysis: [
    '覆盖全部成功解析的 tender 文件，只把 tender 作为招标事实来源。',
    '只提取技术标范围，保留准确 source_refs。',
    '评分项只保存完整原文与简单规则规范化，不得拆解评分响应点。',
  ],
  outline_generation: [
    'Main Agent 按评分语义全局拆解响应点，Host 统一分配稳定 RP ID。',
    '只读取人工框架和参考旧标书的目录结构，不进行正文资料映射。',
    '当前 tender 要求始终高于人工框架和旧标书结构。',
    '不得使用 Web Search、grep 或生成章节正文。',
  ],
  evidence_mapping: [
    'Host 为已确认初步目录的每个可写叶子生成独立 Mapping Task，只处理技术标范围。',
    '每个 Child 只研究当前 Section，并接收其关联 Requirement、Scoring、Response Point、Compliance 和 corpus 定位。',
    '优先搜索本地资料；是否补充 Web Research 由 Agent 按章节需要判断。',
    '资料缺失写入 missing_topics，不得因此删除招标要求或评分章节。',
    '研究后只能深化当前 Section 子树；拆分产生的新叶子分别入队，前置研究结果只作为候选，不自动成为 Evidence。',
  ],
  chapter_writing: [
    'confirmed-outline.json 是唯一章节结构来源。',
    'Host 按 execution-plan 的强依赖 DAG 调度，无依赖章节并行。',
    '每章正文生成后立即可读并启动独立 Reviewer；明确问题最多自动修复一次。',
    '企业事实和参数必须有本地 Evidence，没有可靠原文时不得虚构。',
  ],
  docx_export: ['只使用最终确认目录和已写章节。', '输出必须位于项目 output 目录。'],
}

/**
 * Return a detached fixed policy for one Bid stage.
 * @param stage Stage whose executor and transition policy is requested.
 * @returns Detached stage policy safe for callers to inspect.
 */
export function getBidStagePolicy(stage: BidStage): BidStagePolicy {
  const policy = POLICIES[stage]
  return { ...policy, requiredInputs: [...policy.requiredInputs], allowedTools: [...policy.allowedTools],
    ...policy.forbiddenTools === undefined ? {} : { forbiddenTools: [...policy.forbiddenTools] },
    requiredArtifacts: [...policy.requiredArtifacts] }
}

/**
 * Build the deterministic executor assignment for one stage policy.
 * @param stage Stage to assign.
 * @returns Executor-facing objective, inputs, artifacts, tools, and constraints.
 */
export function buildBidStageTask(stage: BidStage): BidStageTask {
  const policy = getBidStagePolicy(stage)
  return { stage, objective: OBJECTIVES[stage], inputs: [...policy.requiredInputs], requiredArtifacts: [...policy.requiredArtifacts],
    allowedTools: [...policy.allowedTools], constraints: [...CONSTRAINTS[stage]] }
}

function cloneIssue(issue: StageValidationIssue) {
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.artifact === undefined ? {} : { artifact: issue.artifact }),
    ...(issue.path === undefined ? {} : { path: issue.path }),
  }
}

function cloneRun(run: BidRunData): BidRunData {
  return {
    ...run,
    ...run.progress === undefined ? {} : {
      progress: {
        ...run.progress,
        ...run.progress.details === undefined ? {} : { details: [...run.progress.details] },
      },
    },
  }
}

function cloneFailure(failure: BidTaskFailure): BidTaskFailure {
  return {
    ...failure,
    ...failure.issues === undefined ? {} : { issues: failure.issues.map(cloneIssue) },
    ...failure.recovery === undefined ? {} : { recovery: { ...failure.recovery } },
  }
}

/** 返回用于投影或状态迁移的独立任务状态。
 * @param task 当前任务状态。
 * @returns 通过当前结构校验的独立状态。
 */
export function cloneBidTaskState(task: BidTaskState): BidTaskState {
  return bidTaskStateSchema.parse(task)
}

/** 将宿主重启时遗留的运行中 Run 转为可恢复状态。
 * @param task 磁盘中的任务状态。
 * @param updatedAt 恢复状态的更新时间。
 * @returns 原状态或带宿主重启原因的挂起状态。
 */
export function suspendForHostRestart(task: BidTaskState, updatedAt = Date.now()): BidTaskState {
  if (task.status !== 'running') return task
  return {
    stage: task.stage,
    status: 'suspended',
    run: { ...task.run, cause: 'host_restart', updatedAt },
  }
}

function placeholderRun(stage: BidStage): BidRunData {
  return {
    runId: `legacy-${stage}`,
    epoch: 0,
    baseProjectRevision: 0,
    work: {
      kind: 'stage_execution', workId: `legacy-${stage}`, stage,
      requestRef: `requests/legacy-${stage}.json`, requestSha256: '0'.repeat(64), inputFingerprint: '0'.repeat(64),
    },
    startedAt: 0,
    updatedAt: 0,
  }
}

function legacyFailure(reason: string | undefined, issues: readonly StageValidationIssue[] | undefined): BidTaskFailure {
  return {
    message: reason ?? '旧项目记录的当前阶段失败。',
    ...issues === undefined ? {} : { issues: issues.map(cloneIssue) },
  }
}

function runDataFromLegacy(run: NonNullable<LegacyBidControlState['run']>): BidRunData {
  return cloneRun({
    runId: run.runId,
    ...run.interactionSessionId === undefined ? {} : { interactionSessionId: run.interactionSessionId },
    ...run.executionSessionId === undefined ? {} : { executionSessionId: run.executionSessionId },
    epoch: run.epoch,
    baseProjectRevision: run.baseProjectRevision,
    ...run.controlRevision === undefined ? {} : { controlRevision: run.controlRevision },
    work: { ...run.work },
    ...run.resumeOf === undefined ? {} : { resumeOf: { ...run.resumeOf } },
    ...run.progress === undefined ? {} : { progress: { ...run.progress } },
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  })
}

/** 将旧版扁平 Session 投影归一为当前任务状态。
 * @param runtime 旧版阶段运行态。
 * @returns 当前结构的任务状态。
 */
export function normalizeLegacyBidRuntime(runtime: LegacyBidRuntimeState): BidTaskState {
  const failure = legacyFailure(runtime.failureReason, runtime.failureIssues)
  switch (runtime.status) {
    case 'running': return startRun(markReady(runtime.stage), placeholderRun(runtime.stage))
    case 'suspended': return suspendRun(markReady(runtime.stage), placeholderRun(runtime.stage), 'host_restart', failure)
    case 'failed': return markFailed(runtime.stage, failure)
    case 'pending':
    case 'waiting_start': return markReady(runtime.stage)
    case 'waiting_user': return waitForUser(runtime.stage)
    case 'attention_required': return waitForUser(runtime.stage, runtime.failureReason, runtime.failureIssues)
    case 'completed': return markCompleted(runtime.stage)
  }
}

/** 将旧版 v3 项目控制记录归一为单一任务状态。
 * @param legacy 旧版控制记录。
 * @returns 当前结构的任务状态。
 */
export function normalizeLegacyBidControlState(legacy: LegacyBidControlState): BidTaskState {
  const { workflow, run } = legacy
  if (run?.status === 'running') return startRun(markReady(workflow.stage), runDataFromLegacy(run))
  if (run?.status === 'cancelling') {
    return suspendRun(markReady(workflow.stage), runDataFromLegacy(run), 'host_restart', run.error)
  }
  if (run?.status === 'suspended') {
    return suspendRun(markReady(workflow.stage), runDataFromLegacy(run), run.cause ?? 'host_restart', run.error)
  }
  switch (workflow.gate) {
    case 'ready':
    case 'waiting_start': return markReady(workflow.stage)
    case 'waiting_user': return waitForUser(workflow.stage)
    case 'attention_required': return waitForUser(workflow.stage, workflow.failureReason, workflow.failureIssues)
    case 'failed': return markFailed(workflow.stage, legacyFailure(workflow.failureReason, workflow.failureIssues))
    case 'completed': return markCompleted(workflow.stage)
  }
}

/** 为自动阶段创建可持久化的就绪检查点。
 * @param stage 待运行阶段。
 * @returns 没有关联 Run 的就绪状态。
 */
export function markReady(stage: BidStage): BidTaskState {
  return { stage, status: 'ready', run: null }
}

/** 启动 Work 所属阶段与当前阶段一致的 Run。
 * @param state 当前阶段状态。
 * @param run 即将运行的 Run 记录。
 * @returns 包含独立 Run 数据的运行中状态。
 */
export function startRun(state: BidTaskState, run: BidRunData): BidTaskState {
  if (run.work.stage !== state.stage) throw new Error('BID_RUN_STAGE_MISMATCH')
  return { stage: state.stage, status: 'running', run: cloneRun(run) }
}

/** 在 Run 完全收敛后记录可恢复的挂起状态。
 * @param state 当前阶段状态。
 * @param run 已收敛的 Run 记录。
 * @param cause 挂起原因。
 * @param error 可保留的失败诊断。
 * @returns 保留 Run 身份与挂起原因的任务状态。
 */
export function suspendRun(
  state: BidTaskState,
  run: BidRunData,
  cause: import('./control-plane-contract.ts').BidRunSuspensionCause,
  error?: BidTaskFailure,
): BidTaskState {
  if (run.work.stage !== state.stage) throw new Error('BID_RUN_STAGE_MISMATCH')
  return {
    stage: state.stage,
    status: 'suspended',
    run: { ...cloneRun(run), cause, ...error === undefined ? {} : { error: cloneFailure(error) } },
  }
}

/** 停止自动执行并等待用户明确操作。
 * @param stage 等待输入的阶段。
 * @param reason 展示给用户的等待原因。
 * @param issues 待处理的校验问题。
 * @returns 不携带运行中 Run 的等待状态。
 */
export function waitForUser(
  stage: BidStage,
  reason?: string,
  issues?: readonly StageValidationIssue[],
): BidTaskState {
  return {
    stage, status: 'waiting_user', run: null,
    ...reason === undefined ? {} : { reason },
    ...issues === undefined ? {} : { issues: issues.map(cloneIssue) },
  }
}

/** 记录无法保留 Run 的项目失败。
 * @param stage 失败阶段。
 * @param failure 持久化的失败诊断。
 * @returns 带独立失败诊断的终止状态。
 */
export function markFailed(stage: BidStage, failure: BidTaskFailure): BidTaskState {
  return { stage, status: 'failed', run: null, failure: cloneFailure(failure) }
}

/** 记录不再保留 Run 的最终完成状态。
 * @param stage 已完成阶段。
 * @returns 完成状态。
 */
export function markCompleted(stage: BidStage): BidTaskState {
  return { stage, status: 'completed', run: null }
}

/** 将已完成阶段推进到下一自动阶段的就绪检查点。
 * @param _current 已完成的当前任务状态。
 * @param next 下一阶段。
 * @returns 下一阶段的就绪状态。
 */
export function advanceStage(_current: BidTaskState, next: BidStage): BidTaskState {
  return markReady(next)
}

/**
 * Fold one committed Session event into the authoritative task state.
 * @param state Task state before the event.
 * @param event Committed Session event to apply.
 * @returns Task state after the event.
 */
export function reduceBidTaskState(state: BidTaskState, event: SessionEvent): BidTaskState {
  switch (event.type) {
    case 'bid.project.resumed': {
      const resumed = 'state' in event.data
        ? cloneBidTaskState(event.data.state)
        : 'workflow' in event.data
          ? normalizeLegacyBidControlState(event.data)
          : normalizeLegacyBidRuntime(event.data.runtime)
      return JSON.stringify(state) === JSON.stringify(resumed) ? state : resumed
    }
    case 'bid.task.changed':
      return cloneBidTaskState(event.data.state)
    case 'bid.run.started':
      return event.data.run.work.stage === state.stage ? startRun(state, event.data.run) : state
    case 'bid.run.progress': {
      if ((state.status !== 'running' && state.status !== 'suspended')
        || state.run.runId !== event.data.runId
        || state.run.epoch !== event.data.epoch
        || state.stage !== event.data.stage) return state
      const progress = {
        ...event.data.progress,
        ...event.data.progress.details === undefined ? {} : { details: [...event.data.progress.details] },
      }
      if (state.status === 'running') return {
        ...state, run: { ...state.run, progress, updatedAt: event.data.progress.updatedAt },
      }
      return {
        ...state, run: { ...state.run, progress, updatedAt: event.data.progress.updatedAt },
      }
    }
    case 'bid.run.start_failed':
      return state.status === 'running' && state.run.runId === event.data.runId && state.run.epoch === event.data.epoch
        ? markReady(state.stage)
        : state
    case 'bid.run.cancelling':
      return state
    case 'bid.run.suspended':
      return state.status === 'running' && state.run.runId === event.data.run.runId && state.run.epoch === event.data.run.epoch
        ? suspendRun(state, event.data.run, event.data.run.cause, event.data.run.error)
        : state
    case 'bid.run.completed':
      return state
    // Legacy events remain readable without retaining their parallel status vocabulary.
    case 'bid.stage.started': {
      return event.data.stage === state.stage ? startRun(state, placeholderRun(event.data.stage)) : state
    }
    case 'bid.stage.attention_required':
      return event.data.stage === state.stage ? waitForUser(event.data.stage, event.data.reason, event.data.issues) : state
    case 'bid.workflow.failed':
    case 'bid.stage.failed':
      return event.data.stage === state.stage
        ? markFailed(event.data.stage, {
          message: event.data.reason,
          ...event.data.issues === undefined ? {} : { issues: event.data.issues },
        })
        : state
    case 'bid.stage.reset':
      return BID_STAGES.indexOf(event.data.stage) <= BID_STAGES.indexOf(state.stage)
        ? event.data.stage === 'file_intake' || event.data.stage === 'chapter_writing'
          ? waitForUser(event.data.stage)
          : markReady(event.data.stage)
        : state
    case 'bid.user_confirmation.required':
      return event.data.stage === state.stage && getBidStagePolicy(state.stage).userGate !== 'none'
        ? waitForUser(state.stage)
        : state
    case 'bid.user_confirmation.received':
      return event.data.stage === state.stage && state.status === 'waiting_user'
        ? markReady(state.stage)
        : state
    case 'bid.stage.completed': {
      if (event.data.stage !== state.stage) return state
      const next = getBidStagePolicy(event.data.stage).nextStage
      return next === null ? markCompleted(event.data.stage) : advanceStage(state, next)
    }
    default: return state
  }
}

/**
 * Build Project Host-owned action and composer decisions from the authoritative task state.
 * @param task Authoritative task state.
 * @param fileLimits Host file limits exposed to the browser.
 * @returns Detached browser projection and Host-admitted actions.
 */
export function getBidClientProjection(
  task: BidTaskState,
  fileLimits: Pick<BidClientProjection, 'allowedExtensions' | 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes'> = {},
): BidClientProjection {
  const base = { task: cloneBidTaskState(task) }
  const fileView = fileLimits.allowedExtensions === undefined ? { ...fileLimits }
    : { ...fileLimits, allowedExtensions: [...fileLimits.allowedExtensions] }
  if (task.status === 'suspended') return {
    ...base,
    allowedActions: task.stage === 'chapter_writing'
      ? ['send_message', 'export_docx', 'revise_chapter'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (task.stage === 'docx_export' && task.status !== 'running' && task.status !== 'completed') return { ...base, allowedActions: ['send_message', 'export_docx'], composer: { enabled: true }, ...fileView }
  if (task.status === 'failed') return {
    ...base,
    allowedActions: ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (task.status === 'ready') return { ...base, allowedActions: ['send_message'], composer: { enabled: true }, ...fileView }
  if (task.status === 'running') return {
    ...base,
    allowedActions: task.stage === 'chapter_writing'
      ? ['send_message', 'export_docx'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (task.status === 'completed') return {
    ...base,
    allowedActions: task.stage === 'chapter_writing' || task.stage === 'docx_export'
      ? ['send_message', 'export_docx', 'revise_chapter'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (task.stage === 'file_intake') return { ...base, allowedActions: ['upload_files', 'send_message'], composer: { enabled: true }, ...fileView }
  if (task.stage === 'tender_analysis' && task.status === 'waiting_user') return { ...base, allowedActions: ['confirm_tender_analysis', 'send_message'], composer: { enabled: true }, ...fileView }
  if ((task.stage === 'outline_generation' || task.stage === 'evidence_mapping') && task.status === 'waiting_user') return { ...base, allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'], composer: { enabled: true }, ...fileView }
  if (task.stage === 'chapter_writing' && task.status === 'waiting_user') return {
    ...base,
    allowedActions: ['request_writing_requirements', 'auto_start_chapter_writing', 'send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  return { ...base, allowedActions: ['send_message'], composer: { enabled: true }, ...fileView }
}
