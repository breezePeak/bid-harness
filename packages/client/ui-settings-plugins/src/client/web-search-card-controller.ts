/** Staged hosted-search policy; credentials are edited exclusively on the Models page. */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, numberField, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Existing namespace retained for persisted search policy. */
export const WEB_SEARCH_NS = 'web-search-deepseek'

/** Search policy fields owned by this card. */
export interface WebSearchSettings {
  provider?: string
  maxUses?: number
}

/** A provider advertising installed hosted search. */
interface SearchProviderChoice {
  id: string
  name: string
}

/** Staged search policy and current capability choices. */
export interface WebSearchCardState extends CardShell {
  provider: CardFieldState
  maxUses: CardFieldState
  providers: readonly SearchProviderChoice[]
  providerError: boolean
}

/** Registration-side card face. */
export interface WebSearchCardFace extends CardActions {
  hooks: { webSearchCard: SnapshotStore<WebSearchCardState> }
}

/** Connect the existing staged form to provider capability discovery. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private providers: SearchProviderChoice[] = []
  private providerError = false
  private generation = 0

  /**
   * @param scope - existing search settings scope.
   * @param api - provider capability directory.
   */
  constructor(scope: SettingsScope<WebSearchSettings>, private readonly api: Pick<IApiClient, 'llm'>) {
    this.form = new CardForm(scope, [textField('provider'), numberField('maxUses')])
    this.store = this.form.bind(() => this.projection())
    void this.refreshProviders()
  }

  private projection(): WebSearchCardState {
    return {
      ...this.form.shell(), provider: this.form.field('provider'), maxUses: this.form.field('maxUses'),
      providers: this.providers, providerError: this.providerError,
    }
  }

  /** Refresh provider choices after adapter topology changes. */
  async refreshProviders(): Promise<void> {
    const generation = ++this.generation
    try {
      const response = await this.api.llm.providers({})
      if (generation !== this.generation) return
      if (!response.result.ok) throw new Error('Provider directory unavailable')
      this.providers = response.result.value.providers
        .filter(row => row.active && row.capabilities?.includes('web_search'))
        .map(row => ({ id: row.provider, name: row.displayName }))
      this.providerError = false
    } catch { if (generation === this.generation) this.providerError = true }
    this.store.set(this.projection())
  }

  /**
   * Expose the staged policy to the registered settings card.
   * @returns the card snapshot and staged save/discard actions.
   */
  inject(): WebSearchCardFace {
    return { hooks: { webSearchCard: this.store }, ...this.form.actions() }
  }
}
