import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  buildBidStageTask,
  executeTenderAnalysis,
  getBidStagePolicy,
  renderTenderAnalysisRepairTask,
  renderTenderAnalysisTask,
} from '@deepseek-ai/dsh-bid'

describe('tender-analysis Agent executor', () => {
  it('stops before issuing stage work when the Host operation is cancelled', async () => {
    const controller = new AbortController()
    const followup = vi.fn()
    const agent = {
      id: 'session',
      whenIdle: vi.fn(async () => { controller.abort() }),
      followup,
    } as unknown as Agent
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-cancel-')))

    await expect(executeTenderAnalysis(
      agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      { maxRepairAttempts: 1, signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('allows only grep/read plus the private S2 tools and requires finish', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-executor-')))
    await workspace.import([{
      name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('# 技术要求\n\n系统应支持审计日志。'),
    }])
    const definitions = new Map<string, ToolDefinition>()
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const restrict = vi.fn(() => liftRestriction)
    let policy: (exec: { name: string }) => string | undefined = () => undefined
    const guard = vi.fn((next: typeof policy) => { policy = next; return liftGuard })
    const register = vi.fn((definition: ToolDefinition) => {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    })
    const services = {
      tools: { guard, restrict, register },
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
    }
    const followup = vi.fn()
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup,
      whenIdle: vi.fn(async () => {}),
    } as unknown as Agent
    const task = buildBidStageTask('tender_analysis')

    const result = await executeTenderAnalysis(agent, workspace, task, { maxRepairAttempts: 1 })

    expect(restrict).toHaveBeenCalledWith({ allow: ['grep', 'read'] })
    expect(policy({ name: 'read' })).toBeUndefined()
    expect(policy({ name: 'write' })).toContain('allows only')
    expect(policy({ name: 'bash' })).toContain('allows only')
    expect(policy({ name: 'web_search' })).toContain('allows only')
    expect(followup).toHaveBeenCalledTimes(2)
    const initial = followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }
    const repair = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(initial.content[0]?.text).toContain('T1:')
    expect(initial.content[0]?.text).toContain('submit_project_fact')
    expect(initial.content[0]?.text).toContain('不得填写 file_id、source_refs、line_start 或 line_end')
    expect(initial.content[0]?.text).toContain('评分响应点')
    expect(initial.content[0]?.text).toContain('评分大项')
    expect(initial.content[0]?.text).toContain('不得另建评分项或填写 parent_ref')
    expect(initial.content[0]?.text).toContain('远距离第二评分区域')
    expect(repair.content[0]?.text).toContain('TENDER_ANALYSIS_FINISH_REQUIRED')
    expect(result.map(value => value.path)).toEqual(task.requiredArtifacts)
    expect(register).toHaveBeenCalledTimes(5)
    expect(definitions.size).toBe(0)
    expect(liftGuard).toHaveBeenCalledOnce()
    expect(liftRestriction).toHaveBeenCalledOnce()
  })

  it('renders staged repair issues without asking the model to rewrite JSON', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-repair-task-')))
    const rendered = renderTenderAnalysisRepairTask(
      { id: 'session' } as Agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      [{ code: 'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY', artifact: 'analysis/scoring.json', path: 'scoring_items', message: '缺少技术评分项。' }],
    )
    expect(rendered).toContain('scoring_items')
    expect(rendered).toContain('submit_scoring_item')
    expect(rendered).toContain('不得 write analysis/*.json')
  })

  it('stops after finish succeeds and leaves all four Host-authored Artifacts', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-finished-')))
    await workspace.import([{
      name: 'project.md', role: 'tender', bytes: new TextEncoder().encode('项目名称：审计平台。'),
    }])
    const definitions = new Map<string, ToolDefinition>()
    const services = {
      tools: {
        register: (definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          return () => { definitions.delete(definition.name) }
        },
        restrict: vi.fn(() => vi.fn()),
        guard: vi.fn(() => vi.fn()),
      },
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
    }
    let idle = 0
    let reviewRevision: number | undefined
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {
      idle++
      const exec = { agent, signal: new AbortController().signal } as ToolRunContext
      if (idle === 2) {
        await definitions.get('submit_project_fact')?.execute({
          field: 'project_name', value: '审计平台',
          sources: [{ file_ref: 'T1', chunk: 'chunk_0001', quote: '项目名称：审计平台。' }],
        }, exec)
        const staged = await definitions.get('finish_tender_analysis')?.execute({}, exec) as { revision?: number }
        reviewRevision = staged.revision
      } else if (idle === 3) {
        await definitions.get('finish_tender_analysis')?.execute({ review_revision: reviewRevision }, exec)
      }
    })
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup,
      whenIdle,
    } as unknown as Agent

    await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), { maxRepairAttempts: 1 })

    expect(followup).toHaveBeenCalledTimes(2)
    const review = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(review.content[0]?.text).toContain('Tender Analysis Quality Review')
    expect(review.content[0]?.text).toContain(`"revision":${String(reviewRevision)}`)
    await expect(Promise.all(['project.json', 'requirements.json', 'scoring.json', 'compliance.json']
      .map(name => readFile(join(workspace.projectRoot, 'analysis', name), 'utf8'))))
      .resolves.toHaveLength(4)
  })

  it('keeps S2 ordinary-tool policy and prompt paths deterministic', async () => {
    const policy = getBidStagePolicy('tender_analysis')
    expect(policy.allowedTools).toEqual(['grep', 'read'])
    expect(policy.forbiddenTools).toEqual(['write', 'bash', 'web_search', 'web_fetch', 'subagent'])
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-task-')))
    const text = renderTenderAnalysisTask({ id: 'session' } as Agent, workspace, buildBidStageTask('tender_analysis'))
    expect(text).toContain('.bid-harness/manifest.json')
    expect(text).toContain('chunks/index.json')
    expect(text).not.toContain('必须按期交付，技术方案得 10 分')
  })
})
