import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidResumePolicy, BidRunResumeIdentity, BidRunSnapshot, BidRunSuspensionCause, BidStage } from './control-plane-contract.ts'

/** Run-owned admission gate for model tasks and child creation. */
export interface BidRunScheduler {
  /** Whether task admission is temporarily held. */
  paused(): boolean
  /** Permanently reject new work for the current Run. */
  close(): void
  /** Wait for admission and reject once the Run closes or aborts. */
  waitUntilRunnable(signal: AbortSignal): Promise<void>
}

/** Run-owned child forest convergence. */
export interface BidChildScope {
  /** Stop and drain every child admitted by the current Run. */
  drain(): Promise<void>
}

/** Main-Agent work and its private inbox entries owned by one Run. */
export interface BidMainAgentScope {
  /** Abort only the active Main-Agent driver while preserving user messages. */
  cancel(): void
  /** Wait until the Main Agent has no active turn left. */
  whenIdle(): Promise<void>
  /** Discard only private messages registered by this Run. */
  discardOwnedInbox(): void
}

interface CommitIdentity {
  readonly runId: string
  readonly epoch: number
  readonly controlRevision: number
  readonly signal: AbortSignal
}

export interface BidCommitLease {
  /** Atomically replace one formal text artifact. */
  writeText(path: string, value: string): Promise<void>
  /** Atomically replace one formal JSON artifact. */
  writeJson(path: string, value: unknown): Promise<void>
  /** Atomically replace one formal binary artifact. */
  writeBytes(path: string, value: Uint8Array): Promise<void>
  /** Remove one formal artifact. */
  remove(path: string): Promise<void>
}

/**
 * The only Run-owned authority that may publish formal project artifacts.
 * Retiring the scope denies new leases, while an already admitted atomic write
 * finishes before suspension can become durable.
 */
export class BidCommitScope {
  private retired = false
  private inFlight = 0
  private readonly drained = Promise.withResolvers<void>()

  constructor(
    private readonly identity: CommitIdentity,
    private readonly readProjectRevision: () => number,
  ) {}

  /** Reject later publications without interrupting an admitted atomic replace. */
  retire(): void {
    this.retired = true
    if (this.inFlight === 0) this.drained.resolve()
  }

  /** Wait until every lease admitted before retirement has settled. */
  whenDrained(): Promise<void> {
    return this.inFlight === 0 ? Promise.resolve() : this.drained.promise
  }

  /** Atomically replace one formal text artifact under a short commit lease. */
  writeText(path: string, value: string): Promise<void> {
    return this.withLease(lease => lease.writeText(path, value))
  }

  /** Atomically replace one formal JSON artifact under a short commit lease. */
  writeJson(path: string, value: unknown): Promise<void> {
    return this.withLease(lease => lease.writeJson(path, value))
  }

  /** Atomically replace one formal binary artifact under a short commit lease. */
  writeBytes(path: string, value: Uint8Array): Promise<void> {
    return this.withLease(lease => lease.writeBytes(path, value))
  }

  /** Remove one formal artifact under a short commit lease. */
  remove(path: string): Promise<void> {
    return this.withLease(lease => lease.remove(path))
  }

  /** Group a minimal multi-file publication beneath one admitted commit lease. */
  publish<T>(write: (lease: BidCommitLease) => Promise<T>): Promise<T> {
    return this.withLease(write)
  }

  /** Compatibility assertion for isolated tests; production code must acquire a write method instead. */
  assertWritable(identity: Pick<CommitIdentity, 'runId' | 'epoch'>): void {
    if (identity.runId !== this.identity.runId || identity.epoch !== this.identity.epoch) throw new Error('BID_RUN_RETIRED')
    this.assertLeaseAvailable()
  }

