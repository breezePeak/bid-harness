import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

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
    '根据 Project、Requirements、Scoring、Compliance 和 Evidence Map 设计技术标详细写作 Blueprint。Requirement 保证完整响应，Scoring 决定重点，Compliance 不能遗漏；Evidence 只影响写作备注，缺少资料绝不能省略目录。必要时可 read 已有 source_ref 或 material chunk，但不得 grep 搜索资料。',
    `唯一输出：${root}/outline/outline.json。`,
    '文件严格包含 schema_version=1、scope="technical_bid"、document_title、global_compliance_ids、sections。不得写 content、body、markdown 或任何正文。',
    'sections 是 parent_id + order 的扁平树。每个节点严格包含 id、parent_id、order、level、title、purpose、writable、must_answer、requirement_ids、scoring_ids、compliance_ids、suggested_tables、suggested_figures、writing_notes。',
    'writable 节点必须是一个可独立写作的聚焦技术主题，并有至少一个具体 must_answer；结构节点 writable=false、must_answer=[] 且必须有子节点。不要把粗粒度评分标题直接作为唯一可写章节：按技术语义细化组织、阶段、质量、风险、安全、验收等主题，但不要套固定模板。',
    '每个 Requirement、Scoring 和 Compliance ID 都必须至少覆盖一次；mandatory Requirement，以及 must_answer=true、带 score 或 score_range 的 Scoring，必须关联至少一个 writable 节点。一个 ID 可出现在多个章节，但同一数组不得重复。Compliance 可以放在 global_compliance_ids 或具体章节。',
    'Evidence Map 中 reuse/adapt/reference/background 和 missing_topics 只应转化为简短 writing_notes、建议表格或图示；不得复制 material 引用或撰写技术正文。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '写完文件后停止；Host 将独立验证树结构、引用和覆盖。',
  ].join('\n')
}

/** Execute S4 through the live Agent and return its expected Artifact. */
export async function executeOutlineGeneration(agent: Agent, workspace: BidWorkspace, task: BidStageTask): Promise<StageArtifact[]> {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  await agent.whenIdle()
  const outlineRoot = join(workspace.sessionRoot, 'outline')
  const artifactPath = join(outlineRoot, 'outline.json')
  await assertNoLinkedPath(workspace.root, outlineRoot)
  await mkdir(outlineRoot, { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid outline generation requires fs and tools services')
  await rm(artifactPath, { force: true })
  const target = await fs.resolve(artifactPath)
  agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
  const allowed = new Set(task.allowedTools)
  const liftRestriction = tools.restrict({ allow: task.allowedTools })
  const liftGuard = tools.guard(exec => allowed.has(exec.name) ? undefined : `Bid stage ${task.stage} allows only ${task.allowedTools.join(', ')}`)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: renderOutlineGenerationTask(agent, workspace, task) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
    await agent.whenIdle()
  } finally {
    liftGuard()
    liftRestriction()
  }
  return [{ stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' }]
}
