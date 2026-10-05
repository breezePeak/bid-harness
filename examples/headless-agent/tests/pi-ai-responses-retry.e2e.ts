/** 用合成提示验证 Responses 断流分类后重试实际配置的模型路由。 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { describe, expect, it } from 'vitest'
import { mapStopReason } from '@deepseek-ai/dsh-llm-pi-ai/src/stream.ts'
import { responsesDisconnectMessage } from '../../../scripts/test-fixtures/responses-retry.ts'

const provider = process.env.DSH_PI_AI_RETRY_E2E_PROVIDER
const model = process.env.DSH_PI_AI_RETRY_E2E_MODEL ?? 'gpt-5.6-luna'

describe.skipIf(provider === undefined)('Responses 断流恢复真实 API', () => {
  it('用同一合成请求重试并记录实际提供方完成', { timeout: 200_000, retry: 0 }, async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(AgentSpine, {
        agents: [], workspaceContext: false, skills: { enabled: false }, toolBash: false, toolJobs: false,
        includeHarnessIdentity: false, includeRuntimeContext: false,
      })
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      await ctx.plugin(FileSettingsProvider, { dshHome, watch: false })
      await ctx.plugin(LocalCredentialProvider, { dshHome, watch: false })
      await ctx.plugin(LlmPiAi, {})
      const route = provider ?? ''
      const policy = ctx.llm.providerRetryPolicy(route)
      expect(policy?.mode).toBe('normal')
      if (policy?.mode === 'normal') expect(policy.retryableCodes).toContain('TRANSPORT')
      let requests = 0
      let firstMessages = ''
      ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
        requests += 1
        const messages = JSON.stringify(options.messages)
        if (requests !== 1) {
          expect(messages).toBe(firstMessages)
          return next()
        }
        firstMessages = messages
        const reason = mapStopReason({
          role: 'assistant', api: 'openai-responses', provider: route, model,
          stopReason: 'error', errorMessage: responsesDisconnectMessage, content: [], timestamp: 0,
          usage: {
            input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        })
        return (async function* () {
          yield { type: 'finish', reason } satisfies StreamChunk
        })()
      })
      const agent = ctx.agentLoop.create(SessionId('responses-retry-synthetic-e2e'), { provider: route, model })
      const timeout = setTimeout(() => { agent.cancel({ kind: 'user' }) }, 180_000)
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: '这是程序恢复验证的合成样例。请只回复 PONG，不调用工具。' }],
          source: { kind: 'user' },
        }))
        await agent.whenIdle()
      } finally {
        clearTimeout(timeout)
      }
      expect(requests).toBe(2)
      const recorded: readonly { type: string; data: unknown }[] = agent.session.events
      const retries = recorded.filter(event => event.type === 'llm/retry')
      expect(retries).toHaveLength(1)
      expect(retries[0]?.data).toMatchObject({ retry: 1, failure: { code: 'TRANSPORT', message: responsesDisconnectMessage } })
      const messages = agent.session.deriveMessages()
      const assistant = messages.at(-1)
      expect(assistant?.role).toBe('assistant')
      const text = assistant?.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text?.toUpperCase()).toContain('PONG')
      expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
