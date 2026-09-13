import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import {
  BID_STAGES,
  BID_WORKFLOW_GATES,
  STAGE_RUN_STATUSES,
  type BidStage,
} from './control-plane-contract.ts'
import type {
  BidClientProjection,
  BidControlState,
  BidProjectWorkflow,
  BidRunSnapshot,
  BidRuntimeState,
  BidStagePolicy,
  BidStageTask,
  StageValidationIssue,
} from './control-plane-contract.ts'

/** Bid 项目文件和客户端投影允许的控制状态字段，不包含聊天内容。 */
export const bidRuntimeSchema = z.object({
  stage: z.enum(BID_STAGES),
  status: z.enum(STAGE_RUN_STATUSES),
  failureReason: z.string().optional(),
  failureIssues: z.array(z.object({
    code: z.string(),
    message: z.string(),
    artifact: z.string().optional(),
    path: z.string().optional(),
  }).strict()).readonly().optional(),
}).strict()

const stageValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  artifact: z.string().optional(),
  path: z.string().optional(),
}).strict()

/** Durable Workflow schema used by project state and Session projection replay. */
export const bidWorkflowSchema = z.object({
  stage: z.enum(BID_STAGES),
  gate: z.enum(BID_WORKFLOW_GATES),
  failureReason: z.string().optional(),
  failureIssues: z.array(stageValidationIssueSchema).readonly().optional(),
}).strict()

