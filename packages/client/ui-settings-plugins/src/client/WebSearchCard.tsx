/** Hosted-search routing and per-request budget within the existing plugin card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'
import styles from './fields.module.css'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  const selectedProvider = state.searchProvider.text || 'deepseek-official'
  const registeredFollowModel = state.providers.some(provider => provider.id === 'deepseek-official')
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <label className={styles['field']}>
        <span className={styles['label']}>{t('webSearchProvider')}</span>
        <select className={styles['input']} aria-label={t('webSearchProvider')}
          value={selectedProvider} disabled={disabled || state.saving}
          onChange={(event) => { props.edit('searchProvider', event.target.value) }}>
          {!registeredFollowModel && <option value="deepseek-official">{t('webSearchFollowModel')}</option>}
          {state.searchProvider.text !== '' && !state.providers.some(provider => provider.id === state.searchProvider.text)
            && <option value={state.searchProvider.text}>{state.searchProvider.text}（{t('webSearchUnavailable')}）</option>}
          {state.providers.map(provider => <option key={provider.id} value={provider.id}>
            {provider.id === 'deepseek-official' ? t('webSearchFollowModel') : provider.name}
            {provider.available ? '' : `（${t('webSearchUnavailable')}）`}
          </option>)}
        </select>
      </label>
      <p className={styles['hint']}>{t('webSearchProviderHint')}</p>
      {state.providerError && <p role="alert">{t('webSearchProviderError')}</p>}
      {state.modelSearch.available && <>
        <ValueField id="plugin-config-web-search-max-uses" label={t('webSearchMaxUses')} hint={t('webSearchMaxUsesHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')}
          numeric disabled={disabled} {...state.modelSearch.maxUses}
          onEdit={(text) => { props.edit('maxUses', text) }} onReset={() => { props.resetField('maxUses') }} />
      </>}
      {state.tavily.available && <>
        <h4>{t('webSearchIndependentTitle')}</h4>
        <p className={styles['hint']}>{t('webSearchIndependentHint')}</p>
        <SecretField id="plugin-config-tavily-api-key" label={t('tavilyApiKey')} hint={t('tavilyApiKeyHint')}
          text={state.tavily.apiKey.text} disabled={disabled || !state.tavily.apiKeyWritable}
          configured={state.tavily.apiKeyConfigured} stateLabel={t(state.tavily.apiKeyConfigured ? 'tavilyApiKeySet' : 'tavilyApiKeyUnset')}
          onEdit={(text) => { props.edit('tavily.apiKey', text) }} />
        <p className={styles['hint']}>{t('tavilyApiKeyRef')}: {state.tavily.apiKeyEnv}</p>
        <ValueField id="plugin-config-tavily-base-url" label={t('tavilyBaseUrl')} hint={t('tavilyBaseUrlHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')}
          disabled={disabled} {...state.tavily.baseURL} onEdit={(text) => { props.edit('tavily.baseURL', text) }}
          onReset={() => { props.resetField('tavily.baseURL') }} />
        <ValueField id="plugin-config-tavily-timeout" label={t('tavilyTimeoutMs')} hint={t('tavilyTimeoutMsHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={disabled}
          {...state.tavily.timeoutMs} onEdit={(text) => { props.edit('tavily.timeoutMs', text) }} onReset={() => { props.resetField('tavily.timeoutMs') }} />
        <ValueField id="plugin-config-tavily-search-depth" label={t('tavilySearchDepth')} hint={t('tavilySearchDepthHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={disabled}
          choices={['basic', 'advanced', 'fast', 'ultra-fast']} {...state.tavily.searchDepth}
          onEdit={(text) => { props.edit('tavily.searchDepth', text) }} onReset={() => { props.resetField('tavily.searchDepth') }} />
        <ValueField id="plugin-config-tavily-topic" label={t('tavilyTopic')} hint={t('tavilyTopicHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={disabled}
          choices={['general', 'news', 'finance']} {...state.tavily.topic}
          onEdit={(text) => { props.edit('tavily.topic', text) }} onReset={() => { props.resetField('tavily.topic') }} />
        <ValueField id="plugin-config-tavily-answer" label={t('tavilyIncludeAnswer')} hint={t('tavilyIncludeAnswerHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={disabled}
          choices={['false', 'true', 'basic', 'advanced']} {...state.tavily.includeAnswer}
          onEdit={(text) => { props.edit('tavily.includeAnswer', text) }} onReset={() => { props.resetField('tavily.includeAnswer') }} />
        <ValueField id="plugin-config-tavily-max-results" label={t('tavilyMaxResults')} hint={t('tavilyMaxResultsHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={disabled}
          {...state.tavily.maxResults} onEdit={(text) => { props.edit('tavily.maxResults', text) }} onReset={() => { props.resetField('tavily.maxResults') }} />
        <ValueField id="plugin-config-tavily-chunks" label={t('tavilyChunksPerSource')} hint={t('tavilyChunksPerSourceHint')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={disabled}
          {...state.tavily.chunksPerSource} onEdit={(text) => { props.edit('tavily.chunksPerSource', text) }} onReset={() => { props.resetField('tavily.chunksPerSource') }} />
      </>}
    </PluginCard>
  )
}
