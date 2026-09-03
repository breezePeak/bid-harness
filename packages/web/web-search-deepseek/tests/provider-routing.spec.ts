/** Real Loader composition with HTTP-only provider doubles and the production Agent Tool loop. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as GPT from '@deepseek-ai/dsh-llm-pi-ai/gpt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Web from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as Search from '../src/index.ts'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE = 'https://source.example/spec'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

function responsesEvents(tool?: { name: string; args: object }): object[] {
  const item = tool === undefined
    ? { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成', annotations: [] }] }
    : { type: 'function_call', id: `fc_${tool.name}`, call_id: `call_${tool.name}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
  return [
    { type: 'response.created', response: { id: 'resp_test' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, ...tool === undefined ? { content: [] } : { arguments: '' } } },
    tool === undefined
      ? { type: 'response.output_text.delta', output_index: 0, delta: '完成' }
      : { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(tool.args) },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
}

function chatEvents(tool?: { name: string; args: object }): object[] {
  return [{ choices: [{ index: 0, delta: tool === undefined ? { content: '完成' } : {
    tool_calls: [{ index: 0, id: `call_${tool.name}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }],
  }, finish_reason: tool === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }]
}

async function fixture(options: {
  provider?: string
  settings?: object
  status?: number
  hold?: boolean
  textOnly?: boolean
  settingsText?: string
  malformed?: boolean
} = {}) {
  vi.stubEnv('PROVIDER_TEST_KEY', '')
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-routing-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const requests: { path: string; body: Record<string, unknown>; authorization: string | undefined }[] = []
  let step = 0
  let held: ServerResponse | undefined
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += String(chunk) })
    request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ path: request.url!, body, authorization: request.headers.authorization })
      if (options.hold) { held = response; return }
      if (options.status) { response.writeHead(options.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'provider-test-secret', code: 'unsupported' } })); return }
      if (options.malformed) {
        response.writeHead(200, { 'content-type': body.stream === true ? 'text/event-stream' : 'application/json' })
          .end(body.stream === true ? 'data: provider-test-secret\n\n' : 'provider-test-secret')
        return
      }
      if (body.stream !== true) {
        const payload = request.url?.endsWith('/messages')
          ? { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: SOURCE, title: '标准' }] }] }
          : { output: [
            { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: SOURCE }] } },
            { type: 'message', content: [{ type: 'output_text', text: 'This generated answer is not evidence', annotations: [{ type: 'url_citation', url: SOURCE, title: '标准', start_index: 0, end_index: 4 }] }] },
          ] }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
        return
      }
      const tool = options.textOnly ? undefined : step++ === 0 ? { name: 'web_search', args: { queries: ['安全标准'] } }
        : step === 2 ? { name: 'web_fetch', args: { url: SOURCE } } : undefined
      const events = request.url?.endsWith('/responses') ? responsesEvents(tool) : chatEvents(tool)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end(request.url?.endsWith('/responses') ? '' : 'data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    held?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no test port')
  const url = `http://127.0.0.1:${address.port}`
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, options.settingsText ?? JSON.stringify(options.settings ?? {}))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, 'version: 1\nrefs:\n  PROVIDER_TEST_KEY: provider-test-secret\n')
  const modules = {
    llm: LlmRuntime, settings: FileSettings, credentials: Credentials, defaultModel: AgentDefaultModel,
    deepseek: DeepSeek, gpt: GPT, agents: AgentRegistry, loop: AgentLoop, sessions: SessionStore,
    prompt: SystemPrompt, tools: Tools, web: Web, search: Search, toolWeb: ToolWeb,
    subagents: Subagents, spawn: Spawn, persistence: Persistence,
  }
  const composition: { id: keyof typeof modules; name: string; config?: object }[] =
    JSON.parse(await readFile(new URL('../../../../examples/headless-agent/tests/fixtures/web/web-search-deepseek/cordis.yml', import.meta.url), 'utf8')) as { id: keyof typeof modules; name: string; config?: object }[]
  const entries = composition.map(entry => ({ ...entry, config: { ...entry.config, ...({
    settings: { path: settingsPath, watch: false }, credentials: { path: credentialsPath, watch: false },
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    deepseek: { baseURL: `${url}/ds`, apiKeyEnv: 'PROVIDER_TEST_KEY', thinking: 'disabled', maxTokens: 64 },
    gpt: { baseURL: `${url}/proxy`, apiKeyEnv: 'PROVIDER_TEST_KEY', models: [{ id: 'gpt-test', contextWindow: 10000, maxTokens: 64 }] },
    loop: { agents: [] }, prompt: { persona: '使用搜索和读取工具查阅标准。' },
    web: { searchProvider: 'deepseek-official' },
    persistence: { root: join(root, 'sessions'), compression: 'none' },
  } as Record<string, object>)[entry.id] } }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(entries))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    const entry = composition.find(entry => entry.name === name)
    if (entry === undefined) throw new Error(`unexpected fixture plugin ${name}`)
    return modules[entry.id]
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.web.registerFetchProvider({ id: 'fixture-page', available: () => true, async fetch(request) {
    return { url: request.url, statusCode: 200, body: { kind: 'text', content: '原始标准正文：保留访问控制与审计记录。' }, truncated: false }
  } })
  if (options.provider === 'gpt') await ctx.agentDefaultModel.saveSelection({ provider: 'gpt', model: 'gpt-test' })
  return { ctx, root, settingsPath, requests }
}

describe('Provider routing through a Loader-created Agent', () => {
  it.each(['deepseek-official', 'gpt'])('%s executes search → fetch through the existing tool loop', async (provider) => {
    const { ctx, requests, settingsPath } = await fixture({ provider })
    const agent = ctx.agentLoop.create(SessionId('provider-task'), ctx.agentDefaultModel.currentSelection())
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '查阅标准' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const calls = agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['web_search', 'web_fetch'])
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(JSON.stringify(results)).toContain('原始标准正文')
    expect(JSON.stringify(results)).not.toContain('This generated answer is not evidence')
    const searchRequest = requests.find(request => request.body.stream !== true)!
    expect(searchRequest.body.tools).toEqual(provider === 'gpt' ? [{ type: 'web_search' }]
      : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    expect(requests.map(request => request.path)).toEqual(provider === 'gpt'
      ? Array(4).fill('/proxy/v1/responses')
      : ['/ds/chat/completions', '/ds/anthropic/v1/messages', '/ds/chat/completions', '/ds/chat/completions'])
    expect(requests.every(request => request.authorization === 'Bearer provider-test-secret')).toBe(true)
    expect(JSON.stringify(agent.session.events)).not.toContain('provider-test-secret')
    expect(ctx.settings.describe({ redactSecrets: true }).some(row => row.ns === 'llm-gpt')).toBe(true)
    if (provider === 'gpt') {
      expect(await readFile(settingsPath, 'utf8')).toContain('gpt-test')
      expect(requests[2]!.body.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output' })]))
    }
    expect({ calls, discovery: searchRequest.body.tools, final: agent.session.events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content })
      .toMatchSnapshot()
  })

  it('migrates legacy search connection fields into the Provider without losing secrets', async () => {
    const { ctx, settingsPath } = await fixture({ settings: { 'web-search-deepseek': { apiKey: 'legacy-key', model: 'legacy-search', maxUses: 2 } } })
    await ctx.web.search({ query: 'migration' })
    const stored = await readFile(settingsPath, 'utf8')
    expect(stored).toContain('legacy-key')
    const described = ctx.settings.describe({ redactSecrets: true })
    expect(JSON.stringify(described)).not.toContain('legacy-key')
    expect(ctx.settings.get(settingsNamespace('web-search-deepseek'))).toEqual({ maxUses: 2 })
    expect(ctx.settings.get(settingsNamespace('llm-deepseek'))).toMatchObject({ search: { apiKey: 'legacy-key', model: 'legacy-search' } })
  })

  it('rejects an unsupported Responses endpoint without exposing its echoed key', async () => {
    const { ctx, requests } = await fixture({ provider: 'gpt', status: 404 })
    const result = await ctx.llm.generate({ provider: 'gpt', model: 'gpt-test', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_RESPONSES_API', message: 'GPT Provider does not support Responses API' } })
    expect(JSON.stringify(result)).not.toContain('provider-test-secret')
    expect(requests).toHaveLength(1)
  })

  it('stops a GPT model request without continuing the tool loop', async () => {
    const { ctx, requests } = await fixture({ provider: 'gpt', hold: true })
    const agent = ctx.agentLoop.create(SessionId('abort-task'), ctx.agentDefaultModel.currentSelection())
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '等待' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })

  it.each(['one-shot', 'continuable'])('%s children inherit the parent request selection despite stale creation options', async (mode) => {
    const { ctx, requests } = await fixture({ textOnly: true })
    const parent = ctx.agentLoop.create(SessionId('parent-task'), ctx.agentDefaultModel.currentSelection())
    installModelSelection(parent.ctx, { current: { provider: 'gpt', model: 'gpt-test' }, assembled: undefined })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: '父任务' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(parent.options.provider).toBe('deepseek-official')
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => { if (agent !== parent) child = agent })
    const spec = { provider: 'spawn', label: '子任务', request: { parent, prompt: [{ type: 'text' as const, text: '继续' }] }, signal: new AbortController().signal }
    if (mode === 'one-shot') {
      const run = await ctx.subagents.start('spawn', { ...spec.request, signal: spec.signal, label: spec.label })
      expect((await run.result).stopReason).toBe('completed')
      await run.dispose()
    } else {
      const started = await ctx.subagents.startContinuable(spec)
      await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    }
    await parent.whenIdle()
    expect(child?.session.requestHeader()?.config).toMatchObject({ provider: 'gpt', model: 'gpt-test' })
    expect(requests.map(request => request.path)).toEqual(Array(mode === 'continuable' ? 3 : 2).fill('/proxy/v1/responses'))
  })

  it('reloads the saved default after restart while an existing task retains its model', async () => {
    const { ctx, settingsPath } = await fixture({ textOnly: true })
    const parent = ctx.agentLoop.create(SessionId('before-switch'), ctx.agentDefaultModel.currentSelection())
    await ctx.agentDefaultModel.saveSelection({ provider: 'gpt', model: 'gpt-test' })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: '原任务' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(parent.session.requestHeader()?.config.provider).toBe('deepseek-official')
    const restarted = await fixture({ textOnly: true, settingsText: await readFile(settingsPath, 'utf8') })
    expect(restarted.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'gpt', model: 'gpt-test' })
    const agent = restarted.ctx.agentLoop.create(SessionId('after-restart'), restarted.ctx.agentDefaultModel.currentSelection())
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '新任务' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(restarted.requests[0]?.path).toBe('/proxy/v1/responses')
  })

  it('keeps DeepSeek usable after rejecting invalid GPT configuration', async () => {
    const { ctx, requests } = await fixture({ textOnly: true })
    await expect(ctx.settings.mutate(settingsNamespace('llm-gpt'), [{ op: 'set', path: ['baseURL'], value: 'invalid' }])).rejects.toThrow()
    const result = await ctx.llm.generate({ ...ctx.agentDefaultModel.currentSelection(), messages: [] })
    expect(result.finish.kind).toBe('stop')
    expect(requests[0]?.path).toBe('/ds/chat/completions')
  })

  it.each(['deepseek-official', 'gpt'])('%s redacts a key echoed in an upstream HTTP error', async (provider) => {
    const { ctx } = await fixture({ provider, status: 401 })
    const result = await ctx.llm.generate({ ...ctx.agentDefaultModel.currentSelection(), messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(JSON.stringify(result)).not.toContain('provider-test-secret')
    expect(JSON.stringify(result)).toContain(provider === 'gpt' ? 'GPT Provider' : 'DeepSeek Provider')
    await expect(ctx.web.search({ query: 'error' })).rejects.not.toThrow('provider-test-secret')
  })

  it.each(['deepseek-official', 'gpt'])('%s redacts a key in malformed stream and search responses', async (provider) => {
    const { ctx } = await fixture({ provider, malformed: true })
    const result = await ctx.llm.generate({ ...ctx.agentDefaultModel.currentSelection(), messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(JSON.stringify(result)).not.toContain('provider-test-secret')
    await expect(ctx.web.search({ query: 'malformed' })).rejects.not.toThrow('provider-test-secret')
  })
})
