/** 恢复轮的持久化派发窗口、实际 Agent 工具执行与原 Work 预算。 */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidRecoveryDriver, type BidRecoveryNotice } from '../src/bid-recovery-driver.ts'
import { bidRecoverableRun, bidRunRecoveryEligibility } from '../src/bid-recovery.ts'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from '../src/runtime-state.ts'
import { BidRunCoordinator, DirectBidRunScheduler } from '../src/run-coordinator.ts'
import { checkpointBidProjectState, readBidProjectState } from '../src/project-state.ts'
import { BidWorkspace } from '../src/index.ts'
import type { BidTaskFailure, BidWorkDescriptor } from '../src/control-plane-contract.ts'

class RecoveryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  gate?: Promise<void>
  reply?: (options: GenerateOptions, count: number) => StreamChunk[]
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
    yield* this.reply?.(options, this.requests.length) ?? [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '已看到真实失败。' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
}

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

async function fixture(options: { root?: string; budget?: number; resume?: boolean } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-bid-recovery-driver-'))
  if (options.root === undefined) disposals.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.sessions'), compression: 'none', packChunks: false })
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecoveryAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const id = SessionId('recovery-driver-main')
  const { agent } = options.resume === true
    ? await ctx.agentLoop.resume(ctx, { resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    : await ctx.agentLoop.createAgent(ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const budget = options.budget ?? 3
  const state = () => agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const read = (session: Session): BidRecoveryNotice | undefined => {
    const decision = bidRunRecoveryEligibility(session, budget)
    if (decision.target === undefined || decision.fingerprint === undefined) return
    const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
    const run = bidRecoverableRun(session, task)
    if (run?.cause === 'user_stop' || run?.cause === 'awaiting_input') return
    return { target: decision.target, fingerprint: decision.fingerprint, eligible: decision.eligible,
      reason: decision.reason, facts: ['已保存真实执行失败，保留原正文。'] }
  }
  const driver = new BidRecoveryDriver(ctx, budget, read, session => ctx.agents.get(session.id)?.session === session)
  const workspace = new BidWorkspace(root)
  const bodyPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  if (options.resume !== true) {
    await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
    await writeFile(bodyPath, '# 正式正文\n\n已核验的章节内容。\n')
    agent.session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'ready', run: null } })
    await checkpointBidProjectState(workspace, state())
  }
  let revision = (await readBidProjectState(workspace))!.revision
  const coordinator = () => new BidRunCoordinator(agent.session, new DirectBidRunScheduler(), { drain: async () => {} },
    () => revision, async () => {
      revision = (await checkpointBidProjectState(workspace, state())).revision
      await ctx.sessions.flush(agent.session)
      return revision
    }, undefined, { workspaceRoot: root, projectRoot: workspace.projectRoot })
  const work: BidWorkDescriptor = { kind: 'stage_execution', workId: 'writing-work', stage: 'chapter_writing',
    requestRef: 'requests/writing-work.json', requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) }
  const fail = async (code = 'EIO', previous?: string) => {
    const runs = coordinator()
    const run = await runs.start(work, previous === undefined ? undefined : { runId: previous, cause: 'executor_error' })
    const error: BidTaskFailure = { code, message: `实际失败 ${code}`, issues: [{ code, artifact: 'chapters/sections/0001.md', message: `实际失败 ${code}` }],
      recovery: { kind: 'retry', unit: 'chapters/sections/0001.md', reason: `实际失败 ${code}` } }
    await runs.suspend('executor_error', error)
    return { run, runs }
  }
  const rounds = () => agent.session.events.filter(event => event.type === 'bid.recovery.round').map(event => event.data)
  const hash = async () => createHash('sha256').update(await readFile(bodyPath)).digest('hex')
  return { root, ctx, agent, adapter, driver, workspace, bodyPath, state, coordinator, work, fail, rounds, hash, read }
}

