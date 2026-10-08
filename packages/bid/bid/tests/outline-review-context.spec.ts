/** 固定共享职责输入的增长、逐对跨片覆盖及单节点超限拒绝。 */
import { describe, expect, it } from 'vitest'
import { bindOutlineReviewIssue, buildOutlineReviewRequest, buildOutlineReviewRequests,
  OutlineReviewContextTooLargeError, type OutlineReviewContext } from '../src/outline-review-context.ts'

function context(count: number): OutlineReviewContext {
  return { instructions: '逐项核对职责及跨章关系。', coverage: { requirements: [], scoring: [], response_points: [], compliance: [] },
    differences: [], operations: [],
    cards: Array.from({ length: count }, (_, position) => ({ section_id: `S${String(position)}`, research: '研究依据。'.repeat(40) })),
    index: Array.from({ length: count }, (_, position) => ({ id: `S${String(position)}`, position,
      title: `章节${String(position)}`, purpose: '方法及成果责任。'.repeat(20), parent_id: null })),
  }
}

describe('目录审查上下文', () => {
  it('详细分片只装载本片关联与项目原文，同一Chunk去重且按完整内容计入预算', () => {
    const input = context(4)
    input.sources = Array.from({ length: 5 }, (_, position) => ({ key: `C${String(position)}`, file_id: '采购文件',
      name: '采购文件.md', chunk: `chunk_${String(position)}`, text: `原文${String(position)}。`.repeat(100), line_count: 1 }))
    input.projectSourceKeys = ['C0', 'C0']
    input.cards.forEach((card, position) => { card.source_keys = [`C${String(position + 1)}`, `C${String(position + 1)}`] })
    input.index.forEach((item, position) => { item.source_keys = [`C${String(position + 1)}`] })
    const requests = buildOutlineReviewRequests(input, 1_000)
    for (const request of requests) {
      const line = request.prompt.split('\n').find(value => value.startsWith('采购原文：'))!
      const sources = JSON.parse(line.slice('采购原文：'.length)) as Array<{ key: string; text: string }>
      const positions = request.kind === 'sections' ? request.cardPositions : request.sectionPositions
      expect(sources.map(source => source.key)).toEqual(['C0', ...positions.map(position => `C${String(position + 1)}`)])
      expect(sources.every(source => source.text === input.sources!.find(item => item.key === source.key)!.text)).toBe(true)
      expect(request.estimatedInputTokens).toBeLessThanOrEqual(1_000)
    }
  })
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
  it('单章意见整理只校验既定范围的完整预算，无关索引的半预算不能阻断', () => {
    const input: OutlineReviewContext = { instructions: '', coverage: [], differences: [], operations: [],
      cards: [{ section_id: 'A', detail: 'x'.repeat(1_200) }, { section_id: 'B', detail: 'x'.repeat(1_600) }],
      index: [{ position: 0, id: 'A', purpose: 'x'.repeat(100) }, { position: 1, id: 'B', purpose: 'x'.repeat(1_700) }],
    }
    const original = buildOutlineReviewRequests(input, 1_000)
    const owner = original.find(request => request.cardPositions.includes(0))!
    expect(owner.sectionPositions).toEqual([0])
    const consolidation = { ...input, cards: [input.cards[0]!], operations: { opinions: ['y'.repeat(700)] } }
    expect(() => buildOutlineReviewRequests(consolidation, 1_000)).toThrow(OutlineReviewContextTooLargeError)
    const focused = { ...consolidation, index: input.index.filter(item => owner.sectionPositions.includes(item.position)) }
    const request = buildOutlineReviewRequest(focused, 1_000)
    expect(request).toMatchObject({ kind: 'complete', sectionPositions: [0], cardPositions: [0] })
    expect(request.estimatedInputTokens).toBeLessThanOrEqual(1_000)
    expect(request.prompt).toContain(JSON.stringify(focused.operations))
    expect(buildOutlineReviewRequest(focused, request.estimatedInputTokens)).toEqual(request)
    expect(() => buildOutlineReviewRequest(focused, request.estimatedInputTokens - 1)).toThrow(OutlineReviewContextTooLargeError)
  })
  it('全书索引可见时详细分片仍只拥有实际卡片，跨片不接纳粒度意见', () => {
    const input = context(4)
    input.detailInstructions = '核对 Hidden Heading Pressure。'
    input.index.forEach((item) => { item.purpose = '章节职责。' })
    input.cards.forEach((item) => { item.research = '详细研究。'.repeat(400) })
    const requests = buildOutlineReviewRequests(input, 1_000)
    const detail = requests.find(request => request.kind === 'sections')!
    const cross = requests.find(request => request.kind === 'cross_sections')!
    expect(detail.cardPositions.length).toBeLessThan(detail.sectionPositions.length)
    const foreign = detail.sectionPositions.find(position => !detail.cardPositions.includes(position))!
    expect(() => bindOutlineReviewIssue({ section_position: foreign, issue_kind: 'detail', reason: '应拆分。' }, detail, input.index))
      .toThrow('没有该章详细卡片')
    expect(() => bindOutlineReviewIssue({ section_position: detail.cardPositions[0]!, issue_kind: 'detail', reason: '缺少独立任务。' }, detail, input.index))
      .not.toThrow()
    expect(cross.prompt).not.toContain('核对 Hidden Heading Pressure。')
    expect(() => bindOutlineReviewIssue({ section_position: 0, issue_kind: 'detail', reason: '应合并。' }, cross, input.index))
      .toThrow('没有该章详细卡片')
    expect(bindOutlineReviewIssue({ section_position: 0, issue_kind: 'relationship', reason: '职责冲突。' }, cross, input.index))
      .toEqual({ section_id: 'S0', reason: '职责冲突。' })
  })
})
