/** Flowchart content contract, anchor resolution, layout, and the S5 SVG preview renderer. */

export const FLOWCHART_SCHEMA_VERSION = 1 as const
/** Maximum number of native shapes in one flowchart. */
export const FLOWCHART_MAX_NODES = 100
/** Maximum number of native connectors in one flowchart. */
export const FLOWCHART_MAX_EDGES = 200

/** Orientation used by the deterministic layout engine. */
export type FlowchartDirection = 'TB' | 'LR'
/** Semantic node kinds accepted from the Writer. */
export type FlowchartNodeType = 'start' | 'end' | 'process' | 'decision' | 'document' | 'subprocess'

/** One Host-owned flowchart node. */
export interface FlowchartNode {
  readonly id: string
  readonly type: FlowchartNodeType
  readonly text: string
}

/** One Host-owned flowchart connector. */
export interface FlowchartEdge {
  readonly from: string
  readonly to: string
  readonly label?: string | undefined
}

/** Persisted flowchart envelope shared by S5, preview, and S6 export. */
export interface FlowchartBlock {
  readonly type: 'flowchart'
  readonly schema_version: typeof FLOWCHART_SCHEMA_VERSION
  readonly id: string
  /** Stable semantic key written by the model and used by正文 anchors. */
  readonly key?: string | undefined
  readonly title: string
  readonly purpose?: string | undefined
  readonly direction: FlowchartDirection
  readonly nodes: readonly FlowchartNode[]
  readonly edges: readonly FlowchartEdge[]
}

/** Structured flowchart persisted in chapter metadata and consumed by every renderer. */
export type FlowchartSpec = FlowchartBlock

/** Marker prefix used only in the temporary DOCX rendering pass. */
export const FLOWCHART_PLACEHOLDER_PREFIX = 'BID_VISIO_OBJECT_'

/** Return the internal placeholder that the Word COM pass replaces.
 * @param spec Flowchart specification represented by the placeholder.
 * @returns Marker text embedded in the temporary DOCX.
 */
export function flowchartPlaceholder(spec: FlowchartSpec): string {
  return `${FLOWCHART_PLACEHOLDER_PREFIX}${spec.id}`
}

/** Model-facing node shape before Host IDs are assigned. */
export interface FlowchartDraftNode {
  readonly key: string
  readonly type: FlowchartNodeType
  readonly text: string
}

/** Model-facing connector before Host IDs are assigned. */
export interface FlowchartDraftEdge {
  readonly from: string
  readonly to: string
  readonly label?: string | undefined
}

/** Model-facing flowchart shape; IDs are assigned by the Host after validation. */
export interface FlowchartDraft {
  readonly type?: 'flowchart' | undefined
  readonly key?: string | undefined
  readonly title: string
  readonly purpose?: string | undefined
  readonly direction?: FlowchartDirection | undefined
  readonly nodes: readonly FlowchartDraftNode[]
  readonly edges: readonly FlowchartDraftEdge[]
}

/** Accepted model draft or already-normalized persisted flowchart. */
export type FlowchartInput = FlowchartDraft | FlowchartSpec

/** Self-contained SVG preview result. */
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

/** Deterministic node positions shared by preview and native export. */
export interface FlowchartLayout {
  readonly positions: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>
  readonly width: number
  readonly height: number
}

/** Compute deterministic positions without assuming the graph is acyclic.
 * @param spec Validated flowchart specification.
 * @returns Node positions and the canvas size in CSS pixels.
 */
export function layoutFlowchart(spec: FlowchartSpec): FlowchartLayout {
  const incoming = new Map(spec.nodes.map(node => [node.id, 0]))
  const outgoing = new Map<string, string[]>(spec.nodes.map(node => [node.id, []]))
  for (const edge of spec.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const levels = new Map<string, number>()
  const queue = spec.nodes.filter(node => (incoming.get(node.id) ?? 0) === 0).map(node => node.id)
  if (queue.length === 0 && spec.nodes.length > 0) {
    const first = spec.nodes[0]
    if (first !== undefined) queue.push(first.id)
  }
  const queued = new Set(queue)
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) continue
    const level = levels.get(id) ?? 0
    for (const next of outgoing.get(id) ?? []) {
      if (levels.has(next)) continue
      levels.set(next, level + 1)
      if (!queued.has(next)) {
        queued.add(next)
        queue.push(next)
      }
    }
  }
  for (const node of spec.nodes) if (!levels.has(node.id)) levels.set(node.id, 0)
  const groups = new Map<number, FlowchartNode[]>()
  for (const node of spec.nodes) {
    const level = levels.get(node.id)
    if (level === undefined) continue
    groups.set(level, [...(groups.get(level) ?? []), node])
  }
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

function flowchartKey(spec: FlowchartSpec): string {
  return spec.key?.trim() || spec.id
}

