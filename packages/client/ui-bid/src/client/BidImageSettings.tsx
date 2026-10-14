/** 标书作图地址和项目默认模型设置，认证沿用 pp 配置。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidImageSettings.module.css'

/** 已读取的作图配置及其设置写入权限。 */
export interface BidImageSettingsView {
  baseURL: string
  effectiveBaseURL: string
  model: string
  credentialConfigured: boolean
  error?: string | undefined
  revision: number
  writable: boolean
}

/** 设置卡片只接收非敏感配置和带版本的保存操作。 */
export interface BidImageSettingsInjected {
  load: () => Promise<BidImageSettingsView>
  getModels: () => Promise<string[]>
  save: (config: { baseURL: string; model: string }, revision: number) => Promise<BidImageSettingsView>
}

/**
 * 显示作图配置，失败时保留编辑内容。
 * @param props 非敏感读取、模型目录和配置保存操作。
 * @returns 标书作图设置卡片。
 */
export function BidImageSettings({ load, getModels, save }: BidImageSettingsInjected) {
  const [view, setView] = useState<BidImageSettingsView | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const modelRequest = useRef(0)
  const live = useRef(false)

  useEffect(() => {
    live.current = true
    let current = true
    setError(null)
    void load().then((next) => {
      if (!current) return
      setView(next)
      setBaseURL(next.baseURL)
      setModel(next.model)
    }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false; live.current = false; modelRequest.current++ }
  }, [load, attempt])

  const refreshModels = useCallback(async (): Promise<void> => {
    const request = ++modelRequest.current
    setLoadingModels(true)
    setModelError(null)
    await getModels().then((next) => {
      if (live.current && request === modelRequest.current) setModels(next)
    }).catch((reason: unknown) => {
      if (live.current && request === modelRequest.current) setModelError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (live.current && request === modelRequest.current) setLoadingModels(false)
    })
  }, [getModels])

  useEffect(() => { void refreshModels() }, [refreshModels, attempt])

  const submit = async (): Promise<void> => {
    if (view === null || saving) return
    setSaving(true)
    setSaved(false)
    setError(null)
    await save({ baseURL: baseURL.trim(), model }, view.revision).then((next) => {
      if (!live.current) return
      setView(next)
      setBaseURL(next.baseURL)
      setModel(next.model)
      setSaved(true)
      void refreshModels()
    }).catch((reason: unknown) => {
      if (live.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (live.current) setSaving(false)
    })
  }

  const disabled = view === null || !view.writable || saving
  return <section className={css.section} aria-label="标书作图设置">
    <h2>标书作图</h2>
    <p className={css.hint}>S5 按章节需要生成图片，同一项目沿用统一风格和作图模型。</p>
    {view === null && !error && <p role="status">正在读取作图配置…</p>}
    <label className={css.field}>
      <span>作图接口地址</span>
      <Input aria-label="作图接口地址" value={baseURL} disabled={disabled}
        placeholder={view?.effectiveBaseURL || '留空沿用当前 CPA 地址'}
        onChange={(event) => { setBaseURL(event.target.value); setSaved(false) }} />
    </label>
    <p className={css.hint}>留空沿用当前 CPA 地址。修改地址并保存后，再刷新模型列表。</p>
    <label className={css.field}>
      <span>作图模型</span>
      <select aria-label="作图模型" value={model} disabled={disabled} className={css.select}
        onChange={(event) => { setModel(event.target.value); setSaved(false) }}>
        <option value="">未启用作图</option>
        {model !== '' && !models.includes(model) && <option value={model}>{model}</option>}
        {models.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
    <div className={css.actions}>
      <Button size="sm" variant="outline" disabled={loadingModels || saving} onClick={() => { void refreshModels() }}>
        {loadingModels ? '正在读取模型…' : '刷新模型'}
      </Button>
      <Button size="sm" variant="primary" disabled={disabled} onClick={() => { void submit() }}>{saving ? '正在保存…' : '保存配置'}</Button>
    </div>
    {view && <p className={css.hint}>{view.credentialConfigured ? '认证沿用 pp 已配置的密钥。' : 'pp 尚未配置可用密钥，请先在模型设置中完成配置。'}</p>}
    {view?.error && <p role="alert">{view.error}</p>}
    {view && !view.writable && <p className={css.hint}>当前连接不允许修改设置。</p>}
    {saved && <p role="status">作图配置已保存。</p>}
    {modelError && <p role="alert">模型列表读取失败：{modelError}</p>}
    {error && <p role="alert">{error}</p>}
    {error && <Button size="sm" disabled={saving} onClick={() => { setSaved(false); setAttempt(value => value + 1) }}>重新读取配置</Button>}
  </section>
}
