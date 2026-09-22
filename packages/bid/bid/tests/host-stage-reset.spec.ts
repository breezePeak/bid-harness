import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  BID_STAGES, BidWorkspace, checkpointBidProjectState, BID_INITIAL_TASK_STATE, reduceBidTaskState,
  BidHostRuntime,
  type BidTaskState,
  type Config,
} from '@deepseek-ai/dsh-bid'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

interface TestOperation {
  readonly session: unknown
  readonly workspace: BidWorkspace
  readonly key: string
  readonly ready: boolean
  controller: AbortController
  readonly runs: { retire(): Promise<void> }
  readonly done: Promise<void>
  readonly settle: () => void
  reservedForReset: boolean
  finishing?: Promise<void>
  retirement?: Promise<void>
  executionHandle?: { agent: Agent; dispose?: () => Promise<void> }
}

interface TestHost {
  readonly ctx: { readonly sessions: { readonly flush: (session: unknown) => Promise<void> } }
  readonly config: Config
  readonly inFlight: Map<string, TestOperation>
  readonly executionAgent: (operation: TestOperation) => Promise<Agent>
  automaticOrchestrator: (
    agent: Agent,
    workspace: { readonly projectRoot: string },
    signal?: AbortSignal,
  ) => { drive: () => Promise<BidTaskState> }
}

