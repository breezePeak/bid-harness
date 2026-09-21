import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { ToolArgsError, type ObjectJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { zodJsonSchema } from './zod-json-schema.ts'
import { applyOutlineEdits, outlineEditOperationSchema, parseOutlineEditOperations, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { outlineArtifactSha256, parseOutlineDraft, type OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { outlineRegenerationChanges, parseOutlineRegenerationChangeSet } from './outline-regeneration-artifacts.ts'
import type { BidWorkspace } from './index.ts'
import { BidStageExecutionError, type BidStageTask, type StageArtifact, type StageValidationIssue } from './control-plane-contract.ts'
import {
  type ModelStageExecutionOptions,
  renderStageRepairIssues,
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import {
  type OutlineArtifact,
  type OutlineQualityIssue,
  outlineQualityIssueSchema,
  parseOutlineQualityReport,
  OUTLINE_GENERATION_SCHEMA_VERSION,
  OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
} from './outline-generation-artifacts.ts'
import { loadOutlineFrameworkStructures, validateOutlineFrameworkRefs, type OutlineFrameworkStructure } from './outline-framework.ts'
import {
  catalogMatchesScoring,
  parseScoringResponsePointCatalog,
  type ScoringResponsePointCatalog,
  createScoringResponsePointCatalog,
  parseScoringResponsePointCandidate,
  scoringResponsePointCandidateSchema,
  type ScoringResponsePointCandidate,
} from './scoring-response-point-artifacts.ts'
import { parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderComplianceArtifact, parseTenderScoringArtifact, type TenderScoringArtifact, type TenderRequirementsArtifact, type TenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { applyOutlineRepair, outlineRepairOperationSchema, outlineAssociationRepairOperationSchema } from './outline-generation-repair.ts'
import { inspectOutlineCandidate, applyOutlineCandidateRepair, outlineCandidateRepairSchema, parseOutlineFormatRepair } from './outline-candidate-repair.ts'
import { missingOutlineResponsePoints, validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { installMainAgentProtocol } from './main-agent-protocol.ts'
import { customerFacingOutlineText, findBidInternalIdentifiers } from './customer-facing-prose.ts'

const OUTLINE_ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT_ARTIFACT = 'outline/quality-report.json'
const QUALITY_REPORT_TOOL = 'submit_outline_quality_review'
const RESPONSE_POINT_CANDIDATE = 'analysis/scoring-response-points.candidate.json'
const RESPONSE_POINT_CATALOG = 'analysis/scoring-response-points.json'
const REPAIR_RECEIPT = 'outline/repair-operations.json'
const REGENERATION_CHANGE_SET = 'outline/regeneration/change-set.json'
const qualityReportSubmissionSchema = z.object({ issues: z.array(outlineQualityIssueSchema) }).strict()

// 子代理结构化输出仅接受结构约束；Host 的 Zod 解析保留全部标量约束。
function removeUnsupportedSubagentSchemaConstraints(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) removeUnsupportedSubagentSchemaConstraints(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  const schema = value as Record<string, unknown>
  delete schema.$schema
  delete schema.minLength
  delete schema.exclusiveMinimum
  delete schema.maximum
  for (const child of Object.values(schema)) removeUnsupportedSubagentSchemaConstraints(child)
}

const rawScoringResponsePointCandidateOutputSchema = zodJsonSchema(scoringResponsePointCandidateSchema)
removeUnsupportedSubagentSchemaConstraints(rawScoringResponsePointCandidateOutputSchema)
const scoringResponsePointCandidateOutputSchema: ObjectJsonSchema = {
  ...rawScoringResponsePointCandidateOutputSchema,
  type: 'object',
}

/** Drop a no-op same-mode escalation while preserving every genuinely wider request. */
function withoutRedundantSandboxEscalation(agent: Agent, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  let mode: string | undefined
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index] as { type?: string; data?: { mode?: unknown } } | undefined
    if (event?.type === 'sandbox/mode' && typeof event.data?.mode === 'string') {
      mode = event.data.mode
      break
    }
  }
  const input = args as Record<string, unknown>
  if (mode === undefined || input.sandbox_permissions !== mode) return args
  const standingArgs = { ...input }
  delete standingArgs.sandbox_permissions
  delete standingArgs.justification
  return standingArgs
}

async function readWithConfiguredLimit(tool: ToolDefinition, args: unknown, exec: ToolRunContext): Promise<unknown> {
  try {
    return await tool.execute(args, exec)
  } catch (error) {
    const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined
    if (input?.limit === undefined || !(error instanceof Error) || !error.message.startsWith('limit must be ')) throw error
    const defaultLimitArgs = { ...input }
    delete defaultLimitArgs.limit
    return tool.execute(defaultLimitArgs, exec)
  }
}

function resolveStageTool(agent: Agent, name: string): ToolDefinition | undefined {
  const tools = agent.ctx.get('tools')
  const direct = tools?.get(name, agent)
  if (direct !== undefined || agent.session.header.origin !== 'subagent') return direct
  const parentId = agent.session.header.parentSession
  if (parentId === undefined) return undefined
  const parent = agent.ctx.get('agents')?.get(parentId)
  return parent?.ctx.get('tools')?.get(name, parent)
}

function renderOutlineRevisionFeedback(feedback: string): string {
  return `以当前持久化 Draft 为基线，保留未涉及章节、全部招标要求和评分覆盖。按以下用户反馈重构目录，不得只在 writing_notes 中转述：\n<outline-revision-feedback>\n${feedback}\n</outline-revision-feedback>`
}

/**
 * 使用独立、无文件写权限的 Child 生成局部编辑操作，与整本重生成共用反馈规则和目录 Validator。
 * @param agent 当前 Main Agent，不等待其工具调用结束。
 * @param draft 最近一次读取的 CAS 基线。
 * @param sectionIds 选中章节或分支。
 * @param feedback 用户反馈。
 * @param signal 当前 Host 操作取消信号。
 * @returns 只修改选中子树的编辑操作；调用方经 mutateOutlineDraft 校验后提交。
 */
export async function generateScopedOutlineOperations(
  agent: Agent, draft: OutlineDraftView, sectionIds: readonly string[], feedback: string, signal: AbortSignal,
): Promise<OutlineEditOperation[]> {
  const selected = outlineSectionScope(draft.outline, sectionIds)
  const subagents = agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) throw new Error('局部目录重生成需要独立上下文的 spawn provider。')
  const run = await subagents.start('spawn', {
    parent: agent, signal, label: '局部目录重生成', maxDepth: 1, toolFilter: { allow: [] },
    prompt: [{ type: 'text', text: [
      renderOutlineRevisionFeedback(feedback),
      `当前 Draft：${JSON.stringify(draft)}`,
      `只允许修改以下章节及其子树：${JSON.stringify(sectionIds)}。保留选中根的 ID、父节点和位置；不得修改范围外节点。拆分叶子使用 split_section，合并同级叶子使用 merge_sections。`,
      '不得写文件。最终只返回原始 JSON 编辑操作数组，新增 ID 由 Host 分配。操作必须符合：',
      JSON.stringify(zodJsonSchema(z.array(outlineEditOperationSchema))),
    ].join('\n') }],
  })
  try {
    const result = await run.result
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`BID_REGENERATE_FAILED: ${result.stopReason}`)
    const operations = parseOutlineEditOperations(JSON.parse(result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('')))
    const candidate = applyOutlineEdits(draft.outline, operations)
    const candidateScope = outlineSectionScope(candidate, sectionIds)
    if (sectionIds.some((id) => {
      const before = draft.outline.sections.find(section => section.id === id)
      const after = candidate.sections.find(section => section.id === id)
      return before === undefined || after === undefined || before.parent_id !== after.parent_id || before.order !== after.order
    })) throw new Error('BID_OUTLINE_SCOPE_VIOLATION')
    const changes = outlineRegenerationChanges(draft.outline, candidate)
    if (changes.some(change => change.type === 'add' ? !candidateScope.has(change.section_id) : !selected.has(change.section_id))) throw new Error('BID_OUTLINE_SCOPE_VIOLATION')
    return operations
  } finally { await run.dispose() }
}

/** Optional user-feedback regeneration identity layered onto bounded, resumable S3 execution. */
export interface OutlineGenerationExecutionOptions extends ModelStageExecutionOptions {
  readonly regeneration?: { readonly feedback: string; readonly revision: number; readonly draftSha256: string }
}

/** Return the latest durable user feedback that requested an outline regeneration. */
function latestOutlineFeedback(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index--) {
    const event = agent.session.events[index]
    if (event?.type === 'bid.user_confirmation.received'
      && (event.data.stage === 'outline_generation' || event.data.stage === 'evidence_mapping')
      && !event.data.confirmed) return event.data.feedback
  }
  return undefined
}

/** Render the S3 semantic scoring analysis assignment. */
function renderResponsePointAnalysisTask(
  agent: Agent,
  task: BidStageTask,
  scoring: TenderScoringArtifact,
): string {
  const scoringIds = scoring.scoring_items.map(item => item.id)
  return [
    `当前阶段：${task.stage} / 评分响应点分析`,
    `Bid Session：${agent.id}`,
    '以下是本次需要分析的评分项 JSON，由 Host 提供：',
    `<scoring-json>\n${JSON.stringify(scoring)}\n</scoring-json>`,
    '逐项理解评分语义，将每个评分项拆成一个或多个可独立回答、可独立审查，或在实际评分逻辑中明显独立评价的最小合理业务单元。重点识别原文明列事项、包括或包括但不限于的独立内容、编号或分号列项、逐项得分或扣分，以及虽在同一句但可独立编写审查的技术内容。',
    '不要按顿号、逗号、和、及或分值数量机械切分。完整、合理、可行、准确、符合要求等质量判断词不是独立写作主题，除非原文明确定义为分别响应的评价维度；不得凭常识新增原文没有依据的评分内容。',
    '返回前逐项自检：不得遗漏原文明列事项，不得错误合并独立内容，不得过度拆碎完整单义要求，不得把质量评价词误作主题，也不得新增原文没有的内容。',
    '典型逐项计分原文中的项目目标、预期成果、总体设计对相关政策与现有条件的符合性、软件技术路线、总体设计应分别保留；整体表述“总体方案完整、合理、可行，得5分”应保留为一个合理响应点，不得按分值拆成五项。',
    `scoring_id 必须逐字复制 Host 提供的 id；本次合法 ID：${JSON.stringify(scoringIds)}。`,
    '每个 scoring_id 至少一个响应点，同一评分项的 order 从 1 连续递增。稳定 RP ID 由 Host 分配。',
    '请在本轮内部完成一次自检，然后直接返回最终候选。Host 不会再启动第二个评分响应点复核 Agent。',
  ].join('\n')
}

/**
 * Render the dynamic S3 assignment for the live Bid Agent.
 * @param agent Agent executing the outline-generation stage.
 * @param workspace Bid project workspace exposed to that Agent.
 * @param task Deterministic stage assignment.
 * @param regeneration Optional constrained regeneration request.
 * @param frameworks Imported outline frameworks available to the stage.
 * @returns Complete model instruction for the current S3 execution.
 */
export function renderOutlineGenerationTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  regeneration?: OutlineGenerationExecutionOptions['regeneration'],
  frameworks: readonly OutlineFrameworkStructure[] = [],
): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  const feedback = regeneration?.feedback ?? latestOutlineFeedback(agent)
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Project Workspace：${root}`,
    '先读取以下结构化 Artifact：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    `本阶段只允许调用：${task.allowedTools.join(', ')}。不得 Web Search、bash 或重新进行全库资料映射。`,
    ...(frameworks.length === 0 ? [
      '目录模式：无人工框架。以评分响应点和评分项为主要拆分依据，自主生成完整技术标目录，再用 mandatory Requirements、其他 Requirements 和 Compliance 补充。语义相近的评分响应点可以合并到同一技术主题；每个稳定 Response Point ID 必须至少落入一个合适的可写叶子，同一 Response Point 可以由多个章节共同支撑。',
    ] : [
      '目录模式：存在人工框架。以下结构由 Host 从 manifest 中成功解析的 outline_framework 直接提取。第一个是 primary framework，决定主要层级和顺序；其余仅补充 primary 缺失的合理技术章节，不得打乱主要骨架。当前 Tender、稳定 Response Points、人工框架、reference_bid 结构、自主补充依次决定必须响应内容、语义颗粒度、整体组织、缺口参考和剩余补充。',
      '先按 primary framework 初始化骨架：精确覆盖时直接复用，过粗时保留父标题并增加子章节，缺失 Tender 必须内容时在合适位置新增，旧项目污染或非技术标标题才排除。无直接评分点但合理的技术章节可以保留；不得要求每个框架标题都绑定评分点。Framework 高于 reference_bid，但绝不覆盖当前 Tender。',
      `<outline-framework-structures>\n${JSON.stringify(frameworks)}\n</outline-framework-structures>`,
    ]),
    '根据 Project、Requirements、Scoring、Compliance 和稳定评分响应点目录设计技术标详细写作 Blueprint。此阶段不读取或推断证据映射。',
    '技术标目录只组织投标人需要展开的技术方案、实施措施和交付成果。投标资格、企业资质证书、行政递交或其他只需材料核验的 Compliance 放入 global_compliance_ids，不得为复述或解释这类要求单独创建可写章节；与技术任务混合时，章节只承担可作答的技术部分。',
    `本轮初稿唯一输出：${root}/${OUTLINE_ARTIFACT}。Host 随后会强制发送一次 Blueprint Quality Review。`,
    `文件严格包含 schema_version=${OUTLINE_GENERATION_SCHEMA_VERSION}、scope="technical_bid"、document_title、global_compliance_ids、sections。不得写 content、body、markdown 或任何正文。`,
    'sections 是 parent_id + order 的扁平树。每个节点严格包含 id、parent_id、order、level、title、purpose、writable、must_answer、requirement_ids、scoring_ids、compliance_ids、origin、framework_refs、scoring_response_point_ids、suggested_tables、suggested_figures、writing_notes。origin 只说明目录结构来源，取 framework/generated/mixed，不是 Evidence ID。framework_refs 使用 [{"file_id":"...","heading_path":["..."]}] 追溯原框架标题：直接继承为 framework，调整或在框架下扩展为 mixed，Tender 全新增为 generated 且数组为空。',
    '模型只选择 scoring_response_point_ids，不必抄写 scoring_response_points；Host 从正式清单按选择顺序重建快照并合并所属 scoring_ids。每个 RP 至少由一个合适的可写叶子覆盖，也可由多个章节共同响应。不得修改正式清单或猜测 RP 编号。',
    'writable 节点必须有至少一个具体 must_answer。父评分、子评分和通用质量评分可以同时关联。结构节点 writable=false、must_answer=[] 且必须有子节点。章节标题应按技术语义表达组织、阶段、质量、风险、安全、验收等内容，但不要套固定模板。',
    '不要创建“目录”章节。Host 固定保留 id=dsh-technical-deviation-table、title=技术偏离表的可写第一章；封面和目录由导出程序生成，第二章以后才组织本项目的动态技术正文。',
    '技术响应索引、偏离表或合规清单只能作为索引或附录，不能集中承担正文覆盖。mandatory Requirement 和重点 Scoring 必须在对应的实质性可写叶子中映射；索引重复引用不能替代正文拆分。',
    '每个 Requirement、Scoring 和 Compliance ID 都必须至少覆盖一次；mandatory Requirement，以及 must_answer=true、带 score 或 score_range 的 Scoring，必须关联至少一个 writable 节点。一个 ID 可出现在多个章节，但同一数组不得重复。Compliance 可以放在 global_compliance_ids 或具体章节。',
    ...(feedback === undefined ? [] : [
      `先读取 ${root}/outline/draft.json，并以其中当前持久化目录为唯一修改基线；未被反馈涉及的章节必须保持不变。`,
      ...(regeneration === undefined ? [] : [
        `当前基线 revision=${String(regeneration.revision)}，draft hash=${regeneration.draftSha256}。`,
        `同时写入 ${root}/${REGENERATION_CHANGE_SET}，严格包含 schema_version=1、base_revision、base_draft_sha256、changes；每个实际 update/add/delete/move 都必须逐项登记 section_id、type、reason，不得登记不存在的变更。`,
      ]),
      renderOutlineRevisionFeedback(feedback),
    ]),
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '写完文件后停止；Host 将独立验证树结构、引用和覆盖。',
  ].join('\n')
}

/** Render the required post-draft review assignment for the live Bid Agent. */
function renderBlueprintQualityReviewTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage} / Blueprint Quality Review`,
    `Bid Session：${agent.id}`,
    '这是强制复核；即使初稿看起来完整，也必须完成后才可停止。',
    '重新读取 Requirements、Scoring、Compliance、评分响应点目录和当前 outline.json：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    `- ${root}/${OUTLINE_ARTIFACT}`,
    `本阶段只允许调用：${task.allowedTools.join(', ')}、${QUALITY_REPORT_TOOL}。不得 Web Search、bash 或重新进行全库资料映射。`,
    '逐项检查每个技术 Requirement、Scoring、稳定 Response Point 和 Compliance 是否落在合适位置；重点判断评分项实际要求证明的内容，而非只检查 ID 是否出现。投标资格、企业资质证书、行政递交或其他只需材料核验的 Compliance 必须留在 global_compliance_ids，不得单独形成正文页；发现此类章节时删除或合并其技术内容。根据评分语义判断章节是否聚焦一个可独立编写的技术主题；技术响应索引、偏离表或合规清单不得集中承担正文覆盖。must_answer 必须具体。存在 Framework 时还要检查主要骨架、顺序和关键技术章节是否合理继承，框架过粗处是否按 RP 扩展，是否产生重复主题，framework_refs 与 origin 是否符合实际来源，旧项目污染是否清理。',
    '发现章节过粗、多个明显技术主题混在一节、评分项未真实拆解、must_answer 过泛、结构与可写职责混淆或其他问题时，先修改 outline/outline.json；保留原有严格 JSON 字段和全部引用覆盖。',
    '这是 S3 唯一一次完整 Blueprint Quality Review。必须在本轮内阅读目录、检查语义质量、直接修正阻断问题，并自行复查修改结果；Host 不会因为本轮修改了 outline 而启动第二轮完整 Review。',
    `修正后调用 ${QUALITY_REPORT_TOOL}，只提交 issues=[{code,severity:"advisory",message}]。code 使用大写下划线标识，issues 可以记录仍需用户判断的非阻断语义建议；阻断问题必须先修复目录。`,
    `Host 为当前复核目录生成 schema_version=${OUTLINE_QUALITY_REPORT_SCHEMA_VERSION}、scope、checked_* 和 reviewed_section_ids 并写入正式质量报告。工具返回 submitted=true 后停止；Host 会独立校验报告集合、树结构和引用覆盖。`,
  ].join('\n')
}

