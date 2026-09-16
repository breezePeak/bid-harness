/**
 * Vocabulary for the web capability seam (`ctx.web`). Search and fetch deliberately share one
 * seam so provider selection, cancellation, errors, and product configuration have one owner,
 * while retaining separate request and result types.
 * @module @deepseek-ai/dsh-web/types
 */

export { WebError } from '@deepseek-ai/dsh-llm'

import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-llm'
export type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-llm'

/**
 * What one fetch-capable backend is asked to retrieve. The request deliberately
 * omits timeout, format, prompt, and extraction controls: cancellation is a
 * direct execution argument, while presentation and higher-level LLM concerns
 * belong outside safe retrieval.
 */
export interface WebFetchRequest {
  readonly url: string
}

/** Secret-free local availability facts exposed to orchestration diagnostics. */
export interface WebProviderDiagnostic {
  /** Whether the provider can serve requests with its current local state. */
  readonly available: boolean
  /** Why a provider is unavailable, when the provider can classify it. */
  readonly reason?: 'credentials' | 'configuration' | 'unknown'
  /** Credential reference used by the provider, never the credential value. */
  readonly credentialRef?: string
  /** Where the credential was found, when the provider can disclose it safely. */
  readonly credentialSource?: string
  /** Provider endpoint, without credential material. */
  readonly endpoint?: string
}

/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
export interface WebFetchResult {
  /** The final URL after allowed redirects (the request URL is in the request). */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}

/**
 * The decoded body of a fetched resource. A CLOSED discriminated union owned by
 * `dsh-web`: the provider decodes the kind and `dsh-tool-web` renders it, so a
 * new kind is a coordinated change across known packages, not a plugin
 * extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`
 * so adding a kind breaks compilation at every consumer until handled. Each arm
 * stays its own object literal even where fields coincide, so an arm can gain
 * fields the others lack.
 */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/**
 * A search-capable backend. Registered with `ctx.web.registerSearchProvider`.
 * `id` is a stable string, unique within the search capability kind.
 */
export interface WebSearchProvider {
  readonly id: string
  /** Local usability check; must not make network calls. */
  available(): boolean | Promise<boolean>
  /** Optional secret-free explanation used by host preflight diagnostics. */
  diagnose?(): WebProviderDiagnostic | Promise<WebProviderDiagnostic>
  /** Run one search; honor `signal` for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/**
 * A fetch-capable backend. Registered with `ctx.web.registerFetchProvider`.
 * `id` is a stable string, unique within the fetch capability kind.
 */
export interface WebFetchProvider {
  readonly id: string
  /** Local usability check; must not make network calls. */
  available(): boolean | Promise<boolean>
  /** Optional secret-free explanation used by host preflight diagnostics. */
  diagnose?(): WebProviderDiagnostic | Promise<WebProviderDiagnostic>
  /** Retrieve one URL; honor `signal` for cancellation. */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}
