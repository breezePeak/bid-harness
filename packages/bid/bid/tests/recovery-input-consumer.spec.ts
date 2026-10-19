/** 独立 S3 子任务通过真实工具分页读取原始长输入，权限随所属任务释放。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { bidContinuationInstruction, installBidRecoveryInputReader } from '../src/bid-user-input.ts'
import { generateScopedOutlineOperations } from '../src/outline-generation-executor.ts'
import { outlineArtifactSha256 } from '../src/outline-confirmation-artifacts.ts'
import type { BidWorkDescriptor } from '../src/control-plane-contract.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

it('S3 独立工具过滤器保留本任务读取器，完整消费超过 16k 的单条输入并拒绝无权读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-input-'))
  const base = fileURLToPath(new URL('../../../../examples/headless-agent/bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const path = join(root, 'cordis.yml')
  await writeFile(path, (await readFile(base, 'utf8'))
    .replace("root: './.session-store'", `root: '${join(root, '.sessions').replaceAll('\\', '/')}'`)
    .replace("- name: '../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'\n", '')
    .replace("- name: '@deepseek-ai/dsh-bid'\n", ''))
  const ctx = await boot('recovery-input-consumer', path, undefined, undefined,
    new URL('../../../../examples/headless-agent/', import.meta.url).href)
  try {
    const original = '背景资料。'.repeat(4000) + '末尾业务要求：增加交付追溯说明。'
    let page = 0
    const consumed: string[] = []
    class ReaderAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        expect(options.tools?.map(tool => tool.name)).toEqual(['bid_read_recovery_input'])
        const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
        if (result?.type === 'tool-result') {
          const content = result.content.find(block => block.type === 'text')
          if (content?.type !== 'text') throw new Error('缺少输入分页结果')
          const value = JSON.parse(content.text) as { text: string; has_more: boolean }
          consumed.push(value.text)
          if (!value.has_more) {
            expect(consumed.join('')).toBe(original)
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify([
              { type: 'update_section', section_position: 0, writing_notes: ['增加交付追溯说明。'] },
            ]) } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`read-${page}`),
          name: 'bid_read_recovery_input', arguments: JSON.stringify({ input_position: 1, page: page++ }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], new ReaderAdapter()))
    const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('recovery-input'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
    const work: BidWorkDescriptor = { kind: 'outline_regeneration', workId: 'outline', stage: 'outline_generation',
      requestRef: 'requests/outline.json', requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) }
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: original }] }), { surfaceOp: 'append' })
    agent.session.append('bid.run.started', { run: { work, runId: 'original', epoch: 1, baseProjectRevision: 0, startedAt: 1, updatedAt: 1 } })
    const modelContext = bidContinuationInstruction(agent.session, work, '继续')
    expect(modelContext.text.length).toBeLessThan(16_000)
    expect(modelContext.text).toContain('bid_read_recovery_input')
    let live = true
    installBidRecoveryInputReader(agent, () => live ? modelContext.inputs : undefined)
    const outline = await seedProjectArtifacts(new BidWorkspace(root))
    const hash = outlineArtifactSha256(outline)
    const operations = await generateScopedOutlineOperations(agent, { schema_version: 1, scope: 'technical_bid', revision: 1,
      source_outline_sha256: hash, draft_outline_sha256: hash, outline }, ['SEC-1'], '按原始输入补充', new AbortController().signal,
    { workId: work.workId, instruction: '继续', unit: 'outline/outline.json', modelContext, issues: [] })
    expect(operations).toEqual([{ type: 'update_section', section_id: 'SEC-1', writing_notes: ['增加交付追溯说明。'] }])
    expect(consumed.length).toBeGreaterThan(4)
    const { agent: unrelated } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('unrelated'), agentOptions: { provider: 'mock', model: 'mock' } })
    const read = (target: typeof agent, input_position = 1, requestedPage = 0) => ctx.tools.execute({ agent: target,
      name: 'bid_read_recovery_input', arguments: { input_position, page: requestedPage }, callId: CallId('unauthorized'), signal: new AbortController().signal })
    expect(await read(unrelated)).toMatchObject({ isError: true })
    expect(await read(agent, 50)).toMatchObject({ isError: true })
    expect(await read(agent, 1, -1)).toMatchObject({ isError: true })
    live = false
    expect(await read(agent)).toMatchObject({ isError: true })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
