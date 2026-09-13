import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props supplied by the keyed conversation-chat renderer. */
type BidRunNoticeProps = PropsRuntime<'conversation.chat.node', 'bid-run-notice'>

/** Render one durable, model-invisible terminal Run outcome. */
export function BidRunNotice({ node }: BidRunNoticeProps) {
  return <p role={node.data.severity === 'error' ? 'alert' : 'status'}>{node.data.message}</p>
}
