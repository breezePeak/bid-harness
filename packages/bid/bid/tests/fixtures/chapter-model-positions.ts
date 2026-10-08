/** 将程序拥有身份的 S5 测试数据编译成真实模型位置协议。 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
const fields = new Map([
  ['item_ref', 'item_position'], ['material_ref', 'material_position'], ['file_ref', 'file_position'],
  ['web_ref', 'web_position'], ['claim_quote_ref', 'claim_quote_position'], ['source_reference', 'source_position'],
  ['evidence_quote_refs', 'evidence_quote_positions'], ['evidence_refs', 'evidence_positions'],
])

/**
 * 按 fixture 固定的编号顺序生成模型参数；持久断言保留原身份。
 * @param value 程序测试数据。
 * @param quoteOffset 文档审核已有静态依据数量。
 * @returns 仅用于模拟模型输出的位置参数。
 */
export function chapterModelPositions(value: unknown, quoteOffset = 0): unknown {
  const refPosition = (ref: unknown): unknown => {
    if (typeof ref !== 'string') return ref
    const match = /^(DQ|[RQMFEWD])([0-9]+)$/u.exec(ref)
    return match === null ? ref : Number(match[2]) - 1 + (match[1] === 'DQ' ? quoteOffset : 0)
  }
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (value === null || typeof value !== 'object') return value
    const output: Record<string, unknown> = {}
    for (const [field, child] of Object.entries(value)) {
      const model = fields.get(field)
      if (model !== undefined) {
        output[model] = Array.isArray(child) ? child.map(refPosition) : refPosition(child)
      } else if (field === 'chunk') {
        const match = typeof child === 'string' ? /^chunk_([0-9]+)$/u.exec(child) : null
        output.chunk_position = match === null ? child : Number(match[1]) - 1
      } else output[field] = visit(child)
    }
    return output
  }
  return visit(value)
}

/**
 * 将带原程序流程图的候选 fixture 投影为语义图及位置锚点。
 * @param candidate 模拟 Writer 的完整候选。
 * @param preservedCount 程序保留的只读原图数量。
 * @returns 新模型正文和 metadata。
 */
export function chapterModelCandidate(candidate: { markdown: string; metadata: Record<string, unknown> }, preservedCount = 0): unknown {
  const flowcharts = candidate.metadata.flowcharts as Array<{
    key?: string
    title: string
    purpose?: string
    nodes: Array<{ key?: string; id?: string; type: string; text: string }>
    edges: Array<{ from?: string; to?: string; from_position?: number; to_position?: number; label?: string }>
  }> | undefined
  let markdown = candidate.markdown
  const charts = flowcharts?.map((chart, index) => {
    if (chart.key !== undefined) {
      markdown = markdown.replaceAll('{{flowchart:' + chart.key + '}}', '{{flowchart:' + String(preservedCount + index) + '}}')
        .replaceAll('{{flow_ref:' + chart.key + '}}', '{{flow_ref:' + String(preservedCount + index) + '}}')
    }
    return { title: chart.title, ...(chart.purpose === undefined ? {} : { purpose: chart.purpose }),
      nodes: chart.nodes.map(({ type, text }) => ({ type, text })), edges: chart.edges.map(edge => ({
        from_position: edge.from_position ?? chart.nodes.findIndex(node => (node.key ?? node.id) === edge.from),
        to_position: edge.to_position ?? chart.nodes.findIndex(node => (node.key ?? node.id) === edge.to),
        ...(edge.label === undefined ? {} : { label: edge.label }),
      })) }
  })
  return { markdown, metadata: chapterModelPositions({ ...candidate.metadata, ...(charts === undefined ? {} : { flowcharts: charts }) }) }
}

/**
 * 编译共享真实 Loader 的 S5 模型调用，使用当前请求的依据位置顺序。
 * @param chunks 可控 Provider 提供的业务回复。
 * @param options 当前实际模型上下文。
 * @returns S5 位置协议回复；其他阶段调用保留。
 */
export function chapterModelReply(chunks: readonly StreamChunk[], options: GenerateOptions): StreamChunk[] {
  const prompt = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const offsetLine = prompt.split('\n').findLast(line => line.startsWith('Evidence Position Count：'))
  const quoteOffset = offsetLine === undefined ? 0 : Number(offsetLine.slice('Evidence Position Count：'.length))
  const tools = ['review_coverage_items', 'review_acceptance_criteria', 'review_global_constraints', 'review_claims',
    'set_review_summary', 'review_global_compliance', 'submit_chapter_writing_completion_review']
  return chunks.map((chunk) => {
    if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') return chunk
    const args: unknown = JSON.parse(chunk.block.arguments)
    const value = chunk.block.name === 'submit_chapter'
      ? chapterModelCandidate(args as { markdown: string; metadata: Record<string, unknown> })
      : tools.includes(chunk.block.name) ? chapterModelPositions(args, quoteOffset) : args
    return { ...chunk, block: { ...chunk.block, arguments: JSON.stringify(value) } }
  })
}
