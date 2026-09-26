/** 聊天时间线中的 Word 导出终态与文件位置。 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BidDocxExportNotice.module.css'

/** 旧会话缺少绝对路径时前往项目当前的 Word 导出页。 */
export interface BidDocxExportNoticeInjected {
  /** 打开当前会话的 Word 导出页，供旧记录查看可下载文件。 */
  showExport: () => void
}

type BidDocxExportNoticeProps = PropsRuntime<'conversation.chat.node', 'bid-docx-export-notice'>
  & BidDocxExportNoticeInjected

/**
 * 显示一条独立导出的持久终态消息。
 * @param props 聊天节点与导出页入口。
 * @returns 成功文件位置或失败原因。
 */
export function BidDocxExportNotice({ node, showExport }: BidDocxExportNoticeProps) {
  if (node.data.status === 'failed') {
    return <div className={css.root} role="alert"><strong>Word 导出失败，未完成</strong><p>{node.data.error}</p></div>
  }
  return <div className={css.root} role="status">
    <strong>Word 导出完成</strong>
    <p>文件位置：<code>{node.data.filePath ?? `项目数据目录内的 ${node.data.path}`}</code></p>
    {node.data.filePath === undefined && <button type="button" onClick={showExport}>前往导出页查看当前文件</button>}
  </div>
}
