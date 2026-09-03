import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BidInvariant from '../src/invariant.ts'
import { BID_INITIAL_RUNTIME_STATE } from '../src/runtime-state.ts'

describe('Bid 项目修订号约束', () => {
  it('允许重复修订，拒绝回退且卸载后移除检查', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const invariants = await ctx.plugin(InvariantRegistry, { enabled: true })
    const companion = await ctx.plugin(BidInvariant)
    try {
      const session = ctx.sessions.create()
      const append = (revision: number) => session.append('bid.project.resumed', { runtime: BID_INITIAL_RUNTIME_STATE, revision })
      append(12)
      expect(() => append(12)).not.toThrow()
      expect(() => append(13)).not.toThrow()
      const accepted = session.events.length
      expect(() => append(12)).toThrow('Bid 项目修订号不能从 13 回退到 12。')
      expect(session.events).toHaveLength(accepted)
      await companion.dispose()
      expect(() => append(12)).not.toThrow()
    } finally {
      await companion.dispose()
      await invariants.dispose()
      await sessions.dispose()
    }
  })
})
