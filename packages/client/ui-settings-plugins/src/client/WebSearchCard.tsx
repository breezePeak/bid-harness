/** Hosted-search routing and per-request budget within the existing plugin card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
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
        <span className={styles['label']}>搜索 Provider</span>
        <select className={styles['input']} aria-label="搜索 Provider" value={state.provider.text} disabled={disabled || state.saving}
          onChange={(event) => { props.edit('provider', event.target.value) }}>
          <option value="">跟随默认 Provider</option>
          {state.provider.text !== '' && !state.providers.some(provider => provider.id === state.provider.text)
            && <option value={state.provider.text}>{state.provider.text}（不可用）</option>}
          {state.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <p className={styles['hint']}>跟随选项使用本次任务的 Provider。API Key、接口地址和模型请在“模型”中配置。</p>
      {state.providerError && <p role="alert">读取搜索 Provider 失败</p>}
      <ValueField
        id="plugin-config-web-search-max-uses"
        label={t('webSearchMaxUses')}
        hint={t('webSearchMaxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxUses}
        onEdit={(text) => { props.edit('maxUses', text) }}
        onReset={() => { props.resetField('maxUses') }}
      />
    </PluginCard>
  )
}
