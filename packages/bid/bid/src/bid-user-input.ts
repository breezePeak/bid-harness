/** 原生问答由 Host 核对并保存为真实用户输入，授权与任务来源共用同一消息。 */
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { BidWorkDescriptor } from './control-plane-contract.ts'
import type {} from './bid-events.ts'
import { redactBidSecrets } from './safe-error.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
 * @param binding Host 绑定的问题与所属 Work；不关联全局阶段。
 * @returns 程序生成并已追加的用户消息。
 */
export function recordBidUserAnswer(session: Session, questions: readonly AskUserQuestionItem[], reply: unknown,
  binding?: { questionKey: string; work: Pick<BidWorkDescriptor, 'workId' | 'requestSha256'> | null }): UserMessage {
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
  if (binding !== undefined) {
    const previous = session.events.findLast(event => event.type === 'bid.user_input.recorded'
      && event.data.questionKey === binding.questionKey && event.data.work?.workId === binding.work?.workId
      && event.data.work?.requestSha256 === binding.work?.requestSha256)
    if (previous?.type === 'bid.user_input.recorded') {
      const saved = session.events.find(event => event.type === 'user/message' && String(event.data.id) === previous.data.messageId)
      if (saved?.type !== 'user/message' || JSON.stringify(saved.data.content) !== JSON.stringify(message.content)) {
        throw new Error('BID_INPUT_IDENTITY_MISMATCH')
      }
      return saved.data
    }
  }
  session.append('user/message', message, { surfaceOp: 'append' })
  if (binding !== undefined) session.append('bid.user_input.recorded', { messageId: String(message.id),
    questionKey: binding.questionKey, work: binding.work === null ? null : {
      workId: binding.work.workId, requestSha256: binding.work.requestSha256,
    } })
  return message
}

/**
 * 按当前要求、当前 Work 的最新回答、原始请求及旧方案构造恢复输入；完整输入供分页读取。
 * @param session 原任务的公开会话。
 * @param work 当前 Work；其他任务的恢复方案不进入本次输入。
 * @param instruction 当前接纳的语义方案或继续指令。
 * @param requestSeq 本次已接纳事件；避免把同一要求再次列为旧方案。
 * @returns 有界的模型上下文和按身份去重的完整来源。
 */
export function bidContinuationInstruction(session: Session, work: BidWorkDescriptor, instruction: string, requestSeq?: number): {
  text: string
  inputs: readonly string[]
} {
  const first = session.events.find(event => event.type === 'bid.run.started' && event.data.run.work.workId === work.workId)
  const bindings = session.events.flatMap(event => event.type === 'bid.user_input.recorded' ? [event.data] : [])
  const owned = new Set(bindings.filter(binding => binding.work?.workId === work.workId
    && binding.work.requestSha256 === work.requestSha256).map(binding => binding.messageId))
  for (const event of session.events) {
    if (event.type === 'bid.recovery.requested' && event.data.target.kind === 'run'
      && event.data.target.workId === work.workId && event.data.sourceMessageId !== undefined) owned.add(event.data.sourceMessageId)
  }
  const original = first === undefined ? undefined : session.events.findLast(event => event.seq < first.seq
    && event.type === 'user/message' && event.data.source.kind === 'user')
  const messages = session.events.flatMap(event => event.type === 'user/message' && owned.has(String(event.data.id))
    ? [{ id: String(event.data.id), text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }] : []).reverse()
  if (original?.type === 'user/message' && !owned.has(String(original.data.id))) messages.push({ id: String(original.data.id),
    text: original.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') })
  const prior = session.events.flatMap(event => event.type === 'bid.recovery.requested'
    && event.seq !== requestSeq && event.data.target.kind === 'run' && event.data.target.workId === work.workId ? [event.data] : []).reverse()
  const inputs = [instruction, ...messages.map(message => message.text), ...prior.slice(0, 3).map(request => request.instruction)]
    .map(redactBidSecrets)
  let text = '按下列优先级处理，最新回答优先于旧方案；范围与授权仍以原任务为准。\n'
  for (const [position, input] of inputs.entries()) {
    if (text.length > 14_500) {
      text += `其余输入位置 ${position} 至 ${inputs.length - 1} 可调用 bid_read_recovery_input 分页读取。\n`
      break
    }
    const title = position === 0 ? '本次继续要求' : position <= messages.length ? '真实用户输入' : '先前接纳的处理方案'
    const heading = `${title}（输入位置 ${position}，${input.length} 字符）：\n`
    const remaining = Math.max(0, 15_000 - text.length - heading.length)
    if (input.length <= remaining) text += `${heading}${input}\n\n`
    else text += `${heading}调用 bid_read_recovery_input 分页读取完整内容；不得在未读取所需输入时提交结果。\n`
  }
  return { text, inputs }
}

/**
 * 为执行 Agent 及其授权子任务安装只读输入分页；随 Agent 卸载释放。
 * @param agent 原 Work 的执行 Agent。
 * @param inputs 当前操作从权威会话重建的输入，不接受模型指定会话或路径。
 */
export function installBidRecoveryInputReader(agent: Agent, inputs: () => readonly string[] | undefined): void {
  if (recoveryInputExcluded.has(agent)) return
  agent.ctx.on('agent/created', ({ agent: child }) => {
    if (agent.ctx.get('agents')?.isOwnedBy(child.id, agent)) installBidRecoveryInputReader(child, inputs)
  }, { global: true })
  agent.ctx.get('tools')?.register(defineTool({
    name: 'bid_read_recovery_input',
    description: '分页读取本次恢复任务的完整输入。输入位置从 0 开始；读取长输入直到 has_more 为 false。',
    parameters: {
      input_position: { type: 'integer', required: true, description: '从 0 开始的输入位置。' },
      page: { type: 'integer', required: true, description: '从 0 开始的页码，每页最多 4000 字符。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', required: true }, has_more: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute({ input_position, page }) {
      if (input_position < 0 || page < 0) throw new Error('BID_RECOVERY_INPUT_POSITION_INVALID')
      const input = inputs()?.[input_position]
      const offset = page * 4000
      if (input === undefined || offset >= input.length && page !== 0) throw new Error('BID_RECOVERY_INPUT_POSITION_INVALID')
      return Promise.resolve({ text: input.slice(offset, offset + 4000), has_more: offset + 4000 < input.length })
    },
  }))
}

const recoveryInputExcluded = new WeakSet<Agent>()

/**
 * 在子任务 setup 中隔离只消费冻结证据的核验者，阻止 agent/created 传播执行者恢复输入。
 * @param agent 尚未发布的核验 Agent。
 */
export function excludeBidRecoveryInputReader(agent: Agent): void {
  recoveryInputExcluded.add(agent)
}
