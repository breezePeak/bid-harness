import type {} from '@deepseek-ai/dsh-bid'
import type { BidRunNotice } from '@deepseek-ai/dsh-bid/control-plane'
import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Durable terminal status for one exact Bid Run. */
    'bid-run-notice': BidRunNotice
  }
}

/** Durable, model-invisible terminal Run notice. */
export const bidRunNoticeDefinition: ConversationNodeDefinition<BidRunNotice> = {
  kind: 'bid-run-notice',
  target: 'chat',
  match: event => event.type === 'bid.run.notice'
    ? { id: event.data.noticeId, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'bid.run.notice') throw new Error('bid-run-notice requires bid.run.notice')
    return match.event.data
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'bid-run-notice',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
