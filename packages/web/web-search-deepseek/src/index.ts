/** Web-search policy over the selected LLM Provider, with migration of legacy DeepSeek settings. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { HostedSearchRequest } from '@deepseek-ai/dsh-llm'
import { WebError } from '@deepseek-ai/dsh-web'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session'
import type { DeepSeekSearchLlmRequest } from './provider.ts'

export * from './provider.ts'

export const name = 'web-search-deepseek'
export const inject = ['web', 'llm', 'agentDefaultModel']

/** The persisted namespace is retained so existing plugin policies keep their address. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')
const PROVIDER_NS = settingsNamespace('llm-deepseek')

/** Search routing and cost policy. Legacy connection fields are migration inputs only. */
export interface Config {
  /** Omission follows the initiating Agent's provider, or the global default outside an Agent. */
  provider?: string
  /** Maximum hosted searches in one auxiliary request. */
  maxUses?: number
  /** @deprecated Migrated to the DeepSeek Provider. */
  apiKey?: string
  /** @deprecated Migrated to the DeepSeek Provider. */
  apiKeyEnv?: string
  /** @deprecated Migrated to the DeepSeek Provider. */
  baseURL?: string
  /** @deprecated Migrated to the DeepSeek Provider. */
  model?: string
  /** @deprecated Migrated to the DeepSeek Provider. */
  apiVersion?: string
  /** @deprecated Migrated to the DeepSeek Provider. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  maxUses: z.number().step(1).min(1).default(5),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  model: z.string(),
  apiVersion: z.string(),
  maxTokens: z.number().step(1).min(1),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Legacy DeepSeek search request retained for existing logs. */
    'web/deepseek-search-llm-request': DeepSeekSearchLlmRequest
    /** Exact secret-free hosted-search request, recorded before dispatch. */
    'web/provider-search-llm-request': HostedSearchRequest
  }
}

/** Move connection fields before dispatch; a failed write leaves the original values recoverable. */
async function migrateLegacy(ctx: Context, config: Config): Promise<void> {
  const fields = ['apiKey', 'apiKeyEnv', 'baseURL', 'model', 'apiVersion', 'maxTokens'] as const
  const present = fields.filter(field => config[field] !== undefined)
  if (present.length === 0) return
  const settings = ctx.get('settings')
  const target = settings?.get(PROVIDER_NS) as { search?: Record<string, unknown> } | undefined
  if (settings === undefined || target === undefined || !settings.writable) {
    throw new WebError('DeepSeek Provider search settings require a writable settings service for migration', 'WEB_PROVIDER_ERROR')
  }
  const ops: SettingsPathOp[] = present.filter(field => target.search?.[field] === undefined)
    .map(field => ({ op: 'set', path: ['search', field], value: config[field] }))
  if (ops.length > 0) await settings.mutate(PROVIDER_NS, ops)
  await settings.mutate(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, present.map(field => ({ op: 'unset', path: [field] })))
}

/**
 * Register a web-tool adapter preserving the existing discovery/fetch result pipeline.
 * @param ctx - context exposing web, LLM, and default model services.
 * @param entry - composition policy and optional legacy migration input.
 */
export function apply(ctx: Context, entry: Config): void {
  let current: () => Config = () => entry
  installSettingsSection(ctx, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider({
    // Existing cordis.yml files select this web-service registration by id.
    id: 'deepseek-official',
    available: () => true,
    async search(request, signal) {
      const policy = current()
      const agent = ctx.get('agents')?.currentInitiator()
      const logged = agent?.session.requestHeader()?.config
      const selected = logged ?? (agent?.options.provider !== undefined && agent.options.model !== undefined
        ? { provider: agent.options.provider, model: agent.options.model }
        : ctx.agentDefaultModel.currentSelection())
      const route = policy.provider ?? selected.provider
      const model = route === selected.provider ? selected.model : (await ctx.llm.listModels(route))[0]?.id
      if (model === undefined) throw new WebError(`Provider "${route}" has no configured search model`, 'WEB_PROVIDER_ERROR')
      await migrateLegacy(ctx, policy)
      return ctx.llm.webSearch(route, request, {
        model, maxUses: policy.maxUses ?? 5,
        ...signal === undefined ? {} : { signal },
        recordRequest: (value) => { agent?.session.append('web/provider-search-llm-request', value) },
      })
    },
  })
}
