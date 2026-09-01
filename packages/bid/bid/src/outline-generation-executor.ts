import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import type { BidStageTask, StageArtifact, StageValidationIssue } from './control-plane-contract.ts'
import {
  DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
  type ModelStageExecutionOptions,
  renderStageRepairIssues,
} from './model-stage-repair.ts'
import {
  OUTLINE_GENERATION_SCHEMA_VERSION,
  OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
} from './outline-generation-artifacts.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const OUTLINE_ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT_ARTIFACT = 'outline/quality-report.json'

/** Render the dynamic S4 assignment for the live Bid Agent. */
export function renderOutlineGenerationTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${root}`,
    '先读取以下结构化 Artifact：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    `本阶段只允许调用：${task.allowedTools.join(', ')}。不得 Web Search、bash 或重新进行全库资料映射。`,
    '根据 Project、Requirements、Scoring、Compliance 和 Evidence Map 设计技术标详细写作 Blueprint。Requirement 保证完整响应，Scoring 决定重点，Compliance 不能遗漏；缺少资料绝不能省略目录。必要时可 read 已有 source_ref 或 material chunk，但不得 grep 搜索资料。',
    `本轮初稿唯一输出：${root}/${OUTLINE_ARTIFACT}。Host 随后会强制发送一次 Blueprint Quality Review。`,
    `文件严格包含 schema_version=${OUTLINE_GENERATION_SCHEMA_VERSION}、scope="technical_bid"、document_title、global_compliance_ids、sections。不得写 content、body、markdown 或任何正文。`,
    'sections 是 parent_id + order 的扁平树。每个节点严格包含 id、parent_id、order、level、title、purpose、writable、must_answer、requirement_ids、scoring_ids、compliance_ids、suggested_tables、suggested_figures、writing_notes。',
    'writable 节点必须是一个可独立写作的聚焦技术主题，并有至少一个具体 must_answer；结构节点 writable=false、must_answer=[] 且必须有子节点。不要把粗粒度评分标题直接作为唯一可写章节：按技术语义细化组织、阶段、质量、风险、安全、验收等主题，但不要套固定模板。',
    '每个 Requirement、Scoring 和 Compliance ID 都必须至少覆盖一次；mandatory Requirement，以及 must_answer=true、带 score 或 score_range 的 Scoring，必须关联至少一个 writable 节点。一个 ID 可出现在多个章节，但同一数组不得重复。Compliance 可以放在 global_compliance_ids 或具体章节。',
    'Evidence Map 的 research_topics 是 S3 通过本地资料和外部研究得到的结构设计输入：findings 是已获得的研究结论，writing_dimensions 是可纳入后续技术标的维度。结合项目和 S2 记录自主决定如何将多个 Topic 合并、一个 Topic 拆成多个叶子章节、只用于项目理解，或转化为章节标题、层级、must_answer、建议表格、图示和 writing_notes；不得机械地一个 Topic 对应一个章节。reuse/adapt/reference/background 与 missing_topics 也可形成简短 writing_notes、建议表格或图示；不得复制 material 引用或撰写技术正文。',
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
    '重新读取 Requirements、Scoring、Compliance、Evidence Map 和当前 outline.json：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    `- ${root}/${OUTLINE_ARTIFACT}`,
    `本阶段只允许调用：${task.allowedTools.join(', ')}。不得 Web Search、bash 或重新进行全库资料映射。`,
    '逐项检查每个技术 Requirement、Scoring 和 Compliance 是否落在合适的可写叶子章节；重点判断评分项实际要求证明的内容，而非只检查 ID 是否出现。检查每个章节是否聚焦单一技术主题，评分要求是否已按招标语义拆解，must_answer 是否具体且不机械复述标题。Evidence 的本地资料、外部资料和缺失主题只影响写作备注，不得成为删除要求或评分章节的理由。',
    '发现章节过粗、多个明显技术主题混在一节、评分项未真实拆解、must_answer 过泛、结构与可写职责混淆或其他问题时，先修改 outline/outline.json；保留原有严格 JSON 字段和全部引用覆盖。',
    `修正后写入 ${root}/${QUALITY_REPORT_ARTIFACT}。文件严格包含 schema_version=${OUTLINE_QUALITY_REPORT_SCHEMA_VERSION}、scope="technical_bid"、checked_requirement_ids、checked_scoring_ids、reviewed_section_ids、issues。前三个数组分别列出本次检查的全部现有 Requirement ID、Scoring ID 和最终 outline section ID，且不得编造 ID 或重复。只在所有发现的问题已修正后写 issues=[]。`,
    '完成复核和质量报告后停止；Host 会独立校验报告、树结构和引用覆盖。',
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
    '修正目录树、ID 覆盖和质量报告后，将 reviewed_section_ids 更新为最终全部 section ID，并仅在所有问题已解决时写 issues=[]。',
    `修复时只允许调用：${task.allowedTools.join(', ')}。写完原文件后停止；Host 将重新校验。`,
  ].join('\n')
}

/**
 * Execute S4 through the live Agent and return its expected Artifact.
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
  options: ModelStageExecutionOptions = { maxRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS },
): Promise<StageArtifact[]> {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  await agent.whenIdle()
  const outlineRoot = join(workspace.sessionRoot, 'outline')
  const artifactPaths = [OUTLINE_ARTIFACT, QUALITY_REPORT_ARTIFACT]
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
  const artifacts: StageArtifact[] = [{ stage: 'outline_generation', type: 'outline', path: OUTLINE_ARTIFACT }]
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderOutlineGenerationTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderBlueprintQualityReviewTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await agent.whenIdle()
    let prevalidation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
    for (let attempt = 1; !prevalidation.ok && attempt <= options.maxRepairAttempts; attempt++) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderOutlineGenerationRepairTask(agent, workspace, task, prevalidation.issues) }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      }))
      await agent.whenIdle()
      prevalidation = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
    }
  } finally {
    liftGuard()
    liftRestriction()
  }
  return artifacts
}
