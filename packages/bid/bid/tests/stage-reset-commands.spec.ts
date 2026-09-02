import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as resetCommands from '../src/stage-reset-commands.ts'

class FakeBidRuntime extends Service {
  readonly resetStage = vi.fn(async (_agent: Agent, stage: string) => ({ stage, status: 'waiting_user' as const }))

  constructor(ctx: Context) {
    super(ctx, 'bid')
  }
}

describe('Bid stage reset commands', () => {
  it('registers S2-S7 commands and dispatches the selected stage without model input', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(FakeBidRuntime)
    await ctx.plugin(resetCommands)
    const session = ctx.sessions.create(SessionId('bid-stage-reset-command'))
    const agent = { id: session.id, session } as Agent

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual([
      'bid-reset-s2', 'bid-reset-s3', 'bid-reset-s4',
      'bid-reset-s5', 'bid-reset-s6', 'bid-reset-s7',
    ])
    const handler = ctx.commands.find(agent, 'bid-reset-s3')?.handler
    expect(handler).toBeDefined()
    await expect(handler!({
      commandId: CommandId('bid-reset-command'),
      agent,
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'success',
      text: '证据映射阶段已重置：evidence_mapping / waiting_user。',
    })
    expect((ctx.bid as unknown as FakeBidRuntime).resetStage).toHaveBeenCalledWith(agent, 'evidence_mapping')
  })
})
