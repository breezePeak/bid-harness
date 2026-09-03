/** GPT Provider over the existing pi-ai Responses adapter, including hosted search. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { attributionHeaders, assertUsableApiKey, LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, HostedSearchOptions, PreparedAdapterCall, StreamChunk, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PiAiAdapter } from './adapter.ts'
import type { PiAiAdapterOptions } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { modelProfile, resolveProfiles } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'

export const name = 'llm-gpt'
export const inject = ['llm']

/** GPT settings use the same credential reference and model catalog as the existing provider editor. */
export type Config = Pick<PiAiProviderProfile, 'apiKeyEnv' | 'baseURL' | 'models' | 'streamIdleTimeoutMs' | 'timeoutMs' | 'retryPolicy'>

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENAI_API_KEY'),
  baseURL: z.string().default('https://api.openai.com/v1'),
  models: z.array(modelProfile).default([{ id: 'gpt-5.2', name: 'GPT-5.2' }]),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  retryPolicy: RetryPolicySchema,
})

/**
 * Normalize an official or Responses-compatible base, accepting an optional /v1 suffix.
 * @param value - configured endpoint; credentials and query parameters are forbidden.
 * @returns base URL whose /responses endpoint the SDK and hosted search share.
 */
export function responsesBaseURL(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new LlmError('GPT Provider requires a valid Base URL', 'INVALID_CONFIG') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmError('GPT Provider Base URL must be HTTP(S) without credentials, query, or fragment', 'INVALID_CONFIG')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url.href.replace(/\/$/u, '')
}

/**
 * Parse only structured discovery URLs; generated answer text never becomes evidence.
 * @param payload - untrusted Responses API JSON.
 * @returns discovered HTTP(S) sources, deduplicated by URL.
 */
export function mapResponsesSearch(payload: unknown): WebSearchResult {
  if (typeof payload !== 'object' || payload === null || !('output' in payload) || !Array.isArray(payload.output)) {
    throw new LlmError('GPT Provider returned an invalid Responses search result', 'WEB_PROVIDER_ERROR')
  }
  if (('status' in payload && payload.status !== 'completed') || ('error' in payload && payload.error != null)) {
    throw new LlmError('GPT Provider search response did not complete', 'WEB_PROVIDER_ERROR')
  }
  const sources = new Map<string, WebSearchSource>()
  let searched = false
  const add = (item: unknown): void => {
    if (typeof item !== 'object' || item === null || !('url' in item) || typeof item.url !== 'string') return
    if (!URL.canParse(item.url) || !['http:', 'https:'].includes(new URL(item.url).protocol)) return
    const title = 'title' in item && typeof item.title === 'string' ? item.title : undefined
    sources.set(item.url, { ...sources.get(item.url), url: item.url, ...title === undefined ? {} : { title } })
  }
  for (const item of payload.output as unknown[]) {
    if (typeof item !== 'object' || item === null || !('type' in item)) continue
    if (item.type === 'web_search_call') {
      if ('status' in item && item.status !== 'completed') throw new LlmError('GPT Provider web_search did not complete', 'WEB_PROVIDER_ERROR')
      searched = true
      if ('action' in item && typeof item.action === 'object' && item.action !== null
        && 'sources' in item.action && Array.isArray(item.action.sources)) item.action.sources.forEach(add)
      if ('results' in item && Array.isArray(item.results)) item.results.forEach(add)
    }
    if (item.type === 'url_citation' || item.type === 'web_search_result_location') add(item)
    if (item.type === 'message' && 'content' in item && Array.isArray(item.content)) {
      for (const block of item.content as unknown[]) {
        if (typeof block !== 'object' || block === null || !('annotations' in block) || !Array.isArray(block.annotations)) continue
        for (const annotation of block.annotations as unknown[]) {
          if (typeof annotation === 'object' && annotation !== null && 'type' in annotation
            && (annotation.type === 'url_citation' || annotation.type === 'web_search_result_location')) add(annotation)
        }
      }
    }
  }
  if (!searched && sources.size === 0) throw new LlmError('GPT Provider returned no hosted web_search call', 'WEB_PROVIDER_ERROR')
  return { sources: [...sources.values()], truncated: false }
}

/** GPT model calls retain pi-ai's streaming, tools, usage, reasoning, and replay conversion. */
export class GPTProvider extends PiAiAdapter {
  private readonly gptOptions: PiAiAdapterOptions

