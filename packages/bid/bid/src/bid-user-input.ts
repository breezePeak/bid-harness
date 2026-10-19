/** 原生问答由 Host 核对并保存为真实用户输入，授权与任务来源共用同一消息。 */
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { BidWorkDescriptor } from './control-plane-contract.ts'

const questionsSchema = z.object({ questions: z.array(z.object({
  id: z.string().min(1), question: z.string().min(1), header: z.string().optional(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).optional(),
  multi_select: z.boolean().optional(),
})).min(1) })
const answersSchema = z.object({ answers: z.array(z.object({ id: z.string().min(1),
  selected: z.array(z.string()), custom: z.string().max(4000).optional() }).strict()) }).strict()

/**
 * 将模型工具参数解析为原生问题；不接受模型提供的任务身份。
 * @param input 工具入口 JSON。
 * @returns 可交给原生 UI 的问题。
 */
export function bidToolQuestions(input: unknown): AskUserQuestionItem[] {
  return questionsSchema.parse(input).questions.map(question => ({
    id: question.id, question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : { options: question.options.map(option => ({ label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }) })) }),
    ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
  }))
}

/**
 * 保存经过问题身份、选项和完整性核对的真实回答；空回答不授予执行权限。
 * @param session 原提问的公开会话。
 * @param questions 实际展示的问题。
 * @param reply UI 提供的答案，不接纳模型摘要。
 * @returns 程序生成并已追加的用户消息。
 */
export function recordBidUserAnswer(session: Session, questions: readonly AskUserQuestionItem[], reply: unknown): UserMessage {
  const result = answersSchema.parse(reply)
  if (new Set(questions.map(question => question.id)).size !== questions.length
    || result.answers.length !== questions.length || new Set(result.answers.map(answer => answer.id)).size !== questions.length) {
    throw new Error('BID_INPUT_ANSWER_MISMATCH')
  }
  const lines = questions.map((question) => {
    const answer = result.answers.find(item => item.id === question.id)
    if (answer === undefined || answer.selected.some(label => !question.options?.some(option => option.label === label))
      || !question.multiSelect && answer.selected.length > 1
      || answer.selected.length === 0 && !answer.custom?.trim()) throw new Error('BID_INPUT_ANSWER_MISMATCH')
    return [`问题：${question.question}`, ...question.detail === undefined ? [] : [question.detail],
      `用户回答：${[...answer.selected, answer.custom?.trim()].filter(Boolean).join('；')}`].join('\n')
  })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: lines.join('\n\n') }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

/**
 * 继续原 Work 时保留该任务开始前的授权上下文、后续回答及最近方案。
 * @param session 原任务的公开会话。
 * @param work 当前 Work；其他任务的恢复方案不进入本次输入。
 * @param instruction 当前接纳的语义方案或继续指令。
 * @returns 可重建的用户原话和方案，后出现的回答优先。
 */
export function bidContinuationInstruction(session: Session, work: BidWorkDescriptor, instruction: string): string {
  const first = session.events.find(event => event.type === 'bid.run.started' && event.data.run.work.workId === work.workId)
  const boundary = session.events.findLast(event => event.type === 'bid.run.completed' && event.seq < (first?.seq ?? Infinity))?.seq ?? -1
  const prior = session.events.flatMap(event => event.type === 'bid.recovery.requested'
    && event.data.target.kind === 'run' && event.data.target.workId === work.workId
    ? [event.data.instruction] : []).slice(-3)
  const messages = session.events.flatMap(event => event.seq > boundary && event.type === 'user/message'
    && event.data.source.kind === 'user' ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')] : [])
  return [...prior.map(text => `先前接纳的处理方案：${text}`),
    '原任务的真实用户输入（按时间排列，后续回答可修订前述要求）：', ...messages,
    `本次继续要求：${instruction}`].join('\n\n')
}
