import { describe, expect, it } from 'vitest'
import { boxesOverlap, layoutFlowchart, normalizeFlowchartInputs, renderFlowchartSvg, resolveFlowchartAnchors, validateFlowchartAnchors, validateFlowchartSpec, type FlowchartDraft, type FlowchartSpec } from '../src/flowchart.ts'

const draft: FlowchartDraft = {
  title: '质量检查闭环', direction: 'TB',
  nodes: [
    { key: 'start', type: 'start', text: '开始' },
    { key: 'check', type: 'decision', text: '质量检查' },
    { key: 'fix', type: 'process', text: '整改' },
    { key: 'end', type: 'end', text: '成果提交' },
  ],
  edges: [
    { from: 'start', to: 'check' }, { from: 'check', to: 'fix', label: '不通过' },
    { from: 'fix', to: 'check' }, { from: 'check', to: 'end', label: '通过' },
  ],
}

function expectNoOverlappingNodes(spec: FlowchartSpec): void {
  const layout = layoutFlowchart(spec)
  const boxes = [...layout.positions.entries()]
  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      expect(boxesOverlap(boxes[left]![1], boxes[right]![1]), `${boxes[left]![0]} overlaps ${boxes[right]![0]}`).toBe(false)
    }
  }
}

describe('flowchart contract', () => {
  it('由 Host 分配流程图和节点身份，并生成可复用 SVG', () => {
    const [spec] = normalizeFlowchartInputs('SEC-IMPLEMENT', [draft])
    expect(spec).toBeDefined()
    const normalized = spec!
    expect(normalized.id).toBe('FLOW-SEC-IMPLEMENT-1')
    expect(normalized.nodes.map(node => node.id)).toEqual(['N1', 'N2', 'N3', 'N4'])
    expect(validateFlowchartSpec(normalized)).toEqual([])
    const rendered = renderFlowchartSvg(normalized)
    expect(rendered.svg).toContain('<svg')
    expect(rendered.svg).toContain('不通过')
  })

  it('拒绝断开的连线和缺少分支的判断节点', () => {
    expect(() => normalizeFlowchartInputs('SEC-INVALID', [{ ...draft, edges: [{ from: 'start', to: 'missing' }, { from: 'check', to: 'end' }] }])).toThrow('不存在的节点')
    expect(validateFlowchartSpec({ ...normalizeFlowchartInputs('SEC-INVALID', [draft])[0]!, edges: [{ from: 'N2', to: 'N4' }] })).toEqual(expect.arrayContaining([
      expect.stringContaining('缺少分支'),
    ]))
  })

  it('在非对象输入和未声明 anchor 时返回确定性错误', () => {
    expect(validateFlowchartSpec(null)).toEqual(['流程图数据必须是对象。'])
    const [spec] = normalizeFlowchartInputs('SEC-IMPLEMENT', [draft])
    expect(validateFlowchartAnchors('{{flowchart:unknown}}', [spec!])).toEqual(expect.arrayContaining([
      expect.stringContaining('未声明'),
      expect.stringContaining('必须在正文中有且只有一个'),
    ]))
  })

  it('为循环图保留前向层级，并严格按正文 anchor 展开', () => {
    const [spec] = normalizeFlowchartInputs('SEC-IMPLEMENT', [{ ...draft, key: 'quality-control-flow' }])
    const layout = layoutFlowchart(spec!)
    expect(layout.positions.get('N2')!.y).toBeLessThan(layout.positions.get('N3')!.y)
    const markdown = '前置说明。\n\n{{flowchart:quality-control-flow}}\n\n后置说明。'
    expect(validateFlowchartAnchors(markdown, [spec!])).toEqual([])
    expect(resolveFlowchartAnchors(markdown, [spec!], new Map([['quality-control-flow', 3]]))).toContain('```flowchart')
    expect(() => resolveFlowchartAnchors('缺少 anchor', [spec!])).toThrow('FLOWCHART_ANCHOR_MISSING')
  })

  it('按方向使用正确的同层轴，并为串行、分支和整改闭环避免节点重叠', () => {
    const cases: FlowchartDraft[] = [
      {
        title: '普通串行', direction: 'TB',
        nodes: [
          { key: 'start', type: 'start', text: '开始' }, { key: 'process', type: 'process', text: '处理' }, { key: 'end', type: 'end', text: '结束' },
        ], edges: [{ from: 'start', to: 'process' }, { from: 'process', to: 'end' }],
      },
      {
        title: '判断双分支', direction: 'TB',
        nodes: [
          { key: 'decision', type: 'decision', text: '判断' }, { key: 'yes', type: 'process', text: 'A' }, { key: 'no', type: 'process', text: 'B' },
        ], edges: [{ from: 'decision', to: 'yes', label: '是' }, { from: 'decision', to: 'no', label: '否' }],
      },
      {
        title: '三分支', direction: 'LR',
        nodes: [
          { key: 'review', type: 'process', text: '审核' }, { key: 'a', type: 'process', text: 'A' }, { key: 'b', type: 'process', text: 'B' }, { key: 'c', type: 'process', text: 'C' },
        ], edges: [{ from: 'review', to: 'a' }, { from: 'review', to: 'b' }, { from: 'review', to: 'c' }],
      },
      {
        title: '整改闭环', direction: 'TB',
        nodes: [
          { key: 'check', type: 'decision', text: '检查' }, { key: 'submit', type: 'process', text: '提交' }, { key: 'fix', type: 'process', text: '整改' },
        ], edges: [{ from: 'check', to: 'submit', label: '通过' }, { from: 'check', to: 'fix', label: '不通过' }, { from: 'fix', to: 'check' }],
      },
      {
        title: '长中文文本', direction: 'TB',
        nodes: [
          { key: 'start', type: 'start', text: '开始' },
          { key: 'long', type: 'process', text: '长中文文本'.repeat(80) },
          { key: 'end', type: 'end', text: '结束' },
        ], edges: [{ from: 'start', to: 'long' }, { from: 'long', to: 'end' }],
      },
    ]
    for (const [index, value] of cases.entries()) {
      const [spec] = normalizeFlowchartInputs(`SEC-LAYOUT-${String(index)}`, [value])
      expectNoOverlappingNodes(spec!)
    }
  })

  it('长中文留在节点内，回边和标签不穿过节点', () => {
    const [spec] = normalizeFlowchartInputs('SEC-RENDER', [{
      key: 'review-loop', title: '复核闭环', direction: 'TB',
      nodes: [
        { key: 'start', type: 'start', text: '接收县级成果' },
        { key: 'check', type: 'decision', text: '核对地类边界及相关属性是否符合年度变更要求' },
        { key: 'fix', type: 'process', text: '退回县级补充举证并复核' },
        { key: 'end', type: 'end', text: '形成市级核查意见' },
      ],
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'fix', label: '不符合' },
        { from: 'fix', to: 'check', label: '再次提交' },
        { from: 'check', to: 'end', label: '符合' },
      ],
    }])
    const layout = layoutFlowchart(spec!)
    const rendered = renderFlowchartSvg(spec!)
    for (const node of spec!.nodes) {
      const box = layout.positions.get(node.id)!
      const textWidth = Math.max(...node.text.match(/.{1,16}/gsu)!.map(line => Array.from(line).length)) * 14
      const textHeight = node.text.match(/.{1,16}/gsu)!.length * 18
      if (node.type === 'decision') {
        expect(box.width).toBeGreaterThanOrEqual(textWidth * 2 + 32)
        expect(box.height).toBeGreaterThanOrEqual(textHeight * 2 + 24)
      } else {
        expect(box.width).toBeGreaterThanOrEqual(textWidth + 32)
        expect(box.height).toBeGreaterThanOrEqual(textHeight + 24)
      }
    }
    expect(rendered.svg).not.toContain('<line ')
    const routes = [...rendered.svg.matchAll(/<polyline points="([^"]+)"/gu)].map(match => match[1]!)
    expect(routes).toHaveLength(4)
    const points = (value: string) => value.split(' ').map((point) => {
      const [x, y] = point.split(',').map(Number)
      return { x: x!, y: y! }
    })
    const boxes = [...layout.positions.values()]
    const first = points(routes[0]!)
    const origin = { x: boxes[0]!.x + boxes[0]!.width / 2 - first[0]!.x, y: boxes[0]!.y + boxes[0]!.height - first[0]!.y }
    for (const route of routes) {
      const interior = points(route).slice(1, -1)
      for (const point of interior) for (const box of boxes) {
        expect(point.x + origin.x > box.x && point.x + origin.x < box.x + box.width
          && point.y + origin.y > box.y && point.y + origin.y < box.y + box.height).toBe(false)
      }
    }
    const labels = [...rendered.svg.matchAll(/<text x="([^"]+)" y="([^"]+)" text-anchor="[^"]+" font-family="Microsoft YaHei,Arial,sans-serif" font-size="12"[^>]*>([^<]+)<\/text>/gu)]
    expect(labels.map(match => match[3])).toEqual(expect.arrayContaining(['不符合', '再次提交', '符合']))
    for (const label of labels) {
      const x = Number(label[1]) + origin.x
      const y = Number(label[2]) + origin.y
      for (const box of boxes) {
        expect(x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height).toBe(false)
      }
    }
  })
})
