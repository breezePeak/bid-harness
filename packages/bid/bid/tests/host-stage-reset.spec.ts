import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidHostRuntime,
  type BidRuntimeState,
  type Config,
} from '@deepseek-ai/dsh-bid'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

interface TestOperation {
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
    workspace: { readonly sessionRoot: string },
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

    const evidencePath = join(cwd, '.bid-harness', 'sessions', session.id, 'analysis', 'evidence-map.json')
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, '{}\n')

    const prior = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    const operation: TestOperation = {
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
    } as unknown as Agent
    const flush = vi.fn(async () => {})
    const drive = vi.fn(async (): Promise<BidRuntimeState> => {
      await expect(access(evidencePath)).rejects.toThrow()
      expect(session.events.at(-1)).toMatchObject({ type: 'bid.stage.reset', data: { stage: 'evidence_mapping' } })
      return { stage: 'evidence_mapping', status: 'waiting_user' }
    })
    let resetSignal: AbortSignal | undefined
    const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
      ctx: { sessions: { flush } },
      config: {
        allowedExtensions: ['.pdf'], maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096,
        modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
        chapterWritingMaxConcurrency: 1, trustedHosts: [],
      } satisfies Config,
      inFlight: new Map([[session.id, operation]]),
      automaticOrchestrator: (_agent: Agent, _workspace: { readonly sessionRoot: string }, signal?: AbortSignal) => {
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
    expect(host.inFlight.has(session.id)).toBe(false)
  })
})
