/** Tavily `POST /search` wire types; provider-private and independent of `ctx.llm`. */

/** One Tavily search result. */
export interface TavilyResult {
  title?: string | null
  url: string
  content?: string | null
  published_date?: string | null
}

/** Tavily search response envelope. */
export interface TavilySearchResponse {
  answer?: string | null
  results: TavilyResult[]
}

/** Best-effort Tavily error response envelope. */
export interface TavilyError {
  detail?: string | { error?: string; message?: string }
  error?: string
  message?: string
}
