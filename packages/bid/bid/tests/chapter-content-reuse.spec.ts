import { describe, expect, it } from 'vitest'
import { assignChapterContentBlocks, indexChapterContentBlocks, selectOriginalChapterContent } from '../src/chapter-content-reuse.ts'
import { normalizeFlowchartInputs } from '../src/flowchart.ts'

describe('chapter content reuse', () => {
  const source = '# 流程\n\n原文说明。\n\n| 环节 | 要求 |\n| --- | --- |\n| 验收 | 留痕 |\n\n```ts\nconst id = 1\n```\n\n{{flowchart:review}}\n'

  it('preserves complete source blocks and distributes a split without rewriting', () => {
    const blocks = indexChapterContentBlocks('SEC-001', source)
    expect(blocks.map(block => block.markdown).join('')).toBe(source)
    expect(blocks.map(block => block.type)).toContain('table')
    expect(blocks.map(block => block.type)).toContain('code')
    const assignments = blocks.map((block, index) => ({
      block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: [index < 2 ? 'SEC-002' : 'SEC-003'], disposition: 'move' as const,
    }))
    const result = assignChapterContentBlocks(blocks, assignments, new Set(['SEC-002', 'SEC-003']), false)
    expect([...result.markdownBySectionId.values()].join('')).toBe(source)
    expect(result.markdownBySectionId.get('SEC-003')).toContain('{{flowchart:review}}')
    expect(result.deletedBlockIds).toEqual([])
  })

  it('rejects omission, stale source, implicit sharing, and unauthorized deletion', () => {
    const [block] = indexChapterContentBlocks('SEC-001', '原文。\n')
    if (block === undefined) throw new Error('missing test block')
    const allocation = { block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: ['SEC-002'], disposition: 'move' as const }
    const targets = new Set(['SEC-002', 'SEC-003'])
    expect(() => assignChapterContentBlocks([block], [], targets, false)).toThrow('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
    expect(() => assignChapterContentBlocks([block], [{ ...allocation, source_sha256: '0'.repeat(64) }], targets, false))
      .toThrow('BID_CHAPTER_REUSE_BLOCK_IDENTITY_INVALID')
    expect(() => assignChapterContentBlocks([block], [{ ...allocation, target_section_ids: ['SEC-002', 'SEC-003'] }], targets, false))
      .toThrow('BID_CHAPTER_REUSE_ALLOCATION_INVALID')
    expect(() => assignChapterContentBlocks([block], [{ ...allocation, target_section_ids: [], disposition: 'delete' }], targets, false))
      .toThrow('BID_CHAPTER_REUSE_DELETION_UNAUTHORIZED')
  })

  it('原正式正文与流程图保持只读，候选新增段落和图形可以整改', () => {
    const original = '原文说明。\n\n表1 校验产物\n\n| 环节 | 要求 |\n| --- | --- |\n| 验收 | 留痕 |\n\n{{flowchart:original}}'
    const charts = normalizeFlowchartInputs('old', [{ key: 'original', title: '原流程', direction: 'TB',
      nodes: [{ key: 'start', type: 'start', text: '开始' }, { key: 'end', type: 'end', text: '完成' }],
      edges: [{ from: 'start', to: 'end' }] }])
    const added = normalizeFlowchartInputs('new', [{ ...charts[0]!, key: 'added', title: '新增流程' }])
    const candidate = '# 新子章\n\n' + original + '\n\n需要整改的候选新增段落。\n\n{{flowchart:added}}'
    const preserved = selectOriginalChapterContent(candidate, [...normalizeFlowchartInputs('new', charts), ...added],
      [{ markdown: '# 原章\n\n' + original, flowcharts: charts }])
    expect(preserved.markdown).toBe(original)
    expect(preserved.flowcharts.map(chart => chart.key)).toEqual(['original'])
    expect(selectOriginalChapterContent('只有新增正文。', added, [{ markdown: original, flowcharts: charts }]))
      .toEqual({ markdown: '', flowcharts: [] })
  })

  it('原文与新增文字处于同一段落时仍逐字冻结原块，并按候选位置保留次序', () => {
    const original = '原始受理说明。\n\n原始交付说明。'
    const candidate = '新增引导：原始交付说明。新增归档条件。\n\n原始受理说明。新增核验条件。'
    expect(selectOriginalChapterContent(candidate, [], [{ markdown: original, flowcharts: [] }]))
      .toEqual({ markdown: '原始交付说明。\n\n原始受理说明。', flowcharts: [] })
    expect(selectOriginalChapterContent('原始受理说明已改写。', [], [{ markdown: original, flowcharts: [] }]))
      .toEqual({ markdown: '', flowcharts: [] })
  })

  it('修复迁移时完整登记跨源章原文副本，统一归属后只输出一次且不删除独有内容', () => {
    const blocks = [
      ...indexChapterContentBlocks('parent', '完整原文。\n\n{{flowchart:original}}\n'),
      ...indexChapterContentBlocks('child', '完整原文。\n\n{{flowchart:original}}\n\n候选新增说明。\n'),
    ]
    const originals = new Map([['完整原文。', 1], ['{{flowchart:original}}', 1]])
    const assignments = blocks.map(block => ({ block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: ['target'], disposition: 'move' as const }))
    const targets = new Set(['target', 'other'])
    const result = assignChapterContentBlocks(blocks, assignments, targets, false, originals)
    expect(result.markdownBySectionId.get('target')).toBe('完整原文。\n\n{{flowchart:original}}\n\n\n候选新增说明。\n')
    expect(result.deletedBlockIds).toEqual([])
    expect(assignChapterContentBlocks(blocks, assignments, targets, false).markdownBySectionId.get('target')
      ?.split('完整原文。')).toHaveLength(3)
    expect(() => assignChapterContentBlocks(blocks, assignments.slice(1), targets, false, originals))
      .toThrow('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
    expect(() => assignChapterContentBlocks(blocks, assignments.map((assignment, index) => index === 2
      ? { ...assignment, target_section_ids: ['other'] } : assignment), targets, false, originals))
      .toThrow('BID_CHAPTER_REUSE_LINKED_BLOCK_TARGET_MISMATCH')
    expect(() => assignChapterContentBlocks(blocks, assignments.map(assignment => ({ ...assignment,
      target_section_ids: ['target', 'other'], disposition: 'share' as const })), targets, false, originals))
      .toThrow('BID_CHAPTER_REUSE_ORIGINAL_TARGET_NOT_UNIQUE')
  })

  it('keeps captions with complete tables and flow references with their anchors, in original order', () => {
    const markdown = '引导段。\n\n表1 校验产物\n\n| 环节 | 产物 |\n| --- | --- |\n| 校验 | 报告 |\n\n{{flowchart:review}}\n\n见 {{flow_ref:review}}。\n'
    const blocks = indexChapterContentBlocks('SEC-001', markdown)
    const assignments = blocks.map(block => ({ block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: ['SEC-002'], disposition: 'move' as const }))
    const targets = new Set(['SEC-002', 'SEC-003'])
    for (const index of [0, 2, 4]) {
      const separated = assignments.map((assignment, position) => position === index
        ? { ...assignment, target_section_ids: ['SEC-003'] } : assignment)
      expect(() => assignChapterContentBlocks(blocks, separated, targets, false))
        .toThrow('BID_CHAPTER_REUSE_LINKED_BLOCK_TARGET_MISMATCH')
    }
    expect(assignChapterContentBlocks(blocks, [...assignments].reverse(), targets, false).markdownBySectionId.get('SEC-002'))
      .toBe(markdown)
  })

  it('不同源章和去重后的相邻块仍保留 Markdown 段落与标题边界', () => {
    const blocks = [
      ...indexChapterContentBlocks('parent', '原文说明。'),
      ...indexChapterContentBlocks('child', '原文说明。\n\n# 子章\n\n新增说明。'),
      ...indexChapterContentBlocks('other', '| 内容 |\n| --- |\n| 记录 |'),
      ...indexChapterContentBlocks('last', '# 另一子章'),
    ]
    const assignments = blocks.map(block => ({ block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: ['target'], disposition: 'move' as const }))
    const markdown = assignChapterContentBlocks(blocks, assignments, new Set(['target']), false,
      new Map([['原文说明。', 1]])).markdownBySectionId.get('target')!
    expect(markdown.split('原文说明。')).toHaveLength(2)
    expect(indexChapterContentBlocks('target', markdown).map(block => block.type))
      .toEqual(['paragraph', 'heading', 'paragraph', 'table', 'heading'])
    expect(markdown).toContain('| 记录 |\n\n# 另一子章')
  })

  it('粘连和同源重复的正式原块恢复独立身份后统一归属，独有新增内容逐字保留', () => {
    const original = '完整原文。\n\n表 校验记录\n\n| 内容 |\n| --- |\n| 记录 |'
    const originals = new Set(indexChapterContentBlocks('original', original).map(block => block.markdown.trim()))
    const counts = new Map([...originals].map(text => [text, 1]))
    const candidate = original + '# 错误粘连标题\n\n' + original + '\n\n新增说明。'
    const blocks = indexChapterContentBlocks('child', candidate, originals)
    expect(blocks.map(block => block.markdown).join('')).toBe(candidate)
    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'paragraph', 'table', 'heading', 'paragraph', 'paragraph', 'table', 'paragraph'])
    const assignments = blocks.map(block => ({ block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256,
      target_section_ids: ['target'], disposition: 'move' as const }))
    const targets = new Set(['target', 'other'])
    const markdown = assignChapterContentBlocks(blocks, assignments, targets, false, counts).markdownBySectionId.get('target')!
    for (const text of originals) expect(markdown.split(text)).toHaveLength(2)
    expect(markdown).toContain('| 记录 |\n\n# 错误粘连标题')
    expect(markdown).toContain('新增说明。')
    const repeated = assignChapterContentBlocks(blocks, assignments, targets, false,
      new Map([...originals].map(text => [text, 2]))).markdownBySectionId.get('target')!
    for (const text of originals) expect(repeated.split(text)).toHaveLength(3)
    expect(() => assignChapterContentBlocks(blocks, assignments.map((assignment, index) => index === 4
      ? { ...assignment, target_section_ids: ['other'] } : assignment), targets, false, counts))
      .toThrow('BID_CHAPTER_REUSE_LINKED_BLOCK_TARGET_MISMATCH')
  })
})
