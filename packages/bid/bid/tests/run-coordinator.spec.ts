import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  BidRunCoordinator,
  type BidStage,
  type BidRunScheduler,
  type BidWorkDescriptor,
} from '@deepseek-ai/dsh-bid'
import { describe, expect, it, vi } from 'vitest'

class TestScheduler implements BidRunScheduler {
  closed = false
  paused(): boolean { return false }
  close(): void { this.closed = true }
  async waitUntilRunnable(signal: AbortSignal): Promise<void> { signal.throwIfAborted() }
}

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const scheduler = new TestScheduler()
  const children = { drain: vi.fn(async () => {}) }
  let revision = 7
  const runs = new BidRunCoordinator(session, scheduler, children, () => revision)
  return { session, scheduler, children, runs, setRevision: (next: number) => { revision = next } }
}

function work(stage: BidStage): BidWorkDescriptor {
  return {
    kind: 'stage_execution',
    workId: `work-${stage}`,
    stage,
    requestRef: `requests/work-${stage}.json`,
    requestSha256: '1'.repeat(64),
    inputFingerprint: '2'.repeat(64),
  }
}

describe('BidRunCoordinator', () => {
  it('fences formal commits by Run identity, epoch, and project revision', async () => {
    const { runs, setRevision } = await fixture()
    const run = await runs.start(work('evidence_mapping'))

    expect(() => { run.commits.assertWritable(run) }).not.toThrow()
    setRevision(8)
    expect(() => { run.commits.assertWritable(run) }).toThrow('BID_PROJECT_REVISION_CONFLICT')
  })

  it('coalesces repeated stop requests and keeps the first suspension cause', async () => {
    const { session, scheduler, children, runs } = await fixture()
    const run = await runs.start(work('chapter_writing'))

    const first = runs.suspend('user_stop')
    const second = runs.suspend('executor_error', { message: 'late failure' })

    await expect(second).resolves.toMatchObject({ runId: run.runId, status: 'suspended', cause: 'user_stop' })
    await first
    expect(scheduler.closed).toBe(true)
    expect(children.drain).toHaveBeenCalledOnce()
    expect(session.events.filter(event => event.type === 'bid.run.suspended')).toHaveLength(1)
    expect(session.events.find(event => event.type === 'bid.run.notice')).toMatchObject({
      data: { runId: run.runId, kind: 'stopped', severity: 'info' },
    })
  })

  it('publishes one sanitized terminal notice for an executor failure', async () => {
    const { session, runs } = await fixture()
    const run = await runs.start(work('tender_analysis'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PROVIDER_ERROR', message: 'raw' } } })

    await runs.suspend('executor_error', {
      code: 'PROVIDER_ERROR',
      message: 'Authorization: Bearer sk-secret provider response: {"request":"private"}',
      issues: [
        { code: 'UPSTREAM', message: 'api_key=hidden-token request failed' },
        { code: 'ISSUE_2', message: 'second' },
        { code: 'ISSUE_3', message: 'third' },
        { code: 'ISSUE_4', message: 'must stay out of the compact notice' },
      ],
    })

    const notices = session.events.filter(event => event.type === 'bid.run.notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.data.supersedesTurn).toBe(1)
    expect(notices[0]?.data.message).toContain('PROVIDER_ERROR')
    expect(notices[0]?.data.message).toContain('[REDACTED]')
    expect(notices[0]?.data.message).not.toContain('sk-secret')
    expect(notices[0]?.data.message).not.toContain('private')
    expect(notices[0]?.data.message).not.toContain('hidden-token')
    expect(notices[0]?.data.message).not.toContain('ISSUE_4')
    expect(run.signal.aborted).toBe(true)
  })

  it('retires commit authority before abort and rejects late completion', async () => {
    const { session, runs } = await fixture()
    const run = await runs.start(work('outline_generation'))

    await runs.suspend('user_stop')

    expect(run.signal.aborted).toBe(true)
    expect(() => { run.commits.assertWritable(run) }).toThrow('BID_RUN_RETIRED')
    await expect(runs.complete(run)).rejects.toThrow('BID_RUN_RETIRED')
    expect(session.events.filter(event => event.type === 'bid.run.completed')).toHaveLength(0)
  })

  it('assigns a new identity and epoch to the next completed stage attempt', async () => {
    const { runs } = await fixture()
    const oldRun = await runs.start(work('tender_analysis'))
    await runs.complete(oldRun)

    const replacement = await runs.start(work('outline_generation'))

    expect(replacement.runId).not.toBe(oldRun.runId)
    expect(replacement.epoch).toBe(oldRun.epoch + 1)
    expect(() => { oldRun.commits.assertWritable(oldRun) }).toThrow('BID_RUN_RETIRED')
    expect(() => { replacement.commits.assertWritable(replacement) }).not.toThrow()
  })

  it('does not expose execution authority before the running state checkpoint resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const checkpoint = Promise.withResolvers<number>()
    const runs = new BidRunCoordinator(session, new TestScheduler(), { drain: async () => {} }, () => 8, () => checkpoint.promise)

    const start = runs.start(work('evidence_mapping'))

    expect(runs.current).toBeUndefined()
    expect(session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
    checkpoint.resolve(8)
    await expect(start).resolves.toMatchObject({ controlRevision: 8 })
  })

  it('does not expose execution authority when the running state checkpoint fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const runs = new BidRunCoordinator(session, new TestScheduler(), { drain: async () => {} }, () => 7, async () => {
      throw new Error('project-state-write-failed')
    })

    await expect(runs.start(work('evidence_mapping'))).rejects.toThrow('project-state-write-failed')

    expect(runs.current).toBeUndefined()
  })

  it('waits for an admitted publication before making suspension observable', async () => {
    const { runs } = await fixture()
    const run = await runs.start(work('evidence_mapping'))
    const target = join(tmpdir(), `dsh-bid-commit-scope-${run.runId}.json`)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const publication = run.commits.publish(async (lease) => {
      entered.resolve(undefined)
      await release.promise
      await lease.writeJson(target, { committed: true })
    })
    await entered.promise

    const stopping = runs.suspend('user_stop')
    let settled = false
    void stopping.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve(undefined)
    await publication
    await stopping

    await expect(readFile(target, 'utf8')).resolves.toContain('"committed": true')
  })

  it('waits for registered activities before publishing a suspension', async () => {
    const { session, runs } = await fixture()
    const run = await runs.start(work('evidence_mapping'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const activity = run.activities.track(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise

    const stopping = runs.suspend('user_stop')
    await Promise.resolve()
    expect(session.events.some(event => event.type === 'bid.run.suspended')).toBe(false)
    expect(() => run.activities.track(async () => {})).toThrow('BID_RUN_RETIRED')

    release.resolve(undefined)
    await activity
    await stopping
    expect(session.events.filter(event => event.type === 'bid.run.suspended')).toHaveLength(1)
  })

  it('does not release a completed Run until its terminal checkpoint is durable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    let revision = 7
    const checkpoints: Array<PromiseWithResolvers<number>> = []
    const runs = new BidRunCoordinator(
      session,
      new TestScheduler(),
      { drain: async () => {} },
      () => revision,
      () => {
        const checkpoint = Promise.withResolvers<number>()
        checkpoints.push(checkpoint)
        return checkpoint.promise.then((next) => { revision = next; return next })
      },
    )
    const starting = runs.start(work('chapter_writing'))
    checkpoints[0]!.resolve(8)
    const run = await starting

    const completing = runs.complete(run)
    await vi.waitFor(() => {
      expect(session.events.findLast(event => event.type === 'bid.run.completed')).toBeDefined()
      expect(checkpoints).toHaveLength(2)
    })
    expect(runs.current).toBe(run)
    checkpoints[1]!.resolve(9)
    await completing

    expect(runs.current).toBeUndefined()
    expect(revision).toBe(9)
  })

  it('persists the Workflow outcome in the same checkpoint as Run completion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    let revision = 0
    const persisted: string[] = []
    const runs = new BidRunCoordinator(
      session,
      new TestScheduler(),
      { drain: async () => {} },
      () => revision,
      async () => {
        persisted.push(...session.events.slice(persisted.length).map(event => event.type))
        return ++revision
      },
    )
    const run = await runs.start(work('outline_generation'))

    await runs.complete(run, () => {
      session.append('bid.user_confirmation.required', { stage: 'outline_generation', status: 'waiting_user' })
    })

    expect(persisted).toEqual([
      'bid.run.started',
      'bid.run.completed',
      'bid.user_confirmation.required',
    ])
  })
})
