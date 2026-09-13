import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidRunSnapshot, BidRunSuspensionCause, BidStage } from './control-plane-contract.ts'

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

interface CommitIdentity {
  readonly runId: string
  readonly epoch: number
  readonly projectRevision: number
  readonly signal: AbortSignal
}

/** Rejects formal artifact commits from retired or superseded execution attempts. */
export class BidCommitFence {
  private current: CommitIdentity | undefined

  constructor(private readonly readProjectRevision: () => number) {}

  /** Install the sole identity allowed to commit formal project data. */
  activate(identity: CommitIdentity): void { this.current = identity }

  /** Revoke commit authority synchronously before cancellation propagates. */
  retire(runId: string, epoch: number): void {
    if (this.current?.runId === runId && this.current.epoch === epoch) this.current = undefined
  }

  /** Verify identity, project revision, and cancellation immediately before a formal commit. */
  assertWritable(identity: Pick<CommitIdentity, 'runId' | 'epoch'>): void {
    const current = this.current
    if (current === undefined || current.runId !== identity.runId || current.epoch !== identity.epoch) {
      throw new Error('BID_RUN_RETIRED')
    }
    current.signal.throwIfAborted()
    if (this.readProjectRevision() !== current.projectRevision) throw new Error('BID_PROJECT_REVISION_CONFLICT')
  }
}

/** Mandatory execution authority passed to every automatic stage Executor. */
export interface BidRunContext {
  readonly runId: string
  readonly epoch: number
  readonly signal: AbortSignal
  readonly scheduler: BidRunScheduler
  readonly commits: BidCommitFence
  readonly children: BidChildScope
  readonly projectRevision: number
}

interface ActiveRun {
  readonly snapshot: BidRunSnapshot
  readonly context: BidRunContext
  readonly controller: AbortController
}

/** Owns one-at-a-time Run identity, logical retirement, cancellation, and durable settlement. */
export class BidRunCoordinator {
  private epoch = 0
  private active: ActiveRun | undefined
  private suspension: Promise<BidRunSnapshot | undefined> | undefined
  readonly commits: BidCommitFence

  constructor(
    private readonly session: Session,
    private readonly scheduler: BidRunScheduler,
    private readonly children: BidChildScope,
    private readonly readProjectRevision: () => number,
    private readonly parentSignal?: AbortSignal,
  ) {
    this.commits = new BidCommitFence(readProjectRevision)
  }

  /** Current live Run, if any. */
  get current(): BidRunContext | undefined { return this.active?.context }

  /** Start one exact stage attempt and publish its durable identity. */
  start(stage: BidStage): BidRunContext {
    if (this.active !== undefined) throw new Error('BID_RUN_ALREADY_ACTIVE')
    this.suspension = undefined
    const controller = new AbortController()
    const signal = this.parentSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, this.parentSignal])
    const epoch = ++this.epoch
    const projectRevision = this.readProjectRevision()
    const now = Date.now()
    const snapshot: BidRunSnapshot = {
      runId: randomUUID(),
      stage,
      epoch,
      baseProjectRevision: projectRevision,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    const context: BidRunContext = {
      runId: snapshot.runId,
      epoch,
      signal,
      scheduler: this.scheduler,
      commits: this.commits,
      children: this.children,
      projectRevision,
    }
    this.commits.activate({ runId: context.runId, epoch, projectRevision, signal })
    this.active = { snapshot, context, controller }
    this.session.append('bid.run.started', { run: snapshot })
    return context
  }

  /** Settle a Run only while it still owns commit authority. */
  complete(context: BidRunContext): void {
    this.commits.assertWritable(context)
    const active = this.requireActive(context)
    this.commits.retire(context.runId, context.epoch)
    this.active = undefined
    this.session.append('bid.run.completed', {
      run: { ...active.snapshot, status: 'completed', updatedAt: Date.now() },
    })
  }

  /** Retire first, then cancel and drain before persisting a resumable suspension. */
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
    this.commits.retire(active.context.runId, active.context.epoch)
    active.controller.abort({ kind: 'hook', reason: `bid-run-${cause}` })
    await this.children.drain()
    if (this.active !== active) return undefined
    const snapshot: BidRunSnapshot & { status: 'suspended' } = {
      ...active.snapshot,
      status: 'suspended',
      cause,
      ...(error === undefined ? {} : { error }),
      updatedAt: Date.now(),
    }
    this.active = undefined
    this.session.append('bid.run.suspended', { run: snapshot })
    return snapshot
  }

  /** Retire and drain an internal reset or teardown without publishing a user-resumable suspension. */
  async retire(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.scheduler.close()
    this.commits.retire(active.context.runId, active.context.epoch)
    active.controller.abort({ kind: 'hook', reason: 'bid-run-retired' })
    await this.children.drain()
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
