import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidWorkspace,
  buildBidStageTask,
  executeTenderAnalysis,
  renderTenderAnalysisTask,
} from '@deepseek-ai/dsh-bid'

describe('tender-analysis Agent executor', () => {
  it('delivers the StageTask through followup, waits for idle, and restricts tools', async () => {
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const restrict = vi.fn(() => liftRestriction)
    let policy: (exec: { name: string }) => string | undefined = () => undefined
    const guard = vi.fn((next: typeof policy) => {
      policy = next
      return liftGuard
    })
    const resolve = vi.fn(async (path: string) => ({ targetKey: path, displayPath: path }))
    const emit = vi.fn()
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const agent = {
      id: 'session',
      ctx: { tools: { guard, restrict }, fs: { resolve }, emit },
      followup,
      whenIdle,
    } as unknown as Agent
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-executor-')), 'session')
    const task = buildBidStageTask('tender_analysis')

    const result = await executeTenderAnalysis(agent, workspace, task)

    expect(whenIdle).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenCalledWith({ allow: ['grep', 'read', 'write'] })
    expect(guard).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledWith(
      'fs/observed',
      expect.objectContaining({ displayPath: expect.stringContaining('analysis/project.json') }),
      { kind: 'absent' },
      { agent },
    )
    expect(policy({ name: 'read' })).toBeUndefined()
    expect(policy({ name: 'bash' })).toContain('allows only grep, read, write')
    expect(liftGuard).toHaveBeenCalledOnce()
    expect(liftRestriction).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }>; source: unknown }
    expect(message.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' })
    expect(message.content[0]?.text).toContain('首先读取：.bid-harness/sessions/session/manifest.json')
    expect(message.content[0]?.text).toContain('只把 manifest 中 role=tender')
    expect(result.map(artifact => artifact.path)).toEqual(task.requiredArtifacts)
  })

  it('renders dynamic paths without embedding document bodies', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-task-')), 'session')
    const agent = { id: 'session' } as Agent
    const text = renderTenderAnalysisTask(agent, workspace, buildBidStageTask('tender_analysis'))
    expect(text).toContain('chunks/index.json')
    expect(text).not.toContain('必须按期交付，技术方案得 10 分')
  })
})
