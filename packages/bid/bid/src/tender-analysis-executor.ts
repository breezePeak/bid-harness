import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import { BidStageExecutionError, type BidStageTask, type StageArtifact, type StageValidationIssue } from './control-plane-contract.ts'
import {
  type ModelStageExecutionOptions,
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import { renderBidRecoveryContext } from './bid-recovery.ts'
import {
  attachTenderAnalysisSubmissionRuntime,
  TENDER_ANALYSIS_PRIVATE_TOOLS,
  TENDER_ANALYSIS_VIEW_TOOLS,
  type TenderLocator,
} from './tender-analysis-submission.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { installMainAgentProtocol } from './main-agent-protocol.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'

const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  'analysis/project.json': 'tender_project',
  'analysis/requirements.json': 'tender_requirements',
  'analysis/scoring-origin.json': 'tender_scoring_origin',
  'analysis/compliance.json': 'tender_compliance',
}

const TECHNICAL_SCORING_ANCHORS = '技术评分、技术评审、技术评价、评分标准、评分表、评审因素、分值、满分'
const TENDER_ANALYSIS_VIEW_TOOL_NAMES: ReadonlySet<string> = new Set(TENDER_ANALYSIS_VIEW_TOOLS)

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
    `本阶段可用检索工具仅为：${task.allowedTools.filter(name => !TENDER_ANALYSIS_VIEW_TOOL_NAMES.has(name)).join(', ')}。另有 S2 私有工具：${TENDER_ANALYSIS_PRIVATE_TOOLS.join(', ')}。不得调用 write、bash、web_search、web_fetch 或 subagent。`,
    '当前只分析技术标。保留项目背景、建设目标和范围；技术、功能、性能、接口、参数和架构要求；实施、进度、质量、测试、验收、培训、运维和技术服务要求；数据、网络和信息安全；技术评分项；以及影响技术方案的强制要求或否决条件。',
    '排除投标报价、价格评分、报价计算、付款、保证金、财务、纳税、营业执照、法定代表人、授权委托、资格审查、注册资本、纯商务信誉、纯商务评分和纯商务合同条款。人员、案例、服务和承诺按是否直接影响技术方案编写或技术评分响应判断，不得按关键词机械过滤。',
    '使用 grep 定位候选 chunk，再用 read 阅读原文；语义被截断时读取 chunks/index.json 后继续读相邻 chunk。不得一次读取完整 document.md。',
    '优先使用 grep/read。只有表格、图片或版式关系无法从解析文本可靠判断时，才用 view_pdf_page 查看已定位的 PDF 页；不得逐页浏览整份 PDF，也不得把页面图片当作 OCR 文本来源。',
    '提取技术评分时，先用 grep 搜索评分区域锚点：' + TECHNICAL_SCORING_ANCHORS + '。命中后 read 对应 chunk 和 chunks/index.json，利用 prev_chunk、next_chunk 和 heading_path 连续阅读评分区域；只在边界截断时扩展，进入商务、价格、资格或无关区域时停止。完成该区域后只再 grep 一次检查远距离第二评分区域，发现新区域才继续读取。不得为每个评分项全局 grep。',
    '完整分析结果包含 project_facts、requirements、scoring_items 和 compliance_items 四个数组。项目数组字段每个语义项各占一条；未知项目字段省略，Host 自动补齐 null 或 []。所有项目内容必须至少有一个真实 tender source，不得补通用模板。',
    'requirements 中每项是一个可独立响应的原子技术要求。scoring_items 只包含招标评分体系中具有独立名称及总分、权重或独立区块边界的评分大项，并在 criterion 中保留该大项的完整评分细则；大项内部的评价内容、得分条件、子要求、分档规则或分项得分说明不得另建评分项。compliance_items 包含每个影响技术方案的强制或合规规则。',
    '引用只提交 sources=[{file_ref,chunk,anchor_text}]；file_ref 使用 T1、T2 等 locator，chunk 使用 chunk_0001 等 index id。anchor_text 填写该 chunk 对应的非空来源文本。Host 只校验真实 tender、chunk 归属和非空文本，并以整个 chunk 的实际行范围生成引用。',
    '不得填写或猜测任何业务 ID、runtime ref、revision、replace_ref、quote、raw_text、file_id、source_refs、line_start、line_end、parent、schema_version、analyzed_tender_files 或最终 Artifact 路径。Host 从来源输入生成原文、引用、全部 ID、排序和固定字段；归纳字段不得改变数字、单位、“应、须、必须、不得”等强制语义或增加原文没有的要求。',
    '分析完成后仅调用一次 submit_tender_analysis，提交四个完整数组。普通文字回复不会完成 S2。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
  ].join('\n')
}

/**
 * Render a bounded continuation for an invalid or missing complete S2 submission.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Workspace 级 Bid 项目.
 * @param task Orchestrator task for the tender-analysis stage.
 * @param issues Recoverable issues returned for the previous complete result.
 * @param context Current invalid item and the original chunks cited by that item.
 * @returns Dynamic continuation that requests one corrected complete result.
 */
export function renderTenderAnalysisRepairTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  issues: readonly StageValidationIssue[],
  context: unknown,
): string {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  const repairInstructions = context === undefined ? [
    'Host 尚未收到完整结果。调用 submit_tender_analysis 提交 project_facts、requirements、scoring_items 和 compliance_items 四个完整数组。',
  ] : [
    `当前问题项与相关原文：${JSON.stringify(context)}`,
    '修正后再次调用 submit_tender_analysis，只提交 {repair:{<repair_key>:<修正后的单个业务项>}}。不得重交完整数组，也不得提交任何 ID、revision、replace_ref 或正式 Artifact 字段。',
  ]
  return [
    `当前阶段：${task.stage} / Complete Submission Repair`,
    `Bid Session：${agent.id}`,
    `Project Workspace：${workspacePath}`,
    '上一份完整 S2 结果未通过校验。只修正以下内容问题：',
    ...issues.map(issue => `- ${issue.code} | ${issue.path ?? '未指定字段'} | ${issue.message}`),
    `检索工具仍只允许：${task.allowedTools.filter(name => !TENDER_ANALYSIS_VIEW_TOOL_NAMES.has(name)).join(', ')}；必要时可用 ${TENDER_ANALYSIS_VIEW_TOOLS.join(', ')} 复核版式。`,
    ...repairInstructions,
  ].join('\n')
}

/**
 * Execute S2 through one complete-submission tool and return Host-authored Artifact references.
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
  options: ModelStageExecutionOptions,
): Promise<StageArtifact[]> {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.run.signal)
  options.run.reportProgress({ phase: 'locating', summary: '正在定位招标文件中的技术要求与评分区域' })
  const analysisRoot = join(workspace.projectRoot, 'analysis')
  await assertNoLinkedPath(workspace.root, analysisRoot)
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid tender analysis requires fs and tools services')
  const artifacts = task.requiredArtifacts.map(path => ({
    stage: 'tender_analysis' as const,
    type: ARTIFACT_TYPES[path] ?? 'tender_analysis',
    path,
  }))
  const existing = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
  if (existing.ok) return artifacts
  const runtime = await attachTenderAnalysisSubmissionRuntime(agent, workspace, await workspace.readManifest(), options.run)
  options.run.reportProgress({
    phase: 'collecting',
    summary: '正在提取招标信息与原文依据',
    details: [`已定位 ${String(runtime.locators.length)} 份招标文件`],
  })
  const ordinaryTools = task.allowedTools.filter(name => !TENDER_ANALYSIS_VIEW_TOOL_NAMES.has(name))
  const allowedTools = [...ordinaryTools, ...TENDER_ANALYSIS_PRIVATE_TOOLS]
  const allowed = new Set(allowedTools)
  let liftRestriction: (() => void) | undefined
  let liftGuard: (() => void) | undefined
  try {
    liftRestriction = tools.restrict({ allow: ordinaryTools })
    liftGuard = tools.guard(exec => allowed.has(exec.name)
      ? undefined
      : `Bid stage ${task.stage} allows only ${allowedTools.join(', ')}`)
    const run = async (prompt: string): Promise<void> => {
      await options.run.scheduler.waitUntilRunnable(options.run.signal)
      const message = createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      })
      const protocol = installMainAgentProtocol(agent, {
        privateTools: TENDER_ANALYSIS_PRIVATE_TOOLS,
        internalTools: allowedTools,
        setPrivateToolsEnabled: (enabled) => { runtime.setToolsEnabled(enabled) },
        label: 'S2 Tender Analysis',
      })
      protocol.own(message)
      try {
        agent.followup(message)
        await waitForModelStageIdle(agent, options.run.signal)
      } finally {
        protocol.dispose()
      }
    }
    options.run.signal.throwIfAborted()
    await run([renderTenderAnalysisTask(agent, workspace, task, runtime.locators), renderBidRecoveryContext(options.recovery)].filter(Boolean).join('\n'))
    let attempts = 0
    let latestIssues = runtime.lastIssues
    while (!runtime.completed) {
      options.run.signal.throwIfAborted()
      if (attempts++ >= options.maxRepairAttempts) break
      const issues = runtime.lastIssues.length > 0 ? runtime.lastIssues : [{
        code: 'TENDER_ANALYSIS_SUBMISSION_REQUIRED',
        message: '必须调用 submit_tender_analysis 提交四个完整数组；普通回复不能完成 S2。',
      }]
      latestIssues = issues
      options.run.reportProgress({
        phase: 'repairing',
        summary: '正在修正招标信息提取结果',
        completed: attempts,
        total: options.maxRepairAttempts,
        details: issues.slice(0, 5).map(issue => `${issue.code}：${issue.message}`),
      })
      await run([renderTenderAnalysisRepairTask(agent, workspace, task, issues, runtime.repairContext()), renderBidRecoveryContext(options.recovery)].filter(Boolean).join('\n'))
    }
    await waitForModelStageIdle(agent, options.run.signal)
    if (!runtime.completed) {
      throw new BidStageExecutionError([{
        code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE',
        message: `S2 完整结果未提交或未通过校验。最近问题：${latestIssues.map(issue => issue.code).join(', ') || '无'}。`,
      }, ...latestIssues])
    }
    options.run.reportProgress({ phase: 'validating', summary: '招标信息提取已通过校验，正在提交阶段结果' })
    return artifacts
  } finally {
    liftGuard?.()
    liftRestriction?.()
    runtime.dispose()
  }
}
