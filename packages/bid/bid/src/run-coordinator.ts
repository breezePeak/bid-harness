import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  BidRunData, BidRunNotice, BidRunProgressInput, BidRunResumeIdentity,
  BidRunSuspensionCause, BidTaskFailure, BidWorkDescriptor,
} from './control-plane-contract.ts'
import { publishBidBatch, type BidPublicationLease } from './publication-batch.ts'
import { bidRunProgressSchema } from './runtime-state.ts'
import { sanitizeBidErrorText } from './safe-error.ts'

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

/** Run-owned asynchronous work that must stop before suspension is durable. */
export interface BidRunActivityScope {
  /** Admit and start one asynchronous activity. */
  track<T>(activity: () => Promise<T>): Promise<T>
  /** Reject new activities while allowing admitted work to settle. */
  retire(): void
  /** Wait for every admitted activity to settle. */
  whenDrained(): Promise<void>
}

class RunActivityScope implements BidRunActivityScope {
  private retired = false
  private readonly active = new Set<Promise<unknown>>()
  private drained = Promise.withResolvers<void>()

  track<T>(activity: () => Promise<T>): Promise<T> {
    if (this.retired) throw new Error('BID_RUN_RETIRED')
    const observed = Promise.resolve().then(activity).finally(() => {
      this.active.delete(observed)
      if (this.retired && this.active.size === 0) this.drained.resolve()
    })
    this.active.add(observed)
    return observed
  }

  retire(): void {
    this.retired = true
    if (this.active.size === 0) this.drained.resolve()
  }

  whenDrained(): Promise<void> {
    return this.active.size === 0 ? Promise.resolve() : this.drained.promise
  }
}

interface CommitIdentity {
  readonly runId: string
  readonly epoch: number
  readonly controlRevision: number
  readonly signal: AbortSignal
}

interface CommitGate {
  retired: boolean
  inFlight: number
  readonly drained: PromiseWithResolvers<void>
}

function createCommitGate(): CommitGate {
  return { retired: false, inFlight: 0, drained: Promise.withResolvers<void>() }
}

/** Short-lived writer admitted before its owning Run retires. */
export interface BidCommitLease {
  /** Atomically replace one formal text artifact. */
  writeText(path: string, value: string): Promise<void>
  /** Atomically replace one formal JSON artifact. */
  writeJson(path: string, value: unknown): Promise<void>
  /** Atomically replace one formal binary artifact. */
  writeBytes(path: string, value: Uint8Array): Promise<void>
  /** Remove one formal artifact. */
  remove(path: string, recursive?: boolean): Promise<void>
}

/**
 * The only Run-owned authority that may publish formal project artifacts.
 * Retiring the scope denies new leases, while an already admitted atomic write
 * finishes before suspension can become durable.
 */
export class BidCommitScope {
  constructor(
    private readonly identity: CommitIdentity,
    private readonly readProjectRevision: () => number,
    private readonly publication?: { readonly workspaceRoot: string; readonly projectRoot: string },
    private readonly gate: CommitGate = createCommitGate(),
  ) {}

  /**
   * Create a path-confined writer for this Run's private working project.
   * @param publication - Workspace and project roots that confine every write.
   * @returns Commit scope sharing this Run's retirement gate.
   */
  forPublication(publication: { readonly workspaceRoot: string; readonly projectRoot: string }): BidCommitScope {
    return new BidCommitScope(this.identity, this.readProjectRevision, publication, this.gate)
  }

  /** Reject later publications without interrupting an admitted atomic replace. */
  retire(): void {
    this.gate.retired = true
    if (this.gate.inFlight === 0) this.gate.drained.resolve()
  }

  /** Wait until every lease admitted before retirement has settled. */
  whenDrained(): Promise<void> {
    return this.gate.inFlight === 0 ? Promise.resolve() : this.gate.drained.promise
  }

  /**
   * Atomically replace one formal text artifact under a short commit lease.
   * @param path - Absolute artifact path.
   * @param value - Complete next text content.
   */
  writeText(path: string, value: string): Promise<void> {
    return this.withLease(lease => lease.writeText(path, value))
  }

  /**
   * Atomically replace one formal JSON artifact under a short commit lease.
   * @param path - Absolute artifact path.
   * @param value - Complete JSON-compatible value.
   */
  writeJson(path: string, value: unknown): Promise<void> {
    return this.withLease(lease => lease.writeJson(path, value))
  }

  /**
   * Atomically replace one formal binary artifact under a short commit lease.
   * @param path - Absolute artifact path.
   * @param value - Complete next binary content.
   */
  writeBytes(path: string, value: Uint8Array): Promise<void> {
    return this.withLease(lease => lease.writeBytes(path, value))
  }

