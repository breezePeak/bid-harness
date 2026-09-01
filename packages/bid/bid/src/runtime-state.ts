import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  BidClientProjection,
  BidRuntimeState,
  BidStage,
  BidStagePolicy,
  BidStageTask,
} from './control-plane-contract.ts'

/** Runtime state produced by an empty Bid session log. */
export const BID_INITIAL_RUNTIME_STATE: BidRuntimeState = Object.freeze({
  stage: 'file_intake',
  status: 'pending',
})

const POLICIES: { readonly [K in BidStage]: Readonly<BidStagePolicy> } = {
  file_intake: {
    stage: 'file_intake',
    executor: 'program',
    requiredInputs: [],
    allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'],
    requiredArtifacts: ['manifest.json'],
    validator: 'file-intake-validator',
    userGate: 'none',
    nextStage: 'tender_analysis',
  },
  tender_analysis: {
    stage: 'tender_analysis',
    executor: 'agent',
    requiredInputs: ['manifest.json'],
    allowedTools: ['grep', 'read', 'write'],
    forbiddenTools: ['bash', 'web_search'],
    requiredArtifacts: [
      'analysis/project.json',
      'analysis/requirements.json',
      'analysis/scoring.json',
      'analysis/scoring-response-points.json',
      'analysis/compliance.json',
    ],
    validator: 'tender-analysis-validator',
    userGate: 'after_validation',
    nextStage: 'evidence_mapping',
  },
  evidence_mapping: {
    stage: 'evidence_mapping',
    executor: 'agent',
    requiredInputs: [
      'analysis/project.json',
      'analysis/requirements.json',
      'analysis/scoring.json',
      'analysis/scoring-response-points.json',
      'analysis/compliance.json',
    ],
    allowedTools: ['read', 'write'],
    forbiddenTools: ['grep', 'bash', 'web_search', 'web_fetch'],
    requiredArtifacts: ['analysis/evidence-map.json', 'analysis/web-evidence-sources.json'],
    validator: 'evidence-mapping-validator',
    userGate: 'none',
    nextStage: 'outline_generation',
  },
  outline_generation: {
    stage: 'outline_generation',
    executor: 'agent',
    requiredInputs: [
      'analysis/project.json',
      'analysis/requirements.json',
      'analysis/scoring.json',
      'analysis/scoring-response-points.json',
      'analysis/compliance.json',
      'analysis/evidence-map.json',
    ],
    allowedTools: ['read', 'write'],
    forbiddenTools: ['grep', 'bash', 'web_search'],
    requiredArtifacts: ['outline/outline.json'],
    validator: 'outline-generation-validator',
    userGate: 'none',
    nextStage: 'outline_confirmation',
  },
  outline_confirmation: {
    stage: 'outline_confirmation',
    executor: 'user',
    requiredInputs: ['outline/outline.json'],
    allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'],
    requiredArtifacts: ['outline/confirmed-outline.json', 'outline/confirmation.json'],
    validator: 'outline-confirmation-validator',
    userGate: 'before_execution',
    nextStage: 'chapter_writing',
  },
  chapter_writing: {
    stage: 'chapter_writing',
    executor: 'agent',
    requiredInputs: [
      'manifest.json',
      'analysis/project.json',
      'analysis/requirements.json',
      'analysis/scoring.json',
      'analysis/scoring-response-points.json',
      'analysis/compliance.json',
      'analysis/evidence-map.json',
      'outline/confirmed-outline.json',
      'outline/confirmation.json',
    ],
    allowedTools: ['read', 'write'],
    forbiddenTools: ['grep', 'bash', 'web_search', 'web_fetch'],
    requiredArtifacts: ['chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json'],
    validator: 'chapter-writing-validator',
    userGate: 'none',
    nextStage: 'book_review',
  },
  book_review: {
    stage: 'book_review',
    executor: 'program',
    requiredInputs: ['analysis/scoring-response-points.json', 'outline/confirmed-outline.json', 'chapters/manifest.json'],
    allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'],
    requiredArtifacts: ['review/report.json'],
    validator: 'book-review-validator',
    userGate: 'after_validation',
    nextStage: 'docx_export',
  },
  docx_export: {
    stage: 'docx_export',
    executor: 'program',
    requiredInputs: ['chapters/manifest.json', 'review/report.json'],
    allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'],
    requiredArtifacts: ['output/bid.docx'],
    validator: 'docx-export-validator',
    userGate: 'none',
    nextStage: null,
  },
}

