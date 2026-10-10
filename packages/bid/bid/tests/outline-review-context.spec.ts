/** 固定共享职责输入的增长、逐对跨片覆盖及单节点无损分组。 */
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
  it('超目标大章独立审核，普通章节仍按目标分片且全部原文保留', () => {
    const input = context(4)
    input.index.forEach((item) => { item.purpose = '章节职责。' })
    input.cards[0]!.research = '完整章节研究。'.repeat(800)
    input.sources = [{ key: 'C0', file_id: '采购文件', name: '采购文件.md', chunk: 'chunk_0001',
      text: '决定性原文，不可截断。'.repeat(100), line_count: 1 }]
    input.cards[0]!.source_keys = ['C0']
    input.index[0]!.source_keys = ['C0']
    const requests = buildOutlineReviewRequests(input, 5_000, 800)
    const large = requests.find(request => request.cardPositions.includes(0))!
    expect(large.cardPositions).toEqual([0])
    expect(large.estimatedInputTokens).toBeGreaterThan(800)
    expect(large.prompt).toContain(input.sources[0]!.text)
    expect(requests.filter(request => request !== large).every(request => request.estimatedInputTokens <= 800)).toBe(true)
    expect(requests.flatMap(request => request.cardPositions).sort()).toEqual([0, 1, 2, 3])
    expect(requests.every(request => request.estimatedInputTokens <= 5_000)).toBe(true)
    expect(buildOutlineReviewRequests(input, large.estimatedInputTokens, 800)).toEqual(requests)
    expect(buildOutlineReviewRequests(input, large.estimatedInputTokens - 1, 800)
      .every(request => request.estimatedInputTokens < large.estimatedInputTokens)).toBe(true)
    expect(buildOutlineReviewRequests(input, 800, 5_000).every(request => request.estimatedInputTokens <= 800)).toBe(true)
  })
  it('共享原文超目标保留完整请求，真实超限才按依据分段', () => {
    const input = context(3)
    input.sources = [{ key: 'C0', file_id: '采购文件', name: '采购文件.md', chunk: 'chunk_0001',
      text: '完整采购原文。'.repeat(600), line_count: 1 }]
    input.projectSourceKeys = ['C0']
    input.index.forEach((item) => { item.purpose = '职责索引。'.repeat(100) })
    const requests = buildOutlineReviewRequests(input, 5_000, 800)
    expect(requests.flatMap(request => request.cardPositions).sort()).toEqual([0, 1, 2])
    for (let left = 0; left < 3; left++) for (let right = left; right < 3; right++) {
      expect(requests.some(request => request.kind === 'cross_sections'
        && request.sectionPositions.includes(left) && request.sectionPositions.includes(right))).toBe(true)
    }
    expect(requests.every(request => request.prompt.includes(input.sources![0]!.text))).toBe(true)
    const hardLimit = Math.max(...requests.map(request => request.estimatedInputTokens))
    expect(buildOutlineReviewRequests(input, hardLimit, 800)).toEqual(requests)
    const partitioned = buildOutlineReviewRequests(input, hardLimit - 1, 800)
    expect(partitioned.every(request => request.estimatedInputTokens < hardLimit)).toBe(true)
    expect(partitioned.some(request => request.evidenceParts !== undefined)).toBe(true)
  })
  it('公共原文占满分片目标时全书索引仍共享，不退化为逐章配对', () => {
    const input = context(32)
    input.index.forEach((item) => { item.purpose = '章节职责。' })
    input.sources = [{ key: 'C0', file_id: '采购文件', name: '采购文件.md', chunk: 'chunk_0001',
      text: '采购原文完整保留。'.repeat(6_000), line_count: 1 }]
    input.projectSourceKeys = ['C0']
    const requests = buildOutlineReviewRequests(input, 30_000, 12_000)
    const cross = requests.filter(request => request.kind === 'cross_sections')
    expect(cross).toHaveLength(1)
    expect(cross[0]!.sectionPositions).toEqual(input.index.map(item => item.position))
    expect(requests.filter(request => request.kind === 'sections')).toHaveLength(32)
    expect(requests.flatMap(request => request.cardPositions).sort((left, right) => left - right))
      .toEqual(input.index.map(item => item.position))
    expect(requests.every(request => request.estimatedInputTokens <= 30_000)).toBe(true)
  })
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
  it('超大单叶无损分段，极小预算明确拒绝且不修改输入', () => {
    const input = context(1)
    input.cards[0]!.research = '巨大节点'.repeat(10_000)
    const requests = buildOutlineReviewRequests(input, 800)
    const parts = requests.flatMap(request => request.evidenceParts ?? [])
      .filter(part => part.path.join('.') === 'cards.0.research')
    expect(parts.map(part => part.value).join('')).toBe(input.cards[0]!.research)
    let offset = 0
    for (const part of parts) {
      expect(part).toMatchObject({ start: offset, end: offset + String(part.value).length, total: 40_000 })
      offset += String(part.value).length
    }
    expect(requests.every(request => request.estimatedInputTokens <= 800)).toBe(true)
    expect(() => buildOutlineReviewRequests(input, 1)).toThrow(OutlineReviewContextTooLargeError)
    expect(input.cards[0]!.research).toBe('巨大节点'.repeat(10_000))
  })
  it('按章节筛选业务、diff 和 operations，带来源偏移的采购原文覆盖尾部', () => {
    const input = context(2)
    const source = { key: 'C0', file_id: '采购文件', name: '采购文件.md', chunk: 'chunk_0001',
      text: '1: 必须保留完整技术要求😀。'.repeat(2_000) + '2: 尾部验收。', line_count: 2 }
    input.sources = [source]
    input.cards[0]!.source_keys = ['C0']
    input.cards[0]!.requirements = [{ id: 'R0', raw_text: '本章技术要求。' }]
    input.cards[1]!.requirements = [{ id: 'R1', raw_text: '其他业务要求。' }]
    input.coverage = { requirements: [input.cards[0]!.requirements, input.cards[1]!.requirements].flat() }
    input.differences = [{ section_id: 'S0', change: '本章改动' }, { section_id: 'S1', change: '其他改动' }]
    input.operations = [{ section_ids: ['S0'], operations: ['本章操作'] }, { section_ids: ['S1'], operations: ['其他操作'] }]
    const requests = buildOutlineReviewRequests(input, 800)
    const details = requests.filter(request => request.cardPositions.includes(0))
    expect(details.every(request => !request.prompt.includes('其他业务要求') && !request.prompt.includes('其他改动')
      && !request.prompt.includes('其他操作'))).toBe(true)
    const parts = details.flatMap(request => request.evidenceParts ?? []).filter(part => part.source?.key === source.key)
    expect(parts.map(part => part.value).join('')).toBe(source.text)
    expect(parts[0]?.start).toBe(0)
    expect(parts.at(-1)?.end).toBe(source.text.length)
    expect(parts.every(part => part.source?.file_id === source.file_id && part.total === source.text.length)).toBe(true)
    for (let position = 1; position < parts.length; position++) expect(parts[position]!.start).toBe(parts[position - 1]!.end)
    expect(requests.some(request => request.kind === 'cross_sections' && request.sectionPositions.length === 2)).toBe(true)
  })
  it('父节点独有业务依据及来源完整提供，其他叶节详情不能替代', () => {
    const input = context(2)
    input.cards = [input.cards[1]!]
    input.index[0]!.coverage_ids = ['PARENT-REQ']
    input.index[0]!.source_keys = ['parent-source']
    input.sources = [{ key: 'parent-source', file_id: '采购文件', name: '采购文件.md', chunk: 'parent.md',
      line_count: 1, text: '父节点原文。'.repeat(3_000) }]
    input.coverage = { requirements: [{ id: 'PARENT-REQ', raw_text: '父节点业务原文' }] }
    const requests = buildOutlineReviewRequests(input, 800)
    const parent = requests.filter(request => request.kind === 'cross_sections' && request.sectionPositions.join() === '0')
    expect(parent.some(request => request.prompt.includes('父节点业务原文'))).toBe(true)
    expect(parent.flatMap(request => request.evidenceParts ?? []).filter(part => part.source?.key === 'parent-source')
      .map(part => part.value).join('')).toBe(input.sources[0]!.text)
    expect(parent.every(request => request.cardPositions.length === 0 && request.estimatedInputTokens <= 800)).toBe(true)
  })
  it('单章意见整理只校验既定范围的完整预算，无关索引的半预算不能阻断', () => {
    const input: OutlineReviewContext = { instructions: '', coverage: [], differences: [], operations: [],
      cards: [{ section_id: 'A', detail: 'x'.repeat(1_200) }, { section_id: 'B', detail: 'x'.repeat(1_600) }],
      index: [{ position: 0, id: 'A', purpose: 'x'.repeat(100) }, { position: 1, id: 'B', purpose: 'x'.repeat(1_700) }],
    }
    const original = buildOutlineReviewRequests(input, 1_000)
    const owner = original.find(request => request.cardPositions.includes(0))!
    expect(owner.sectionPositions).toEqual([0])
    expect(owner.prompt).toContain('本片职责索引是局部视图')
    expect(owner.prompt).not.toContain('全书职责索引：')
    expect(original.find(request => request.sectionPositions.length === input.index.length)?.prompt)
      .not.toContain('本片职责索引是局部视图')
    const consolidation = { ...input, cards: [input.cards[0]!], operations: { opinions: ['y'.repeat(700)] } }
    expect(() => buildOutlineReviewRequest(consolidation, 1_000)).toThrow(OutlineReviewContextTooLargeError)
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
