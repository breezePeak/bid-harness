/** Search discovery shared by hosted model tools and the web tool service. */

import { HarnessError } from './error.ts'

/** Typed search/fetch failure with an open machine-readable code. */
export class WebError extends HarnessError {}

/**
 * What one search-capable backend is asked to search. Each request carries one
 * query; a consumer may issue several requests. `maxResults` is a
 * `dsh-tool-web`-layer bound passed through unchanged and enforced on the way
 * back by the seam (see {@link WebSearchResult}).
 */
export interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it. A provider whose API supports a
   * result-count control (Exa's `numResults`) should apply it at the request
   * layer as a cost/latency optimization; the seam enforces the bound
   * regardless.
   */
  readonly maxResults?: number
}

/**
 * One citeable source. A source always has a URL; `title`, `snippet`, and
 * `publishedAt` are optional because not every provider returns them — forcing
 * adapters to invent them would make the seam lie (Perplexity citations may be
 * URL-only). `dsh-tool-web` renders `title ?? hostname(url)` for display.
 */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}

/**
 * Normalized search outcome. `content` is optional provider-generated answer
 * text or summary (Exa and DeepSeek return none; Perplexity returns a
 * generated answer).
 * `sources[]` is the portable citation shape. `truncated` is set by the seam
 * when it cut `sources[]` down to `maxResults`.
 */
export interface WebSearchResult {
  /** Optional provider-generated answer text, search context, or summary. */
  readonly content?: string
  /** Citeable sources, already truncated to the request's `maxResults`. */
  readonly sources: readonly WebSearchSource[]
  /** True when the seam dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}

/** Secret-free hosted-search input recorded before dispatch. */
export interface HostedSearchRequest {
  readonly provider: string
  readonly endpoint: string
  /** Provider protocol revision, when a version header changes request interpretation. */
  readonly apiVersion?: string
  readonly body: Readonly<Record<string, unknown>>
}

/** Per-operation model selection, cost limit, cancellation, and durable input recorder. */
export interface HostedSearchOptions {
  readonly model: string
  readonly maxUses: number
  readonly signal?: AbortSignal
  readonly recordRequest: (request: HostedSearchRequest) => void
}

/** Provider-owned hosted search implementation; credential resolution stays private. */
export type HostedWebSearch = (request: WebSearchRequest, options: HostedSearchOptions) => Promise<WebSearchResult>

/** Capabilities queried by consumers without inspecting provider names. */
export type LlmCapability = 'chat' | 'tools' | 'web_search'
