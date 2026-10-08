/** 真实 Loader 的待答卸载、保存答案、生产文件导入和接纳对账回放。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, checkpointBidProjectState, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { bindBidInputRecovery, readBidInputRecovery } from '../../../../packages/bid/bid/src/bid-input-recovery.ts'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'

class InputRecoveryAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '原任务已继续，DOCX 无法解析，请重新提供可读取的文件。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少输入恢复回放配置')
const workspace = new BidWorkspace(process.cwd())
const workId = randomUUID()
const bytes = Buffer.from('not a zip archive', 'utf8')
const bytesRef = `requests/${workId}/files/0001`
await mkdir(join(workspace.projectRoot, 'requests', workId, 'files'), { recursive: true })
await writeFile(join(workspace.projectRoot, bytesRef), bytes)
const files = [{ name: 'input-recovery-broken.docx', role: 'tender' as const, bytes_ref: bytesRef,
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
const work = await persistBidWorkRequest(workspace, 'file_intake', 'file_intake', { files }, files, workId)
const run = { runId: randomUUID(), epoch: 1, baseProjectRevision: 0, work,
  cause: 'user_stop' as const, startedAt: 1, updatedAt: 2 }
await checkpointBidProjectState(workspace, { stage: 'file_intake', status: 'suspended', run })
const sessionId = SessionId('input-recovery-loader-owner')
let ctx: Context | undefined
const start = async (restoring: boolean) => {
  ctx = await boot('bid-input-recovery-snapshot', configPath)
  ctx.effect(() => ctx!.llm.registerAdapter(['input-snapshot'], new InputRecoveryAdapter()))
  const initialized = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'bid.project.resumed') initialized.resolve(undefined)
  }, { global: true })
  const create = async () => {
    const handle = restoring ? await ctx!.agentLoop.resume(ctx!, { resumeSessionId: sessionId,
      agentOptions: { provider: 'input-snapshot', model: 'mock' } })
      : await ctx!.agentLoop.createAgent(ctx!, { sessionId, agentOptions: { provider: 'input-snapshot', model: 'mock' },
        meta: { cwd: workspace.root, agentPreset: 'bid' } })
    await initialized.promise
    off()
    return handle.agent
  }
  return { ctx, create, host: ctx.bid as unknown as { pendingRunDecisions: Map<string, Promise<void>>
    inFlight: Map<string, { done: Promise<void> }> } }
}
try {
  const first = await start(false)
  const asked = Promise.withResolvers<undefined>()
  first.ctx.userQuestions.registerProvider({ ask: ({ signal }) => {
    asked.resolve(undefined)
    return new Promise<AskUserQuestionAnswer>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('测试提问取消')) }, { once: true })
    })
  } })
  const original = await first.create()
  await asked.promise
  const question = original.session.events.find(event => event.type === 'bid.run.decision.required')
  if (question?.type !== 'bid.run.decision.required') throw new Error('原问题未持久发布')
  const binding = bindBidInputRecovery(String(sessionId), run, 'decision', question.data.decisionKey)
  await first.ctx.sessions.flush(original.session)
  await first.ctx.fiber.dispose()
  const waiting = await readBidInputRecovery(workspace, binding, 20)
  const second = await start(true)
  const answered = Promise.withResolvers<undefined>()
  let resumedQuestions = 0
  second.ctx.userQuestions.registerProvider({ ask: async ({ questions }) => {
    resumedQuestions++
    answered.resolve(undefined)
    return { answers: [{ id: questions[0]!.id, selected: ['继续未完成任务（推荐）'] }] }
  } })
  const continued = await second.create()
  await answered.promise
  await Promise.all([...second.host.pendingRunDecisions.values()])
  await Promise.all([...second.host.inFlight.values()].map(operation => operation.done))
  await continued.whenIdle()
  const applied = await readBidInputRecovery(workspace, binding, 20)
  const started = continued.session.events.find(event => event.type === 'bid.run.started'
    && event.data.run.resumeOf?.runId === run.runId)
  await second.ctx.sessions.flush(continued.session)
  await second.ctx.fiber.dispose()
  const third = await start(true)
  let repeatedQuestions = 0
  third.ctx.userQuestions.registerProvider({ ask: async () => { repeatedQuestions++; return { answers: [] } } })
  const restored = await third.create()
  await Promise.all([...third.host.inFlight.values()].map(operation => operation.done))
  const settled = await readBidInputRecovery(workspace, binding, 20)
  const state = await readBidProjectState(workspace)
  const manifest = await workspace.readManifest()
  process.stdout.write(`${JSON.stringify({
    waiting: { phase: waiting.phase, attempts: waiting.attempts, budget: waiting.budget },
    applied: { phase: applied.phase, attempts: applied.attempts, budget: applied.budget, decision: applied.decision,
      applicationBound: applied.application?.attempt === applied.attempts && /^[a-f0-9]{64}$/u.test(applied.application.id),
      acceptedBound: started?.type === 'bid.run.started' && applied.application?.accepted_run?.run_id === started.data.run.runId
        && applied.application.accepted_run.epoch === started.data.run.epoch },
    settled: { phase: settled.phase, attempts: settled.attempts, budget: settled.budget },
    resumedQuestions, repeatedQuestions,
    resumeStarts: restored.session.events.filter(event => event.type === 'bid.run.started'
      && event.data.run.resumeOf?.runId === run.runId && event.data.run.work.workId === work.workId).length,
    required: restored.session.events.filter(event => event.type === 'bid.run.decision.required').map(event => event.data.question.options?.map(option => option.label)),
    received: restored.session.events.filter(event => event.type === 'bid.run.decision.received').map(event => event.data.decision),
    productionImport: { preservedBytes: (await readFile(join(workspace.projectRoot, 'input/input-recovery-broken.docx'))).equals(bytes),
      parseStatus: manifest.files[0]?.parseStatus, parseError: manifest.files[0]?.parseError },
    task: { stage: state?.stage, status: state?.status, code: state?.status === 'failed' ? state.failure.code : undefined },
  })}\n`)
} finally { await ctx?.fiber.dispose() }
