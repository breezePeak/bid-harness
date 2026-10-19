import { useEffect, useState } from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BidRunNotice.module.css'
import type { BidTaskDeliverablesView } from '@deepseek-ai/dsh-bid/control-plane'

/** 当前会话的已发布文件读取与浏览器路径，由注册处绑定真实 Session。 */
export interface BidRunNoticeInjected {
  /** 读取完成通知对应的精确发布回执。 */
  getDeliverables: (workId: string) => Promise<BidTaskDeliverablesView>
  /** 由 Host 对象位置构造同源查看或下载 URL。 */
  artifactUrl: (workId: string, receipt: string, position: number, mode: 'preview' | 'download') => string
}

/** Props supplied by the keyed conversation-chat renderer. */
type BidRunNoticeProps = PropsRuntime<'conversation.chat.node', 'bid-run-notice'>
  & BidRunNoticeInjected

/** Render one durable, model-invisible terminal Run outcome. */
export function BidRunNotice({ node, getDeliverables, artifactUrl }: BidRunNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  const [files, setFiles] = useState<BidTaskDeliverablesView>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const workId = node.data.kind === 'completed' ? node.data.workId : undefined
  useEffect(() => {
    let active = true
    setFiles(undefined); setError(undefined)
    if (workId !== undefined) void getDeliverables(workId).then((value) => {
      if (active) setFiles(value)
    }, (error: unknown) => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [workId, node.data.noticeId, getDeliverables, retry])
  if (node.data.severity !== 'error') return <div className={css.root}>
    <p role="status">{node.data.message}</p>
    {error !== undefined && <p role="alert">文件读取失败：{error} <button type="button" onClick={() => { setRetry(value => value + 1) }}>重试</button></p>}
    {files !== undefined && workId !== undefined && files.files.length > 0 && <ul className={css.files} aria-label="本次任务交付文件">
      {files.files.map(file => <li key={file.position}>
        <span>{file.name}</span>
        {file.preview && <a href={artifactUrl(workId, files.receipt, file.position, 'preview')} target="_blank" rel="noreferrer">查看</a>}
        <a href={artifactUrl(workId, files.receipt, file.position, 'download')} download={file.name}>下载</a>
      </li>)}
    </ul>}
  </div>
  const summary = node.data.message.split('；').slice(0, 2).join('；')
  return (
    <div className={css.root} role="alert">
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<StateDot state="error" />}
        title="任务运行失败"
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary}>{summary}</span>
          </>
        )}
      >
        <div className={css.body}>{node.data.message}</div>
      </DisclosureRow>
    </div>
  )
}