/**
 * 将目录差集与正式响应点交给模型，只接受现有目录编辑操作。
 * @param agent 当前目录 Agent。
 * @param workspace 项目工作区。
 * @param task S3 任务。
 * @param issues 基础校验问题。
 * @param context 当前目录、正式清单及上一轮操作失败原因。
 * @returns 只写局部操作候选的修复任务。
 */
export function renderOutlineGenerationRepairTask(
  agent: Agent, workspace: BidWorkspace, task: BidStageTask, issues: readonly StageValidationIssue[],
  context: {
    outline: OutlineArtifact
    catalog: ScoringResponsePointCatalog
    scoring: TenderScoringArtifact
    failure?: string | undefined
    associations?: {
      requirements: TenderRequirementsArtifact
      compliance: TenderComplianceArtifact
      frameworks: readonly OutlineFrameworkStructure[]
    }
  },
): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  const missing = missingOutlineResponsePoints(context.outline, context.catalog).map((point) => {
    const item = context.scoring.scoring_items.find(item => item.id === point.scoring_id)
    if (item === undefined) throw new Error('正式响应点清单引用了未知评分项 ' + point.scoring_id)
    return { ...point, scoring_raw_text: item.raw_text }
  })
  return [
    '当前阶段：outline_generation / ' + (context.associations === undefined ? '局部响应点修复' : '局部关联与结构修复'),
    'Bid Session：' + agent.id,
    '正式响应点清单（只读，不得修改、删除或重新分配编号）：' + root + '/' + RESPONSE_POINT_CATALOG,
    JSON.stringify(context.catalog),
    '当前目录（包含 purpose、must_answer 和已有关联）：' + JSON.stringify(context.outline),
    '未被可写叶子覆盖的响应点及所属评分原文：' + JSON.stringify(missing),
    ...(context.associations === undefined ? [] : [
      '权威需求原文、合规规则、合法框架文件与标题路径（只读）：' + JSON.stringify(context.associations),
      '全部正式评分原文（只读）：' + JSON.stringify(context.scoring),
      '按问题选择 requirement_ids、scoring_ids、compliance_ids、framework_refs、origin 或 global_compliance_ids 的局部操作；新增或拆分章节时明确分配必要关联。结构错误使用 move/add/delete/split/merge 或 repair_structure；repair_structure 仅修改声明节点的结构字段，只有重复 ID 才能换编号。',
    ]),
    ...renderStageRepairIssues(issues), context.failure ?? '',
    '判断已有章节能否承担：能则补充关联并完善具体 must_answer；确实缺少内容时新增章节或局部拆分。保留未涉及章节的 ID、内容和相对顺序。不得默认挂到第一章、结构父节点或集中放入索引附录。只补编号没有实际写作指导不算修复。',
    '只返回局部编辑操作，不得重写 outline.json 或质量报告。scoring_response_point_ids 是章节最终选定的完整列表，保留已有合理关联。新增 ID 由 Host 分配。',
    '唯一输出：' + root + '/outline/repair-operations.json',
    JSON.stringify(zodJsonSchema(z.array(context.associations === undefined
      ? outlineRepairOperationSchema : outlineAssociationRepairOperationSchema))),
  ].join('\n')
}

