/** Registers Tavily as an independent `ctx.web` search provider. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_DEFAULT_TOPIC,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export * from './provider.ts'

/** Cordis plugin name. */
export const name = 'web-search-tavily'

/** The provider registers into the Web service. */
export const inject = ['web']

/** Settings namespace for Tavily connection and search policy. */
export const TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-tavily')

/** Tavily connection and search policy. Secrets are referenced through `apiKeyEnv`. */
export interface Config {
  /** Credentials reference resolved for each search. */
  apiKeyEnv?: string
  /** HTTP(S) API root; `/search` is appended. */
  baseURL?: string
  /** Provider-owned request deadline in milliseconds. */
  timeoutMs?: number
  /** Tavily latency and relevance mode. */
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'
  /** Tavily result category. */
  topic?: 'general' | 'news' | 'finance'
  /** Optional generated-answer mode. */
  includeAnswer?: boolean | 'basic' | 'advanced'
  /** Default result bound when the caller omits one. */
  maxResults?: number
  /** Advanced-search chunks retained per source. */
  chunksPerSource?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('TAVILY_API_KEY'),
  baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  timeoutMs: z.number().default(TAVILY_DEFAULT_TIMEOUT_MS),
  searchDepth: z.union(['basic', 'advanced', 'fast', 'ultra-fast'] as const).default(TAVILY_DEFAULT_SEARCH_DEPTH),
  topic: z.union(['general', 'news', 'finance'] as const).default(TAVILY_DEFAULT_TOPIC),
  includeAnswer: z.union([z.boolean(), z.union(['basic', 'advanced'] as const)]).default(false),
  maxResults: z.number().step(1).min(1).max(20),
  chunksPerSource: z.number().step(1).min(1).max(3),
})

/**
 * Resolve and validate one complete settings snapshot.
 * @param config current plugin and Settings values.
 * @returns validated options used by the next Tavily request.
 */
export function resolveTavilyOptions(config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = config.apiKeyEnv ?? 'TAVILY_API_KEY'
  credentialRef(apiKeyEnv)
  const base = new URL(config.baseURL ?? TAVILY_DEFAULT_BASE_URL)
  if (!['http:', 'https:'].includes(base.protocol) || base.username !== '' || base.password !== ''
    || base.search !== '' || base.hash !== '') {
    throw new Error('web-search-tavily: baseURL must be HTTP(S) without credentials, query, or fragment')
  }
  const timeoutMs = config.timeoutMs ?? TAVILY_DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`web-search-tavily: timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const searchDepth = config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH
  if (config.chunksPerSource !== undefined && searchDepth !== 'advanced') {
    throw new Error('web-search-tavily: chunksPerSource requires searchDepth "advanced"')
  }
  return {
    apiKeyEnv,
    baseURL: base.toString().replace(/\/+$/u, ''),
    timeoutMs,
    searchDepth,
    topic: config.topic ?? TAVILY_DEFAULT_TOPIC,
    includeAnswer: config.includeAnswer ?? false,
    ...config.maxResults === undefined ? {} : { maxResults: config.maxResults },
    ...config.chunksPerSource === undefined ? {} : { chunksPerSource: config.chunksPerSource },
  }
}

/** Register the Tavily provider and its live settings section. */
export function apply(ctx: Context, entry: Config): void {
  let current = (): Config => entry
  const options = (): TavilySearchProviderOptions => resolveTavilyOptions(current())
  options()
  installSettingsSection(ctx, TAVILY_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (source) => { current = source },
    onChange: () => { options() },
    validate: options,
  })
  const resolveApiKey = async (name: string): Promise<string> => {
    const ref = credentialRef(name)
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)
      : await credentials.resolve(ref)
    if (hit?.value !== undefined && hit.value.length > 0) return hit.value
    throw new WebError(`Tavily search has no API key for "${ref}"; store it through the credentials service or export ${ref}`, 'WEB_PROVIDER_ERROR')
  }
  ctx.web.registerSearchProvider(new TavilySearchProvider(options, resolveApiKey))
}
