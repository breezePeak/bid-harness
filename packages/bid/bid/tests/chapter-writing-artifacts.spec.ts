import { describe, expect, it } from 'vitest'
import { parseChapterCandidate, parseChapterMetadata, parseChapterWritingManifest } from '@deepseek-ai/dsh-bid'

const web = {
  source_id: 'WEB-aaaaaaaaaaaaaaaa',
  snapshot_path: 'analysis/web-sources/WEB-aaaaaaaaaaaaaaaa.md',
  usage: 'reference' as const,
  summary: '标准正文摘要。',
  supports: '支持当前章节的公开技术方法。',
}

function metadata(): Record<string, unknown> {
  return {
    section_id: 'SEC-1',
    covered_must_answer: ['回答架构设计'],
    covered_scoring_response_point_ids: [],
    covered_scoring_response_points: [],
    local_materials_used: [],
    web_materials_used: [web],
    unresolved_topics: [],
    handoff: { section_id: 'SEC-1', decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] },
  }
}

describe('chapter-writing schema v5', () => {
  it('parses durable local and Web material identities', () => {
    expect(parseChapterMetadata(metadata())).toMatchObject({ web_materials_used: [web] })
  })

  it('accepts transient Web URLs only in the Child candidate', () => {
    const additional = [{ url: 'https://example.com/standard', usage: 'reference', summary: '补充资料', supports: '支持公开技术要求' }]
    expect(parseChapterCandidate({ section_id: 'SEC-1', markdown: '# 章节', metadata: { ...metadata(), additional_web_materials: additional } })
      .metadata.additional_web_materials).toEqual(additional)
    expect(() => parseChapterMetadata({ ...metadata(), additional_web_materials: additional })).toThrow()
  })

  it.each([
    ['missing field', () => { const value = metadata(); delete value.unresolved_topics; return value }],
    ['extra field', () => ({ ...metadata(), unexpected: true })],
    ['invalid snapshot path', () => ({ ...metadata(), web_materials_used: [{ ...web, snapshot_path: 'analysis/web-sources/WEB-bbbbbbbbbbbbbbbb.md' }] })],
    ['invalid Web usage', () => ({ ...metadata(), web_materials_used: [{ ...web, usage: 'reuse' }] })],
    ['duplicate Web source', () => ({ ...metadata(), web_materials_used: [web, web] })],
    ['reference reuse', () => ({ ...metadata(), local_materials_used: [{ source_kind: 'reference', file_id: 'REF', chunk: 'chunk_0001', usage: 'reuse', summary: '资料' }] })],
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
