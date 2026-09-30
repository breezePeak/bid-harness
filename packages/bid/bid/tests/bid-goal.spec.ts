import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { BidHostRuntime, BidRunCoordinator, BidWorkspace, checkpointBidProjectState, readBidProjectState, buildBidStageTask,
} from '../src/index.ts'
import { type BidWorkDescriptor } from '../src/control-plane-contract.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { safeRecoverableBidFailure } from '../src/bid-recovery.ts'
import { inspectBidStage } from '../src/stage-interaction.ts'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import { resolveBidToolAuthorization } from '../src/bid-tool-authorization.ts'
import { seedCapabilityProject } from './capability-fixture.ts'
import { capabilityTaskRequestSchema, executeCapabilityTask, findCapabilityTaskRequest, patchCapabilityTaskSteps, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { persistBidWorkRequest, readBidWorkRequest } from '../src/work-descriptor.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from '../src/runtime-state.ts'

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
  const clearAdapter = ctx.llm.registerAdapter(['mock'], new TestAdapter(async () => [{ type: 'finish', reason: { kind: 'stop' } }]))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  if (withGoal) {
    await ctx.plugin(GoalService, { defaultMaxGoalRounds: 1 })
    await ctx.plugin(ToolGoal)
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
  return { ctx, host, agent: handle.agent, workspace, clearAdapter }
}

function work(stage: 'file_intake' | 'tender_analysis'): BidWorkDescriptor {
  return {
    kind: stage === 'file_intake' ? 'file_intake' : 'stage_execution',
    stage, workId: `work-${stage}`, requestRef: 'requests/test.json',
    requestSha256: '0'.repeat(64), inputFingerprint: '0'.repeat(64),
  }
}

it.each(['file_intake', 'tender_analysis'] as const)('%s 默认运行不创建 Goal，失败交给主 Agent', async (stage) => {
  const { ctx, host, agent } = await setup(stage, false)
  const steer = vi.spyOn(agent, 'steer')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const run = await operation.runs.start(work(stage))
  expect(ctx.get('goals')?.get(agent)).toBeUndefined()
  expect(agent.session.events.some(event => event.type === 'bid.goal.bound')).toBe(false)
  await operation.runs.suspend('retry_exhausted', safeRecoverableBidFailure(run.work, new Error('repair exhausted')))
  await host.finishOperation(agent.session, operation)
  await agent.whenIdle()
  expect(agent.session.events.some(event => event.type === 'bid.run.decision.required')).toBe(false)
  expect(agent.session.events.some(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text.startsWith('当前阶段执行失败，失败状态已保存。')))).toBe(stage === 'tender_analysis')
  expect(steer).toHaveBeenCalledTimes(stage === 'tender_analysis' ? 1 : 0)
  expect(agent.session.events.some(event => event.type === 'bid.goal.recovery.requested')).toBe(false)
  expect(agent.ctx.tools.schemas(agent).some(tool => tool.name === 'bid_recover_task')).toBe(stage === 'tender_analysis')
})

it('没有 Goal 服务时 S2 正常运行', async () => {
  const { host, agent } = await setup('tender_analysis', false)
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('tender_analysis'))
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
})

it.each(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'] as const)(
  '%s Host 重启仅凭 Bid 状态恢复，不要求 Goal', async (stage) => {
    const { ctx, host, agent, workspace } = await setup('tender_analysis')
    const descriptor = { ...work('tender_analysis'), stage }
    const interrupted = { runId: `interrupted-${stage}`, epoch: 1, baseProjectRevision: 1,
      work: descriptor, startedAt: 1, updatedAt: 1 }
    await checkpointBidProjectState(workspace, { stage, status: 'running', run: interrupted })
    const resume = vi.spyOn(ctx.bid, 'resumeCurrentRun').mockResolvedValue(BID_INITIAL_TASK_STATE)
    const driver = host as unknown as { driveStartedSession(agent: Agent, cwd: string): Promise<void> }
    await driver.driveStartedSession(agent, workspace.root)
    const saved = await readBidProjectState(workspace)
    await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })
    expect(resume).toHaveBeenCalledWith(agent.session, interrupted.runId, saved?.revision)
    expect(ctx.get('goals')?.get(agent)).toBeUndefined()
  },
)

it('Goal pause/clear 不停止 Bid，Bid stop 不改变 Goal', async () => {
  const { ctx, host, agent } = await setup('tender_analysis')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('tender_analysis'))
  const goal = ctx.goals.create(agent, { objective: '仅检查资料' })
  const paused = ctx.goals.pause(agent, goal)
  expect(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).status).toBe('running')
  ctx.goals.clear(agent, paused)
  expect(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).status).toBe('running')
  const next = ctx.goals.create(agent, { objective: '另一目标' })
  const gate = ctx.goalRoundDriver.registerGate(() => 'wait')
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
  expect(ctx.goals.get(agent)).toEqual(next)
  gate()
})

