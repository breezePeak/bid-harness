import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { applyOutlineEdits, outlineEditOperationSchema, parseOutlineEditOperations, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { parseOutlineDraft, type OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { outlineRegenerationChanges, parseOutlineRegenerationChangeSet } from './outline-regeneration-artifacts.ts'
import type { BidWorkspace } from './index.ts'
import { BidStageExecutionError, type BidStageTask, type StageArtifact, type StageValidationIssue } from './control-plane-contract.ts'
import {
  DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
  type ModelStageExecutionOptions,
  renderStageRepairIssues,
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import {
  type OutlineArtifact,
  type OutlineQualityIssue,
  outlineQualityIssueSchema,
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
} from './scoring-response-point-artifacts.ts'
import { parseTenderRequirementsArtifact, parseTenderComplianceArtifact, parseTenderScoringArtifact, type TenderScoringArtifact, type TenderRequirementsArtifact, type TenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { applyOutlineRepair, outlineRepairOperationSchema, outlineAssociationRepairOperationSchema } from './outline-generation-repair.ts'
import { inspectOutlineCandidate, applyOutlineCandidateRepair, outlineCandidateRepairSchema, parseOutlineFormatRepair } from './outline-candidate-repair.ts'
import { missingOutlineResponsePoints, validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const OUTLINE_ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT_ARTIFACT = 'outline/quality-report.json'
const QUALITY_REPORT_TOOL = 'submit_outline_quality_review'
const RESPONSE_POINT_CANDIDATE = 'analysis/scoring-response-points.candidate.json'
const RESPONSE_POINT_CATALOG = 'analysis/scoring-response-points.json'
const REGENERATION_CHANGE_SET = 'outline/regeneration/change-set.json'
const qualityReportSubmissionSchema = z.object({ issues: z.array(outlineQualityIssueSchema) }).strict()

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
      JSON.stringify(z.toJSONSchema(z.array(outlineEditOperationSchema))),
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

/** Optional user-feedback regeneration identity layered onto normal S3 execution. */
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
function renderResponsePointAnalysisTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage} / 评分响应点分析`,
    `Bid Session：${agent.id}`,
    `读取 ${root}/analysis/scoring.json。`,
    '逐项理解评分语义，将每个评分项拆成一个或多个可独立回答、可独立审查，或在实际评分逻辑中明显独立评价的最小合理业务单元。重点识别原文明列事项、包括或包括但不限于的独立内容、编号或分号列项、逐项得分或扣分，以及虽在同一句但可独立编写审查的技术内容。',
    '不要按顿号、逗号、和、及或分值数量机械切分。完整、合理、可行、准确、符合要求等质量判断词不是独立写作主题，除非原文明确定义为分别响应的评价维度；不得凭常识新增原文没有依据的评分内容。',
    `唯一输出：${root}/${RESPONSE_POINT_CANDIDATE}。严格写入 {"schema_version":1,"points":[{"scoring_id":"SCORE-...","order":1,"text":"具体响应点"}]}。`,
    '每个 scoring_id 至少一个响应点，同一评分项的 order 从 1 连续递增。写完停止，稳定 RP ID 由 Host 分配。',
  ].join('\n')
}

/**
 * Render the independent S3 semantic review that repairs the candidate in place.
 * @param agent - live Bid Agent receiving the review assignment.
 * @param workspace - Workspace 级 Bid 项目.
 * @returns model-visible semantic review instructions.
 */
export function renderResponsePointSemanticReviewTask(agent: Agent, workspace: BidWorkspace): string {
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    '当前阶段：outline_generation / Response Point Semantic Review',
    `Bid Session：${agent.id}`,
    `重新读取 ${root}/analysis/scoring.json 和 ${root}/${RESPONSE_POINT_CANDIDATE}。`,
    '逐个评分项复核：原文明列事项是否遗漏，多个独立内容是否错误合并，完整单义要求是否过度拆碎，质量评价词是否误作写作主题，是否新增无原文依据的内容，scoring_id 与顺序是否正确，每个响应点是否具体到可直接用于目录设计。',
    '典型逐项计分原文中的项目目标、预期成果、总体设计对相关政策与现有条件的符合性、软件技术路线、总体设计应分别保留；完整、合理可行、现状分析准确清晰、符合项目要求、满足采购需求仍是质量标准。整体表述“总体方案完整、合理、可行，得5分”应保留为一个合理响应点，不得按分值拆成五项。',
    `发现过粗、遗漏或误拆时直接重写 ${root}/${RESPONSE_POINT_CANDIDATE}；没有问题则保持文件内容。不得另写 review report。完成后停止，Host 只校验 JSON、scoring_id、每项至少一点、连续 order 和非空文本。`,
  ].join('\n')
}

/** Render the dynamic S3 assignment for the live Bid Agent. */
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
    `本轮初稿唯一输出：${root}/${OUTLINE_ARTIFACT}。Host 随后会强制发送一次 Blueprint Quality Review。`,
    `文件严格包含 schema_version=${OUTLINE_GENERATION_SCHEMA_VERSION}、scope="technical_bid"、document_title、global_compliance_ids、sections。不得写 content、body、markdown 或任何正文。`,
    'sections 是 parent_id + order 的扁平树。每个节点严格包含 id、parent_id、order、level、title、purpose、writable、must_answer、requirement_ids、scoring_ids、compliance_ids、origin、framework_refs、scoring_response_point_ids、suggested_tables、suggested_figures、writing_notes。origin 只说明目录结构来源，取 framework/generated/mixed，不是 Evidence ID。framework_refs 使用 [{"file_id":"...","heading_path":["..."]}] 追溯原框架标题：直接继承为 framework，调整或在框架下扩展为 mixed，Tender 全新增为 generated 且数组为空。',
    '模型只选择 scoring_response_point_ids，不必抄写 scoring_response_points；Host 从正式清单按选择顺序重建快照并合并所属 scoring_ids。每个 RP 至少由一个合适的可写叶子覆盖，也可由多个章节共同响应。不得修改正式清单或猜测 RP 编号。',
    'writable 节点必须有至少一个具体 must_answer。父评分、子评分和通用质量评分可以同时关联。结构节点 writable=false、must_answer=[] 且必须有子节点。章节标题应按技术语义表达组织、阶段、质量、风险、安全、验收等内容，但不要套固定模板。',
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
    '逐项检查每个技术 Requirement、Scoring、稳定 Response Point 和 Compliance 是否落在合适的可写叶子章节；重点判断评分项实际要求证明的内容，而非只检查 ID 是否出现。根据评分语义判断章节是否聚焦一个可独立编写的技术主题；技术响应索引、偏离表或合规清单不得集中承担正文覆盖。must_answer 必须具体。存在 Framework 时还要检查主要骨架、顺序和关键技术章节是否合理继承，框架过粗处是否按 RP 扩展，是否产生重复主题，framework_refs 与 origin 是否符合实际来源，旧项目污染是否清理。',
    '发现章节过粗、多个明显技术主题混在一节、评分项未真实拆解、must_answer 过泛、结构与可写职责混淆或其他问题时，先修改 outline/outline.json；保留原有严格 JSON 字段和全部引用覆盖。',
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
    JSON.stringify(z.toJSONSchema(z.array(context.associations === undefined
      ? outlineRepairOperationSchema : outlineAssociationRepairOperationSchema))),
  ].join('\n')
}

/**
 * Execute S3 through the live Agent and return its expected Artifacts.
 * @param agent - live Bid Agent used for Blueprint generation and repair.
 * @param workspace - Workspace 级 Bid 项目.
 * @param task - Host-issued outline-generation task and Tool policy.
 * @param options - Host-owned limit for Validator-guided repair turns.
 * @returns the validated Blueprint Artifact descriptor.
 */
export async function executeOutlineGeneration(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  options: OutlineGenerationExecutionOptions = { maxRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS },
): Promise<StageArtifact[]> {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.signal)
  const frameworks = await loadOutlineFrameworkStructures(workspace)
  const path = (artifact: string): string => join(workspace.projectRoot, artifact)
  const read = async (artifact: string): Promise<string | undefined> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    try { return await readFile(path(artifact), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }
  const write = async (artifact: string, value: unknown): Promise<void> => {
    options.signal?.throwIfAborted()
    await assertNoLinkedPath(workspace.root, path(artifact))
    await writeFileAtomic(path(artifact), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  }
  const remove = async (artifact: string): Promise<void> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    await rm(path(artifact), { force: true })
    const fs = agent.ctx.get('fs')
    if (fs !== undefined) agent.ctx.emit('fs/observed', await fs.resolve(path(artifact)), { kind: 'absent' }, { agent })
  }
  await assertNoLinkedPath(workspace.root, path('outline'))
  await mkdir(path('outline'), { recursive: true, mode: 0o700 })
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('S3 需要 tools 服务。')
  if (options.regeneration === undefined && await read('outline/initial-confirmed-outline.json') !== undefined) throw new Error('S3 已有用户确认目录，不能用失败重试覆盖确认结果。')
  await remove(QUALITY_REPORT_ARTIFACT)
  const readInput = async <T>(artifact: string, parse: (value: unknown) => T): Promise<T> => {
    const raw = await read(artifact)
    try { return parse(JSON.parse(raw ?? 'null')) } catch (error) {
      throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_INVALID', artifact, message: '正式输入缺失或损坏：' + (error instanceof Error ? error.message : String(error)) }])
    }
  }
  const scoring = await readInput('analysis/scoring.json', parseTenderScoringArtifact)
  const requirements = await readInput('analysis/requirements.json', parseTenderRequirementsArtifact)
  const compliance = await readInput('analysis/compliance.json', parseTenderComplianceArtifact)
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
  let writablePaths: string[] = []
  const allowed = new Set([...task.allowedTools, QUALITY_REPORT_TOOL])
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard((exec) => {
    if (!allowed.has(exec.name)) return 'S3 仅允许读取输入及写入当前任务指定的候选文件。'
    if (exec.name !== 'write' || exec.arguments === undefined) return undefined
    const args = z.object({ file_path: z.string() }).safeParse(exec.arguments)
    if (!args.success || !writablePaths.some(artifact => relative(path(artifact), resolve(workspace.root, args.data.file_path)) === '')) {
      return '正式响应点、确认目录与其他输入只读；只能写入当前任务指定的候选文件。'
    }
    return undefined
  })
  const run = async (prompt: string, outputs: string[]): Promise<void> => {
    options.signal?.throwIfAborted()
    writablePaths = outputs
    const eventStart = agent.session.events.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await waitForModelStageIdle(agent, options.signal)
    const end = agent.session.events.slice(eventStart).findLast(event => event.type === 'turn/end')
    if (end?.data.reason.kind !== 'completed') {
      const reason = end?.data.reason.kind === 'error' ? end.data.reason.error.message : end?.data.reason.kind ?? '没有完成记录'
      throw new Error('S3 模型任务未正常完成，保留当前候选；本轮不能标记为已复核。原因：' + reason)
    }
    writablePaths = []
  }
  let qualityIssues: OutlineQualityIssue[] | undefined
  const runQualityReview = async (prompt: string): Promise<void> => {
    qualityIssues = undefined
    const dispose = tools.register({
      name: QUALITY_REPORT_TOOL,
      description: '提交当前 Blueprint Quality Review 的非阻断语义建议；Host 生成并持久化正式质量报告。',
      parameters: z.toJSONSchema(qualityReportSubmissionSchema, { target: 'draft-7' }),
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
        qualityIssues = parsed.data.issues
        return Promise.resolve({ submitted: true, issue_count: qualityIssues.length })
      },
    })
    try {
      await run(prompt, [OUTLINE_ARTIFACT])
    } finally {
      dispose()
    }
  }
  let completed = false
  const artifacts: StageArtifact[] = [
    { stage: 'outline_generation', type: 'scoring_response_points', path: RESPONSE_POINT_CATALOG },
    { stage: 'outline_generation', type: 'outline', path: OUTLINE_ARTIFACT },
    { stage: 'outline_generation', type: 'outline_quality_report', path: QUALITY_REPORT_ARTIFACT },
  ]
  try {
    if (catalog === undefined) {
      if (options.regeneration !== undefined) throw new Error('目录重新生成缺少有效的正式响应点清单。')
      if (await read(RESPONSE_POINT_CANDIDATE) === undefined) {
        await run(renderResponsePointAnalysisTask(agent, workspace, task), [RESPONSE_POINT_CANDIDATE])
      }
      await run(renderResponsePointSemanticReviewTask(agent, workspace), [RESPONSE_POINT_CANDIDATE])
      const candidate = parseScoringResponsePointCandidate(JSON.parse((await read(RESPONSE_POINT_CANDIDATE)) ?? 'null'))
      catalog = createScoringResponsePointCatalog(scoring, candidate)
      await write(RESPONSE_POINT_CATALOG, catalog)
    }
    const handoff = '\n正式响应点清单（只读，不得修改、删除或重新分配编号）：' + relative(workspace.root, path(RESPONSE_POINT_CATALOG)).replaceAll('\\', '/')
      + '\n' + JSON.stringify(catalog)
    if (options.regeneration !== undefined || await read(OUTLINE_ARTIFACT) === undefined) {
      await run(renderOutlineGenerationTask(agent, workspace, task, options.regeneration, frameworks) + handoff,
        [OUTLINE_ARTIFACT, ...(options.regeneration === undefined ? [] : [REGENERATION_CHANGE_SET])])
    }
    await remove(QUALITY_REPORT_ARTIFACT)
    let attempts = 0
    let repairFailure: string | undefined
    let reviewBaseline: string | undefined
    const formalCatalog = catalog
    const consumeRepair = (issues: readonly StageValidationIssue[]): void => {
      if (attempts++ >= options.maxRepairAttempts) throw new BidStageExecutionError([
        ...issues, { code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', message: 'S3 局部修复未通过，已保留当前目录候选。' + (repairFailure ?? '') },
      ])
    }
    const validate = async (outline: OutlineArtifact): Promise<StageValidationIssue[]> => {
      const issues: StageValidationIssue[] = []
      validateOutlineSharedStructure(outline.sections, issues)
      validateOutlineSharedCoverage(outline, requirements, scoring, compliance, formalCatalog, issues)
      await validateOutlineFrameworkRefs(workspace, outline, issues)
      return issues
    }
    while (true) {
      options.signal?.throwIfAborted()
      const raw = (await read(OUTLINE_ARTIFACT)) ?? ''
      const candidate = inspectOutlineCandidate(raw, catalog, scoring)
      if (candidate.kind !== 'valid') {
        reviewBaseline = undefined
        qualityIssues = undefined
        if (candidate.kind === 'fields' && candidate.issues.some(issue => issue.field === null || issue.field === 'sections')) {
          throw new BidStageExecutionError([...candidate.issues, { code: 'OUTLINE_CANDIDATE_UNRECOVERABLE', artifact: OUTLINE_ARTIFACT,
            message: '候选缺少可恢复的目录或章节对象；字段修复不能重生成整章或整本目录，已保留原始候选。' }])
        }
        consumeRepair(candidate.issues)
        const output = candidate.kind === 'format' ? 'outline/format-repair.json' : 'outline/candidate-repair.json'
        await remove(output)
        if (candidate.kind === 'format') {
          await assertNoLinkedPath(workspace.root, path('outline/format-repair-source.txt'))
          await writeFileAtomic(path('outline/format-repair-source.txt'), raw, { mode: 0o600 })
        }
        const repairTask = [
          '当前阶段：outline_generation / 候选' + (candidate.kind === 'format' ? ' JSON 格式修复' : '字段修复'),
          '问题位置与原因：' + JSON.stringify(candidate.issues), repairFailure ?? '',
          '原始候选（只读）：\n' + raw,
          candidate.kind === 'format'
            ? '只修复 JSON 序列化标点和空白，保留字符串、数值、字面值及其顺序；禁止调整章节、拆解评分、重分配 RP 或重生成目录。无法在此范围内恢复时说明原因。输出恢复后的 JSON。'
            : '只输出已定位字段的局部操作。section_index 指原始数组下标，section_id 与 path 供核对；禁止整章或整本替换。未知 ID 必须根据原文重新明确选择合法关联，不能删除未知 ID 了事、模糊替换或默认挂到某章。RP 快照由 Host 派生，修复快照错误时只选择 scoring_response_point_ids。删除额外字段用 remove=true。\n' + JSON.stringify(z.toJSONSchema(outlineCandidateRepairSchema)),
          ...(candidate.kind === 'format' ? [] : ['权威输入（只读，不得修改）：' + JSON.stringify({ catalog, scoring, requirements, compliance, frameworks })]),
          '唯一可写输出：' + relative(workspace.root, path(output)).replaceAll('\\', '/'),
        ].join('\n')
        await run(repairTask, [output])
        let repaired: unknown
        try {
          repaired = candidate.kind === 'format'
            ? parseOutlineFormatRepair(raw, (await read(output)) ?? '')
            : applyOutlineCandidateRepair(candidate.value, JSON.parse((await read(output)) ?? 'null'), candidate.issues,
              { catalog, scoring, requirements, compliance, frameworks })
        } catch (error) {
          if (options.signal?.aborted) throw error
          repairFailure = error instanceof Error ? error.message : String(error)
          continue
        }
        repairFailure = undefined
        await write(OUTLINE_ARTIFACT, repaired)
        continue
      }
      const outline = candidate.outline
      await write(OUTLINE_ARTIFACT, outline)
      const issues = await validate(outline)
      if (reviewBaseline !== undefined && reviewBaseline !== JSON.stringify(outline)) {
        reviewBaseline = undefined
        qualityIssues = undefined
        if (issues.length === 0) consumeRepair([{ code: 'OUTLINE_GENERATION_REVIEW_INCOMPLETE', message: '质量复核修改了目录，当前候选尚需完整语义复核。' }])
      }
      if (issues.length > 0 || repairFailure !== undefined) {
        reviewBaseline = undefined
        qualityIssues = undefined
        consumeRepair(issues)
        const operationsPath = 'outline/repair-operations.json'
        await remove(operationsPath)
        const rpOnly = issues.length > 0 && issues.every(issue => issue.code.includes('RESPONSE_POINT'))
        const repairTask = renderOutlineGenerationRepairTask(agent, workspace, task, issues,
          { outline, catalog, scoring, failure: repairFailure,
            ...(rpOnly ? {} : { associations: { requirements, compliance, frameworks } }) })
        try {
          await run(repairTask, [operationsPath])
        } catch (error) {
          if (options.signal?.aborted) throw error
          throw new BidStageExecutionError([...issues, { code: 'OUTLINE_GENERATION_REPAIR_FAILED', message: error instanceof Error ? error.message : String(error) }])
        }
        let repaired: OutlineArtifact
        const operationSchema = rpOnly ? outlineRepairOperationSchema : outlineAssociationRepairOperationSchema
        try {
          repaired = applyOutlineRepair(outline, z.array(operationSchema).parse(JSON.parse((await read(operationsPath)) ?? 'null')), catalog, scoring)
        } catch (error) {
          repairFailure = error instanceof Error ? error.message : String(error)
          continue
        }
        const repairedIssues = await validate(repaired)
        const remaining = [...issues]
        const invalid = repairedIssues.filter((issue) => {
          if (issue.code.endsWith('_MISSING')) return false
          const index = remaining.findIndex(previous => previous.code === issue.code
            && previous.path === issue.path && previous.message === issue.message)
          if (index < 0) return true
          remaining.splice(index, 1)
          return false
        })
        if (invalid.length > 0) {
          repairFailure = '局部操作引入非法引用或结构，未保存：' + JSON.stringify(invalid)
          continue
        }
        repairFailure = undefined
        await remove(QUALITY_REPORT_ARTIFACT)
        await write(OUTLINE_ARTIFACT, repaired)
        continue
      }
      if (reviewBaseline === undefined) {
        reviewBaseline = JSON.stringify(outline)
        await remove(QUALITY_REPORT_ARTIFACT)
        await runQualityReview(renderBlueprintQualityReviewTask(agent, workspace, task) + handoff + '\n本轮完整复核目录：' + reviewBaseline
          + '\n本轮完整复核的招标要求、评分及合规：' + JSON.stringify({ requirements, scoring, compliance }))
        continue
      }
      if (qualityIssues === undefined) {
        consumeRepair([{
          code: 'OUTLINE_GENERATION_QUALITY_SUBMISSION_REQUIRED',
          message: `必须调用 ${QUALITY_REPORT_TOOL} 提交当前目录的质量复核结果。`,
        }])
        await runQualityReview([
          '当前阶段：outline_generation / Blueprint Quality Review Submission',
          `Bid Session：${agent.id}`,
          `当前目录未收到 ${QUALITY_REPORT_TOOL} 提交。保持目录不变并调用该工具；如发现阻断问题，先修改目录，Host 将要求重新完整复核。`,
        ].join('\n'))
        continue
      }
      const reviewed = outline
      await write(QUALITY_REPORT_ARTIFACT, {
        schema_version: OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
        scope: 'technical_bid',
        issues: qualityIssues,
        checked_requirement_ids: requirements.requirements.map(item => item.id),
        checked_scoring_ids: scoring.scoring_items.map(item => item.id),
        checked_scoring_response_point_ids: catalog.points.map(point => point.id),
        reviewed_section_ids: reviewed.sections.map(section => section.id),
      })
      const validation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
      if (!validation.ok) throw new BidStageExecutionError(validation.issues)
      if (options.regeneration !== undefined) {
        const draft = parseOutlineDraft(JSON.parse((await read('outline/draft.json')) ?? 'null'))
        const changeSet = parseOutlineRegenerationChangeSet(JSON.parse((await read(REGENERATION_CHANGE_SET)) ?? 'null'))
        await write(REGENERATION_CHANGE_SET, { ...changeSet, changes: outlineRegenerationChanges(draft.outline, reviewed).map(change => ({
          ...change, reason: changeSet.changes.find(item => item.section_id === change.section_id && item.type === change.type)?.reason ?? '响应点覆盖修复及目录质量复核',
        })) })
      }
      await waitForModelStageIdle(agent, options.signal)
      completed = true
      return artifacts
    }
  } finally {
    liftGuard()
    liftRestriction()
    if (!completed) await remove(QUALITY_REPORT_ARTIFACT)
  }
}
