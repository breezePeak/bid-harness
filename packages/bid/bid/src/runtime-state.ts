import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { BID_STAGES, type BidStage } from './control-plane-contract.ts'
import type {
  BidClientProjection,
  BidRuntimeState,
  BidStagePolicy,
  BidStageTask,
} from './control-plane-contract.ts'

/** Runtime state produced by an empty Bid session log. */
export const BID_INITIAL_RUNTIME_STATE: BidRuntimeState = Object.freeze({ stage: 'file_intake', status: 'pending' })

const POLICIES: { readonly [K in BidStage]: Readonly<BidStagePolicy> } = {
  file_intake: {
    stage: 'file_intake', executor: 'program', requiredInputs: [], allowedTools: [],
    forbiddenTools: ['grep', 'read', 'write', 'bash', 'web_search'], requiredArtifacts: ['manifest.json'],
    validator: 'file-intake-validator', userGate: 'none', nextStage: 'tender_analysis',
  },
  tender_analysis: {
    stage: 'tender_analysis', executor: 'agent', requiredInputs: ['manifest.json'], allowedTools: ['grep', 'read', 'write'],
    forbiddenTools: ['bash', 'web_search'], requiredArtifacts: [
      'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json',
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
    ], allowedTools: ['grep', 'read', 'write', 'web_search', 'web_fetch'], forbiddenTools: ['bash'], requiredArtifacts: [
      'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json',
    ], validator: 'chapter-writing-validator', userGate: 'none', nextStage: 'docx_export',
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
    'Host 按已确认初步目录的业务分支生成 Mapping Task，每批可含多个 Section，只处理技术标范围。',
    '每个 Child 只接收当前批次的 Section 及其关联 Requirement、Scoring、Response Point、Compliance 和 corpus 定位。',
    '优先搜索本地资料；是否补充 Web Research 由 Agent 按章节需要判断。',
    '资料缺失写入 missing_topics，不得因此删除招标要求或评分章节。',
    '一轮映射后深化一次目录，再按 Section ID 对齐证据；新增章节保留材料缺口，拆分章节可继承原资料供 S5 筛选。',
  ],
  chapter_writing: [
    'confirmed-outline.json 是唯一章节结构来源。',
    'Host 按 execution-plan 的强依赖 DAG 调度，无依赖章节并行。',
    '每章正文生成后立即可读并启动独立 Reviewer；明确问题最多自动修复一次。',
    '企业事实和参数必须有本地 Evidence，没有可靠原文时不得虚构。',
  ],
  docx_export: ['只使用最终确认目录和已写章节。', '输出必须位于项目 output 目录。'],
}

/** Return a detached fixed policy for one Bid stage. */
export function getBidStagePolicy(stage: BidStage): BidStagePolicy {
  const policy = POLICIES[stage]
  return { ...policy, requiredInputs: [...policy.requiredInputs], allowedTools: [...policy.allowedTools],
    ...policy.forbiddenTools === undefined ? {} : { forbiddenTools: [...policy.forbiddenTools] },
    requiredArtifacts: [...policy.requiredArtifacts] }
}

/** Build the deterministic executor assignment for one stage policy. */
export function buildBidStageTask(stage: BidStage): BidStageTask {
  const policy = getBidStagePolicy(stage)
  return { stage, objective: OBJECTIVES[stage], inputs: [...policy.requiredInputs], requiredArtifacts: [...policy.requiredArtifacts],
    allowedTools: [...policy.allowedTools], constraints: [...CONSTRAINTS[stage]] }
}

/** Fold one committed session event into replayable Bid runtime state. */
export function reduceBidRuntimeState(state: BidRuntimeState, event: SessionEvent): BidRuntimeState {
  switch (event.type) {
    case 'bid.stage.started':
      return event.data.stage === state.stage && (state.status === 'pending' || state.status === 'failed' || (getBidStagePolicy(state.stage).userGate === 'after_validation' && state.status === 'waiting_user'))
        ? { stage: state.stage, status: 'running' } : state
    case 'bid.stage.failed':
      return event.data.stage === state.stage && state.status === 'running'
        ? { stage: state.stage, status: 'failed', failureReason: event.data.reason,
          ...event.data.issues === undefined ? {} : { failureIssues: event.data.issues.map(issue => ({ ...issue })) } }
        : state
    case 'bid.stage.reset':
      return BID_STAGES.indexOf(event.data.stage) <= BID_STAGES.indexOf(state.stage)
        ? { stage: event.data.stage, status: 'pending' }
        : state
    case 'bid.user_confirmation.required':
      return event.data.stage === state.stage && getBidStagePolicy(state.stage).userGate !== 'none'
        && (state.status === 'pending' || state.status === 'running' || state.status === 'failed')
        ? { stage: state.stage, status: 'waiting_user' } : state
    case 'bid.user_confirmation.received':
      if (event.data.stage !== state.stage || state.status !== 'waiting_user') return state
      return event.data.confirmed ? { stage: state.stage, status: 'running' } : { stage: state.stage, status: 'pending' }
    case 'bid.stage.completed': {
      if (event.data.stage !== state.stage || state.status !== 'running') return state
      const next = getBidStagePolicy(event.data.stage).nextStage
      return next === null ? { stage: event.data.stage, status: 'completed' } : { stage: next, status: 'pending' }
    }
    default: return state
  }
}

/** Project Host-owned Bid action and composer decisions for a client. */
export function getBidClientProjection(
  runtime: BidRuntimeState,
  fileLimits: Pick<BidClientProjection, 'allowedExtensions' | 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes'> = {},
): BidClientProjection {
  const fileView = fileLimits.allowedExtensions === undefined ? { ...fileLimits }
    : { ...fileLimits, allowedExtensions: [...fileLimits.allowedExtensions] }
  if (runtime.status === 'failed') return { runtime: { ...runtime }, allowedActions: runtime.stage === 'file_intake' ? ['upload_files'] : ['retry_stage'], composer: { enabled: false, reason: 'bid.stage_failed' }, ...fileView }
  if (runtime.status === 'running') return { runtime: { ...runtime }, allowedActions: [], composer: { enabled: false, reason: 'bid.stage_running' }, ...fileView }
  if (runtime.status === 'completed') return { runtime: { ...runtime }, allowedActions: [], composer: { enabled: false, reason: 'bid.completed' }, ...fileView }
  if (runtime.stage === 'file_intake') return { runtime: { ...runtime }, allowedActions: ['upload_files'], composer: { enabled: false, reason: 'bid.upload_required' }, ...fileView }
  if (runtime.stage === 'tender_analysis' && runtime.status === 'waiting_user') return { runtime: { ...runtime }, allowedActions: ['confirm_tender_analysis', 'send_message'], composer: { enabled: true }, ...fileView }
  if ((runtime.stage === 'outline_generation' || runtime.stage === 'evidence_mapping') && runtime.status === 'waiting_user') return { runtime: { ...runtime }, allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'], composer: { enabled: true }, ...fileView }
  return { runtime: { ...runtime }, allowedActions: [], composer: { enabled: false, reason: 'bid.stage_pending' }, ...fileView }
}