/** Validate that every structured flowchart has exactly one semantic body anchor.
 * @param markdown Chapter Markdown to inspect.
 * @param flowcharts Structured flowcharts declared by the chapter metadata.
 * @returns Human-readable anchor violations.
 */
export function validateFlowchartAnchors(
  markdown: string,
  flowcharts: readonly { readonly key?: string | undefined; readonly id?: string | undefined }[],
): string[] {
  const issues: string[] = []
  const keys = flowcharts.map(flowchart => flowchart.key?.trim() || flowchart.id || '')
  if (new Set(keys).size !== keys.length) issues.push('流程图语义 key 必须唯一。')
  const anchors = [...markdown.matchAll(/\{\{flowchart:([A-Za-z0-9_-]{1,64})\}\}/gu)].map(match => match[1] ?? '')
  const known = new Set(keys.filter(Boolean))
  for (const key of anchors) if (!known.has(key)) issues.push(`正文包含未声明的流程图 anchor：${key}。`)
  for (const key of keys) {
    if (!key) {
      issues.push('流程图缺少语义 key。')
      continue
    }
    const count = markdown.split(`{{flowchart:${key}}}`).length - 1
    if (count !== 1) issues.push(`流程图 ${key} 必须在正文中有且只有一个 anchor。`)
  }
  return issues
}

/** Replace model-authored anchors with durable flowchart blocks and resolve figure references.
 * @param markdown Chapter Markdown containing semantic markers.
 * @param flowcharts Structured flowcharts declared by the chapter metadata.
 * @param figureNumbers Document-wide figure numbers keyed by semantic flowchart key.
 * @returns Markdown containing structured flowchart blocks and resolved references.
 */
export function resolveFlowchartAnchors(
  markdown: string,
  flowcharts: readonly FlowchartSpec[],
  figureNumbers: ReadonlyMap<string, number> = new Map(),
): string {
  const byKey = new Map(flowcharts.map(spec => [flowchartKey(spec), spec]))
  if (byKey.size !== flowcharts.length) throw new Error('FLOWCHART_KEY_DUPLICATE')
  const used = new Set<string>()
  const withReferences = markdown.replace(/\{\{flow_ref:([A-Za-z0-9_-]{1,64})\}\}/gu, (_match, key: string) => {
    const number = figureNumbers.get(key)
    if (number === undefined) throw new Error(`FLOWCHART_REFERENCE_UNKNOWN:${key}`)
    return `图 ${String(number)}`
  })
  const resolved = withReferences.replace(/\{\{flowchart:([A-Za-z0-9_-]{1,64})\}\}/gu, (_match, key: string) => {
    const spec = byKey.get(key)
    if (spec === undefined) throw new Error(`FLOWCHART_ANCHOR_UNKNOWN:${key}`)
    if (used.has(key)) throw new Error(`FLOWCHART_ANCHOR_DUPLICATE:${key}`)
    used.add(key)
    return `\`\`\`flowchart\n${JSON.stringify(spec)}\n\`\`\``
  })
  for (const key of byKey.keys()) if (!used.has(key)) throw new Error(`FLOWCHART_ANCHOR_MISSING:${key}`)
  return resolved
}

/** Validate a persisted spec at the renderer boundary.
 * @param spec Untrusted decoded flowchart value.
 * @returns Human-readable validation violations.
 */
