import { describe, expect, it } from 'vitest'
import { parseChapterMetadata, parseChapterWritingManifest } from '@deepseek-ai/dsh-bid'

const external = {
  title: '官方标准',
  url: 'https://official.example/standard',
  publisher: '官方机构',
  retrieved_at: '2026-08-31T00:00:00.000Z',
  retrieval_method: 'web_search' as const,
  usage: 'reference' as const,
  summary: '标准正文摘要。',
  supports: '支持当前章节的公开技术方法。',
}

function metadata(): Record<string, unknown> {
  return {
    section_id: 'SEC-1',
    covered_must_answer: ['回答架构设计'],
    evidence_used: [],
    additional_materials: [],
    external_evidence_used: [external],
    additional_external_materials: [],
    unresolved_topics: [],
  }
}

describe('chapter-writing schema v2', () => {
  it('parses all four evidence arrays', () => {
    expect(parseChapterMetadata(metadata())).toMatchObject({ external_evidence_used: [external] })
  })

  it.each([
    ['missing field', () => { const value = metadata(); delete value.unresolved_topics; return value }],
    ['extra field', () => ({ ...metadata(), unexpected: true })],
    ['invalid URL', () => ({ ...metadata(), external_evidence_used: [{ ...external, url: 'file:///secret' }] })],
    ['invalid usage', () => ({ ...metadata(), external_evidence_used: [{ ...external, usage: 'reuse' }] })],
    ['duplicate URL across arrays', () => ({ ...metadata(), additional_external_materials: [{ ...external, url: 'https://OFFICIAL.example:443/standard#fragment' }] })],
  ])('rejects %s', (_name, value) => {
    expect(() => parseChapterMetadata(value())).toThrow()
  })

  it('rejects a stale manifest schema version', () => {
    expect(() => parseChapterWritingManifest({
      schema_version: 1,
      scope: 'technical_bid',
      confirmed_outline_sha256: '0'.repeat(64),
      chapters: [],
    })).toThrow()
  })
})
