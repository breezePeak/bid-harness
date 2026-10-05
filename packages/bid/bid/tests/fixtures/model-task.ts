/** 将测试指定的 canonical 任务编译为真实模型工具的对象选择参数。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { BidWorkspace } from '../../src/index.ts'
import { collectBidModelTaskCatalog } from '../../src/bid-model-task.ts'

/**
 * 保留 fixture 的指定语义；模型入口只收到选择位置。
 * @param agent 拥有真实项目与工具服务的 Main。
 * @param request 测试指定的 canonical 任务和接管条件。
 * @returns 通过真实 inspect 冻结对象表后的模型参数。
 */
export async function modelTaskArguments(agent: Agent, request: { task: object; supersede?: object }): Promise<object> {
  const inspected = await agent.ctx.tools.execute({ agent, name: 'bid_project_inspect',
    arguments: { query: { object: 'outline' } }, callId: CallId('model-task-objects'), signal: new AbortController().signal })
  if (inspected.isError) throw new Error(JSON.stringify(inspected))
  if (agent.session.header.cwd === undefined) throw new Error('测试 Main 缺少项目 cwd')
  const catalog = await collectBidModelTaskCatalog(new BidWorkspace(agent.session.header.cwd), agent.session)
  const fields = {
    section_id: ['section_position', catalog.objects.sections], section_ids: ['section_positions', catalog.objects.sections],
    parent_id: ['parent_position', catalog.objects.sections], source_section_ids: ['source_section_positions', catalog.objects.sections],
    issue_ids: ['issue_positions', catalog.objects.issues], template_id: ['template_position', catalog.objects.templates],
    requirement_id: ['requirement_position', catalog.objects.requirements],
  } as const
  const bindings = new Map(Object.entries(fields))
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (node === null || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).flatMap(([name, child]) => {
      if (name === 'task_id' || name === 'defer_content_migration') return []
      if (name === 'order') return [['sibling_position', Number(child) - 1]]
      const field = bindings.get(name)
      if (field === undefined) return [[name, visit(child)]]
      const index = (id: unknown) => {
        const selected = field[1].findIndex(entry => entry.id === id)
        if (selected < 0) throw new Error('测试目标不在 Host 对象表内：' + String(id))
        return selected
      }
      return [[field[0], child === null ? null : Array.isArray(child) ? child.map(index) : index(child)]]
    }))
  }
  return { ...request.supersede === undefined ? {} : { supersede: true }, task: visit(request.task) }
}
