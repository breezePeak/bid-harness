/** Staged Tavily connection and search-policy settings for the Plugins page. */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, numberField, textField, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell } from './card-form.ts'

/** Host settings namespace registered by the Tavily search provider. */
export const TAVILY_NS = 'web-search-tavily'

/** Tavily settings accepted by the Host provider. */
export interface TavilySettings {
  apiKeyEnv?: string
  baseURL?: string
  timeoutMs?: number
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'
  topic?: 'general' | 'news' | 'finance'
  includeAnswer?: boolean | 'basic' | 'advanced'
  maxResults?: number
  chunksPerSource?: number
}

/** Staged Tavily settings and credential status. */
export interface TavilyCardState extends CardShell {
  apiKeyEnv: string
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
  baseURL: CardFieldState
  timeoutMs: CardFieldState
  searchDepth: CardFieldState
  topic: CardFieldState
  includeAnswer: CardFieldState
  maxResults: CardFieldState
  chunksPerSource: CardFieldState
}

/** Registration-side card face. */
export interface TavilyCardFace extends CardActions {
  hooks: { tavilyCard: SnapshotStore<TavilyCardState> }
}

const DEFAULT_API_KEY_REF = 'TAVILY_API_KEY'

function choiceField(field: string, values: readonly (string | boolean)[]): CardFieldSpec {
  return {
    field,
    format: value => values.includes(value as string | boolean) ? String(value) : '',
    parse: (text) => {
      if (!values.some(value => String(value) === text)) return undefined
      const value = text === 'true' ? true : text === 'false' ? false : text
      return { kind: 'set', value }
    },
  }
}

/** Connect the Tavily card to its Host settings namespace and credentials. */
export class TavilyCardController {
  private readonly form: CardForm<TavilySettings>
  private readonly store: SnapshotStore<TavilyCardState>
  private credentialConfigured = false
  private credentialWritable = false
  private credentialLoaded = false
  private credentialGeneration = 0

  /**
   * @param scope - Tavily's Host settings scope.
   * @param api - credential wire methods.
   */
  constructor(private readonly scope: SettingsScope<TavilySettings>, private readonly api: Pick<IApiClient, 'credentials'>) {
    this.form = new CardForm(scope, [
      textField('baseURL'), numberField('timeoutMs'),
      choiceField('searchDepth', ['basic', 'advanced', 'fast', 'ultra-fast']),
      choiceField('topic', ['general', 'news', 'finance']),
      choiceField('includeAnswer', [false, true, 'basic', 'advanced']),
      numberField('maxResults'), numberField('chunksPerSource'),
    ], [{ field: 'apiKey', write: value => this.storeCredential(value) }])
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.refreshCredential() })
    void this.refreshCredential()
  }

  /** Refresh the write-only key status for the currently effective reference. */
  async refreshCredential(): Promise<void> {
    const ref = this.credentialRef()
    const generation = ++this.credentialGeneration
    this.credentialLoaded = false
    this.store.set(this.projection())
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (generation !== this.credentialGeneration || !response.result.ok) return
      const info = response.result.value.credentials[ref]
      this.credentialConfigured = info?.configured === true
      this.credentialWritable = info?.writable === true
      this.credentialLoaded = true
    } catch {
      // Credential status is advisory; keep the card usable when the probe transport fails.
      if (generation !== this.credentialGeneration) return
    }
    this.store.set(this.projection())
  }

  /**
   * Expose the card snapshot and staged actions.
   * @returns the card snapshot and staged actions.
   */
  inject(): TavilyCardFace {
    return { hooks: { tavilyCard: this.store }, ...this.form.actions() }
  }

  private projection(): TavilyCardState {
    const value = this.scope.getSnapshot().value
    return {
      ...this.form.shell(),
      apiKeyEnv: typeof value?.apiKeyEnv === 'string' && value.apiKeyEnv.length > 0 ? value.apiKeyEnv : DEFAULT_API_KEY_REF,
      apiKey: this.form.field('apiKey'),
      apiKeyConfigured: this.credentialConfigured,
      apiKeyWritable: !this.credentialLoaded || this.credentialWritable,
      baseURL: this.form.field('baseURL'),
      timeoutMs: this.form.field('timeoutMs'),
      searchDepth: this.form.field('searchDepth'),
      topic: this.form.field('topic'),
      includeAnswer: this.form.field('includeAnswer'),
      maxResults: this.form.field('maxResults'),
      chunksPerSource: this.form.field('chunksPerSource'),
    }
  }

  private credentialRef(): string {
    const value = this.scope.getSnapshot().value?.apiKeyEnv
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_API_KEY_REF
  }

  private async storeCredential(value: string): Promise<boolean> {
    try {
      const response = await this.api.credentials.set({ ref: this.credentialRef(), value })
      if (!response.result.ok) return false
      this.credentialConfigured = true
      return true
    } catch { return false }
  }
}
