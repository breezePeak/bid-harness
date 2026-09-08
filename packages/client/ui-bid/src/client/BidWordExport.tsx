/** Word 格式编辑页；保存、解析、预览和生成都由明确的用户操作触发。 */
import { useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DOCX_TEMPLATE_MAX_BYTES } from '@deepseek-ai/dsh-bid/control-plane'
import type { DocxFormatRequest, DocxFormatView, DocxFormatSuggestion, FormatValues } from '@deepseek-ai/dsh-bid/control-plane'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidWordExport.module.css'
const OPTION_LABELS: Record<string, string> = {
  mm: '毫米', chars: '字符',
  portrait: '纵向', landscape: '横向', left: '左对齐', center: '居中', right: '右对齐', both: '两端对齐',
  auto: '倍数行距', exact: '固定值', atLeast: '最小值', decimal: '十进制', template: '自定义 / 模板编号', none: '无',
  upperRoman: '大写罗马数字', lowerRoman: '小写罗马数字', upperLetter: '大写字母', lowerLetter: '小写字母', chineseCounting: '中文数字',
  single: '单线', nil: '无边框', double: '双线', dashed: '虚线', current: '当前页码', total: '当前页 / 总页数',
}
export interface BidWordExportInjected {
  getFormat: () => Promise<DocxFormatView>
  saveFormat: (request: DocxFormatRequest) => Promise<DocxFormatView>
  uploadTemplate: (file: File, revision: number) => Promise<DocxFormatView>
  preview: () => Promise<DocxFormatView>
  generate: () => Promise<{
    path: string
  }>
  download: () => Promise<void>
  suggest: () => Promise<DocxFormatSuggestion>
}
/** 项目级配置编辑和沙箱内的样式预览。 */
export function BidWordExport({ sessionId,
  useSessions,
  useProjection,
  getFormat,
  saveFormat,
  uploadTemplate,
  preview,
  generate,
  download,
  suggest }: ConvViewProps & BidWordExportInjected) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [view, setView] = useState<DocxFormatView | null>(null)
  const [draft, setDraft] = useState<DocxFormatRequest | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('正在读取配置…')
  const [dirty, setDirty] = useState(false)
  const [suggestion, setSuggestion] = useState<DocxFormatSuggestion | null>(null)
  const [previewView, setPreviewView] = useState<DocxFormatView | null>(null)
  const ready = projection?.allowedActions.includes('export_docx') ?? (projection?.runtime.status === 'completed' && ['chapter_writing',
    'docx_export'].includes(projection.runtime.stage))
  const load = (next: DocxFormatView): void => {
    setView(next)
    setDraft({ revision: next.state.revision,
      source: next.state.source,
      overrides: next.state.overrides,
      mapping: next.state.mapping,
      description: next.state.description })
    setDirty(false)
  }
  useEffect(() => {
    if (!isBid)
      return
    let disposed = false
    void getFormat().then((next) => { if (!disposed) {
      load(next)
      setStatus('配置已读取')
    } }, (reason: unknown) => { if (!disposed)
      setError(reason instanceof Error ? reason.message : '配置读取失败。') })
    return () => { disposed = true }
  }, [getFormat, isBid, sessionId])
  if (!isBid)
    return null
  const perform = (label: string, action: () => Promise<void>): void => {
    if (busy)
      return
    setBusy(label)
    setError('')
    void action().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : '操作失败，请重试。'); setStatus('失败') }).finally(() => { setBusy('') })
  }
  const edit = (key: string, value: string | number | boolean): void => {
    if (!draft)
      return
    setDraft({ ...draft, overrides: { ...draft.overrides, [key]: value } })
    setDirty(true)
    setStatus('配置已修改，预览和文件需要更新')
  }
  const save = async (): Promise<void> => {
    if (!draft)
      return
    const next = await saveFormat(draft)
    load(next)
    setStatus('配置已保存，预览和文件需要更新')
  }
  const values: FormatValues = { ...view?.values, ...draft?.overrides }
  const groups = [...new Set(view?.fields.map(field => field.group))]
  const stale = dirty || (view?.state.lastExport !== undefined && view.fingerprint !== view.state.lastExport.fingerprint)
  const previewStale = dirty || (previewView !== null && previewView.fingerprint !== view?.fingerprint)
  const templateMaxBytes = view?.templateMaxBytes ?? DOCX_TEMPLATE_MAX_BYTES
  const templateMaxMiB = Math.floor(templateMaxBytes / 1024 / 1024)
  const unresolvedRoles = draft?.source === 'template' ? [...new Set(Object.entries(view?.sources ?? {})
    .filter(([key, source]) => source === '待确认' && draft.overrides[key] === undefined && !draft.mapping[key.slice(0, key.indexOf('.'))])
    .map(([key]) => key.slice(0, key.indexOf('.'))))] : []
  const roleLabel = (role: string): string => view?.fields.find(field => field.key === `${role}.font`)?.label.replace('中文字体', '') ?? role
  return <section className={css.root} aria-label="导出 Word" data-conversation-composer-overlay="">
    <header className={css.toolbar}><strong>导出 Word</strong></header>
    <div className={css.columns}>
      <div className={css.config}>
        <fieldset disabled={Boolean(busy) || !draft}>
          <legend>格式来源</legend>
          <label>来源<select aria-label="格式来源" value={draft?.source ?? 'default'} onChange={(event) => {
            if (!draft)
              return
            setDraft({ ...draft, source: event.target.value as 'default' | 'template' })
            setDirty(true)
          }}><option value="default">默认样式</option><option value="template" disabled={!view?.state.template}>已上传模板</option></select></label>
          <Button onClick={() => { perform('读取已保存配置…', async () => { load(await getFormat()); setStatus('已恢复保存配置') }) }}>使用已保存配置</Button>
          <label>上传 DOCX 模板（最多 {templateMaxMiB} MiB）<input aria-label="上传 DOCX 模板" type="file" accept=".docx" onClick={(event) => { event.currentTarget.value = '' }} onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file || !draft)
              return
            perform(`正在上传并解析模板：${file.name}`, async () => {
              if (file.size > templateMaxBytes)
                throw new Error(`模板文件不能超过 ${String(templateMaxMiB)} MiB。`)
              let revision = draft.revision
              if (dirty) {
                const saved = await saveFormat(draft)
                load(saved)
                revision = saved.state.revision
              }
              load(await uploadTemplate(file, revision))
              setStatus('模板已解析；请检查来源、候选和默认补充项')
            })
          }}/></label>
          {view?.state.template && <p>当前模板：{view.state.template.name}。更换模板保留用户修改；旧模板按文件标识保存。</p>}
          <label>格式描述<textarea aria-label="格式描述" value={draft?.description ?? ''} maxLength={4000} onChange={(event) => { if (draft) {
            setDraft({ ...draft, description: event.target.value })
            setDirty(true)
          } }}/></label>
          <p>格式描述不会直接改写配置；请核对建议或在下方手动设置实际值。</p>
          <Button onClick={() => { perform('正在理解格式要求…', async () => { if (dirty)
            await save(); setSuggestion(await suggest()); setStatus('建议待确认，尚未生效') }) }}>识别格式要求与模糊样式</Button>
          {suggestion && <div>
            <p>应用后将覆盖以下设置：</p>
            <ul>{Object.entries(suggestion.overrides).map(([key,
              value]) => <li key={key}>
              {view?.fields.find(field => field.key === key)?.label ?? key}：{String(values[key])} → {String(value)}
                ；依据：{suggestion.evidence[key]}</li>)}
            {Object.entries(suggestion.mapping).map(([role,
              id]) => <li key={role}>{role} → {view?.state.template?.candidates.find(item => item.id === id)?.name}</li>)}
            </ul>
            <Button onClick={() => { if (draft) {
              setDraft({ ...draft,
                overrides: { ...draft.overrides,
                  ...suggestion.overrides },
                mapping: { ...draft.mapping,
                  ...suggestion.mapping } })
              setDirty(true)
              setSuggestion(null)
              setStatus('建议已应用到草稿，请保存配置')
            } }}>应用这些建议</Button>
            <Button onClick={() => { setSuggestion(null) }}>放弃建议</Button>
          </div>}
        </fieldset>
        {view?.state.template && draft?.source === 'template' && <details open><summary>模板样式映射与待确认候选</summary>
          {['title',
            'heading1',
            'heading2',
            'heading3',
            'heading4',
            'heading5',
            'heading6',
            'body',
            'tableHeader',
            'tableCell',
            'figureCaption',
            'tableCaption',
            'header',
            'footer'].map((role) => {
            const candidate = (view.state.template?.candidates ?? []).find(item => item.id === draft.mapping[role])
            const candidates = view.state.template?.candidates ?? []
            const hasRole = candidates.some(item => item.role === role)
            const label = view.fields.find(field => field.key === `${role}.font`)?.label.replace('中文字体', '') ?? role
            return <div key={role}><label>{label}<select aria-label={`${label}模板映射`} disabled={Boolean(busy)} value={draft.mapping[role] ?? ''} onChange={(event) => {
              const mapping = Object.fromEntries(Object.entries(draft.mapping).filter(([key]) => key !== role))
              if (event.target.value)
                mapping[role] = event.target.value
              setDraft({ ...draft, mapping })
              setDirty(true)
            }}><option value="">未映射（请检查默认补充或待确认项）</option><option value="__default__">明确使用默认方案</option>{candidates.filter(item => item.role === role || item.id === draft.mapping[role] || !hasRole && !item.role).map(item => <option key={item.id} value={item.id}>{item.name} — {item.sample || '未使用的样式'}</option>)}</select></label>
            {candidate ? <small>{Object.entries(candidate.values).map(([key,
              value]) => `${key}=${String(value)}`).join('；')}</small> : <small>{draft.mapping[role] === '__default__' ? '已选择默认方案。' : '未映射；请核对下方字段来源。'}</small>}
            </div>
          })}
        </details>}
        {groups.map(group => <details key={group}><summary>{group}</summary><fieldset disabled={Boolean(busy)}>
          {view?.fields.filter(field => field.group === group).map(field => <label key={field.key} className={css.field}>
            <span>{field.label}<small>{draft?.overrides[field.key] !== undefined ? '用户修改' : view.sources[field.key]}{dirty ? ' · 保存后计算最终值' : ''}</small></span>
            {field.options ? <select aria-label={field.label} value={String(values[field.key])} onChange={(event) => { edit(field.key,
              event.target.value) }}>
              {field.options.map(option => <option key={option} value={option}>{OPTION_LABELS[option] ?? option}</option>)}
            </select>
              : typeof field.value === 'boolean' ? <input aria-label={field.label} type="checkbox" checked={Boolean(values[field.key])} onChange={(event) => { edit(field.key,
                event.target.checked) }}/>
                : <input aria-label={field.label} type={typeof field.value === 'number' ? 'number' : 'text'} min={field.min} max={field.max} step="any" value={String(values[field.key] ?? '')} onChange={(event) => { edit(field.key,
                  typeof field.value === 'number' ? Number(event.target.value) : event.target.value) }}/>}
            {draft?.overrides[field.key] !== undefined && <button type="button" onClick={() => { const overrides = Object.fromEntries(Object.entries(draft.overrides).filter(([key]) => key !== field.key)); setDraft({ ...draft,
              overrides }); setDirty(true) }}>恢复来源值</button>}
          </label>)}</fieldset></details>)}
        <Button disabled={!draft || Boolean(busy)} onClick={() => { perform('保存配置…', save) }}>保存配置</Button>
        {dirty && <p>本次覆盖：{Object.keys(draft?.overrides ?? {}).map(key => view?.fields.find(field => field.key === key)?.label ?? key).join('、') || '格式来源或样式映射'}。</p>}
        {view?.state.previous && <details><summary>与更换前配置比较：{view.state.previous.name}</summary><ul>
          {view.fields.filter(field => view.state.previous?.values[field.key] !== view.values[field.key]).map(field => <li key={field.key}>
            {field.label}：{String(view.state.previous?.values[field.key])} → {String(view.values[field.key])}
          </li>)}
        </ul></details>}
        {view?.warnings.map(message => <p key={message} className={css.notice}>{message}</p>)}
      </div>
      <div className={css.preview}>
        <div className={css.toolbar}>
          <Button disabled={!draft || Boolean(busy)} onClick={() => { perform('正在更新预览…', async () => { if (dirty)
            await save(); const next = await preview(); load(next); setPreviewView(next); setStatus('预览已更新，可生成') }) }}>更新预览</Button>
          <Button variant="primary" disabled={!ready || !draft || Boolean(busy) || unresolvedRoles.length > 0} onClick={() => { perform('正在生成 Word…',
            async () => { if (dirty)
              await save(); await generate(); load(await getFormat()); setStatus('Word 生成成功') }) }}>生成 Word</Button>
          {view?.state.lastExport && <Button disabled={Boolean(busy)} onClick={() => { perform('正在下载…', download) }}>下载文件</Button>}
        </div>
        <p role="status">{busy || status}</p>
        {error && <p role="alert" className={css.notice}>{error}</p>}
        {unresolvedRoles.length > 0 && <div>
          <p>生成前请确认以下样式：{unresolvedRoles.map(roleLabel).join('、')}。可在左侧选择模板样式，或使用默认方案。</p>
          <Button disabled={Boolean(busy)} onClick={() => { if (draft) {
            setDraft({ ...draft, mapping: { ...draft.mapping, ...Object.fromEntries(unresolvedRoles.map(role => [role, '__default__'])) } })
            setDirty(true)
            setStatus('未确认项已选择默认方案，生成时保存配置')
          } }}>未确认项使用默认方案</Button>
        </div>}
        <p>样式预览，分页以 Word 为准。{stale && view?.state.lastExport ? '已有文件可能过期，请重新生成。' : ''}</p>
        {previewStale && <p>旧预览需要更新。</p>}
        {!ready && <p>正文编写完成后才能生成 Word。</p>}
        {previewView?.previewHtml ? <iframe title="Word 样式预览" sandbox="" srcDoc={previewView.previewHtml} className={css.frame}/> : <p>点击“更新预览”查看当前格式。切换页面不会自动解析模板或生成文件。</p>}
      </div>
    </div>
  </section>
}
