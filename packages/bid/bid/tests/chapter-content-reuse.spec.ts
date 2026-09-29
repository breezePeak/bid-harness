import { describe, expect, it } from 'vitest'
import { assignChapterContentBlocks, indexChapterContentBlocks } from '../src/chapter-content-reuse.ts'

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
})
