import { describe, expect, it } from 'vitest'
import {
  normalizeWebEvidenceUrl,
  parseWebEvidenceSourcesArtifact,
  webEvidenceContentSha256,
  webEvidenceSourceId,
} from '@deepseek-ai/dsh-bid'

const source = {
  source_id: 'WEB-0123456789abcdef',
  search_call_id: 'search-1',
  fetch_call_id: 'fetch-1',
  search_result_seq: 2,
  fetch_call_seq: 3,
  fetch_result_seq: 4,
  queries: ['访问控制官方标准'],
  discovered_url: 'https://official.example/standard#result',
  requested_url: 'https://official.example/standard',
  final_url: 'https://official.example/standard',
  status_code: 200,
  truncated: false,
  fetched_at: '2026-08-31T02:00:00.000Z',
  content_sha256: 'a'.repeat(64),
  snapshot_path: 'analysis/web-sources/WEB-0123456789abcdef.md',
}

const ledger = (candidate: unknown = source) => ({ schema_version: 1, stage: 'evidence_mapping', sources: candidate === undefined ? [] : [candidate] })

describe('Web evidence source Artifact schema', () => {
  it('accepts an empty ledger and one complete verified source', () => {
    expect(parseWebEvidenceSourcesArtifact({ schema_version: 1, stage: 'evidence_mapping', sources: [] }).sources).toEqual([])
    expect(parseWebEvidenceSourcesArtifact(ledger()).sources).toHaveLength(1)
  })

  it.each([
    ['schema version', { ...ledger(), schema_version: 2 }],
    ['stage', { ...ledger(), stage: 'outline_generation' }],
    ['source id', ledger({ ...source, source_id: '' })],
    ['search call id', ledger({ ...source, search_call_id: '' })],
    ['fetch call id', ledger({ ...source, fetch_call_id: '' })],
    ['queries', ledger({ ...source, queries: [] })],
    ['URL protocol', ledger({ ...source, requested_url: 'file:///tmp/source' })],
    ['status code', ledger({ ...source, status_code: 200.5 })],
    ['snapshot path', ledger({ ...source, snapshot_path: '../escape.md' })],
    ['hash', ledger({ ...source, content_sha256: 'invalid' })],
    ['ordering', ledger({ ...source, fetch_call_seq: 1 })],
    ['URL association', ledger({ ...source, requested_url: 'https://other.example/source' })],
    ['extra field', ledger({ ...source, unexpected: true })],
  ])('rejects invalid %s', (_name, value) => {
    expect(() => parseWebEvidenceSourcesArtifact(value)).toThrow()
  })

  it('normalizes fragments and default ports without weakening path or query matching', () => {
    expect(normalizeWebEvidenceUrl('https://example.com:443/path?q=1#section')).toBe('https://example.com/path?q=1')
    expect(normalizeWebEvidenceUrl('ftp://example.com/path')).toBeUndefined()
  })

  it('derives deterministic content hashes and filename-safe source ids', () => {
    const hash = webEvidenceContentSha256('bounded result')
    expect(hash).toMatch(/^[a-f0-9]{64}$/u)
    expect(webEvidenceSourceId('fetch-1', 'https://example.com/', hash)).toMatch(/^WEB-[a-f0-9]{16}$/u)
    expect(webEvidenceSourceId('fetch-1', 'https://example.com/', hash)).toBe(webEvidenceSourceId('fetch-1', 'https://example.com/', hash))
  })
})