describe('BidRecoveryDriver 的持久化与运行时协议', () => {
  it('到期恢复通知已落盘但确认临时失败，无新 idle 仍重新确认并派发同轮一次', async () => {
    const f = await fixture({ budget: 2 })
    await f.fail()
    const hash = await f.hash()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let failed = false
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (!failed && f.rounds().at(-1)?.state === 'notified' && f.rounds().at(-1)?.round === 2) {
        failed = true
        throw Object.assign(new Error('恢复通知落盘确认暂时失败'), { code: 'EIO' })
      }
      return persisted
    })
    try {
      await f.driver.request(f.agent)
      await vi.waitFor(() => { expect(failed).toBe(true) }, { timeout: 3000 })
      const raw = await f.ctx.sessionPersistence.readRaw(f.agent.id)
      expect(raw?.content).toContain('"state":"notified"')
      await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(2) }, { timeout: 3000 })
      await f.agent.whenIdle()
      const notifications = f.rounds().filter(round => round.state === 'notified')
      expect([...new Set(notifications.map(round => round.round))]).toEqual([1, 2])
      expect(new Set(notifications.filter(round => round.round === 2).map(round => round.messageId)).size).toBe(1)
      expect(f.rounds().at(-1)).toMatchObject({ round: 2, budget: 2, dispatchAttempts: 1 })
      await f.ctx.sessions.flush(f.agent.session)
      expect((await f.ctx.sessionPersistence.readRaw(f.agent.id))?.content).toContain('"dispatchAttempts":1')
      expect(await f.hash()).toBe(hash)
    } finally { checkpoint.mockRestore() }
  })

  it('终止报告的 JSONL 确认失败后重试派发报告，同轮同预算且重复事件不重复报告', async () => {
    const f = await fixture({ budget: 1 })
    await f.fail()
    const hash = await f.hash()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async session => flush(session))
      .mockImplementationOnce(async (session) => {
        await flush(session)
        throw Object.assign(new Error('终止报告落盘确认暂时失败'), { code: 'EIO' })
      })
    try {
      await expect(f.driver.request(f.agent)).rejects.toThrow('终止报告落盘确认暂时失败')
      expect(f.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 1, budget: 1 })
      const raw = await f.ctx.sessionPersistence.readRaw(f.agent.id)
      expect(raw?.content).toContain('"state":"blocked"')
      await f.driver.request(f.agent)
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(2)
      expect(f.adapter.requests.at(-1)?.messages.flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.includes('恢复已终止。报告原始失败'))).toBe(true)
      await Promise.all(Array.from({ length: 10 }, () => f.driver.request(f.agent)))
      expect(f.adapter.requests).toHaveLength(2)
      expect(f.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 1, budget: 1 })
      expect(await f.hash()).toBe(hash)
    } finally { checkpoint.mockRestore() }
  })

  it('连续 JSONL 确认失败有界停止，恢复存储并重启也不会增加同轮派发预算', async () => {
    const f = await fixture({ budget: 1 })
    await f.fail()
    const hash = await f.hash()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (['notified', 'blocked'].includes(f.rounds().at(-1)?.state ?? '')) {
        throw Object.assign(new Error('持久化确认仍不可用'), { code: 'EIO' })
      }
      return persisted
    })
    try {
      await expect(f.driver.request(f.agent)).rejects.toThrow('持久化确认仍不可用')
      await vi.waitFor(() => { expect(f.rounds().at(-1)?.dispatchAttempts).toBe(2) }, { timeout: 3000 })
      expect(f.adapter.requests).toHaveLength(0)
    } finally { checkpoint.mockRestore() }
    await f.ctx.sessions.flush(f.agent.session)
    expect((await f.ctx.sessionPersistence.readRaw(f.agent.id))?.content).toContain('"dispatchAttempts":2')
    await f.ctx.fiber.dispose()
    const restored = await fixture({ root: f.root, resume: true, budget: 5 })
    await restored.driver.request(restored.agent)
    await restored.agent.whenIdle()
    expect(restored.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 1, budget: 1, dispatchAttempts: 2 })
    expect(restored.rounds().at(-1)?.reason).toContain('BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED')
    expect(restored.adapter.requests).toHaveLength(1)
    expect(restored.adapter.requests[0]?.messages.flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text.includes('BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED'))).toBe(true)
    await Promise.all(Array.from({ length: 10 }, () => restored.driver.request(restored.agent)))
    expect(restored.adapter.requests).toHaveLength(1)
    expect(await restored.hash()).toBe(hash)
  })

  it('通知确认重试耗尽后终止 checkpoint 可确认，Main 只收到一次真实 blocker 报告', async () => {
    const f = await fixture({ budget: 1 })
    await f.fail()
    const hash = await f.hash()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (f.rounds().at(-1)?.state === 'notified') throw Object.assign(new Error('恢复通知确认持续失败'), { code: 'EIO' })
      return persisted
    })
    try {
      await expect(f.driver.request(f.agent)).rejects.toThrow('恢复通知确认持续失败')
      await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(1) }, { timeout: 3000 })
      await f.agent.whenIdle()
      expect(f.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 1, budget: 1, dispatchAttempts: 2 })
      expect(f.rounds().at(-1)?.messageId).toEqual(expect.any(String))
      expect(f.rounds().at(-1)?.reason).toContain('BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED')
      const raw = await f.ctx.sessionPersistence.readRaw(f.agent.id)
      expect(raw?.content).toContain('BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED')
      expect(f.adapter.requests[0]?.messages.flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.includes('恢复已终止。报告原始失败'))).toBe(true)
      await Promise.all(Array.from({ length: 10 }, () => f.driver.request(f.agent)))
      expect(f.adapter.requests).toHaveLength(1)
      expect(await f.hash()).toBe(hash)
    } finally { checkpoint.mockRestore() }
  })

  it('真实 pre-step 拒绝已消费恢复通知，记 no_effect 并有界结算，不无限重派相同消息', async () => {
    const f = await fixture({ budget: 2 })
    await f.fail()
    const hash = await f.hash()
    let rejected = 0
    f.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'plugin'
        && message.source.form === 'notice'
        && message.source.summary === 'Bid 执行失败，交由主 Agent 处理')) {
        rejected++
        return { kind: 'reject' as const }
      }
      return next()
    }, { global: true })
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(rejected).toBe(1)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.session.events.filter(event => event.type === 'user/message')).toHaveLength(0)
    expect(f.agent.session.events.findLast(event => event.type === 'agent/inbox/spliced')).toMatchObject({ data: { removedCount: 1 } })
    expect(f.agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'blocked' } } })
    await f.driver.request(f.agent)
    expect(f.rounds().at(-1)).toMatchObject({ state: 'scheduled', round: 2, budget: 2 })
    await vi.waitFor(() => { expect(rejected).toBe(2) }, { timeout: 3000 })
    await f.agent.whenIdle()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(f.rounds().filter(round => round.state === 'no_effect')).toHaveLength(2)
    expect(f.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 2, budget: 2 })
    expect(f.adapter.requests).toHaveLength(1)
    await Promise.all(Array.from({ length: 10 }, () => f.driver.request(f.agent)))
    expect(rejected).toBe(2)
    expect(f.adapter.requests).toHaveLength(1)
    expect(await f.hash()).toBe(hash)
  })

  it('卸载等待已拥有的 flush 退出，确认迟到也不追加新轮或启动 Main', async () => {
    const f = await fixture()
    await f.fail()
    const gate = Promise.withResolvers<undefined>()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let held = false
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (f.rounds().at(-1)?.state === 'notified') { held = true; await gate.promise }
      return persisted
    })
    const request = f.driver.request(f.agent)
    let disposalCompleted = false
    let disposing: Promise<void> | undefined
    try {
      await vi.waitFor(() => { expect(held).toBe(true) })
      disposing = f.ctx.fiber.dispose().then(() => { disposalCompleted = true })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(disposalCompleted).toBe(false)
    } finally {
      gate.resolve(undefined)
      await Promise.all([request, disposing])
      checkpoint.mockRestore()
    }
    const rounds = f.rounds().length
    await f.driver.request(f.agent)
    expect(f.rounds()).toHaveLength(rounds)
    expect(f.adapter.requests).toHaveLength(0)
    expect(disposalCompleted).toBe(true)
  })

  it('通知确认失败后的退避计时到期前用户 Stop，重试确认也不能开启模型', async () => {
    const f = await fixture({ budget: 2 })
    const failed = await f.fail()
    const hash = await f.hash()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    let rejected = false
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (!rejected && f.rounds().at(-1)?.state === 'notified') {
        rejected = true
        throw Object.assign(new Error('通知确认暂时失败'), { code: 'EIO' })
      }
      return persisted
    })
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      await expect(f.driver.request(f.agent)).rejects.toThrow('通知确认暂时失败')
      const runs = f.coordinator()
      await runs.start(f.work, { runId: failed.run.runId, cause: 'executor_error' })
      await runs.suspend('user_stop')
      f.agent.cancel({ kind: 'user' })
      await vi.advanceTimersByTimeAsync(2500)
      await f.driver.request(f.agent)
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.rounds().at(-1)).toMatchObject({ state: 'cancelled', round: 1, budget: 2 })
      expect(await f.hash()).toBe(hash)
    } finally { checkpoint.mockRestore(); vi.useRealTimers() }
  })

  it('等待中的原 Work 更换 Run 和故障 fingerprint，保留预算并继续派发当前失败', async () => {
    const f = await fixture({ budget: 2 })
    const first = await f.fail()
    const hash = await f.hash()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    await f.driver.request(f.agent)
    expect(f.rounds().at(-1)).toMatchObject({ round: 2, state: 'scheduled' })
    const second = await f.fail('ETIMEDOUT', first.run.runId)
    expect(f.read(f.agent.session)?.fingerprint).not.toBe(f.rounds()[0]?.fingerprint)
    await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(2) }, { timeout: 3000 })
    await f.agent.whenIdle()
    const notified = f.rounds().filter(round => round.state === 'notified')
    expect(notified.map(round => round.round)).toEqual([1, 2])
    expect(notified[1]).toMatchObject({ target: { runId: second.run.runId, workId: first.run.work.workId }, budget: 2 })
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(f.rounds().at(-1)).toMatchObject({ state: 'blocked', round: 2, budget: 2 })
    expect(await f.hash()).toBe(hash)
  })

  it('重复失败请求和真实 idle 通知共享一次派发，持久化确认前不会进入真实模型', async () => {
    const f = await fixture()
    await f.fail()
    const gate = Promise.withResolvers<undefined>()
    const modelGate = Promise.withResolvers<undefined>()
    f.adapter.gate = modelGate.promise
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      const latest = f.rounds().at(-1)
      if (latest?.state === 'notified') await gate.promise
      return persisted
    })
    const idleRequests: Promise<void>[] = []
    for (let index = 0; index < 20; index++) {
      f.ctx.on('agent/status', ({ agent, status }) => {
        if (agent === f.agent && status === 'idle') idleRequests.push(f.driver.request(agent))
      }, { global: true })
    }
    try {
      const requests = Array.from({ length: 20 }, () => f.driver.request(f.agent))
      await vi.waitFor(() => { expect(f.rounds().at(-1)?.state).toBe('notified') })
      expect(f.adapter.requests).toHaveLength(0)
      for (const request of requests) expect(request).toBe(requests[0])
      gate.resolve(undefined)
      await Promise.all(requests)
      await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(1) })
      await Promise.all(Array.from({ length: 20 }, () => f.driver.request(f.agent)))
      expect(f.rounds().filter(round => round.state === 'notified')).toHaveLength(1)
    } finally {
      gate.resolve(undefined)
      modelGate.resolve(undefined)
      checkpoint.mockRestore()
    }
    await f.agent.whenIdle()
    await Promise.all(idleRequests)
    expect(idleRequests).toHaveLength(20)
    for (const request of idleRequests) expect(request).toBe(idleRequests[0])
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.rounds().filter(round => round.state === 'notified')).toHaveLength(1)
  })

  it('通知落盘后 steer 前崩溃，真实 JSONL 恢复后重派同一轮而不消费新预算', async () => {
    const f = await fixture({ budget: 2 })
    await f.fail()
    const hash = await f.hash()
    vi.spyOn(f.agent, 'steer').mockImplementationOnce(() => { throw new Error('注入通知落盘后进程退出') })
    await expect(f.driver.request(f.agent)).rejects.toThrow('注入通知落盘后进程退出')
    expect(f.rounds().at(-1)).toMatchObject({ state: 'notified', round: 1, budget: 2 })
    expect(f.adapter.requests).toHaveLength(0)
    await f.ctx.fiber.dispose()
    const restored = await fixture({ root: f.root, budget: 2, resume: true })
    expect(restored.rounds().at(-1)).toMatchObject({ state: 'notified', round: 1 })
    await restored.driver.request(restored.agent)
    await restored.agent.whenIdle()
    expect(restored.adapter.requests).toHaveLength(1)
    expect(restored.rounds().filter(round => round.state === 'notified').map(round => round.round)).toEqual([1])
    expect(restored.rounds().at(-1)?.messageId).toBe(f.rounds().at(-1)?.messageId)
    expect(restored.rounds().at(-1)?.budget).toBe(2)
    expect(await restored.hash()).toBe(hash)
  })

  it('通知已被消费但尚无 turn/end 的落盘快照，重启后继续原预算并最终结算', async () => {
    const f = await fixture({ budget: 2 })
    await f.fail()
    const hash = await f.hash()
    const gate = Promise.withResolvers<undefined>()
    f.adapter.gate = gate.promise
    const crashRoot = await mkdtemp(join(tmpdir(), 'dsh-bid-recovery-crash-'))
    disposals.push(() => rm(crashRoot, { recursive: true, force: true }))
    try {
      await f.driver.request(f.agent)
      await vi.waitFor(() => { expect(f.adapter.requests).toHaveLength(1) })
      await f.ctx.sessions.flush(f.agent.session)
      const raw = await f.ctx.sessionPersistence.readRaw(f.agent.id)
      expect(raw?.content).toContain('"type":"user/message"')
      expect(raw?.content).not.toContain('"type":"turn/end"')
      expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
      // 保存进程中断时已写入的完整字节，隔离正常 dispose 随后产生的闭合事件。
      await cp(f.root, crashRoot, { recursive: true })
    } finally {
      gate.resolve(undefined)
    }
    await f.agent.whenIdle()
    await f.ctx.fiber.dispose()
    const restored = await fixture({ root: crashRoot, budget: 5, resume: true })
    const receipt = restored.agent.session.events.find(event => event.type === 'user/message')
    if (receipt === undefined) throw new Error('恢复快照丢失已消费的通知')
    expect(restored.agent.session.events.some(event => event.type === 'turn/end' && event.seq > receipt.seq)).toBe(true)
    expect(restored.rounds().at(-1)).toMatchObject({ round: 1, budget: 2, state: 'notified' })
    await restored.driver.request(restored.agent)
    expect(restored.rounds().at(-1)).toMatchObject({ round: 2, budget: 2, state: 'scheduled' })
    await vi.waitFor(() => { expect(restored.adapter.requests).toHaveLength(1) }, { timeout: 3000 })
    await restored.agent.whenIdle()
    expect(restored.rounds().filter(round => round.state === 'notified').map(round => round.round)).toEqual([1, 2])
    await restored.driver.request(restored.agent)
    await restored.agent.whenIdle()
    expect(restored.rounds().at(-1)).toMatchObject({ round: 2, budget: 2, state: 'blocked' })
    const calls = restored.adapter.requests.length
    await Promise.all(Array.from({ length: 10 }, () => restored.driver.request(restored.agent)))
    expect(restored.adapter.requests).toHaveLength(calls)
    expect(await restored.hash()).toBe(hash)
  })

  it('恢复工具已启动真实 Run 但接受响应失败，重复请求不会重新执行原恢复', async () => {
    const f = await fixture()
    const failed = await f.fail()
    const hash = await f.hash()
    const runs = f.coordinator()
    let resumed: Awaited<ReturnType<BidRunCoordinator['start']>> | undefined
    let executions = 0
    f.ctx.tools.register({ name: 'recover_now', description: '恢复当前真实 Run', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => {
        executions++
        const notice = f.read(f.agent.session)!
        f.agent.session.append('bid.recovery.requested', { ownerSessionId: String(f.agent.id), target: notice.target,
          unit: 'chapters/sections/0001.md', instruction: '仅重试原测量。', progressFingerprint: notice.fingerprint })
        resumed = await runs.start(f.work, { runId: failed.run.runId, cause: 'executor_error' })
        throw new Error('注入接受响应发送失败')
      } })
    f.adapter.reply = (_options, count) => count === 1 ? [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('recover_now'), name: 'recover_now', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] : [{ type: 'finish', reason: { kind: 'stop' } }]
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(executions).toBe(1)
    await Promise.all(Array.from({ length: 10 }, () => f.driver.request(f.agent)))
    expect(executions).toBe(1)
    expect(f.state().status).toBe('running')
    expect(f.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
    if (resumed === undefined) throw new Error('恢复工具没有启动 Run')
    await runs.complete(resumed, () => f.agent.session.append('bid.stage.completed', { stage: 'chapter_writing', status: 'completed', artifacts: [] }))
    await f.driver.request(f.agent)
    expect(f.rounds().at(-1)?.state).toBe('recovered')
    expect(await f.hash()).toBe(hash)
  })

  it('真实 Main 连续调整策略后仍失败，新 Run 与新 fingerprint 不重置原 Work 的执行预算', async () => {
    const f = await fixture({ budget: 2 })
    await f.fail()
    const hash = await f.hash()
    let executions = 0
    const failures: string[] = []
    f.ctx.tools.register({ name: 'recover_now', description: '在原 Work 中调整当前故障的修复策略', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => {
        const notice = f.read(f.agent.session)
        if (notice?.target.kind !== 'run') throw new Error('缺少当前 Run 的权威恢复目标')
        executions++
        failures.push(notice.fingerprint)
        f.agent.session.append('bid.recovery.requested', { ownerSessionId: String(f.agent.id), target: notice.target,
          unit: 'chapters/sections/0001.md', instruction: `第 ${executions} 次修复采用调整后的测量方法。`, progressFingerprint: notice.fingerprint })
        await f.fail(executions === 1 ? 'ETIMEDOUT' : 'ECONNRESET', notice.target.runId)
        return { status: 'failed', attempt: executions }
      } })
    f.adapter.reply = (_options, count) => count === 1 || count === 3 ? [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`recover_${count}`), name: 'recover_now', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] : [{ type: 'finish', reason: { kind: 'stop' } }]
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(executions).toBe(1)
    await f.driver.request(f.agent)
    await vi.waitFor(() => { expect(executions).toBe(2) }, { timeout: 3000 })
    await f.agent.whenIdle()
    expect(new Set(failures).size).toBe(2)
    expect(f.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(3)
    const decision = bidRunRecoveryEligibility(f.agent.session, 99)
    expect(decision).toMatchObject({ eligible: false, attempts: 2, sameProblemCount: 0 })
    expect(decision.reason).toContain('BID_RECOVERY_BUDGET_EXHAUSTED')
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    expect(f.rounds().at(-1)).toMatchObject({ round: 2, budget: 2, state: 'blocked' })
    const calls = f.adapter.requests.length
    await Promise.all(Array.from({ length: 20 }, () => f.driver.request(f.agent)))
    expect(executions).toBe(2)
    expect(f.adapter.requests).toHaveLength(calls)
    expect(await f.hash()).toBe(hash)
  })

  it('用户停止与到期 timer 竞争，原正文及退休写入权限均受保护', async () => {
    const f = await fixture()
    const failed = await f.fail()
    const hash = await f.hash()
    await expect(failed.run.commits.writeText(f.bodyPath, '不得覆盖正式正文')).rejects.toThrow('BID_RUN_RETIRED')
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await f.driver.request(f.agent)
    expect(f.rounds().at(-1)).toMatchObject({ round: 2, state: 'scheduled' })
    const runs = f.coordinator()
    const resumed = await runs.start(f.work, { runId: failed.run.runId, cause: 'executor_error' })
    await runs.suspend('user_stop')
    await vi.advanceTimersByTimeAsync(2500)
    await f.driver.request(f.agent)
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.state()).toMatchObject({ status: 'suspended', run: { runId: resumed.runId, cause: 'user_stop' } })
    expect(f.rounds().at(-1)?.state).toBe('cancelled')
    expect(await f.hash()).toBe(hash)
  })

  it('到期通知已落盘但 flush 尚未确认时用户停止，迟到确认不能重新唤醒 Main', async () => {
    const f = await fixture()
    const failed = await f.fail()
    const hash = await f.hash()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    const gate = Promise.withResolvers<undefined>()
    let held = false
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      const latest = f.rounds().at(-1)
      if (!held && latest?.state === 'notified' && latest.round === 2) {
        held = true
        await gate.promise
      }
      return persisted
    })
    try {
      await f.driver.request(f.agent)
      await vi.waitFor(() => { expect(held).toBe(true) }, { timeout: 3000 })
      const runs = f.coordinator()
      await runs.start(f.work, { runId: failed.run.runId, cause: 'executor_error' })
      await runs.suspend('user_stop')
      f.agent.cancel({ kind: 'user' })
      expect(f.read(f.agent.session)).toBeUndefined()
      gate.resolve(undefined)
      await f.driver.request(f.agent)
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(1)
      await f.driver.request(f.agent)
      expect(f.rounds().at(-1)?.state).toBe('cancelled')
      expect(await f.hash()).toBe(hash)
    } finally {
      gate.resolve(undefined)
      checkpoint.mockRestore()
    }
  })

  it('预算终止报告等待落盘确认时用户停止，确认后也不自动开启新模型轮', async () => {
    const f = await fixture({ budget: 1 })
    const failed = await f.fail()
    const hash = await f.hash()
    await f.driver.request(f.agent)
    await f.agent.whenIdle()
    const gate = Promise.withResolvers<undefined>()
    let held = false
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const checkpoint = vi.spyOn(f.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const persisted = await flush(session)
      if (!held && f.rounds().at(-1)?.state === 'blocked') {
        held = true
        await gate.promise
      }
      return persisted
    })
    try {
      const blocked = f.driver.request(f.agent)
      await vi.waitFor(() => { expect(held).toBe(true) })
      const runs = f.coordinator()
      await runs.start(f.work, { runId: failed.run.runId, cause: 'executor_error' })
      await runs.suspend('user_stop')
      f.agent.cancel({ kind: 'user' })
      gate.resolve(undefined)
      await blocked
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(1)
      expect(await f.hash()).toBe(hash)
    } finally {
      gate.resolve(undefined)
      checkpoint.mockRestore()
    }
  })
})
