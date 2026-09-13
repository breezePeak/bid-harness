import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as hostedSearch from '../src/index.ts'

const result = { sources: [], truncated: false }

function agent(provider: string, model: string): Agent {
  return {
    options: { provider, model },
    session: { requestHeader: () => ({ config: { provider, model } }) },
  } as unknown as Agent
}

async function mount(policy: hostedSearch.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentDefaultModel, { provider: 'default', model: 'default-model' })
  await ctx.plugin(WebRuntime, { searchProvider: hostedSearch.LLM_HOSTED_SEARCH_PROVIDER_ID })
  await ctx.plugin(hostedSearch, policy)
  return ctx
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LLM hosted-search routing', () => {
  it('uses the initiating task provider and model while Tavily is installed', async () => {
    const ctx = await mount()
    const hosted = vi.spyOn(ctx.llm, 'webSearch').mockResolvedValue(result)
    const tavily = vi.fn(async () => result)
    ctx.web.registerSearchProvider({ id: 'tavily', available: async () => false, search: tavily })

    await ctx.agents.withInitiator(agent('pp', 'gpt-5.6-luna'), () => ctx.web.search({ query: 'q' }))

    expect(hosted).toHaveBeenCalledWith('pp', { query: 'q' }, expect.objectContaining({ model: 'gpt-5.6-luna' }))
    expect(tavily).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('uses an explicit search Provider instead of the task Provider', async () => {
    const ctx = await mount({ provider: 'provider-b' })
    vi.spyOn(ctx.llm, 'listModels').mockResolvedValue([{ provider: 'provider-b', id: 'search-model', name: 'Search model' }])
    const hosted = vi.spyOn(ctx.llm, 'webSearch').mockResolvedValue(result)

    await ctx.agents.withInitiator(agent('provider-a', 'task-model'), () => ctx.web.search({ query: 'q' }))

    expect(hosted).toHaveBeenCalledWith('provider-b', { query: 'q' }, expect.objectContaining({ model: 'search-model' }))
    await ctx.fiber.dispose()
  })

  it('routes a subagent initiator by that subagent model selection', async () => {
    const ctx = await mount()
    const hosted = vi.spyOn(ctx.llm, 'webSearch').mockResolvedValue(result)
    const parent = agent('parent-provider', 'parent-model')
    const child = agent('pp', 'gpt-5.6-luna')

    await ctx.agents.withInitiator(parent, () => ctx.agents.withInitiator(child, () => ctx.web.search({ query: 'q' })))

    expect(hosted).toHaveBeenCalledWith('pp', { query: 'q' }, expect.objectContaining({ model: 'gpt-5.6-luna' }))
    await ctx.fiber.dispose()
  })
})
