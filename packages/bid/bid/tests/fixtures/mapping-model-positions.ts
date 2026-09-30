/** 可控 Provider 夹具从实际模型输入编译位置参数；不参与真实 Provider 验收。 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

type Objects = Record<string, Array<{ id: string; position: number }>>

/**
 * 从当前职责索引编译可控目录复核回复；覆盖对象由生产 Host 绑定。
 * @param value 可控夹具的 canonical 报告。
 * @param prompt 实际目录复核提示。
 * @returns 模型位置协议的报告。
 */
export function mappingModelQuality(value: unknown, prompt: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const { checked_requirement_ids: _requirements, checked_scoring_ids: _scoring,
    checked_scoring_response_point_ids: _points, ...report } = value as Record<string, unknown>
  const line = prompt.split('\n').find(item => item.startsWith('全书职责索引：'))
  const sections = line === undefined ? [] : JSON.parse(line.slice('全书职责索引：'.length)) as Array<{ id: string; position: number }>
  return { ...report, blocking_issues: Array.isArray(report.blocking_issues) ? report.blocking_issues.map((issue: unknown) => {
    if (issue === null || typeof issue !== 'object' || !('section_id' in issue)) return issue
    const { section_id, ...rest } = issue
    return { ...rest, section_position: sections.find(item => item.id === section_id)?.position ?? 999_999 }
  }) : report.blocking_issues }
}
const fields: Record<string, [string, string]> = {
  section_id: ['section_position', 'sections'], target_section_id: ['target_section_position', 'sections'],
  parent_id: ['parent_position', 'sections'], section_ids: ['section_positions', 'sections'],
  requirement_id: ['requirement_position', 'requirements'], requirement_ids: ['requirement_positions', 'requirements'],
  scoring_id: ['scoring_position', 'scoring'], scoring_ids: ['scoring_positions', 'scoring'],
  compliance_id: ['compliance_position', 'compliance'], compliance_ids: ['compliance_positions', 'compliance'],
  scoring_response_point_ids: ['response_point_positions', 'response_points'],
  ref: ['reference_position', 'references'], record_id: ['record_position', 'references'],
  finding_refs: ['finding_positions', 'findings'], review_ref: ['review_position', 'reviews'],
  material_ref: ['material_position', 'references'], chunk_refs: ['chunk_positions', 'references'],
}

/**
 * 将测试的 canonical 参数转换为当前对象表中的模型选择。
 * @param value 夹具提供的业务回复。
 * @param objects 当前任务提示或真实工具结果中的对象表。
 * @returns 通过模型位置协议提交的参数；未知身份保持非法位置。
 */
export function mappingModelArguments(value: unknown, objects: Objects): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(item => mappingModelArguments(item, objects))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([name, child]) => {
    const field = fields[name]
    if (field === undefined) return [name, mappingModelArguments(child, objects)]
    const select = (id: unknown) => id === null ? null : objects[field[1]]?.find(item => item.id === id)?.position ?? 999_999
    return [field[0], Array.isArray(child) ? (child as unknown[]).map(select) : select(child)]
  }))
}

/**
 * 读取本轮模型实际可见的 S4 对象表。
 * @param options 当前可控 Provider 请求。
 * @returns 最新工具对象表，或任务提示中的初始表。
 */
function mappingModelObjects(options: Pick<GenerateOptions, 'messages'>): Objects | undefined {
  for (const message of [...options.messages].reverse()) for (const block of [...message.content].reverse()) {
    if (block.type === 'tool-result') for (const content of block.content) {
      if (content.type !== 'text' || !content.text.trimStart().startsWith('{')) continue
      const result = JSON.parse(content.text) as { objects?: Objects }
      if (result.objects !== undefined) return result.objects
    }
    if (block.type === 'text') {
      const line = block.text.split('\n').find(value => value.startsWith('对象位置：'))
      if (line !== undefined) return JSON.parse(line.slice('对象位置：'.length)) as Objects
    }
  }
  return undefined
}

/**
 * 将可控回复中的 S4 工具调用编译为最新位置协议。
 * @param chunks 已确定的夹具回复。
 * @param options 真实运行时组装的请求。
 * @returns 使用位置参数的可控回复；其他阶段保持原调用。
 */
export function mappingModelReply(chunks: readonly StreamChunk[], options: GenerateOptions): StreamChunk[] {
  if (options.system?.includes('技术标目录轻量复核 Subagent')) return chunks.map((chunk) => {
    if (chunk.type !== 'block-end') return chunk
    const prompt = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') return {
      ...chunk, block: { ...chunk.block, arguments: JSON.stringify(mappingModelQuality(JSON.parse(chunk.block.arguments), prompt)) },
    }
    if (chunk.block.type !== 'text' || !chunk.block.text.trimStart().startsWith('{')) return chunk
    return { ...chunk, block: { ...chunk.block, text: JSON.stringify(mappingModelQuality(JSON.parse(chunk.block.text), prompt)) } }
  })
  const objects = mappingModelObjects(options)
  if (objects === undefined) return [...chunks]
  return chunks.map(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
    ? { ...chunk, block: { ...chunk.block, arguments: JSON.stringify(mappingModelArguments(JSON.parse(chunk.block.arguments), objects)) } }
    : chunk)
}
