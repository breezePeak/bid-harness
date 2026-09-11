/** Word 模板上传、主要格式确认和 resolved 效果预览页。 */
import { useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DOCX_TEMPLATE_MAX_BYTES } from '@deepseek-ai/dsh-bid/control-plane'
import type { DocxFormatRequest, DocxFormatView, FormatConflict, FormatEvidenceSource, FormatRole, FormatValue } from '@deepseek-ai/dsh-bid/control-plane'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BidWordExport.module.css'

const ROWS: Array<{ role: FormatRole; label: string }> = [
  { role: 'heading1', label: '一级标题' },
  { role: 'heading2', label: '二级标题' },
  { role: 'body', label: '正文' },
  { role: 'figureCaption', label: '图题' },
  { role: 'tableCaption', label: '表题' },
]
const SOURCE_LABELS: Record<FormatEvidenceSource, string> = {
  system_default: '系统默认值',
  doc_defaults: '文档默认格式',
  theme: 'Theme 字体',
  named_style: 'Word 样式',
  direct_format: '示例段落直接格式',
  template_instruction: '模板格式说明',
  user_requirement: '用户格式要求',
  user_confirmed: '用户确认',
}
const ALIGNMENT_LABELS: Record<string, string> = { left: '左对齐', center: '居中', right: '右对齐', both: '两端对齐' }
const SUMMARY_KEYS = new Set(ROWS.flatMap(({ role }) => ['font', 'latinFont', 'size', 'alignment', 'line', 'lineRule',
  'firstLine', 'firstLineUnit'].map(key => `${role}.${key}`)))

export interface BidWordExportInjected {
  getFormat: () => Promise<DocxFormatView>
  saveFormat: (request: DocxFormatRequest) => Promise<DocxFormatView>
  uploadTemplate: (file: File, revision: number) => Promise<DocxFormatView>
  preview: () => Promise<DocxFormatView>
  generate: () => Promise<{ path: string }>
  download: () => Promise<void>
}

const sameValue = (left: FormatValue, right: FormatValue): boolean => typeof left === typeof right && left === right
const displayValue = (value: FormatValue): string => typeof value === 'boolean' ? value ? '是' : '否' : String(value)

