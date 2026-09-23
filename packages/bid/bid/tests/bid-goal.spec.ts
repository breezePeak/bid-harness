import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { BidHostRuntime, BidRunCoordinator, BidWorkspace, checkpointBidProjectState } from '../src/index.ts'
import type { BidWorkDescriptor } from '../src/control-plane-contract.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { persistBidWorkRequest } from '../src/work-descriptor.ts'
import { buildBidStageTask } from '../src/runtime-state.ts'
import { safeRecoverableBidFailure } from '../src/bid-recovery.ts'

interface Operation { runs: BidRunCoordinator }
interface HostInternals {
  inFlight: Map<string, unknown>
  beginOperation(session: Session): Operation
  prepareOperation(operation: Operation): Promise<unknown>
  finishOperation(session: Session, operation: Operation): Promise<void>
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).reverse().map(dispose => dispose())) })

async function setup(stage: 'file_intake' | 'tender_analysis', withGoal = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-goal-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  if (withGoal) {
    await ctx.plugin(GoalService)
    await ctx.plugin(GoalRoundDriver)
  }
  const workspace = new BidWorkspace(root)
  await checkpointBidProjectState(workspace, { stage, status: 'waiting_user', run: null })
  await ctx.plugin(BidHostRuntime)
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(`bid-goal-${stage}`),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: root, agentPreset: 'bid' },
  })
  const host = ctx.bid as unknown as HostInternals
  await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
  return { ctx, host, agent: handle.agent, workspace }
}

function work(stage: 'file_intake' | 'tender_analysis'): BidWorkDescriptor {
  return {
    kind: stage === 'file_intake' ? 'file_intake' : 'stage_execution',
    stage, workId: `work-${stage}`, requestRef: 'requests/test.json',
    requestSha256: '0'.repeat(64), inputFingerprint: '0'.repeat(64),
  }
}

it('binds one native Goal only after the S2 Run is admitted', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  expect(ctx.goals.get(agent)).toBeUndefined()
  const run = await operation.runs.start(work('tender_analysis'))
  await ctx.sessions.flush(agent.session)
  const bound = agent.session.events.filter(event => event.type === 'bid.goal.bound')
  expect(bound).toHaveLength(1)
  expect(bound[0]?.data).toMatchObject({
    goalId: ctx.goals.get(agent)?.id,
    ownerSessionId: String(agent.id),
    initialS2WorkId: run.work.workId,
  })
  expect(ctx.goals.get(agent)?.roundsStarted).toBe(0)
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
})

it('leaves S1 without a Goal or binding event', async () => {
  const { ctx, host, agent } = await setup('file_intake')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('file_intake'))
  expect(ctx.goals.get(agent)).toBeUndefined()
  expect(agent.session.events.filter(event => event.type === 'bid.goal.bound')).toHaveLength(0)
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
})

it('keeps S2 Host execution available when native Goal services are absent', async () => {
  const { host, agent } = await setup('tender_analysis', false)
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('tender_analysis'))
  expect(agent.session.events.filter(event => event.type === 'bid.goal.bound')).toHaveLength(0)
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
})

it('does not replace an unrelated native Goal when S2 starts', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const disposeGate = ctx.goalRoundDriver.registerGate(() => 'wait')
  try {
    const unrelated = ctx.goals.create(agent, { objective: '另一项用户目标' })
    const operation = host.beginOperation(agent.session)
    await host.prepareOperation(operation)
    await operation.runs.start(work('tender_analysis'))
    expect(ctx.goals.get(agent)?.id).toBe(unrelated.id)
    expect(agent.session.events.filter(event => event.type === 'bid.goal.bound')).toHaveLength(0)
    await operation.runs.suspend('user_stop')
    await host.finishOperation(agent.session, operation)
  } finally { disposeGate() }
})

it('does not create a Goal when the S2 running checkpoint fails', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('checkpoint unavailable'))
  try {
    await expect(operation.runs.start(work('tender_analysis'))).rejects.toThrow('checkpoint unavailable')
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'bid.goal.bound')).toHaveLength(0)
  } finally {
    flush.mockRestore()
    await host.finishOperation(agent.session, operation)
  }
})

