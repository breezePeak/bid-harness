/** 原生问题在真实 Host、Agent 和 JSONL 重启之间保存答案、执行次数与接纳事实。 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, expect, it, vi } from 'vitest'
import { BidHostRuntime, BidOrchestrator, BidWorkspace, buildBidStageTask, checkpointBidProjectState,
  type BidStageExecutorPort } from '../src/index.ts'
import { bindBidInputRecovery, readBidInputRecovery } from '../src/bid-input-recovery.ts'
import * as inputRecovery from '../src/bid-input-recovery.ts'
import { persistBidWorkRequest } from '../src/work-descriptor.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

class InputLifecycleAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(budget?: number, root?: string) {
  const restarting = root !== undefined
  root ??= await mkdtemp(join(tmpdir(), 'bid-input-lifecycle-'))
  if (!restarting) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock-input'], new InputLifecycleAdapter())
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.sessions'), compression: 'none' })
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(SessionProjectionRegistry)
  const configInput = (budget === undefined ? {} : { modelStageRepairAttempts: budget }) as Parameters<typeof BidHostRuntime.Config>[0]
  const config = BidHostRuntime.Config(configInput)
  const fiber = await ctx.plugin(BidHostRuntime, config)
  const workspace = new BidWorkspace(root)
  const execute = vi.fn<BidStageExecutorPort['execute']>(async () => [])
  const host = ctx.bid as unknown as { automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator
    pendingRunDecisions: Map<string, Promise<void>>
    pendingRunDecisionControllers: Map<string, AbortController>
    inFlight: Map<string, { session: Session; runs: ConstructorParameters<typeof BidOrchestrator>[5] }>
    ensureRunDecision(agent: Agent): void }
  host.automaticOrchestrator = (_agent, _workspace, signal) => {
    const operation = [...host.inFlight.values()][0]
    if (operation === undefined) throw new Error('没有真实 Host 操作')
    return new BidOrchestrator(operation.session, { canExecute: stage => stage === 'evidence_mapping', execute },
      { validate: async () => ({ ok: true, issues: [] }) }, signal, undefined, operation.runs)
  }
  const fresh = async () => {
    const handle = restarting
      ? await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('input-lifecycle-owner'), agentOptions: { provider: 'mock-input', model: 'mock' } })
      : await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('input-lifecycle-owner'), agentOptions: { provider: 'mock-input', model: 'mock' }, meta: { cwd: root, agentPreset: 'bid' } })
    await vi.waitFor(() => { expect(handle.agent.session.events.some(event => event.type === 'bid.project.resumed')).toBe(true) })
    return handle.agent
  }
  return { ctx, workspace, host, fresh, execute, fiber }
}

async function suspend(workspace: BidWorkspace) {
  await seedProjectArtifacts(workspace)
  const stage = 'evidence_mapping' as const
  const payload = { stage }
  const inputs = await Promise.all(buildBidStageTask(stage).inputs.map(async (path) => {
    try { return { path, sha256: createHash('sha256').update(await readFile(join(workspace.projectRoot, path))).digest('hex') } }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, sha256: null }
      throw error
    }
  }))
  const work = await persistBidWorkRequest(workspace, 'stage_execution', stage, payload, { stage, inputs, payload })
  const run = { runId: 'input-original-run', epoch: 1, baseProjectRevision: 0, work, cause: 'user_stop' as const, startedAt: 1, updatedAt: 2 }
  await checkpointBidProjectState(workspace, { stage, status: 'suspended', run })
  return run
}

function binding(agent: Agent, run: Awaited<ReturnType<typeof suspend>>) {
  const required = agent.session.events.find(event => event.type === 'bid.run.decision.required')
  if (required?.type !== 'bid.run.decision.required') throw new Error('真实 Host 没有提出原生问题')
  return bindBidInputRecovery(String(agent.id), run, 'decision', required.data.decisionKey)
}

function answerImmediately(ctx: Context) {
  return ctx.userQuestions.registerProvider({ ask: async ({ questions }) => ({ answers: [{ id: questions[0]!.id,
    selected: ['继续未完成任务（推荐）'] }] }) })
}

it.each([1, undefined])('预算 %s：提问期间卸载和重启不消耗执行次数', async (budget) => {
  const first = await fixture(budget)
  const run = await suspend(first.workspace)
  const asked = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<AskUserQuestionAnswer>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(new Error('测试提问取消')) }, { once: true })
  }))
  first.ctx.userQuestions.registerProvider({ ask: asked })
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(asked).toHaveBeenCalledOnce() })
  const input = binding(agent, run)
  await first.ctx.sessions.flush(agent.session)
  await first.fiber.dispose()
  expect(await readBidInputRecovery(first.workspace, input, 20)).toMatchObject({ phase: 'asking', attempts: 0 })
  const restarted = await fixture(budget, first.workspace.root)
  const release = answerImmediately(restarted.ctx)
  await restarted.fresh()
  await vi.waitFor(() => { expect(restarted.execute).toHaveBeenCalledOnce() })
  expect(await readBidInputRecovery(restarted.workspace, input, 20)).toMatchObject({ attempts: 1, budget: budget ?? 3 })
  release()
}, 20_000)

it.each([1, undefined])('预算 %s：答案落盘后取消保留答案且未调用 resume 不计数', async (budget) => {
  const first = await fixture(budget)
  const run = await suspend(first.workspace)
  answerImmediately(first.ctx)
  const save = inputRecovery.writeBidInputRecovery
  const saved = Promise.withResolvers<undefined>()
  vi.spyOn(inputRecovery, 'writeBidInputRecovery').mockImplementation(async (workspace, record) => {
    await save(workspace, record)
    if (record.phase === 'answered') {
      for (const controller of first.host.pendingRunDecisionControllers.values()) controller.abort(new Error('测试重启'))
      saved.resolve(undefined)
    }
  })
  const resume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun')
  const agent = await first.fresh()
  await saved.promise
  await first.fiber.dispose()
  const input = binding(agent, run)
  expect(resume).not.toHaveBeenCalled()
  expect(await readBidInputRecovery(first.workspace, input, 20)).toMatchObject({ phase: 'answered', attempts: 0, decision: 'continue' })
  await first.ctx.sessions.flush(agent.session)
  vi.restoreAllMocks()
  const restarted = await fixture(budget, first.workspace.root)
  const ask = vi.spyOn(restarted.ctx.userQuestions, 'ask')
  await restarted.fresh()
  await vi.waitFor(() => { expect(restarted.execute).toHaveBeenCalledOnce() })
  expect(ask).not.toHaveBeenCalled()
}, 20_000)

it.each([1, undefined])('预算 %s：已接纳但未结算重启只对账，不重复恢复', async (budget) => {
  const first = await fixture(budget)
  const run = await suspend(first.workspace)
  answerImmediately(first.ctx)
  const resume = first.ctx.bid.resumeCurrentRun.bind(first.ctx.bid)
  const resumed = vi.spyOn(first.ctx.bid, 'resumeCurrentRun').mockImplementation(async (...args) => {
    await resume(...args)
    for (const controller of first.host.pendingRunDecisionControllers.values()) controller.abort(new Error('接纳后退出'))
    throw Object.assign(new Error('接纳后本地结算未执行'), { code: 'EIO' })
  })
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(first.execute).toHaveBeenCalledOnce(); expect(first.host.pendingRunDecisions.size).toBe(0) })
  const input = binding(agent, run)
  const accepted = agent.session.events.find(event => event.type === 'bid.run.started' && event.data.run.resumeOf?.runId === run.runId)
  if (accepted?.type !== 'bid.run.started') throw new Error('原 Run 没有持久接纳事实')
  expect(await readBidInputRecovery(first.workspace, input, 20)).toMatchObject({ phase: 'applying', attempts: 1,
    application: { attempt: 1 } })
  expect(resumed).toHaveBeenCalledOnce()
  await first.ctx.sessions.flush(agent.session)
  await first.fiber.dispose()
  vi.restoreAllMocks()
  const restarted = await fixture(budget, first.workspace.root)
  const ask = vi.spyOn(restarted.ctx.userQuestions, 'ask')
  const repeat = vi.spyOn(restarted.ctx.bid, 'resumeCurrentRun')
  const restored = await restarted.fresh()
  await vi.waitFor(async () => { expect(await readBidInputRecovery(restarted.workspace, input, 20))
    .toMatchObject({ phase: 'applied', attempts: 1,
      application: { accepted_run: { run_id: accepted.data.run.runId, epoch: accepted.data.run.epoch } } }) })
  expect(repeat).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
  expect(restarted.execute).not.toHaveBeenCalled()
  expect(restored.session.events.filter(event => event.type === 'bid.run.started' && event.data.run.resumeOf?.runId === run.runId)).toHaveLength(1)
}, 20_000)

it('应用预占落盘期间取消且尚未调用动作，只撤销这一未执行次数', async () => {
  const first = await fixture(1)
  const run = await suspend(first.workspace)
  answerImmediately(first.ctx)
  const save = inputRecovery.writeBidInputRecovery
  vi.spyOn(inputRecovery, 'writeBidInputRecovery').mockImplementation(async (workspace, record) => {
    await save(workspace, record)
    if (record.phase === 'applying') {
      for (const controller of first.host.pendingRunDecisionControllers.values()) controller.abort(new Error('预占尚未执行时退出'))
    }
  })
  const resume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun')
  const agent = await first.fresh()
  await vi.waitFor(async () => { expect(await readBidInputRecovery(first.workspace, binding(agent, run), 20))
    .toMatchObject({ phase: 'answered', attempts: 0, decision: 'continue' }) })
  expect(resume).not.toHaveBeenCalled()
  await first.fiber.dispose()
}, 20_000)

it('真正开始的暂态失败跨重启持续累计，最终保存阻断且不刷新预算', async () => {
  const first = await fixture(3)
  const run = await suspend(first.workspace)
  answerImmediately(first.ctx)
  const firstResume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun').mockImplementation(async () => {
    for (const controller of first.host.pendingRunDecisionControllers.values()) controller.abort(new Error('失败后退出'))
    throw Object.assign(new Error('已开始应用后的写盘失败'), { code: 'EIO' })
  })
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(firstResume).toHaveBeenCalledOnce(); expect(first.host.pendingRunDecisions.size).toBe(0) })
  const input = binding(agent, run)
  expect(await readBidInputRecovery(first.workspace, input, 20)).toMatchObject({ attempts: 1, budget: 3 })
  await first.ctx.sessions.flush(agent.session)
  await first.fiber.dispose()
  vi.restoreAllMocks()
  const restarted = await fixture(20, first.workspace.root)
  const ask = vi.spyOn(restarted.ctx.userQuestions, 'ask')
  const resumed = vi.spyOn(restarted.ctx.bid, 'resumeCurrentRun').mockRejectedValue(Object.assign(new Error('暂态失败持续存在'), { code: 'EIO' }))
  await restarted.fresh()
  await vi.waitFor(() => { expect(resumed).toHaveBeenCalledTimes(2); expect(restarted.host.pendingRunDecisions.size).toBe(0) })
  expect(await readBidInputRecovery(restarted.workspace, input, 20)).toMatchObject({ phase: 'blocked', attempts: 3, budget: 3,
    error: { code: 'EIO' } })
  expect(ask).not.toHaveBeenCalled()
  expect(restarted.execute).not.toHaveBeenCalled()
}, 20_000)

it.each(['EACCES', 'QUOTA_EXHAUSTED'])('非暂态 %s 只尝试一次并保存阻断', async (code) => {
  const first = await fixture()
  const run = await suspend(first.workspace)
  answerImmediately(first.ctx)
  const resume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun').mockRejectedValue(Object.assign(new Error('不可自动修复'), { code }))
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce(); expect(first.host.pendingRunDecisions.size).toBe(0) })
  expect(resume).toHaveBeenCalledOnce()
  expect(await readBidInputRecovery(first.workspace, binding(agent, run), 20)).toMatchObject({ phase: 'blocked', attempts: 1, error: { code } })
})

it('提问的真实暂态失败使用独立持久次数，不占执行预算', async () => {
  const first = await fixture()
  const run = await suspend(first.workspace)
  const ask = vi.fn(async () => { throw Object.assign(new Error('提问传输暂态失败'), { code: 'EIO' }) })
  first.ctx.userQuestions.registerProvider({ ask })
  const resume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun')
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(ask).toHaveBeenCalledTimes(3); expect(first.host.pendingRunDecisions.size).toBe(0) })
  expect(await readBidInputRecovery(first.workspace, binding(agent, run), 20)).toMatchObject({
    phase: 'blocked', attempts: 0, preparation_failures: 3, budget: 3,
  })
  expect(resume).not.toHaveBeenCalled()
})

it('停止答案在重启后保持停止，不接纳恢复', async () => {
  const first = await fixture(1)
  await suspend(first.workspace)
  first.ctx.userQuestions.registerProvider({ ask: async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: ['停止任务'] }] }) })
  const resume = vi.spyOn(first.ctx.bid, 'resumeCurrentRun')
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(agent.session.events.some(event => event.type === 'bid.run.decision.received'
    && event.data.decision === 'stop')).toBe(true); expect(first.host.pendingRunDecisions.size).toBe(0) })
  expect(resume).not.toHaveBeenCalled()
  await first.ctx.sessions.flush(agent.session)
  await first.fiber.dispose()
  const restarted = await fixture(1, first.workspace.root)
  const ask = vi.spyOn(restarted.ctx.userQuestions, 'ask')
  await restarted.fresh()
  expect(ask).not.toHaveBeenCalled()
  expect(restarted.execute).not.toHaveBeenCalled()
}, 20_000)

it('接纳后真实用户停止保留执行次数，重启对账不复活已停止的 Run', async () => {
  const first = await fixture(1)
  const run = await suspend(first.workspace)
  const releaseAnswer = answerImmediately(first.ctx)
  first.execute.mockImplementation(async (_task, active) => {
    await new Promise<void>((resolve) => { active.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    active.signal.throwIfAborted()
    return []
  })
  const agent = await first.fresh()
  await vi.waitFor(() => { expect(first.execute).toHaveBeenCalledOnce() })
  const input = binding(agent, run)
  releaseAnswer()
  first.ctx.userQuestions.registerProvider({ ask: ({ signal }) => new Promise<AskUserQuestionAnswer>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(new Error('测试提问取消')) }, { once: true })
  }) })
  await first.ctx.bid.stopRun(agent.session)
  await vi.waitFor(() => {
    expect(first.host.inFlight.size).toBe(0)
    expect(first.host.pendingRunDecisions.has(input.question_key)).toBe(false)
  })
  expect(await readBidInputRecovery(first.workspace, input, 20)).toMatchObject({ attempts: 1 })
  await first.ctx.sessions.flush(agent.session)
  await first.fiber.dispose()
  const restarted = await fixture(1, first.workspace.root)
  const waiting = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<AskUserQuestionAnswer>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(new Error('测试提问取消')) }, { once: true })
  }))
  restarted.ctx.userQuestions.registerProvider({ ask: waiting })
  await restarted.fresh()
  await vi.waitFor(async () => { expect(await readBidInputRecovery(restarted.workspace, input, 20)).toMatchObject({ phase: 'applied', attempts: 1 }) })
  expect(restarted.execute).not.toHaveBeenCalled()
}, 20_000)
