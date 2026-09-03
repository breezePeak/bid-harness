/** Responses search parsing accepts structured discovery only. */
import { describe, expect, it } from 'vitest'
import { mapResponsesSearch, responsesBaseURL } from '../src/gpt.ts'

describe('GPT Provider protocol', () => {
  it.each(['https://api.openai.com', 'https://api.openai.com/v1', 'https://api.openai.com/v1/'])('normalizes %s to one v1 prefix', (base) => {
    expect(responsesBaseURL(base)).toBe('https://api.openai.com/v1')
  })

  it('preserves CPA deployment prefixes', () => {
    expect(responsesBaseURL('http://localhost:8317/proxy/')).toBe('http://localhost:8317/proxy/v1')
  })

  it.each(['invalid', 'ftp://host', 'https://secret@host', 'https://host?key=secret'])('rejects unsafe endpoint configuration', (base) => {
    expect(() => responsesBaseURL(base)).toThrow('GPT Provider')
    try { responsesBaseURL(base) } catch (error) { expect(String(error)).not.toContain('secret') }
  })

  it('deduplicates sources and annotations without treating generated text as evidence', () => {
    expect(mapResponsesSearch({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://source.test' }, { url: 'javascript:alert(1)' }] } },
      { type: 'message', content: [{ text: 'generated answer', annotations: [{ type: 'url_citation', url: 'https://source.test', title: 'Source' }] }] },
    ] })).toEqual({ sources: [{ url: 'https://source.test', title: 'Source' }], truncated: false })
  })

  it.each([
    { type: 'web_search_call', action: { sources: [{ url: 'https://source.test', title: '来源' }] } },
    { type: 'web_search_call', results: [{ url: 'https://source.test', title: '来源' }] },
    { type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://source.test', title: '来源' }] }] },
    { type: 'message', content: [{ annotations: [{ type: 'web_search_result_location', url: 'https://source.test', title: '来源' }] }] },
  ])('GPT / CPA 四种结构化来源均进入 sources：%j', (item) => {
    expect(mapResponsesSearch({ status: 'completed', output: [item] })).toEqual({ sources: [{ url: 'https://source.test', title: '来源' }], truncated: false })
  })

  it('普通回答中的 URL 不成为正式来源', () => {
    expect(mapResponsesSearch({ output: [{ type: 'web_search_call', action: { sources: [] } }, { type: 'message', content: [{ text: 'https://invented.test' }] }] }).sources).toEqual([])
  })

  it.each([
    null, { output: {} }, { output: [{ type: 'message', content: [{ text: 'https://invented.test' }] }] },
    { output: [{ type: 'web_search_call', status: 'failed' }] },
    { status: 'incomplete', output: [{ type: 'web_search_call', status: 'completed' }] },
    { error: { message: 'secret' }, output: [] },
  ])('rejects invalid, prose-only, failed, and incomplete discovery', (body) => {
    expect(() => mapResponsesSearch(body)).toThrow('GPT Provider')
  })
})
