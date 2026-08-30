import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    const services = { tools: { guard, restrict }, fs: { resolve } }
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit },
      followup,
      whenIdle,
    } as unknown as Agent
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-executor-')), 'session')
    const task = buildBidStageTask('tender_analysis')

    const result = await executeTenderAnalysis(agent, workspace, task)

    expect(whenIdle).toHaveBeenCalledTimes(3)
    expect(restrict).toHaveBeenCalledWith({ allow: ['grep', 'read', 'write'] })
    expect(guard).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledWith(
      'fs/observed',
      expect.objectContaining({ displayPath: expect.stringContaining(join('analysis', 'project.json')) }),
      { kind: 'absent' },
      { agent },
    )
    expect(policy({ name: 'read' })).toBeUndefined()
    expect(policy({ name: 'bash' })).toContain('allows only grep, read, write')
    expect(liftGuard).toHaveBeenCalledOnce()
    expect(liftRestriction).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledTimes(2)
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }>; source: unknown }
    const coverageAudit = followup.mock.calls[1]?.[0] as { content: Array<{ type: string; text: string }>; source: unknown }
    expect(message.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' })
    expect(message.content[0]?.text).toContain('首先读取：.bid-harness/sessions/session/manifest.json')
    expect(message.content[0]?.text).toContain('只把 manifest 中 role=tender')
    expect(message.content[0]?.text).toContain('当前只分析技术标')
    expect(message.content[0]?.text).toContain('投标报价、价格评分')
    expect(coverageAudit.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' })
    expect(coverageAudit.content[0]?.text).toContain('Coverage Audit')
    expect(coverageAudit.content[0]?.text).toContain('技术评分、技术评审、技术评价')
    expect(coverageAudit.content[0]?.text).toContain('动态形成搜索词')
    expect(result.map(artifact => artifact.path)).toEqual(task.requiredArtifacts)
  })

  it('gives the live Agent a coverage-audit turn to repair omitted technical scoring', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-coverage-audit-')), 'session')
    await workspace.import([{
      name: 'technical-scoring.md',
      role: 'tender',
      bytes: new TextEncoder().encode([
        '# 技术要求',
        '系统功能要求：应支持审计日志。',
        '# 技术评分',
        '技术评分标准：方案完整性满分 10 分。',
      ].join('\n\n')),
    }])
    const scoringPath = join(workspace.sessionRoot, 'analysis/scoring.json')
    const firstPass = { schema_version: 1, scoring_items: [] }
    const repaired = {
      schema_version: 1,
      scoring_items: [{ id: 'SCORE-1', title: '技术评分', raw_text: '技术评分标准', criterion: '技术方案完整', score: 10 }],
    }
    let idleCount = 0
    let observedFirstPass: unknown
    const whenIdle = vi.fn(async () => {
      idleCount++
      if (idleCount === 2) await writeFile(scoringPath, `${JSON.stringify(firstPass)}\n`)
      if (idleCount === 3) {
        observedFirstPass = JSON.parse(await readFile(scoringPath, 'utf8'))
        await writeFile(scoringPath, `${JSON.stringify(repaired)}\n`)
      }
    })
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const services = {
      tools: { guard: vi.fn(() => liftGuard), restrict: vi.fn(() => liftRestriction) },
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
    }
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup: vi.fn(),
      whenIdle,
    } as unknown as Agent

    await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'))

    expect(observedFirstPass).toEqual(firstPass)
    expect(JSON.parse(await readFile(scoringPath, 'utf8'))).toEqual(repaired)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('renders dynamic paths without embedding document bodies', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-task-')), 'session')
    const agent = { id: 'session' } as Agent
    const text = renderTenderAnalysisTask(agent, workspace, buildBidStageTask('tender_analysis'))
    expect(text).toContain('chunks/index.json')
    expect(text).not.toContain('必须按期交付，技术方案得 10 分')
  })
})
