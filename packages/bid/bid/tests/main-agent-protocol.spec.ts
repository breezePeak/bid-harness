import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createChapterProtocol } from '../src/chapter-writing-protocol.ts'
import { installMainAgentProtocol, runMainAgentProtocol } from '../src/main-agent-protocol.ts'

async function setup(mode: 'native' | 'both' = 'native') {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime, { mode })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId('private-tools'), { provider: 'mock', model: 'mock' })
  const runtime = createChapterProtocol<string>(agent, 'finish_private_task', 0)
  const definition = { description: '测试工具。', parameters: { type: 'object' as const },
    output: { schema: { type: 'object' as const }, render: () => [] }, execute: async () => ({}) }
  ctx.tools.register({ name: 'read', ...definition })
  ctx.tools.register({ name: 'write', ...definition })
  agent.ctx.tools.register({ name: 'exec', ...definition })
  runtime.register({ name: 'finish_private_task', description: '完成内部任务。', parameters: { type: 'object' },
    execute: async (_args, exec) => runtime.finish(exec, 'done') })
  return { ctx, agent, runtime }
}

class FailureAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_TEST', message: '真实模型失败' } } }
  }
}

describe('Execution Agent 私有协议', () => {
  it('Code Mode 部署的私有任务只展示语义工具，拒绝代码执行并恢复原展示', async () => {
    const { ctx, agent, runtime } = await setup('both')
    try {
      const protocol = installMainAgentProtocol(agent, { privateTools: ['finish_private_task'], label: '私有审核' })
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['finish_private_task'])
      expect((await ctx.tools.execute({ agent, name: 'run_code', arguments: { code: 'return {}' },
        callId: CallId('denied-code-transport'), signal: new AbortController().signal })).isError).toBe(true)
      protocol.dispose()
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('run_code')
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
  it('私有模型仅看见阶段工具，任务释放与恢复不遗留权限，其他 Agent 不受影响', async () => {
    const { ctx, agent, runtime } = await setup()
    const other = ctx.agentLoop.create(SessionId('other-task'), { provider: 'mock', model: 'mock' })
    const base = agent.ctx.tools.restrict({ allow: ['read'] })
    try {
      const before = ctx.tools.schemas(agent).map(tool => tool.name).sort()
      for (let attempt = 0; attempt < 2; attempt++) {
        const protocol = installMainAgentProtocol(agent, { privateTools: ['finish_private_task'],
          internalTools: ['read', 'finish_private_task'], label: '私有审核' })
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['finish_private_task', 'read'])
        expect(ctx.tools.schemas(other).map(tool => tool.name).sort()).toEqual(['read', 'write'])
        for (const name of ['write', 'exec']) {
          expect((await ctx.tools.execute({ agent, name, arguments: {}, callId: CallId('denied-' + name),
            signal: new AbortController().signal })).isError).toBe(true)
        }
        protocol.dispose()
        protocol.dispose()
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(before)
      }
      const privateOnly = installMainAgentProtocol(agent, { privateTools: ['finish_private_task'], label: '只读验收' })
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['finish_private_task'])
      privateOnly.dispose()
      expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(before)
    } finally {
      base()
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('模型失败后释放本轮限制，原 Agent 可恢复原工具集合', async () => {
    const { ctx, agent, runtime } = await setup()
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], new FailureAdapter()))
    try {
      const before = ctx.tools.schemas(agent).map(tool => tool.name).sort()
      await expect(runMainAgentProtocol(agent, '执行私有任务。', ['finish_private_task'], runtime))
        .rejects.toMatchObject({ code: 'MODEL_TEST' })
      expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(before)
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
  it('保留私有任务的真实模型错误', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], new FailureAdapter()))
    const agent = ctx.agentLoop.create(SessionId('interleave-failure'), { provider: 'mock', model: 'mock' })
    const runtime = createChapterProtocol<string>(agent, 'finish_private_task', 0)
    runtime.register({
      name: 'finish_private_task', description: '完成内部任务。', parameters: { type: 'object' },
      execute: async (_args, exec: ToolRunContext) => runtime.finish(exec, 'done'),
    })
    try {
      await expect(runMainAgentProtocol(
        agent, '执行私有任务。', ['finish_private_task'], runtime,
      )).rejects.toMatchObject({ code: 'MODEL_TEST', message: '真实模型失败' })
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
})
