/** Global model selection persisted through the existing settings write path. */

import { useEffect, useState } from 'react'
import type { IApiClient, SettingsNamespaceView, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import styles from './ModelsSection.module.css'

/** Props for the global default selection card. */
export interface DefaultProviderEditorProps {
  namespace: SettingsNamespaceView
  api: Pick<IApiClient, 'settings' | 'llm'>
  writable: boolean
  onSaved: () => void
}

/**
 * Render the default Provider and model in the existing Models page.
 * @param props - authoritative settings, catalog, and mutation face.
 * @returns a staged selection card; running Agents retain their selection.
 */
export function DefaultProviderEditor({ namespace, api, writable, onSaved }: DefaultProviderEditorProps) {
  const saved = namespace.value as { provider: string; model: string }
  const [provider, setProvider] = useState(saved.provider)
  const [model, setModel] = useState(saved.model)
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void api.llm.models({}).then((response) => {
      if (!active) return
      if (response.result.ok) setGroups(response.result.value.groups)
      else setError(response.result.error.message)
    }, () => { if (active) setError('读取模型列表失败') })
    return () => { active = false }
  }, [api.llm, namespace])
  const models = groups.find(group => group.id === provider)?.models ?? []
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await api.settings.mutate({
        ns: namespace.ns, expectedRevision: namespace.revision,
        ops: [
          { op: 'set', path: ['provider'], value: provider },
          { op: 'set', path: ['model'], value: model },
          { op: 'unset', path: ['reasoningEffort'] },
        ],
      })
      if (response.result.ok) onSaved()
      else setError(response.result.error.message)
    } catch { setError('保存默认 Provider 失败') } finally { setBusy(false) }
  }
  return <div className={styles['editor']}>
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>默认 Provider</span>
      <select aria-label="默认 Provider" className={styles['input']} value={provider} disabled={!writable || busy}
        onChange={(event) => { setProvider(event.target.value); setModel(groups.find(group => group.id === event.target.value)?.models[0]?.id ?? '') }}>
        {!groups.some(group => group.id === provider) && <option value={provider}>{provider}</option>}
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
    </label>
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>默认模型</span>
      <select aria-label="默认模型" className={styles['input']} value={model} disabled={!writable || busy}
        onChange={(event) => { setModel(event.target.value) }}>
        {!models.some(item => item.id === model) && <option value={model}>{model}</option>}
        {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <p className={styles['advancedHint']}>保存后新建的任务使用此 Provider；正在执行的任务保持原选择。</p>
    <button type="button" className={styles['secondaryButton']} disabled={!writable || busy || !models.some(item => item.id === model)
      || (provider === saved.provider && model === saved.model)} onClick={() => { void save() }}>
      {busy ? '保存中…' : '保存默认 Provider'}
    </button>
    {error && <p role="alert" className={styles['error']}>{error}</p>}
  </div>
}