  /**
   * Remove one formal artifact under a short commit lease.
   * @param path - Absolute artifact path.
   * @param recursive - Whether a directory tree may be removed.
   */
  remove(path: string, recursive: boolean = false): Promise<void> {
    return this.withLease(lease => lease.remove(path, recursive))
  }

  /**
   * Group a minimal multi-file publication beneath one admitted commit lease.
   * @param write - Callback receiving the admitted writer.
   * @returns Callback result after the publication settles.
   */
  publish<T>(write: (lease: BidCommitLease) => Promise<T>): Promise<T> {
    return this.withLease(write)
  }

  /**
   * Assert compatibility for isolated tests; production code must acquire a write method instead.
   * @param identity - Run identity expected to own this scope.
   */
  assertWritable(identity: Pick<CommitIdentity, 'runId' | 'epoch'>): void {
    if (identity.runId !== this.identity.runId || identity.epoch !== this.identity.epoch) throw new Error('BID_RUN_RETIRED')
    this.assertLeaseAvailable()
  }

  private async withLease<T>(write: (lease: BidCommitLease) => Promise<T>): Promise<T> {
    this.assertLeaseAvailable()
    this.gate.inFlight += 1
    try {
      const direct: BidCommitLease = {
        writeText: (path, value) => writeFileAtomic(path, value, { mode: 0o600, dirMode: 0o700 }),
        writeJson: (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
        writeBytes: (path, value) => writeFileAtomic(path, value, { mode: 0o600, dirMode: 0o700 }),
        remove: (path, recursive = false) => rm(path, { recursive, force: true }),
      }
      if (this.publication === undefined) return await write(direct)
      return await publishBidBatch(
        this.publication.workspaceRoot,
        this.publication.projectRoot,
        (lease: BidPublicationLease) => write({
          writeText: lease.writeText.bind(lease),
          writeJson: lease.writeJson.bind(lease),
          writeBytes: lease.writeBytes.bind(lease),
          remove: (path, recursive) => lease.remove(path, recursive),
        }),
      )
    } finally {
      this.gate.inFlight -= 1
      if (this.gate.retired && this.gate.inFlight === 0) this.gate.drained.resolve()
    }
  }

  private assertLeaseAvailable(): void {
    if (this.gate.retired) throw new Error('BID_RUN_RETIRED')
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
  readonly work: BidWorkDescriptor
  readonly resumeOf?: BidRunResumeIdentity | undefined
  readonly signal: AbortSignal
  readonly scheduler: BidRunScheduler
  readonly commits: BidCommitScope
  readonly children: BidChildScope
  readonly activities: BidRunActivityScope
  /** Publish one bounded deterministic milestone for this exact Run. */
  reportProgress(progress: BidRunProgressInput): void
  /** Register a Main-Agent interval that must settle before suspension. */
  bindMainAgent(scope: BidMainAgentScope): () => void
}

interface ActiveRun {
  snapshot: BidRunData
  readonly context: BidRunContext
  readonly controller: AbortController
  readonly eventStart: number
  readonly mainAgents: Set<BidMainAgentScope>
  readonly activities: BidRunActivityScope
}

/** Persist one Run transition before the coordinator grants execution authority. */
export type BidRunCheckpoint = () => Promise<number>

/** Observe a Run after its running checkpoint is durable and before execution starts. */
export type BidRunAdmissionObserver = (run: BidRunContext) => void

/** Owns one-at-a-time Run identity, durable admission, cancellation, and settlement. */
export class BidRunCoordinator {
  private epoch = 0
  private active: ActiveRun | undefined
  private starting = false
  private suspension: Promise<(BidRunData & { cause: BidRunSuspensionCause; error?: BidTaskFailure }) | undefined> | undefined

  constructor(
    private readonly session: Session,
    private readonly scheduler: BidRunScheduler,
    private readonly children: BidChildScope,
    private readonly readProjectRevision: () => number,
    private readonly checkpoint?: BidRunCheckpoint,
    private readonly parentSignal?: AbortSignal,
    private readonly publication?: { readonly workspaceRoot: string; readonly projectRoot: string },
    private readonly executionSessionId?: () => string | undefined,
    private readonly onAdmitted?: BidRunAdmissionObserver,
    private readonly onSuspended?: (notice: BidRunNotice, run: BidRunData & { cause: BidRunSuspensionCause; error?: BidTaskFailure }) => void,
  ) {}

  /** Current live Run, if any. */
  get current(): BidRunContext | undefined { return this.active?.context }

  /**
   * Durably record a running Run before exposing its context to an Executor.
   * @param work - Durable descriptor selecting the exact resume adapter and request.
   * @param resumeOf - Suspended Run identity resumed by this attempt.
   * @returns Admitted Run authority after its running state is durable.
   * @throws when the running state cannot be persisted; no Executor can then start.
   */
  async start(work: BidWorkDescriptor, resumeOf?: BidRunResumeIdentity): Promise<BidRunContext> {
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
    const executionSessionId = this.executionSessionId?.()
    const snapshot: BidRunData = {
      runId: randomUUID(),
      interactionSessionId: this.session.id,
      ...(executionSessionId === undefined ? {} : { executionSessionId }),
      work,
      epoch,
      baseProjectRevision,
      controlRevision,
      ...(resumeOf === undefined ? {} : { resumeOf }),
      startedAt: now,
      updatedAt: now,
    }
    try {
      signal.throwIfAborted()
      const eventStart = this.session.events.length
      this.session.append('bid.run.started', { run: snapshot })
      const persistedRevision = await (this.checkpoint?.() ?? Promise.resolve(this.readProjectRevision()))
      const commits = new BidCommitScope(
        { runId: snapshot.runId, epoch, controlRevision: persistedRevision, signal },
        this.readProjectRevision,
        this.publication,
      )
      const mainAgents = new Set<BidMainAgentScope>()
      const activities = new RunActivityScope()
      const context: BidRunContext = {
        runId: snapshot.runId,
        epoch,
        baseProjectRevision,
        controlRevision: persistedRevision,
        work,
        ...(resumeOf === undefined ? {} : { resumeOf }),
        signal,
        scheduler: this.scheduler,
        commits,
        children: this.children,
        activities,
        reportProgress: (progress) => { this.reportProgress(context, progress) },
        bindMainAgent: (scope) => {
          mainAgents.add(scope)
          return () => { mainAgents.delete(scope) }
        },
      }
      this.active = { snapshot, context, controller, eventStart, mainAgents, activities }
      context.reportProgress({ phase: 'starting', summary: `正在开始 ${work.stage} 阶段` })
      this.onAdmitted?.(context)
      return context
    } catch (error) {
      this.session.append('bid.run.start_failed', { runId: snapshot.runId, epoch })
      throw error
    } finally {
      this.starting = false
    }
  }

  private reportProgress(context: BidRunContext, input: BidRunProgressInput): void {
    const active = this.requireActive(context)
    const progress = bidRunProgressSchema.parse({
      ...input,
      phase: input.phase.slice(0, 32),
      summary: input.summary.slice(0, 240),
      ...input.details === undefined ? {} : {
        details: input.details.slice(0, 5).map(detail => detail.slice(0, 160)),
      },
      updatedAt: Date.now(),
    })
    active.snapshot = { ...active.snapshot, progress, updatedAt: progress.updatedAt }
    this.session.append('bid.run.progress', {
      runId: context.runId,
      epoch: context.epoch,
      stage: context.work.stage,
      progress,
    })
  }

  /**
   * Settle a Run and its owning Workflow transition in one durable checkpoint.
   * @param context - Active Run authority to complete.
   * @param commitOutcome - Synchronous event commit for the task outcome owned by this Run.
   */
  async complete(context: BidRunContext, commitOutcome: () => void): Promise<void> {
    context.commits.assertWritable(context)
    const active = this.requireActive(context)
    active.activities.retire()
    context.commits.retire()
    await active.activities.whenDrained()
    await context.commits.whenDrained()
    this.session.append('bid.run.completed', {
      run: { ...active.snapshot, updatedAt: Date.now() },
    })
    commitOutcome()
    await this.checkpoint?.()
    if (this.active === active) this.active = undefined
  }

  /**
   * Retire, cancel, and drain before publishing a resumable suspension.
   * @param cause - Stable suspension classification.
   * @param error - Sanitized durable failure details when applicable.
   * @returns Suspended snapshot, or undefined when no Run is active.
   */
  suspend(
    cause: BidRunSuspensionCause,
    error?: BidTaskFailure,
  ): Promise<(BidRunData & { cause: BidRunSuspensionCause; error?: BidTaskFailure }) | undefined> {
    if (this.suspension !== undefined) return this.suspension
    const active = this.active
    if (active === undefined) return Promise.resolve(undefined)
    this.suspension = this.settleSuspension(active, cause, error)
    return this.suspension
  }

  private async settleSuspension(
    active: ActiveRun,
    cause: BidRunSuspensionCause,
    error?: BidTaskFailure,
  ): Promise<(BidRunData & { cause: BidRunSuspensionCause; error?: BidTaskFailure }) | undefined> {
    this.scheduler.close()
    active.context.commits.retire()
    active.activities.retire()
    const mainAgents = [...active.mainAgents]
    this.session.append('bid.run.cancelling', {
      runId: active.snapshot.runId,
      epoch: active.snapshot.epoch,
      stage: active.snapshot.work.stage,
    })
    await this.checkpoint?.()
    for (const scope of mainAgents) scope.discardOwnedInbox()
    active.controller.abort({ kind: 'hook', reason: `bid-run-${cause}` })
    for (const scope of mainAgents) scope.cancel()
    await Promise.all(mainAgents.map(scope => scope.whenIdle()))
    await this.children.drain()
    await active.activities.whenDrained()
    await active.context.commits.whenDrained()
    if (this.active !== active) return undefined
    const snapshot: BidRunData & { cause: BidRunSuspensionCause; error?: BidTaskFailure } = {
      ...active.snapshot,
      cause,
      ...(error === undefined ? {} : { error }),
      updatedAt: Date.now(),
    }
    this.active = undefined
    this.session.append('bid.run.suspended', { run: snapshot })
    const superseded = this.session.events.slice(active.eventStart).findLast(event =>
      event.type === 'turn/end' && event.data.reason.kind === 'error')
    const notice: BidRunNotice = {
      noticeId: `run:${snapshot.runId}:suspended`,
      supersedesTurn: superseded?.type === 'turn/end' ? superseded.data.turn : null,
      runId: snapshot.runId,
      stage: snapshot.work.stage,
      kind: cause === 'user_stop' ? 'stopped' : 'interrupted',
      severity: cause === 'user_stop' ? 'info' : 'error',
      message: cause === 'user_stop'
        ? '当前任务已停止，已保存已完成进度。'
        : [error?.code, error?.message, ...error?.issues?.slice(0, 3).map(issue => `${issue.code}: ${issue.message}`) ?? []]
          .filter((value): value is string => value !== undefined)
          .map(sanitizeBidErrorText)
          .join('；') || '当前阶段已中断，已保存已完成进度。',
    }
    this.session.append('bid.run.notice', notice)
    this.onSuspended?.(notice, snapshot)
    await this.checkpoint?.()
    return snapshot
  }

  /** Retire and drain an internal reset or teardown without publishing a user-resumable suspension. */
  async retire(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.scheduler.close()
    active.context.commits.retire()
    active.activities.retire()
    const mainAgents = [...active.mainAgents]
    for (const scope of mainAgents) scope.discardOwnedInbox()
    active.controller.abort({ kind: 'hook', reason: 'bid-run-retired' })
    for (const scope of mainAgents) scope.cancel()
    await Promise.all(mainAgents.map(scope => scope.whenIdle()))
    await this.children.drain()
    await active.activities.whenDrained()
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

/**
 * Build a self-contained Run authority for isolated Executor tests.
 * @param options - Optional identity, cancellation, scheduler, and commit controls.
 * @returns Run authority without Host persistence.
 */
export function createTestBidRunContext(options: {
  readonly signal?: AbortSignal
  readonly scheduler?: BidRunScheduler
  readonly children?: BidChildScope
  readonly controlRevision?: number
  readonly readProjectRevision?: () => number
  readonly work?: BidWorkDescriptor
  readonly resumeOf?: BidRunResumeIdentity
  readonly reportProgress?: (progress: BidRunProgressInput) => void
} = {}): BidRunContext {
  const controlRevision = options.controlRevision ?? 0
  const signal = options.signal ?? new AbortController().signal
  const scheduler = options.scheduler ?? new DirectBidRunScheduler()
  const children = options.children ?? { drain: async () => {} }
  const readProjectRevision = options.readProjectRevision ?? (() => controlRevision)
  const runId = `test-${randomUUID()}`
  const work: BidWorkDescriptor = options.work ?? {
    kind: 'stage_execution', workId: `test-work-${randomUUID()}`, stage: 'file_intake',
    requestRef: 'requests/test.json', requestSha256: '0'.repeat(64), inputFingerprint: '0'.repeat(64),
  }
  const activities = new RunActivityScope()
  return {
    runId,
    epoch: 1,
    baseProjectRevision: controlRevision,
    controlRevision,
    work,
    ...(options.resumeOf === undefined ? {} : { resumeOf: options.resumeOf }),
    signal,
    scheduler,
    commits: new BidCommitScope({ runId, epoch: 1, controlRevision, signal }, readProjectRevision),
    children,
    activities,
    reportProgress: options.reportProgress ?? (() => {}),
    bindMainAgent: () => () => {},
  }
}
