import { describe, expect, it } from 'vitest'
import { TavilySearchProvider, resolveTavilyOptions } from '@deepseek-ai/dsh-web-search-tavily'

describe.skipIf(!process.env.TAVILY_API_KEY)('Tavily live search', () => {
  it('returns at least one public source', async () => {
    const apiKey = process.env.TAVILY_API_KEY
    if (apiKey === undefined) throw new Error('TAVILY_API_KEY is required')
    const provider = new TavilySearchProvider(
      () => resolveTavilyOptions({}),
      async () => apiKey,
    )
    const result = await provider.search({ query: 'DeepSeek Harness GitHub', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.every(source => URL.canParse(source.url))).toBe(true)
  }, 30_000)
})