  /** @param options - provider configuration, credentials, and optional attachment service. */
  constructor(options: PiAiAdapterOptions) {
    super(options)
    this.gptOptions = options
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal)
    return { model: prepared.model, stream: options => this.safeStream(prepared.stream(options)) }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.safeStream(super.stream(options))
  }

  private async * safeStream(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const unsupported = [404, 405, 501].includes(chunk.reason.failure.status ?? 0)
            || /\b(?:404|405|501)\b/u.test(chunk.reason.failure.message)
          yield { ...chunk, reason: { ...chunk.reason, failure: {
            ...chunk.reason.failure,
            code: unsupported ? 'UNSUPPORTED_RESPONSES_API' : chunk.reason.failure.code,
            message: unsupported ? 'GPT Provider does not support Responses API'
              : `GPT Provider request failed (${chunk.reason.failure.code})`,
          } } }
        } else yield chunk
      }
    } catch (error) {
      const code = error instanceof LlmError ? error.failure.code : 'TRANSPORT'
      throw new LlmError(`GPT Provider request failed (${code})`, code)
    }
  }

  /**
   * Discover URLs using the same GPT profile as conversation requests.
   * @param request - search query and source limit.
   * @param options - captured model, budget, cancellation, and durable input recorder.
   * @returns structured URLs and titles, without generated answer text.
   */
  async search(request: WebSearchRequest, options: HostedSearchOptions): Promise<WebSearchResult> {
    const profile = requireGptProfile(this.gptOptions.profiles())
    const baseURL = profile.baseURL
    if (baseURL === undefined) throw new LlmError('GPT Provider requires a Base URL', 'INVALID_CONFIG')
    using timeout = deadline(options.signal, profile.timeoutMs ?? 300_000, 'GPT_SEARCH_TIMEOUT')
    try {
      const apiKey = await this.gptOptions.resolveApiKey('gpt', profile)
      timeout.signal.throwIfAborted()
      const body = {
        model: options.model,
        input: `Perform a web search for the query: ${request.query}`,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        max_tool_calls: options.maxUses,
        store: false,
      }
      const endpoint = `${baseURL}/responses`
      options.recordRequest({ provider: 'gpt', endpoint, body })
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: timeout.signal,
        headers: { ...attributionHeaders(), authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if ([404, 405, 501].includes(response.status)) throw new LlmError('GPT Provider does not support Responses API', 'UNSUPPORTED_RESPONSES_API')
      if (!response.ok) throw new LlmError(`GPT Provider search request failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR', { status: response.status })
      return mapResponsesSearch(await response.json())
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('GPT Provider search aborted', 'WEB_ABORTED')
      if (timeout.signal.aborted) throw new LlmError('GPT Provider search timed out', 'TIMEOUT')
      if (error instanceof LlmError) throw error
      throw new LlmError('GPT Provider search request failed', 'WEB_PROVIDER_ERROR')
    }
  }
}

/**
 * Register the GPT route and its hosted-search capability using one settings namespace.
 * @param ctx - plugin context exposing the LLM registry and optional settings/credentials.
 * @param entry - composition defaults beneath the user settings.
 */
export function apply(ctx: Context, entry: Config): void {
  const ns = settingsNamespace('llm-gpt')
  const base = Config(entry)
  let current: () => Config = () => base
  let cached: Config | undefined
  let resolved: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const config = current()
    if (cached === config) return resolved
    resolved = resolveProfiles({ gpt: {
      ...config, displayName: 'GPT', api: 'openai-responses',
      baseURL: responsesBaseURL(config.baseURL ?? 'https://api.openai.com/v1'),
      transport: 'sse',
    } })
    cached = config
    return resolved
  }
  const resolveApiKey = async (_provider: string, profile: ResolvedPiAiProviderProfile): Promise<string> => {
    const ref = profile.apiKeyEnv ?? credentialRef('OPENAI_API_KEY')
    const credentials = ctx.get('credentials')
    const key = credentials === undefined ? launchEnvironmentOf(ctx).get(ref)?.value : (await credentials.resolve(ref))?.value
    if (key === undefined) throw new LlmError('GPT Provider requires an API Key in the model settings', 'MISSING_CREDENTIAL')
    return assertUsableApiKey(key, 'GPT Provider', ref)
  }
  const provider = new GPTProvider({
    profiles, resolveApiKey,
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([{ provider: 'gpt', displayName: 'GPT', settingsNs: ns, settingsPath: [] }])
  const registration = ctx.llm.registerAdapter(['gpt'], provider)
  ctx.llm.registerWebSearch('gpt', (request, options) => provider.search(request, options))
  ctx.llm.registerModelDiscovery(ns, request => discoverModels({
    ...request, provider: 'gpt', api: 'openai-responses',
    baseURL: responsesBaseURL(request.baseURL ?? current().baseURL ?? 'https://api.openai.com/v1'),
  }, () => resolveApiKey('gpt', requireGptProfile(profiles()))))
  installSettingsSection(ctx, ns, Config, base, {
    setSource: (source) => { current = source },
    validate: (config) => { responsesBaseURL(config.baseURL ?? 'https://api.openai.com/v1'); resolveProfiles({ gpt: { ...config, api: 'openai-responses' } }) },
    onChange: () => { registration.replace(['gpt']) },
  })
}

/** Resolve the route owned by this plugin before using its connection. */
function requireGptProfile(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): ResolvedPiAiProviderProfile {
  const profile = profiles.get('gpt')
  if (profile === undefined) throw new LlmError('GPT Provider is not configured', 'INVALID_CONFIG')
  return profile
}