it('disarms automatic recovery if the new S2 binding cannot be flushed', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const disposeGate = ctx.goalRoundDriver.registerGate(() => 'wait')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(session => session.events.some(event => event.type === 'bid.goal.bound')
    ? Promise.reject(new Error('binding unavailable')) : originalFlush(session))
  try {
    await operation.runs.start(work('tender_analysis'))
    await vi.waitFor(() => { expect(ctx.goals.get(agent)?.activation).toBe('disarmed') })
    expect(ctx.goals.get(agent)?.roundsStarted).toBe(0)
  } finally {
    flush.mockRestore()
    await operation.runs.suspend('user_stop')
    await host.finishOperation(agent.session, operation)
    disposeGate()
  }
})

it('removes recovery authority on native Goal pause and clear', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const disposeGate = ctx.goalRoundDriver.registerGate(() => 'wait')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const descriptor = work('tender_analysis')
  await operation.runs.start(descriptor)
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(descriptor, new Error('missing submission'), [{
    code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
  }]))
  await host.finishOperation(agent.session, operation)
  try {
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('bid_recover_task')
    const goal = ctx.goals.get(agent)!
    const paused = ctx.goals.pause(agent, goal)
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('bid_recover_task')
    const resumed = ctx.goals.resume(agent, paused)
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('bid_recover_task')
    ctx.goals.clear(agent, resumed)
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('bid_recover_task')
    expect(agent.session.events.filter(event => event.type === 'bid.goal.bound')).toHaveLength(1)
  } finally { disposeGate() }
})

it('accepts the exact failed Run once, returns after its durable checkpoint, and retains the recovery event', async () => {
  const { ctx, host, agent, workspace } = await setup('tender_analysis')
  const disposeGate = ctx.goalRoundDriver.registerGate(() => 'wait')
  const payload = { stage: 'tender_analysis' }
  const inputs = buildBidStageTask('tender_analysis').inputs.map(path => ({ path, sha256: null }))
  const descriptor = await persistBidWorkRequest(workspace, 'stage_execution', 'tender_analysis', payload,
    { stage: 'tender_analysis', inputs, payload })
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const failed = await operation.runs.start(descriptor)
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(descriptor, new Error('missing submission'), [{
    code: 'BID_TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
  }]))
  await host.finishOperation(agent.session, operation)
  const gate = Promise.withResolvers<undefined>()
  const original = host as unknown as { automaticOrchestrator: (...args: unknown[]) => unknown }
  original.automaticOrchestrator = (_execution, _workspace, _signal, resumedOperation) => ({
    resume: async (runId: string, onAccepted: ((run: Awaited<ReturnType<BidRunCoordinator['start']>>) => void) | undefined) => {
      const current = resumedOperation as Operation
      const run = await current.runs.start(descriptor, { runId, cause: 'retry_exhausted' })
      onAccepted?.(run)
      await gate.promise
      return current.runs.suspend('user_stop')
    },
  })
  try {
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('bid_recover_task')
    const call = (id: string) => agent.ctx.tools.execute({ agent, name: 'bid_recover_task',
      arguments: { target: 'run', run_id: failed.runId, instruction: '补齐项目字段并按原提交工具提交。' },
      callId: CallId(id), signal: new AbortController().signal })
    const [first, second] = await Promise.all([call('recover-1'), call('recover-2')])
    if (first.isError) throw new Error(JSON.stringify(first))
    expect(first).toMatchObject({ isError: false, value: { accepted: true } })
    if (second.isError) throw new Error(JSON.stringify(second))
    expect(second).toMatchObject({ isError: false, value: first.value })
    expect(agent.session.events.filter(event => event.type === 'bid.goal.recovery.requested')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
    const value = first.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.run_id !== 'string') {
      throw new Error(`unexpected recovery result: ${JSON.stringify(value)}`)
    }
    expect(agent.session.events.some(event => event.type === 'bid.project.resumed'
      && 'state' in event.data && event.data.state.status === 'running'
      && event.data.state.run.runId === value.run_id)).toBe(true)
  } finally {
    gate.resolve(undefined)
    disposeGate()
  }
})