const OBJECTIVES: { readonly [K in BidStage]: string } = {
  file_intake: '校验已入库的投标语料和分块索引。',
  tender_analysis: '提取招标项目、要求、评分项和合规规则。',
  evidence_mapping: '对齐人工框架、分析旧标书复用、映射资料并准备评分响应点写作维度。',
  outline_generation: '继承框架与旧标书映射，生成可直接指导后续章节写作的详细技术标 Blueprint。',
  outline_confirmation: '确认技术标目录并固化供章节写作使用的最终版本。',
  chapter_writing: '按确认目录保留补充、适配改写或新写全部技术标章节。',
  book_review: '审核整本投标文件的完整性和内部一致性。',
  docx_export: '把已通过校验的投标内容导出为 DOCX。',
}

const CONSTRAINTS: { readonly [K in BidStage]: readonly string[] } = {
  file_intake: ['只使用已入库的工作区文件。', '不得调用 Agent。'],
  tender_analysis: [
    '首先读取 manifest.json，并覆盖全部成功解析的 tender 文件。',
    '只把 tender 资料作为招标要求、评分项和合规规则的权威来源。',
    '搜索命中后必须读取原文，不得一次读取完整 document.md。',
    '只写入要求的分析 Artifact。',
    '不得虚构招标要求或评分语义。',
  ],
  evidence_mapping: [
    '只处理技术标范围，不得搜索商务、资格或报价资料。',
    '主 Agent 先全局分析并动态拆分 Mapping Tasks；Host 使用独立 Child Session 并发执行实际检索和映射。',
    '当前 tender 决定技术要求、评分项和合规约束；人工框架决定优先目录骨架，旧标书仅提供可适配的结构和正文。',
    '把每个评分 response_point 下沉为可供目录和章节消费的写作维度；没有特殊资产时仍应形成从头生成目录所需的维度。',
    '每个 Mapping Child 只接收当前任务相关的 Requirement、Scoring、Response Point、Compliance 和 corpus 定位。',
    'Child 根据当前任务自主决定是否 grep、read、web_search 或 web_fetch；grep 只定位候选，读取原始 chunk 或网页正文后再判断其研究价值。',
    '企业事实只能使用本地资料证明；本地缺失时记录 missing_topics。',
    'Child 只返回 structured partial result；主 Agent 分析合并后只写入要求的 evidence-map Artifact。',
  ],
  outline_generation: [
    '读取 S2 Artifact 和 S3 evidence-map，以人工框架为优先骨架并消费参考旧标书映射，覆盖全部技术要求、评分项和合规规则。',
    'Evidence 缺失只能形成写作备注，不能省略目录；不得重新进行全局资料映射。',
    '不得使用 Web Search、grep 或生成章节正文。',
    '只写入要求的目录 Artifact。',
  ],
  outline_confirmation: ['必须取得用户的明确决定。', '必须固化已确认目录。', '不得调用 Agent。'],
  chapter_writing: [
    '主 Agent 只分析章节关系并写入 execution-plan.json；所有章节正文和 metadata 均由 spawn Subagent 生成。',
    'Host 按 execution-plan 的强依赖 DAG 调度；无依赖或弱关联章节在并发上限内并行。',
    '人工框架和旧标书不得覆盖当前 tender 的项目名称、范围、周期、数量、技术环境、交付和验收要求。',
    '先消费 S3 本地与外部 Evidence；不足时先本地补搜，仅对仍缺少的公开技术知识执行 web_search 后 web_fetch。',
    '企业事实、产品参数、人员经验和既有能力必须有本地 Evidence；缺失时保留 unresolved_topics。',
    '没有可靠原文时不得虚构数字、标准号、版本、企业能力或历史事实。',
  ],
  book_review: ['在要求的审核 Artifact 中记录未解决缺陷。', '不得改写控制面状态。'],
  docx_export: ['只导出已通过校验的章节内容。', '不得调用 Agent。'],
}

/**
 * Return the single fixed policy for a Bid stage.
 * @param stage - stage whose policy is required.
 * @returns a detached policy owned by the Bid control plane.
 */
export function getBidStagePolicy(stage: BidStage): BidStagePolicy {
  const policy = POLICIES[stage]
  return {
    ...policy,
    requiredInputs: [...policy.requiredInputs],
    allowedTools: [...policy.allowedTools],
    ...policy.forbiddenTools === undefined ? {} : { forbiddenTools: [...policy.forbiddenTools] },
    requiredArtifacts: [...policy.requiredArtifacts],
  }
}

/**
 * Build the deterministic executor assignment for one stage policy.
 * @param stage - stage for which the host creates an assignment.
 * @returns a detached task that executors may consume without mutating policy data.
 */
