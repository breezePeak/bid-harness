/** Flowchart content contract and deterministic SVG renderer shared by S5 and S6. */

export const FLOWCHART_SCHEMA_VERSION = 1 as const
export const FLOWCHART_MAX_NODES = 100
export const FLOWCHART_MAX_EDGES = 200

export type FlowchartDirection = 'TB' | 'LR'
export type FlowchartNodeType = 'start' | 'end' | 'process' | 'decision' | 'document' | 'subprocess'

export interface FlowchartNode {
  readonly id: string
  readonly type: FlowchartNodeType
  readonly text: string
}

export interface FlowchartEdge {
  readonly from: string
  readonly to: string
  readonly label?: string | undefined
}

export interface FlowchartBlock {
  readonly type: 'flowchart'
  readonly schema_version: typeof FLOWCHART_SCHEMA_VERSION
  readonly id: string
  readonly title: string
  readonly purpose?: string | undefined
  readonly direction: FlowchartDirection
  readonly nodes: readonly FlowchartNode[]
  readonly edges: readonly FlowchartEdge[]
}

/** Structured flowchart persisted in chapter metadata and consumed by every renderer. */
export type FlowchartSpec = FlowchartBlock

export interface FlowchartDraftNode {
  readonly key: string
  readonly type: FlowchartNodeType
  readonly text: string
}

export interface FlowchartDraftEdge {
  readonly from: string
  readonly to: string
  readonly label?: string | undefined
}

/** Model-facing flowchart shape; IDs are assigned by the Host after validation. */
export interface FlowchartDraft {
  readonly type?: 'flowchart' | undefined
  readonly title: string
  readonly purpose?: string | undefined
  readonly direction?: FlowchartDirection | undefined
  readonly nodes: readonly FlowchartDraftNode[]
  readonly edges: readonly FlowchartDraftEdge[]
}

export type FlowchartInput = FlowchartDraft | FlowchartSpec

export interface FlowchartSvg {
  readonly svg: string
  readonly width: number
  readonly height: number
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function textLines(value: string, max = 18): string[] {
  const chars = Array.from(value.trim())
  const lines: string[] = []
  for (let index = 0; index < chars.length; index += max) lines.push(chars.slice(index, index + max).join(''))
  return lines.length > 0 ? lines : ['']
}

function nodeSize(node: FlowchartNode): { width: number; height: number } {
  return { width: node.type === 'decision' ? 190 : 180, height: Math.max(56, textLines(node.text).length * 18 + 20) }
}

function nodeShape(node: FlowchartNode, x: number, y: number, width: number, height: number): string {
  const fill = node.type === 'decision' ? '#fff7ed' : node.type === 'start' || node.type === 'end' ? '#ecfdf5' : '#ffffff'
  const stroke = node.type === 'decision' ? '#c2410c' : node.type === 'start' || node.type === 'end' ? '#047857' : '#334155'
  const shape = node.type === 'decision'
    ? `<polygon points="${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`
    : `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${node.type === 'start' || node.type === 'end' ? 28 : 8}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`
  const lines = textLines(node.text)
  const startY = y + height / 2 - (lines.length - 1) * 9
  const label = lines.map((line, index) => `<tspan x="${x + width / 2}" dy="${index === 0 ? 0 : 18}">${escapeXml(line)}</tspan>`).join('')
  return `${shape}<text x="${x + width / 2}" y="${startY}" text-anchor="middle" dominant-baseline="middle" font-family="Microsoft YaHei,Arial,sans-serif" font-size="14" fill="#0f172a">${label}</text>`
}

function layout(spec: FlowchartSpec): { positions: Map<string, { x: number; y: number; width: number; height: number }>; width: number; height: number } {
  const incoming = new Map(spec.nodes.map(node => [node.id, 0]))
  const outgoing = new Map<string, string[]>(spec.nodes.map(node => [node.id, []]))
  for (const edge of spec.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const levels = new Map<string, number>()
  const queue = spec.nodes.filter(node => (incoming.get(node.id) ?? 0) === 0).map(node => node.id)
  if (queue.length === 0 && spec.nodes.length > 0) queue.push(spec.nodes[0]!.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    const level = levels.get(id) ?? 0
    for (const next of outgoing.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, level + 1))
      const rest = (incoming.get(next) ?? 0) - 1
      incoming.set(next, rest)
      if (rest <= 0) queue.push(next)
    }
  }
  for (const node of spec.nodes) if (!levels.has(node.id)) levels.set(node.id, 0)
  const groups = new Map<number, FlowchartNode[]>()
  for (const node of spec.nodes) groups.set(levels.get(node.id)!, [...(groups.get(levels.get(node.id)!) ?? []), node])
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>()
  const gap = 42, margin = 30
  for (const [level, nodes] of groups) for (const [index, node] of nodes.entries()) {
    const size = nodeSize(node)
    const cross = nodes.slice(0, index).reduce((sum, value) => sum + nodeSize(value).height + gap, 0)
    positions.set(node.id, spec.direction === 'LR'
      ? { x: margin + level * 240, y: margin + cross, ...size }
      : { x: margin + cross, y: margin + level * 150, ...size })
  }
  const width = Math.max(320, ...[...positions.values()].map(value => value.x + value.width + margin))
  const height = Math.max(180, ...[...positions.values()].map(value => value.y + value.height + margin))
  return { positions, width, height }
}