it('S5 完成不完成显式 Goal，旧绑定事件不参与调度', async () => {
  const { ctx, host, agent, workspace } = await setup('tender_analysis')
  const gate = ctx.goalRoundDriver.registerGate(() => 'wait')
  const goal = ctx.goals.create(agent, { objective: '核对整体资料' })
  agent.session.append('bid.goal.bound', { goalId: goal.id, ownerSessionId: String(agent.id), initialS2WorkId: 'legacy' })
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'ready', run: null })
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  const run = await operation.runs.start({ ...work('tender_analysis'), stage: 'chapter_writing' })
  await operation.runs.complete(run, () => agent.session.append('bid.stage.completed', {
    stage: 'chapter_writing', status: 'completed', artifacts: [],
  }))
  await host.finishOperation(agent.session, operation)
  expect(ctx.goals.get(agent)).toEqual(goal)
  gate()
})

class TestAdapter extends LlmAdapter {
  constructor(private readonly respond: (options: GenerateOptions) => Promise<StreamChunk[]>) { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions) { yield* await this.respond(options) }
}

it('Busy Gate 在后台操作期间不消耗 Goal 轮次，结束后允许正常阶段工具与提前完成', async () => {
  const { ctx, host, agent, clearAdapter } = await setup('tender_analysis')
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('tender_analysis'))
  const seen: string[][] = []
  const authorizations: unknown[] = []
  clearAdapter()
  ctx.llm.registerAdapter(['mock'], new TestAdapter(async () => {
    seen.push(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    authorizations.push(resolveBidToolAuthorization(agent))
    const goal = ctx.goals.get(agent)!
    if (seen.length === 1) return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('goal-complete'), name: 'update_goal',
        arguments: JSON.stringify({ action: 'complete', goal_id: goal.id, revision: goal.revision }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    return [{ type: 'finish', reason: { kind: 'stop' } }]
  }))
  ctx.goals.create(agent, { objective: '确认当前失败状态' })
  await ctx.sessions.flush(agent.session)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(ctx.goals.get(agent)?.roundsStarted).toBe(0)
  expect(seen).toHaveLength(0)
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
  await vi.waitFor(() =>{  expect(ctx.goals.get(agent)?.phase).toBe('complete') })
  await agent.whenIdle()
  expect(seen[0]).toEqual(expect.arrayContaining(['bid_stage_inspect', 'bid_project_inspect', 'get_goal', 'update_goal']))
  expect(seen[0]).not.toContain('bid_run_task')
  expect(seen[0]).not.toContain('create_goal')
  expect(authorizations[0]).toMatchObject({ session_id: String(agent.session.id), message_id: expect.any(String) as string })
  expect(resolveBidToolAuthorization(agent)).toBeUndefined()
})

it('waiting_user 的显式 Goal 可读取和更新，普通消息不可创建 Goal', async () => {
  const { ctx, agent } = await setup('tender_analysis')
  const gate = ctx.goalRoundDriver.registerGate(() => 'wait')
  ctx.goals.create(agent, { objective: '检查目录' })
  const tools = agent.ctx.tools.schemas(agent).map(tool => tool.name)
  expect(tools).toEqual(expect.arrayContaining(['get_goal', 'update_goal']))
  expect(tools).not.toContain('create_goal')
  expect(agent.session.events.some(event => event.type === 'bid.goal.bound')).toBe(false)
  gate()
})

it('原生 Goal Round 通过 bid_run_task 发布能力结果，授权只保存会话和消息身份', async () => {
  const { ctx, agent, workspace, clearAdapter } = await setup('tender_analysis')
  await seedCapabilityProject(workspace, 'partial')
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
  agent.session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'completed', run: null } })
  let request = 0
  let authorization: ReturnType<typeof resolveBidToolAuthorization>
  clearAdapter()
  ctx.llm.registerAdapter(['mock'], new TestAdapter(async () => {
    request++
    const goal = ctx.goals.get(agent)!
    if (request > 2) return [{ type: 'finish', reason: { kind: 'stop' } }]
    const name = request === 1 ? 'bid_run_task' : 'update_goal'
    const args = request === 1 ? { task: { goal: '更正招标理解', scope: { kind: 'project' }, steps: [{ description: '执行已授权的测试步骤',
      scope: { source: 'task' }, call: { capability: 'tender.update', input: { operations: [{
        type: 'update_requirement', requirement_id: 'REQ-1', fields: { normalized_requirement: '明确实施边界' },
      }] } },
    }] } } : { action: 'complete', goal_id: goal.id, revision: goal.revision }
    authorization ??= resolveBidToolAuthorization(agent)
    return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(`goal-task-${request}`), name, arguments: JSON.stringify(args) } },
      { type: 'finish', reason: { kind: 'tool-calls' } }]
  }))
  ctx.goals.create(agent, { objective: '更正招标理解' })
  await vi.waitFor(() =>{  expect(ctx.goals.get(agent)?.phase).toBe('complete') }, { timeout: 10_000 })
  await agent.whenIdle()
  const work = await findCapabilityTaskRequest(workspace, authorization!)
  expect(work).not.toBeNull()
  const saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work!))
  expect(saved.authorization).toEqual(authorization)
  expect(Object.keys(saved.authorization).sort()).toEqual(['message_id', 'session_id'])
  await expect(persistCapabilityTaskRequest(workspace, agent.session, 'chapter_writing', saved.task,
    saved.authorization, [], saved.return_state, agent)).rejects.toThrow('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
})

