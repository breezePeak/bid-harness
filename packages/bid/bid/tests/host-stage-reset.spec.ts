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
  readonly done: Promise<void>
  readonly settle: () => void
  reservedForReset: boolean
}

interface TestHost {
  readonly ctx: { readonly sessions: { readonly flush: (session: unknown) => Promise<void> } }
  readonly config: Config
  readonly inFlight: Map<string, TestOperation>
  automaticOrchestrator: (
    agent: Agent,
    workspace: { readonly projectRoot: string },
    signal?: AbortSignal,
  ) => { drive: () => Promise<BidRuntimeState> }
}

describe('Bid Host stage reset', () => {
  it('cancels and drains running work before cleanup and rejects another reset', async () => {
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

    const evidencePath = join(cwd, '.bid-harness', 'analysis', 'evidence-map.json')
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, '{}\n')

    const workspace = new BidWorkspace(cwd)
    await checkpointBidProjectState(workspace, session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE))
    const key = process.platform === 'win32' ? realpathSync(cwd).toLowerCase() : realpathSync(cwd)
    const prior = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    const operation: TestOperation = {
      session, workspace, key, ready: true,
      controller: new AbortController(),
      done: prior.promise,
      settle: () => prior.resolve(undefined),
      reservedForReset: false,
    }
    const cancel = vi.fn()
    const agent = {
      id: session.id,
      session,
      cancel,
      whenIdle: vi.fn(() => idle.promise),
      inbox: { clear: vi.fn() },
    } as unknown as Agent
    const flush = vi.fn(async () => {})
    const drive = vi.fn(async (): Promise<BidRuntimeState> => {
      await expect(access(evidencePath)).rejects.toThrow()
      expect(session.events.at(-1)).toMatchObject({ type: 'bid.stage.reset', data: { stage: 'evidence_mapping' } })
      return { stage: 'evidence_mapping', status: 'waiting_user' }
    })
    let resetSignal: AbortSignal | undefined
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: { sessions: { flush, list: () => [session] } },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, trustedHosts: [],
      } satisfies Config,
      inFlight: new Map([[key, operation]]),
      automaticOrchestrator: (_agent: Agent, _workspace: { readonly projectRoot: string }, signal?: AbortSignal) => {
        resetSignal = signal
        return { drive }
      },
    }) as TestHost

    await expect(BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'chapter_writing',
    )).rejects.toMatchObject({ code: 'BID_STAGE_RESET_NOT_ALLOWED' })

    const reset = BidHostRuntime.prototype.resetStage.call(host as unknown as BidHostRuntime, agent, 'evidence_mapping')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'bid-stage-reset' }))
    expect(operation.controller.signal.aborted).toBe(true)
    expect(drive).not.toHaveBeenCalled()
    await expect(BidHostRuntime.prototype.resetStage.call(
      host as unknown as BidHostRuntime,
      agent,
      'evidence_mapping',
    )).rejects.toMatchObject({ code: 'BID_OPERATION_IN_PROGRESS' })

    prior.resolve(undefined)
    idle.resolve(undefined)
    await expect(reset).resolves.toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
    expect(resetSignal).toBeDefined()
    expect(resetSignal?.aborted).toBe(false)
    expect(flush).toHaveBeenCalledWith(session)
    expect(host.inFlight.has(key)).toBe(false)
  })

  it.each(BID_STAGES)('clears %s and later-stage model context before rerunning', async (stage) => {
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
    const agent = {
      id: session.id,
      session,
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      inbox: { clear },
    } as unknown as Agent
    const drive = vi.fn(async (): Promise<BidRuntimeState> => {
      expect(session.surface.nodes).toEqual([
        ...messages.slice(0, stageIndex).map(message => message.seq),
        session.surface.nodes.at(-1),
      ])
      const resetContext = session.events.findLast(event => event.type === 'user/message')
      expect(resetContext).toMatchObject({
        data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice' } },
        sourceEventSeqs: messages.slice(stageIndex).map(message => message.seq),
      })
      return { stage, status: 'waiting_user' }
    })
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: { sessions: { flush: vi.fn(async () => {}), list: () => [session] } },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, trustedHosts: [],
      } satisfies Config,
      inFlight: new Map(),
      automaticOrchestrator: () => ({ drive }),
    }) as TestHost

    await expect(BidHostRuntime.prototype.resetStage.call(host as unknown as BidHostRuntime, agent, stage))
      .resolves.toEqual({ stage, status: 'waiting_user' })
    expect(clear).toHaveBeenCalledOnce()
  })
})
