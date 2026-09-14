import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createChapterProtocol } from '../src/chapter-writing-protocol.ts'
import { runMainAgentProtocol } from '../src/main-agent-protocol.ts'

class FailureAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_TEST', message: '真实模型失败' } } }
  }
}

describe('Execution Agent 私有协议', () => {
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
