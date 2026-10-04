/** Host 冻结真实消息及审批队列；模型摘要不构成任务来源或授权。 */
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidWorkspace } from './index.ts'
import { bidCapabilityScopeSchema, type BidCapabilityTask } from './bid-capability-contract.ts'
import { readRevisionQueue, revisionIssueSchema } from './chapter-revision-queue.ts'

const sourceMessageSchema = z.object({ session_id: z.string().min(1), message_id: z.string().min(1),
  text: z.string(), seq: z.number().int().nonnegative() }).strict()

/** 接纳时的来源及队列事实；未绑定意见也保留供覆盖核验。 */
export const bidTaskSourceSnapshotSchema = z.object({
  message: sourceMessageSchema,
  context_messages: z.array(sourceMessageSchema).optional(),
  issues: z.array(revisionIssueSchema),
  observed_issues: z.array(revisionIssueSchema),
  queue_revision: z.number().int().nonnegative(),
  root_scope: bidCapabilityScopeSchema,
}).strict()

/** 不可变任务来源。 */
export type BidTaskSourceSnapshot = z.infer<typeof bidTaskSourceSnapshotSchema>

/**
 * 从原消息之前、上次 Run 接纳或完成之后的真实用户消息绑定本次澄清上下文。
 * @param session 原授权会话，后续消息不能补充旧任务的授权。
 * @param source 原任务来源；已保存的上下文须与原会话相符。
 * @returns 带持久消息身份和原文的来源，不改变原任务消息或审批意见。
 */
export function bindBidTaskSourceContext(session: Session, source: BidTaskSourceSnapshot): BidTaskSourceSnapshot {
  const prior = session.events.filter(event => event.seq < source.message.seq)
  const boundary = prior.findLast(event => event.type === 'bid.run.started' || event.type === 'bid.run.completed')?.seq ?? -1
  const context = prior.flatMap(event => event.seq > boundary && event.type === 'user/message'
    && event.data.source.kind === 'user' ? [{ session_id: String(session.id), message_id: String(event.data.id),
      text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'), seq: event.seq }] : [])
  if (source.message.session_id !== String(session.id)
    || source.context_messages !== undefined && JSON.stringify(source.context_messages) !== JSON.stringify(context)) {
    throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
  }
  return { ...source, context_messages: context }
}

/**
 * 读取授权消息原文和实际意见，拒绝模型提供不存在的身份。
 * @param workspace 正式项目。
 * @param session 原授权会话。
 * @param task 本次计划。
 * @param authorization 真实消息身份。
 * @returns 冻结的来源及接纳时的待处理集合。
 */
export async function freezeBidTaskSource(
  workspace: BidWorkspace, session: Session, task: BidCapabilityTask,
  authorization: { session_id: string; message_id: string },
): Promise<BidTaskSourceSnapshot> {
  const event = session.events.find(item => item.type === 'user/message'
    && String(item.data.id) === authorization.message_id)
  if (authorization.session_id !== String(session.id) || event?.type !== 'user/message'
    || !['user', 'goal'].includes(event.data.source.kind)) throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
  const queue = await readRevisionQueue(workspace)
  const issues = [...new Set(task.issue_ids ?? task.steps.flatMap(step => step.call.capability === 'chapter.revision_batch'
    ? step.call.input.issue_ids : []))].map((id) => {
    const issue = queue.issues.find(item => item.issue_id === id)
    if (issue === undefined) throw new Error('BID_TASK_SOURCE_ISSUE_UNKNOWN')
    return issue
  })
  return bindBidTaskSourceContext(session, bidTaskSourceSnapshotSchema.parse({
    message: { ...authorization, seq: event.seq,
      text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') },
    issues, observed_issues: queue.issues.filter(issue => issue.status === 'pending'),
    queue_revision: queue.revision, root_scope: task.scope,
  }))
}
