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
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  'analysis/project.json': 'tender_project',
  'analysis/requirements.json': 'tender_requirements',
  'analysis/scoring.json': 'tender_scoring',
  'analysis/compliance.json': 'tender_compliance',
}

const RAW_TEXT_SOURCE_RULES = [
  'requirements.json、scoring.json、compliance.json 中每一项 raw_text 都必须以 source_refs 指向的招标原文为依据；允许提取、压缩、去冗余和原子化，不要求逐字复制。',
  'raw_text 不得改变原文的关键数字、单位以及“应、须、必须、不得”等强制语义，不得新增原文没有的要求。归纳或解释分别写入 normalized_requirement、normalized_rule 或 criterion；评分响应点留给 S3 分析。',
  'source_refs 必须真实、合法且可追溯：写 Artifact 前重新 read 对应 chunk，逐项确认原文能够支持 raw_text，并核对 file_id、chunk 归属、文件解析状态以及 line_start、line_end。',
  '内容跨 chunk 或被截断时，必须读取相邻 chunk 后再决定如何提取和原子化；不得凭上下文记忆补充要求。',
] as const

/**
 * Render the complete dynamic S2 assignment injected into the Bid Agent.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Session-scoped Bid workspace.
 * @param task Orchestrator task for the tender-analysis stage.
 * @returns Dynamic assignment text for the Agent follow-up.
 */
export function renderTenderAnalysisTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const manifestPath = `${workspacePath}/manifest.json`
  const artifactPaths = task.requiredArtifacts.map(path => `${workspacePath}/${path}`)
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${workspacePath}`,
    `首先读取：${manifestPath}`,
    '只把 manifest 中 role=tender 且 parseStatus=success 的文件作为本阶段权威来源；reference 资料不得产生招标要求、评分项或合规规则。',
    `本阶段只允许调用：${task.allowedTools.join(', ')}。`,
    '当前只分析技术标。正式 Artifact 只保留会影响技术方案编写、技术评分响应或技术实施约束的内容：项目背景、建设目标和范围；技术、功能、性能、接口、参数和架构要求；实施、进度、质量、测试、验收、培训、运维和技术服务要求；数据、网络和信息安全；技术评分项；以及影响技术方案的强制要求或否决条件。',
    '不得把投标报价、价格评分、报价计算、付款、保证金、财务、纳税、营业执照、法定代表人、授权委托、资格审查、注册资本、纯商务信誉、纯商务评分或纯商务合同条款写入 requirements.json、scoring.json 或 compliance.json。人员、案例、服务和承诺是否保留，按其是否用于技术方案或技术评分响应判断，不得按关键词机械过滤。',
    '使用 grep 定位候选 chunk，再用 read 阅读原文；语义被截断时读取 chunks/index.json 后继续读相邻 chunk。不得一次读取完整 document.md。',
    '完成前写入以下四个 UTF-8 JSON 文件：',
    ...artifactPaths.map(path => `- ${path}`),
    '四个文件共同使用 schema_version=1。source_refs 必须是非空数组，元素严格包含 file_id、chunk、line_start、line_end；chunk 使用 Session Workspace 相对路径并且必须属于该 tender 文件。',
    'project.json 严格包含 schema_version, project_name, tender_name, purchaser, owner, project_background, project_objectives, project_scope, technical_scope, delivery_scope, implementation_constraints, key_technical_points, source_refs, analyzed_tender_files。project_background 说明建设背景，project_objectives 说明建设目标，implementation_constraints 只记录影响技术方案的实施约束，key_technical_points 根据本项目招标文件概括技术标必须重点说明的内容。未知单值写 null，未知数组写 []，不得补全或套用通用模板；analyzed_tender_files 列出全部成功解析 tender 文件的 manifest id。',
    'requirements.json 严格包含 schema_version, requirements；每项严格包含 id, category, raw_text, normalized_requirement, mandatory, source_refs，并按可独立响应的语义原子化。',
    'scoring.json 严格包含 schema_version, scoring_items；只收录技术评分及其技术子项，排除资格、商务和价格评分。每项严格包含 id, parent, group, title, raw_text, criterion, score, score_range, must_answer, source_refs。raw_text 忠实保留完整评分原文，criterion 只做评分规则规范化；不得拆解评分响应点。score_range 为 null 或 {min,max}。',
    'compliance.json 严格包含 schema_version, compliance_items；每项严格包含 id, type, raw_text, normalized_rule, severity, source_refs；severity 只能是 fatal、mandatory、warning。',
    ...RAW_TEXT_SOURCE_RULES,
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '写完四个文件后停止。回复文字不会完成阶段；Host 会在 Agent idle 后独立校验文件与引用。',
  ].join('\n')
}

function renderTenderAnalysisCoverageAuditTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const manifestPath = `${workspacePath}/manifest.json`
  const artifactPaths = task.requiredArtifacts.map(path => `${workspacePath}/${path}`)
  return [
    `当前阶段：${task.stage} / Coverage Audit`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${workspacePath}`,
    '首次提取已经结束。执行一次完整性自审，只检查 manifest 中 role=tender 且 parseStatus=success 的文件；reference 资料不得用于补全或证明招标要求。',
    `重新读取：${manifestPath}`,
    '重新读取并在需要时修正以下四个 Artifact：',
    ...artifactPaths.map(path => `- ${path}`),
    `本阶段仍只允许调用：${task.allowedTools.join(', ')}。`,
    '使用 grep 定位候选 chunk，再用 read 阅读原文；根据招标文件的章节、术语和表格内容动态形成搜索词，不得把固定关键词当作正式 Requirement、Scoring 或 Compliance。',
    '重点重查技术要求、技术参数、功能要求、性能要求、接口要求、实施要求、安全要求、测试、验收、培训、运维、售后技术服务、技术评分、技术评审、技术评价、评分标准、评分表、技术否决项和必须响应项。',
    '检查每一类内容是否已在 requirements.json、scoring.json 或 compliance.json 中以可追溯的原文和 source_refs 表达。发现遗漏时直接修正现有四个文件；不得创建其他 Artifact。',
    '继续只保留技术标内容。投标报价、价格评分、付款、财务、资格、保证金和纯商务材料不得写入分析 Artifact。',
    '逐项检查 scoring_items：必须只包含技术评分，raw_text 保留完整评分原文，criterion 只规范评分规则，不得拆解评分响应点。',
    ...RAW_TEXT_SOURCE_RULES,
    '逐项遍历 requirements、scoring_items 和 compliance_items；根据每项 source_refs 重新 read 原文，确认引用真实合法、范围包含支持该项的原文，并检查提取后的 raw_text 未改变关键数字、单位、强制语义或新增要求。',
    '审计结束后停止。Host 会独立验证最终 Artifact、引用和异常空结果。',
  ].join('\n')
}

