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
  FormatEvidenceSource,
  FormatRole,
  FormatValue,
} from '@deepseek-ai/dsh-bid/control-plane'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidWordExport.module.css'

const ROWS: Array<{ role: FormatRole; label: string }> = [
  { role: 'heading1', label: '一级标题' },
  { role: 'heading2', label: '二级标题' },
  { role: 'body', label: '正文' },
  { role: 'figureCaption', label: '图题' },
  { role: 'tableCaption', label: '表题' },
]
const SOURCE_LABELS: Record<FormatEvidenceSource, string> = {
  system_default: '系统默认值', doc_defaults: '文档默认格式', theme: 'Theme 字体', named_style: 'Word 样式',
  direct_format: '示例段落直接格式', template_instruction: '模板格式说明', user_requirement: '用户格式要求', user_confirmed: '用户确认',
}
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

const sameValue = (left: FormatValue, right: FormatValue): boolean => typeof left === typeof right && left === right
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

/** 项目级模板库、冲突确认和样式预览。 */
export function BidWordExport({ sessionId, useSessions, useProjection, getLibrary, getFormat, saveFormat,
  uploadTemplate, preview, estimatePages, setEstimateTemplate, generate, download }: ConvViewProps & BidWordExportInjected) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
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
  const [activeConflict, setActiveConflict] = useState<FormatConflict | null>(null)
  const [selected, setSelected] = useState<FormatValue | undefined>()
  const firstConflict = useRef<HTMLButtonElement | null>(null)
  const ready = projection?.allowedActions.includes('export_docx') ?? (projection?.runtime.status === 'completed' && ['chapter_writing',
    'docx_export'].includes(projection.runtime.stage))

  const loadTemplate = useCallback(async (
    templateId: DocxTemplateId | null,
    active: () => boolean = () => true,
  ): Promise<void> => {
    const [next, rendered, estimate] = await Promise.all([getFormat(templateId), preview(templateId), estimatePages(templateId)])
    if (!active()) return
    setSelectedId(templateId)
    setView(next)
    setLibrary(next.library)
    setPreviewHtml(rendered.previewHtml ?? '')
    setEstimates(current => new Map(current).set(templateEstimateKey(templateId), estimate))
    setFormatVisible(true)
  }, [estimatePages, getFormat, preview])

  useEffect(() => {
    if (!isBid) return
    let disposed = false
    void getLibrary().then(async (next) => {
      if (disposed) return
      setLibrary(next)
      const initial = next.estimateTemplateId ?? next.templates[0]?.id ?? null
      await loadTemplate(initial, () => !disposed)
      for (const template of next.templates) {
        if (template.id === initial) continue
        void estimatePages(template.id).then((value) => {
          if (!disposed) setEstimates(current => new Map(current).set(templateEstimateKey(template.id), value))
        }).catch(() => {})
      }
    }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Word 模板库读取失败。') })
    return () => { disposed = true }
  }, [estimatePages, getLibrary, isBid, loadTemplate, sessionId])
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
      setFormatVisible(false); setPreviewHtml(''); setActiveConflict(null)
      await loadTemplate(templateId)
    })
  }
  const refreshPreviewAndEstimate = async (templateId: DocxTemplateId | null): Promise<void> => {
    const [rendered, estimate] = await Promise.all([preview(templateId), estimatePages(templateId)])
    setPreviewHtml(rendered.previewHtml ?? '')
    setEstimates(current => new Map(current).set(templateEstimateKey(templateId), estimate))
  }
  const unresolved = view?.state.conflicts.filter(conflict => conflict.status === 'conflict') ?? []
  const otherConflicts = unresolved.filter(conflict => !SUMMARY_KEYS.has(conflict.key))
  const firstUnresolvedKey = unresolved[0]?.key
  const conflictFor = (keys: string[]): FormatConflict | undefined => unresolved.find(conflict => keys.includes(conflict.key))
  const templateMaxBytes = library?.templateMaxBytes ?? 0
  const templateMaxMiB = Math.floor(templateMaxBytes / 1024 / 1024)
  const partialExportMessage = projection?.runtime.stage === 'chapter_writing' && projection.runtime.status !== 'completed'
    ? '按目录导出所有已保存正文；缺失正文的章节会保留标题并标注。'
    : ''
  const value = (key: string): FormatValue => view?.state.resolved[key] ?? ''
  const cell = (keys: string[], text: string) => {
    const conflict = conflictFor(keys)
    return <td className={conflict ? css.conflict : undefined}>{conflict
      ? <button ref={conflict.key === firstUnresolvedKey ? firstConflict : undefined} type="button" onClick={() => { setActiveConflict(conflict); setSelected(conflict.resolvedValue) }}>{text}</button>
      : text}</td>
  }

  return <section className={css.root} aria-label="导出 Word" data-conversation-composer-overlay="">
    <header className={css.header}><strong>导出 Word</strong>
      <Button variant="primary" size="sm" disabled={!ready || !view || !formatVisible || Boolean(busy)} onClick={() => {
        if (unresolved.length) {
          setError(`当前仍有 ${String(unresolved.length)} 项格式冲突，请先确认。`); firstConflict.current?.focus(); return
        }
        perform('正在导出 Word…', async () => {
          const result = await generate(selectedId)
          await download(selectedId)
          setView(await getFormat(selectedId))
          setStatus(result.warnings?.map(warning => warning.message).join('；') || 'Word 导出完成')
        })
      }}>导出 Word</Button>
    </header>
    <div className={css.columns}>
      <div className={css.left}>
        <section className={css.templateLibrary} aria-label="Word 模板">
          <h2>Word 模板</h2>
          <p>模板只提供解析后的排版格式，不会进入招标资料库，也不保证复刻复杂封面、Logo 或多分节结构。</p>
          <label className={`${css.templateOption} ${selectedId === null ? css.templateOptionSelected : ''}`}>
            <input type="radio" name="word-template" checked={selectedId === null} onChange={() => { choose(null) }}/>
            <div className={css.templateInfo}>
              <div className={css.templateTitleRow}>
                <strong className={css.templateName}>系统默认格式</strong>
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
                    <span className={css.conflictText}> · {String(template.conflictCount)} 项格式冲突</span>
                  ) : (
                    <span className={css.noConflictText}> · 无格式冲突</span>
                  )}
                </span>
              </label>
            )
          })}
          <div className={css.templateActions}>
            <div className={css.actionGroup}>
              <label className={css.uploadTrigger} title="上传新模板">
                <IconPlusOutline16 size={14} className={css.uploadIcon} />
                <strong>上传新模板</strong>
                <input aria-label="上传 Word 模板" className={css.hiddenFileInput} type="file" accept=".docx" disabled={Boolean(busy)} onClick={(event) => {
                  event.currentTarget.value = ''
                }} onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file || !library) return
                  perform('正在解析模板…', async () => {
                    if (file.size > templateMaxBytes) throw new Error(`模板文件不能超过 ${String(templateMaxMiB)} MiB。`)
                    const next = await uploadTemplate(file, library.revision)
                    setLibrary(next.library); setSelectedId(next.templateId); setView(next); setFormatVisible(true); setActiveConflict(null)
                    await refreshPreviewAndEstimate(next.templateId)
                    setStatus(next.warnings.find(warning => warning.startsWith('模板解析完成；自动格式解释未应用')) ?? '模板已加入项目模板库')
                  })
                }}/>
              </label>
              <span className={css.uploadHint}>选择 .docx 文件（最多 {templateMaxMiB} MiB）</span>
            </div>
            {library && library.estimateTemplateId !== selectedId && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => {
              perform('正在设置页数基准…', async () => {
                const next = await setEstimateTemplate(selectedId, library.revision)
                setLibrary(next); setView(current => current === null ? null : { ...current, library: next }); setStatus('已设为 S5 页数基准模板')
              })
            }}>设为页数基准模板</Button>}
          </div>
        </section>
        <p role="status" className={css.status}>{busy || status || [
          estimateLabel(estimates.get(templateEstimateKey(selectedId))), partialExportMessage,
        ].filter(Boolean).join('；')}</p>
        {error && <p role="alert" className={css.error}>{error}</p>}
        {formatVisible && view && <table className={css.summary}>
          <caption>当前模板主要格式</caption>
          <thead><tr><th>类型</th><th>字体</th><th>字号</th><th>对齐</th><th>行距</th><th>缩进</th><th>状态</th></tr></thead>
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
            </tr>
          })}</tbody>
        </table>}
        {formatVisible && otherConflicts.length > 0 && <div className={css.otherConflicts} aria-label="其他格式冲突"><strong>其他待确认</strong>
          {otherConflicts.map(conflict => <button key={conflict.key} ref={conflict.key === firstUnresolvedKey ? firstConflict : undefined}
            type="button" onClick={() => { setActiveConflict(conflict); setSelected(conflict.resolvedValue) }}>
            {view?.fields.find(field => field.key === conflict.key)?.label ?? conflict.key}：{displayValue(conflict.resolvedValue)}
          </button>)}</div>}
      </div>
      <div className={css.preview}>{formatVisible ? previewHtml
        ? <iframe title="Word 效果预览" sandbox="" srcDoc={previewHtml} className={css.frame}/>
        : <p>正在生成 Word 效果预览…</p> : <p>正在读取所选模板。</p>}</div>
    </div>
    {activeConflict && <div className={css.backdrop}><div role="dialog" aria-modal="true" aria-labelledby="word-conflict-title" className={css.dialog}>
      <h2 id="word-conflict-title">{view?.fields.find(field => field.key === activeConflict.key)?.label ?? activeConflict.key}存在冲突</h2>
      {[...new Map(activeConflict.evidence.map(item => [displayValue(item.value), item.value])).values()].map((option) => {
        const sources = [...new Set(activeConflict.evidence
          .filter(item => sameValue(item.value, option))
          .map(item => SOURCE_LABELS[item.source]))]
        return <label key={`${typeof option}:${String(option)}`}><input type="radio" name="word-conflict" checked={selected !== undefined && sameValue(selected, option)} onChange={() => { setSelected(option) }}/>
          <span>{displayValue(option)}<small>来源：{sources.join('、')}</small></span></label>
      })}
      <div className={css.dialogActions}><Button onClick={() => { setActiveConflict(null) }}>取消</Button><Button variant="primary" disabled={selected === undefined || !view || Boolean(busy)} onClick={() => {
        if (selected === undefined || !view) return
        perform('正在确认格式…', async () => {
          const next = await saveFormat(selectedId, { revision: view.state.revision,
            userConfirmed: { ...view.state.userConfirmed, [activeConflict.key]: selected } })
          setView(next); setLibrary(next.library); setActiveConflict(null); await refreshPreviewAndEstimate(selectedId); setStatus('格式已确认')
        })
      }}>确认</Button></div>
    </div></div>}
  </section>
}
