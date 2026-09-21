import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  BID_STAGES, BidWorkspace, checkpointBidProjectState, BID_INITIAL_RUNTIME_STATE, reduceBidRuntimeState,
  BidHostRuntime,
  type BidRuntimeState,
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
  executionHandle?: { agent: Agent }
}

interface TestHost {
  readonly ctx: { readonly sessions: { readonly flush: (session: unknown) => Promise<void> } }
  readonly config: Config
  readonly inFlight: Map<string, TestOperation>
  automaticOrchestrator: (
    agent: Agent,
    workspace: { readonly projectRoot: string },
    signal?: AbortSignal,
  ) => { drive?: () => Promise<BidRuntimeState>; startResetStage?: () => Promise<BidRuntimeState> }
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
    await checkpointBidProjectState(workspace, session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE))
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
    const drive = vi.fn()
    const startStage = vi.fn(async () => ({ ok: true, value: { stage: 'outline_generation', status: 'running' } }))
    const ask = vi.fn(async ({ questions }: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: questions[0]!.id, selected: ['重新执行当前阶段'] }],
    }))
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: {
        on: vi.fn(() => () => {}),
        fiber: ctx.fiber,
        get: vi.fn(() => undefined),
        agents: { get: () => agent },
        sessions: { flush, list: () => [session] },
        userQuestions: { ask },
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
      automaticOrchestrator: () => ({ drive }),
      startStage,
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
    await expect(reset).resolves.toEqual({ stage: 'outline_generation', status: 'waiting_start' })
    for (const path of resetPaths) await expect(access(path)).rejects.toThrow()
    expect(session.events.findLast(event => event.type === 'bid.stage.reset')).toMatchObject({
      type: 'bid.stage.reset', data: { stage: 'outline_generation', status: 'waiting_start' },
    })
    expect(drive).not.toHaveBeenCalled()
    expect(flush).toHaveBeenCalledWith(session)
    expect(host.inFlight.has(key)).toBe(false)
    await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(startStage).toHaveBeenCalledWith(session) })
    expect(session.events.some(event => event.type === 'bid.run.decision.required')).toBe(true)
    expect(session.events.some(event => event.type === 'bid.run.decision.received')).toBe(true)
  })

  it.each(BID_STAGES.filter(stage => stage !== 'docx_export'))('clears %s and later-stage model context before waiting for start', async (stage) => {
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
    await checkpointBidProjectState(new BidWorkspace(cwd), session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE))
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
    const drive = vi.fn()
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
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    await expect(BidHostRuntime.prototype.resetStage.call(host as unknown as BidHostRuntime, agent, stage))
      .resolves.toEqual({ stage, status: stage === 'file_intake' ? 'pending' : 'waiting_start' })
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
  })
})