/**
 * Render the sole S2 repair assignment from Host-produced validation issues.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Session-scoped Bid workspace.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param issues Browser-safe issues produced by the S2 Validator.
 * @returns Dynamic repair assignment for one Agent follow-up.
 */
export function renderTenderAnalysisRepairTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  issues: readonly StageValidationIssue[],
): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const artifactPaths = task.requiredArtifacts.map(path => `${workspacePath}/${path}`)
  return [
    `当前阶段：${task.stage} / Artifact Repair`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${workspacePath}`,
    '预校验未通过。依据下列 Host Validator 问题修改原正式 Artifact：',
    ...issues.map(issue => [
      `- code: ${issue.code}`,
      `  artifact: ${issue.artifact ?? '未指定'}`,
      `  path: ${issue.path ?? '未指定'}`,
      `  message: ${issue.message}`,
    ].join('\n')),
    '四个正式 Artifact 路径：',
    ...artifactPaths.map(path => `- ${path}`),
    `修复时只允许调用：${task.allowedTools.join(', ')}。`,
    '只能修改上述四个 S2 Artifact，必须调用 write 覆盖原正式路径；不得创建 final、fixed、new 或 v2 文件，不得推进下一阶段。',
    'project.json 严格包含 schema_version, project_name, tender_name, purchaser, owner, project_background, project_objectives, project_scope, technical_scope, delivery_scope, implementation_constraints, key_technical_points, source_refs, analyzed_tender_files；未知单值写 null，未知数组写 []。',
    'requirements.json 每项严格包含 id, category, raw_text, normalized_requirement, mandatory, source_refs。',
    'scoring.json 每项严格包含 id, parent, group, title, raw_text, criterion, score, score_range, must_answer, source_refs；parent 和 group 必须存在且可为 null，score 为 number 或 null，score_range 为 {min,max} 或 null。',
    'compliance.json 每项严格包含 id, type, raw_text, normalized_rule, severity, source_refs；severity 只能是 fatal、mandatory 或 warning。',
    'source_refs 必须是非空数组，元素严格包含 file_id, chunk, line_start, line_end。需要核对原文或行号时，可以重新 read 对应 chunk。',
    ...RAW_TEXT_SOURCE_RULES,
    '修复引用问题时必须重新 read 对应原始 chunk，根据真实来源修正 file_id、chunk、line_start 或 line_end；不得伪造引用。raw_text 可以在原文含义内提取、压缩、去冗余和原子化，但不得改变关键数字、单位、强制语义或新增要求。',
    '必须实际写入修复结果；只回复“已修复”不会改变 Artifact。完成后停止，Host 将执行最终校验。',
  ].join('\n')
}

/**
 * Execute S2 through the live Harness Agent and return expected Artifact references after quiescence.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Session-scoped Bid workspace.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param options Host-owned repair-turn limit for this execution.
 * @returns Expected Artifact references for Validator inspection.
 */
export async function executeTenderAnalysis(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  options: ModelStageExecutionOptions = { maxRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS },
): Promise<StageArtifact[]> {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.signal)
  const analysisRoot = join(workspace.sessionRoot, 'analysis')
  await assertNoLinkedPath(workspace.root, analysisRoot)
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid tender analysis requires fs and tools services')
  await Promise.all(task.requiredArtifacts.map(async (path) => {
    const artifactPath = join(workspace.sessionRoot, path)
    await rm(artifactPath, { force: true })
    const target = await fs.resolve(artifactPath)
    agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  }))
  const allowed = new Set(task.allowedTools)
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard(exec => allowed.has(exec.name)
    ? undefined
    : `Bid stage ${task.stage} allows only ${task.allowedTools.join(', ')}`)
  try {
    options.signal?.throwIfAborted()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: renderTenderAnalysisTask(agent, workspace, task) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }))
    await waitForModelStageIdle(agent, options.signal)
    options.signal?.throwIfAborted()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: renderTenderAnalysisCoverageAuditTask(agent, workspace, task) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }))
    await waitForModelStageIdle(agent, options.signal)
    const artifacts = task.requiredArtifacts.map(path => ({
      stage: 'tender_analysis' as const,
      type: ARTIFACT_TYPES[path] ?? 'tender_analysis',
      path,
    }))
    let prevalidation = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
    for (let attempt = 1; !prevalidation.ok && attempt <= options.maxRepairAttempts; attempt++) {
      options.signal?.throwIfAborted()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderTenderAnalysisRepairTask(agent, workspace, task, prevalidation.issues) }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      }))
      await waitForModelStageIdle(agent, options.signal)
      prevalidation = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
    }
    return artifacts
  } finally {
    liftGuard()
    liftRestriction()
  }
}
