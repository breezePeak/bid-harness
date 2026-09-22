/** 项目 Word 模板选择、独立冲突确认、分页预估和导出页。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  BidDocxExportResult,
  BidPageEstimate,
  DocxFormatRequest,
  DocxFormatView,
  DocxTemplateId,
  DocxTemplateLibraryView,
  FormatConflict,
  FormatField,
  FormatRole,
  FormatValue,
  FormatValues,
  StageValidationIssue,
} from '@deepseek-ai/dsh-bid/control-plane'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidWordExport.module.css'
import { isBidMainSessionSummary } from './session-authority.ts'

const ROWS: Array<{ role: FormatRole; label: string }> = [
  { role: 'heading1', label: '一级标题' },
  { role: 'heading2', label: '二级标题' },
  { role: 'body', label: '正文' },
  { role: 'figureCaption', label: '图题' },
  { role: 'tableCaption', label: '表题' },
]
const ALIGNMENT_LABELS: Record<string, string> = { left: '左对齐', center: '居中', right: '右对齐', both: '两端对齐' }
const CHINESE_SIZE_LABELS: Record<string, string> = {
  42: '初号', 36: '小初', 26: '一号', 24: '小一', 22: '二号', 18: '小二', 16: '三号', 15: '小三',
  14: '四号', 12: '小四', 10.5: '五号', 9: '小五', 7.5: '六号', 6.5: '小六', 5.5: '七号', 5: '八号',
}
const SUMMARY_KEYS = new Set(ROWS.flatMap(({ role }) => ['font', 'latinFont', 'size', 'alignment', 'line', 'lineRule',
  'firstLine', 'firstLineUnit'].map(key => `${role}.${key}`)))

export interface BidWordExportInjected {
  getLibrary: () => Promise<DocxTemplateLibraryView>
  getFormat: (templateId: DocxTemplateId | null) => Promise<DocxFormatView>
  saveFormat: (templateId: DocxTemplateId | null, request: DocxFormatRequest) => Promise<DocxFormatView>
  uploadTemplate: (file: File, revision: number) => Promise<DocxFormatView>
  preview: (templateId: DocxTemplateId | null) => Promise<DocxFormatView>
  estimatePages: (templateId: DocxTemplateId | null) => Promise<BidPageEstimate>
  setEstimateTemplate: (templateId: DocxTemplateId | null, revision: number) => Promise<DocxTemplateLibraryView>
  generate: (templateId: DocxTemplateId | null) => Promise<Extract<BidDocxExportResult, { ok: true }>['value']>
  download: (templateId: DocxTemplateId | null) => Promise<void>
}

const displayValue = (value: FormatValue): string => typeof value === 'boolean' ? value ? '是' : '否' : String(value)
const displaySize = (value: FormatValue): string => {
  const points = displayValue(value)
  const named = CHINESE_SIZE_LABELS[points]
  return named ? `${named}（${points}pt）` : `${points}pt`
}
const estimateLabel = (value: BidPageEstimate | undefined): string => value?.status === 'available'
  ? `${value.method === 'rendered' ? '预计导出' : '约'} ${value.pages} 页`
  : value?.status === 'empty' ? '正文尚未生成' : value?.status === 'unavailable' ? '页数暂不可用' : '正在测算…'
const templateEstimateKey = (id: DocxTemplateId | null): string => id ?? 'default'
const exportErrorMessage = (reason: unknown): string => {
  if (!(reason instanceof Error)) return 'Word 导出失败，请重试。'
  const issue = (reason as Error & { readonly issues?: readonly StageValidationIssue[] }).issues?.[0]
  return issue === undefined ? reason.message : `${issue.message} (${issue.code})`
}

/** 项目级模板库、冲突确认和样式预览。 */
export function BidWordExport({
  sessionId, useSessions, useProjection, getLibrary, getFormat, saveFormat,
  uploadTemplate, preview, estimatePages, setEstimateTemplate: _setEstimateTemplate, generate, download,
}: ConvViewProps & BidWordExportInjected) {
  const isBid = useSessions(state => isBidMainSessionSummary(state.byId[sessionId]))
  const projection = useProjection('bid.runtime')
  const [library, setLibrary] = useState<DocxTemplateLibraryView | null>(null)
  const [selectedId, setSelectedId] = useState<DocxTemplateId | null>(null)
  const [view, setView] = useState<DocxFormatView | null>(null)
  const [estimates, setEstimates] = useState<ReadonlyMap<string, BidPageEstimate>>(() => new Map())
  const [previewHtml, setPreviewHtml] = useState('')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [formatVisible, setFormatVisible] = useState(false)
  const [editingKeys, setEditingKeys] = useState<string[] | null>(null)
  const [formatDraft, setFormatDraft] = useState<FormatValues>({})
  const [savingFormat, setSavingFormat] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [exportFeedback, setExportFeedback] = useState<{ status: 'success' | 'error'; text: string } | null>(null)
  const editFormatButton = useRef<HTMLButtonElement | null>(null)
  const ready = projection?.allowedActions.includes('export_docx') ?? (projection?.task.status === 'completed' && ['chapter_writing',
    'docx_export'].includes(projection.task.stage))

  const triggerEstimate = useCallback((templateId: DocxTemplateId | null): void => {
    void estimatePages(templateId).then((value) => {
      setEstimates(current => new Map(current).set(templateEstimateKey(templateId), value))
    }).catch(() => {})
  }, [estimatePages])

  const loadTemplate = useCallback(async (
    templateId: DocxTemplateId | null,
    active: () => boolean = () => true,
  ): Promise<void> => {
    const [next, rendered] = await Promise.all([getFormat(templateId), preview(templateId)])
    if (!active()) return
    setSelectedId(templateId)
    setView(next)
    setLibrary(next.library)
    setPreviewHtml(rendered.previewHtml ?? '')
    setFormatVisible(true)
    triggerEstimate(templateId)
  }, [getFormat, preview, triggerEstimate])

  useEffect(() => {
    if (!isBid) return
    let disposed = false
    const active = (): boolean => !disposed
    void getLibrary().then(async (next) => {
      if (disposed) return
      setLibrary(next)
      const initial = next.estimateTemplateId ?? next.templates[0]?.id ?? null
      await loadTemplate(initial, active)
      if (!active()) return
      for (const template of next.templates) {
        if (template.id === initial) continue
        triggerEstimate(template.id)
      }
      if (initial !== null) triggerEstimate(null)
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Word 模板库读取失败。') })
    return () => { disposed = true }
  }, [getLibrary, isBid, loadTemplate, sessionId, triggerEstimate])
  if (!isBid) return null

  const perform = (label: string, action: () => Promise<void>): void => {
    if (busy) return
    setBusy(label); setError(''); setStatus('')
    void action().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') })
      .finally(() => { setBusy('') })
  }
  const choose = (templateId: DocxTemplateId | null): void => {
    if (templateId === selectedId || busy) return
    perform('正在切换模板…', async () => {
      setFormatVisible(false); setPreviewHtml(''); setEditingKeys(null)
      await loadTemplate(templateId)
    })
  }
  const unresolved = view?.state.conflicts.filter(conflict => conflict.status === 'conflict') ?? []
  const otherConflicts = unresolved.filter(conflict => !SUMMARY_KEYS.has(conflict.key))
  const conflictFor = (keys: string[]): FormatConflict | undefined => unresolved.find(conflict => keys.includes(conflict.key))
  const templateMaxBytes = library?.templateMaxBytes ?? 0
  const templateMaxMiB = Math.floor(templateMaxBytes / 1024 / 1024)
  const partialExportMessage = projection?.task.stage === 'chapter_writing' && projection.task.status !== 'completed'
    ? '按目录导出所有已保存正文；缺失正文的章节会保留标题并标注。'
    : ''
  const value = (key: string): FormatValue => view?.state.resolved[key] ?? ''
  const openFormatEditor = (keys?: string[]): void => {
    if (!view) return
    const selectedKeys = keys ?? view.fields.map(field => field.key)
    const selected = new Set(selectedKeys)
    setFormatDraft(Object.fromEntries(view.fields.filter(field => selected.has(field.key))
      .map(field => [field.key, view.state.resolved[field.key] ?? field.value])))
    setEditingKeys(selectedKeys)
  }
  const cell = (keys: string[], text: string) => {
    const conflict = conflictFor(keys)
    return <td className={conflict ? css.conflict : undefined}><button type="button" aria-label={`修改${text}`} onClick={() => { openFormatEditor(keys) }}>{text}</button></td>
  }
  const editingKeySet = new Set(editingKeys ?? [])
  const editingFields = (view?.fields ?? []).filter(field => editingKeySet.has(field.key))
  const fieldGroups = editingFields.reduce<Record<string, FormatField[]>>((groups, field) => {
    (groups[field.group] ??= []).push(field)
    return groups
  }, {})
  const formatInput = (field: FormatField) => {
    if (typeof field.value === 'boolean') return <input type="checkbox" checked={Boolean(formatDraft[field.key])}
      onChange={(event) => { setFormatDraft(current => ({ ...current, [field.key]: event.target.checked })) }}/>
    if (field.options !== undefined) return <select value={String(formatDraft[field.key] ?? field.value)}
      onChange={(event) => { setFormatDraft(current => ({ ...current, [field.key]: event.target.value })) }}>
      {field.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
    return <input type={typeof field.value === 'number' ? 'number' : 'text'} min={field.min} max={field.max}
      step={typeof field.value === 'number' ? 'any' : undefined} value={String(formatDraft[field.key] ?? field.value)}
      onChange={(event) => { setFormatDraft(current => ({ ...current,
        [field.key]: typeof field.value === 'number' ? Number(event.target.value) : event.target.value })) }}/>
  }

  return <section className={css.root} aria-label="导出 Word" data-conversation-composer-overlay="">
    <header className={css.header}>
      <div className={css.headerTitleRow}>
        <strong>导出 Word</strong>
        {exportFeedback && (
          <span
            role="status"
            className={exportFeedback.status === 'success' ? css.exportFeedbackSuccess : css.exportFeedbackError}
          >
            {exportFeedback.text}
          </span>
        )}
      </div>
      <Button variant="primary" size="sm" disabled={!ready || !view || !formatVisible || Boolean(busy) || uploading} onClick={() => {
        if (unresolved.length) {
          const message = `当前模板仍有 ${String(unresolved.length)} 项格式差异，请先确认或修改。`
          setError(message)
          setExportFeedback({ status: 'error', text: message })
          editFormatButton.current?.focus()
          return
        }
        setExportFeedback(null)
        perform('正在导出 Word…', async () => {
          try {
            const result = await generate(selectedId)
            await download(selectedId)
            setView(await getFormat(selectedId))
            const message = result.warnings?.map(warning => warning.message).join('；') || 'Word 导出完成'
            setStatus(message)
            setExportFeedback({ status: 'success', text: message })
          } catch (reason: unknown) {
            const message = exportErrorMessage(reason)
            setExportFeedback({ status: 'error', text: message })
          }
        })
      }}>导出 Word</Button>
    </header>
    <div className={css.columns}>
      <div className={css.left}>
        <section className={css.templateLibrary} aria-label="Word 模板">
          <h2>Word 模板</h2>
          <div className={css.actionGroup}>
            <label
              className={`${css.uploadTrigger} ${uploading || Boolean(busy) ? css.uploadTriggerDisabled : ''}`}
              title={uploading ? '正在上传模板…' : '上传新模板'}
              onClick={(event) => {
                if (uploading || Boolean(busy)) {
                  event.preventDefault()
                }
              }}
            >
              {uploading ? (
                <span className={css.uploadSpinner} aria-hidden="true" />
              ) : (
                <IconPlusOutline16 size={14} className={css.uploadIcon} />
              )}
              <strong>{uploading ? '正在上传模板…' : '上传新模板'}</strong>
              <input
                aria-label="上传 Word 模板"
                className={css.hiddenFileInput}
                type="file"
                accept=".docx"
                disabled={uploading || Boolean(busy)}
                onClick={(event) => {
                  if (uploading || Boolean(busy)) {
                    event.preventDefault()
                    return
                  }
                  event.currentTarget.value = ''
                }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file || !library || uploading || Boolean(busy)) return
                  setUploading(true)
                  perform('正在解析模板…', async () => {
                    try {
                      if (file.size > templateMaxBytes) throw new Error(`模板文件不能超过 ${String(templateMaxMiB)} MiB。`)
                      const next = await uploadTemplate(file, library.revision)
                      setLibrary(next.library); setSelectedId(next.templateId); setView(next)
                      setFormatVisible(true); setEditingKeys(null)
                      const rendered = await preview(next.templateId)
                      setPreviewHtml(rendered.previewHtml ?? '')
                      triggerEstimate(next.templateId)
                      setStatus(next.warnings.find(warning => warning.startsWith('模板解析完成；自动格式解释未应用')) ?? '模板已加入项目模板库')
                    } finally {
                      setUploading(false)
                    }
                  })
                }}
              />
            </label>
            <span className={css.uploadHint}>选择 .docx 文件（最多 {templateMaxMiB} MiB）</span>
          </div>
          <label className={`${css.templateOption} ${selectedId === null ? css.templateOptionSelected : ''}`}>
            <input type="radio" name="word-template" checked={selectedId === null} onChange={() => { choose(null) }}/>
            <div className={css.templateInfo}>
              <div className={css.templateTitleRow}>
                <strong className={css.templateName}>系统默认模板</strong>
                {library?.estimateTemplateId === null && <span className={css.benchmarkBadge}>页数基准</span>}
              </div>
            </div>
            <span className={css.templateMeta}>{estimateLabel(estimates.get('default'))}</span>
          </label>
          {library?.templates.map((template) => {
            const isSelected = selectedId === template.id
            const isBenchmark = library.estimateTemplateId === template.id
            return (
              <label key={template.id} className={`${css.templateOption} ${isSelected ? css.templateOptionSelected : ''}`}>
                <input type="radio" name="word-template" checked={isSelected} onChange={() => { choose(template.id) }}/>
                <div className={css.templateInfo}>
                  <div className={css.templateTitleRow}>
                    <strong className={css.templateName}>{template.name}</strong>
                    {isBenchmark && <span className={css.benchmarkBadge}>页数基准</span>}
                  </div>
                </div>
                <span className={css.templateMeta}>
                  <span>{estimateLabel(estimates.get(template.id))}</span>
                  {template.conflictCount > 0 ? (
                    <span className={css.conflictText}> · {String(template.conflictCount)} 项模板内格式差异</span>
                  ) : (
                    <span className={css.noConflictText}> · 无模板内格式差异</span>
                  )}
                </span>
              </label>
            )
          })}
        </section>
        {(busy || status || partialExportMessage) && (
          <p role="status" className={css.status}>{busy || status || partialExportMessage}</p>
        )}
        {error && <p role="alert" className={css.error}>{error}</p>}
        {formatVisible && view && <>
          <div className={css.summaryHeader}>
            <strong>当前模板主要格式</strong>
            <button ref={editFormatButton} type="button" className={css.editAllButton} onClick={() => { openFormatEditor() }}>修改全部参数</button>
          </div>
          <p className={css.formatHint}>所有参数在确认前后均可修改；模板值和系统默认值只提供初始结果。</p>
          <table className={css.summary}>
            <caption className={css.visuallyHidden}>当前模板主要格式</caption>
            <thead><tr><th>类型</th><th>字体</th><th>字号</th><th>对齐</th><th>行距</th><th>缩进</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{ROWS.map(({ role, label }) => {
              const roleConflicts = unresolved.filter(conflict => conflict.key.startsWith(`${role}.`))
              return <tr key={role} className={roleConflicts.length ? css.conflictRow : undefined}>
                <th scope="row">{label}</th>
                {cell([`${role}.font`, `${role}.latinFont`], `${displayValue(value(`${role}.font`))} / ${displayValue(value(`${role}.latinFont`))}`)}
                {cell([`${role}.size`], displaySize(value(`${role}.size`)))}
                {cell([`${role}.alignment`], ALIGNMENT_LABELS[String(value(`${role}.alignment`))] ?? displayValue(value(`${role}.alignment`)))}
                {cell([`${role}.line`, `${role}.lineRule`], displayValue(value(`${role}.line`)))}
                {cell([`${role}.firstLine`, `${role}.firstLineUnit`], Number(value(`${role}.firstLine`)) === 0 ? '0' : `${displayValue(value(`${role}.firstLine`))}${value(`${role}.firstLineUnit`) === 'chars' ? '字符' : 'mm'}`)}
                <td className={roleConflicts.length ? css.pending : undefined}>{roleConflicts.length ? '待确认' : '正常'}</td>
                <td><button type="button" onClick={() => { openFormatEditor(view.fields.filter(field => field.key.startsWith(`${role}.`)).map(field => field.key)) }}>修改</button></td>
              </tr>
            })}</tbody>
          </table></>}
        {formatVisible && otherConflicts.length > 0 && <div className={css.otherConflicts} aria-label="其他模板内格式差异"><strong>其他待确认</strong>
          {otherConflicts.map(conflict => <button key={conflict.key} type="button" onClick={() => { openFormatEditor([conflict.key]) }}>
            {view?.fields.find(field => field.key === conflict.key)?.label ?? conflict.key}：{displayValue(conflict.resolvedValue)}
          </button>)}</div>}
      </div>
      <div className={css.preview}>{formatVisible ? previewHtml
        ? <iframe title="Word 效果预览" sandbox="" srcDoc={previewHtml} className={css.frame}/>
        : <p>正在生成 Word 效果预览…</p> : <p>正在读取所选模板。</p>}</div>
    </div>
    {editingKeys && view && <div className={css.backdrop}><div role="dialog" aria-modal="true" aria-labelledby="word-format-title" className={`${css.dialog} ${css.formatDialog}`}>
      <h2 id="word-format-title">{editingKeys.length === view.fields.length ? '修改全部 Word 参数' : editingFields.length === 1 ? `修改${editingFields[0]?.label ?? '参数'}` : '修改所选 Word 参数'}</h2>
      <p className={css.dialogHint}>保存后立即覆盖当前模板的生效格式，之后仍可再次修改。</p>
      <div className={css.formatFields}>{Object.entries(fieldGroups).map(([group, fields]) => <fieldset key={group}>
        <legend>{group}</legend>
        <div className={css.fieldGrid}>{fields.map(field => <label key={field.key}>
          <span>{field.label}</span>
          {formatInput(field)}
        </label>)}</div>
      </fieldset>)}</div>
      <div className={css.dialogActions}><Button onClick={() => { setEditingKeys(null) }}>取消</Button><Button variant="primary" disabled={savingFormat} onClick={() => {
        if (savingFormat) return
        setSavingFormat(true)
        setError('')
        void saveFormat(selectedId, {
          revision: view.state.revision,
          userConfirmed: { ...view.state.userConfirmed, ...formatDraft },
        }).then((next) => {
          setView(next)
          setLibrary(next.library)
          setEditingKeys(null)
          setStatus('Word 参数已保存，仍可继续修改')
          void preview(selectedId).then((rendered) => {
            setPreviewHtml(rendered.previewHtml ?? '')
          }).catch(() => {})
        }).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
        }).finally(() => {
          setSavingFormat(false)
        })
      }}>{editingKeys.length === view.fields.length ? '保存全部参数' : '保存修改'}</Button></div>
    </div></div>}
  </section>
}