export function validateFlowchartSpec(spec: unknown): string[] {
  const issues: string[] = []
  if (typeof spec !== 'object' || spec === null) return ['流程图数据必须是对象。']
  const value = spec as {
    readonly type?: unknown
    readonly schema_version?: unknown
    readonly id?: unknown
    readonly key?: unknown
    readonly title?: unknown
    readonly direction?: unknown
    readonly nodes?: unknown
    readonly edges?: unknown
  }
  if (value.type !== 'flowchart' || value.schema_version !== FLOWCHART_SCHEMA_VERSION) issues.push('流程图 schema 版本无效。')
  if (typeof value.id !== 'string' || !/^FLOW-[A-Za-z0-9_-]+$/u.test(value.id)) issues.push('流程图 ID 不合法。')
  if (value.key !== undefined && (typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.key))) issues.push('流程图语义 key 不合法。')
  if (typeof value.title !== 'string' || value.title.trim().length === 0) issues.push('流程图标题不能为空。')
  if (value.direction !== 'TB' && value.direction !== 'LR') issues.push('流程图方向无效。')
  const nodes = Array.isArray(value.nodes) ? value.nodes : []
  const edges = Array.isArray(value.edges) ? value.edges : []
  if (nodes.length === 0) issues.push('流程图至少需要一个节点。')
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || nodes.length > FLOWCHART_MAX_NODES || edges.length > FLOWCHART_MAX_EDGES) issues.push('流程图规模超过限制。')
  const ids = new Set<string>()
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) {
      issues.push('流程图节点格式无效。')
      continue
    }
    const value = node as { readonly id?: unknown; readonly type?: unknown; readonly text?: unknown }
    const id = typeof value.id === 'string' ? value.id : ''
    if (!/^N\d+$/u.test(id)) issues.push(`节点 ID 不合法：${id}。`)
    if (ids.has(id)) issues.push(`节点 ID 重复：${id}。`)
    ids.add(id)
    if (!['start', 'end', 'process', 'decision', 'document', 'subprocess'].includes(value.type as string)) issues.push(`节点 ${id} 类型无效。`)
    if (typeof value.text !== 'string' || value.text.trim().length === 0) issues.push(`节点 ${id} 文本不能为空。`)
  }
  const startCount = nodes.filter(node => typeof node === 'object' && node !== null && (node as { readonly type?: unknown }).type === 'start').length
  const endCount = nodes.filter(node => typeof node === 'object' && node !== null && (node as { readonly type?: unknown }).type === 'end').length
  if (startCount > 1) issues.push('流程图只能有一个开始节点。')
  if (endCount > 1) issues.push('流程图只能有一个结束节点。')
  const edgeKeys = new Set<string>()
  for (const edge of edges) {
    if (typeof edge !== 'object' || edge === null) {
      issues.push('流程图连线格式无效。')
      continue
    }
    const value = edge as { readonly from?: unknown; readonly to?: unknown; readonly label?: unknown }
    const from = typeof value.from === 'string' ? value.from : ''
    const to = typeof value.to === 'string' ? value.to : ''
    const label = value.label === undefined ? '' : typeof value.label === 'string' ? value.label : '<invalid>'
    if (value.from === undefined || value.to === undefined || typeof value.from !== 'string' || typeof value.to !== 'string') issues.push('流程图连线端点格式无效。')
    if (value.label !== undefined && typeof value.label !== 'string') issues.push('流程图连线标签格式无效。')
    if (!ids.has(from) || !ids.has(to)) issues.push(`连线引用不存在的节点：${from}→${to}。`)
    const key = `${from}\u0000${to}\u0000${label}`
    if (edgeKeys.has(key)) issues.push(`连线重复：${from}→${to}。`)
    edgeKeys.add(key)
  }
  for (const node of nodes.filter(value => typeof value === 'object' && value !== null && (value as { readonly type?: unknown }).type === 'decision')) {
    const id = (node as { readonly id?: unknown }).id
    if (edges.filter(edge => typeof edge === 'object' && edge !== null && (edge as { readonly from?: unknown }).from === id).length < 2) issues.push(`判断节点 ${String(id)} 缺少分支连线。`)
  }
  return issues
}

/** Assign Host-owned flowchart and node IDs after the model result is accepted.
 * @param sectionId Confirmed outline section owning the flowcharts.
 * @param inputs Model drafts or previously normalized inputs.
 * @returns Normalized flowchart specifications.
 */
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
      key: input.key?.trim() || `flowchart-${String(index + 1)}`,
      title: input.title.trim(), ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
      direction: input.direction ?? 'TB',
      nodes: nodes.map(({ key: _key, ...node }) => node),
      edges: input.edges.map(edge => ({
        from: nodeIds.get(edge.from) ?? edge.from,
        to: nodeIds.get(edge.to) ?? edge.to,
        ...(edge.label?.trim() ? { label: edge.label.trim() } : {}),
      })),
    }
    const issues = validateFlowchartSpec(spec)
    if (issues.length > 0) throw new Error(`Flowchart ${spec.id} 无效：${issues.join('；')}`)
    return spec
  })
}

/** Render the same validated spec to a self-contained SVG for Web and DOCX.
 * @param spec Validated flowchart specification.
 * @returns Self-contained SVG and its dimensions.
 */
export function renderFlowchartSvg(spec: FlowchartSpec): FlowchartSvg {
  const issues = validateFlowchartSpec(spec)
  if (issues.length > 0) throw new Error(`Flowchart 无法渲染：${issues.join('；')}`)
  const { positions, width, height } = layoutFlowchart(spec)
  const edges = spec.edges.map((edge) => {
    const from = positions.get(edge.from), to = positions.get(edge.to)
    if (from === undefined || to === undefined) throw new Error('Flowchart 布局缺少连线节点。')
    const x1 = from.x + from.width / 2, y1 = from.y + from.height / 2
    const x2 = to.x + to.width / 2, y2 = to.y + to.height / 2
    const label = edge.label === undefined ? '' : `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-family="Microsoft YaHei,Arial,sans-serif" font-size="12" fill="#475569">${escapeXml(edge.label)}</text>`
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>${label}`
  }).join('')
  const nodes = spec.nodes.map((node) => {
    const position = positions.get(node.id)
    if (position === undefined) throw new Error('Flowchart 布局缺少节点。')
    return nodeShape(node, position.x, position.y, position.width, position.height)
  }).join('')
  return {
    width, height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(spec.title)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="white"/>${edges}${nodes}</svg>`,
  }
}
