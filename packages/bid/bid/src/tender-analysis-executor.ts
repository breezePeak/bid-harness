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
import {
  attachTenderAnalysisSubmissionRuntime,
  TENDER_ANALYSIS_SUBMISSION_TOOLS,
  type TenderLocator,
} from './tender-analysis-submission.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  'analysis/project.json': 'tender_project',
  'analysis/requirements.json': 'tender_requirements',
  'analysis/scoring.json': 'tender_scoring',
  'analysis/compliance.json': 'tender_compliance',
}

const TECHNICAL_SCORING_ANCHORS = '技术评分、技术评审、技术评价、评分标准、评分表、评审因素、分值、满分'

function renderLocators(locators: readonly TenderLocator[]): string[] {
  return locators.flatMap(locator => [
    `${locator.file_ref}:`,
    `  name: ${locator.name}`,
    `  chunks_path: ${locator.chunks_path}`,
    `  chunk_index_path: ${locator.chunk_index_path}`,
  ])
}

/**
 * Render the complete dynamic S2 assignment injected into the Bid Agent.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Workspace 级 Bid 项目.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param locators Host-issued short references for successful tender files.
 * @returns Dynamic assignment text for the Agent follow-up.
 */
export function renderTenderAnalysisTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  locators: readonly TenderLocator[] = [],
): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Project Workspace：${workspacePath}`,
    `首先读取：${workspacePath}/manifest.json，并确认下列全部成功 tender locator：`,
    ...renderLocators(locators),
    '只把 locator 对应的 role=tender 且 parseStatus=success 文件作为权威来源；reference、reference_bid 和 outline_framework 不得产生招标要求、评分项或合规规则。',
    `本阶段可用普通工具仅为：${task.allowedTools.join(', ')}。另有 S2 私有工具：${TENDER_ANALYSIS_SUBMISSION_TOOLS.join(', ')}。不得调用 write、bash、web_search、web_fetch 或 subagent。`,
    '当前只分析技术标。保留项目背景、建设目标和范围；技术、功能、性能、接口、参数和架构要求；实施、进度、质量、测试、验收、培训、运维和技术服务要求；数据、网络和信息安全；技术评分项；以及影响技术方案的强制要求或否决条件。',
    '排除投标报价、价格评分、报价计算、付款、保证金、财务、纳税、营业执照、法定代表人、授权委托、资格审查、注册资本、纯商务信誉、纯商务评分和纯商务合同条款。人员、案例、服务和承诺按是否直接影响技术方案编写或技术评分响应判断，不得按关键词机械过滤。',
    '使用 grep 定位候选 chunk，再用 read 阅读原文；语义被截断时读取 chunks/index.json 后继续读相邻 chunk。不得一次读取完整 document.md。',
    '提取技术评分时，先用 grep 搜索评分区域锚点：' + TECHNICAL_SCORING_ANCHORS + '。命中后 read 对应 chunk 和 chunks/index.json，利用 prev_chunk、next_chunk 和 heading_path 连续阅读评分区域；只在边界截断时扩展，进入商务、价格、资格或无关区域时停止。完成该区域后只再 grep 一次检查远距离第二评分区域，发现新区域才继续读取。不得为每个评分项全局 grep。',
    '项目事实或摘要逐项调用 submit_project_fact；数组字段每次只提交一个语义项。未知单值不必提交，Host 自动填 null；未知数组由 Host 自动填 []。所有项目内容必须至少有一个真实 tender source，不得补通用模板。',
    '每个可独立响应的原子技术要求调用 submit_requirement。只有在招标评分体系中作为独立评审对象出现，并具有独立名称及总分、权重或独立区块边界的评分大项，才调用 submit_scoring_item；在 raw_text 和 criterion 中保留该大项的完整评分细则。大项内部的评价内容、得分条件、子要求、分档规则或分项得分说明不得另建评分项或填写 parent_ref；重复看到同一评分区块时使用 replace_ref。每个影响技术方案的强制或合规规则调用 submit_compliance_item。',
    '引用只提交 sources=[{file_ref,chunk,quote}]；file_ref 使用 T1、T2 等 locator，chunk 使用 chunk_0001 等 index id，quote 必须是该 chunk 正文中唯一出现的真实原文。跨 chunk 内容提交多个 source。不得填写 file_id、source_refs、line_start 或 line_end。',
    '不得填写 schema_version、analyzed_tender_files、最终 Artifact 路径或正式 REQ/SC/COM ID。raw_text 可以基于一个或多个 quote 忠实提取、压缩、去冗余和原子化，但不得改变数字、单位、“应、须、必须、不得”等强制语义或增加原文没有的要求。',
    '工具返回 INVALID_ARGS 或引用错误时只修正当前条目。已记录条目需要修改时，用其 runtime ref 作为 replace_ref；覆盖不会改变正式 ID。',
    '所有区域分析完成后调用 finish_tender_analysis({})。确定性校验通过后，Host 会在当前轮结束后强制发起一次全量语义复核；初次 finish 不会写入正式 Artifact。普通文字回复不会完成 S2。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
  ].join('\n')
}

/**
 * Render the mandatory same-Agent review over the complete current S2 staged revision.
 * @param agent Live Agent that owns the staged runtime.
 * @param workspace Workspace containing the tender corpus.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param snapshot Host-rendered staged records and their current revision.
 * @param locators Host-issued short references for successful tender files.
 * @returns Dynamic full-review assignment for the Agent follow-up.
 */
export function renderTenderAnalysisQualityReviewTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  snapshot: unknown,
  locators: readonly TenderLocator[],
): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    '当前阶段：tender_analysis / Tender Analysis Quality Review',
    `Bid Session：${agent.id}`,
    `Project Workspace：${workspacePath}`,
    '这是独立的强制复核轮次。重新读取每项 staged 记录对应的 tender chunk，逐项检查 Project、Requirement、Scoring 和 Compliance 的语义、记录边界及来源归属。特别检查相邻表格行之间是否发生 title、raw_text、criterion、分值或来源串配。',
    '发现问题时使用对应 runtime ref 和 replace_ref 原地修正；不得按标题、分值、关键词或行位置推测并批量改写。没有问题时保持 staged 内容不变。',
    'Tender locators：',
    ...renderLocators(locators),
    `当前 staged snapshot：${JSON.stringify(snapshot)}`,
    '完成全部复核后调用 finish_tender_analysis，并将 review_revision 设置为当前最新 revision。任一提交工具返回的新 revision 都会使旧版本失效。只有 finish 返回 completed=true 才能停止。',
  ].join('\n')
}

/**
 * Render a bounded continuation for an S2 turn that stopped before successful finish.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Workspace 级 Bid 项目.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param issues Recoverable issues last returned by finish, or a missing-finish issue.
 * @returns Dynamic continuation that preserves the current staged submissions.
 */
export function renderTenderAnalysisRepairTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  issues: readonly StageValidationIssue[],
): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  return [
    `当前阶段：${task.stage} / Staged Submission Repair`,
    `Bid Session：${agent.id}`,
    `Project Workspace：${workspacePath}`,
    'S2 尚未完成；当前 staged 记录仍然保留。只处理以下问题：',
    ...issues.map(issue => `- ${issue.code} | ${issue.path ?? '未指定字段'} | ${issue.message}`),
    `普通工具仍只允许：${task.allowedTools.join(', ')}；使用 ${TENDER_ANALYSIS_SUBMISSION_TOOLS.join(', ')} 补充、replace 或再次 finish。`,
    '不得 write analysis/*.json、重新提交整套 Artifact 或推进 S3。只有 finish_tender_analysis 返回 completed=true 才能停止。',
  ].join('\n')
}

/**
 * Execute S2 through staged private tools and return Host-authored Artifact references.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Workspace 级 Bid 项目.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param options Host-owned continuation limit for this execution.
 * @returns Expected Artifact references for final Validator inspection.
 */
export async function executeTenderAnalysis(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  options: ModelStageExecutionOptions = { maxRepairAttempts: DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS },
): Promise<StageArtifact[]> {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.signal)
  const analysisRoot = join(workspace.projectRoot, 'analysis')
  await assertNoLinkedPath(workspace.root, analysisRoot)
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid tender analysis requires fs and tools services')
  await Promise.all(task.requiredArtifacts.map(async (path) => {
    const artifactPath = join(workspace.projectRoot, path)
    await rm(artifactPath, { force: true })
    const target = await fs.resolve(artifactPath)
    agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  }))
  const runtime = await attachTenderAnalysisSubmissionRuntime(agent, workspace, await workspace.readManifest())
  const allowedTools = [...task.allowedTools, ...TENDER_ANALYSIS_SUBMISSION_TOOLS]
  const allowed = new Set(allowedTools)
  let liftRestriction: (() => void) | undefined
  let liftGuard: (() => void) | undefined
  const artifacts = task.requiredArtifacts.map(path => ({
    stage: 'tender_analysis' as const,
    type: ARTIFACT_TYPES[path] ?? 'tender_analysis',
    path,
  }))
  try {
    liftRestriction = tools.restrict({ allow: task.allowedTools })
    liftGuard = tools.guard(exec => allowed.has(exec.name)
      ? undefined
      : `Bid stage ${task.stage} allows only ${allowedTools.join(', ')}`)
    options.signal?.throwIfAborted()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: renderTenderAnalysisTask(agent, workspace, task, runtime.locators) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }))
    await waitForModelStageIdle(agent, options.signal)
    let attempts = 0
    while (!runtime.completed) {
      options.signal?.throwIfAborted()
      if (runtime.phase === 'review_required') {
        const snapshot = runtime.reviewSnapshot()
        runtime.beginReview()
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: renderTenderAnalysisQualityReviewTask(agent, workspace, task, snapshot, runtime.locators) }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
        }))
        await waitForModelStageIdle(agent, options.signal)
        continue
      }
      if (attempts++ >= options.maxRepairAttempts) break
      const issues = runtime.lastIssues.length > 0 ? runtime.lastIssues : [{
        code: 'TENDER_ANALYSIS_FINISH_REQUIRED',
        message: '必须调用 finish_tender_analysis 并处理其返回问题；普通回复不能完成 S2。',
      }]
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderTenderAnalysisRepairTask(agent, workspace, task, issues) }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      }))
      await waitForModelStageIdle(agent, options.signal)
    }
    await waitForModelStageIdle(agent, options.signal)
    return artifacts
  } finally {
    liftGuard?.()
    liftRestriction?.()
    runtime.dispose()
  }
}
