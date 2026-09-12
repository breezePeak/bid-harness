/** Tavily implementation of the provider-neutral Web search contract. */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id registered with `ctx.web`. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Public Tavily API base. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Provider resource backstop for direct `ctx.web.search()` callers. */
export const TAVILY_DEFAULT_TIMEOUT_MS = 30_000

/** Default Tavily latency/relevance trade-off. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic'

/** Default Tavily result category. */
export const TAVILY_DEFAULT_TOPIC = 'general'

/** Tavily search-depth values supported by this provider. */
export type TavilySearchDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast'

/** Tavily topic values supported by this provider. */
export type TavilyTopic = 'general' | 'news' | 'finance'

/** Validated provider options, resolved from settings for each operation. */
export interface TavilySearchProviderOptions {
  apiKeyEnv: string
  baseURL: string
  timeoutMs: number
  searchDepth: TavilySearchDepth
  topic: TavilyTopic
  includeAnswer: boolean | 'basic' | 'advanced'
  maxResults?: number
  chunksPerSource?: number
}

/**
 * Map one Tavily result to the provider-neutral source shape.
 * @param result one entry from Tavily `results`.
 * @returns normalized source metadata and snippet.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.length > 0 ? { snippet: result.content } : {},
    ...result.published_date != null && result.published_date.length > 0
      ? { publishedAt: result.published_date }
      : {},
  }
}

/**
 * Map a Tavily response to the provider-neutral result shape.
 * @param response parsed Tavily search response.
 * @returns normalized answer and sources.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  return {
    ...response.answer != null && response.answer.length > 0 ? { content: response.answer } : {},
    sources: response.results.map(mapTavilyResult),
    truncated: false,
  }
}

/** Tavily-backed provider; configuration and credentials are resolved once per search. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /** @param options current configuration thunk. @param resolveApiKey per-operation credential resolver. */
  constructor(
    private readonly options: () => TavilySearchProviderOptions,
    private readonly resolveApiKey: (ref: string) => Promise<string>,
  ) {}

  available(): boolean {
    return this.options().apiKeyEnv.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.options()
    using d = deadline(signal, options.timeoutMs, 'WEB_SEARCH_TIMEOUT')
    throwIfAborted(d.signal)
    const apiKey = await this.resolveApiKey(options.apiKeyEnv)
    throwIfAborted(d.signal)
    const maxResults = request.maxResults ?? options.maxResults
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': 'deepseek-harness/0.0.1',
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: options.searchDepth,
          topic: options.topic,
          include_answer: options.includeAnswer,
          include_raw_content: false,
          ...maxResults === undefined ? {} : { max_results: maxResults },
          ...options.chunksPerSource === undefined ? {} : { chunks_per_source: options.chunksPerSource },
        }),
        signal: d.signal,
      })
    } catch (error: unknown) {
      throw translateAbortOrFailure(error, d.signal)
    }
    if (!response.ok) throw await tavilyHttpError(response, d.signal)
    try {
      return mapTavilyResponse(await response.json() as TavilySearchResponse)
    } catch (error: unknown) {
      throwIfAborted(d.signal, error)
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

async function tavilyHttpError(response: Response, signal: AbortSignal): Promise<WebError> {
  let message = `Tavily API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as TavilyError
    const detail = typeof parsed.detail === 'string'
      ? parsed.detail
      : parsed.detail?.error ?? parsed.detail?.message ?? parsed.error ?? parsed.message
    if (detail !== undefined && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (signal.aborted) return translateAbortOrFailure(error, signal)
  }
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

function translateAbortOrFailure(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_SEARCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('Tavily search timed out', 'WEB_SEARCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

function throwIfAborted(signal: AbortSignal, cause?: unknown): void {
  if (signal.aborted) throw translateAbortOrFailure(cause, signal)
}