it('后续合法 Goal 轮次可修改未执行步骤，旧轮次与伪造来源不能授权新修改', async () => {
  const { ctx, agent, workspace, clearAdapter } = await setup('tender_analysis')
  await seedCapabilityProject(workspace, 'partial')
  const done = Promise.withResolvers<undefined>()
  let work: Awaited<ReturnType<typeof persistCapabilityTaskRequest>>
  let saved: ReturnType<typeof capabilityTaskRequestSchema.parse>
  let firstAuthorization: NonNullable<ReturnType<typeof resolveBidToolAuthorization>>
  let round = 0
  clearAdapter()
  ctx.llm.registerAdapter(['mock'], new TestAdapter(async () => {
    try {
      round++
      const authorization = resolveBidToolAuthorization(agent)!
      if (round === 1) {
        firstAuthorization = authorization
        work = await persistCapabilityTaskRequest(workspace, agent.session, 'chapter_writing', {
          goal: '审核章节和全书', scope: { kind: 'project' }, steps: [
            { description: '审核章节', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核章节' } } },
            { description: '审核全书', scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: '审核全书' } } },
          ],
        }, authorization, ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null }, agent)
        saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
        await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
          allowedWrites: async (call) => {
            if (call.capability === 'document.review') throw new Error('等待新计划')
            return new Set(['chapters/local-review.json'])
          },
          execute: async (_call, context) => {
            await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
            return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
              change_summary: '章节已审核', warnings: [], missing_topics: [], needs_input: false } }
          }, validate: async () => {},
        }, agent, agent.session)).rejects.toThrow('等待新计划')
      } else {
        const paths = await prepareBidWorkingTree(workspace, work)
        const working = new BidWorkspace(paths.root)
        const steps = [{ description: '只审核一致性', scope: { source: 'task' as const }, call: { capability: 'document.review' as const, input: { reason: '只审核一致性' } } }]
        const patched = await patchCapabilityTaskSteps(createTestBidRunContext({ work }), workspace, working,
          saved, agent.session, authorization, 1, steps, agent)
        expect(patched.steps[1]?.authorization).toEqual(authorization)
        expect(authorization.message_id).not.toBe(firstAuthorization.message_id)
        await expect(patchCapabilityTaskSteps(createTestBidRunContext({ work }), workspace, working,
          saved, agent.session, firstAuthorization, 1, steps, agent)).rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
        const goal = ctx.goals.get(agent)!
        agent.session.append('turn/start', { turn: 100 })
        agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '伪造授权' }],
          source: { kind: 'plugin', plugin: 'test', form: 'instructions' } }), { surfaceOp: 'append' })
        expect(resolveBidToolAuthorization(agent)).toBeUndefined()
        const result = await agent.ctx.tools.execute({ agent, name: 'bid_run_task', arguments: { task: saved.task },
          callId: CallId('invalid-goal-task'), signal: new AbortController().signal })
        expect(result.isError).toBe(true)
        expect(resolveBidToolAuthorization({ ...agent })).toBeUndefined()
        ctx.goals.complete(agent, goal)
        done.resolve(undefined)
      }
    } catch (error) { done.reject(error) }
    return [{ type: 'finish', reason: { kind: 'stop' } }]
  }))
  ctx.goals.create(agent, { objective: '审核章节和全书', maxGoalRounds: 2 })
  await done.promise
  await agent.whenIdle()
}, 15_000)

