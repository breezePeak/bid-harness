import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  'analysis/project.json': 'tender_project',
  'analysis/requirements.json': 'tender_requirements',
  'analysis/scoring.json': 'tender_scoring',
  'analysis/compliance.json': 'tender_compliance',
}

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
    '使用 grep 定位候选 chunk，再用 read 阅读原文；语义被截断时读取 chunks/index.json 后继续读相邻 chunk。不得一次读取完整 document.md。',
    '完成前写入以下四个 UTF-8 JSON 文件：',
    ...artifactPaths.map(path => `- ${path}`),
    '四个文件共同使用 schema_version=1。source_refs 必须是非空数组，元素严格包含 file_id、chunk、line_start、line_end；chunk 使用 Session Workspace 相对路径并且必须属于该 tender 文件。',
    'project.json 严格包含 schema_version, project_name, tender_name, purchaser, owner, project_scope, technical_scope, delivery_scope, source_refs, analyzed_tender_files。未知单值写 null，不得补全；analyzed_tender_files 列出全部成功解析 tender 文件的 manifest id。',
    'requirements.json 严格包含 schema_version, requirements；每项严格包含 id, category, raw_text, normalized_requirement, mandatory, source_refs，并按可独立响应的语义原子化。',
    'scoring.json 严格包含 schema_version, scoring_items；每项严格包含 id, parent, group, title, raw_text, criterion, score, score_range, must_answer, source_refs。score_range 为 null 或 {min,max}；不得创造原文没有的评分语义。',
    'compliance.json 严格包含 schema_version, compliance_items；每项严格包含 id, type, raw_text, normalized_rule, severity, source_refs；severity 只能是 fatal、mandatory、warning。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '写完四个文件后停止。回复文字不会完成阶段；Host 会在 Agent idle 后独立校验文件与引用。',
  ].join('\n')
}

/**
 * Execute S2 through the live Harness Agent and return expected Artifact references after quiescence.
 * @param agent Live Agent that owns the Bid Session.
 * @param workspace Session-scoped Bid workspace.
 * @param task Orchestrator task for the tender-analysis stage.
 * @returns Expected Artifact references for Validator inspection.
 */
export async function executeTenderAnalysis(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
): Promise<StageArtifact[]> {
  if (task.stage !== 'tender_analysis') throw new Error('tender-analysis-executor-stage-invalid')
  await agent.whenIdle()
  const analysisRoot = join(workspace.sessionRoot, 'analysis')
  await assertNoLinkedPath(workspace.root, analysisRoot)
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 })
  await Promise.all(task.requiredArtifacts.map(async (path) => {
    const artifactPath = join(workspace.sessionRoot, path)
    await rm(artifactPath, { force: true })
    const target = await agent.ctx.fs.resolve(artifactPath)
    agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  }))
  const allowed = new Set(task.allowedTools)
  const liftRestriction = agent.ctx.tools.restrict({ allow: task.allowedTools })
  const liftGuard = agent.ctx.tools.guard(exec => allowed.has(exec.name)
    ? undefined
    : `Bid stage ${task.stage} allows only ${task.allowedTools.join(', ')}`)
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: renderTenderAnalysisTask(agent, workspace, task) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }))
    await agent.whenIdle()
  } finally {
    liftGuard()
    liftRestriction()
  }
  return task.requiredArtifacts.map(path => ({
    stage: 'tender_analysis',
    type: ARTIFACT_TYPES[path] ?? 'tender_analysis',
    path,
  }))
}