export function buildBidStageTask(stage: BidStage): BidStageTask {
  const policy = getBidStagePolicy(stage)
  return {
    stage,
    objective: OBJECTIVES[stage],
    inputs: [...policy.requiredInputs],
    requiredArtifacts: [...policy.requiredArtifacts],
    allowedTools: [...policy.allowedTools],
    constraints: [...CONSTRAINTS[stage]],
  }
}

/**
 * Fold one committed session event into the replayable Bid runtime state.
 * @param state - state covering all earlier events.
 * @param event - next committed DSH session event.
 * @returns the next state, or the same reference for events not owned by Bid.
 */
export function reduceBidRuntimeState(state: BidRuntimeState, event: SessionEvent): BidRuntimeState {
  switch (event.type) {
    case 'bid.stage.started':
      return event.data.stage === state.stage
        && getBidStagePolicy(state.stage).executor !== 'user'
        && (state.status === 'pending' || state.status === 'failed')
        ? { stage: state.stage, status: 'running' }
        : state
    case 'bid.stage.failed':
      return event.data.stage === state.stage
        && state.status === 'running'
        ? {
          stage: state.stage,
          status: 'failed',
          failureReason: event.data.reason,
          ...(event.data.issues === undefined ? {} : { failureIssues: event.data.issues.map(issue => ({ ...issue })) }),
        }
        : state
    case 'bid.user_confirmation.required':
      return event.data.stage === state.stage
        && getBidStagePolicy(state.stage).userGate !== 'none'
        && (state.status === 'pending' || state.status === 'running' || state.status === 'failed')
        ? { stage: state.stage, status: 'waiting_user' }
        : state
    case 'bid.stage.completed': {
      if (event.data.stage !== state.stage) return state
      if (state.status !== 'running') return state
      const nextStage = getBidStagePolicy(event.data.stage).nextStage
      return nextStage === null
        ? { stage: event.data.stage, status: 'completed' }
        : { stage: nextStage, status: 'pending' }
    }
    case 'bid.user_confirmation.received':
      if (event.data.stage !== state.stage || state.status !== 'waiting_user') return state
      return event.data.confirmed
        ? { stage: state.stage, status: 'running' }
        : { stage: 'outline_generation', status: 'pending' }
    default:
      return state
  }
}

/**
 * Project host-owned Bid action and composer decisions for a client.
 * @param runtime - current state derived from the session log.
 * @param fileLimits - Host-configured file constraints exposed to the browser.
 * @returns a detached whole-value client projection.
 */
export function getBidClientProjection(
  runtime: BidRuntimeState,
  fileLimits: Pick<
    BidClientProjection,
    'allowedExtensions' | 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes'
  > = {},
): BidClientProjection {
  const fileView = fileLimits.allowedExtensions === undefined
    ? { ...fileLimits }
    : { ...fileLimits, allowedExtensions: [...fileLimits.allowedExtensions] }
  if (runtime.status === 'failed') {
    return {
      runtime: { ...runtime },
      allowedActions: runtime.stage === 'file_intake' ? ['upload_files'] : ['retry_stage'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
      ...fileView,
    }
  }
  if (runtime.status === 'running') {
    return {
      runtime: { ...runtime },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_running' },
      ...fileView,
    }
  }
  if (runtime.status === 'completed') {
    return {
      runtime: { ...runtime },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.completed' },
      ...fileView,
    }
  }
  if (runtime.stage === 'file_intake' && runtime.status === 'pending') {
    return {
      runtime: { ...runtime },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.upload_required' },
      ...fileView,
    }
  }
  if (runtime.stage === 'outline_confirmation' && runtime.status === 'waiting_user') {
    return {
      runtime: { ...runtime },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
      composer: { enabled: false, reason: 'bid.outline_confirmation_required' },
      ...fileView,
    }
  }
  if (runtime.stage === 'book_review' && runtime.status === 'waiting_user') {
    return {
      runtime: { ...runtime },
      allowedActions: ['send_message', 'complete_review'],
      composer: { enabled: true },
      ...fileView,
    }
  }
  if (runtime.stage === 'tender_analysis' && runtime.status === 'waiting_user') {
    return {
      runtime: { ...runtime },
      allowedActions: ['confirm_tender_analysis'],
      composer: { enabled: false, reason: 'bid.tender_analysis_confirmation_required' },
      ...fileView,
    }
  }
  return {
    runtime: { ...runtime },
    allowedActions: [],
    composer: { enabled: false, reason: 'bid.stage_pending' },
    ...fileView,
  }
}
