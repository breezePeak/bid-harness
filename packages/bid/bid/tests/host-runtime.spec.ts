import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as BidHostRuntime from '@deepseek-ai/dsh-bid'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`bid-host-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  return {
    ctx,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
      cwd: '/workspace',
    }),
  }
}

function attach(ctx: Context, agentPreset?: string): {
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const session = ctx.sessions.create(undefined, {
    meta: { cwd: '/workspace', ...(agentPreset === undefined ? {} : { agentPreset }) },
  })
  const followup = vi.fn()
  const steer = vi.fn()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    followup,
    steer,
  } as unknown as Agent
  ctx.agents.register(agent)
  return { agent, followup, steer }
}

describe('Bid Host runtime composition', () => {
  it('registers bid.runtime and rejects direct Bid session prompts before dispatch', async () => {
    const { ctx, api } = await harness()
    const { agent, followup, steer } = attach(ctx, 'bid')

    expect(ctx.sessionProjections.snapshot(agent.session).values[BidHostRuntime.BID_RUNTIME_PROJECTION_KEY]).toMatchObject({
      runtime: { stage: 'file_intake', status: 'pending' },
      allowedExtensions: BidHostRuntime.DEFAULT_BID_CONFIG.allowedExtensions,
      maxFiles: BidHostRuntime.DEFAULT_BID_CONFIG.maxFiles,
      maxFileBytes: BidHostRuntime.DEFAULT_BID_CONFIG.maxFileBytes,
      maxTotalBytes: BidHostRuntime.DEFAULT_BID_CONFIG.maxTotalBytes,
    })
    const response = await api.sessions.prompt(request({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'bypass the workflow' }],
    }))

    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'prompt-admission-rejected',
        message: 'Bid session prompt rejected by Host admission: bid.upload_required',
        details: { reason: 'bid.upload_required' },
      },
    })
    expect(followup).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    expect(agent.session.events).toHaveLength(0)
  })

  it('preserves the generic follow-up path for a standard session', async () => {
    const { ctx, api } = await harness()
    const { agent, followup, steer } = attach(ctx, 'standard')

    const response = await api.sessions.prompt(request({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'ordinary prompt' }],
    }))

    expect(response.result).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })
})
