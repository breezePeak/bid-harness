import { describe, expect, it } from 'vitest'
import {
  buildWebEvidenceChunkIndex,
  WEB_EVIDENCE_CHUNK_MAX_CHARS,
  webEvidenceChunkIndexMatches,
  webEvidenceContentSha256,
  webEvidenceSourceId,
} from '@deepseek-ai/dsh-bid'

describe('Web Evidence Markdown chunks', () => {
  it('按标题和完整块稳定分组，不拆分列表、表格或代码块', () => {
    const paragraph = '技术控制说明。'.repeat(500)
    const content = [
      '# 总则', paragraph, paragraph,
      '## 控制项', '- 身份鉴别\n- 权限复核',
      '| 字段 | 要求 |\n| --- | --- |\n| 账号 | 唯一 |',
      '```ts\nconst enabled = true\n```',
    ].join('\n\n')
    const url = 'https://example.com/standard'
    const hash = webEvidenceContentSha256(content)
    const source = {
      source_id: webEvidenceSourceId(url, hash), requested_url: url, final_url: url,
      status_code: 200, truncated: false, fetched_at: '2026-09-14T00:00:00.000Z', content_sha256: hash,
      snapshot_path: `analysis/web-sources/${webEvidenceSourceId(url, hash)}.md`,
    }

    const index = buildWebEvidenceChunkIndex(source, content)
    expect(buildWebEvidenceChunkIndex(source, content)).toEqual(index)
    expect(index.chunks.map(chunk => chunk.chunk_ref)).toEqual(index.chunks.map((_, position) =>
      `W:${source.source_id}:C${String(position + 1).padStart(4, '0')}`))
    expect(index.headings.map(heading => heading.heading_path)).toEqual([['总则'], ['总则', '控制项']])
    expect(webEvidenceChunkIndexMatches(index, source, content)).toBe(true)
    for (const block of ['- 身份鉴别\n- 权限复核', '| 字段 | 要求 |', '```ts\nconst enabled = true\n```']) {
      expect(index.chunks.filter(chunk => content.slice(chunk.start_offset, chunk.end_offset).includes(block))).toHaveLength(1)
    }
  })

  it('对超过硬上限的单一 Markdown Block 确定性切分', () => {
    const content = `# 超长正文\n\n${'超长内容。'.repeat(WEB_EVIDENCE_CHUNK_MAX_CHARS)}`
    const hash = webEvidenceContentSha256(content)
    const url = 'https://example.com/oversized'
    const source = {
      source_id: webEvidenceSourceId(url, hash), requested_url: url, final_url: url,
      status_code: 200, truncated: false, fetched_at: '2026-09-14T00:00:00.000Z', content_sha256: hash,
      snapshot_path: `analysis/web-sources/${webEvidenceSourceId(url, hash)}.md`,
    }
    const index = buildWebEvidenceChunkIndex(source, content)
    expect(index.chunks.length).toBeGreaterThan(1)
    expect(Math.max(...index.chunks.map(chunk => chunk.char_count))).toBeLessThanOrEqual(WEB_EVIDENCE_CHUNK_MAX_CHARS)
    expect(index.chunks.map(chunk => content.slice(chunk.start_offset, chunk.end_offset)).join('')).toBe(content)
    expect(buildWebEvidenceChunkIndex(source, content)).toEqual(index)
  })
})
