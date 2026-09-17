import { describe, expect, it } from 'vitest'
import { renderFlowchartImage } from '../src/flowchart-image.ts'
import type { FlowchartSpec } from '../src/flowchart.ts'

describe('Flowchart PNG rasterization', () => {
  it('为合法 FlowchartSpec 生成真实 PNG 图像和对应 SVG', async () => {
    const spec: FlowchartSpec = {
      type: 'flowchart',
      schema_version: 1,
      id: 'FLOW-TEST-1',
      key: 'test-flow',
      title: '流程图真实渲染测试',
      direction: 'TB',
      nodes: [
        { id: 'N1', type: 'start', text: '起始节点' },
        { id: 'N2', type: 'process', text: '中间执行步骤' },
        { id: 'N3', type: 'end', text: '结束节点' },
      ],
      edges: [
        { from: 'N1', to: 'N2', label: '进行' },
        { from: 'N2', to: 'N3', label: '完成' },
      ],
    }

    const result = await renderFlowchartImage(spec)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    expect(result.svg).toContain('<svg')
    expect(result.svg).toContain('流程图真实渲染测试')

    // 检查 PNG 格式与尺寸
    expect(result.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const width = result.png.readUInt32BE(16)
    const height = result.png.readUInt32BE(20)
    expect(width).toBe(result.width)
    expect(height).toBe(result.height)
  })
})
