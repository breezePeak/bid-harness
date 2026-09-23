import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as driver from '../src/index.ts'

class CountingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('waits without spending rounds and resumes exactly once after a fresh request', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(driver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new CountingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('bid-gate'), { provider: 'mock', model: 'mock' })
  let waiting = true
  ctx.goalRoundDriver.registerGate(() => waiting ? 'wait' : undefined)
  ctx.goals.create(agent, { objective: 'resume only when ready', maxGoalRounds: 1 })
  for (let i = 0; i < 100; i++) ctx.goalRoundDriver.request(agent)
  await vi.waitFor(() => expect(ctx.goals.get(agent)?.activation).toBe('armed'))
  expect(adapter.requests).toHaveLength(0)
  expect(ctx.goals.get(agent)?.roundsStarted).toBe(0)

  waiting = false
  ctx.goalRoundDriver.request(agent)
  await vi.waitFor(() => expect(ctx.goals.get(agent)?.roundsStarted).toBe(1))
  expect(adapter.requests).toHaveLength(1)
})

it('defers a queued round without blocking its goal or losing another message', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(driver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new CountingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('bid-gate-queued'), { provider: 'mock', model: 'mock' })
  let waiting = false
  const inserted = Promise.withResolvers<undefined>()
  ctx.goalRoundDriver.registerGate(() => waiting ? 'wait' : undefined)
  ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
    if (subject === agent && message.source.kind === 'goal' && message.source.round > 0) {
      waiting = true
      inserted.resolve(undefined)
    }
  })
  ctx.goals.create(agent, { objective: 'defer queued round', maxGoalRounds: 1 })
  await inserted.promise
  await vi.waitFor(() => expect(agent.status).toBe('idle'))
  expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed', roundsStarted: 0 })
  expect(adapter.requests).toHaveLength(0)
})

it('rechecks a gate after downstream pre-step work settles', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(driver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new CountingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('bid-gate-pre-step'), { provider: 'mock', model: 'mock' })
  let waiting = false
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.goalRoundDriver.registerGate(() => waiting ? 'wait' : undefined)
  ctx.on('agent/pre-step', async (_payload, next) => {
    entered.resolve(undefined)
    await release.promise
    return next()
  })
  ctx.goals.create(agent, { objective: 'defer during step assembly', maxGoalRounds: 1 })
  await entered.promise
  waiting = true
  release.resolve(undefined)
  await vi.waitFor(() => expect(agent.status).toBe('idle'))
  expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'armed', roundsStarted: 0 })
  expect(adapter.requests).toHaveLength(0)
})