  private async withLease<T>(write: (lease: BidCommitLease) => Promise<T>): Promise<T> {
    this.assertLeaseAvailable()
    this.inFlight += 1
    try {
      return await write({
        writeText: (path, value) => writeFileAtomic(path, value, { mode: 0o600, dirMode: 0o700 }),
        writeJson: (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
        writeBytes: (path, value) => writeFileAtomic(path, value, { mode: 0o600, dirMode: 0o700 }),
        remove: path => rm(path, { force: true }),
      })
    } finally {
      this.inFlight -= 1
      if (this.retired && this.inFlight === 0) this.drained.resolve()
    }
  }

  private assertLeaseAvailable(): void {
    if (this.retired) throw new Error('BID_RUN_RETIRED')
    this.identity.signal.throwIfAborted()
    if (this.readProjectRevision() !== this.identity.controlRevision) throw new Error('BID_PROJECT_REVISION_CONFLICT')
  }
}

/** Mandatory execution authority passed to every automatic stage Executor. */
export interface BidRunContext {
  readonly runId: string
  readonly epoch: number
  readonly baseProjectRevision: number
  readonly controlRevision: number
  readonly resumeOf?: BidRunResumeIdentity | undefined
  readonly resumePolicy?: BidResumePolicy | undefined
  readonly signal: AbortSignal
  readonly scheduler: BidRunScheduler
  readonly commits: BidCommitScope
  readonly children: BidChildScope
  /** Register a Main-Agent interval that must settle before suspension. */
  bindMainAgent(scope: BidMainAgentScope): () => void
}

interface ActiveRun {
  readonly snapshot: BidRunSnapshot
  readonly context: BidRunContext
  readonly controller: AbortController
  readonly mainAgents: Set<BidMainAgentScope>
}

/** Persist one Run transition before the coordinator grants execution authority. */
export type BidRunCheckpoint = () => Promise<number>

/** Owns one-at-a-time Run identity, durable admission, cancellation, and settlement. */
export class BidRunCoordinator {
  private epoch = 0
  private active: ActiveRun | undefined
  private starting = false
  private suspension: Promise<BidRunSnapshot | undefined> | undefined

  constructor(
    private readonly session: Session,
    private readonly scheduler: BidRunScheduler,
    private readonly children: BidChildScope,
    private readonly readProjectRevision: () => number,
    private readonly checkpoint?: BidRunCheckpoint,
    private readonly parentSignal?: AbortSignal,
  ) {}

  /** Current live Run, if any. */
  get current(): BidRunContext | undefined { return this.active?.context }

