import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  createTestBidRunContext,
  parseWebEvidenceSourcesArtifact,
  S4WebResearchPool,
  webEvidenceChunkIndexPath,
} from '@deepseek-ai/dsh-bid'

describe('S4 Web Research Pool', () => {
  it('同 URL single-flight，并在抓取返回时立即共享可读 Chunk', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-pool-')))
    await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
    const run = createTestBidRunContext()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rawFetch = vi.fn(async (url: string): Promise<ToolExecutionResult> => {
      await gate
      return {
        isError: false,
        value: { url, statusCode: 200, body: { kind: 'text', content: `# 标准\n\n访问控制与审计要求。${'详细控制条款。'.repeat(100)}` }, truncated: false },
        content: [{ type: 'text', text: '原始长正文不应穿透宿主封装。' }],
      }
    })
    const pool = new S4WebResearchPool(workspace, run.commits, rawFetch)
    const exec = { signal: new AbortController().signal } as ToolRunContext

    const first = pool.fetch('https://example.com/standard#one', exec)
    const second = pool.fetch('https://example.com/standard#two', exec)
    expect(rawFetch).toHaveBeenCalledTimes(1)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toMatchObject({ source_ref: firstResult.source_ref, reused: true })
    expect(JSON.stringify(firstResult)).not.toContain('详细控制条款。'.repeat(50))
    expect(pool.listSources(0, 20).sources).toHaveLength(1)

    const chunk = (firstResult.chunks as Array<{ chunk_ref: string }>)[0]!
    expect(pool.readChunk(chunk.chunk_ref, 'child-b')).toMatchObject({ chunk_ref: chunk.chunk_ref, body: expect.stringContaining('访问控制') })
    expect(pool.readChunkRefs('child-a')).toEqual(new Set())
    expect(pool.readChunkRefs('child-b')).toEqual(new Set([chunk.chunk_ref]))
    await pool.fetch('https://example.com/standard', exec)
    expect(pool.stats()).toEqual({ web_sources_fetched: 1, web_sources_reused: 1, duplicate_fetch_avoided: 1, web_chunks_read: 1 })

    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    const source = ledger.sources[0]!
    const indexPath = join(workspace.projectRoot, webEvidenceChunkIndexPath(source.source_id))
    await writeFile(indexPath, '{}', 'utf8')
    const restored = new S4WebResearchPool(workspace, run.commits, rawFetch)
    await restored.restore(ledger.sources)
    await expect(readFile(indexPath, 'utf8')).resolves.toContain(chunk.chunk_ref)

    await unlink(indexPath)
    const restoredWithoutIndex = new S4WebResearchPool(workspace, run.commits, rawFetch)
    await restoredWithoutIndex.restore(ledger.sources)
    await expect(readFile(indexPath, 'utf8')).resolves.toContain(chunk.chunk_ref)
  })
})
