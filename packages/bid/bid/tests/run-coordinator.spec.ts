import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  BidRunCoordinator,
  type BidRunScheduler,
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

describe('BidRunCoordinator', () => {
  it('fences formal commits by Run identity, epoch, and project revision', async () => {
    const { runs, setRevision } = await fixture()
    const run = await runs.start('evidence_mapping')

    expect(() => { run.commits.assertWritable(run) }).not.toThrow()
    setRevision(8)
    expect(() => { run.commits.assertWritable(run) }).toThrow('BID_PROJECT_REVISION_CONFLICT')
  })

  it('coalesces repeated stop requests and keeps the first suspension cause', async () => {
    const { session, scheduler, children, runs } = await fixture()
    const run = await runs.start('chapter_writing')

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

  it('retires commit authority before abort and rejects late completion', async () => {
    const { session, runs } = await fixture()
    const run = await runs.start('outline_generation')

    await runs.suspend('user_stop')

    expect(run.signal.aborted).toBe(true)
    expect(() => { run.commits.assertWritable(run) }).toThrow('BID_RUN_RETIRED')
    expect(() => { runs.complete(run) }).toThrow('BID_RUN_RETIRED')
    expect(session.events.filter(event => event.type === 'bid.run.completed')).toHaveLength(0)
  })

  it('assigns a new identity and epoch to the next completed stage attempt', async () => {
    const { runs } = await fixture()
    const oldRun = await runs.start('tender_analysis')
    runs.complete(oldRun)

    const replacement = await runs.start('outline_generation')

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

    const start = runs.start('evidence_mapping')

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

    await expect(runs.start('evidence_mapping')).rejects.toThrow('project-state-write-failed')

    expect(runs.current).toBeUndefined()
  })

  it('waits for an admitted publication before making suspension observable', async () => {
    const { runs } = await fixture()
    const run = await runs.start('evidence_mapping')
    const target = join(tmpdir(), `dsh-bid-commit-scope-${run.runId}.json`)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const publication = run.commits.publish(async lease => {
      entered.resolve()
      await release.promise
      await lease.writeJson(target, { committed: true })
    })
    await entered.promise

    const stopping = runs.suspend('user_stop')
    let settled = false
    void stopping.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await publication
    await stopping

    await expect(readFile(target, 'utf8')).resolves.toContain('"committed": true')
  })
})