/** Durable identity and settlement schema for one Bid Run. */
export const bidRunSchema = z.object({
  runId: z.string().min(1),
  stage: z.enum(BID_STAGES),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseProjectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  controlRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  resumeOf: z.object({
    runId: z.string().min(1),
    cause: z.enum(['user_stop', 'retry_exhausted', 'executor_error', 'host_restart']),
  }).strict().optional(),
  resumePolicy: z.object({ webAccess: z.enum(['inherit', 'disabled']).optional() }).strict().optional(),
  status: z.enum(['running', 'cancelling', 'suspended', 'completed']),
  cause: z.enum(['user_stop', 'retry_exhausted', 'executor_error', 'host_restart']).optional(),
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    issues: z.array(stageValidationIssueSchema).readonly().optional(),
  }).strict().optional(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** Replayable Workflow and Run state. */
export const bidControlStateSchema = z.object({
  workflow: bidWorkflowSchema,
  run: bidRunSchema.nullable(),
  lastRun: bidRunSchema.nullable(),
}).strict()

/** Runtime state produced by an empty Bid session log. */
export const BID_INITIAL_RUNTIME_STATE: BidRuntimeState = Object.freeze({ stage: 'file_intake', status: 'pending' })

/** Control state produced by an empty Bid Session log. */
export const BID_INITIAL_CONTROL_STATE: BidControlState = Object.freeze({
  workflow: Object.freeze({ stage: 'file_intake', gate: 'ready' }),
  run: null,
  lastRun: null,
})

const POLICIES: { readonly [K in BidStage]: Readonly<BidStagePolicy> } = {
  file_intake: {
    stage: 'file_intake', executor: 'program', requiredInputs: [], allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'], requiredArtifacts: ['manifest.json'],
    validator: 'file-intake-validator', userGate: 'none', nextStage: 'tender_analysis',
  },
  tender_analysis: {
    stage: 'tender_analysis', executor: 'agent', requiredInputs: ['manifest.json'], allowedTools: ['grep', 'read'],
    forbiddenTools: ['write', 'bash', 'web_search', 'web_fetch', 'subagent'], requiredArtifacts: [
      'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring-origin.json', 'analysis/compliance.json',
    ], validator: 'tender-analysis-validator', userGate: 'after_validation', nextStage: 'outline_generation',
  },
  outline_generation: {
    stage: 'outline_generation', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json',
    ], allowedTools: ['read', 'write'], forbiddenTools: ['grep', 'bash', 'web_search'], requiredArtifacts: [
      'analysis/scoring-response-points.json', 'outline/outline.json', 'outline/quality-report.json',
    ], validator: 'outline-generation-validator', userGate: 'after_validation', nextStage: 'evidence_mapping',
  },
  evidence_mapping: {
    stage: 'evidence_mapping', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json',
      'analysis/scoring-response-points.json', 'analysis/compliance.json', 'outline/initial-confirmed-outline.json',
    ], allowedTools: ['read', 'write'], forbiddenTools: ['bash'], requiredArtifacts: [
      'analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/outline.json', 'outline/quality-report.json',
    ], validator: 'evidence-mapping-validator', userGate: 'after_validation', nextStage: 'chapter_writing',
  },
  chapter_writing: {
    stage: 'chapter_writing', executor: 'agent', requiredInputs: [
      'manifest.json', 'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json',
      'analysis/scoring-response-points.json', 'analysis/compliance.json', 'analysis/evidence-map.json',
      'analysis/web-evidence-sources.json', 'outline/confirmed-outline.json',
    ], allowedTools: ['grep', 'read', 'web_search', 'web_fetch'], forbiddenTools: ['bash', 'write'], requiredArtifacts: [
      'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json', 'chapters/global-compliance-review.json',
    ], validator: 'chapter-writing-validator', userGate: 'before_execution', nextStage: null,
  },
  docx_export: {
    stage: 'docx_export', executor: 'program', requiredInputs: ['outline/confirmed-outline.json', 'chapters/manifest.json'],
    allowedTools: [], forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'], requiredArtifacts: ['output/bid.docx'],
    validator: 'docx-export-validator', userGate: 'none', nextStage: null,
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

function cloneWorkflow(workflow: BidProjectWorkflow): BidProjectWorkflow {
  return {
    ...workflow,
    ...workflow.failureIssues === undefined ? {} : {
      failureIssues: workflow.failureIssues.map(cloneIssue),
    },
  }
}

function cloneRun(run: BidRunSnapshot | null): BidRunSnapshot | null {
  return run === null ? null : {
    ...run,
    ...run.error === undefined ? {} : {
      error: {
        ...run.error,
        ...run.error.issues === undefined ? {} : {
          issues: run.error.issues.map(cloneIssue),
        },
      },
    },
  }
}

/** Convert a legacy flat runtime into split Workflow and Run state. */
export function controlStateFromLegacyRuntime(runtime: BidRuntimeState, _revision = 0): BidControlState {
  const failure = runtime.failureReason === undefined ? undefined : {
    message: runtime.failureReason,
    ...runtime.failureIssues === undefined ? {} : { issues: runtime.failureIssues.map(cloneIssue) },
  }
  const legacyRun = (status: 'running' | 'suspended', cause?: 'executor_error' | 'host_restart'): BidRunSnapshot => ({
    runId: `legacy-${runtime.stage}`,
    stage: runtime.stage,
    epoch: 0,
    baseProjectRevision: 0,
    status,
    ...(cause === undefined ? {} : { cause }),
    ...(failure === undefined ? {} : { error: failure }),
    startedAt: 0,
    updatedAt: 0,
  })
  switch (runtime.status) {
    case 'running': {
      const run = legacyRun('running')
      return { workflow: { stage: runtime.stage, gate: 'ready' }, run, lastRun: null }
    }
    case 'failed': {
      const run = legacyRun('suspended', 'executor_error')
      return { workflow: { stage: runtime.stage, gate: 'ready' }, run, lastRun: run }
    }
    case 'pending': return { workflow: { stage: runtime.stage, gate: 'ready' }, run: null, lastRun: null }
    case 'waiting_start': return { workflow: { stage: runtime.stage, gate: 'waiting_start' }, run: null, lastRun: null }
    case 'waiting_user': return { workflow: { stage: runtime.stage, gate: 'waiting_user' }, run: null, lastRun: null }
    case 'attention_required': return { workflow: {
      stage: runtime.stage, gate: 'attention_required',
      ...runtime.failureReason === undefined ? {} : { failureReason: runtime.failureReason },
      ...runtime.failureIssues === undefined ? {} : { failureIssues: runtime.failureIssues.map(cloneIssue) },
    }, run: null, lastRun: null }
    case 'completed': return { workflow: { stage: runtime.stage, gate: 'completed' }, run: null, lastRun: null }
  }
}

/** Derive the existing browser view without making it the state authority. */
export function bidRuntimeView(state: BidControlState): BidRuntimeState {
  const run = state.run
  if (run?.status === 'running' || run?.status === 'cancelling') return { stage: run.stage, status: 'running' }
  if (run?.status === 'suspended') return {
    stage: state.workflow.stage,
    status: 'pending',
    ...run.error === undefined ? {} : {
      failureReason: run.error.message,
      ...run.error.issues === undefined ? {} : { failureIssues: run.error.issues.map(issue => ({ ...issue })) },
    },
  }
  const workflow = state.workflow
  return {
    stage: workflow.stage,
    status: workflow.gate === 'ready' ? 'pending' : workflow.gate,
    ...workflow.failureReason === undefined ? {} : { failureReason: workflow.failureReason },
    ...workflow.failureIssues === undefined ? {} : {
      failureIssues: workflow.failureIssues.map(issue => ({ ...issue })),
    },
  }
}

/** Fold one committed Session event into authoritative Workflow and Run state. */
export function reduceBidControlState(state: BidControlState, event: SessionEvent): BidControlState {
  switch (event.type) {
    case 'bid.project.resumed': {
      const resumed = 'workflow' in event.data ? {
        workflow: cloneWorkflow(event.data.workflow),
        run: cloneRun(event.data.run),
        lastRun: cloneRun(event.data.lastRun),
      } : controlStateFromLegacyRuntime(event.data.runtime, event.data.revision)
      return JSON.stringify(state) === JSON.stringify(resumed) ? state : resumed
    }
    case 'bid.run.started':
      return event.data.run.stage === state.workflow.stage
        ? { ...state, run: cloneRun(event.data.run) }
        : state
    case 'bid.run.start_failed':
      return state.run?.runId === event.data.runId && state.run.epoch === event.data.epoch
        ? { ...state, run: null }
        : state
    case 'bid.run.cancelling':
      return state.run?.runId === event.data.run.runId && state.run.epoch === event.data.run.epoch
        ? { ...state, run: cloneRun(event.data.run) }
        : state
    case 'bid.run.suspended':
      return state.run?.runId === event.data.run.runId && state.run.epoch === event.data.run.epoch
        ? { ...state, run: cloneRun(event.data.run), lastRun: cloneRun(event.data.run) }
        : state
    case 'bid.run.completed':
      return state.run?.runId === event.data.run.runId && state.run.epoch === event.data.run.epoch
        ? { ...state, run: null, lastRun: cloneRun(event.data.run) }
        : state
    case 'bid.workflow.failed':
      return event.data.stage === state.workflow.stage ? {
        ...state,
        workflow: {
          stage: event.data.stage,
          gate: 'failed',
          failureReason: event.data.reason,
          ...event.data.issues === undefined ? {} : { failureIssues: event.data.issues.map(issue => ({ ...issue })) },
        },
        run: null,
      } : state
    // Legacy events remain readable; execution failures become resumable Runs.
    case 'bid.stage.started': {
      if (event.data.stage !== state.workflow.stage) return state
      const run: BidRunSnapshot = {
        runId: `legacy-event-${event.data.stage}`,
        stage: event.data.stage,
        epoch: 0,
        baseProjectRevision: 0,
        status: 'running',
        startedAt: 0,
        updatedAt: 0,
      }
      return { ...state, run }
    }
    case 'bid.stage.attention_required':
      return event.data.stage === state.workflow.stage ? {
        ...state,
        workflow: { stage: event.data.stage, gate: 'attention_required', failureReason: event.data.reason,
          failureIssues: event.data.issues.map(issue => ({ ...issue })) },
        run: null,
      } : state
    case 'bid.stage.failed': {
      if (event.data.stage !== state.workflow.stage) return state
      const prior = state.run ?? {
        runId: `legacy-failure-${event.data.stage}`,
        stage: event.data.stage,
        epoch: 0,
        baseProjectRevision: 0,
        status: 'running' as const,
        startedAt: 0,
        updatedAt: 0,
      }
      const run: BidRunSnapshot = {
        ...prior,
        status: 'suspended',
        cause: 'executor_error',
        error: {
          message: event.data.reason,
          ...event.data.issues === undefined ? {} : { issues: event.data.issues.map(issue => ({ ...issue })) },
        },
      }
      return { ...state, run, lastRun: run }
    }
    case 'bid.stage.reset':
      return BID_STAGES.indexOf(event.data.stage) <= BID_STAGES.indexOf(state.workflow.stage)
        ? { workflow: { stage: event.data.stage, gate: event.data.status === 'pending' ? 'ready' : 'waiting_start' }, run: null, lastRun: state.lastRun }
        : state
    case 'bid.user_confirmation.required':
      if (event.data.stage !== state.workflow.stage || getBidStagePolicy(state.workflow.stage).userGate === 'none') return state
      return {
        ...state,
        workflow: { stage: state.workflow.stage, gate: 'waiting_user' },
        ...(state.run?.stage === event.data.stage ? {
          run: null,
          lastRun: { ...state.run, status: 'completed', updatedAt: event.time },
        } : {}),
      }
    case 'bid.user_confirmation.received':
      return event.data.stage === state.workflow.stage && state.workflow.gate === 'waiting_user'
        ? { ...state, workflow: { stage: state.workflow.stage, gate: 'ready' } }
        : state
    case 'bid.stage.completed': {
      if (event.data.stage !== state.workflow.stage) return state
      const next = getBidStagePolicy(event.data.stage).nextStage
      return {
        ...state,
        workflow: next === null
          ? { stage: event.data.stage, gate: 'completed' }
          : { stage: next, gate: 'ready' },
        ...(state.run?.stage === event.data.stage ? {
          run: null,
          lastRun: { ...state.run, status: 'completed', updatedAt: event.time },
        } : {}),
      }
    }
    default: return state
  }
}

/** Compatibility reducer for callers that only need the flattened browser view. */
export function reduceBidRuntimeState(state: BidRuntimeState, event: SessionEvent): BidRuntimeState {
  return bidRuntimeView(reduceBidControlState(controlStateFromLegacyRuntime(state), event))
}

/** Project Host-owned action and composer decisions from split Workflow and Run state. */
export function getBidClientProjection(
  source: BidControlState | BidRuntimeState,
  fileLimits: Pick<BidClientProjection, 'allowedExtensions' | 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes'> = {},
): BidClientProjection {
  const state = 'workflow' in source ? source : controlStateFromLegacyRuntime(source)
  const runtime = bidRuntimeView(state)
  const base = {
    workflow: cloneWorkflow(state.workflow),
    run: cloneRun(state.run),
    runtime,
  }
  const fileView = fileLimits.allowedExtensions === undefined ? { ...fileLimits }
    : { ...fileLimits, allowedExtensions: [...fileLimits.allowedExtensions] }
  if (state.run?.status === 'suspended') return {
    ...base,
    allowedActions: state.workflow.stage === 'chapter_writing'
      ? ['send_message', 'export_docx', 'revise_chapter'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (state.workflow.stage === 'docx_export' && runtime.status !== 'running' && runtime.status !== 'completed') return { ...base, allowedActions: ['export_docx'], composer: { enabled: false, reason: 'bid.stage_pending' }, ...fileView }
  if (state.workflow.gate === 'failed') return {
    ...base,
    allowedActions: ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (runtime.stage === 'chapter_writing' && runtime.status === 'attention_required') return {
    ...base, allowedActions: ['send_message', 'export_docx', 'revise_chapter'],
    composer: { enabled: true }, ...fileView,
  }
  if (runtime.status === 'waiting_start') return { ...base, allowedActions: ['start_stage'], composer: { enabled: false, reason: 'bid.stage_start_required' }, ...fileView }
  if (runtime.status === 'running') return {
    ...base,
    allowedActions: runtime.stage === 'chapter_writing'
      ? ['send_message', 'export_docx'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (runtime.status === 'completed') return {
    ...base,
    allowedActions: runtime.stage === 'chapter_writing' || runtime.stage === 'docx_export'
      ? ['send_message', 'export_docx', 'revise_chapter'] : ['send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  if (runtime.stage === 'file_intake') return { ...base, allowedActions: ['upload_files'], composer: { enabled: false, reason: 'bid.upload_required' }, ...fileView }
  if (runtime.stage === 'tender_analysis' && runtime.status === 'waiting_user') return { ...base, allowedActions: ['confirm_tender_analysis', 'send_message'], composer: { enabled: true }, ...fileView }
  if ((runtime.stage === 'outline_generation' || runtime.stage === 'evidence_mapping') && runtime.status === 'waiting_user') return { ...base, allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'], composer: { enabled: true }, ...fileView }
  if (runtime.stage === 'chapter_writing' && runtime.status === 'waiting_user') return {
    ...base,
    allowedActions: ['request_writing_requirements', 'auto_start_chapter_writing', 'send_message'],
    composer: { enabled: true },
    ...fileView,
  }
  return { ...base, allowedActions: [], composer: { enabled: false, reason: 'bid.stage_pending' }, ...fileView }
}
