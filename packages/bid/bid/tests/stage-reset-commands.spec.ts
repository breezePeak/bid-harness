import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as resetCommands from '../src/stage-reset-commands.ts'

class FakeBidRuntime extends Service {
  readonly resetStage = vi.fn(async (_agent: Agent, stage: string) => ({ stage, status: 'waiting_user' as const, run: null }))

  constructor(ctx: Context) {
    super(ctx, 'bid')
  }
}

describe('Bid stage reset commands', () => {
  it.each([
    ['bid-reset-s1', 'file_intake', '资料上传'],
    ['bid-reset-s3', 'outline_generation', '初步目录'],
  ])('注册 S1–S5 命令并将 %s 重置交给 Host，拒绝命令参数', async (command, stage, label) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(FakeBidRuntime)
    await ctx.plugin(resetCommands)
    const session = ctx.sessions.create(SessionId('bid-stage-reset-command'))
    const agent = { id: session.id, session } as Agent

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual([
      'bid-reset-s1', 'bid-reset-s2', 'bid-reset-s3', 'bid-reset-s4',
      'bid-reset-s5',
    ])
    const handler = ctx.commands.find(agent, command)?.handler
    expect(handler).toBeDefined()
    await expect(handler!({
      commandId: CommandId('bid-reset-command'),
      agent,
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'success',
      text: `${label}阶段重置已应用。当前状态：${stage} / waiting_user。`,
    })
    const host = ctx.bid as unknown as FakeBidRuntime
    expect(host.resetStage).toHaveBeenCalledWith(agent, stage)
    await expect(handler!({
      commandId: CommandId('bid-reset-command-with-args'),
      agent,
      rawInput: 'extra',
      attachments: [],
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'error', text: '阶段重置命令不接受参数。' })
    expect(host.resetStage).toHaveBeenCalledOnce()
    expect(session.events).toEqual([])
    await ctx.fiber.dispose()
  })
})
