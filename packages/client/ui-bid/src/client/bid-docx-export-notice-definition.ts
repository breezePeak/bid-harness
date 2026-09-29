/** 将独立 Word 导出的终态事件投影到聊天时间线，不进入模型上下文。 */
import type {} from '@deepseek-ai/dsh-bid'
import type { DocxExportOperation } from '@deepseek-ai/dsh-bid/control-plane'
import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'

type DocxExportOutcome = Extract<DocxExportOperation, { status: 'completed' | 'failed' }>

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 同一会话中一次独立 Word 导出的持久结果。 */
    'bid-docx-export-notice': DocxExportOutcome
  }
}

/** 每条完成或失败事件形成一条可重放的聊天消息，重试保留原失败记录。 */
export const bidDocxExportNoticeDefinition: ConversationNodeDefinition<DocxExportOutcome> = {
  kind: 'bid-docx-export-notice',
  target: 'chat',
  match: event => event.type === 'bid.docx_export.changed' && event.data.operation.status !== 'running'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'bid.docx_export.changed' || match.event.data.operation.status === 'running') {
      throw new Error('bid-docx-export-notice requires a terminal bid.docx_export.changed event')
    }
    return match.event.data.operation
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'bid-docx-export-notice',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
