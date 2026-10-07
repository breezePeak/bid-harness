/** 固定共享职责输入的增长、逐对跨片覆盖及单节点超限拒绝。 */
import { describe, expect, it } from 'vitest'
import { buildOutlineReviewRequests, OutlineReviewContextTooLargeError, type OutlineReviewContext } from '../src/outline-review-context.ts'

function context(count: number): OutlineReviewContext {
  return { instructions: '逐项核对职责及跨章关系。', coverage: { requirements: [], scoring: [], response_points: [], compliance: [] },
    differences: [], operations: [],
    cards: Array.from({ length: count }, (_, position) => ({ section_id: `S${String(position)}`, research: '研究依据。'.repeat(40) })),
    index: Array.from({ length: count }, (_, position) => ({ id: `S${String(position)}`, position,
      title: `章节${String(position)}`, purpose: '方法及成果责任。'.repeat(20), parent_id: null })),
  }
}

describe('目录审查上下文', () => {
  it('同级索引共享后小目录请求大小随节点数线性增长', () => {
    const small = buildOutlineReviewRequests(context(8), 12_000)[0]!
    const large = buildOutlineReviewRequests(context(16), 12_000)[0]!
    expect(large.estimatedInputTokens).toBeLessThan(small.estimatedInputTokens * 2.1)
    expect(large.kind).toBe('complete')
  })
  it('分片输入包含尾节点、每对跨片节点且全部请求在预算内', () => {
    const input = context(32)
    const requests = buildOutlineReviewRequests(input, 800)
    expect(requests.every(request => request.estimatedInputTokens <= 800)).toBe(true)
    for (let left = 0; left < 32; left++) for (let right = left; right < 32; right++) {
      expect(requests.some(request => request.kind === 'cross_sections'
        && request.sectionPositions.includes(left) && request.sectionPositions.includes(right))).toBe(true)
    }
    const cards = requests.flatMap(request => JSON.parse(request.prompt.split('\n').find(line => line.startsWith('Structure Review Cards：'))!
      .slice('Structure Review Cards：'.length)) as Array<{ section_id: string }>)
    expect(cards.map(card => card.section_id).sort()).toEqual(input.cards.map(card => card.section_id).sort())
  })
  it('超大单叶明确拒绝且不截断研究依据', () => {
    const input = context(1)
    input.cards[0]!.research = '巨大节点'.repeat(10_000)
    expect(() => buildOutlineReviewRequests(input, 800)).toThrow(OutlineReviewContextTooLargeError)
    expect(input.cards[0]!.research).toBe('巨大节点'.repeat(10_000))
  })
})