describe('Bid Host stage reset', () => {
  it('cancels and drains running work before clearing every S3 checkpoint', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-bid-reset-'))
    const session = ctx.sessions.create(SessionId('bid-reset-running'), { meta: { cwd, agentPreset: 'bid' } })
    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
    session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })

    const projectRoot = join(cwd, '.bid-harness')
    const resetPaths = [
      'analysis/scoring-response-points.candidate.json',
      'analysis/scoring-response-points.json',
      'outline/generation-inputs.json',
      'outline/outline.json',
      'outline/quality-report.json',
      'outline/draft.json',
    ].map(path => join(projectRoot, path))
    await Promise.all(resetPaths.map(async (path) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '{}\n')
    }))

    const workspace = new BidWorkspace(cwd)
    await checkpointBidProjectState(workspace, session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
    const key = process.platform === 'win32' ? realpathSync(cwd).toLowerCase() : realpathSync(cwd)
    const prior = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    idle.resolve(undefined)
    const executionIdle = Promise.withResolvers<undefined>()
    const executionCancel = vi.fn()
    const executionAgent = {
      cancel: executionCancel,
      whenIdle: vi.fn(() => executionIdle.promise),
    } as unknown as Agent
    const operation: TestOperation = {
      session, workspace, key, ready: true,
      controller: new AbortController(),
      runs: { retire: vi.fn(async () => {}) },
      done: prior.promise,
      settle: () => { prior.resolve(undefined) },
      reservedForReset: false,
      executionHandle: { agent: executionAgent },
    }
    const cancel = vi.fn()
    const agent = {
      id: session.id,
      session,
      inject: vi.fn(),
      cancel,
      whenIdle: vi.fn(() => idle.promise),
      inbox: { clear: vi.fn() },
    } as unknown as Agent
    const flush = vi.fn(async () => {})
    const drivenState: BidTaskState = { stage: 'outline_generation', status: 'waiting_user', run: null }
    const drive = vi.fn(async () => drivenState)
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: {
        on: vi.fn(() => () => {}),
        fiber: ctx.fiber,
        get: vi.fn(() => undefined),
        agents: { get: () => agent },
        sessions: { flush, list: () => [session] },
        userQuestions: { ask: vi.fn() },
        logger: { warn: vi.fn() },
      },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        docxTemplateMaxBytes: 300 * 1024 * 1024,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, chapterWritingCompletionRepairRounds: 1,
        wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120000, trustedHosts: [], webSearchEnabled: true, bidderName: '',
      } satisfies Config,
      inFlight: new Map([[key, operation]]),
      docxInFlight: new Set(),
      pendingRunDecisions: new Map(),
      pendingWritingQuestions: new Map(),
      processingWritingPlans: new Map(),
      writingEntryStops: new Map(),
      unsavedWritingAnswers: new Map(),
      executionAgent: vi.fn(async () => agent),
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    await expect(BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'chapter_writing',
    )).rejects.toMatchObject({ code: 'BID_STAGE_RESET_NOT_ALLOWED' })

    const reset = BidHostRuntime.prototype.resetStage.call(host as unknown as BidHostRuntime, agent, 'outline_generation')
    await vi.waitFor(() => { expect(executionCancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'bid-stage-reset' }) })
    expect(operation.controller.signal.aborted).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    expect(agent.whenIdle).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()
    await expect(BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'outline_generation',
    )).rejects.toMatchObject({ code: 'BID_OPERATION_IN_PROGRESS' })

    prior.resolve(undefined)
    executionIdle.resolve(undefined)
    await expect(reset).resolves.toEqual({ stage: 'outline_generation', status: 'ready', run: null })
    expect(drive).not.toHaveBeenCalled()
    expect(host.inFlight.has(key)).toBe(true)
    expect(session.events.findLast(event => event.type === 'bid.task.changed')).toMatchObject({
      type: 'bid.task.changed', data: { state: { stage: 'outline_generation', status: 'ready', run: null } },
    })
    expect(flush).toHaveBeenCalledWith(session)
    expect(session.events.some(event => event.type === 'bid.run.decision.required')).toBe(false)
    for (const path of resetPaths) await expect(access(path)).rejects.toThrow()
    await vi.waitFor(() => { expect(drive).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(host.inFlight.has(key)).toBe(false) })
  })

  it('returns the committed reset before dispatching work and keeps its execution agent alive until drive settles', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-bid-reset-lifetime-'))
    const session = ctx.sessions.create(SessionId('bid-reset-lifetime'), { meta: { cwd, agentPreset: 'bid' } })
    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
    session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
    await checkpointBidProjectState(new BidWorkspace(cwd), session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))

    const agent = {
      id: session.id,
      session,
      inject: vi.fn(),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      inbox: { clear: vi.fn() },
    } as unknown as Agent
    const driveGate = Promise.withResolvers<BidTaskState>()
    const drive = vi.fn(() => driveGate.promise)
    const dispose = vi.fn(async () => {})
    const executionAgent = vi.fn(async (operation: TestOperation) => {
      operation.executionHandle = { agent, dispose }
      return agent
    })
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: {
        on: vi.fn(() => () => {}),
        fiber: ctx.fiber,
        get: vi.fn(() => undefined),
        agents: { get: () => agent },
        sessions: { flush: vi.fn(async () => {}), list: () => [session] },
        userQuestions: { ask: vi.fn(async () => ({ answers: [] })) },
        logger: { warn: vi.fn() },
      },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        docxTemplateMaxBytes: 300 * 1024 * 1024,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, chapterWritingCompletionRepairRounds: 1,
        wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120000, trustedHosts: [], webSearchEnabled: true, bidderName: '',
      } satisfies Config,
      inFlight: new Map(),
      docxInFlight: new Set(),
      pendingRunDecisions: new Map(),
      pendingWritingQuestions: new Map(),
      processingWritingPlans: new Map(),
      writingEntryStops: new Map(),
      unsavedWritingAnswers: new Map(),
      executionAgent,
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    const resetting = BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'outline_generation',
    )
    await expect(resetting).resolves.toEqual({ stage: 'outline_generation', status: 'ready', run: null })
    expect(executionAgent).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()
    expect(host.inFlight.values().next().value).toMatchObject({ reservedForReset: false })

    await vi.waitFor(() => { expect(drive).toHaveBeenCalledOnce() })
    expect(dispose).not.toHaveBeenCalled()

    const drivenState: BidTaskState = { stage: 'outline_generation', status: 'waiting_user', run: null }
    driveGate.resolve(drivenState)
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
    expect(host.inFlight.size).toBe(0)
  })

  it('waits for an operation already finishing instead of retiring children through its released parent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-bid-reset-finishing-'))
    const session = ctx.sessions.create(SessionId('bid-reset-finishing'), { meta: { cwd, agentPreset: 'bid' } })
    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
    await checkpointBidProjectState(new BidWorkspace(cwd), session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))

    const key = process.platform === 'win32' ? realpathSync(cwd).toLowerCase() : realpathSync(cwd)
    const finished = Promise.withResolvers<undefined>()
    const retire = vi.fn(async () => {
      throw new Error('selected child teardown requires the exact live parent agent')
    })
    const agent = {
      id: session.id,
      session,
      inject: vi.fn(),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      inbox: { clear: vi.fn() },
    } as unknown as Agent
    const prior: TestOperation = {
      session,
      workspace: new BidWorkspace(cwd),
      key,
      ready: true,
      controller: new AbortController(),
      runs: { retire },
      done: finished.promise,
      settle: () => { finished.resolve(undefined) },
      reservedForReset: false,
      finishing: finished.promise,
      executionHandle: { agent },
    }
    const drive = vi.fn(async (): Promise<BidTaskState> => ({
      stage: 'outline_generation', status: 'waiting_user', run: null,
    }))
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: {
        on: vi.fn(() => () => {}),
        fiber: ctx.fiber,
        get: vi.fn(() => undefined),
        agents: { get: () => agent },
        sessions: { flush: vi.fn(async () => {}), list: () => [session] },
        userQuestions: { ask: vi.fn(async () => ({ answers: [] })) },
        logger: { warn: vi.fn() },
      },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        docxTemplateMaxBytes: 300 * 1024 * 1024,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, chapterWritingCompletionRepairRounds: 1,
        wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120000, trustedHosts: [], webSearchEnabled: true, bidderName: '',
      } satisfies Config,
      inFlight: new Map([[key, prior]]),
      docxInFlight: new Set(),
      pendingRunDecisions: new Map(),
      pendingWritingQuestions: new Map(),
      processingWritingPlans: new Map(),
      writingEntryStops: new Map(),
      unsavedWritingAnswers: new Map(),
      executionAgent: vi.fn(async () => agent),
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    const resetting = BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'outline_generation',
    )
    await Promise.resolve()
    expect(retire).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()

    finished.resolve(undefined)
    await expect(resetting).resolves.toEqual({ stage: 'outline_generation', status: 'ready', run: null })
    await vi.waitFor(() => { expect(drive).toHaveBeenCalledOnce() })
  })

  it.each(BID_STAGES.filter(stage => stage !== 'docx_export'))('clears %s and applies its fixed restart policy', async (stage) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-bid-reset-context-'))
    const session = ctx.sessions.create(SessionId(`bid-reset-context-${stage}`), { meta: { cwd, agentPreset: 'bid' } })
    const messages = BID_STAGES.map((candidate) => {
      session.append('bid.stage.started', { stage: candidate, status: 'running' })
      const message = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${candidate} context` }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
      }), { surfaceOp: 'append' })
      if (candidate !== 'docx_export') session.append('bid.stage.completed', { stage: candidate, status: 'completed', artifacts: [] })
      return message
    })
    await checkpointBidProjectState(new BidWorkspace(cwd), session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
    const stageIndex = BID_STAGES.indexOf(stage)
    const clear = vi.fn()
    const cancel = vi.fn()
    const agent = {
      id: session.id,
      session,
      cancel,
      whenIdle: vi.fn(async () => {}),
      inbox: { clear },
    } as unknown as Agent
    const drivenState: BidTaskState = { stage, status: 'waiting_user', run: null }
    const drive = vi.fn(async () => drivenState)
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: {
        on: vi.fn(() => () => {}),
        fiber: ctx.fiber,
        get: vi.fn(() => undefined),
        agents: { get: () => agent },
        sessions: { flush: vi.fn(async () => {}), list: () => [session] },
        userQuestions: { ask: vi.fn(async () => ({ answers: [] })) },
        logger: { warn: vi.fn() },
      },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        docxTemplateMaxBytes: 300 * 1024 * 1024,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, chapterWritingCompletionRepairRounds: 1,
        wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120000, trustedHosts: [], webSearchEnabled: true, bidderName: '',
      } satisfies Config,
      inFlight: new Map(),
      docxInFlight: new Set(),
      pendingRunDecisions: new Map(),
      pendingWritingQuestions: new Map(),
      processingWritingPlans: new Map(),
      writingEntryStops: new Map(),
      unsavedWritingAnswers: new Map(),
      executionAgent: vi.fn(async () => agent),
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    const reset = BidHostRuntime.prototype.resetStage.call(host as unknown as BidHostRuntime, agent, stage)
    await expect(reset).resolves.toEqual(stage === 'file_intake' || stage === 'chapter_writing'
      ? drivenState
      : { stage, status: 'ready', run: null })
    expect(session.surface.nodes).toEqual([
      ...messages.slice(0, stageIndex).map(message => message.seq),
      session.surface.nodes.at(-1),
    ])
    const resetContext = session.events.findLast(event => event.type === 'user/message')
    expect(resetContext).toMatchObject({
      data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice' } },
      sourceEventSeqs: messages.slice(stageIndex).map(message => message.seq),
    })
    expect(clear).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()
    if (stage !== 'file_intake' && stage !== 'chapter_writing') {
      await vi.waitFor(() => { expect(drive).toHaveBeenCalledOnce() })
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
    }
  })
})
