import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** Render the dynamic S3 assignment for the live Bid Agent. */
export function renderEvidenceMappingTask(agent: Agent, workspace: BidWorkspace, task: BidStageTask): string {
  if (task.stage !== 'evidence_mapping') throw new Error('evidence-mapping-executor-stage-invalid')
  const workspacePath = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const inputPaths = ['manifest.json', ...task.inputs].map(path => `${workspacePath}/${path}`)
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Session Workspace：${workspacePath}`,
    '当前系统只生成技术标；不得为商务、资格、报价或价格评分搜索资料。',
    '先读取 manifest.json 和 S2 的 project、requirements、scoring、compliance Artifact：',
    ...inputPaths.map(path => `- ${path}`),
    `本阶段只允许调用：${task.allowedTools.join(', ')}。`,
    '对每项技术 Requirement 和技术 Scoring 自行生成搜索词，grep 仅定位候选；必须 read 候选 chunk 后再判断。语义截断时先读 chunks/index.json 再读相邻 chunk。不得读取整个 document.md。',
    '优先搜索 manifest 中 role=reference 且 parseStatus=success 的本地技术资料；招标原文只可帮助理解要求，不作为 materials 的重复来源。',
    `唯一输出：${workspacePath}/analysis/evidence-map.json。`,
    '文件严格包含 schema_version=1、requirement_mappings、scoring_mappings。每个技术 Requirement 和技术 Scoring 各出现一次；每个 mapping 严格包含对应 id、materials、missing_topics。',
    '每个 material 严格包含 file_id、chunk、line_start、line_end、usage、summary。usage 只能是 reuse（逻辑高度可复用）、adapt（需结合本项目改写）、reference（技术方法参考）或 background（帮助理解项目）。',
    '没有可用材料是合法结果：materials 写 []，在 missing_topics 说明后续技术写作仍缺少的内容。不得虚构产品参数、项目案例、系统能力或团队经验。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '写完文件后停止；Host 将独立验证覆盖和每一处本地引用。',
  ].join('\n')
}

/** Execute S3 through the live Agent and return its expected Artifact. */
export async function executeEvidenceMapping(agent: Agent, workspace: BidWorkspace, task: BidStageTask): Promise<StageArtifact[]> {
  if (task.stage !== 'evidence_mapping') throw new Error('evidence-mapping-executor-stage-invalid')
  await agent.whenIdle()
  const analysisRoot = join(workspace.sessionRoot, 'analysis')
  const artifactPath = join(workspace.sessionRoot, 'analysis/evidence-map.json')
  await assertNoLinkedPath(workspace.root, analysisRoot)
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid evidence mapping requires fs and tools services')
  await rm(artifactPath, { force: true })
  const target = await fs.resolve(artifactPath)
  agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  const allowed = new Set(task.allowedTools)
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard(exec => allowed.has(exec.name) ? undefined : `Bid stage ${task.stage} allows only ${task.allowedTools.join(', ')}`)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderEvidenceMappingTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await agent.whenIdle()
  } finally {
    liftGuard()
    liftRestriction()
  }
  return [{ stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' }]
}
