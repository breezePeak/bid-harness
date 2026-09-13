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
    const run = runs.start('evidence_mapping')

    expect(() => { runs.commits.assertWritable(run) }).not.toThrow()
    setRevision(8)
    expect(() => { runs.commits.assertWritable(run) }).toThrow('BID_PROJECT_REVISION_CONFLICT')
  })

  it('coalesces repeated stop requests and keeps the first suspension cause', async () => {
    const { session, scheduler, children, runs } = await fixture()
    const run = runs.start('chapter_writing')

    const first = runs.suspend('user_stop')
    const second = runs.suspend('executor_error', { message: 'late failure' })

    await expect(second).resolves.toMatchObject({ runId: run.runId, status: 'suspended', cause: 'user_stop' })
    await first
    expect(scheduler.closed).toBe(true)
    expect(children.drain).toHaveBeenCalledOnce()
    expect(session.events.filter(event => event.type === 'bid.run.suspended')).toHaveLength(1)
  })

  it('retires commit authority before abort and rejects late completion', async () => {
    const { session, runs } = await fixture()
    const run = runs.start('outline_generation')

    await runs.suspend('user_stop')

    expect(run.signal.aborted).toBe(true)
    expect(() => { runs.commits.assertWritable(run) }).toThrow('BID_RUN_RETIRED')
    expect(() => { runs.complete(run) }).toThrow('BID_RUN_RETIRED')
    expect(session.events.filter(event => event.type === 'bid.run.completed')).toHaveLength(0)
  })

  it('assigns a new identity and epoch to the next completed stage attempt', async () => {
    const { runs } = await fixture()
    const oldRun = runs.start('tender_analysis')
    runs.complete(oldRun)

    const replacement = runs.start('outline_generation')

    expect(replacement.runId).not.toBe(oldRun.runId)
    expect(replacement.epoch).toBe(oldRun.epoch + 1)
    expect(() => { runs.commits.assertWritable(oldRun) }).toThrow('BID_RUN_RETIRED')
    expect(() => { runs.commits.assertWritable(replacement) }).not.toThrow()
  })
})
