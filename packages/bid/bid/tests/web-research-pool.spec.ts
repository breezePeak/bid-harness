/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers return any. */
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, WebError } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webTools from '@deepseek-ai/dsh-tool-web'
import {
  BidWorkspace,
  createTestBidRunContext,
  parseWebEvidenceSourcesArtifact,
  S4WebResearchPool,
  webEvidenceChunkIndexPath,
} from '@deepseek-ai/dsh-bid'

describe('S4 Web Research Pool', () => {
  it('生产 Fetch 成功但正文为空时拒绝保存，不伪装为 Provider 暂态错误', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(WebRuntime)
    await ctx.plugin(webTools)
    ctx.effect(() => ctx.web.registerFetchProvider({ id: 'empty-fetch', available: () => true,
      fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: '   ' }, truncated: false }) }))
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-pool-empty-')))
    const pool = new S4WebResearchPool(workspace, createTestBidRunContext().commits, (url, exec) => ctx.tools.execute({
      callId: CallId('parent-empty-fetch'), name: 'web_fetch', arguments: { url }, signal: exec.signal,
    }))
    try {
      await expect(pool.fetch('https://example.com/empty', { signal: new AbortController().signal } as ToolRunContext))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(pool.snapshots()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
  it.each([
    ['WEB_PROVIDER_RATE_LIMITED', 429, '12'], ['WEB_PROVIDER_ERROR', 503, undefined],
    ['WEB_FETCH_TIMEOUT', undefined, undefined], ['WEB_PROVIDER_AUTHENTICATION_FAILED', 401, undefined],
    ['WEB_PROVIDER_QUOTA_EXCEEDED', 429, undefined],
  ] as const)('生产 Web Tool 与 Pool 双层执行保留 %s 原始字段', async (code, statusCode, retryAfter) => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(WebRuntime)
    await ctx.plugin(webTools)
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-pool-errors-')))
    const original = new WebError('固定 Provider 原因', code, {
      ...(statusCode === undefined ? {} : { statusCode }), ...(retryAfter === undefined ? {} : { retryAfter }),
    })
    ctx.effect(() => ctx.web.registerFetchProvider({ id: 'fake-fetch', available: () => true, fetch: async () => { throw original } }))
    const observed: ToolExecutionResult[] = []
    ctx.on('tools/result', (_exec, result) => { observed.push(result) })
    let caught: unknown
    const pool = new S4WebResearchPool(workspace, createTestBidRunContext().commits, (url, exec) => ctx.tools.execute({
      callId: CallId('parent-fetch'), name: 'web_fetch', arguments: { url }, signal: exec.signal, parent: exec.token,
    }))
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'pooled_fetch', description: '共享研究来源。', parameters: { url: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute(args, exec) {
        try { return await pool.fetch(args.url, exec) } catch (error) { caught = error; throw error }
      },
    })))
    try {
      const result = await ctx.tools.execute({ callId: CallId('child-fetch'), name: 'pooled_fetch', arguments: { url: 'https://example.com/standard' }, signal: new AbortController().signal })
      expect(result).toMatchObject({ isError: true, error: { info: {
        code, ...(statusCode === undefined ? {} : { statusCode }), ...(retryAfter === undefined ? {} : { retryAfter }),
      } } })
      expect(observed).toHaveLength(2)
      expect(caught).toMatchObject({ cause: { message: '固定 Provider 原因', info: { code } } })
      expect(pool.snapshots()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

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

  it('不同 requested URL 重定向到同一 Source 时在提交临界区只登记一次', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-web-pool-redirect-')))
    await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
    const run = createTestBidRunContext()
    const rawFetch = vi.fn(async (_url: string): Promise<ToolExecutionResult> => ({
      isError: false,
      value: { url: 'https://example.com/final', statusCode: 200, body: { kind: 'text', content: '# 相同正文\n\n同一来源。' }, truncated: false },
      content: [],
    }))
    const pool = new S4WebResearchPool(workspace, run.commits, rawFetch)
    const exec = { signal: new AbortController().signal } as ToolRunContext
    const [left, right] = await Promise.all([
      pool.fetch('https://example.com/left', exec), pool.fetch('https://example.com/right', exec),
    ])
    expect(rawFetch).toHaveBeenCalledTimes(2)
    expect(left.source_ref).toBe(right.source_ref)
    expect([left.reused, right.reused].sort()).toEqual([false, true])
    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    expect(ledger.sources).toHaveLength(1)
    expect(pool.listSources(0, 20).sources).toHaveLength(1)
    expect(pool.stats()).toMatchObject({ web_sources_fetched: 1, web_sources_reused: 1 })
  })
})
