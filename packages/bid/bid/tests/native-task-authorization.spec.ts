/** 原生用户修订请求只在 Host 接纳期间授权自身会话，不改变模型 turn 权限。 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { resolveBidToolAuthorization, withBidNativeTaskAuthorization } from '../src/bid-tool-authorization.ts'

it('原生请求无需伪造 turn；未记录消息、其他会话和作用域结束后均不授权', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    const other = ctx.sessions.create()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '修订当前选区。' }] })
    expect(() => withBidNativeTaskAuthorization(session, message, async () => undefined))
      .toThrow('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(() => withBidNativeTaskAuthorization(session, { ...message, content: [{ type: 'text', text: '其他任务。' }] }, async () => undefined))
      .toThrow('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
    expect(resolveBidToolAuthorization(session)).toBeUndefined()
    await withBidNativeTaskAuthorization(session, message, async () => {
      await Promise.resolve()
      expect(resolveBidToolAuthorization(session)).toEqual({ session_id: String(session.id), message_id: String(message.id) })
      expect(resolveBidToolAuthorization(other)).toBeUndefined()
    })
    expect(resolveBidToolAuthorization(session)).toBeUndefined()
    expect(session.events.some(event => event.type === 'turn/start')).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