it('无 Goal 时主 Agent 恢复原 Run；重复失败再次 steer，相同指令拒绝，不同方案可执行', async () => {
  const { ctx, host, agent, workspace } = await setup('tender_analysis', false)
  const steer = vi.spyOn(agent, 'steer')
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
      return current.runs.suspend('retry_exhausted', safeRecoverableBidFailure(descriptor, new Error('missing submission'), [{
        code: 'BID_TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失',
      }]))
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
    expect(agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
    const value = first.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.run_id !== 'string') {
      throw new Error(`unexpected recovery result: ${JSON.stringify(value)}`)
    }
    expect(agent.session.events.some(event => event.type === 'bid.project.resumed'
      && 'state' in event.data && event.data.state.status === 'running'
      && event.data.state.run.runId === value.run_id)).toBe(true)
    gate.resolve(undefined)
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
    const repeated = await readBidProjectState(workspace)
    if (repeated?.status !== 'suspended') throw new Error('测试没有重复故障')
    await expect(ctx.bid.resumeCurrentRun(agent.session, repeated.run.runId, repeated.revision, undefined,
      { instruction: '  补齐项目字段并按原提交工具提交。  ' }))
      .rejects.toMatchObject({ code: 'BID_RECOVERY_DUPLICATE_INSTRUCTION' })
    expect(steer).toHaveBeenCalledTimes(2)
    const changed = await agent.ctx.tools.execute({ agent, name: 'bid_recover_task',
      arguments: { target: 'run', run_id: repeated.run.runId, instruction: '先核对 chunk 原文，再逐字段补齐并提交。' },
      callId: CallId('changed-strategy'), signal: new AbortController().signal })
    expect(changed).toMatchObject({ isError: false, value: { accepted: true } })
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
    expect(steer).toHaveBeenCalledTimes(3)
    expect(agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(2)
    expect(ctx.get('goals')).toBeUndefined()

  } finally {
    gate.resolve(undefined)

  }
})


it.each(['user_stop', 'awaiting_input', 'provider unavailable', 'quota exhausted', 'credential missing'] as const)(
  '%s 只在需要主 Agent 解释阻断时唤醒', async (cause) => {
    const { host, agent, workspace } = await setup('tender_analysis', false)
    const steer = vi.spyOn(agent, 'steer')
    const operation = host.beginOperation(agent.session)
    await host.prepareOperation(operation)
    const run = await operation.runs.start(work('tender_analysis'))
    await operation.runs.suspend(cause === 'user_stop' || cause === 'awaiting_input' ? cause : 'executor_error',
      safeRecoverableBidFailure(run.work, new Error(cause)))
    await host.finishOperation(agent.session, operation)
    await agent.whenIdle()
    expect(steer).toHaveBeenCalledTimes(cause === 'user_stop' || cause === 'awaiting_input' ? 0 : 1)
    if (cause !== 'user_stop' && cause !== 'awaiting_input') {
      expect(await inspectBidStage(workspace, agent.session, undefined, 'recovery')).toMatchObject({ eligible: false })
      expect(agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
    }
    expect(agent.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('bid_recover_task')
  },
)

it.each(['file_intake', 'outline_generation', 'evidence_mapping', 'chapter_writing'] as const)(
  '重置到 %s 不更新或清除显式 Goal', async (stage) => {
    const { ctx, host, agent, workspace } = await setup('tender_analysis')
    await seedCapabilityProject(workspace, 'partial')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
    agent.session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'completed', run: null } })
    const disposeGate = ctx.goalRoundDriver.registerGate(() => 'wait')
    const goal = ctx.goals.create(agent, { objective: '核对资料' })
    await ctx.bid.resetStage(agent, stage)
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
    expect(ctx.goals.get(agent)).toEqual(goal)
    disposeGate()
  },
)

it('项目释放后重新请求同项目其他主会话的显式 Goal', async () => {
  const { ctx, host, agent, workspace } = await setup('tender_analysis')
  const { agent: other } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('same-project-goal'), agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: workspace.root, agentPreset: 'bid' },
  })
  await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
  const operation = host.beginOperation(agent.session)
  await host.prepareOperation(operation)
  await operation.runs.start(work('tender_analysis'))
  ctx.goals.create(other, { objective: '检查当前资料' })
  await ctx.sessions.flush(other.session)
  expect(ctx.goals.get(other)?.roundsStarted).toBe(0)
  await operation.runs.suspend('user_stop')
  await host.finishOperation(agent.session, operation)
  await vi.waitFor(() => { expect(ctx.goals.get(other)?.roundsStarted).toBe(1) })
  await other.whenIdle()
})