/** 项目级模板上传、冲突确认和样式预览。 */
export function BidWordExport({ sessionId,
  useSessions,
  useProjection,
  getFormat,
  saveFormat,
  uploadTemplate,
  preview,
  generate,
  download }: ConvViewProps & BidWordExportInjected) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [view, setView] = useState<DocxFormatView | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [activeConflict, setActiveConflict] = useState<FormatConflict | null>(null)
  const [selected, setSelected] = useState<FormatValue | undefined>()
  const firstConflict = useRef<HTMLButtonElement | null>(null)
  const ready = projection?.allowedActions.includes('export_docx') ?? (projection?.runtime.status === 'completed' && ['chapter_writing',
    'docx_export'].includes(projection.runtime.stage))

  const loadPreview = async (): Promise<void> => {
    const next = await preview()
    setPreviewHtml(next.previewHtml ?? '')
  }
  useEffect(() => {
    if (!isBid) return
    let disposed = false
    void Promise.all([getFormat(), preview()]).then(([next, rendered]) => {
      if (disposed) return
      setView(next)
      setPreviewHtml(rendered.previewHtml ?? '')
    }, (reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Word 格式读取失败。') })
    return () => { disposed = true }
  }, [getFormat, isBid, preview, sessionId])
  if (!isBid) return null

  const perform = (label: string, action: () => Promise<void>): void => {
    if (busy) return
    setBusy(label)
    setError('')
    void action().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') })
      .finally(() => { setBusy('') })
  }
  const openConflict = (conflict: FormatConflict): void => {
    setActiveConflict(conflict)
    setSelected(conflict.resolvedValue)
  }
  const unresolved = view?.state.conflicts.filter(conflict => conflict.status === 'conflict') ?? []
  const otherConflicts = unresolved.filter(conflict => !SUMMARY_KEYS.has(conflict.key))
  const firstUnresolvedKey = unresolved[0]?.key
  const conflictFor = (keys: string[]): FormatConflict | undefined => unresolved.find(conflict => keys.includes(conflict.key))
  const templateMaxBytes = view?.templateMaxBytes ?? DOCX_TEMPLATE_MAX_BYTES
  const templateMaxMiB = Math.floor(templateMaxBytes / 1024 / 1024)
  const value = (key: string): FormatValue => view?.state.resolved[key] ?? ''
  const cell = (keys: string[], text: string) => {
    const conflict = conflictFor(keys)
    return <td className={conflict ? css.conflict : undefined}>{conflict
      ? <button ref={conflict.key === firstUnresolvedKey ? firstConflict : undefined} type="button" onClick={() => { openConflict(conflict) }}>{text}</button>
      : text}</td>
  }

  return <section className={css.root} aria-label="导出 Word" data-conversation-composer-overlay="">
    <header className={css.header}><strong>导出 Word</strong></header>
    <div className={css.columns}>
      <div className={css.left}>
        <label className={css.upload}>
          <strong>上传 Word 模板</strong>
          <span>选择 .docx 文件（最多 {templateMaxMiB} MiB）</span>
          <input aria-label="上传 Word 模板" type="file" accept=".docx" disabled={Boolean(busy)} onClick={(event) => { event.currentTarget.value = '' }} onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file || !view) return
            perform('正在解析模板…', async () => {
              if (file.size > templateMaxBytes) throw new Error(`模板文件不能超过 ${String(templateMaxMiB)} MiB。`)
              const next = await uploadTemplate(file, view.state.revision)
              setView(next)
              await loadPreview()
              setStatus('模板解析完成')
            })
          }}/>
          {view?.state.template && <span>{view.state.template.name}</span>}
        </label>
        <p role="status" className={css.status}>{busy || status}</p>
        {error && <p role="alert" className={css.error}>{error}</p>}
        {view && <table className={css.summary}>
          <caption>模板主要格式</caption>
          <thead><tr><th>类型</th><th>字体</th><th>字号</th><th>对齐</th><th>行距</th><th>缩进</th><th>状态</th></tr></thead>
          <tbody>{ROWS.map(({ role, label }) => {
            const roleConflicts = unresolved.filter(conflict => conflict.key.startsWith(`${role}.`))
            return <tr key={role} className={roleConflicts.length ? css.conflictRow : undefined}>
              <th scope="row">{label}</th>
              {cell([`${role}.font`, `${role}.latinFont`], `${displayValue(value(`${role}.font`))} / ${displayValue(value(`${role}.latinFont`))}`)}
              {cell([`${role}.size`], `${displayValue(value(`${role}.size`))}pt`)}
              {cell([`${role}.alignment`], ALIGNMENT_LABELS[String(value(`${role}.alignment`))] ?? displayValue(value(`${role}.alignment`)))}
              {cell([`${role}.line`, `${role}.lineRule`], displayValue(value(`${role}.line`)))}
              {cell([`${role}.firstLine`, `${role}.firstLineUnit`], Number(value(`${role}.firstLine`)) === 0 ? '0' : `${displayValue(value(`${role}.firstLine`))}${value(`${role}.firstLineUnit`) === 'chars' ? '字符' : 'mm'}`)}
              <td className={roleConflicts.length ? css.pending : undefined}>{roleConflicts.length ? '待确认' : '正常'}</td>
            </tr>
          })}</tbody>
        </table>}
        {otherConflicts.length > 0 && <div className={css.otherConflicts} aria-label="其他格式冲突">
          <strong>其他待确认</strong>
          {otherConflicts.map(conflict => <button key={conflict.key}
            ref={conflict.key === firstUnresolvedKey ? firstConflict : undefined}
            type="button" onClick={() => { openConflict(conflict) }}>
            {view?.fields.find(field => field.key === conflict.key)?.label ?? conflict.key}：
            {displayValue(conflict.resolvedValue)}
          </button>)}
        </div>}
      </div>
      <div className={css.preview}>
        {previewHtml ? <iframe title="Word 效果预览" sandbox="" srcDoc={previewHtml} className={css.frame}/> : <p>正在生成 Word 效果预览…</p>}
      </div>
    </div>
    <footer className={css.footer}>
      <Button variant="primary" disabled={!ready || !view || Boolean(busy)} onClick={() => {
        if (unresolved.length) {
          setError(`当前仍有 ${String(unresolved.length)} 项格式冲突，请先确认。`)
          firstConflict.current?.focus()
          return
        }
        perform('正在导出 Word…', async () => {
          await generate()
          await download()
          setView(await getFormat())
          setStatus('Word 导出完成')
        })
      }}>导出 Word</Button>
    </footer>
    {activeConflict && <div className={css.backdrop}>
      <div role="dialog" aria-modal="true" aria-labelledby="word-conflict-title" className={css.dialog}>
        <h2 id="word-conflict-title">{view?.fields.find(field => field.key === activeConflict.key)?.label ?? activeConflict.key}存在冲突</h2>
        {[...new Map(activeConflict.evidence.map(item => [displayValue(item.value), item.value])).values()].map((option) => {
          const sources = [...new Set(activeConflict.evidence
            .filter(item => sameValue(item.value, option)).map(item => SOURCE_LABELS[item.source]))]
          return <label key={`${typeof option}:${String(option)}`}><input type="radio" name="word-conflict" checked={selected !== undefined && sameValue(selected, option)} onChange={() => { setSelected(option) }}/>
            <span>{displayValue(option)}<small>来源：{sources.join('、')}</small></span></label>
        })}
        <div className={css.dialogActions}><Button onClick={() => { setActiveConflict(null) }}>取消</Button><Button variant="primary" disabled={selected === undefined || !view || Boolean(busy)} onClick={() => {
          if (selected === undefined || !view) return
          perform('正在确认格式…', async () => {
            const next = await saveFormat({ revision: view.state.revision,
              userConfirmed: { ...view.state.userConfirmed, [activeConflict.key]: selected } })
            setView(next)
            setActiveConflict(null)
            await loadPreview()
            setStatus('格式已确认')
          })
        }}>确认</Button></div>
      </div>
    </div>}
  </section>
}