  /**
   * Durably record a running Run before exposing its context to an Executor.
   * @throws when the running state cannot be persisted; no Executor can then start.
   */
  async start(stage: BidStage, resumeOf?: BidRunResumeIdentity, resumePolicy?: BidResumePolicy): Promise<BidRunContext> {
    if (this.active !== undefined || this.starting) throw new Error('BID_RUN_ALREADY_ACTIVE')
    this.suspension = undefined
    this.starting = true
    const controller = new AbortController()
    const signal = this.parentSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, this.parentSignal])
    const epoch = ++this.epoch
    const baseProjectRevision = this.readProjectRevision()
    // The checkpoint writes the running snapshot as the next project revision.
    // A coordinator without a persistence callback is only used by embedders and
    // isolated tests, where the current revision remains its authority.
    const controlRevision = this.checkpoint === undefined ? baseProjectRevision : baseProjectRevision + 1
    const now = Date.now()
    const snapshot: BidRunSnapshot = {
      runId: randomUUID(),
      stage,
      epoch,
      baseProjectRevision,
      controlRevision,
      status: 'running',
      ...(resumeOf === undefined ? {} : { resumeOf }),
      ...(resumePolicy === undefined ? {} : { resumePolicy }),
      startedAt: now,
      updatedAt: now,
    }
    try {
      this.session.append('bid.run.started', { run: snapshot })
      const persistedRevision = await (this.checkpoint?.() ?? Promise.resolve(this.readProjectRevision()))
      const commits = new BidCommitScope({ runId: snapshot.runId, epoch, controlRevision: persistedRevision, signal }, this.readProjectRevision)
      const mainAgents = new Set<BidMainAgentScope>()
      const context: BidRunContext = {
        runId: snapshot.runId,
        epoch,
        baseProjectRevision,
        controlRevision: persistedRevision,
        ...(resumeOf === undefined ? {} : { resumeOf }),
        ...(resumePolicy === undefined ? {} : { resumePolicy }),
        signal,
        scheduler: this.scheduler,
        commits,
        children: this.children,
        bindMainAgent: scope => {
          mainAgents.add(scope)
          return () => { mainAgents.delete(scope) }
        },
      }
      this.active = { snapshot, context, controller, mainAgents }
      return context
    } catch (error) {
      this.session.append('bid.run.start_failed', { runId: snapshot.runId, epoch })
      throw error
    } finally {
      this.starting = false
    }
  }

  /** Settle a Run only while it still owns commit authority. */
  complete(context: BidRunContext): void {
    context.commits.assertWritable(context)
    const active = this.requireActive(context)
    context.commits.retire()
    this.active = undefined
    this.session.append('bid.run.completed', {
      run: { ...active.snapshot, status: 'completed', updatedAt: Date.now() },
    })
  }

  /** Retire, cancel, and drain before publishing a resumable suspension. */
  suspend(
    cause: BidRunSuspensionCause,
    error?: BidRunSnapshot['error'],
  ): Promise<BidRunSnapshot | undefined> {
    if (this.suspension !== undefined) return this.suspension
    const active = this.active
    if (active === undefined) return Promise.resolve(undefined)
    this.suspension = this.settleSuspension(active, cause, error)
    return this.suspension
  }

  private async settleSuspension(
    active: ActiveRun,
    cause: BidRunSuspensionCause,
    error?: BidRunSnapshot['error'],
  ): Promise<BidRunSnapshot | undefined> {
    this.scheduler.close()
    active.context.commits.retire()
    const cancelling: BidRunSnapshot & { status: 'cancelling' } = {
      ...active.snapshot,
      status: 'cancelling',
      ...(error === undefined ? {} : { error }),
      updatedAt: Date.now(),
    }
    this.session.append('bid.run.cancelling', { run: cancelling })
    await this.checkpoint?.()
    for (const scope of active.mainAgents) scope.discardOwnedInbox()
    active.controller.abort({ kind: 'hook', reason: `bid-run-${cause}` })
    for (const scope of active.mainAgents) scope.cancel()
    await this.children.drain()
    await Promise.all([...active.mainAgents].map(scope => scope.whenIdle()))
    await active.context.commits.whenDrained()
    if (this.active !== active) return undefined
    const snapshot: BidRunSnapshot & { status: 'suspended' } = {
      ...cancelling,
      status: 'suspended',
      cause,
      updatedAt: Date.now(),
    }
    this.active = undefined
    this.session.append('bid.run.suspended', { run: snapshot })
    this.session.append('bid.run.notice', {
      noticeId: `run:${snapshot.runId}:suspended`,
      runId: snapshot.runId,
      stage: snapshot.stage,
      kind: cause === 'user_stop' ? 'stopped' : 'interrupted',
      severity: cause === 'user_stop' ? 'info' : 'error',
      message: cause === 'user_stop'
        ? '当前任务已停止，已保存已完成进度。'
        : '当前阶段已中断，已保存已完成进度。',
    })
    await this.checkpoint?.()
    return snapshot
  }

  /** Retire and drain an internal reset or teardown without publishing a user-resumable suspension. */
  async retire(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.scheduler.close()
    active.context.commits.retire()
    for (const scope of active.mainAgents) scope.discardOwnedInbox()
    active.controller.abort({ kind: 'hook', reason: 'bid-run-retired' })
    for (const scope of active.mainAgents) scope.cancel()
    await this.children.drain()
    await Promise.all([...active.mainAgents].map(scope => scope.whenIdle()))
    await active.context.commits.whenDrained()
    if (this.active === active) this.active = undefined
  }

  private requireActive(context: BidRunContext): ActiveRun {
    const active = this.active
    if (active === undefined || active.context !== context) throw new Error('BID_RUN_RETIRED')
    return active
  }
}

/** Open scheduler used by isolated orchestrator tests and non-Host embedders. */
export class DirectBidRunScheduler implements BidRunScheduler {
  paused(): boolean { return false }
  close(): void {}
  waitUntilRunnable(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }
}

/** Build a self-contained Run authority for isolated Executor tests. */
export function createTestBidRunContext(options: {
  readonly signal?: AbortSignal
  readonly scheduler?: BidRunScheduler
  readonly children?: BidChildScope
  readonly controlRevision?: number
  readonly readProjectRevision?: () => number
} = {}): BidRunContext {
  const controlRevision = options.controlRevision ?? 0
  const signal = options.signal ?? new AbortController().signal
  const scheduler = options.scheduler ?? new DirectBidRunScheduler()
  const children = options.children ?? { drain: async () => {} }
  const readProjectRevision = options.readProjectRevision ?? (() => controlRevision)
  const runId = `test-${randomUUID()}`
  return {
    runId,
    epoch: 1,
    baseProjectRevision: controlRevision,
    controlRevision,
    signal,
    scheduler,
    commits: new BidCommitScope({ runId, epoch: 1, controlRevision, signal }, readProjectRevision),
    children,
    bindMainAgent: () => () => {},
  }
}