/**
 * Execute S3 through the live Agent and return its expected Artifacts.
 * @param agent - live Bid Agent used for Blueprint generation and repair.
 * @param workspace - Workspace 级 Bid 项目.
 * @param task - Host-issued outline-generation task and Tool policy.
 * @param options - Run authority plus the optional user-feedback regeneration identity.
 * @returns Artifact descriptors for the Orchestrator-owned formal validation boundary.
 */
export async function executeOutlineGeneration(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  options: OutlineGenerationExecutionOptions,
): Promise<StageArtifact[]> {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.run.signal)
  const frameworks = await loadOutlineFrameworkStructures(workspace)
  const path = (artifact: string): string => join(workspace.projectRoot, artifact)
  const scratchRoot = join(workspace.projectRoot, 'runs', options.run.runId, 'scratch', 'outline-generation')
  const scratchPath = (artifact: string): string => join(scratchRoot, artifact)
  const scratchArtifacts = new Set<string>()
  const read = async (artifact: string): Promise<string | undefined> => {
    const candidate = scratchArtifacts.has(artifact) ? scratchPath(artifact) : path(artifact)
    await assertNoLinkedPath(workspace.root, candidate)
    try { return await readFile(candidate, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!scratchArtifacts.has(artifact)) return undefined
      await assertNoLinkedPath(workspace.root, path(artifact))
      try { return await readFile(path(artifact), 'utf8') } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== 'ENOENT') throw fallback
        return undefined
      }
    }
  }
  const write = async (artifact: string, value: unknown): Promise<void> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    await options.run.commits.writeJson(path(artifact), value)
    scratchArtifacts.delete(artifact)
    await rm(scratchPath(artifact), { force: true })
  }
  const remove = async (artifact: string): Promise<void> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    await options.run.commits.remove(path(artifact))
    const fs = agent.ctx.get('fs')
    if (fs !== undefined) agent.ctx.emit('fs/observed', await fs.resolve(path(artifact)), { kind: 'absent' }, { agent })
  }
  await assertNoLinkedPath(workspace.root, path('outline'))
  await mkdir(path('outline'), { recursive: true, mode: 0o700 })
  if (options.regeneration === undefined && await read('outline/initial-confirmed-outline.json') !== undefined) throw new Error('S3 已有用户确认目录，不能用失败重试覆盖确认结果。')
  const readInput = async <T>(artifact: string, parse: (value: unknown) => T): Promise<T> => {
    const raw = await read(artifact)
    try { return parse(JSON.parse(raw ?? 'null')) } catch (error) {
      throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_INVALID', artifact, message: '正式输入缺失或损坏：' + (error instanceof Error ? error.message : String(error)) }])
    }
  }
  await readInput('analysis/project.json', parseTenderProjectArtifact)
  const scoring = await readInput('analysis/scoring.json', parseTenderScoringArtifact)
  const requirements = await readInput('analysis/requirements.json', parseTenderRequirementsArtifact)
  const compliance = await readInput('analysis/compliance.json', parseTenderComplianceArtifact)
  const validateResponsePointCandidate = (value: unknown): ScoringResponsePointCandidate => {
    try {
      const candidate = parseScoringResponsePointCandidate(typeof value === 'string' ? JSON.parse(value) : value)
      createScoringResponsePointCatalog(scoring, candidate)
      return candidate
    } catch (error) {
      throw new BidStageExecutionError([{
        code: 'OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID',
        artifact: RESPONSE_POINT_CANDIDATE,
        message: error instanceof Error ? error.message : String(error),
      }])
    }
  }
  const generateResponsePointCandidate = async (
    label: string,
    prompt: string,
  ): Promise<ScoringResponsePointCandidate> => {
    const subagents = agent.ctx.get('subagents')
    if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
      throw new Error('S3 评分响应点分析需要独立上下文的 spawn provider。')
    }
    await options.run.scheduler.waitUntilRunnable(options.run.signal)
    const child = await subagents.start('spawn', {
      parent: agent,
      signal: options.run.signal,
      label,
      prompt: [{ type: 'text', text: prompt }],
      outputSchema: scoringResponsePointCandidateOutputSchema,
      toolFilter: { allow: [] },
      maxDepth: 1,
      persona: '你是评分响应点分析 Subagent。只分析 Host 注入的评分内容，不调用工具、不派生其他 Agent，并通过结构化输出返回完整候选。',
    })
    try {
      const result = await child.result
      if (result.stopReason !== 'completed') {
        throw new Error(`评分响应点 Subagent 未正常完成：${result.stopReason}。${result.diagnostic ?? ''}`)
      }
      if (result.structured === undefined) throw new Error('评分响应点 Subagent 未返回结构化候选。')
      return validateResponsePointCandidate(result.structured)
    } catch (error) {
      if (options.run.signal.aborted) throw error
      if (error instanceof BidStageExecutionError) throw error
      throw new BidStageExecutionError([{
        code: 'OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID',
        artifact: RESPONSE_POINT_CANDIDATE,
        message: error instanceof Error ? error.message : String(error),
      }])
    } finally {
      await child.dispose()
    }
  }
  const inputVersion = createHash('sha256').update(JSON.stringify(await Promise.all(task.inputs.map(async input => [input, await read(input)])))).digest('hex')
  const previousVersion = await read('outline/generation-inputs.json')
  if (previousVersion !== undefined && await readInput('outline/generation-inputs.json', value => z.string().parse(value)) !== inputVersion) {
    throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_CHANGED', artifact: 'outline/generation-inputs.json', message: 'S3 正式输入版本已变化，不能继续使用当前候选。请按阶段重置流程更新输入；已保留目录与正式 RP 清单。' }])
  }
  await write('outline/generation-inputs.json', inputVersion)
  const catalogRaw = await read(RESPONSE_POINT_CATALOG)
  let catalog = catalogRaw === undefined ? undefined : await readInput(RESPONSE_POINT_CATALOG, parseScoringResponsePointCatalog)
  if (catalog === undefined && await read(OUTLINE_ARTIFACT) !== undefined) throw new BidStageExecutionError([
    { code: 'OUTLINE_GENERATION_INPUT_INVALID', artifact: RESPONSE_POINT_CATALOG, message: '已有目录候选缺少正式 RP 清单，不能通过重新分配编号恢复。' },
  ])
  if (catalog !== undefined && !catalogMatchesScoring(catalog, scoring)) {
    throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_MISMATCH', artifact: RESPONSE_POINT_CATALOG, message: '正式响应点清单与 S2 评分版本不匹配；不能通过重写正式输入修复候选。' }])
  }

  const artifacts: StageArtifact[] = [
    { stage: 'outline_generation', type: 'scoring_response_points', path: RESPONSE_POINT_CATALOG },
    { stage: 'outline_generation', type: 'outline', path: OUTLINE_ARTIFACT },
    { stage: 'outline_generation', type: 'outline_quality_report', path: QUALITY_REPORT_ARTIFACT },
  ]
  const canonicalOutlineRaw = await read(OUTLINE_ARTIFACT)
  const qualityReportRaw = await read(QUALITY_REPORT_ARTIFACT)
  const draftRaw = await read('outline/draft.json')
  if (options.regeneration === undefined && qualityReportRaw !== undefined) {
    if (catalog === undefined || canonicalOutlineRaw === undefined) throw new BidStageExecutionError([{
      code: 'OUTLINE_GENERATION_CHECKPOINT_INVALID', artifact: QUALITY_REPORT_ARTIFACT,
      message: '质量复核检查点缺少正式响应点清单或目录。',
    }])
    const candidate = inspectOutlineCandidate(canonicalOutlineRaw, catalog, scoring)
    if (candidate.kind !== 'valid') throw new BidStageExecutionError([{
      code: 'OUTLINE_GENERATION_CHECKPOINT_INVALID', artifact: OUTLINE_ARTIFACT,
      message: '质量复核检查点对应的目录无法解析。',
    }, ...candidate.issues])
    await readInput(QUALITY_REPORT_ARTIFACT, parseOutlineQualityReport)
    const hash = outlineArtifactSha256(candidate.outline)
    if (draftRaw !== undefined) {
      const draft = await readInput('outline/draft.json', parseOutlineDraft)
      if (draft.source_outline_sha256 !== hash || draft.draft_outline_sha256 !== hash
        || outlineArtifactSha256(draft.outline) !== hash) throw new BidStageExecutionError([{
        code: 'OUTLINE_GENERATION_DRAFT_MISMATCH', artifact: 'outline/draft.json',
        message: '目录草稿哈希与已复核目录不一致，不能静默覆盖。请重新执行当前阶段。',
      }])
    } else {
      await write('outline/draft.json', {
        schema_version: 1,
        scope: 'technical_bid',
        revision: 1,
        source_outline_sha256: hash,
        draft_outline_sha256: hash,
        outline: candidate.outline,
      } satisfies OutlineDraftView)
    }
    options.run.reportProgress({
      phase: 'finalizing',
      summary: options.run.resumeOf === undefined ? '目录质量复核已完成，正在执行最终目录校验' : '已恢复 S3，目录质量复核已完成，继续最终验收',
      completed: candidate.outline.sections.length,
      total: candidate.outline.sections.length,
    })
    return artifacts
  }
  if (options.regeneration === undefined && draftRaw !== undefined) throw new BidStageExecutionError([{
    code: 'OUTLINE_GENERATION_CHECKPOINT_INVALID', artifact: 'outline/draft.json',
    message: '目录草稿缺少对应的质量复核检查点，不能作为恢复依据。',
  }])

  if (catalog === undefined) {
    if (options.regeneration !== undefined) throw new Error('目录重新生成缺少有效的正式响应点清单。')
    options.run.reportProgress({
      phase: 'analyzing',
      summary: '正在拆解评分响应点',
      total: scoring.scoring_items.length,
      details: [`评分项 ${String(scoring.scoring_items.length)} 项`],
    })
    const candidate = await generateResponsePointCandidate('评分响应点分析', renderResponsePointAnalysisTask(agent, task, scoring))
    const candidatePath = scratchPath(RESPONSE_POINT_CANDIDATE)
    await assertNoLinkedPath(workspace.root, candidatePath)
    await options.run.commits.writeJson(candidatePath, candidate)
    catalog = createScoringResponsePointCatalog(scoring, candidate)
    await write(RESPONSE_POINT_CATALOG, catalog)
  }
  const formalCatalog = catalog
  const handoff = '\n正式响应点清单（只读，不得修改、删除或重新分配编号）：' + relative(workspace.root, path(RESPONSE_POINT_CATALOG)).replaceAll('\\', '/')
    + '\n' + JSON.stringify(formalCatalog)

  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('S3 需要 tools 服务。')
  let writablePaths: string[] = []
  const allowed = new Set([...task.allowedTools, QUALITY_REPORT_TOOL])
  const writeTool = resolveStageTool(agent, 'write')
  if (writeTool === undefined) throw new Error('S3 需要 write 工具。')
  const liftWriteShadow = tools.register({
    ...writeTool,
    execute: (args, exec) => writeTool.execute(withoutRedundantSandboxEscalation(agent, args), exec),
  })
  const readTool = resolveStageTool(agent, 'read')
  if (readTool === undefined) throw new Error('S3 需要 read 工具。')
  const liftReadShadow = tools.register({
    ...readTool,
    execute: (args, exec) => readWithConfiguredLimit(readTool, args, exec),
  })
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard((exec) => {
    if (!allowed.has(exec.name)) return 'S3 仅允许读取输入及写入当前任务指定的候选文件。'
    if (exec.name !== 'write' || exec.arguments === undefined) return undefined
    const args = z.object({ file_path: z.string() }).safeParse(exec.arguments)
    if (!args.success || !writablePaths.some(artifact => relative(artifact, resolve(workspace.root, args.data.file_path)) === '')) {
      return '正式响应点、确认目录与其他输入只读；只能写入当前任务指定的候选文件。'
    }
    return undefined
  })
  const run = async (
    prompt: string,
    outputs: string[],
    privateTask?: {
      readonly names: readonly string[]
      readonly setEnabled: (enabled: boolean) => void
    },
    preserveOutputs = false,
  ): Promise<void> => {
    options.run.signal.throwIfAborted()
    await options.run.scheduler.waitUntilRunnable(options.run.signal)
    await Promise.all(outputs.map(async (output) => {
      const candidate = scratchPath(output)
      await assertNoLinkedPath(workspace.root, candidate)
      await mkdir(join(candidate, '..'), { recursive: true, mode: 0o700 })
      if (preserveOutputs) {
        const formal = path(output)
        await assertNoLinkedPath(workspace.root, formal)
        try {
          await copyFile(formal, candidate, constants.COPYFILE_EXCL)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'ENOENT') throw error
        }
      } else {
        await rm(candidate, { force: true })
      }
      scratchArtifacts.add(output)
    }))
    writablePaths = outputs.map(scratchPath)
    const eventStart = agent.session.events.length
    const modelPrompt = outputs.reduce((text, output) => text.replaceAll(
      relative(workspace.root, path(output)).replaceAll('\\', '/'),
      relative(workspace.root, scratchPath(output)).replaceAll('\\', '/'),
    ), prompt) + '\n当前 DSH file policy 为 workspace-write 或 danger-full-access 时，调用 write 不得传 sandbox_permissions 或 justification；只有 read-only 下首次写入被沙箱拒绝后，才按错误提示做一次严格升级重试。'
    const message = createUserMessage({ content: [{ type: 'text', text: modelPrompt }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } })
    const protocol = installMainAgentProtocol(agent, {
      privateTools: privateTask?.names ?? [],
      setPrivateToolsEnabled: privateTask?.setEnabled,
      label: 'S3 Outline Generation',
    })
    protocol.own(message)
    const unbindMainAgent = options.run.bindMainAgent({
      cancel: () => { agent.cancel({ kind: 'hook', reason: 'bid-run-suspended' }, { keepInbox: true }) },
      whenIdle: () => agent.whenIdle(),
      discardOwnedInbox: () => { protocol.discardOwnedInbox() },
    })
    try {
      agent.followup(message)
      await waitForModelStageIdle(agent, options.run.signal)
    } finally {
      unbindMainAgent()
      protocol.dispose()
    }
    const end = agent.session.events.slice(eventStart).findLast(event => event.type === 'turn/end')
    if (end?.data.reason.kind !== 'completed') {
      const reason = end?.data.reason.kind === 'error' ? end.data.reason.error.message : end?.data.reason.kind ?? '没有完成记录'
      throw new Error('S3 模型任务未正常完成，保留当前候选；本轮不能标记为已复核。原因：' + reason)
    }
    writablePaths = []
  }
  const runQualityReview = async (prompt: string, allowOutlineWrite: boolean): Promise<OutlineQualityIssue[] | undefined> => {
    let submittedIssues: OutlineQualityIssue[] | undefined
    const definition = {
      name: QUALITY_REPORT_TOOL,
      description: '提交当前 Blueprint Quality Review 的非阻断语义建议；Host 生成并持久化正式质量报告。',
      parameters: zodJsonSchema(qualityReportSubmissionSchema),
      output: {
        schema: { type: 'object' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      presentCall: () => ({ card: 'generic', title: '提交目录质量复核' }),
      execute(args: unknown, exec: ToolRunContext) {
        if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
        const parsed = qualityReportSubmissionSchema.safeParse(args)
        if (!parsed.success) {
          throw new ToolArgsError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`))
        }
        submittedIssues = parsed.data.issues
        return Promise.resolve({ submitted: true, issue_count: submittedIssues.length })
      },
    } satisfies ToolDefinition
    let enabled = true
    let dispose: (() => void) | undefined = tools.register(definition)
    const setEnabled = (next: boolean): void => {
      if (enabled === next) return
      enabled = next
      if (next) dispose = tools.register(definition)
      else { dispose?.(); dispose = undefined }
    }
    try {
      await run(prompt, allowOutlineWrite ? [OUTLINE_ARTIFACT] : [], {
        names: [QUALITY_REPORT_TOOL],
        setEnabled,
      }, allowOutlineWrite)
    } finally {
      setEnabled(false)
    }
    return submittedIssues
  }
  try {
    const generated = options.regeneration !== undefined || canonicalOutlineRaw === undefined
    if (generated) {
      await remove(REPAIR_RECEIPT)
      await remove(QUALITY_REPORT_ARTIFACT)
      options.run.reportProgress({
        phase: 'generating',
        summary: options.run.resumeOf === undefined || options.regeneration !== undefined
          ? '正在生成初步技术标目录' : '已恢复 S3，评分响应点已完成，继续生成初步目录',
        total: formalCatalog.points.length,
        details: [`评分响应点 ${String(formalCatalog.points.length)} 项`],
      })
      await run(renderOutlineGenerationTask(agent, workspace, task, options.regeneration, frameworks) + handoff,
        [OUTLINE_ARTIFACT, ...(options.regeneration === undefined ? [] : [REGENERATION_CHANGE_SET])])
    }
    const validate = async (outline: OutlineArtifact): Promise<StageValidationIssue[]> => {
      const issues: StageValidationIssue[] = []
      const customerTextContext = { outline, requirements, scoring, compliance, responsePoints: formalCatalog }
      for (const field of customerFacingOutlineText(outline)) {
        const leaked = findBidInternalIdentifiers(field.text, customerTextContext)
        if (leaked.length > 0) {
          issues.push({
            code: 'OUTLINE_GENERATION_INTERNAL_ID_VISIBLE',
            message: `${field.path} 包含系统内部编号 ${leaked.join('、')}；请改用招标文件原有编号或自然语言。`,
            path: field.path,
          })
        }
      }
      validateOutlineSharedStructure(outline.sections, issues)
      validateOutlineSharedCoverage(outline, requirements, scoring, compliance, formalCatalog, issues)
      await validateOutlineFrameworkRefs(workspace, outline, issues)
      return issues
    }

    const publishOutline = async (outline: OutlineArtifact, receipt?: unknown): Promise<void> => {
      await options.run.commits.publish(async (lease) => {
        await lease.writeJson(path(OUTLINE_ARTIFACT), outline)
        if (receipt === undefined) await lease.remove(path(REPAIR_RECEIPT))
        else await lease.writeJson(path(REPAIR_RECEIPT), receipt)
        await lease.remove(path(QUALITY_REPORT_ARTIFACT))
      })
      for (const artifact of [OUTLINE_ARTIFACT, REPAIR_RECEIPT]) {
        scratchArtifacts.delete(artifact)
        await rm(scratchPath(artifact), { force: true })
      }
    }
    let raw = (await read(OUTLINE_ARTIFACT)) ?? ''
    let candidate = inspectOutlineCandidate(raw, formalCatalog, scoring)
    if (candidate.kind === 'format') {
      const output = 'outline/format-repair.json'
      await remove(output)
      await assertNoLinkedPath(workspace.root, path('outline/format-repair-source.txt'))
      await options.run.commits.writeText(path('outline/format-repair-source.txt'), raw)
      await run([
        '当前阶段：outline_generation / 候选 JSON 格式修复',
        '问题位置与原因：' + JSON.stringify(candidate.issues),
        '原始候选（只读）：\n' + raw,
        '只修复 JSON 序列化标点和空白，保留字符串、数值、字面值及其顺序；禁止调整章节、拆解评分、重分配 RP 或重生成目录。无法在此范围内恢复时说明原因。输出恢复后的 JSON。',
        '唯一可写输出：' + relative(workspace.root, path(output)).replaceAll('\\', '/'),
      ].join('\n'), [output])
      try {
        raw = JSON.stringify(parseOutlineFormatRepair(raw, (await read(output)) ?? ''))
      } catch (error) {
        if (options.run.signal.aborted) throw error
        throw new BidStageExecutionError([...candidate.issues, {
          code: 'OUTLINE_CANDIDATE_FORMAT_REPAIR_FAILED', artifact: OUTLINE_ARTIFACT,
          message: error instanceof Error ? error.message : String(error),
        }])
      }
      candidate = inspectOutlineCandidate(raw, formalCatalog, scoring)
      if (candidate.kind === 'format') throw new BidStageExecutionError(candidate.issues)
    }

    let repairUsed = await read(REPAIR_RECEIPT) !== undefined
    if (repairUsed) await readInput(REPAIR_RECEIPT, value => z.array(z.unknown()).parse(value))
    let outline: OutlineArtifact
    if (candidate.kind === 'fields') {
      if (candidate.issues.some(issue => issue.field === null || issue.field === 'sections')) throw new BidStageExecutionError([
        ...candidate.issues, { code: 'OUTLINE_CANDIDATE_UNRECOVERABLE', artifact: OUTLINE_ARTIFACT,
          message: '候选缺少可恢复的目录或章节对象；字段修复不能重生成整章或整本目录，已保留原始候选。' },
      ])
      if (repairUsed) throw new BidStageExecutionError([...candidate.issues, {
        code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', artifact: REPAIR_RECEIPT,
        message: '当前目录候选已经使用过一次确定性修复，不能再次启动修复。',
      }])
      options.run.reportProgress({ phase: 'repairing', summary: '正在修正目录确定性问题', completed: 0, total: 1,
        details: candidate.issues.slice(0, 5).map(issue => `${issue.code}：${issue.message}`) })
      const output = 'outline/candidate-repair.json'
      await remove(output)
      await run([
        '当前阶段：outline_generation / 候选字段修复',
        '问题位置与原因：' + JSON.stringify(candidate.issues),
        '原始候选（只读）：\n' + raw,
        '只输出已定位字段的局部操作。section_index 指原始数组下标，section_id 与 path 供核对；禁止整章或整本替换。未知 ID 必须根据原文重新明确选择合法关联，不能删除未知 ID 了事、模糊替换或默认挂到某章。RP 快照由 Host 派生，修复快照错误时只选择 scoring_response_point_ids。删除额外字段用 remove=true。\n' + JSON.stringify(zodJsonSchema(outlineCandidateRepairSchema)),
        '权威输入（只读，不得修改）：' + JSON.stringify({ catalog: formalCatalog, scoring, requirements, compliance, frameworks }),
        '唯一可写输出：' + relative(workspace.root, path(output)).replaceAll('\\', '/'),
      ].join('\n'), [output])
      let operations: unknown
      try {
        operations = JSON.parse((await read(output)) ?? 'null')
        const repaired = applyOutlineCandidateRepair(candidate.value, operations, candidate.issues,
          { catalog: formalCatalog, scoring, requirements, compliance, frameworks })
        const inspected = inspectOutlineCandidate(JSON.stringify(repaired), formalCatalog, scoring)
        if (inspected.kind !== 'valid') throw new BidStageExecutionError(inspected.issues)
        outline = inspected.outline
      } catch (error) {
        if (options.run.signal.aborted || error instanceof BidStageExecutionError) throw error
        throw new BidStageExecutionError([...candidate.issues, {
          code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: output,
          message: error instanceof Error ? error.message : String(error),
        }])
      }
      await publishOutline(outline, operations)
      repairUsed = true
    } else {
      outline = candidate.outline
      if (generated) await publishOutline(outline)
      else if (canonicalOutlineRaw !== JSON.stringify(outline)) await write(OUTLINE_ARTIFACT, outline)
    }

    options.run.reportProgress({
      phase: 'validating',
      summary: options.run.resumeOf === undefined ? '正在校验目录结构与响应覆盖'
        : repairUsed ? '已恢复 S3，目录修复已保存，继续复核修复结果' : '已恢复 S3，目录候选已保存，继续进行确定性校验',
      completed: outline.sections.length,
      total: outline.sections.length,
      details: [`目录节点 ${String(outline.sections.length)} 个`, `评分响应点 ${String(formalCatalog.points.length)} 项`],
    })
    let issues = await validate(outline)
    if (issues.length > 0) {
      if (repairUsed) throw new BidStageExecutionError([...issues, {
        code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', artifact: REPAIR_RECEIPT,
        message: '当前目录候选已经使用过一次确定性修复，仍未通过校验。',
      }])
      options.run.reportProgress({ phase: 'repairing', summary: '正在修正目录确定性问题', completed: 0, total: 1,
        details: issues.slice(0, 5).map(issue => `${issue.code}：${issue.message}`) })
      const rpOnly = issues.every(issue => issue.code.includes('RESPONSE_POINT'))
      await run(renderOutlineGenerationRepairTask(agent, workspace, task, issues, {
        outline, catalog: formalCatalog, scoring,
        ...(rpOnly ? {} : { associations: { requirements, compliance, frameworks } }),
      }), [REPAIR_RECEIPT])
      const operationSchema = rpOnly ? outlineRepairOperationSchema : outlineAssociationRepairOperationSchema
      let operations: unknown
      let repaired: OutlineArtifact
      try {
        operations = z.array(operationSchema).parse(JSON.parse((await read(REPAIR_RECEIPT)) ?? 'null'))
        repaired = applyOutlineRepair(outline, operations, formalCatalog, scoring)
      } catch (error) {
        if (options.run.signal.aborted) throw error
        throw new BidStageExecutionError([...issues, {
          code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: REPAIR_RECEIPT,
          message: error instanceof Error ? error.message : String(error),
        }])
      }
      const repairedIssues = await validate(repaired)
      const prior = [...issues]
      const introduced = repairedIssues.filter((issue) => {
        if (issue.code.endsWith('_MISSING')) return false
        const index = prior.findIndex(previous => previous.code === issue.code
          && previous.path === issue.path && previous.message === issue.message)
        if (index < 0) return true
        prior.splice(index, 1)
        return false
      })
      if (introduced.length > 0) throw new BidStageExecutionError([...issues, {
        code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: REPAIR_RECEIPT,
        message: '局部操作引入非法引用或结构，未保存：' + JSON.stringify(introduced),
      }])
      outline = repaired
      issues = repairedIssues
      await publishOutline(outline, operations)
      repairUsed = true
      if (issues.length > 0) throw new BidStageExecutionError([...issues, {
        code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', artifact: REPAIR_RECEIPT,
        message: '唯一一次确定性修复后仍有问题，已保留修复后的目录候选。',
      }])
    }

    options.run.reportProgress({
      phase: 'reviewing',
      summary: '正在进行最终目录质量复核',
      completed: outline.sections.length,
      total: outline.sections.length,
    })
    let qualityIssues = await runQualityReview(renderBlueprintQualityReviewTask(agent, workspace, task) + handoff
      + '\n本轮完整复核目录：' + JSON.stringify(outline)
      + '\n本轮完整复核的招标要求、评分及合规：' + JSON.stringify({ requirements, scoring, compliance }), true)
    if (qualityIssues === undefined) {
      qualityIssues = await runQualityReview([
        '当前阶段：outline_generation / Blueprint Quality Review Submission',
        `Bid Session：${agent.id}`,
        `上一轮 Blueprint Quality Review 已完成，但未调用 ${QUALITY_REPORT_TOOL}。不得再修改 outline.json；只调用该工具提交上一轮质量复核结果，然后停止。`,
      ].join('\n'), false)
    }
    if (qualityIssues === undefined) throw new BidStageExecutionError([{
      code: 'OUTLINE_GENERATION_QUALITY_SUBMISSION_REQUIRED', artifact: QUALITY_REPORT_ARTIFACT,
      message: `质量复核及唯一一次协议补交均未调用 ${QUALITY_REPORT_TOOL}。`,
    }])
    const reviewedCandidate = inspectOutlineCandidate((await read(OUTLINE_ARTIFACT)) ?? '', formalCatalog, scoring)
    if (reviewedCandidate.kind !== 'valid') throw new BidStageExecutionError(reviewedCandidate.issues)
    const reviewed = reviewedCandidate.outline
    const reviewedIssues = await validate(reviewed)
    if (reviewedIssues.length > 0) throw new BidStageExecutionError(reviewedIssues)
    const report = {
      schema_version: OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
      scope: 'technical_bid' as const,
      issues: qualityIssues,
      checked_requirement_ids: requirements.requirements.map(item => item.id),
      checked_scoring_ids: scoring.scoring_items.map(item => item.id),
      checked_scoring_response_point_ids: formalCatalog.points.map(point => point.id),
      reviewed_section_ids: reviewed.sections.map(section => section.id),
    }
    await options.run.commits.publish(async (lease) => {
      await lease.writeJson(path(OUTLINE_ARTIFACT), reviewed)
      await lease.writeJson(path(QUALITY_REPORT_ARTIFACT), report)
    })
    scratchArtifacts.delete(OUTLINE_ARTIFACT)
    await rm(scratchPath(OUTLINE_ARTIFACT), { force: true })

    if (options.regeneration !== undefined) {
      const draft = parseOutlineDraft(JSON.parse((await read('outline/draft.json')) ?? 'null'))
      const changeSet = parseOutlineRegenerationChangeSet(JSON.parse((await read(REGENERATION_CHANGE_SET)) ?? 'null'))
      await write(REGENERATION_CHANGE_SET, { ...changeSet, changes: outlineRegenerationChanges(draft.outline, reviewed).map(change => ({
        ...change, reason: changeSet.changes.find(item => item.section_id === change.section_id && item.type === change.type)?.reason ?? '响应点覆盖修复及目录质量复核',
      })) })
    } else {
      const hash = outlineArtifactSha256(reviewed)
      await write('outline/draft.json', {
        schema_version: 1,
        scope: 'technical_bid',
        revision: 1,
        source_outline_sha256: hash,
        draft_outline_sha256: hash,
        outline: reviewed,
      } satisfies OutlineDraftView)
    }
    options.run.reportProgress({
      phase: 'finalizing', summary: '正在执行最终目录校验',
      completed: reviewed.sections.length, total: reviewed.sections.length,
    })
    await waitForModelStageIdle(agent, options.run.signal)
    return artifacts
  } finally {
    liftGuard()
    liftRestriction()
    liftReadShadow()
    liftWriteShadow()
  }
}
