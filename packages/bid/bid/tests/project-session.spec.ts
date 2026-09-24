import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  BID_INITIAL_TASK_STATE, BidHostRuntime, BidOrchestrator, BidWorkspace,
  BidRunCoordinator,
  bidProjectTaskState, buildBidStageTask, checkpointBidProjectState as checkpointStoredBidProjectState,
  getBidClientProjection, parseEvidenceMapArtifact,
  outlineArtifactSha256, parseChapterReviewArtifact,
  parseGlobalComplianceReviewArtifact, validateGlobalComplianceReview,
  parseTenderComplianceArtifact, parseTenderScoringArtifact, readBidProjectState,
  reduceBidTaskState, TECHNICAL_DEVIATION_SECTION_ID, validateTenderAnalysis,
  type BidRunData, type BidStage, type BidStageExecutorPort, type BidStageValidatorPort, type BidTaskState, type BidTaskStatus,
} from '@deepseek-ai/dsh-bid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareBidStageContextTransition } from '../src/stage-context.ts'
import { isBidMainSession } from '../src/stage-interaction.ts'
import { parseChapterExecutionLog } from '../src/chapter-writing-plan-artifacts.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { readBidChapterCommandJournal } from '../src/chapter-command-journal.ts'
import type { ChapterWritingControl } from '../src/chapter-writing-executor.ts'
import type { BidRunContext } from '../src/run-coordinator.ts'
import { writeRevisionQueue, type RevisionQueueArtifact } from '../src/chapter-revision-queue.ts'
import { writeRevisionBatch, type RevisionBatchArtifact } from '../src/chapter-revision-batch.ts'
import { buildRevisionComparisonPath, createRevisionComparisonArtifact } from '../src/chapter-revision-comparison.ts'
import { BID_UPLOAD_FILES_HEADER, BID_UPLOAD_SESSION_HEADER, BidStageExecutionError } from '../src/control-plane-contract.ts'
import {
  DOCX_TEMPLATE_NAME_HEADER,
  DOCX_TEMPLATE_REVISION_HEADER,
  DOCX_TEMPLATE_SIZE_HEADER,
} from '../src/docx-format-contract.ts'
import { persistBidWorkRequest } from '../src/work-descriptor.ts'
import type { CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { seedConversation, seedProjectArtifacts } from './fixtures/project-session.ts'
import { seedCapabilityProject } from './capability-fixture.ts'
import { readPendingCapabilityRequests } from '../src/bid-capability-queue.ts'
import { readCapabilityOutlineBaseline } from '../src/outline-draft-store.ts'

interface HostExecution {
  readonly inFlight: Map<string, unknown>
  readonly docxInFlight: Set<string>
  beginOperation(session: Session): unknown
  withDocxOperation<T>(session: Session, execute: (workspace: BidWorkspace) => Promise<T>): Promise<T>
  automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator
  handleBinaryUpload(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleDocxTemplateUpload(req: IncomingMessage, res: ServerResponse): Promise<void>
}

async function resumeRun(ctx: Context, session: Session) {
  if (session.header.cwd === undefined) throw new Error('Bid test Session has no workspace')
  const state = await readBidProjectState(new BidWorkspace(session.header.cwd))
  if (state === undefined || state.run === null) throw new Error('Bid test project has no Run')
  const run = state.run
  try {
    const value = await (ctx as Context & { bid: BidHostRuntime }).bid.resumeCurrentRun(session, run.runId, state.revision)
    return { ok: true as const, value }
  } catch (error: unknown) {
    return { ok: false as const, error: { code: 'BID_OPERATION_IN_PROGRESS', message: String(error) } }
  }
}

function toolCall(name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ProjectSessionAdapter extends LlmAdapter {
  readonly script: StreamChunk[][] = []
  readonly requests: GenerateOptions[] = []
  readonly mainSessionIds = new Set<string>()
  requestGate?: Promise<void>
  onRequest?: () => void
  childGate?: Promise<void>
  onChildRequest?: () => void
  isExecutionSession?: (sessionId: string) => boolean

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (!this.mainSessionIds.has(String(options.sessionId)) && this.isExecutionSession?.(String(options.sessionId)) !== true) {
      this.onChildRequest?.()
      await this.childGate
      yield* answer('S4 Mapping Child 已完成。')
      return
    }
    this.onRequest?.()
    await this.requestGate
    const response = this.script.shift()
    if (response === undefined) throw new Error('Project Session 模型脚本已耗尽')
    yield* response
  }
}

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

function runtime(session: Session) {
  return session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
}

type TestTaskSeed =
  | BidTaskState
  | { readonly stage: BidStage; readonly status: BidTaskStatus | 'pending' | 'waiting_start'; readonly failureReason?: string }

async function checkpointBidProjectState(
  workspace: BidWorkspace,
  state: TestTaskSeed,
) {
  const seed = state
  if (seed.status !== 'running' && seed.status !== 'failed') {
    const status = seed.status === 'pending' || seed.status === 'waiting_start' ? 'ready' : seed.status
    return checkpointStoredBidProjectState(workspace, { stage: seed.stage, status, run: null } as BidTaskState)
  }
  const work = await persistStageExecutionWork(workspace, seed.stage)
  const previous = await readBidProjectState(workspace)
  const run: BidRunData = {
    runId: work.workId,
    epoch: (previous?.status === 'running' || previous?.status === 'suspended' ? previous.run.epoch : 0) + 1,
    baseProjectRevision: previous?.revision ?? 0,
    work,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (seed.status === 'running') {
    return checkpointStoredBidProjectState(workspace, { stage: seed.stage, status: 'running', run })
  }
  return checkpointStoredBidProjectState(workspace, {
    stage: seed.stage,
    status: 'suspended',
    run: {
      ...run,
      cause: 'executor_error',
      error: { message: 'failureReason' in seed ? seed.failureReason ?? 'executor failed' : 'executor failed' },
    },
  })
}

async function persistStageExecutionWork(workspace: BidWorkspace, stage: BidStage) {
  const payload = { stage }
  const inputs = await Promise.all(buildBidStageTask(stage).inputs.map(async (path) => {
    try {
      return { path, sha256: createHash('sha256').update(await readFile(join(workspace.projectRoot, path))).digest('hex') }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, sha256: null }
      throw error
    }
  }))
  const work = await persistBidWorkRequest(
    workspace,
    'stage_execution',
    stage,
    payload,
    { stage, inputs, payload },
  )
  return work
}

async function fixture(options: {
  readonly realOrchestrator?: boolean
  readonly withPreset?: boolean
  readonly withPersistence?: boolean
  readonly root?: string
} = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-project-session-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new ProjectSessionAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  await ctx.plugin(SessionStore)
  if (options.withPersistence === true) {
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
  }
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  const webOutput = { schema: { type: 'object' as const }, render: () => [{ type: 'text' as const, text: '{}' }] }
  const webTool = (name: 'web_search' | 'web_fetch'): ToolDefinition => ({
    name, description: name, parameters: { type: 'object' }, output: webOutput,
    execute: async () => ({}),
  })
  if (options.withPreset === true) {
    ctx.tools.register(webTool('web_search'))
    ctx.tools.register(webTool('web_fetch'))
    ctx.provide('agentPresets', {
      composeFrom(agentCtx: Context): string {
        agentCtx.tools.register(webTool('web_search'))
        agentCtx.tools.register(webTool('web_fetch'))
        return 'bid'
      },
      mount(agentCtx: Context): Promise<{ id: string }> {
        agentCtx.tools.register(webTool('web_search'))
        agentCtx.tools.register(webTool('web_fetch'))
        return Promise.resolve({ id: 'bid' })
      },
    } as never)
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  const workspace = new BidWorkspace(root)
  const host = ctx.bid as unknown as HostExecution
  adapter.isExecutionSession = sessionId => [...host.inFlight.values()].some(candidate =>
    (candidate as { executionSessionId?: string }).executionSessionId === sessionId)
  const executeStage = vi.fn<BidStageExecutorPort['execute']>(async () => [])
  const executor = { canExecute: (_stage: BidStage): boolean => false, execute: executeStage } satisfies BidStageExecutorPort
  const validator: BidStageValidatorPort = { validate: async () => ({ ok: true, issues: [] }) }
  if (options.realOrchestrator !== true) host.automaticOrchestrator = (agent, current, signal) => {
    const operation = [...host.inFlight.values()].find(candidate =>
      (candidate as { executionSessionId?: string }).executionSessionId === agent.id) as {
        session: Session
        runs: BidRunCoordinator
      } | undefined
    if (operation === undefined) throw new Error('测试未找到 execution lane 所属操作')
    return new BidOrchestrator(operation.session, {
      canExecute: stage => executor.canExecute(stage),
      execute: async (task, run) => {
        await run.scheduler.waitUntilRunnable(run.signal)
        return executor.execute(task, run)
      },
    }, {
      validate: (stage, artifacts) => stage === 'tender_analysis' ? validateTenderAnalysis(current, stage, artifacts) : validator.validate(stage, artifacts),
    }, signal, (fromStage, toStage) => prepareBidStageContextTransition(agent.session, current, fromStage, toStage),
    operation.runs, stage => persistStageExecutionWork(current, stage))
  }
  const fresh = async (id: string, cwd = root, waitForIdle = true) => {
    adapter.mainSessionIds.add(id)
    const handle = options.root === undefined
      ? await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd, agentPreset: 'bid' } })
      : await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })
    await vi.waitFor(() => {
      expect(handle.agent.session.events.some(event => event.type === 'bid.project.resumed'), `${id} 应完成项目恢复`).toBe(true)
      if (waitForIdle) expect(host.inFlight.size).toBe(0)
    })
    return handle.agent
  }
  return { ctx, workspace, fresh, host, executor, executeStage, validator, adapter }
}