/** Validate a persisted spec at the renderer boundary. */
export function validateFlowchartSpec(spec: FlowchartSpec): string[] {
  const issues: string[] = []
  if (spec.type !== 'flowchart' || spec.schema_version !== FLOWCHART_SCHEMA_VERSION) issues.push('流程图 schema 版本无效。')
  if (!/^FLOW-[A-Za-z0-9_-]+$/u.test(spec.id)) issues.push('流程图 ID 不合法。')
  if (spec.title.trim().length === 0) issues.push('流程图标题不能为空。')
  if (spec.nodes.length === 0) issues.push('流程图至少需要一个节点。')
  if (spec.nodes.length > FLOWCHART_MAX_NODES || spec.edges.length > FLOWCHART_MAX_EDGES) issues.push('流程图规模超过限制。')
  const ids = new Set<string>()
  for (const node of spec.nodes) {
    if (ids.has(node.id)) issues.push(`节点 ID 重复：${node.id}。`)
    ids.add(node.id)
    if (node.text.trim().length === 0) issues.push(`节点 ${node.id} 文本不能为空。`)
  }
  const startCount = spec.nodes.filter(node => node.type === 'start').length
  const endCount = spec.nodes.filter(node => node.type === 'end').length
  if (startCount > 1) issues.push('流程图只能有一个开始节点。')
  if (endCount > 1) issues.push('流程图只能有一个结束节点。')
  const edgeKeys = new Set<string>()
  for (const edge of spec.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`连线引用不存在的节点：${edge.from}→${edge.to}。`)
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ''}`
    if (edgeKeys.has(key)) issues.push(`连线重复：${edge.from}→${edge.to}。`)
    edgeKeys.add(key)
  }
  for (const node of spec.nodes.filter(value => value.type === 'decision')) {
    if (spec.edges.filter(edge => edge.from === node.id).length < 2) issues.push(`判断节点 ${node.id} 缺少分支连线。`)
  }
  return issues
}

/** Assign Host-owned flowchart and node IDs after the model result is accepted. */
export function normalizeFlowchartInputs(sectionId: string, inputs: readonly FlowchartInput[]): FlowchartSpec[] {
  return inputs.map((input, index) => {
    const sourceNodes = input.nodes as readonly (FlowchartDraftNode | FlowchartNode)[]
    const nodes = sourceNodes.map((node, nodeIndex) => ({
      id: `N${String(nodeIndex + 1)}`,
      type: node.type,
      text: node.text.trim(),
      key: 'key' in node ? node.key : node.id,
    }))
    const nodeIds = new Map(nodes.map(node => [node.key, node.id]))
    const spec: FlowchartSpec = {
      type: 'flowchart', schema_version: FLOWCHART_SCHEMA_VERSION,
      id: `FLOW-${sectionId.replaceAll(/[^A-Za-z0-9_-]/gu, '_')}-${String(index + 1)}`,
      title: input.title.trim(), ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
      direction: input.direction ?? 'TB',
      nodes: nodes.map(({ key: _key, ...node }) => node),
      edges: input.edges.map(edge => ({ from: nodeIds.get(edge.from) ?? edge.from, to: nodeIds.get(edge.to) ?? edge.to, ...(edge.label?.trim() ? { label: edge.label.trim() } : {}) })),
    }
    const issues = validateFlowchartSpec(spec)
    if (issues.length > 0) throw new Error(`Flowchart ${spec.id} 无效：${issues.join('；')}`)
    return spec
  })
}

/** Render the same validated spec to a self-contained SVG for Web and DOCX. */
export function renderFlowchartSvg(spec: FlowchartSpec): FlowchartSvg {
  const issues = validateFlowchartSpec(spec)
  if (issues.length > 0) throw new Error(`Flowchart 无法渲染：${issues.join('；')}`)
  const { positions, width, height } = layout(spec)
  const edges = spec.edges.map((edge) => {
    const from = positions.get(edge.from)!, to = positions.get(edge.to)!
    const x1 = from.x + from.width / 2, y1 = from.y + from.height / 2
    const x2 = to.x + to.width / 2, y2 = to.y + to.height / 2
    const label = edge.label === undefined ? '' : `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-family="Microsoft YaHei,Arial,sans-serif" font-size="12" fill="#475569">${escapeXml(edge.label)}</text>`
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>${label}`
  }).join('')
  const nodes = spec.nodes.map((node) => {
    const position = positions.get(node.id)!
    return nodeShape(node, position.x, position.y, position.width, position.height)
  }).join('')
  return {
    width, height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(spec.title)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="white"/>${edges}${nodes}</svg>`,
  }
}
