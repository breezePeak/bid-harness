/** Staged Web search route, hosted-search budget, and independent search settings. */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, numberField, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import type { TavilyCardState, TavilySettings } from './tavily-card-controller.ts'
import { TAVILY_NS, TavilyCardController } from './tavily-card-controller.ts'

/** Namespace owned by the Web service for the actual search route. */
export const WEB_NS = 'web'
/** Existing namespace retained for model-search policy. */
export const WEB_SEARCH_NS = 'web-search-deepseek'
export { TAVILY_NS }

/** Web service route selection. */
export interface WebSettings { searchProvider?: string }

/** Search policy fields owned by this card. */
export interface WebSearchSettings {
  provider?: string
  maxUses?: number
}

/** A provider advertising installed hosted search. */
interface SearchProviderChoice {
  id: string
  name: string
  available: boolean
}

/** Staged search policy and current capability choices. */
export interface WebSearchCardState extends CardShell {
  searchProvider: CardFieldState
  providers: readonly SearchProviderChoice[]
  providerError: boolean
  modelSearch: { available: boolean; maxUses: CardFieldState }
  tavily: TavilyCardState
}

/** Registration-side card face. */
export interface WebSearchCardFace extends CardActions {
  hooks: { webSearchCard: SnapshotStore<WebSearchCardState> }
}

/** Connect the single Web card to its route and provider-specific settings. */
export class WebSearchCardController {
  private readonly webForm: CardForm<WebSettings>
  private readonly modelSearchForm: CardForm<WebSearchSettings>
  private readonly tavily: TavilyCardController
  private readonly store: SnapshotStore<WebSearchCardState>
  private providers: SearchProviderChoice[] = []
  private providerError = false
  private generation = 0

  /**
   * @param webScope - Web route settings scope.
   * @param modelSearchScope - existing model-search policy scope.
   * @param tavilyScope - Tavily settings scope.
   * @param api - provider diagnostics and credential wire methods.
   */
  constructor(
    webScope: SettingsScope<WebSettings>,
    modelSearchScope: SettingsScope<WebSearchSettings>,
    tavilyScope: SettingsScope<TavilySettings>,
    private readonly api: Pick<IApiClient, 'web' | 'credentials'>,
  ) {
    this.webForm = new CardForm(webScope, [textField('searchProvider')])
    this.modelSearchForm = new CardForm(modelSearchScope, [numberField('maxUses')])
    this.tavily = new TavilyCardController(tavilyScope, api)
    this.store = this.webForm.bind(() => this.projection())
    const modelStore = this.modelSearchForm.bind(() => this.projection())
    modelStore.subscribe(() => { this.store.set(this.projection()) })
    this.tavily.inject().hooks.tavilyCard.subscribe(() => { this.store.set(this.projection()) })
    webScope.subscribe(() => { void this.refreshProviders() })
    void this.refreshProviders()
  }

  private projection(): WebSearchCardState {
    const web = this.webForm.shell()
    const model = this.modelSearchForm.shell()
    const tavily = this.tavily.inject().hooks.tavilyCard.getSnapshot()
    const shells = [web, model, tavily]
    return {
      available: shells.some(shell => shell.available),
      writable: shells.filter(shell => shell.available).every(shell => shell.writable),
      dirty: shells.some(shell => shell.dirty),
      invalid: shells.some(shell => shell.invalid),
      saving: shells.some(shell => shell.saving),
      failed: shells.some(shell => shell.failed),
      searchProvider: this.webForm.field('searchProvider'),
      providers: this.providers, providerError: this.providerError,
      modelSearch: {
        available: model.available,
        maxUses: this.modelSearchForm.field('maxUses'),
      },
      tavily,
    }
  }

  /** Refresh actual Web providers after the Host topology changes. */
  async refreshProviders(): Promise<void> {
    const generation = ++this.generation
    try {
      const response = await this.api.web.diagnose({})
      if (generation !== this.generation) return
      if (!response.result.ok) throw new Error('Web provider directory unavailable')
      this.providers = response.result.value.search.providers.map(({ id, diagnostic }) => ({
        id, available: diagnostic.available,
        name: id === 'tavily' ? 'Tavily' : id,
      }))
      this.providerError = false
    } catch { if (generation === this.generation) this.providerError = true }
    this.store.set(this.projection())
  }

  /** Refresh Tavily's write-only credential status after an external update. */
  async refreshCredential(): Promise<void> {
    await this.tavily.refreshCredential()
    this.store.set(this.projection())
  }

  /**
   * Expose the combined card snapshot and staged save/discard actions.
   * @returns the combined card snapshot and staged save/discard actions.
   */
  inject(): WebSearchCardFace {
    const web = this.webForm.actions()
    const model = this.modelSearchForm.actions()
    const tavily = this.tavily.inject()
    const action = (field: string, callback: (actions: CardActions, name: string) => void): void => {
      if (field === 'searchProvider') callback(web, field)
      else if (field === 'maxUses') callback(model, field)
      else if (field.startsWith('tavily.')) callback(tavily, field.slice('tavily.'.length))
      else throw new Error(`web search card has no field ${field}`)
    }
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => action(field, (actions, name) => { actions.edit(name, text) }),
      resetField: field => action(field, (actions, name) => { actions.resetField(name) }),
      save: () => { web.save(); model.save(); tavily.save() },
      discard: () => { web.discard(); model.discard(); tavily.discard() },
    }
  }
}
