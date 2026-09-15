import { describe, expect, it } from 'vitest'
import { layoutFlowchart, normalizeFlowchartInputs, renderFlowchartSvg, resolveFlowchartAnchors, validateFlowchartAnchors, validateFlowchartSpec, type FlowchartDraft } from '../src/flowchart.ts'

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

describe('flowchart contract', () => {
  it('由 Host 分配流程图和节点身份，并生成可复用 SVG', () => {
    const [spec] = normalizeFlowchartInputs('SEC-IMPLEMENT', [draft])
    expect(spec.id).toBe('FLOW-SEC-IMPLEMENT-1')
    expect(spec.nodes.map(node => node.id)).toEqual(['N1', 'N2', 'N3', 'N4'])
    expect(validateFlowchartSpec(spec)).toEqual([])
    const rendered = renderFlowchartSvg(spec)
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
})
