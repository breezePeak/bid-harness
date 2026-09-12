import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import {
  mapTavilyResponse,
  resolveTavilyOptions,
  TavilySearchProvider,
  TAVILY_PROVIDER_ID,
  TAVILY_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-tavily'

const options = {
  apiKeyEnv: 'TAVILY_API_KEY', baseURL: 'https://api.tavily.test', timeoutMs: 5_000,
  searchDepth: 'basic' as const, topic: 'general' as const, includeAnswer: false as const,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily response mapping', () => {
  it('maps answer, sources, snippets, and publication dates', () => {
    expect(mapTavilyResponse({ answer: 'answer', results: [
      { url: 'https://a.test', title: 'A', content: 'snippet', published_date: '2026-09-12' },
      { url: 'https://b.test', title: '', content: null },
    ] })).toEqual({
      content: 'answer',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'snippet', publishedAt: '2026-09-12' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('omits a missing generated answer', () => {
    expect(mapTavilyResponse({ answer: '', results: [] })).toEqual({ sources: [], truncated: false })
  })
})

describe('Tavily configuration', () => {
  it('applies provider defaults and canonicalizes the base URL', () => {
    expect(resolveTavilyOptions({ baseURL: 'https://api.tavily.test/' })).toMatchObject({
      apiKeyEnv: 'TAVILY_API_KEY', baseURL: 'https://api.tavily.test', timeoutMs: 30_000,
      searchDepth: 'basic', topic: 'general', includeAnswer: false,
    })
  })

  it.each([
    { baseURL: 'ftp://api.tavily.test' },
    { baseURL: 'https://user@api.tavily.test' },
    { baseURL: 'https://api.tavily.test?x=1' },
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
    { apiKeyEnv: 'not-a-ref' },
    { searchDepth: 'basic' as const, chunksPerSource: 2 },
  ])('rejects invalid provider configuration: %j', (config) => {
    expect(() => resolveTavilyOptions(config)).toThrow()
  })
})

describe('Tavily request and failure mapping', () => {
  it('sends the provider parameters and lets request maxResults win', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://result.test', title: 'R', content: 'S' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new TavilySearchProvider(
      () => ({ ...options, searchDepth: 'advanced', topic: 'news', includeAnswer: 'basic', maxResults: 9, chunksPerSource: 2 }),
      async () => 'tvly-key',
    )
    await expect(provider.search({ query: 'current rules', maxResults: 4 })).resolves.toMatchObject({
      sources: [{ url: 'https://result.test', title: 'R', snippet: 'S' }],
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tvly-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'current rules', search_depth: 'advanced', topic: 'news', include_answer: 'basic',
      include_raw_content: false, max_results: 4, chunks_per_source: 2,
    })
  })

  it('forwards caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new TavilySearchProvider(() => options, async () => 'key').search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('classifies provider timeout separately from caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })))
    await expect(new TavilySearchProvider(() => ({ ...options, timeoutMs: 10 }), async () => 'key').search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_SEARCH_TIMEOUT' }))
  })

  it.each([
    { response: jsonResponse({ detail: { error: 'bad key' } }, { status: 401 }), message: 'bad key' },
    { response: new Response('gateway', { status: 502 }), message: 'Tavily API error (HTTP 502)' },
  ])('maps HTTP failures: $message', async ({ response, message }) => {
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(new TavilySearchProvider(() => options, async () => 'key').search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message }))
  })

  it('maps malformed success responses to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: null })))
    await expect(new TavilySearchProvider(() => options, async () => 'key').search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('Tavily plugin registration and live credentials/settings', () => {
  it('uses managed credentials per request and applies the next settings snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tavily-settings-'))
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(FileSettingsProvider, { dshHome: root, watch: false })
    await ctx.plugin(LocalCredentialProvider, { dshHome: root, watch: false })
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, {})
    try {
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(/TAVILY_API_KEY/u)
      await ctx.credentials.set(credentialRef('TAVILY_API_KEY'), 'first-key')
      await ctx.web.search({ query: 'one' })
      await ctx.credentials.set(credentialRef('TAVILY_API_KEY'), 'second-key')
      await ctx.settings.update(TAVILY_SETTINGS_NAMESPACE, { baseURL: 'https://alternate.tavily.test', topic: 'finance' })
      await ctx.web.search({ query: 'two' })
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
      expect(calls.map(call => call[0])).toEqual(['https://api.tavily.com/search', 'https://alternate.tavily.test/search'])
      expect(calls.map(call => (call[1].headers as Record<string, string>)['authorization']))
        .toEqual(['Bearer first-key', 'Bearer second-key'])
      expect(JSON.parse(calls[1]![1].body as string)).toMatchObject({ topic: 'finance' })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('is a namespace plugin and disposes its registration', async () => {
    expect('default' in tavilyPlugin).toBe(false)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, {})
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    await ctx.fiber.dispose()
  })
})
