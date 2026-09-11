import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  CallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createChapterProtocol } from '../src/chapter-writing-protocol.ts'
import { runMainAgentProtocol } from '../src/main-agent-interleave.ts'

function call(name: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`${name}-${crypto.randomUUID()}`), name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class InterleaveAdapter extends LlmAdapter {
  readonly started = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  readonly requests: Array<{ tools: string[]; userMessages: string[] }> = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({
      tools: (options.tools ?? []).map(tool => tool.name).sort(),
      userMessages: options.messages.flatMap(message => message.role === 'user' && message.source.kind === 'user'
        ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []),
    })
    switch (this.requests.length) {
      case 1:
        this.started.resolve(undefined)
        await this.release.promise
        yield* call('record_private_progress')
        return
      case 2:
        yield* answer('公开回复已完成，内部任务仍在继续。')
        return
      case 3:
        yield* call('finish_private_task')
        return
      default:
        throw new Error('unexpected interleave model request')
    }
  }
}

describe('Main Agent internal/user interleave', () => {
  it('连续用户消息先回复，私有工具不泄露，随后恢复同一内部任务', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new InterleaveAdapter()
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const agent = ctx.agentLoop.create(SessionId('interleave-main'), { provider: 'mock', model: 'mock' })
    const runtime = createChapterProtocol<string>(agent, 'finish_private_task', 2)
    runtime.register({
      name: 'record_private_progress', description: '记录内部进度。', parameters: { type: 'object' },
      execute: async () => ({ recorded: true }),
    })
    runtime.register({
      name: 'finish_private_task', description: '完成内部任务。', parameters: { type: 'object' },
      execute: async (_args, exec: ToolRunContext) => runtime.finish(exec, 'done'),
    })
    try {
      const result = runMainAgentProtocol(
        agent,
        '执行私有任务并通过 finish_private_task 完成。',
        ['record_private_progress', 'finish_private_task'],
        runtime,
      )
      await adapter.started.promise
      for (const text of ['现在到哪了？', '查了哪些资料？', '为什么这样设计？']) {
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      }
      adapter.release.resolve(undefined)

      await expect(result).resolves.toBe('done')
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(3)
      expect(adapter.requests[0]!.tools).toEqual(['finish_private_task', 'record_private_progress'])
      expect(adapter.requests[1]!.tools).toEqual([])
      expect(adapter.requests[1]!.userMessages.slice(-3)).toEqual(['现在到哪了？', '查了哪些资料？', '为什么这样设计？'])
      expect(adapter.requests[2]!.tools).toEqual(['finish_private_task', 'record_private_progress'])
      const events = agent.session.events
      const reply = events.find(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('公开回复已完成')))
      const finish = events.find(event => event.type === 'tool/call' && event.data.name === 'finish_private_task')
      expect(reply?.seq).toBeLessThan(finish?.seq ?? 0)
      const publicTexts: string[] = []
      for (const event of events) {
        if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
        for (const block of event.data.content) if (block.type === 'text') publicTexts.push(block.text)
      }
      expect(publicTexts).toEqual(['现在到哪了？', '查了哪些资料？', '为什么这样设计？'])
    } finally {
      runtime.dispose()
      await ctx.fiber.dispose()
    }
  })
})
