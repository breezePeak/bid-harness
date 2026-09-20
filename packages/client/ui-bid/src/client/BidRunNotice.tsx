import { useState } from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BidRunNotice.module.css'

/** Props supplied by the keyed conversation-chat renderer. */
type BidRunNoticeProps = PropsRuntime<'conversation.chat.node', 'bid-run-notice'>

/** Render one durable, model-invisible terminal Run outcome. */
export function BidRunNotice({ node }: BidRunNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  if (node.data.severity !== 'error') return <p role="status">{node.data.message}</p>
  const summary = node.data.message.split('；').slice(0, 2).join('；')
  return (
    <div className={css.root} role="alert">
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<StateDot state="error" />}
        title="阶段运行失败"
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
