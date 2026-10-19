/** 经 LLM 注册入口验证视觉复核的输出预算和终止诊断。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { LlmAdapter, resolveRetryPolicy, type GenerateOptions, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { createDocxVisualReviewer, type VisualReviewInput } from '../src/docx-visual-review.ts'

class BudgetAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly budget: number | undefined, private readonly failures: readonly LlmFailure[] = []) { super() }
  override providerRetryPolicy() {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, '视觉复核测试')
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const,
      ...(this.budget === undefined ? {} : { defaultMaxTokens: this.budget }) })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const failure = this.failures[this.calls.length - 1]
    if (failure !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    if ((options.maxTokens ?? 0) < 2_048) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"status":"pass"}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each<{
  configured: number | undefined
  model: number | undefined
  expected: number
  failures?: LlmFailure[]
  error?: string
  calls?: number
  inheritedDefault?: boolean
}>([
  { configured: 4_096, model: 8_192, expected: 4_096 },
  { configured: undefined, model: 8_192, expected: 8_192 },
  { configured: undefined, model: undefined, expected: 4_096 },
  { configured: 4_096, model: 8_192, expected: 8_192, inheritedDefault: true },
  { configured: 512, model: 8_192, expected: 512 },
  { configured: 4_096, model: 8_192, expected: 4_096,
    failures: [{ code: 'SERVER', message: '503 temporary failure' }], calls: 2 },
  { configured: 4_096, model: 8_192, expected: 4_096,
    failures: [{ code: 'AUTH', message: '401 unauthorized' }], error: 'DOCX_VISUAL_REVIEW_INCOMPLETE:error:AUTH:401 unauthorized' },
  { configured: 4_096, model: 8_192, expected: 4_096,
    failures: [{ code: 'SERVER', message: '503 temporary failure' }, { code: 'SERVER', message: '503 repeated failure' }],
    calls: 2, error: 'DOCX_VISUAL_REVIEW_INCOMPLETE:error:SERVER:503 repeated failure' },
])('视觉复核保留输出预算 $expected 和终止原因', async ({ configured, model, expected, failures, error, calls = 1, inheritedDefault }) => {
  const root = await mkdtemp(join(tmpdir(), 'bid-visual-budget-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AttachmentLocal, { dshHome: root })
    const adapter = new BudgetAdapter(model, failures)
    ctx.effect(() => ctx.llm.registerAdapter(['visual-budget'], adapter))
    const session = ctx.sessions.create()
    session.append('request/header', { header: { config: { provider: 'visual-budget', model: 'test',
      ...(configured === undefined ? {} : { maxTokens: configured }) },
    ...(inheritedDefault === true ? { adapterDefaults: { maxTokens: true } } : {}) }, reason: 'initial' })
    const input: VisualReviewInput = { block: { blockId: 'table-test', inputHash: `sha256:${'a'.repeat(64)}`,
      kind: 'table', anchor: ['测试表'], boundary: 'within-page' }, pages: [{ page: 1, pageCount: 1,
      data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') }] }
    const result = createDocxVisualReviewer(ctx, session).review(input)
    if (expected === 512) await expect(result).rejects.toThrow('DOCX_VISUAL_REVIEW_INCOMPLETE:max-tokens')
    else if (error !== undefined) await expect(result).rejects.toThrow(error)
    else expect(await result).toEqual({ status: 'pass' })
    expect(adapter.calls).toHaveLength(calls)
    expect(adapter.calls.every(call => call.maxTokens === expected)).toBe(true)
    expect(session.events.filter(event => event.type === 'bid.visual-review.request')).toHaveLength(calls)
    expect(session.events.findLast(event => event.type === 'bid.visual-review.request')?.data.maxTokens).toBe(expected)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
