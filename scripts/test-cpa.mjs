/** CPA 实测：--search-only 仅测搜索；--without-max-tool-calls 探测不支持次数参数的端点。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../vendor/cordis/lib/index.js'
import LlmRuntime, { createUserMessage } from '../packages/llm/llm/lib/index.js'
import Credentials from '../packages/credentials/credentials-local/lib/index.js'
import * as GPT from '../packages/llm/llm-pi-ai/lib/gpt.js'

const ctx = new Context()
const send = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (process.argv.includes('--without-max-tool-calls') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body)
    delete body.max_tool_calls
    init = { ...init, body: JSON.stringify(body) }
  }
  const response = await send(url, init)
  if (!response.ok) {
    const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '')
    const body = await response.clone().json().catch(() => ({}))
    const detail = JSON.stringify(body.error ?? body.detail ?? body.message ?? body)
    console.error(`HTTP ${response.status}: ${key ? detail.replaceAll(key, '[REDACTED]') : '无认证信息'}`)
  } else if (process.argv.includes('--search-only')) {
    const body = await response.clone().json().catch(() => ({}))
    console.log(JSON.stringify({ status: body.status, outputTypes: body.output?.map(item => item.type),
      searches: body.output?.filter(item => item.type === 'web_search_call').map(item => ({ status: item.status, action: item.action?.type })) }))
  }
  return response
}
let step = '读取 pp 配置'
try {
  const { parse } = createRequire(new URL('../packages/settings/settings-file/package.json', import.meta.url))('yaml')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const pp = parse(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))['llm-pi-ai']?.providers?.pp
  const model = pp?.models?.find(item => item.id === 'gpt-5.6-luna')
  assert.ok(pp?.baseURL && pp.apiKeyEnv && model, '缺少 pp / gpt-5.6-luna 配置')
  await ctx.plugin(Credentials, { dshHome, watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(GPT, { baseURL: pp.baseURL, apiKeyEnv: pp.apiKeyEnv, models: [model], timeoutMs: 60_000 })

  if (!process.argv.includes('--search-only')) {
    const options = { provider: 'gpt', model: model.id, maxTokens: 256 }
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'Call cpa_ping with no arguments. After receiving its result, reply with that result exactly.' }],
      source: { kind: 'user' },
    })]
    const tools = [{ name: 'cpa_ping', description: 'Return the CPA connectivity test result.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }]
    step = 'Responses 流式函数调用'
    const first = await ctx.llm.generate({ ...options, messages, tools })
    assert.equal(first.finish.kind, 'tool-calls', first.finish.failure?.code ?? '未返回函数调用')
    const call = first.message.content.find(block => block.type === 'tool-call' && block.name === 'cpa_ping')
    assert.ok(call, '未调用 cpa_ping')
    console.log(`PASS ${step}`)

    step = '工具结果回传与文本输出'
    const second = await ctx.llm.generate({ ...options, tools, messages: [...messages, first.message,
      createUserMessage({ content: [{ type: 'tool-result', toolCallId: call.id,
        content: [{ type: 'text', text: 'CPA_OK' }] }], source: { kind: 'user' } }),
    ] })
    assert.equal(second.finish.kind, 'stop', second.finish.failure?.code ?? '未正常结束')
    assert.equal(second.message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim(), 'CPA_OK')
    console.log(`PASS ${step}: CPA_OK; usage=${JSON.stringify(second.usage)}`)
  }

  step = 'hosted web_search'
  const result = await ctx.llm.webSearch('gpt', { query: 'site:iana.org example domains' }, {
    model: model.id, maxUses: 1, signal: AbortSignal.timeout(60_000),
    recordRequest: ({ endpoint }) => { assert.ok(endpoint.endsWith('/v1/responses')) },
  })
  assert.ok(result.sources.length > 0, '搜索未返回结构化来源')
  console.log(`PASS ${step}: ${result.sources.length} 个来源`)
  console.log(JSON.stringify(result.sources.slice(0, 3)))
} catch (error) {
  console.error(`FAIL ${step}: ${error.failure?.code ?? error.code ?? error.name}; ${error.failure?.message ?? '测试断言失败'}`)
  process.exitCode = 1
} finally {
  globalThis.fetch = send
  await ctx.fiber.dispose()
}
