/** 原生回答与普通继续共用程序绑定的授权、来源及恢复上下文。 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { bidToolQuestions, recordBidUserAnswer, bidContinuationInstruction } from '../src/bid-user-input.ts'
import { resolveBidToolAuthorization } from '../src/bid-tool-authorization.ts'
import { bindBidTaskSourceContext } from '../src/bid-task-source.ts'
import type { BidWorkDescriptor } from '../src/control-plane-contract.ts'

const work: BidWorkDescriptor = { kind: 'stage_execution', workId: 'outline-work', stage: 'outline_generation',
  requestRef: 'requests/outline-work.json', requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) }
const questions = bidToolQuestions({ questions: [{ id: 'demo', question: '在线演示资料尚未准备，本次怎样写？',
  options: [{ label: '先写方案' }, { label: '稍后补充' }] }] })

it('自动通知轮中的真实回答成为当前授权并冻结为任务来源，后续消息不能修改旧来源', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'bid', form: 'notice', summary: '处理原任务' },
      content: [{ type: 'text', text: '请处理原任务。' }] }), { surfaceOp: 'append' })
    expect(resolveBidToolAuthorization(session)).toBeUndefined()
    const answer = recordBidUserAnswer(session, questions, { answers: [{ id: 'demo', selected: [],
      custom: '可以先生成几张图就行，后续演示这种再说了' }] })
    expect(resolveBidToolAuthorization(session)).toEqual({ session_id: String(session.id), message_id: String(answer.id) })
    const event = session.events.at(-1)!
    const source = bindBidTaskSourceContext(session, { message: { session_id: String(session.id),
      message_id: String(answer.id), seq: event.seq, text: answer.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') },
    issues: [], observed_issues: [], queue_revision: 0, root_scope: { kind: 'project' } })
    expect(source.message.text).toContain('后续演示这种再说了')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '按刚才选择执行' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(bindBidTaskSourceContext(session, source)).toEqual(source)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(resolveBidToolAuthorization(session)).toBeUndefined()
    session.append('turn/start', { turn: 2 })
    expect(resolveBidToolAuthorization(session)).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it.each([
  { answers: [] }, { answers: [{ id: 'other', selected: ['先写方案'] }] },
  { answers: [{ id: 'demo', selected: ['不存在的授权'] }] },
  { answers: [{ id: 'demo', selected: [] }] },
  { answers: [{ id: 'demo', selected: ['先写方案', '稍后补充'] }] },
  { answers: [{ id: 'demo', selected: [], custom: 'x'.repeat(4001) }] },
])('拒绝无效回答且不生成用户授权：%j', async (reply) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    expect(() => recordBidUserAnswer(session, questions, reply)).toThrow()
    expect(session.events.some(event => event.type === 'user/message')).toBe(false)
  } finally { await ctx.fiber.dispose() }
})

it('正文缺口问题的章节详情与真实答案一起保存，不能只留下泛化问题', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    const message = recordBidUserAnswer(session, [{ id: 'stage-question', question: '请补充正文输入',
      detail: '演示方案章节：在线系统演示材料尚未准备。' }],
    { answers: [{ id: 'stage-question', selected: [], custom: '先写方案并配示意图' }] })
    expect(message.content).toEqual([{ type: 'text',
      text: '问题：请补充正文输入\n演示方案章节：在线系统演示材料尚未准备。\n用户回答：先写方案并配示意图' }])
  } finally { await ctx.fiber.dispose() }
})

it('裸继续保留本 Work 的先前决定及处理方案，不带入其他 Work 的方案，也不递归扩张', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    const message = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    message('先写技术标')
    session.append('bid.run.started', { run: { runId: 'run-one', work, epoch: 1, baseProjectRevision: 0, startedAt: 1, updatedAt: 1 } })
    recordBidUserAnswer(session, questions, { answers: [{ id: 'demo', selected: [], custom: '先生成几张示意图，实际演示后续准备' }] })
    for (const [id, instruction] of [['outline-work', '将演示方式保留为全局合规要求'], ['other-work', '其他项目专用策略']]) {
      session.append('bid.recovery.requested', { ownerSessionId: String(session.id), target: { kind: 'run', workId: id!, runId: 'run-one' },
        unit: 'outline/outline.json', instruction: instruction!, progressFingerprint: 'problem' })
    }
    message('继续')
    const instruction = bidContinuationInstruction(session, work, '继续')
    expect(instruction).toContain('先生成几张示意图，实际演示后续准备')
    expect(instruction).toContain('将演示方式保留为全局合规要求')
    expect(instruction).not.toContain('其他项目专用策略')
    expect(bidContinuationInstruction(session, work, '继续')).toBe(instruction)
  } finally { await ctx.fiber.dispose() }
})
