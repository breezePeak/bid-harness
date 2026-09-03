import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { applyOutlineEdits, outlineEditOperationSchema, parseOutlineEditOperations, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import type { OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { outlineRegenerationChanges } from './outline-regeneration-artifacts.ts'
import type { BidWorkspace } from './index.ts'
import type { BidStageTask, StageArtifact, StageValidationIssue } from './control-plane-contract.ts'
import {
  DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
  type ModelStageExecutionOptions,
  renderStageRepairIssues,
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import {
  OUTLINE_GENERATION_SCHEMA_VERSION,
  OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
} from './outline-generation-artifacts.ts'
import { loadOutlineFrameworkStructures, type OutlineFrameworkStructure } from './outline-framework.ts'
import {
  createScoringResponsePointCatalog,
  parseScoringResponsePointCandidate,
} from './scoring-response-point-artifacts.ts'
import { parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const OUTLINE_ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT_ARTIFACT = 'outline/quality-report.json'
const RESPONSE_POINT_CANDIDATE = 'analysis/scoring-response-points.candidate.json'
const RESPONSE_POINT_CATALOG = 'analysis/scoring-response-points.json'
const REGENERATION_CHANGE_SET = 'outline/regeneration/change-set.json'

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
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
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
 * @param workspace - Session-scoped Bid workspace.
 * @returns model-visible semantic review instructions.
 */
export function renderResponsePointSemanticReviewTask(agent: Agent, workspace: BidWorkspace): string {
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
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
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const feedback = regeneration?.feedback ?? latestOutlineFeedback(agent)
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${root}`,
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
    'sections 是 parent_id + order 的扁平树。每个节点严格包含 id、parent_id、order、level、title、purpose、writable、must_answer、requirement_ids、scoring_ids、compliance_ids、origin、framework_refs、scoring_response_point_ids、scoring_response_points、suggested_tables、suggested_figures、writing_notes。origin 只说明目录结构来源，取 framework/generated/mixed，不是 Evidence ID。framework_refs 使用 [{"file_id":"...","heading_path":["..."]}] 追溯原框架标题：直接继承为 framework，调整或在框架下扩展为 mixed，Tender 全新增为 generated 且数组为空。',
    '每个稳定 Response Point ID 与文本快照必须在同一 Section 中按相同顺序配对：scoring_response_point_ids 写 ["RP-000001"]，对应 scoring_response_points 写 [{"scoring_id":"SCORE-...","response_point":"该评分响应点原文"}]，绝不能写 {"id":"RP-...","text":"..."}。每个 RP 至少由一个可写叶子覆盖，也可由多个可写叶子共同支撑。',
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
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage} / Blueprint Quality Review`,
    `Bid Session：${agent.id}`,
    '这是强制复核；即使初稿看起来完整，也必须完成后才可停止。',
    '重新读取 Requirements、Scoring、Compliance、评分响应点目录和当前 outline.json：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    `- ${root}/${OUTLINE_ARTIFACT}`,
    `本阶段只允许调用：${task.allowedTools.join(', ')}。不得 Web Search、bash 或重新进行全库资料映射。`,
    '逐项检查每个技术 Requirement、Scoring、稳定 Response Point 和 Compliance 是否落在合适的可写叶子章节；重点判断评分项实际要求证明的内容，而非只检查 ID 是否出现。根据评分语义判断章节是否聚焦一个可独立编写的技术主题；技术响应索引、偏离表或合规清单不得集中承担正文覆盖。must_answer 必须具体。存在 Framework 时还要检查主要骨架、顺序和关键技术章节是否合理继承，框架过粗处是否按 RP 扩展，是否产生重复主题，framework_refs 与 origin 是否符合实际来源，旧项目污染是否清理。',
    '发现章节过粗、多个明显技术主题混在一节、评分项未真实拆解、must_answer 过泛、结构与可写职责混淆或其他问题时，先修改 outline/outline.json；保留原有严格 JSON 字段和全部引用覆盖。',
    `修正后写入 ${root}/${QUALITY_REPORT_ARTIFACT}。文件严格包含 schema_version=${OUTLINE_QUALITY_REPORT_SCHEMA_VERSION}、scope="technical_bid"、checked_requirement_ids、checked_scoring_ids、checked_scoring_response_point_ids、reviewed_section_ids、issues。前三个 checked 数组分别列出全部现有 Requirement ID、Scoring ID 和稳定 Response Point ID。`,
    'issues 可以记录仍需用户判断的非阻断语义建议；Host 不要求它为空。完成复核和质量报告后停止；Host 会独立校验报告集合、树结构和引用覆盖。',
  ].join('\n')
}

/**
 * Render one Validator-guided S4 repair assignment.
 * @param agent - live Bid Agent receiving the repair assignment.
 * @param workspace - Session-scoped Bid workspace.
 * @param task - Host-issued outline-generation task and Tool policy.
 * @param issues - latest browser-safe S4 validation issues.
 * @returns model-visible instructions for the original Blueprint files.
 */
export function renderOutlineGenerationRepairTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  issues: readonly StageValidationIssue[],
  regeneration?: OutlineGenerationExecutionOptions['regeneration'],
): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage} / Artifact Repair`,
    `Bid Session：${agent.id}`,
    'Host 预校验未通过。依据以下问题修改原文件，不得创建替代文件：',
    `- ${root}/${OUTLINE_ARTIFACT}`,
    `- ${root}/${QUALITY_REPORT_ARTIFACT}`,
    ...renderStageRepairIssues(issues),
    `outline.json 的 schema_version 必须为 ${OUTLINE_GENERATION_SCHEMA_VERSION}；quality-report.json 的 schema_version 必须为 ${OUTLINE_QUALITY_REPORT_SCHEMA_VERSION}。保留两个文件各自的严格字段集合。`,
    ...(regeneration === undefined ? [] : [
      `这是基于 outline/draft.json revision=${String(regeneration.revision)}、draft hash=${regeneration.draftSha256} 的重新生成修复；保留未被反馈涉及的草稿内容。`,
      `修复候选后同步更新 ${root}/${REGENERATION_CHANGE_SET}，使其逐项准确声明相对该基线的全部实际变更。`,
    ]),
    '修正目录树、ID 覆盖、评分响应点和质量报告后，将 reviewed_section_ids 更新为最终全部 section ID。索引或附录不能替代实质性正文叶子的映射；主观建议可以保留在 issues。',
    `修复时只允许调用：${task.allowedTools.join(', ')}。写完原文件后停止；Host 将重新校验。`,
  ].join('\n')
}

/**
 * Execute S3 through the live Agent and return its expected Artifacts.
 * @param agent - live Bid Agent used for Blueprint generation and repair.
 * @param workspace - Session-scoped Bid workspace.
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
  const outlineRoot = join(workspace.sessionRoot, 'outline')
  const artifactPaths = [OUTLINE_ARTIFACT, QUALITY_REPORT_ARTIFACT, RESPONSE_POINT_CANDIDATE]
  if (options.regeneration !== undefined) artifactPaths.push(REGENERATION_CHANGE_SET)
  await assertNoLinkedPath(workspace.root, outlineRoot)
  await mkdir(outlineRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid outline generation requires fs and tools services')
  await Promise.all(artifactPaths.map(async (artifact) => {
    const artifactPath = join(workspace.sessionRoot, artifact)
    await rm(artifactPath, { force: true })
    const target = await fs.resolve(artifactPath)
    agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  }))
  const allowed = new Set(task.allowedTools)
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard(exec => allowed.has(exec.name) ? undefined : `Bid stage ${task.stage} allows only ${task.allowedTools.join(', ')}`)
  const artifacts: StageArtifact[] = [
    { stage: 'outline_generation', type: 'scoring_response_points', path: RESPONSE_POINT_CATALOG },
    { stage: 'outline_generation', type: 'outline', path: OUTLINE_ARTIFACT },
    { stage: 'outline_generation', type: 'outline_quality_report', path: QUALITY_REPORT_ARTIFACT },
  ]
  try {
    if (options.regeneration === undefined) {
      options.signal?.throwIfAborted()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: renderResponsePointAnalysisTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
      await waitForModelStageIdle(agent, options.signal)
      options.signal?.throwIfAborted()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: renderResponsePointSemanticReviewTask(agent, workspace) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
      await waitForModelStageIdle(agent, options.signal)
      const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8')))
      const candidate = parseScoringResponsePointCandidate(JSON.parse(await readFile(join(workspace.sessionRoot, RESPONSE_POINT_CANDIDATE), 'utf8')))
      await writeFileAtomic(join(workspace.sessionRoot, RESPONSE_POINT_CATALOG), `${JSON.stringify(createScoringResponsePointCatalog(scoring, candidate), null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    }
    options.signal?.throwIfAborted()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderOutlineGenerationTask(agent, workspace, task, options.regeneration, frameworks) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await waitForModelStageIdle(agent, options.signal)
    options.signal?.throwIfAborted()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderBlueprintQualityReviewTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await waitForModelStageIdle(agent, options.signal)
    let prevalidation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
    for (let attempt = 1; !prevalidation.ok && attempt <= options.maxRepairAttempts; attempt++) {
      options.signal?.throwIfAborted()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderOutlineGenerationRepairTask(agent, workspace, task, prevalidation.issues, options.regeneration) }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      }))
      await waitForModelStageIdle(agent, options.signal)
      prevalidation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
    }
  } finally {
    liftGuard()
    liftRestriction()
  }
  return artifacts
}