describe('Workspace 项目与独立 Session', () => {
  it('Host 以单一 Run 接纳能力任务并在公开主会话留下完成凭据通知', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-host-main')
    const message = createUserMessage({ content: [{ type: 'text', text: '审核当前章节' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const dispatcher: CapabilityTaskDispatcher = {
      allowedWrites: async () => new Set(['chapters/local-review.json']),
      execute: async (_call, context) => {
        await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
        return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
          change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }
      },
      validate: async () => {},
    }
    const unregister = ctx.bid.registerCapabilityTaskDispatcher(dispatcher)
    try {
      const result = await ctx.bid.runCapabilityTask(agent, {
        goal: '审核当前章节', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
          call: { capability: 'chapter.review', input: { reason: '审核当前章节' } } }],
      }, { session_id: String(agent.session.id), message_id: String(message.id) }, ['chapters/execution-log.json'])
      expect(result).toMatchObject({ stage: 'chapter_writing', status: 'completed', run: null })
      const starts = agent.session.events.filter(event => event.type === 'bid.run.started'
        && event.data.run.work.kind === 'capability_task')
      expect(starts).toHaveLength(1)
      const workId = starts[0]?.type === 'bid.run.started' ? starts[0].data.run.work.workId : undefined
      expect(agent.session.events.find(event => event.type === 'bid.run.notice'
        && event.data.workId === workId)).toMatchObject({ data: {
        kind: 'completed', resultRef: `requests/${workId}/result.json`,
      } })
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('"ok": true')
      expect(await readFile(join(workspace.projectRoot, 'requests', workId ?? '', 'result.json'), 'utf8'))
        .toContain('chapters/local-review.json')
    } finally { unregister() }
  })

  it('能力任务等待原生补充输入后续行原 Work', async () => {
    const { ctx, workspace, fresh, host } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-native-input-main')
    const message = createUserMessage({ content: [{ type: 'text', text: '审核当前章节并补齐问题' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const reply = Promise.withResolvers<AskUserQuestionAnswer>()
    let question: AskUserQuestionItem | undefined
    const provider = ctx.userQuestions.registerProvider({ ask: async ({ questions }) => {
      question = questions[0]
      return reply.promise
    } })
    const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (_call, context) => {
      if (context.inputAnswer === undefined) return { result: { target_section_ids: [], changed_artifacts: [],
        change_summary: '需要确认审核重点', warnings: [], missing_topics: ['请明确审核重点'], needs_input: true } }
      await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), {
        answer: context.inputAnswer.custom,
      })
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
        change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }
    })
    const unregister = ctx.bid.registerCapabilityTaskDispatcher({
      allowedWrites: async () => new Set(['chapters/local-review.json']), execute, validate: async () => {},
    })
    try {
      await expect(ctx.bid.runCapabilityTask(agent, {
        goal: '审核当前章节并补齐问题', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
          call: { capability: 'chapter.review', input: { reason: '审核当前章节' } } }],
      }, { session_id: String(agent.session.id), message_id: String(message.id) }, ['chapters/execution-log.json']))
        .resolves.toMatchObject({ status: 'suspended', run: { cause: 'awaiting_input' } })
      await vi.waitFor(() => { expect(question?.id).toContain('capability:') })
      reply.resolve({ answers: [{ id: question?.id ?? '', selected: [], custom: '重点核对质量控制' }] })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'bid.capability.input.received')).toHaveLength(1)
        expect(agent.session.events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed'))
          .toHaveLength(1)
        expect(host.inFlight.size).toBe(0)
      }, { timeout: 10_000 })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8'))
        .toContain('重点核对质量控制')
    } finally {
      reply.resolve({ answers: [{ id: question?.id ?? '', selected: ['稍后补充'] }] })
      unregister()
      provider()
    }
  })

  it('正式文件已发布而 Run 未结算时，Host 恢复只补状态和一次通知', async () => {
    const { workspace, fresh, host } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-committed-restart-main')
    const message = createUserMessage({ content: [{ type: 'text', text: '审核已有正文' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const work = await persistCapabilityTaskRequest(workspace, agent.session, 'chapter_writing', {
      goal: '审核已有正文', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
        call: { capability: 'chapter.review', input: { reason: '审核已有正文' } } }],
    }, { session_id: String(agent.session.id), message_id: String(message.id) }, ['chapters/execution-log.json'],
    { stage: 'chapter_writing', status: 'completed', run: null })
    const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (_call, context) => {
      await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
        change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }
    })
    await executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
      allowedWrites: async () => new Set(['chapters/local-review.json']), execute, validate: async () => {},
    }, agent, agent.session)
    const crashed: BidRunData = { runId: 'capability-crash-run', epoch: 1, baseProjectRevision: 1, work,
      startedAt: Date.now(), updatedAt: Date.now() }
    await checkpointStoredBidProjectState(workspace, { stage: 'chapter_writing', status: 'running', run: crashed })
    const runtimeHost = host as HostExecution & {
      prepareOperation(operation: unknown): Promise<BidTaskState>
      finishOperation(session: Session, operation: unknown): Promise<void>
    }
    const operation = host.beginOperation(agent.session)
    try {
      await expect(runtimeHost.prepareOperation(operation)).resolves.toMatchObject({ status: 'completed' })
      expect(execute).toHaveBeenCalledOnce()
      expect(agent.session.events.filter(event => event.type === 'bid.run.notice'
        && event.data.workId === work.workId)).toHaveLength(1)
    } finally { await runtimeHost.finishOperation(agent.session, operation) }
  })

  it('重建 Host 和 Session 后恢复已发布能力 Work，不再启动 Child', async () => {
    const first = await fixture({ withPersistence: true })
    await seedProjectArtifacts(first.workspace)
    await checkpointBidProjectState(first.workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await first.fresh('capability-host-restart')
    const message = createUserMessage({ content: [{ type: 'text', text: '审核已保存正文' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    await first.ctx.sessions.flush(agent.session)
    const work = await persistCapabilityTaskRequest(first.workspace, agent.session, 'chapter_writing', {
      goal: '审核已保存正文', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
        call: { capability: 'chapter.review', input: { reason: '审核已保存正文' } } }],
    }, { session_id: String(agent.session.id), message_id: String(message.id) }, ['chapters/execution-log.json'],
    { stage: 'chapter_writing', status: 'completed', run: null })
    const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (_call, context) => {
      await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
        change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }
    })
    await executeCapabilityTask(first.workspace, createTestBidRunContext({ work }), {
      allowedWrites: async () => new Set(['chapters/local-review.json']), execute, validate: async () => {},
    }, agent, agent.session)
    await checkpointStoredBidProjectState(first.workspace, { stage: 'chapter_writing', status: 'running',
      run: { runId: 'capability-host-restart-run', epoch: 1, baseProjectRevision: 1, work,
        startedAt: Date.now(), updatedAt: Date.now() } })
    await first.ctx.fiber.dispose()

    const second = await fixture({ root: first.workspace.root, withPersistence: true })
    const restored = await second.fresh('capability-host-restart')
    expect(await readBidProjectState(second.workspace)).toMatchObject({ status: 'completed' })
    expect(await readFile(join(second.workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('"ok": true')
    expect(execute).toHaveBeenCalledOnce()
    expect(restored.session.events.filter(event => event.type === 'bid.run.notice'
      && event.data.workId === work.workId)).toHaveLength(1)
    expect(second.adapter.requests.filter(request => request.sessionId !== restored.session.id)).toHaveLength(0)
    await second.ctx.sessions.flush(restored.session)
    await second.ctx.fiber.dispose()

    const third = await fixture({ root: first.workspace.root, withPersistence: true })
    const again = await third.fresh('capability-host-restart')
    expect(await readBidProjectState(third.workspace)).toMatchObject({ status: 'completed' })
    expect(execute).toHaveBeenCalledOnce()
    expect(again.session.events.filter(event => event.type === 'bid.run.notice'
      && event.data.workId === work.workId)).toHaveLength(1)
    expect(third.adapter.requests.filter(request => request.sessionId !== again.session.id)).toHaveLength(0)
  })

  it('Run 登记后执行前中断，重建 Host 与 Session 后仅执行原能力 Work', async () => {
    const first = await fixture({ withPersistence: true })
    await seedProjectArtifacts(first.workspace)
    await checkpointBidProjectState(first.workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await first.fresh('capability-admission-restart')
    const message = createUserMessage({ content: [{ type: 'text', text: '审核已保存正文' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    await first.ctx.sessions.flush(agent.session)
    const task = { goal: '审核已保存正文', scope: { kind: 'project' as const }, steps: [{
      scope: { source: 'task' as const }, call: { capability: 'chapter.review' as const,
        input: { reason: '审核已保存正文' } },
    }] }
    await expect(first.ctx.bid.runCapabilityTask(agent, task,
      { session_id: String(agent.session.id), message_id: String(message.id) },
      ['chapters/execution-log.json'], async () => { throw new Error('登记后中断') }))
      .rejects.toThrow('登记后中断')
    expect(await readBidProjectState(first.workspace)).toMatchObject({ status: 'suspended' })
    await expect(readFile(join(first.workspace.projectRoot, 'chapters/local-review.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await first.ctx.fiber.dispose()

    const second = await fixture({ root: first.workspace.root, withPersistence: true })
    const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (_call, context) => {
      await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
        change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }
    })
    const unregister = second.ctx.bid.registerCapabilityTaskDispatcher({
      allowedWrites: async () => new Set(['chapters/local-review.json']), execute, validate: async () => {},
    })
    try {
      const restored = await second.fresh('capability-admission-restart')
      const suspended = await readBidProjectState(second.workspace)
      expect(suspended).toMatchObject({ status: 'suspended' })
      if (suspended?.status !== 'suspended') throw new Error('未保存待恢复 Run')
      const result = await second.ctx.bid.resumeCurrentRun(restored.session, suspended.run.runId, suspended.revision)
      expect(result).toMatchObject({ status: 'completed' })
      expect(execute).toHaveBeenCalledOnce()
      expect(await readFile(join(second.workspace.projectRoot, 'chapters/local-review.json'), 'utf8'))
        .toContain('"ok": true')
      expect(restored.session.events.filter(event => event.type === 'bid.run.notice'
        && event.data.workId === suspended.run.work.workId && event.data.kind === 'completed')).toHaveLength(1)
    } finally { unregister() }
  })

  it('首个能力步骤已合并后重建 Host 与 Session，只重试未完成步骤', async () => {
    const first = await fixture({ withPersistence: true })
    await seedProjectArtifacts(first.workspace)
    await checkpointBidProjectState(first.workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await first.fresh('capability-step-restart')
    const message = createUserMessage({ content: [{ type: 'text', text: '先审章节再审全书' }], source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    await first.ctx.sessions.flush(agent.session)
    const calls: string[] = []
    let interrupt = true
    const dispatcher: CapabilityTaskDispatcher = {
      allowedWrites: async call => new Set([call.capability === 'chapter.review'
        ? 'chapters/local-review.json' : 'chapters/document-review.json']),
      execute: async (call, context) => {
        calls.push(call.capability)
        if (call.capability === 'document.review' && interrupt) {
          interrupt = false
          throw new Error('整书审核前中断')
        }
        const path = call.capability === 'chapter.review'
          ? 'chapters/local-review.json' : 'chapters/document-review.json'
        await context.run.commits.writeJson(join(context.working.projectRoot, path), { capability: call.capability })
        return { result: { target_section_ids: [], changed_artifacts: [path],
          change_summary: `完成 ${call.capability}`, warnings: [], missing_topics: [], needs_input: false } }
      },
      validate: async () => {},
    }
    first.ctx.bid.registerCapabilityTaskDispatcher(dispatcher)
    const result = await first.ctx.bid.runCapabilityTask(agent, { goal: '先审章节再审全书',
      scope: { kind: 'project' }, steps: [
        { scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核章节' } } },
        { scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: '审核全书' } } },
      ] }, { session_id: String(agent.session.id), message_id: String(message.id) },
    ['chapters/execution-log.json'])
    expect(result).toMatchObject({ status: 'suspended' })
    expect(calls).toEqual(['chapter.review', 'document.review'])
    await expect(readFile(join(first.workspace.projectRoot, 'chapters/local-review.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await first.ctx.fiber.dispose()

    const second = await fixture({ root: first.workspace.root, withPersistence: true })
    const unregister = second.ctx.bid.registerCapabilityTaskDispatcher(dispatcher)
    try {
      const restored = await second.fresh('capability-step-restart')
      const suspended = await readBidProjectState(second.workspace)
      if (suspended?.status !== 'suspended') throw new Error('未恢复待续行 Work')
      expect(await second.ctx.bid.resumeCurrentRun(restored.session, suspended.run.runId, suspended.revision))
        .toMatchObject({ status: 'completed' })
      expect(calls).toEqual(['chapter.review', 'document.review', 'document.review'])
      expect(await readFile(join(second.workspace.projectRoot, 'chapters/local-review.json'), 'utf8'))
        .toContain('chapter.review')
      expect(await readFile(join(second.workspace.projectRoot, 'chapters/document-review.json'), 'utf8'))
        .toContain('document.review')
      expect(restored.session.events.filter(event => event.type === 'bid.run.notice'
        && event.data.workId === suspended.run.work.workId && event.data.kind === 'completed')).toHaveLength(1)
    } finally { unregister() }
  })

  it('上传入口把 S1 Work 交给与恢复入口相同的默认编排器', async () => {
    const { ctx, fresh, host } = await fixture()
    const agent = await fresh('shared-capability-route')
    const next = { stage: 'tender_analysis', status: 'waiting_user', run: null } as const
    const route = vi.spyOn(host, 'automaticOrchestrator').mockReturnValue({
      runCurrentProgramStage: vi.fn(async () => next),
      drive: vi.fn(async () => next),
    } as unknown as BidOrchestrator)
    const result = await ctx.bid.uploadIncomingFiles(agent.session, [{
      name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('项目技术要求'),
    }])
    expect(result).toMatchObject({ ok: true, value: next })
    expect(route).toHaveBeenCalledOnce()
    expect(route.mock.calls[0]?.[0].id).not.toBe(agent.id)
    expect(route.mock.calls[0]?.[0].session.header.parentSession).toBe(agent.session.id)
    expect(route.mock.calls[0]?.[1]).toBeInstanceOf(BidWorkspace)
  })

  it('S5 由 Host 在释放项目锁后建立原生写作要求问题并保存真实回答', async () => {
    const { ctx, workspace, fresh, host, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'), { force: true })
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user' })
    const response = Promise.withResolvers<AskUserQuestionAnswer>()
    let question: AskUserQuestionItem | undefined
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      question = questions[0]
      return response.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      const agent = await fresh('s5-native-writing-question')
      await expect(ctx.bid.requestWritingRequirements(agent.session)).resolves.toMatchObject({ ok: true })
      await vi.waitFor(() => { expect(asked).toHaveBeenCalledOnce() })
      expect(question).toMatchObject({
        question: '开始正文编写前，是否还有其他整体写作要求？',
        options: [{ label: '没有，开始编写' }],
        multiSelect: false,
      })
      expect(host.inFlight.size).toBe(0)
      expect(executeStage).not.toHaveBeenCalled()
      response.resolve({ answers: [{ id: question?.id ?? '', selected: [], custom: '正式语言\n重点展开质量控制。' }] })
      await vi.waitFor(async () => {
        const saved = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as {
          state: string
          answer?: { kind: string; custom?: string }
        }
        expect(saved.state).toBe('answered')
        expect(saved.answer).toEqual(expect.objectContaining({ kind: 'custom', custom: '正式语言\n重点展开质量控制。' }))
      })
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      await agent.whenIdle()
    } finally {
      response.resolve({ answers: [{ id: question?.id ?? 'cancelled', selected: [] }] })
      dispose()
    }
  })

  it('继承 Bid preset 与 cwd 的 live Subagent 不获得项目控制权', async () => {
    const { ctx, workspace, fresh, host } = await fixture()
    const main = await fresh('upload-main')
    const childId = SessionId('upload-child')
    const childAgent = (await ctx.agentLoop.createAgent(ctx, {
      sessionId: childId,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: workspace.root, agentPreset: 'bid', origin: 'subagent', parentSession: main.id },
    })).agent
    const child = childAgent.session
    const manifest = await workspace.readManifest()
    const library = await ctx.bid.getDocxTemplateLibrary(main.session)
    const operationCount = host.inFlight.size
    expect(child.header).toMatchObject({
      agentPreset: 'bid', cwd: workspace.root, origin: 'subagent', parentSession: main.id,
    })
    expect(isBidMainSession(child)).toBe(false)
    expect(ctx.tools.get('bid_stage_inspect', childAgent)).toBeUndefined()
    await expect(ctx.serial('session/prompt-admission', {
      session: child, mode: 'queue', content: [{ type: 'text', text: '内部任务' }],
    })).resolves.toBeUndefined()
    await expect(ctx.bid.resetStage(childAgent, 'tender_analysis')).rejects.toThrow('Stage reset requires a Bid Session')
    await expect(ctx.bid.getDetails(child)).rejects.toThrow('BID_SESSION_REQUIRED')
    await expect(ctx.bid.getDocxTemplateLibrary(child)).rejects.toThrow('Word 模板库需要标书项目会话')
    const executeDocx = vi.fn(async () => undefined)
    expect(() => host.beginOperation(child)).toThrow('BID_SESSION_REQUIRED')
    await expect(host.withDocxOperation(child, executeDocx)).rejects.toThrow('BID_SESSION_REQUIRED')
    expect(executeDocx).not.toHaveBeenCalled()
    await expect(ctx.bid.uploadIncomingFiles(child, [{
      name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('不得写入'),
    }])).resolves.toMatchObject({ ok: false, error: { code: 'BID_SESSION_REQUIRED' } })

    const request = (headers: IncomingMessage['headers']) => ({ method: 'POST', headers }) as IncomingMessage
    const invoke = async (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, headers: IncomingMessage['headers']) => {
      let status = 0
      let body = ''
      const response = {
        writeHead(code: number) { status = code; return response },
        end(chunk?: string) { body = chunk ?? ''; return response },
      } as unknown as ServerResponse
      await handler(request({ host: 'localhost', origin: 'http://localhost', ...headers }), response)
      return { status, body: JSON.parse(body) as { ok: boolean } }
    }
    const binary = await invoke(host.handleBinaryUpload.bind(host), {
      [BID_UPLOAD_SESSION_HEADER]: String(childId),
      [BID_UPLOAD_FILES_HEADER]: encodeURIComponent('[]'),
    })
    const docx = await invoke(host.handleDocxTemplateUpload.bind(host), {
      [BID_UPLOAD_SESSION_HEADER]: String(childId),
      [DOCX_TEMPLATE_NAME_HEADER]: encodeURIComponent('模板.docx'),
      [DOCX_TEMPLATE_SIZE_HEADER]: '1',
      [DOCX_TEMPLATE_REVISION_HEADER]: String(library.revision),
    })

    expect(binary).toMatchObject({ status: 200, body: { ok: false } })
    expect(docx).toMatchObject({ status: 200, body: { ok: false } })
    expect(host.inFlight.size).toBe(operationCount)
    expect(host.docxInFlight.size).toBe(0)
    expect(await workspace.readManifest()).toEqual(manifest)
    expect(await ctx.bid.getDocxTemplateLibrary(main.session)).toEqual(library)
  })

  it('ready and suspended Bid stages expose bounded public inspection without starting a Run', async () => {
    const { ctx, workspace, fresh, host } = await fixture()
    await seedProjectArtifacts(workspace)
    const cases = [
      ['file_intake', 'pending', 'ready'],
      ['tender_analysis', 'pending', 'ready'],
      ['evidence_mapping', 'waiting_start', 'ready'],
      ['tender_analysis', 'failed', 'suspended'],
      ['docx_export', 'pending', 'ready'],
    ] as const

    for (const [stage, seedStatus, expectedStatus] of cases) {
      await checkpointBidProjectState(workspace, { stage, status: seedStatus })
      const agent = await fresh(`idle-${stage}-${seedStatus}`)

      await expect(ctx.serial('session/prompt-admission', {
        session: agent.session,
        mode: 'queue',
        content: [{ type: 'text', text: '现在是什么状态？' }],
      })).resolves.toBeUndefined()

      expect(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('bid_')).map(tool => tool.name))
        .toEqual(['bid_stage_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_plan_task',
          'bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap',
          'bid_confirm_writing_plan', 'bid_revise_chapter'])
      const project = await ctx.tools.execute({
        agent, name: 'bid_project_inspect', arguments: { query: { object: 'outline', page_size: 1 } },
        callId: CallId(`project-${stage}-${seedStatus}`), signal: new AbortController().signal,
      })
      expect(project).toMatchObject({ isError: false, value: { available: true, total: 1 } })
      const inspected = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'summary' },
        callId: CallId(`idle-${stage}-${seedStatus}`),
        signal: new AbortController().signal,
      })
      expect(inspected.isError, JSON.stringify(inspected)).toBe(false)
      expect(inspected.value).toMatchObject({ task: { stage, status: expectedStatus } })
      expect(host.inFlight.size).toBe(0)
      expect(agent.session.events.some(event => event.type === 'bid.stage.started')).toBe(false)
      expect(agent.session.events.some(event => event.type === 'bid.run.started')).toBe(false)
    }
  })

  it('主 Agent 工具以真实用户消息执行跨阶段能力任务并返回发布文件', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedCapabilityProject(workspace, 'complete')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-main-tool')
    const message = createUserMessage({ content: [{ type: 'text', text: '更正第一条招标要求的理解' }],
      source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const result = await ctx.tools.execute({ agent, name: 'bid_run_task', arguments: { task: {
      goal: '更正第一条招标要求的理解', scope: { kind: 'project' }, steps: [{
        scope: { source: 'task' }, call: { capability: 'tender.update', input: { operations: [{
          type: 'update_requirement', requirement_id: 'REQ-1',
          fields: { normalized_requirement: '明确实施边界' },
        }] } },
      }],
    } }, callId: CallId('capability-main-tool'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(result.value).toMatchObject({ accepted: true, state: { stage: 'chapter_writing', status: 'completed' },
      changed_artifacts: expect.arrayContaining(['analysis/requirements.json']) })
  })

  it('后续真实用户消息通过 bid_plan_task 只调整挂起 Work 未开始的后缀', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-plan-patch-main')
    const first = createUserMessage({ content: [{ type: 'text', text: '审核章节和整书' }], source: { kind: 'user' } })
    agent.session.append('user/message', first, { surfaceOp: 'append' })
    const work = await persistCapabilityTaskRequest(workspace, agent.session, 'chapter_writing', {
      goal: '审核章节和整书', scope: { kind: 'project' }, steps: [
        { scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核章节' } } },
        { scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: '审核整书' } } },
      ],
    }, { session_id: String(agent.session.id), message_id: String(first.id) }, ['chapters/execution-log.json'],
    { stage: 'chapter_writing', status: 'completed', run: null })
    const executed = vi.fn<CapabilityTaskDispatcher['execute']>(async (_call, context) => {
      await context.run.commits.writeJson(join(context.working.projectRoot, 'chapters/local-review.json'), { ok: true })
      return { result: { target_section_ids: [], changed_artifacts: ['chapters/local-review.json'],
        change_summary: '本章已审核', warnings: [], missing_topics: [], needs_input: false } }
    })
    await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
      allowedWrites: async (call) => {
        if (call.capability === 'document.review') throw new Error('等待后续计划')
        return new Set(['chapters/local-review.json'])
      }, execute: executed, validate: async () => {},
    }, agent, agent.session)).rejects.toThrow('等待后续计划')
    const suspended: BidRunData = { runId: 'capability-plan-patch-run', epoch: 1, baseProjectRevision: 1,
      work, startedAt: Date.now(), updatedAt: Date.now() }
    await checkpointStoredBidProjectState(workspace, { stage: 'chapter_writing', status: 'suspended',
      run: { ...suspended, cause: 'executor_error', error: { message: '等待后续计划' } } })
    const correction = createUserMessage({ content: [{ type: 'text', text: '整书审核只检查一致性' }], source: { kind: 'user' } })
    agent.session.append('user/message', correction, { surfaceOp: 'append' })
    const patched = await ctx.tools.execute({ agent, name: 'bid_plan_task', arguments: {
      work_id: work.workId, from_index: 1, steps: [{ scope: { source: 'task' },
        call: { capability: 'document.review', input: { reason: '只检查一致性' } } }],
    }, callId: CallId('patch-capability-plan'), signal: new AbortController().signal })
    expect(patched).toMatchObject({ isError: false, value: { accepted: true, steps: 2 } })
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'runs', work.workId,
      'task-checkpoint.json'), 'utf8')) as { steps: Array<{ status: string; step: { call: { input: { reason: string } } } }> }
    expect(checkpoint.steps.map(step => step.status)).toEqual(['completed', 'pending'])
    expect(checkpoint.steps[1]?.step.call.input.reason).toBe('只检查一致性')
    expect(executed).toHaveBeenCalledOnce()
    expect(await readBidProjectState(workspace)).toMatchObject({ status: 'suspended' })
  })

  it('旧目录工具在 S5 完成后使用能力 Work，并保留 CAS 冲突保护', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedCapabilityProject(workspace, 'complete')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-legacy-outline-main')
    const unchanged = await readFile(join(workspace.projectRoot, 'chapters/sections/0004.md'))
    const baseline = await readCapabilityOutlineBaseline(workspace)
    const message = createUserMessage({ content: [{ type: 'text', text: '把第三章标题改为实施检查' }],
      source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const result = await ctx.tools.execute({ agent, name: 'bid_outline_apply_operations', arguments: {
      expected_revision: baseline.revision, expected_draft_sha256: baseline.draft_outline_sha256,
      operations: [{ type: 'update_section', section_id: 'SEC-3', title: '实施检查' }],
    }, callId: CallId('legacy-capability-outline'), signal: new AbortController().signal })
    expect(result).toMatchObject({ isError: false, value: { accepted: true, queued: false } })
    const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as {
      sections: Array<{ id: string; title: string }>
    }
    expect(outline.sections.find(section => section.id === 'SEC-3')?.title).toBe('实施检查')
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0004.md'))).toEqual(unchanged)
    expect(agent.session.events.filter(event => event.type === 'bid.run.started'
      && event.data.run.work.kind === 'capability_task')).toHaveLength(1)
    const stale = await ctx.tools.execute({ agent, name: 'bid_outline_apply_operations', arguments: {
      expected_revision: baseline.revision, expected_draft_sha256: baseline.draft_outline_sha256,
      operations: [{ type: 'update_section', section_id: 'SEC-3', title: '过期修改' }],
    }, callId: CallId('legacy-capability-outline-stale'), signal: new AbortController().signal })
    expect(stale).toMatchObject({ isError: false, value: { ok: false,
      error: { code: 'BID_OUTLINE_DRAFT_CONFLICT' } } })
  })

  it('运行中的 S4 将跨阶段修改登记到原 Work，收敛后执行一次', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage } = await fixture()
    await seedCapabilityProject(workspace, 'complete')
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('queued-capability-main')
    const gate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => gate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ status: 'running' }) })
    const running = runtime(agent.session)
    if (running.status !== 'running') throw new Error('应有当前 Run')
    await vi.waitFor(() => {
      const active = [...host.inFlight.values()][0] as { runs: BidRunCoordinator } | undefined
      expect(active?.runs.current).toBeDefined()
    })
    const message = createUserMessage({ content: [{ type: 'text', text: '更正第一条招标要求' }],
      source: { kind: 'user' } })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const queued = await ctx.tools.execute({ agent, name: 'bid_run_task', arguments: { task: {
      goal: '更正第一条招标要求', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
        call: { capability: 'tender.update', input: { operations: [{ type: 'update_requirement',
          requirement_id: 'REQ-1', fields: { normalized_requirement: '明确实施边界' } }] } } }],
    } }, callId: CallId('queued-capability-main'), signal: new AbortController().signal })
    expect(queued.isError, JSON.stringify(queued)).toBe(false)
    expect(queued.value).toMatchObject({ accepted: true, queued: true })
    expect(await readPendingCapabilityRequests(workspace, running.run.work.workId)).toHaveLength(1)
    expect(await ctx.bid.getCapabilityTaskPlan(agent.session)).toMatchObject({
      status: 'queued', title: '更正第一条招标要求',
      steps: [{ capability: 'tender.update', status: 'pending' }],
    })
    gate.resolve([])
    const settled = await retry
    expect(settled).toMatchObject({ ok: true })
    expect(await readBidProjectState(workspace)).toMatchObject({ status: 'waiting_user' })
    await vi.waitFor(async () => {
      const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as {
        requirements: Array<{ normalized_requirement: string }>
      }
      expect(requirements.requirements[0]?.normalized_requirement).toBe('明确实施边界')
    }, { timeout: 10_000 })
    expect(await readPendingCapabilityRequests(workspace, running.run.work.workId)).toEqual([])
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) }, { timeout: 10_000 })
    expect(await ctx.bid.getCapabilityTaskPlan(agent.session)).toMatchObject({
      status: 'completed', steps: [{ capability: 'tender.update', status: 'completed' }],
    })
  }, 20_000)

  it('S4 reset 后 inspect 从 S3 已确认目录恢复章节摘要但不伪造 Draft', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(outline))
    await Promise.all([
      rm(join(workspace.projectRoot, 'outline/outline.json'), { force: true }),
      rm(join(workspace.projectRoot, 'outline/draft.json'), { force: true }),
    ])
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_start' })
    const agent = await fresh('reset-s4-inspect')

    const inspected = await ctx.tools.execute({
      agent, name: 'bid_stage_inspect', arguments: { view: 'task_contract_context' },
      callId: CallId('reset-s4-inspect'), signal: new AbortController().signal,
    })

    expect(inspected).toMatchObject({ isError: false, value: {
      task: { stage: 'evidence_mapping', status: 'ready', run: null },
      current_artifacts_summary: { outline_sections: outline.sections.length },
      sections: expect.arrayContaining([expect.objectContaining({
        section: expect.objectContaining({ id: outline.sections[0]!.id }),
      })]),
      draft: null,
      mapping_progress: null,
      mapping_tasks: [],
    } })
  })

  it('详情按已发布目录和正文展示，阶段标签不隐藏现有内容', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    for (const [path, title] of [
      ['initial-confirmed-outline.json', 'S3 已确认目录'],
      ['outline.json', 'S4 已生成目录'],
      ['confirmed-outline.json', 'S4 最终确认目录'],
    ]) {
      await writeFile(join(workspace.projectRoot, 'outline', path!), JSON.stringify({ ...outline, sections: outline.sections.map(section => ({ ...section, title })) }))
    }
    const finalOutline = { ...outline, sections: outline.sections.map(section => ({ ...section, title: 'S4 最终确认目录' })) }
    const writingPlanPath = join(workspace.projectRoot, 'chapters/writing-plan.json')
    const writingPlan = JSON.parse(await readFile(writingPlanPath, 'utf8')) as Record<string, unknown>
    await writeFile(writingPlanPath, JSON.stringify({
      ...writingPlan,
      confirmed_outline_sha256: outlineArtifactSha256(finalOutline),
    }))
    const cases = [
      ['file_intake', 'pending', false],
      ['tender_analysis', 'waiting_user', true],
      ['outline_generation', 'pending', true],
      ['outline_generation', 'waiting_user', true],
      ['evidence_mapping', 'pending', true],
      ['evidence_mapping', 'failed', true],
      ['evidence_mapping', 'waiting_user', true],
      ['chapter_writing', 'pending', true],
      ['chapter_writing', 'failed', true],
      ['chapter_writing', 'completed', true],
      ['docx_export', 'completed', true],
    ] as const
    for (const [index, [stage, status, tender]] of cases.entries()) {
      await checkpointBidProjectState(workspace, { stage, status })
      const agent = await fresh(`details-${String(index)}`)
      executor.execute.mockClear()
      const details = await ctx.bid.getDetails(agent.session)
      expect(details.tender !== null).toBe(tender)
      expect(details.outline?.sections[0]?.title).toBe('S4 最终确认目录')
      expect(details.body).toBe(true)
      expect(details.outlinePresentation?.source).toBe('final_confirmed')
      expect(details.outlinePresentation?.baseline?.sections[0]?.title).toBe('S3 已确认目录')
      expect(details.outlinePresentation?.evidence?.section_mappings[0]?.missing_topics).toEqual(['待补充实施材料'])
      expect(details.outlinePresentation?.errors).toEqual([])
      expect(executor.execute).not.toHaveBeenCalled()
    }
  })

  it('S5 运行中读取详情不等待写作任务，不调用确认接口；上下文损坏保留最终版本状态', async () => {
    const { ctx, workspace, fresh, host, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(outline))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('details-in-flight')
    agent.session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    const review = vi.spyOn(ctx.bid, 'getOutlineReviewContext')
    const before = agent.session.events.length
    host.inFlight.set(process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root, { done: new Promise(() => {}) })
    try {
      const result = await ctx.bid.getDetails(agent.session)
      expect(result.outlinePresentation).toMatchObject({ source: 'final_confirmed', baseline: outline, errors: [] })
      await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), '{')
      await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), '{')
      const broken = await ctx.bid.getDetails(agent.session)
      expect(broken.outline).toEqual(outline)
      expect(broken.outlinePresentation).toMatchObject({ source: 'final_confirmed', baseline: null, evidence: null })
      expect(broken.outlinePresentation?.errors.join('\n')).toContain('initial-confirmed-outline.json 读取失败')
      expect(broken.outlinePresentation?.errors.join('\n')).toContain('evidence-map.json 读取失败')
      expect(review).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
      expect(agent.session.events).toHaveLength(before)
    } finally { host.inFlight.clear() }
  })
  it('fresh Session 保留 S4 项目，聊天、推理、工具和 conversation nodes 均为空', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    seedConversation(a.session)
    const fork = vi.spyOn(ctx.sessions, 'fork')
    const b = await fresh('session-b')

    expect(runtime(b.session)).toMatchObject(state)
    expect(b.session.header.parentSession).toBeUndefined()
    expect(b.session.header.seedLength).toBeUndefined()
    expect(b.session.surface.nodes).toEqual([])
    expect(b.session.deriveMessages()).toEqual([])
    expect(b.session.events.map(event => event.type)).toEqual([
      'bid.project.resumed',
      'bid.writing_entry.changed',
    ])
    expect(fork).not.toHaveBeenCalled()
    expect(executor.execute).not.toHaveBeenCalled()
    expect(a.session.deriveMessages()).toHaveLength(3)
    expect(await ctx.bid.getOutlineForConfirmation(b.session)).toEqual(outline)
    expect((await new BidWorkspace(b.session.header.cwd!).readManifest()).files).toHaveLength(1)
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(evidence.section_mappings[0]?.missing_topics).toEqual(['待补充实施材料'])
  })

  it('执行中创建的 fresh Session 保留完整 Run 与 Work 身份', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'failed' })
    const owner = await fresh('active-owner')
    const artifacts = buildBidStageTask('tender_analysis').requiredArtifacts.map((path, index) => ({
      stage: 'tender_analysis' as const,
      type: `artifact-${String(index)}`,
      path,
    }))
    const gate = Promise.withResolvers<typeof artifacts>()
    executor.canExecute = stage => stage === 'tender_analysis'
    executeStage.mockImplementationOnce(() => gate.promise)
    const resumed = resumeRun(ctx, owner.session)
    await vi.waitFor(() => { expect(runtime(owner.session)).toMatchObject({ stage: 'tender_analysis', status: 'running' }) })
    await vi.waitFor(async () => {
      expect((await readBidProjectState(workspace))?.status).toBe('running')
    })
    const activeState = await readBidProjectState(workspace)
    if (activeState?.status !== 'running') throw new Error('测试项目没有活动 Run')
    expect(activeState.run).toMatchObject({ interactionSessionId: owner.id })
    expect(activeState.run.executionSessionId).toBeTruthy()
    expect(activeState.run.executionSessionId).not.toBe(owner.id)
    const executionSession = ctx.agents.get(SessionId(activeState.run.executionSessionId!))?.session
    expect(executionSession?.header).toMatchObject({
      parentSession: owner.id,
      origin: 'subagent',
    })
    expect(executionSession?.events.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
      mode: 'one-shot',
      provider: 'bid',
      label: 'S2 · 招标信息提取',
    })
    await expect(ctx.subagents.listChildren(owner.id)).resolves.toContainEqual({
      kind: 'child',
      id: SessionId(activeState.run.executionSessionId!),
      mode: 'one-shot',
      label: 'S2 · 招标信息提取',
      activity: 'running',
      hasChildren: false,
    })

    const observer = await fresh('active-observer', workspace.root, false)
    const mirrored = observer.session.events.findLast(event => event.type === 'bid.project.resumed')
    expect(mirrored?.data).toEqual({ state: bidProjectTaskState(activeState), revision: activeState.revision })
    expect(mirrored !== undefined && 'runtime' in mirrored.data).toBe(false)
    expect(host.inFlight.size).toBe(1)

    gate.resolve(artifacts)
    await resumed
  })

  it('目录 inspect 在 Draft 不存在时只派生视图且不 bump revision', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await writeFile(
      join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'),
      await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'),
    )
    await rm(join(workspace.projectRoot, 'outline/draft.json'), { force: true })
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
    const agent = await fresh('pure-read-draft')
    const before = await readBidProjectState(workspace)

    await expect(ctx.bid.getOutlineDraft(agent.session)).resolves.toMatchObject({ revision: 1 })
    const reviewContext = await ctx.bid.getOutlineReviewContext(agent.session)
    expect(reviewContext.baseline).toBeTruthy()
    await ctx.bid.getDetails(agent.session)

    await expect(readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readBidProjectState(workspace)).toEqual(before)
  })

  it('新项目初始化 S1，S2 在新 Session 中读取、编辑并继续确认', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const a = await fresh('session-a')
    expect(await readBidProjectState(workspace)).toMatchObject({
      schema_version: 4,
      stage: 'file_intake',
      status: 'waiting_user',
      run: null,
    })
    await seedProjectArtifacts(workspace)
    const scoringOriginPath = join(workspace.projectRoot, 'analysis/scoring-origin.json')
    const scoringOrigin = JSON.parse(await readFile(scoringOriginPath, 'utf8')) as { scoring_items: Array<Record<string, unknown>> }
    scoringOrigin.scoring_items.push({ ...scoringOrigin.scoring_items[0], id: 'SCORE-2', title: '实施方案', score: 5 })
    await writeFile(scoringOriginPath, `${JSON.stringify(scoringOrigin)}\n`)
    await writeFile(join(workspace.projectRoot, 'analysis/tender-analysis-selection.json'), JSON.stringify({ schema_version: 1, selected_scoring_ids: ['SCORE-1', 'SCORE-2'] }))
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'waiting_user' })
    const b = await fresh('session-b')
    expect((await ctx.bid.getTenderAnalysisForConfirmation(b.session)).project.project_name).toBe('项目 A')
    b.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'S2 原始评分含有已排除的 SC-009。' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }), { surfaceOp: 'append' })
    await ctx.bid.setTenderScoringSelection(b.session, 'SCORE-2', false)
    const selection = await ctx.bid.getTenderAnalysisForConfirmation((await fresh('session-selection')).session)
    expect(selection.selected_scoring_ids).toEqual(['SCORE-1'])
    await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({
      schema_version: 1, points: [{ scoring_id: 'SCORE-2', order: 1, text: '过期响应点' }],
    }))
    await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), '{}')
    const before = (await readBidProjectState(workspace))!.revision
    const s3Contexts: string[] = []
    executor.canExecute = stage => stage === 'outline_generation'
    executor.execute = vi.fn(async () => {
      const execution = ctx.agents.list().find(candidate => candidate.session.header.parentSession === b.id)
      if (execution === undefined) throw new Error('S3 execution lane 未创建')
      s3Contexts.push(JSON.stringify(execution.session.deriveMessages()))
      if (s3Contexts.length === 1) throw new Error('模拟 S3 模型失败')
      return []
    })
    const confirmation = await ctx.bid.confirmTenderAnalysis(b.session, [{ type: 'update_project', fields: { project_name: '项目 B' } }])
    expect(confirmation).toMatchObject({
      ok: true,
      value: { stage: 'outline_generation', status: 'suspended', run: { error: { message: '模拟 S3 模型失败' } } },
    })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8'))).toMatchObject({ project_name: '项目 B' })
    const unchangedOrigin = parseTenderScoringArtifact(JSON.parse(await readFile(scoringOriginPath, 'utf8')))
    const confirmedScoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
    expect(unchangedOrigin.scoring_items.map(item => item.id)).toEqual(['SCORE-1', 'SCORE-2'])
    expect(confirmedScoring.scoring_items.map(item => item.id)).toEqual(['SCORE-1'])
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(b.session.deriveMessages())).toContain('SC-009')
    expect(JSON.stringify(b.session.deriveMessages())).not.toContain('analysis/scoring.json')
    expect(JSON.stringify(b.session.events)).toContain('SC-009')
    expect(await resumeRun(ctx, b.session)).toMatchObject({ ok: true, value: { stage: 'outline_generation', status: 'waiting_user' } })
    expect(s3Contexts).toHaveLength(2)
    expect(s3Contexts.every(context => !context.includes('SC-009'))).toBe(true)
    expect(s3Contexts.some(context => context.includes('analysis/scoring.json'))).toBe(true)
    expect((await readBidProjectState(workspace))!.revision).toBeGreaterThan(before)
    expect(runtime(a.session)).toMatchObject({ stage: 'outline_generation', status: 'waiting_user' })
    const c = await fresh('session-c')
    expect(runtime(c.session)).toMatchObject({ stage: 'outline_generation', status: 'waiting_user' })
    expect((await ctx.bid.getDetails(c.session)).tender?.project.project_name).toBe('项目 B')
  })

  it('S5 失败后新 Session 继续读取已有正文和执行日志，并从 S5 retry', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    const failed = { stage: 'chapter_writing', status: 'failed', failureReason: '章节执行失败' } as const
    await checkpointBidProjectState(workspace, failed)
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toMatchObject({
      stage: 'chapter_writing', status: 'suspended', run: { error: { message: '章节执行失败' } },
    })
    expect(getBidClientProjection(b.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)).allowedActions).toContain('send_message')
    expect(await ctx.bid.getReviewWorkbench(b.session)).toMatchObject({ outline: [{ section_id: 'SEC-1', writing_status: 'completed', content_available: true }], summary: { content_count: 1 } })
    expect(await ctx.bid.getReviewChapter(b.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
    executor.canExecute = stage => stage === 'chapter_writing'
    expect(await resumeRun(ctx, b.session)).toMatchObject({ ok: true, value: { stage: 'chapter_writing', status: 'completed' } })
    expect(executor.execute.mock.calls[0]?.[0].stage).toBe('chapter_writing')
    expect(typeof executor.execute.mock.calls[0]?.[1].runId).toBe('string')
    expect(await readBidProjectState(workspace)).toMatchObject({ stage: 'chapter_writing', status: 'completed', run: null })
  }, 30000)

  it('S5 工作台投影已保存审核报告，并从失败执行记录读取章节原因', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await mkdir(join(workspace.projectRoot, 'chapters/reviews'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      schema_version: 8, section_id: 'SEC-1', verdict: 'repair', candidate_sha256: createHash('sha256').update('# 技术方案\n\n已有正文。\n').digest('hex'), writer_child_session_id: 'writer-a', reviewer_child_session_id: 'reviewer-a',
      must_answer_coverage: [{ item: '按期交付', status: 'missing', evidence_quotes: [], issue: '正文没有交付节点。' }],
      requirement_coverage: [{ requirement_id: 'REQ-1', item: '按期交付', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      response_point_coverage: [{ response_point_id: 'RP-000001', item: '说明技术方案', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      compliance_coverage: [],
      acceptance_criteria_results: [],
      global_compliance_checks: [],
      assignment_conflicts: [],
      external_input_gaps: [],
      claim_checks: [{ claim_quote: '按期交付', kind: 'commitment', status: 'unsupported', source_reference: null, issue: '未说明保障措施。' }],
      quality_checks: {
        bidder_response_voice: true,
        project_specific: false, structure_complete: true, legacy_project_pollution_free: true,
        placeholder_free: true, obvious_repetition_free: true,
      },
      blocking_issues: ['补充交付节点和保障措施。'],
    }))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('review-projection')
    const phaseLogPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const completedLog = await readFile(phaseLogPath, 'utf8')
    const setPhase = async (
      status: 'pending' | 'running' | 'failed',
      phase: 'queued' | 'writing' | 'reviewing' | 'repairing' | null,
      failurePhase: 'queued' | 'writing' | 'reviewing' | 'repairing' | 'blocked' | null,
    ): Promise<void> => {
      const executionLog = JSON.parse(await readFile(phaseLogPath, 'utf8')) as { sections: Array<Record<string, unknown>> }
      executionLog.sections[0] = { ...executionLog.sections[0]!, status, phase, failure_phase: failurePhase }
      await writeFile(phaseLogPath, `${JSON.stringify(executionLog)}\n`)
    }
    for (const [phase, status, tooltip] of [
      ['writing', 'writing', '正在编写'],
      ['repairing', 'repairing', '正在修复'],
      ['reviewing', 'reviewing', '正在审核'],
    ] as const) {
      await setPhase('running', phase, null)
      expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
        chapter_indicator: { status, tooltip },
      })
    }
    await setPhase('failed', null, 'repairing')
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      chapter_indicator: { status: 'failed', tooltip: '章节修复执行失败' },
    })
    await setPhase('failed', null, 'queued')
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      chapter_indicator: { status: 'failed', tooltip: '章节启动或调度失败' },
    })

    await setPhase('pending', 'queued', null)
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      chapter_indicator: { status: 'queued', tooltip: '等待执行' },
    })
    const queuedWithPass = JSON.parse(completedLog) as { sections: Array<Record<string, unknown>> }
    queuedWithPass.sections[0] = { ...queuedWithPass.sections[0]!, status: 'pending', phase: 'queued', failure_phase: null }
    await writeFile(phaseLogPath, `${JSON.stringify(queuedWithPass)}\n`)
    const queuedReview = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...queuedReview,
      verdict: 'pass',
    }))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      chapter_indicator: { status: 'queued', tooltip: '等待执行' },
    })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify(queuedReview))
    await setPhase('pending', 'queued', null)
    await rm(join(workspace.projectRoot, 'chapters/sections/0001.md'))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      chapter_indicator: { status: 'queued', tooltip: '等待执行' },
    })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n已有正文。\n')
    await writeFile(phaseLogPath, completedLog)

    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')),
      section_id: 'SEC-2',
    }))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      review_status: 'not_started', chapter_indicator: { status: 'content_ready', tooltip: '正文已编写，等待审核' },
    })
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toEqual({ status: 'not_started', issues: [] })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')),
      section_id: 'SEC-1',
    }))

    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({ review_status: 'needs_attention' })
    expect((await ctx.bid.getReviewWorkbench(agent.session)).summary).toMatchObject({ reviewed_count: 1, needs_attention_count: 1 })
    const chapterReview = (await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review
    expect(chapterReview?.status).toBe('needs_attention')
    expect(chapterReview?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'must_answer_coverage', detail: '正文没有交付节点。' }),
      expect.objectContaining({ category: 'claim_checks', detail: '按期交付：未说明保障措施。' }),
      expect.objectContaining({ category: 'quality_checks', detail: 'project_specific：false' }),
    ]))

    const repairReport = parseChapterReviewArtifact(JSON.parse(
      await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8'),
    ))
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...repairReport,
      verdict: 'attention',
      claim_checks: [],
      quality_checks: { ...repairReport.quality_checks, project_specific: true },
      blocking_issues: [],
      external_input_gaps: [{ item_ref: 'R1', required_material: '企业资质证书', reason: '当前项目资料未提供。' }],
    }))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      review_status: 'needs_input', chapter_indicator: { status: 'needs_input', tooltip: '缺少项目资料，正文无需重写' },
    })
    const externalReview = (await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review
    expect(externalReview.status).toBe('needs_input')
    expect(externalReview.issues.some(issue => issue.category === 'external_input_gaps'
      && issue.severity === 'medium' && issue.title === '待补项目资料：企业资质证书')).toBe(true)
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...repairReport,
      verdict: 'attention',
      must_answer_coverage: [{ item: '按期交付', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      claim_checks: [],
      quality_checks: { ...repairReport.quality_checks, project_specific: true },
      blocking_issues: [],
      assignment_conflicts: [{ task: '扩写商务资质', basis: '该任务不属于技术方案。', related_section_ids: ['SEC-1'] }],
      external_input_gaps: [],
    }))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({ review_status: 'needs_attention' })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify(repairReport))

    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n修订后的正文。\n')
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      review_status: 'not_started', chapter_indicator: { status: 'content_ready', tooltip: '正文已编写，等待审核' },
    })
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toEqual({ status: 'not_started', issues: [] })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n已有正文。\n')

    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = JSON.parse(await readFile(logPath, 'utf8')) as { sections: Array<Record<string, unknown>> }
    log.sections[0] = {
      ...log.sections[0], status: 'failed', phase: null, failure_phase: 'reviewing', attempts: [{
        role: 'reviewer', attempt: 1, child_session_id: 'reviewer-b', label: 'S5 审核',
        started_at: '2026-09-09T00:00:00.000Z', ended_at: '2026-09-09T00:00:01.000Z', stop_reason: 'error', accepted: false,
        issues: [{ code: 'CHAPTER_REVIEWER_STOP_REASON_INVALID', message: 'Chapter Reviewer 未正常完成：error。' }],
        input: { plan_version: 1, section_epoch: 0, dependencies: [] },
      }], final_writer_child_session_id: 'writer-a', final_reviewer_child_session_id: null,
    }
    await writeFile(logPath, `${JSON.stringify(log)}\n`)
    await rm(join(workspace.projectRoot, 'chapters/sections/0001.md'))

    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({
      writing_status: 'failed', review_status: 'failed', content_available: false,
      chapter_indicator: { status: 'failed', tooltip: '章节审核执行失败' },
    })
    expect((await ctx.bid.getReviewWorkbench(agent.session)).summary.needs_attention_count).toBe(1)
    const review = (await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review
    expect(review?.status).toBe('failed')
    expect(review?.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      source: 'review_execution', title: '章节审核执行失败', detail: 'Chapter Reviewer 未正常完成：error。',
    })]))
  }, 30000)

  it('S5 工作台将文档级缺口和递交待确认与章节状态分开投影', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const source = (JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as { requirements: Array<{ source_refs: unknown[] }> }).requirements[0]!.source_refs
    outline.global_compliance_ids = ['GLOBAL-CONTENT', 'GLOBAL-UPLOAD']
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline))
    await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [
      { id: 'GLOBAL-CONTENT', type: '材料', raw_text: '须包含资格材料', normalized_rule: '整份文档包含资格材料', severity: 'mandatory', source_refs: source },
      { id: 'GLOBAL-UPLOAD', type: '递交', raw_text: '截止前上传', normalized_rule: '截止前完成上传', severity: 'fatal', source_refs: source },
    ] }))
    const globalReport = {
      schema_version: 1, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), items: [
        { compliance_id: 'GLOBAL-CONTENT', item: '整份文档包含资格材料', category: 'document_requirement', owners: [{ kind: 'document' }], status: 'fail', checked_chapters: [], evidence: [], affected_section_ids: ['SEC-1'], issue: '缺少资格材料。' },
        { compliance_id: 'GLOBAL-UPLOAD', item: '截止前完成上传', category: 'delivery_requirement', owners: [{ kind: 'delivery' }], status: 'pending', checked_chapters: [], evidence: [], affected_section_ids: [], issue: '缺少实际上传执行证据。' },
      ],
    } as const
    await writeFile(join(workspace.projectRoot, 'chapters/global-compliance-review.json'), JSON.stringify(globalReport))
    expect(validateGlobalComplianceReview(
      parseGlobalComplianceReviewArtifact(globalReport), outline,
      parseTenderComplianceArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/compliance.json'), 'utf8'))),
      [{ section_id: 'SEC-1', title: '技术方案', markdown: '# 技术方案\n\n已有正文。\n', candidate_sha256: createHash('sha256').update('# 技术方案\n\n已有正文。\n').digest('hex') }],
      await workspace.readManifest(),
    )).toEqual([])
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('global-review-projection')
    const view = await ctx.bid.getReviewWorkbench(agent.session)
    expect(view.summary.needs_attention_count).toBe(0)
    expect(view.global_compliance).toEqual({
      status: 'needs_attention', reviewed_count: 2, total_count: 2,
      document_issues: [{ compliance_id: 'GLOBAL-CONTENT', status: 'fail', detail: '缺少资格材料。', affected_section_ids: ['SEC-1'] }],
      delivery_todos: [{ compliance_id: 'GLOBAL-UPLOAD', status: 'pending', detail: '缺少实际上传执行证据。', affected_section_ids: [] }],
    })
  }, 30000)

  it('各级父节点从确认目录读取概述，不计入叶节写作和审查进度', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const leaf = outline.sections[0]!
    outline.sections = [
      { ...leaf, id: 'ROOT', title: '项目实施', writable: false, must_answer: [], summary: '本章介绍实施安排及具体技术方案。' },
      { ...leaf, id: 'BRANCH', parent_id: 'ROOT', level: 2, title: '实施安排', writable: false, must_answer: [], summary: '本节概括技术方案的主要内容。' },
      { ...leaf, parent_id: 'BRANCH', level: 3 },
    ]
    const outlinePath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
    await writeFile(outlinePath, JSON.stringify(outline))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('branch-summary')
    const workbench = await ctx.bid.getReviewWorkbench(agent.session)
    expect(workbench).toMatchObject({
      outline: [
        { section_id: 'ROOT', content_available: true },
        { section_id: 'BRANCH', content_available: true },
        { section_id: 'SEC-1', content_available: true },
      ],
      summary: { chapter_count: 1, content_count: 1, reviewed_count: 0 },
    })
    expect(workbench.summary.page_estimate.status).toBe('available')
    if (workbench.summary.page_estimate.status === 'available') expect(typeof workbench.summary.page_estimate.pages).toBe('number')
    const rootEstimate = workbench.outline.find(section => section.section_id === 'ROOT')?.page_estimate
    expect(rootEstimate?.status).toBe('available')
    if (rootEstimate?.status === 'available') expect(typeof rootEstimate.pages).toBe('number')
    for (const [sectionId, number, summary] of [
      ['ROOT', '1', '本章介绍实施安排及具体技术方案。'],
      ['BRANCH', '1.1', '本节概括技术方案的主要内容。'],
    ] as const) {
      expect(await ctx.bid.getReviewChapter(agent.session, sectionId)).toMatchObject({
        number, writable: false, markdown: summary, content_sha256: null, evidence_status: 'not_applicable',
      })
    }
    expect(await ctx.bid.getReviewChapter(agent.session, leaf.id)).toMatchObject({ number: '1.1.1', writable: true, markdown: '# 技术方案\n\n已有正文。\n' })
    delete outline.sections[0]!.summary
    await writeFile(outlinePath, JSON.stringify(outline))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]?.content_available).toBe(false)
    expect((await ctx.bid.getReviewChapter(agent.session, 'ROOT')).markdown).toBeNull()
  }, 30000)

  it('页数估算失败不阻塞正文工作台读取', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '![远程图](https://example.com/image.png)')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('page-estimate-failure')
    const workbench = await ctx.bid.getReviewWorkbench(agent.session)
    expect(workbench.summary.page_estimate).toEqual({ status: 'unavailable' })
    expect(await ctx.bid.estimateDocxPages(agent.session, null)).toEqual({
      status: 'unavailable', basis: { source: 'default', method: 'fast', template: null },
    })
    expect(await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).toMatchObject({ markdown: '![远程图](https://example.com/image.png)' })
  })

  it('getReviewWorkbench 出现新 schema warning 时持久化 flush 且多次调用不重复 flush', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('schema-warning-flush')

    const flushSpy = vi.spyOn(ctx.sessions, 'flush')
    await ctx.bid.getReviewWorkbench(agent.session)
    expect(flushSpy).not.toHaveBeenCalled()

    const outlinePath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
    await writeFile(outlinePath, JSON.stringify({ ...outline, schema_version: 999 }))

    await ctx.bid.getReviewWorkbench(agent.session)
    expect(flushSpy).toHaveBeenCalledTimes(1)

    await ctx.bid.getReviewWorkbench(agent.session)
    expect(flushSpy).toHaveBeenCalledTimes(1)
  }, 20000)

  it('旧 S6 已完成项目仍保留审核工作台和按需导出动作', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'docx_export', status: 'completed' })
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toMatchObject({ stage: 'docx_export', status: 'completed' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toEqual(['send_message', 'export_docx', 'revise_chapter'])
    expect(await ctx.bid.exportDocx(b.session, null)).toMatchObject({ ok: true })
    expect(runtime(b.session)).toMatchObject({ stage: 'docx_export', status: 'completed' })
  })

  it('S5 完成后可重复导出独立 Word 文件且不改变审核阶段', async () => {
    const { ctx, workspace, fresh, host } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('session-export')
    const projectBefore = await readBidProjectState(workspace)
    const stageReservation = vi.spyOn(host.inFlight, 'set')

    const first = await ctx.bid.exportDocx(agent.session, null)
    const second = await ctx.bid.exportDocx(agent.session, null)

    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true })
    if (!first.ok || !second.ok) throw new Error('DOCX export failed')
    expect(first.value.path).toMatch(/^output\/bid-\d+-[a-f0-9]{6}\.docx$/u)
    expect(second.value.path).not.toBe(first.value.path)
    const source = await readFile(join(workspace.projectRoot, first.value.path.replace(/\.docx$/u, '.md')))
    expect(first.value.warnings?.find(warning => warning.code === 'DOCX_EXPORT_CONTENT_SNAPSHOT')?.message)
      .toContain(createHash('sha256').update(source).digest('hex').slice(0, 12))
    expect((await readFile(join(workspace.projectRoot, first.value.path))).readUInt32LE(0)).toBe(0x04034b50)
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
    const exportEvents = agent.session.events.filter(event => event.type === 'bid.docx_export.changed')
    expect(exportEvents.map(event => event.data.operation.status)).toEqual([
      'running', 'running', 'running', 'completed',
      'running', 'running', 'running', 'completed',
    ])
    expect(exportEvents[3]?.data.operation).toMatchObject({ phase: 'finalizing', path: first.value.path })
    expect(exportEvents[7]?.data.operation).toMatchObject({ phase: 'finalizing', path: second.value.path })
    expect(await readBidProjectState(workspace)).toEqual(projectBefore)
    expect(stageReservation).not.toHaveBeenCalled()
  })

  it('公共 docx.export 能力调用独立导出，重放同一用户消息不重复生成', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-docx-export')
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '导出 Word' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const execute = () => ctx.tools.execute({ agent, name: 'bid_run_task', arguments: { task: {
      goal: '导出当前 Word', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
        call: { capability: 'docx.export', input: { template_id: null } } }],
    } }, callId: CallId('capability-docx-export'), signal: new AbortController().signal })
    const first = await execute()
    const second = await execute()
    expect(first.isError, JSON.stringify(first)).toBe(false)
    expect(second.value).toMatchObject({ export_path: (first.value as { export_path: string }).export_path })
    expect(agent.session.events.filter(event => event.type === 'bid.docx_export.changed'
      && event.data.operation.status === 'completed')).toHaveLength(1)
  }, 20_000)

  it('同一句修改并导出先提交能力 Work，再取独立 Word 快照', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedCapabilityProject(workspace, 'complete')
    const firstBodyPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
    await writeFile(firstBodyPath, '# 章节1\n\n实施范围与交付步骤。\n')
    const firstMetadataPath = join(workspace.projectRoot, 'chapters/meta/0001.json')
    const firstMetadata = JSON.parse(await readFile(firstMetadataPath, 'utf8')) as Record<string, unknown>
    await writeFile(firstMetadataPath, JSON.stringify({ ...firstMetadata, flowcharts: [] }))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('capability-update-export')
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '更正要求并导出' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const result = await ctx.tools.execute({ agent, name: 'bid_run_task', arguments: { task: {
      goal: '更正要求并导出', scope: { kind: 'project' }, steps: [
        { scope: { source: 'task' }, call: { capability: 'tender.update', input: {
          operations: [{ type: 'update_requirement', requirement_id: 'REQ-1',
            fields: { normalized_requirement: '交付范围包含测试' } }],
        } } },
        { scope: { source: 'task' }, call: { capability: 'docx.export', input: { template_id: null } } },
      ],
    } }, callId: CallId('capability-update-export'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    const value = result.value as { changed_artifacts: string[]; export_path: string }
    expect(value.changed_artifacts).toContain('analysis/requirements.json')
    expect((await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')))
      .toContain('交付范围包含测试')
    expect((await readFile(join(workspace.projectRoot, value.export_path))).readUInt32LE(0)).toBe(0x04034b50)
    expect(agent.session.events.findLast(event => event.type === 'bid.docx_export.changed')?.data.operation)
      .toMatchObject({ status: 'completed', path: value.export_path })
  }, 30_000)

  it('同会话并发点击共享当前导出，刷新时投影保持同一个任务', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('concurrent-export')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = BidWorkspace.prototype.exportDocxMarkdown
    const render = vi.spyOn(BidWorkspace.prototype, 'exportDocxMarkdown').mockImplementation(async function (this: BidWorkspace, ...args) {
      entered.resolve(undefined)
      await release.promise
      return original.apply(this, args)
    })
    try {
      const first = ctx.bid.exportDocx(agent.session, null)
      await entered.promise
      const running = agent.session.events.findLast(event => event.type === 'bid.docx_export.changed')
      expect(running?.data.operation).toMatchObject({ status: 'running', phase: 'exporting' })
      const second = ctx.bid.exportDocx(agent.session, null)
      expect(agent.session.events.filter(event => event.type === 'bid.docx_export.changed')).toHaveLength(2)
      release.resolve(undefined)
      const [a, b] = await Promise.all([first, second])
      expect(a).toEqual(b)
      expect(render).toHaveBeenCalledOnce()
      expect(agent.session.events.findLast(event => event.type === 'bid.docx_export.changed')?.data.operation)
        .toMatchObject({ status: 'completed' })
    } finally { release.resolve(undefined); render.mockRestore() }
  })

  it('导出校验返回拒绝时发布失败态，宿主恢复时结算遗留运行态', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('failed-export')
    const render = vi.spyOn(BidWorkspace.prototype, 'exportDocxMarkdown').mockResolvedValue('output/missing.docx')
    try {
      const result = await ctx.bid.exportDocx(agent.session, null)
      expect(result).toMatchObject({ ok: false, error: { code: 'BID_DOCX_EXPORT_FAILED' } })
      expect(agent.session.events.findLast(event => event.type === 'bid.docx_export.changed')?.data.operation)
        .toMatchObject({ status: 'failed', phase: 'finalizing', error: '生成的 Word 文件结构无效。' })
    } finally { render.mockRestore() }

    agent.session.append('bid.docx_export.changed', { operation: {
      operationId: 'interrupted-export', templateId: null, startedAt: 1, updatedAt: 2,
      status: 'running', phase: 'exporting', message: '正在生成 Word',
    } })
    await ctx.bid.getDetails(agent.session)
    expect(agent.session.events.findLast(event => event.type === 'bid.docx_export.changed')?.data.operation)
      .toMatchObject({ operationId: 'interrupted-export', status: 'failed', error: '宿主进程已重启，Word 导出未完成，请重试。' })
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
  })

  it('Word 操作与 S5 启动及运行并行，同项目其他会话可配置和导出', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await rm(join(workspace.projectRoot, 'chapters/manifest.json'))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('running-partial-export')
    const gate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'chapter_writing'
    executeStage.mockImplementationOnce(() => gate.promise)
    const key = process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root
    host.docxInFlight.add(key)
    const retry = resumeRun(ctx, agent.session)
    try {
      await vi.waitFor(() => {
        expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
        expect(executeStage).toHaveBeenCalledOnce()
      })
      const active = host.inFlight.get(key)
      await expect(ctx.bid.resetStage(agent, 'chapter_writing'))
        .rejects.toMatchObject({ code: 'BID_OPERATION_IN_PROGRESS' })
      expect(host.inFlight.get(key)).toBe(active)
      expect(active).toMatchObject({ controller: { signal: { aborted: false } } })
    } finally { host.docxInFlight.delete(key) }
    await vi.waitFor(() => {
      expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
      expect(host.inFlight.size).toBe(1)
    })

    expect(getBidClientProjection(runtime(agent.session)).allowedActions).toContain('export_docx')
    const preview = await ctx.bid.previewDocx(agent.session, null)
    expect(typeof preview.previewHtml).toBe('string')
    const format = await ctx.bid.saveDocxFormat(agent.session, null, { revision: 0, userConfirmed: {} })
    expect(format.state.revision).toBe(1)
    expect(host.inFlight.size).toBe(1)
    host.docxInFlight.add(key)
    try {
      await expect(ctx.bid.saveDocxFormat(agent.session, null, { revision: 1, userConfirmed: {} }))
        .rejects.toMatchObject({ code: 'BID_OPERATION_IN_PROGRESS' })
    } finally { host.docxInFlight.delete(key) }
    const other = await fresh('running-partial-export-other', workspace.root, false)
    const projectBefore = await readBidProjectState(workspace)
    await expect(ctx.bid.saveDocxFormat(other.session, null, { revision: 1, userConfirmed: {} }))
      .resolves.toMatchObject({ state: { revision: 2 } })
    await expect(ctx.bid.saveDocxFormat(agent.session, null, { revision: 1, userConfirmed: {} }))
      .rejects.toThrow('配置已在其他页面修改')
    expect((await ctx.bid.previewDocx(other.session, null)).previewHtml).toBeTypeOf('string')
    const exported = await ctx.bid.exportDocx(other.session, null)

    if (!exported.ok) throw new Error('Partial DOCX export failed')
    expect(exported.value.path).toMatch(/^output\/bid-\d+-[a-f0-9]{6}\.docx$/u)
    expect(exported.value.warnings?.map(warning => warning.code)).toContain('DOCX_EXPORT_CONTENT_SNAPSHOT')
    expect(await readFile(join(workspace.projectRoot, exported.value.path.replace(/\.docx$/u, '.md')), 'utf8')).toContain('已有正文')
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
    expect(host.inFlight.size).toBe(1)
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
    expect(await readBidProjectState(workspace)).toEqual(projectBefore)
    gate.resolve([])
    await retry
  })

  it('S5 运行中固定技术偏离表未完成时清空预置行并导出后续正文', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const technical = {
      ...outline.sections[0]!,
      id: TECHNICAL_DEVIATION_SECTION_ID,
      order: 1,
      title: '技术偏离表',
      requirement_ids: [],
      scoring_ids: [],
      scoring_response_point_ids: [],
      scoring_response_points: [],
    }
    const nextOutline = { ...outline, sections: [technical, { ...outline.sections[0]!, order: 2 }] }
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(nextOutline))
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), '技术偏离表尚未完成。')
    await mkdir(join(workspace.projectRoot, 'chapters/meta'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/meta/0002.json'), JSON.stringify({
      section_id: TECHNICAL_DEVIATION_SECTION_ID, covered_must_answer: [], covered_scoring_response_point_ids: [],
      covered_scoring_response_points: [], local_materials_used: [], web_materials_used: [], unresolved_topics: [],
      handoff: { section_id: TECHNICAL_DEVIATION_SECTION_ID, decisions: [], terminology: [], numbers_and_parameters: [],
        interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] },
    }))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'running' })
    const agent = await fresh('partial-technical-deviation')

    const exported = await ctx.bid.exportDocx(agent.session, null)

    expect(exported).toMatchObject({ ok: true })
    if (!exported.ok) throw new Error('阶段性 Word 导出失败')
    expect(exported.value.warnings?.map(warning => warning.code)).toContain('DOCX_EXPORT_TECHNICAL_DEVIATION_PENDING')
    const bytes = await readFile(join(workspace.projectRoot, exported.value.path))
    const document = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
    const table = document.match(/<w:tbl>[^]*?dsh-technical-deviation-table[^]*?<\/w:tbl>/u)?.[0] ?? ''
    expect(table.match(/<w:tr(?:\s[^>]*)?>[^]*?<\/w:tr>/gu)).toHaveLength(1)
    expect(table).not.toContain('满足、响应')
    expect(document).toContain('已有正文')
    expect(document).not.toContain('BID_DOCX_TECHNICAL_DEVIATION_SOURCE_MISSING')
  })

  it('阶段重置等待执行器结束期间拒绝 Word 写入，重置结束后恢复', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('reset-with-word')
    const gate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'chapter_writing'
    executeStage.mockImplementationOnce(() => gate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(executeStage).toHaveBeenCalledOnce() })
    const reset = ctx.bid.resetStage(agent, 'chapter_writing')
    try {
      expect(host.inFlight.values().next().value).toMatchObject({ reservedForReset: true })
      await expect(ctx.bid.saveDocxFormat(agent.session, null, { revision: 0, userConfirmed: {} }))
        .rejects.toThrow('当前项目正在重置阶段')
      const exported = await ctx.bid.exportDocx(agent.session, null)
      expect(exported.ok).toBe(false)
      if (exported.ok) throw new Error('重置期间不能导出')
      expect(exported.error.message).toContain('当前项目正在重置阶段')
    } finally { gate.resolve([]); await retry; await reset }
    await expect(ctx.bid.saveDocxFormat(agent.session, null, { revision: 0, userConfirmed: {} }))
      .resolves.toMatchObject({ state: { revision: 1 } })
  })

  it('S5 失败且章节回到待执行时仍导出已保存正文，保持失败态', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await rm(join(workspace.projectRoot, 'chapters/manifest.json'))
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    for (const section of log.sections) {
      section.status = 'pending'
      section.phase = 'queued'
      section.failure_phase = null
      section.final_writer_child_session_id = null
      section.final_reviewer_child_session_id = null
    }
    await writeFile(logPath, JSON.stringify(log))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed', failureReason: '部分章节失败' })
    const agent = await fresh('failed-partial-export')

    const exported = await ctx.bid.exportDocx(agent.session, null)

    expect(exported).toMatchObject({ ok: true })
    if (!exported.ok) throw new Error('已有正文应可导出')
    expect(exported.value.warnings?.map(warning => warning.code)).toContain('DOCX_EXPORT_CONTENT_SNAPSHOT')
    expect(await readFile(join(workspace.projectRoot, exported.value.path.replace(/\.docx$/u, '.md')), 'utf8')).toContain('已有正文。')
    expect(runtime(agent.session)).toMatchObject({
      stage: 'chapter_writing', status: 'suspended', run: { error: { message: '部分章节失败' } },
    })
    expect(await readBidProjectState(workspace)).toMatchObject({
      stage: 'chapter_writing', status: 'suspended', run: { error: { message: '部分章节失败' } },
    })
  })

  it('S5 完成后普通消息保持完成态，由主 Agent 判断是否需要调整计划', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('writing-plan-update')

    await expect(ctx.serial('session/prompt-admission', {
      session: agent.session,
      mode: 'queue',
      content: [{ type: 'text', text: '为什么第二章这样安排？' }],
    })).resolves.toBeUndefined()

    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
    expect(await readBidProjectState(workspace)).toMatchObject({ stage: 'chapter_writing', status: 'completed', run: null })
    await expect(readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).resolves.toContain('已有正文')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('多轮用户原话通过稳定引用共同进入一个 Task Contract patch', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('multi-turn-contract')
    for (const content of ['第二章写详细一点。', '对，其他章节不用动。']) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: content }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const inspected = await ctx.tools.execute({
      agent, name: 'bid_stage_inspect', arguments: { view: 'task_contract_context' },
      callId: CallId('multi-turn-inspect'), signal: new AbortController().signal,
    })
    expect(inspected.isError).toBe(false)
    const refs = (inspected.value as { task_contract_context: { user_messages: Array<{ ref: object; text: string }> } })
      .task_contract_context.user_messages
    expect(refs.map(item => item.text)).toEqual(['第二章写详细一点。', '对，其他章节不用动。'])

    const committed = await ctx.tools.execute({
      agent, name: 'bid_confirm_writing_plan', arguments: {
        update_kind: 'patch', base_plan_version: 1,
        user_message_refs: refs.map(item => item.ref), summary: '只细化现有技术方案章节。',
        affected_section_ids: [],
        sections: [{
          section_id: 'SEC-1', task: '详细完成技术方案。',
          add_user_message_refs: refs.map(item => item.ref),
        }],
      },
      callId: CallId('multi-turn-commit'), signal: new AbortController().signal,
    })
    expect(committed.isError, JSON.stringify(committed)).toBe(false)
    expect(committed.value).toMatchObject({ ok: true, plan_version: 2 })
    const plan = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')) as {
      user_requirements: string[]
      sections: Array<{ user_requirements: string[] }>
      revision: { affected_section_ids: string[] }
    }
    expect(plan.user_requirements).toEqual(['没有特殊要求，直接开始'])
    expect(plan.sections[0]?.user_requirements).toEqual(['第二章写详细一点。', '对，其他章节不用动。'])
    expect(plan.revision.affected_section_ids).toEqual(['SEC-1'])
  })

  it('S5 完成且无运行操作时通过真实工具读取任务上下文，不重开写作', async () => {
    const { ctx, workspace, fresh, host, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('completed-inspect')

    const result = await ctx.tools.execute({
      agent,
      name: 'bid_stage_inspect',
      arguments: { view: 'task_contract_context' },
      callId: CallId('completed-inspect'),
      signal: new AbortController().signal,
    })

    expect(result, JSON.stringify(result)).toMatchObject({
      isError: false,
      value: {
        task: { stage: 'chapter_writing', status: 'completed', run: null },
        task_contract_context: {
          requirements: { requirements: [{ id: 'REQ-1' }] },
          evidence: { section_mappings: [{ section_id: 'SEC-1' }] },
        },
      },
    })
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
    expect(host.inFlight.size).toBe(0)
    expect(executeStage).not.toHaveBeenCalled()
  })

  it('S5 运行中主 Agent 回答普通消息且不取消当前写作', async () => {
    const { ctx, workspace, fresh, host, executor, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('writing-plan-pause')
    const gate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'chapter_writing'
    vi.mocked(executor.execute).mockImplementationOnce(() => gate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => {
      expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
      expect(host.inFlight.size).toBe(1)
    })

    for (const [question, response] of [
      ['现在写到哪了？', '正文仍在写作，当前任务继续运行。'],
      ['这一章大概多少页？', '页数估算可从当前项目快照读取。'],
      ['为什么这个章节这么慢？', '当前章节仍在执行审核步骤。'],
    ] as const) {
      await expect(ctx.serial('session/prompt-admission', {
        session: agent.session,
        mode: 'steer',
        content: [{ type: 'text', text: question }],
      })).resolves.toBeUndefined()
      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer(response))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(agent.session.deriveMessages().at(-1)?.content).toContainEqual({ type: 'text', text: response })
    }

    expect(adapter.script).toEqual([])
    expect(agent.session.events.some(event => event.type === 'tool/call' && event.data.name === 'bid_stage_inspect')).toBe(true)
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
    expect(host.inFlight.size).toBe(1)
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })

    const replyErrors: unknown[] = []
    const stopErrorCapture = ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) replyErrors.push(error)
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '模拟一次聊天服务失败' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    stopErrorCapture()
    expect(replyErrors).toHaveLength(1)
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
    gate.resolve([])
    await retry

    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
    expect(agent.session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'chapter_writing')).toBe(true)
    await expect(readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('S4 未完成时 steer 在主聊天后续 step 接收且不取消运行', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('steer-during-s4')
    const suspended = await readBidProjectState(workspace)
    if (suspended?.status !== 'suspended') throw new Error('测试项目没有挂起 S4 Run')

    const stageGate = Promise.withResolvers<never[]>()
    void stageGate.promise.catch(() => {})
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => {
      expect(host.inFlight.size).toBe(1)
      expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'running' })
    })
    const beforeSteer = await readBidProjectState(workspace)
    if (beforeSteer?.status !== 'running') throw new Error('S4 Run 未进入运行态')
    const active = host.inFlight.values().next().value as { controller: AbortController }
    const requestStarted = Promise.withResolvers<undefined>()
    const releaseChatStep = Promise.withResolvers<undefined>()
    adapter.onRequest = () => { requestStarted.resolve(undefined) }
    adapter.requestGate = releaseChatStep.promise
    adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('已在后续步骤接收插话。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '先开始多步检查。' }], source: { kind: 'user' } }))
    await requestStarted.promise

    const cancelEvents: unknown[] = []
    const stopCancelCapture = ctx.on('agent/cancel-requested', (payload) => {
      if (payload.agent === agent) cancelEvents.push(payload)
    })
    const admission = await ctx.serial('session/prompt-admission', {
      session: agent.session,
      mode: 'steer',
      content: [{ type: 'text', text: '这条插话应在下一步接收。' }],
    })
    expect(admission).toBeUndefined()
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: '这条插话应在下一步接收。' }],
      source: { kind: 'user' },
    }))
    expect(cancelEvents).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'bid.run.cancelling')).toBe(false)

    releaseChatStep.resolve(undefined)
    await agent.whenIdle()
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('这条插话应在下一步接收。')
    expect(adapter.script).toEqual([])
    const duringSteer = await readBidProjectState(workspace)
    expect(duringSteer?.run).toMatchObject({
      runId: beforeSteer.run.runId,
      work: { workId: beforeSteer.run.work.workId },
    })
    expect(duringSteer?.status).toBe('running')
    expect(executeStage).toHaveBeenCalledOnce()
    expect(active.controller.signal.aborted).toBe(false)

    expect(agent.session.events.some(event => event.type === 'bid.run.cancelling')).toBe(false)
    expect(cancelEvents).toHaveLength(0)
    stopCancelCapture()
    stageGate.resolve([])
    await retry
  })

  it.each(['tender_analysis', 'outline_generation'] as const)(
    '%s 运行任务未完成时任一项目聊天 Session 都能立即回答',
    async (stage: BidStage) => {
      const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
      await seedProjectArtifacts(workspace)
      await checkpointBidProjectState(workspace, { stage, status: 'failed' })
      const agent = await fresh(`live-${stage}`)
      const gate = Promise.withResolvers<never[]>()
      executor.canExecute = candidate => candidate === stage
      executeStage.mockImplementationOnce((_task, run) => {
        run.reportProgress({
          phase: 'validating', summary: `${stage} 正在校验阶段结果`, completed: 2, total: 5,
          details: ['已完成真实里程碑'],
        })
        return gate.promise
      })
      const retry = resumeRun(ctx, agent.session)
      await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ stage, status: 'running' }) })
      await vi.waitFor(() => { expect(executeStage).toHaveBeenCalledOnce() })
      const artifactBefore = await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
      const projectBefore = await readBidProjectState(workspace)
      const inspection = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'summary' },
        callId: CallId(`live-${stage}-progress`),
        signal: new AbortController().signal,
      })
      if (inspection.isError) throw new Error(JSON.stringify(inspection))
      expect(inspection.value).toMatchObject({
        run_progress: {
          phase: 'validating', summary: `${stage} 正在校验阶段结果`, completed: 2, total: 5,
          details: ['已完成真实里程碑'],
        },
      })

      await expect(ctx.serial('session/prompt-admission', {
        session: agent.session, mode: 'steer', content: [{ type: 'text', text: '现在做到哪了？' }],
      })).resolves.toBeUndefined()
      const other = await fresh(`other-${stage}`, workspace.root, false)
      await expect(ctx.serial('session/prompt-admission', {
        session: other.session, mode: 'steer', content: [{ type: 'text', text: '查看进度' }],
      })).resolves.toBeUndefined()

      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('当前阶段仍在执行，后台任务未停止。'))
      agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在做到哪了？' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('另一个聊天也能读取同一项目进度。'))
      other.steer(createUserMessage({ content: [{ type: 'text', text: '查看进度' }], source: { kind: 'user' } }))
      await other.whenIdle()

      expect(agent.session.deriveMessages().at(-1)?.content)
        .toContainEqual({ type: 'text', text: '当前阶段仍在执行，后台任务未停止。' })
      expect(other.session.deriveMessages().at(-1)?.content)
        .toContainEqual({ type: 'text', text: '另一个聊天也能读取同一项目进度。' })
      const request = adapter.requests.findLast(candidate => String(candidate.sessionId) === String(agent.id))
      const requestText = request?.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(requestText).toContain(`摘要：${stage} 正在校验阶段结果`)
      expect(requestText).toContain('完成量：2 / 5')
      expect(requestText).toContain('补充：已完成真实里程碑')
      expect(runtime(agent.session)).toMatchObject({ stage, status: 'running' })
      expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
      expect(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')).toBe(artifactBefore)
      expect(await readBidProjectState(workspace)).toEqual(projectBefore)
      gate.resolve([])
      await retry
    },
  )

  it('暂停阶段只拦住 operation 调度门，继续不取消当前任务', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'failed' })
    const agent = await fresh('pause-stage-scheduling')
    const tenderArtifacts = buildBidStageTask('tender_analysis').requiredArtifacts.map((path, index) => ({
      stage: 'tender_analysis' as const, type: `artifact-${String(index)}`, path,
    }))
    const tenderGate = Promise.withResolvers<typeof tenderArtifacts>()
    executor.canExecute = stage => stage === 'tender_analysis'
    executeStage.mockImplementationOnce(() => tenderGate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ stage: 'tender_analysis', status: 'running' }) })

    adapter.script.push(toolCall('bid_pause_stage', {}), answer('已暂停后续任务调度；当前任务继续安全收敛。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '暂停当前阶段' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const active = host.inFlight.values().next().value as {
      controller: AbortController
      stageControl: {
        paused(): boolean
        waitUntilRunnable(signal: AbortSignal): Promise<void>
      }
    }
    expect(active.stageControl.paused()).toBe(true)
    expect(active.controller.signal.aborted).toBe(false)
    let laterTaskAdmitted = false
    const laterTask = active.stageControl.waitUntilRunnable(active.controller.signal).then(() => { laterTaskAdmitted = true })
    await Promise.resolve()
    expect(laterTaskAdmitted).toBe(false)

    adapter.script.push(toolCall('bid_resume_stage', {}), answer('已继续当前阶段。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await laterTask
    expect(laterTaskAdmitted).toBe(true)
    expect(active.stageControl.paused()).toBe(false)
    tenderGate.resolve(tenderArtifacts)
    const retryResult = await retry
    expect(retryResult).toMatchObject({ ok: true, value: { stage: 'tender_analysis', status: 'waiting_user' } })
    expect(executeStage.mock.calls).toHaveLength(1)
    expect(active.controller.signal.aborted).toBe(false)
  })

  it('阶段失败且未登记 continuable 子代理时不执行子代理回收', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('resume-child-cleanup')
    const drainChildren = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
    const drainDescendants = vi.spyOn(ctx.subagents, 'drainContinuableDescendants')
    executor.canExecute = stage => stage === 'evidence_mapping'
    executor.execute.mockRejectedValueOnce(new Error('mapping transport failed'))

    await expect(resumeRun(ctx, agent.session)).resolves.toMatchObject({ ok: true })
    expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'suspended' })
    expect(drainChildren).not.toHaveBeenCalled()
    expect(drainDescendants).not.toHaveBeenCalled()
  })

  it('S4 Mapping Child 未完成时 Main Agent 先回复，Child 与阶段随后继续', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('live-evidence-child')
    const childReady = Promise.withResolvers<SessionId>()
    const childStarted = Promise.withResolvers<undefined>()
    const releaseChild = Promise.withResolvers<undefined>()
    adapter.childGate = releaseChild.promise
    adapter.onChildRequest = () => { childStarted.resolve(undefined) }
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(async () => {
      const operation = host.inFlight.values().next().value as { controller: AbortController }
      const run = await ctx.subagents.start('spawn', {
        parent: agent,
        prompt: [{ type: 'text', text: '执行 S4 Mapping 子任务。' }],
        signal: operation.controller.signal,
      })
      childReady.resolve(run.id)
      try {
        await run.result
        return []
      } finally {
        await run.dispose()
      }
    })
    const retry = resumeRun(ctx, agent.session)
    try {
      const childId = await childReady.promise
      await childStarted.promise
      expect(ctx.agents.get(childId)).toBeDefined()

      const inspection = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'summary' },
        callId: CallId('live-evidence-inspect'),
        signal: new AbortController().signal,
      })
      if (inspection.isError) throw new Error(JSON.stringify(inspection))
      expect(JSON.parse(JSON.stringify(inspection.value))).toEqual(inspection.value)

      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('Mapping Child 仍在后台执行。'))
      agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在查到哪里了？' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(agent.session.deriveMessages().at(-1)?.content)
        .toContainEqual({ type: 'text', text: 'Mapping Child 仍在后台执行。' })
      expect(ctx.agents.get(childId)).toBeDefined()
      expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'running' })
      expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
      releaseChild.resolve(undefined)
      await retry
      expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'waiting_user' })
    } finally {
      releaseChild.resolve(undefined)
    }
  })

  it('S2 Execution 接收 Child 报告，挂起后 Main Agent 读取 Host 错误摘要', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'failed' })
    const agent = await fresh('quiet-host-child-report')
    const stageGate = Promise.withResolvers<never[]>()
    void stageGate.promise.catch(() => {})
    executor.canExecute = stage => stage === 'tender_analysis'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ stage: 'tender_analysis', status: 'running' }) })

    const operation = host.inFlight.values().next().value as { executionHandle?: { agent: Agent } }
    const execution = operation.executionHandle?.agent
    if (execution === undefined) throw new Error('测试未找到 Execution Agent')
    adapter.script.push(
      answer('Execution 已接收 Child 报告。'),
      answer('Execution 已接收 Child 结算。'),
    )
    execution.followup(createUserMessage({
      content: [{ type: 'text', text: 'S2 Child 返回了中间分析。' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('analysis-child') },
    }))
    await execution.whenIdle()
    execution.followup(createUserMessage({
      content: [{ type: 'text', text: 'S2 Child 已完成。' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'analysis-child completed',
        senderSessionId: SessionId('analysis-child'),
      },
    }))
    await execution.whenIdle()

    const executionSources = adapter.requests.filter(request => String(request.sessionId) === String(execution.id))
      .flatMap(request => request.messages.map(message => message.source.kind))
    expect(executionSources).toContain('subagent-report')
    expect(executionSources).toContain('subagent-settled')

    for (let index = 0; index < 8; index++) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `普通 Child 进度 ${String(index + 1)}` }],
        source: index === 7
          ? {
            kind: 'subagent-settled',
            form: 'notice',
            summary: 'analysis-child-8 completed',
            senderSessionId: SessionId('analysis-child-8'),
          }
          : { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId(`analysis-child-${String(index + 1)}`) },
      }))
    }
    await agent.whenIdle()
    expect(adapter.requests.filter(request => String(request.sessionId) === String(agent.id))).toHaveLength(0)

    stageGate.reject(new BidStageExecutionError([
      { code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', message: '招标分析缺少必需记录。' },
      { code: 'SECOND_ISSUE', message: '第二条关键问题。' },
      { code: 'THIRD_ISSUE', message: '第三条关键问题。' },
      { code: 'FOURTH_ISSUE', message: '这条不应进入 Main Agent 摘要。' },
    ]))
    await expect(retry).resolves.toMatchObject({ ok: true, value: {
      stage: 'tender_analysis', status: 'suspended',
    } })
    expect(agent.session.events.find(event => event.type === 'bid.run.notice')).toMatchObject({
      data: { stage: 'tender_analysis', kind: 'interrupted', severity: 'error' },
    })
    expect(ctx.sessionProjections.snapshot(agent.session).values['bid.runtime']).toMatchObject({
      task: { stage: 'tender_analysis', status: 'suspended' },
      allowedActions: ['send_message'],
    })

    adapter.script.push(answer('招标分析提交不完整，Run 已挂起，可修正后恢复。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '怎么回事？' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const request = adapter.requests.findLast(candidate => String(candidate.sessionId) === String(agent.id))
    const requestText = request?.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(requestText).toContain('Host execution update:')
    expect(requestText).toContain('阶段：tender_analysis')
    expect(requestText).toContain('状态：suspended')
    expect(requestText).toContain('原因：retry_exhausted')
    expect(requestText).toContain('错误：BID_EXECUTOR_ERROR')
    expect(requestText).toContain('TENDER_ANALYSIS_SUBMISSION_INCOMPLETE')
    expect(requestText).toContain('THIRD_ISSUE')
    expect(requestText).not.toContain('FOURTH_ISSUE')
    expect(requestText).not.toContain('普通 Child 进度')
    expect(agent.session.deriveMessages().at(-1)?.content)
      .toContainEqual({ type: 'text', text: '招标分析提交不完整，Run 已挂起，可修正后恢复。' })
  })

  it.each(['session', 'remote'] as const)('%s Stop 同时取消当前回复与 S4 execution lane', async (entry) => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('cancel-public-reply')
    const stageGate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'running' }) })
    await vi.waitFor(() => { expect(executeStage).toHaveBeenCalledOnce() })
    const run = executeStage.mock.calls[0]?.[1]
    if (run === undefined) throw new Error('恢复执行没有 Run 上下文')

    const requestStarted = Promise.withResolvers<undefined>()
    const responseGate = Promise.withResolvers<undefined>()
    adapter.onRequest = () => { requestStarted.resolve(undefined) }
    adapter.requestGate = responseGate.promise
    adapter.script.push(answer('这条回复不应完成。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '查看当前进度' }], source: { kind: 'user' } }))
    await requestStarted.promise
    let stopping: Promise<{ accepted: true }> | undefined
    if (entry === 'remote') stopping = ctx.bid.stopRun(agent.session)
    else agent.cancel({ kind: 'user' }, { keepInbox: true })
    responseGate.resolve(undefined)
    await agent.whenIdle()

    await vi.waitFor(() => { expect(run.signal.aborted).toBe(true) })
    stageGate.resolve([])
    await retry
    await stopping
    await ctx.bid.stopRun(agent.session)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted' } },
    })
    expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'suspended' })
    expect(host.inFlight.size).toBe(0)
    adapter.script.push(answer('停止后仍可继续聊天。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '停止后继续聊天' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('停止后仍可继续聊天')
  })

  it('同项目任一 Interaction Session 的 Stop 都挂起唯一 Run', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('stop-stage')
    const stageGate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const resumed = resumeRun(ctx, agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'running' }) })
    await vi.waitFor(() => { expect(executeStage).toHaveBeenCalledOnce() })
    const run = executeStage.mock.calls[0]?.[1]
    if (run === undefined) throw new Error('恢复执行没有 Run 上下文')

    const other = await fresh('stop-stage-other', workspace.root, false)
    other.cancel({ kind: 'user' })
    await vi.waitFor(() => { expect(run.signal.aborted).toBe(true) })
    stageGate.resolve([])
    await resumed
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
    expect(await readBidProjectState(workspace)).toMatchObject({
      stage: 'evidence_mapping', status: 'suspended',
      run: { runId: run.runId, work: { stage: 'evidence_mapping' }, cause: 'user_stop' },
    })
  })

  it('S4 重试耗尽后 project-state、Session 与客户端 Projection 同步为挂起', async () => {
    const { ctx, workspace, fresh, executor, validator } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('retry-exhausted-state-sync')
    const before = await readBidProjectState(workspace)
    if (before?.status !== 'suspended') throw new Error('测试项目没有可恢复的 S4 Run')
    executor.canExecute = stage => stage === 'evidence_mapping'
    validator.validate = async () => ({ ok: false, issues: [{
      code: 'EVIDENCE_MAPPING_TASK_FAILED',
      message: 'SEC-401 映射重试耗尽。',
      artifact: 'analysis/evidence-mapping-execution-log.json',
    }] })

    await expect(ctx.bid.resumeCurrentRun(agent.session, before.run.runId, before.revision))
      .resolves.toMatchObject({ stage: 'evidence_mapping', status: 'suspended' })
    expect(await readBidProjectState(workspace)).toMatchObject({
      stage: 'evidence_mapping',
      status: 'suspended',
      run: {
        work: { stage: 'evidence_mapping' },
        cause: 'retry_exhausted',
        error: { issues: [{ code: 'EVIDENCE_MAPPING_TASK_FAILED', message: 'SEC-401 映射重试耗尽。' }] },
      },
    })
    expect(runtime(agent.session)).toMatchObject({ stage: 'evidence_mapping', status: 'suspended' })
    expect(ctx.sessionProjections.snapshot(agent.session).values['bid.runtime']).toMatchObject({
      task: { stage: 'evidence_mapping', status: 'suspended', run: { cause: 'retry_exhausted' } },
    })
  })

  it('S4 挂起后仍可读取已保存的映射进度', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), JSON.stringify({
      schema_version: 5,
      max_concurrency: 3,
      observed_max_concurrency: 2,
      tasks: [{
        task_id: 'MAP-INIT-SEC-1', phase: 'initial', title: '技术方案', status: 'failed',
        attempts: [], final_child_session_id: null,
      }],
    }))
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('suspended-s4-progress')

    await expect(ctx.bid.getEvidenceMappingProgress(agent.session)).resolves.toMatchObject({
      total: 1, initial: 1, supplemental: 0, completed: 0, running: 0, not_started: 0, failed: 1,
    })
  })

  it('S4 进度读取会用更新的项目检查点校准落后的 Session 投影', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), JSON.stringify({
      schema_version: 5,
      max_concurrency: 3,
      observed_max_concurrency: 2,
      tasks: [{
        task_id: 'MAP-INIT-SEC-1', phase: 'initial', title: '技术方案', status: 'failed',
        attempts: [], final_child_session_id: null,
      }],
    }))
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
    const agent = await fresh('stale-s4-progress')
    const oldView = getBidClientProjection(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
    const unchanged = structuredClone(oldView)
    const before = agent.session.events.length

    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    await expect(ctx.bid.getEvidenceMappingProgress(agent.session, oldView)).resolves.toBeNull()

    const correction = agent.session.events.at(-1)
    expect(agent.session.events.length).toBe(before + 1)
    expect(correction).toMatchObject({
      type: 'bid.project.resumed', data: { state: { stage: 'evidence_mapping', status: 'suspended' } },
    })
    expect(agent.session.events.some(event => event.type === 'bid.run.started')).toBe(false)
    expect(oldView).toEqual(unchanged)

    const current = getBidClientProjection(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
    await expect(ctx.bid.getEvidenceMappingProgress(agent.session, current)).resolves.toMatchObject({
      total: 1, completed: 0, running: 0, failed: 1,
    })
  })

  it('S4 挂起 Run 允许普通消息继续对话', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('suspended-s4-prompt')

    await expect(ctx.serial('session/prompt-admission', {
      session: agent.session,
      mode: 'queue',
      content: [{ type: 'text', text: '继续吧' }],
    })).resolves.toBeUndefined()
  })

  it('旧 Session 日志落盘失败不会让新聊天以 S1 覆盖已有 S4 项目', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    const saved = (await readBidProjectState(workspace))!
    const flush = vi.fn((session: Session) => {
      if (session === a.session) throw new Error('旧聊天落盘失败')
    })
    const release = ctx.on('session/flush', flush, { global: true })
    try {
      const b = await fresh('session-b')
      expect(flush).toHaveBeenCalledWith(a.session)
      expect(runtime(b.session)).toMatchObject(state)
      expect(b.session.deriveMessages()).toEqual([])
      const restored = (await readBidProjectState(workspace))!
      expect(restored).toMatchObject({ stage: saved.stage, status: saved.status })
      expect(restored.revision).toBeGreaterThanOrEqual(saved.revision)
      expect(executor.execute).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('reset 删除后续产物并在同一操作驱动当前阶段', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'outline/repair-operations.json'), '[]')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const a = await fresh('session-a')
    executor.canExecute = stage => stage === 'outline_generation'
    expect(await ctx.bid.resetStage(a, 'outline_generation')).toEqual({ stage: 'outline_generation', status: 'ready', run: null })
    await vi.waitFor(() => {
      expect(runtime(a.session)).toEqual({ stage: 'outline_generation', status: 'waiting_user', run: null })
    })
    expect(executor.execute).toHaveBeenCalledOnce()
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'outline/repair-operations.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'outline_generation', status: 'waiting_user', run: null })
    expect(b.session.deriveMessages()).toEqual([])
  })

  it('S5 重置后保持等待用户输入且不提出已删除的阶段开始问题', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user' })
    const agent = await fresh('reset-native-question')
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => ({
      answers: [{ id: questions[0]!.id, selected: ['停止任务'] }],
    }))
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      await expect(ctx.bid.resetStage(agent, 'chapter_writing')).resolves.toEqual({
        stage: 'chapter_writing', status: 'waiting_user', run: null,
      })
      expect(asked).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('等待确认投影出现后，目录读取等待操作落盘并返回实际目录', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'outline_generation', status: 'failed' })
    const a = await fresh('session-a')
    executor.canExecute = stage => stage === 'outline_generation'
    const checkpoint = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const release = ctx.on('session/flush', async (session) => {
      if (session === a.session && runtime(session).status === 'waiting_user') {
        checkpoint.resolve(undefined)
        await gate.promise
      }
    }, { global: true })
    const retry = resumeRun(ctx, a.session)
    try {
      await checkpoint.promise
      let settled = false
      const draft = ctx.bid.getOutlineDraft(a.session).finally(() => { settled = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      gate.resolve(undefined)
      expect((await retry).ok).toBe(true)
      expect((await draft).outline).toEqual(outline)
    } finally { gate.resolve(undefined); release(); await retry }
  })

  it('后端中断的 running 在原阶段挂起，保留已有章节且不自动执行', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'running' })
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => ({
      answers: [{ id: questions[0]!.id, selected: ['停止任务'] }],
    }))
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      const b = await fresh('session-b')
      expect(runtime(b.session)).toMatchObject({ stage: 'chapter_writing', status: 'suspended' })
      expect(await readBidProjectState(workspace)).toMatchObject({
        stage: 'chapter_writing', status: 'suspended',
        run: { work: { stage: 'chapter_writing' }, cause: 'host_restart' },
      })
      await vi.waitFor(() => {
        expect(asked).toHaveBeenCalledOnce()
        expect(asked.mock.calls[0]?.[0].questions[0]?.question).toContain('host_restart')
      })
      expect(b.session.events.find(event => event.type === 'bid.run.notice')).toMatchObject({
        data: { kind: 'interrupted', severity: 'error' },
      })
      expect(executor.execute).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('S1 挂起后从 durable raw request 重新装载原始上传字节', async () => {
    const { ctx, workspace, fresh } = await fixture({ realOrchestrator: true })
    const bytes = new TextEncoder().encode('技术要求：恢复时必须读取原始上传。')
    const workId = 'file-intake-resume-work'
    const bytesRef = `requests/${workId}/files/0001`
    await mkdir(join(workspace.projectRoot, 'requests', workId, 'files'), { recursive: true })
    await writeFile(join(workspace.projectRoot, bytesRef), bytes)
    const records = [{
      name: 'tender.md', role: 'tender' as const, bytes_ref: bytesRef, size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]
    const work = await persistBidWorkRequest(
      workspace, 'file_intake', 'file_intake', { files: records }, records, workId,
    )
    const suspended = await checkpointStoredBidProjectState(workspace, {
      stage: 'file_intake',
      status: 'suspended',
      run: {
        runId: 'file-intake-suspended', epoch: 1, baseProjectRevision: 0, work,
        cause: 'user_stop', startedAt: 1, updatedAt: 2,
      },
    })
    await expect(readFile(join(workspace.projectRoot, work.requestRef), 'utf8'))
      .resolves.toContain('bytes_ref')
    const agent = await fresh('file-intake-resume')
    const restored = Promise.withResolvers<readonly { name: string; bytes: Uint8Array }[]>()
    const resumedImport = vi.spyOn(BidWorkspace.prototype, 'import').mockImplementation(async (files) => {
      restored.resolve(files)
      throw new Error('stop after durable reload')
    })
    if (suspended.status !== 'suspended') throw new Error('S1 Run 未挂起')
    await ctx.bid.resumeCurrentRun(agent.session, suspended.run.runId, suspended.revision)
    const resumedFiles = await restored.promise
    expect(resumedFiles).toHaveLength(1)
    expect(resumedFiles[0]?.name).toBe('tender.md')
    expect(Buffer.from(resumedFiles[0]!.bytes)).toEqual(Buffer.from(bytes))
    resumedImport.mockRestore()
  }, 30_000)

  it('恢复必须匹配挂起 Run 身份与项目 revision', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('resume-cas')
    const saved = await readBidProjectState(workspace)
    if (saved?.status !== 'suspended') throw new Error('测试项目没有挂起 Run')

    await expect(ctx.bid.resumeCurrentRun(agent.session, 'other-run', saved.revision))
      .rejects.toMatchObject({ code: 'BID_RESUME_NOT_ALLOWED' })
    await expect(ctx.bid.resumeCurrentRun(agent.session, saved.run.runId, saved.revision + 1))
      .rejects.toMatchObject({ code: 'BID_RESUME_NOT_ALLOWED' })
    expect((await readBidProjectState(workspace))?.revision).toBe(saved.revision)
  })

  it('挂起后的普通消息不自动恢复 Run，也不注册恢复工具', async () => {
    const { workspace, fresh, executor, adapter, ctx } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('suspended-chat')
    const before = await readBidProjectState(workspace)
    adapter.script.push(answer('我先说明当前状态，不继续执行。'))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '现在是什么情况？' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(executor.execute).not.toHaveBeenCalled()
    expect((await readBidProjectState(workspace))?.run).toEqual(before?.run)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('bid_resume_current_run')
  })

  it('挂起 Run 通过原生问题去重，明确停止后记录决策', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const response = Promise.withResolvers<AskUserQuestionAnswer>()
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      expect(questions[0]?.question).toContain('目录生成/资料映射')
      return response.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      const agent = await fresh('native-recovery-question')
      await vi.waitFor(() => { expect(asked).toHaveBeenCalledOnce() })
      const question = asked.mock.calls[0]?.[0].questions[0]
      if (question === undefined) throw new Error('原生恢复问题缺少选项')
      expect(question.options?.map(option => option.label)).toEqual([
        '继续未完成任务（推荐）', '重新执行当前阶段', '停止任务',
      ])
      expect(agent.session.events.filter(event => event.type === 'bid.run.decision.required')).toHaveLength(1)

      const host = ctx.bid as unknown as { ensureRunDecision: (agent: Agent) => void }
      host.ensureRunDecision(agent)
      expect(asked).toHaveBeenCalledOnce()

      response.resolve({ answers: [{ id: question.id, selected: ['停止任务'] }] })
      await vi.waitFor(() => {
        expect(agent.session.events.some(event => event.type === 'bid.run.decision.received'
          && event.data.decisionKey === question.id && event.data.decision === 'stop')).toBe(true)
      })
      expect(agent.session.events.filter(event => event.type === 'bid.run.decision.required')).toHaveLength(1)
      host.ensureRunDecision(agent)
      expect(asked).toHaveBeenCalledOnce()
    } finally {
      dispose()
    }
  })

  it('原生继续选项沿用当前 Run 的恢复入口', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const resume = vi.spyOn(ctx.bid, 'resumeCurrentRun').mockResolvedValue(BID_INITIAL_TASK_STATE)
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => ({
      answers: [{ id: questions[0]!.id, selected: ['继续未完成任务（推荐）'] }],
    }))
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      const agent = await fresh('native-recovery-continue')
      await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })
      expect(resume).toHaveBeenCalledWith(agent.session, expect.any(String), expect.any(Number))
      expect(agent.session.events.some(event => event.type === 'bid.run.decision.received'
        && event.data.decision === 'continue')).toBe(true)
    } finally {
      dispose()
      resume.mockRestore()
    }
  })

  it('原生重跑选项通过 reset 在同一操作驱动当前阶段', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const reset = vi.spyOn(ctx.bid, 'resetStage').mockResolvedValue({ stage: 'evidence_mapping', status: 'waiting_user', run: null })
    const asked = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => ({
      answers: [{ id: questions[0]!.id, selected: ['重新执行当前阶段'] }],
    }))
    const dispose = ctx.userQuestions.registerProvider({ ask: asked })
    try {
      const agent = await fresh('native-recovery-restart')
      await vi.waitFor(() => { expect(reset).toHaveBeenCalledOnce() })
      expect(reset).toHaveBeenCalledWith(agent, 'evidence_mapping')
    } finally {
      dispose()
      reset.mockRestore()
    }
  })

  it('挂起的 S5 修订只追加原 work journal，不创建替代 Run', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('suspended-s5-revision')
    const before = await readBidProjectState(workspace)
    if (before?.status !== 'suspended') throw new Error('测试项目没有挂起 S5 Run')
    const markdown = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')

    const result = await ctx.tools.execute({
      agent,
      name: 'bid_revise_chapter',
      arguments: {
        instruction: '补充交付验收责任。',
        reference: {
          scope: 'chapter',
          section_id: 'SEC-1',
          content_sha256: chapterContentSha256(markdown),
        },
      },
      callId: CallId('suspended-s5-revision'),
      signal: new AbortController().signal,
    })

    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result).toMatchObject({
      isError: false,
      value: { ok: true, accepted: true, workId: before.run.work.workId },
    })
    const after = await readBidProjectState(workspace)
    expect(after?.run).toMatchObject({
      runId: before.run.runId,
      work: { workId: before.run.work.workId },
    })
    expect(after?.status).toBe('suspended')
    expect(after?.revision).toBe(before.revision + 1)
    expect(await readBidChapterCommandJournal(workspace, before.run.work.workId)).toMatchObject([{
      status: 'pending',
      command: { kind: 'revision', request: { instruction: '补充交付验收责任。' } },
    }])
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('挂起 S5 的视觉 skip 写入原 work，原生继续复用命令日志', async () => {
    const { ctx, workspace, fresh, executor, host } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('suspended-s5-visual-policy')
    const before = await readBidProjectState(workspace)
    if (before?.status !== 'suspended') throw new Error('测试项目没有挂起 S5 Run')
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('bid_set_flowchart_visual_review')

    const result = await ctx.tools.execute({
      agent, name: 'bid_set_flowchart_visual_review', arguments: { policy: 'skip' },
      callId: CallId('suspended-s5-visual-policy'), signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result.value).toMatchObject({ ok: true, policy: 'skip', workId: before.run.work.workId })
    const saved = await readBidProjectState(workspace)
    expect(saved).toMatchObject({
      stage: 'chapter_writing', status: 'suspended',
      run: { runId: before.run.runId, work: { workId: before.run.work.workId } },
    })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(await readBidChapterCommandJournal(workspace, before.run.work.workId)).toMatchObject([{
      status: 'pending', command: { kind: 'flowchart_visual_review_policy', policy: 'skip' },
    }])

    executor.canExecute = stage => stage === 'chapter_writing'
    const gate = Promise.withResolvers<Awaited<ReturnType<BidStageExecutorPort['execute']>>>()
    executor.execute.mockImplementation(async () => gate.promise)
    const admitted = Promise.withResolvers<BidRunContext>()
    const resumed = ctx.bid.resumeCurrentRun(agent.session, before.run.runId, saved!.revision, run => admitted.resolve(run))
    try {
      const run = await admitted.promise
      expect(run.work.workId).toBe(before.run.work.workId)
      const active = [...host.inFlight.values()][0] as {
        writingControl: ChapterWritingControl & {
          bind(workspace: BidWorkspace, workId: string, commits: typeof run.commits): Promise<void>
          flowchartVisualReviewPolicy(): 'required' | 'skip'
        }
      }
      await active.writingControl.bind(workspace, run.work.workId, run.commits)
      expect(active.writingControl.flowchartVisualReviewPolicy()).toBe('skip')
      const commands = active.writingControl.drain()
      expect(commands).toMatchObject([{ kind: 'flowchart_visual_review_policy', policy: 'skip' }])
      await active.writingControl.commit!(commands, async () => {})
      expect(await readBidChapterCommandJournal(workspace, before.run.work.workId)).toMatchObject([{
        status: 'applied', command: { kind: 'flowchart_visual_review_policy', policy: 'skip' },
      }])
      expect(active.writingControl.flowchartVisualReviewPolicy()).toBe('skip')
      const running = await ctx.tools.execute({
        agent, name: 'bid_set_flowchart_visual_review', arguments: { policy: 'required' },
        callId: CallId('running-s5-visual-policy'), signal: new AbortController().signal,
      })
      if (running.isError) throw new Error(JSON.stringify(running))
      expect(running.value).toMatchObject({ ok: true, policy: 'required' })
      expect(active.writingControl.flowchartVisualReviewPolicy()).toBe('required')
      expect(await readBidChapterCommandJournal(workspace, before.run.work.workId)).toMatchObject([
        { status: 'applied', command: { kind: 'flowchart_visual_review_policy', policy: 'skip' } },
        { status: 'pending', command: { kind: 'flowchart_visual_review_policy', policy: 'required' } },
      ])
      expect(host.inFlight.size).toBe(1)
    } finally {
      gate.resolve([])
      await resumed
    }
  })

  it('同一真实目录的 Session 共用锁，不同 Workspace 可并行执行', async () => {
    const { ctx, workspace, fresh, executor, host } = await fixture()
    await seedProjectArtifacts(workspace)
    const alias = join(workspace.root, 'workspace-link')
    await symlink(workspace.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const otherRoot = join(workspace.root, 'other-project')
    await mkdir(otherRoot)
    const otherWorkspace = new BidWorkspace(otherRoot)
    await seedProjectArtifacts(otherWorkspace)
    const failed = { stage: 'chapter_writing', status: 'failed' } as const
    await checkpointBidProjectState(workspace, failed)
    await checkpointBidProjectState(otherWorkspace, failed)
    const a = await fresh('session-a')
    const b = await fresh('session-b', alias)
    const c = await fresh('session-c', otherRoot)
    const gate = Promise.withResolvers<undefined>()
    executor.canExecute = stage => stage === 'chapter_writing'
    executor.execute = vi.fn(async () => { await gate.promise; return [] })
    const operationA = resumeRun(ctx, a.session)
    try {
      await vi.waitFor(() => { expect(executor.execute).toHaveBeenCalledTimes(1) })
      expect(await resumeRun(ctx, b.session)).toMatchObject({ ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS' } })
      const operationC = resumeRun(ctx, c.session)
      await vi.waitFor(() => { expect(executor.execute).toHaveBeenCalledTimes(2) })
      const d = await fresh('session-d', alias, false)
      expect(runtime(d.session)).toMatchObject({ stage: 'chapter_writing', status: 'running' })
      expect(d.session.deriveMessages()).toEqual([])
      expect(await ctx.bid.getReviewChapter(d.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
      gate.resolve(undefined)
      expect((await operationA).ok).toBe(true)
      expect((await operationC).ok).toBe(true)
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      expect(runtime(d.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
      expect(executor.execute).toHaveBeenCalledTimes(2)
    } finally { gate.resolve(undefined); await operationA }
  })

  it('S5 审批意见队列：收集、编辑、删除意见不触发任何章节写作 Run', async () => {
    const { ctx, workspace, fresh, host, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-queue')
    const chapter = await ctx.bid.getReviewChapter(agent.session, 'SEC-1')
    expect(chapter.content_sha256).not.toBeNull()
    const sha = chapter.content_sha256!

    const added = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: sha },
      instruction: '加强技术方案细节', suggestion: '补充实施步骤',
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const issueId = added.value.issues[0]!.issue_id
    const queueRevision = added.value.revision

    const queue = await ctx.bid.getRevisionQueue(agent.session)
    expect(queue.issues).toHaveLength(1)
    expect(queue.revision).toBe(queueRevision)

    const updated = await ctx.bid.updateRevisionIssue(agent.session, {
      issue_id: issueId, expected_queue_revision: queueRevision,
      instruction: '进一步细化技术方案',
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.issues[0]!.instruction).toBe('进一步细化技术方案')

    const deleted = await ctx.bid.deleteRevisionIssue(agent.session, {
      issue_id: issueId, expected_queue_revision: updated.value.revision,
    })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.issues).toHaveLength(0)

    expect(executeStage).not.toHaveBeenCalled()
    expect(host.inFlight.size).toBe(0)
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
  })

  it('S5 历史对比按 issue 定位 task 快照，旧记录明确不可用', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-comparison')
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        {
          issue_id: 'ISSUE-1', section_id: 'SEC-1', section_title: '技术方案', scope: 'chapter',
          reference: { scope: 'chapter', base_content_sha256: 'a'.repeat(64) }, instruction: '补充步骤',
          suggestion: null, status: 'completed', batch_id: 'BATCH-1', created_at: 1, updated_at: 2,
        },
        {
          issue_id: 'ISSUE-2', section_id: 'SEC-1', section_title: '技术方案', scope: 'chapter',
          reference: { scope: 'chapter', base_content_sha256: 'b'.repeat(64) }, instruction: '补充验收',
          suggestion: null, status: 'completed', batch_id: 'BATCH-2', created_at: 3, updated_at: 4,
        },
      ],
    }
    const batch: RevisionBatchArtifact = {
      schema_version: 2,
      batch_id: 'BATCH-1', queue_revision: 1, issue_ids: ['ISSUE-1'], status: 'completed',
      tasks: [{ task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: ['ISSUE-1'], depends_on: [], status: 'completed', failure: null, started_at: 1, completed_at: 2 }],
      created_at: 1, updated_at: 2,
    }
    await writeRevisionQueue(workspace, queue)
    await writeRevisionBatch(workspace, batch)
    await writeRevisionBatch(workspace, {
      ...batch,
      batch_id: 'BATCH-2', issue_ids: ['ISSUE-2'],
      tasks: [{ ...batch.tasks[0]!, task_id: 'TASK-2', issue_ids: ['ISSUE-2'], started_at: 3, completed_at: 4 }],
      created_at: 3, updated_at: 4,
    })
    await expect(ctx.bid.getRevisionComparison(agent.session, 'ISSUE-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BID_REVISION_COMPARISON_NOT_AVAILABLE' },
    })

    const comparison = createRevisionComparisonArtifact({
      batchId: 'BATCH-1', taskId: 'TASK-1', sectionId: 'SEC-1', issueIds: ['ISSUE-1'],
      beforeMarkdown: '# 技术方案\n\nV1\n', afterMarkdown: '# 技术方案\n\nV2\n', createdAt: 2,
    })
    const path = join(workspace.projectRoot, buildRevisionComparisonPath('BATCH-1', 'TASK-1'))
    await mkdir(join(workspace.projectRoot, 'chapters/revisions/comparisons/BATCH-1'), { recursive: true })
    await writeFile(path, `${JSON.stringify(comparison)}\n`)
    const comparison2 = createRevisionComparisonArtifact({
      batchId: 'BATCH-2', taskId: 'TASK-2', sectionId: 'SEC-1', issueIds: ['ISSUE-2'],
      beforeMarkdown: '# 技术方案\n\nV2\n', afterMarkdown: '# 技术方案\n\nV3\n', createdAt: 4,
    })
    const path2 = join(workspace.projectRoot, buildRevisionComparisonPath('BATCH-2', 'TASK-2'))
    await mkdir(join(workspace.projectRoot, 'chapters/revisions/comparisons/BATCH-2'), { recursive: true })
    await writeFile(path2, `${JSON.stringify(comparison2)}\n`)
    await expect(ctx.bid.getRevisionComparison(agent.session, 'ISSUE-1')).resolves.toMatchObject({
      ok: true,
      value: { issue_id: 'ISSUE-1', task_id: 'TASK-1', before_markdown: '# 技术方案\n\nV1\n', after_markdown: '# 技术方案\n\nV2\n' },
    })
    await expect(ctx.bid.getRevisionComparison(agent.session, 'ISSUE-2')).resolves.toMatchObject({
      ok: true,
      value: { issue_id: 'ISSUE-2', task_id: 'TASK-2', before_markdown: '# 技术方案\n\nV2\n', after_markdown: '# 技术方案\n\nV3\n' },
    })
    await writeFile(path, `${JSON.stringify({ ...comparison, after_markdown: 'tampered' })}\n`)
    await expect(ctx.bid.getRevisionComparison(agent.session, 'ISSUE-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'BID_REVISION_COMPARISON_CORRUPT' },
    })
  })

  it('S5 审批意见队列：非 pending issue 拒绝编辑，CAS 冲突返回稳定错误', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-queue-cas')
    const chapter = await ctx.bid.getReviewChapter(agent.session, 'SEC-1')
    const sha = chapter.content_sha256!

    const added = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: sha },
      instruction: '意见', suggestion: null,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const issueId = added.value.issues[0]!.issue_id

    const stale = await ctx.bid.updateRevisionIssue(agent.session, {
      issue_id: issueId, expected_queue_revision: 999,
      instruction: '过期',
    })
    expect(stale).toMatchObject({ ok: false, error: { code: 'BID_REVISION_QUEUE_CONFLICT' } })

    const unknown = await ctx.bid.updateRevisionIssue(agent.session, {
      issue_id: 'REV-missing', expected_queue_revision: added.value.revision,
      instruction: 'x',
    })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'BID_REVISION_ISSUE_NOT_FOUND' } })
  })

  it('S5 批量修订：inspect → plan → execute(全冲突) 同一回合真实工具调用', async () => {
    const { ctx, workspace, fresh, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-batch-composition')
    const chapter = await ctx.bid.getReviewChapter(agent.session, 'SEC-1')
    expect(chapter.content_sha256).not.toBeNull()
    const sha = chapter.content_sha256!

    const added = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: sha },
      instruction: '加强技术方案细节', suggestion: '补充实施步骤',
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const issueId = added.value.issues[0]!.issue_id
    const queueRevision = added.value.revision

    const inspected = await ctx.tools.execute({
      agent,
      name: 'bid_stage_inspect',
      arguments: { view: 'summary' },
      callId: CallId('batch-inspect'),
      signal: new AbortController().signal,
    })
    expect(inspected.isError, JSON.stringify(inspected)).toBe(false)
    expect(inspected.value).toMatchObject({
      task: { stage: 'chapter_writing', status: 'completed', run: null },
    })

    const planned = await ctx.tools.execute({
      agent,
      name: 'bid_plan_revision_batch',
      arguments: {
        expected_queue_revision: queueRevision,
        issue_ids: [issueId],
        tasks: [{
          task_id: 'TASK-1',
          section_id: 'SEC-1',
          issue_ids: [issueId],
          depends_on: [],
        }],
      },
      callId: CallId('batch-plan'),
      signal: new AbortController().signal,
    })
    expect(planned.isError, JSON.stringify(planned)).toBe(false)
    const planResult = planned.value as {
      batch_id: string
      status: string
      issue_ids: string[]
      tasks: Array<{ task_id: string; status: string }>
      queue_revision: number
    }
    expect(planResult.batch_id).toMatch(/^BATCH-/u)
    expect(planResult.status).toBe('planning')
    expect(planResult.issue_ids).toEqual([issueId])
    expect(planResult.tasks[0]?.task_id).toBe('TASK-1')
    expect(planResult.tasks[0]?.status).toBe('queued')
    const batchId = planResult.batch_id

    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n修订后的正文。\n')

    const executed = await ctx.tools.execute({
      agent,
      name: 'bid_execute_revision_batch',
      arguments: { batch_id: batchId },
      callId: CallId('batch-execute'),
      signal: new AbortController().signal,
    })
    expect(executed.isError, JSON.stringify(executed)).toBe(false)
    const execResult = executed.value as {
      batch_id: string
      status: string
      tasks: Array<{
        task_id: string
        status: string
        failure: { code: string; message: string; phase: string | null } | null
      }>
    }
    expect(execResult.batch_id).toBe(batchId)
    expect(execResult.status).toBe('completed')
    expect(execResult.tasks[0]?.status).toBe('conflict')
    expect(execResult.tasks[0]?.failure?.code).toBe('STALE_BASE')

    expect(executeStage).not.toHaveBeenCalled()
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })

    const batchArtifact = JSON.parse(await readFile(join(workspace.projectRoot, `chapters/revisions/batches/${batchId}.json`), 'utf8')) as { status: string; tasks: Array<{ status: string }> }
    expect(batchArtifact.status).toBe('completed')
    expect(batchArtifact.tasks[0]?.status).toBe('conflict')

    const finalQueue = await ctx.bid.getRevisionQueue(agent.session)
    expect(finalQueue.issues[0]?.status).toBe('conflict')
  })

  it('S5 批量修订：inspect → plan 通过真实 AgentLoop 同一回合', async () => {
    const { ctx, workspace, fresh, adapter, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-batch-agent-loop')
    const chapter = await ctx.bid.getReviewChapter(agent.session, 'SEC-1')
    const sha = chapter.content_sha256!

    const added = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: sha },
      instruction: '加强技术方案细节', suggestion: '补充实施步骤',
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const issueId = added.value.issues[0]!.issue_id
    const queueRevision = added.value.revision

    adapter.script.push(
      toolCall('bid_stage_inspect', { view: 'summary' }),
      toolCall('bid_plan_revision_batch', {
        expected_queue_revision: queueRevision,
        issue_ids: [issueId],
        tasks: [{
          task_id: 'TASK-1',
          section_id: 'SEC-1',
          issue_ids: [issueId],
          depends_on: [],
        }],
      }),
      answer('已规划批次，准备执行修订。'),
    )
    const before = agent.session.events.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '请规划并执行修订。' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const toolCalls = agent.session.events.slice(before)
      .filter(event => event.type === 'tool/call')
      .map(event => event.data.name)
    expect(toolCalls).toEqual(['bid_stage_inspect', 'bid_plan_revision_batch'])

    const batchFiles = await readdir(join(workspace.projectRoot, 'chapters/revisions/batches'))
    expect(batchFiles).toHaveLength(1)
    const batchArtifact = JSON.parse(await readFile(join(workspace.projectRoot, `chapters/revisions/batches/${batchFiles[0]!}`), 'utf8')) as { status: string; tasks: Array<{ status: string }> }
    expect(batchArtifact.status).toBe('planning')
    expect(batchArtifact.tasks[0]?.status).toBe('queued')

    expect(executeStage).not.toHaveBeenCalled()
    expect(runtime(agent.session)).toMatchObject({ stage: 'chapter_writing', status: 'completed' })
  })

  it('S5 批量修订：不同 section 的原 Writer 来自不同 parent 时拒绝执行', async () => {
    const { ctx, workspace, fresh } = await fixture({ withPersistence: true })
    const outline = await seedProjectArtifacts(workspace)
    const twoSectionOutline = {
      ...outline,
      sections: [
        ...outline.sections,
        { ...outline.sections[0]!, id: 'SEC-2', order: 2, title: '总体设计', purpose: '说明总体设计' },
      ],
    }
    const twoSectionSha = outlineArtifactSha256(twoSectionOutline)
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), JSON.stringify(twoSectionOutline))
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(twoSectionOutline))
    await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify({
      schema_version: 4, scope: 'technical_bid', confirmed_outline_sha256: twoSectionSha,
      writing_plan_version: 1, max_concurrency: 1, observed_max_concurrency: 1,
      sections: [
        { section_id: 'SEC-1', depends_on: [], related_sections: [], epoch: 0, status: 'completed', phase: null, failure_phase: null, attempts: [], final_writer_child_session_id: 'writer-sec-1', final_reviewer_child_session_id: 'reviewer-a' },
        { section_id: 'SEC-2', depends_on: [], related_sections: [], epoch: 0, status: 'completed', phase: null, failure_phase: null, attempts: [], final_writer_child_session_id: 'writer-sec-2', final_reviewer_child_session_id: 'reviewer-b' },
      ],
    }))
    await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify({
      schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
      confirmed_outline_sha256: twoSectionSha,
      user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
      user_requirements: ['没有特殊要求，直接开始'], global_instructions: ['完整响应招标要求。'], document_acceptance: [],
      sections: [
        { section_id: 'SEC-1', task: '完成技术方案。', user_message_refs: [], user_requirements: [], writing_instructions: [], acceptance_criteria: [] },
        { section_id: 'SEC-2', task: '完成总体设计。', user_message_refs: [], user_requirements: [], writing_instructions: [], acceptance_criteria: [] },
      ],
      revision: null,
    }))
    const manifestBase = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')) as { schema_version: number; scope: string; confirmed_outline_sha256: string; chapters: Array<Record<string, unknown>> }
    const chapter1 = manifestBase.chapters[0]!
    const chapter2 = { ...chapter1, section_id: 'SEC-2', content_path: 'chapters/sections/0002.md', review_path: 'chapters/reviews/0002.json', handoff: { ...(chapter1.handoff as object), section_id: 'SEC-2' } }
    await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), JSON.stringify({ ...manifestBase, confirmed_outline_sha256: twoSectionSha, chapters: [chapter1, chapter2] }))
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), '# 总体设计\n\n已有正文。\n')

    await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('writer-sec-1'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: workspace.root, agentPreset: 'bid', origin: 'subagent', parentSession: SessionId('parent-a') },
    })
    await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('writer-sec-2'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: workspace.root, agentPreset: 'bid', origin: 'subagent', parentSession: SessionId('parent-b') },
    })

    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-batch-multi-parent')

    const sha1 = chapterContentSha256(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8'))
    const sha2 = chapterContentSha256(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8'))
    const added1 = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: sha1 },
      instruction: '加强技术方案', suggestion: null,
    })
    expect(added1.ok).toBe(true)
    if (!added1.ok) return
    const added2 = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-2', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: sha2 },
      instruction: '加强总体设计', suggestion: null,
    })
    expect(added2.ok).toBe(true)
    if (!added2.ok) return
    const issue1Id = added1.value.issues[0]!.issue_id
    const issue2Id = added2.value.issues[1]!.issue_id

    const planned = await ctx.tools.execute({
      agent,
      name: 'bid_plan_revision_batch',
      arguments: {
        expected_queue_revision: added2.value.revision,
        issue_ids: [issue1Id, issue2Id],
        tasks: [
          { task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: [issue1Id], depends_on: [] },
          { task_id: 'TASK-2', section_id: 'SEC-2', issue_ids: [issue2Id], depends_on: [] },
        ],
      },
      callId: CallId('multi-parent-plan'),
      signal: new AbortController().signal,
    })
    expect(planned.isError, JSON.stringify(planned)).toBe(false)
    const batchId = (planned.value as { batch_id: string }).batch_id

    const executed = await ctx.tools.execute({
      agent,
      name: 'bid_execute_revision_batch',
      arguments: { batch_id: batchId },
      callId: CallId('multi-parent-execute'),
      signal: new AbortController().signal,
    })
    expect(executed.isError).toBe(true)
    expect((executed as { error?: { message?: string } }).error?.message).toContain('BID_CHAPTER_REVISION_MULTI_PARENT_UNSUPPORTED')
  })

  it('S5 批量修订：从失败修订残留恢复原 Writer parent 续写', async () => {
    const { ctx, workspace, fresh } = await fixture({ withPersistence: true, withPreset: true })
    for (const name of ['grep', 'read'] as const) {
      ctx.tools.register({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [{ type: 'text' as const, text: '{}' }] }, execute: async () => ({}) })
    }
    const outline = await seedProjectArtifacts(workspace)
    const outlineSha = outlineArtifactSha256(outline)
    const markdown = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const candidateSha = createHash('sha256').update(`${markdown.trim()}\n`).digest('hex')

    await writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({
      schema_version: 2, scope: 'technical_bid', decision: 'confirmed',
      source_outline_sha256: outlineSha, confirmed_outline_sha256: outlineSha,
      confirmed_draft_revision: 1, confirmed_draft_sha256: outlineSha,
    }))
    await mkdir(join(workspace.projectRoot, 'chapters/meta'), { recursive: true })
    await mkdir(join(workspace.projectRoot, 'chapters/reviews'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), JSON.stringify({
      schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: outlineSha,
      writing_plan_version: 1, global_consistency_notes: ['全局一致性说明'],
      sections: [{ section_id: 'SEC-1', depends_on: [], related_sections: [], planning_notes: ['章节规划说明'] }],
    }))
    await writeFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), JSON.stringify({
      section_id: 'SEC-1',
      covered_must_answer: ['按期交付'],
      covered_scoring_response_point_ids: ['RP-000001'],
      covered_scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明技术方案' }],
      local_materials_used: [], web_materials_used: [], unresolved_topics: [],
      handoff: { section_id: 'SEC-1', decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] },
      flowcharts: [],
    }))
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      schema_version: 8, section_id: 'SEC-1', verdict: 'pass',
      must_answer_coverage: [{ item: '按期交付', status: 'covered', evidence_quotes: ['已有正文'], issue: null }],
      requirement_coverage: [{ requirement_id: 'REQ-1', item: '按期交付', status: 'covered', evidence_quotes: ['已有正文'], issue: null }],
      response_point_coverage: [{ response_point_id: 'RP-000001', item: '说明技术方案', status: 'covered', evidence_quotes: ['已有正文'], issue: null }],
      compliance_coverage: [], acceptance_criteria_results: [], global_compliance_checks: [],
      assignment_conflicts: [], external_input_gaps: [], claim_checks: [],
      quality_checks: {
        bidder_response_voice: true,
        project_specific: true,
        structure_complete: true,
        legacy_project_pollution_free: true,
        placeholder_free: true,
        obvious_repetition_free: true,
      },
      blocking_issues: [],
      candidate_sha256: candidateSha, writer_child_session_id: 'writer-sec-1', reviewer_child_session_id: 'reviewer-a',
    }))
    await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({
      stage: 'evidence_mapping', sources: [],
    }))

    const originalParent = (await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('original-s5-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: workspace.root },
    })).agent
    await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('writer-sec-1'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: workspace.root, agentPreset: 'bid', origin: 'subagent', parentSession: originalParent.id },
    })

    const attempt = {
      role: 'writer', attempt: 1, child_session_id: 'writer-sec-1', label: 'Writer',
      started_at: '2024-01-01T00:00:00Z', ended_at: '2024-01-01T00:01:00Z',
      stop_reason: 'completed', accepted: true, issues: [],
      input: { plan_version: 1, section_epoch: 0, dependencies: [] },
    }
    const reviewAttempt = {
      role: 'reviewer', attempt: 1, child_session_id: 'reviewer-a', label: 'Reviewer',
      started_at: '2024-01-01T00:01:00Z', ended_at: '2024-01-01T00:02:00Z',
      stop_reason: 'completed', accepted: true, issues: [],
      input: { plan_version: 1, section_epoch: 0, dependencies: [] },
    }
    await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify({
      schema_version: 4, scope: 'technical_bid', confirmed_outline_sha256: outlineSha,
      writing_plan_version: 1, max_concurrency: 1, observed_max_concurrency: 1,
      sections: [{ section_id: 'SEC-1', depends_on: [], related_sections: [], epoch: 0, status: 'failed', phase: null, failure_phase: 'repairing', attempts: [attempt, reviewAttempt], final_writer_child_session_id: 'writer-sec-1', final_reviewer_child_session_id: 'reviewer-a' }],
    }))

    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('revision-batch-original-parent')

    const persistence = ctx.get('sessionPersistence')!
    const writerInspect = await persistence.inspect(SessionId('writer-sec-1'), new AbortController().signal)
    expect(writerInspect.meta.parentSession).toBe(originalParent.id)
    expect(writerInspect.meta.cwd).toBe(workspace.root)
    expect(ctx.agents.get(originalParent.id)?.id).toBe(originalParent.id)

    const sha = chapterContentSha256(markdown)
    const added = await ctx.bid.addRevisionIssue(agent.session, {
      section_id: 'SEC-1', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: sha },
      instruction: '加强技术方案', suggestion: null,
    })
    expect(added.ok, JSON.stringify(added)).toBe(true)
    if (!added.ok) return
    const issueId = added.value.issues[0]!.issue_id

    const planned = await ctx.tools.execute({
      agent,
      name: 'bid_plan_revision_batch',
      arguments: {
        expected_queue_revision: added.value.revision,
        issue_ids: [issueId],
        tasks: [{ task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: [issueId], depends_on: [] }],
      },
      callId: CallId('original-parent-plan'),
      signal: new AbortController().signal,
    })
    expect(planned.isError, JSON.stringify(planned)).toBe(false)
    const batchId = (planned.value as { batch_id: string }).batch_id
    const followup = vi.spyOn(ctx.subagents, 'followup')

    const executed = await ctx.tools.execute({
      agent,
      name: 'bid_execute_revision_batch',
      arguments: { batch_id: batchId },
      callId: CallId('original-parent-execute'),
      signal: new AbortController().signal,
    })

    expect(followup.mock.calls.some(([parent, childId]) =>
      parent.id === originalParent.id && childId === SessionId('writer-sec-1')), JSON.stringify({
      executed,
      followups: followup.mock.calls.map(([parent, childId]) => ({ parentId: parent.id, childId })),
    })).toBe(true)
    const executedError = executed.isError ? (executed as { error?: { message?: string } }).error?.message ?? '' : ''
    expect(executedError, JSON.stringify(executed)).not.toContain('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
  })

})
