import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  buildBidStageTask,
  createTestBidRunContext,
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
      { maxRepairAttempts: 1, run: createTestBidRunContext({ signal: controller.signal }) },
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
    const policies: Array<(exec: { name: string }) => string | undefined> = []
    const policy = (exec: { name: string }): string | undefined => policies.map(next => next(exec)).find(value => value !== undefined)
    const guard = vi.fn((next: typeof policy) => { policies.push(next); return liftGuard })
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
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      inbox: { append: vi.fn(), prepend: vi.fn(), nextStep: [], nextTurn: [] },
      followup,
      whenIdle: vi.fn(async () => {}),
    } as unknown as Agent
    const task = buildBidStageTask('tender_analysis')

    const error: { name: string; issues: Array<{ code: string; message: string }> } | undefined = await executeTenderAnalysis(
      agent, workspace, task, { maxRepairAttempts: 1, run: createTestBidRunContext() },
    ).then(
      () => undefined,
      (caught: unknown) => caught as { name: string; issues: Array<{ code: string; message: string }> },
    )
    expect(error).toMatchObject({ name: 'BidStageExecutionError', issues: [expect.objectContaining({ code: 'TENDER_ANALYSIS_STAGED_INCOMPLETE' })] })
    const incomplete = error?.issues[0]?.message ?? ''
    expect(incomplete).toContain('phase=collecting')
    expect(incomplete).toContain('revision=0')
    expect(incomplete).toContain('TENDER_ANALYSIS_FINISH_REQUIRED')
    expect(incomplete).toContain('暂存摘要：{"revision":0')

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
    expect(initial.content[0]?.text).toContain('不得填写 quote、raw_text、file_id、source_refs、line_start、line_end、parent_ref')
    expect(initial.content[0]?.text).toContain('semantic_hint')
    expect(initial.content[0]?.text).toContain('评分响应点')
    expect(initial.content[0]?.text).toContain('评分大项')
    expect(initial.content[0]?.text).toContain('不得另建评分项')
    expect(initial.content[0]?.text).toContain('远距离第二评分区域')
    expect(repair.content[0]?.text).toContain('TENDER_ANALYSIS_FINISH_REQUIRED')
    expect(repair.content[0]?.text).toContain('当前 staged snapshot')
    expect(register).toHaveBeenCalledTimes(5)
    expect(definitions.size).toBe(0)
    expect(liftGuard).toHaveBeenCalledTimes(3)
    expect(liftRestriction).toHaveBeenCalledOnce()
    await expect(Promise.all(['project.json', 'requirements.json', 'scoring-origin.json', 'compliance.json']
      .map(name => readFile(join(workspace.projectRoot, 'analysis', name), 'utf8'))))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renders staged repair issues without asking the model to rewrite JSON', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-repair-task-')))
    const rendered = renderTenderAnalysisRepairTask(
      { id: 'session' } as Agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      [{ code: 'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY', artifact: 'analysis/scoring-origin.json', path: 'scoring_items', message: '缺少技术评分项。' }],
      { revision: 3, requirements: [{ requirement_ref: 'R1' }], scoring: [{ scoring_ref: 'S2' }], compliance: [{ compliance_ref: 'C1' }] },
    )
    expect(rendered).toContain('scoring_items')
    expect(rendered).toContain('submit_scoring_item')
    expect(rendered).toContain('不得 write analysis/*.json')
    expect(rendered).toContain('"revision":3')
    expect(rendered).toContain('缺少新记录时使用 action=create，且不得传 replace_ref')
    expect(rendered).toContain('当前 Requirement refs：["R1"]')
    expect(rendered).toContain('当前 Scoring refs：["S2"]')
    expect(rendered).toContain('当前 Compliance refs：["C1"]')
    expect(rendered).toContain('禁止根据当前数量、revision、排序、上一轮记忆或历史 Run 推算')
  })

  it('ends an unknown-ref turn, then repairs, reviews, and completes', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-ref-repair-')))
    await workspace.import([{
      name: 'project.md', role: 'tender', bytes: new TextEncoder().encode([
        '项目名称：审计平台。', '系统应支持审计日志。', '技术评分：总体方案得 10 分。', '技术方案必须提供安全措施。',
      ].join('\n')),
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
    let unknownRefAttempts = 0
    const rejectedTurn = vi.fn()
    const followup = vi.fn()
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      inbox: { append: vi.fn(), prepend: vi.fn(), nextStep: [], nextTurn: [] },
      followup,
      whenIdle: vi.fn(async () => {
        idle++
        const exec = {
          agent,
          signal: new AbortController().signal,
          concludeTurn: idle === 2 ? rejectedTurn : vi.fn(),
        } as unknown as ToolRunContext
        const source = (semantic_hint: string) => [{ file_ref: 'T1', chunk: 'chunk_0001', semantic_hint }]
        if (idle === 2) {
          unknownRefAttempts++
          await expect(definitions.get('submit_requirement')?.execute({
            action: 'replace', replace_ref: 'R404', category: '功能要求', normalized_requirement: '系统应支持审计日志。', mandatory: true,
            sources: source('系统应支持审计日志。'),
          }, exec)).resolves.toMatchObject({ recorded: false, rejected: true, current_refs: [], revision: 0 })
        } else if (idle === 3) {
          await definitions.get('submit_project_fact')?.execute({ field: 'project_name', value: '审计平台', sources: source('项目名称：审计平台。') }, exec)
          await definitions.get('submit_requirement')?.execute({
            action: 'create', category: '功能要求', normalized_requirement: '系统应支持审计日志。', mandatory: true, sources: source('系统应支持审计日志。'),
          }, exec)
          await definitions.get('submit_scoring_item')?.execute({
            action: 'create', group: '技术评分', title: '总体方案', criterion: '总体方案得 10 分。', score: 10, score_range: null, must_answer: true,
            sources: source('技术评分：总体方案得 10 分。'),
          }, exec)
          await definitions.get('submit_compliance_item')?.execute({
            action: 'create', type: '强制要求', normalized_rule: '技术方案必须提供安全措施。', severity: 'mandatory', sources: source('技术方案必须提供安全措施。'),
          }, exec)
          reviewRevision = (await definitions.get('finish_tender_analysis')?.execute({}, exec) as { revision: number }).revision
        } else if (idle === 4) {
          await definitions.get('finish_tender_analysis')?.execute({ review_revision: reviewRevision }, exec)
        }
      }),
    } as unknown as Agent

    await expect(executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), {
      maxRepairAttempts: 1, run: createTestBidRunContext(),
    })).resolves.toHaveLength(4)
    expect(unknownRefAttempts).toBe(1)
    expect(rejectedTurn).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledTimes(3)
    const repair = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    const review = followup.mock.calls[2]?.[0] as { content: Array<{ text: string }> }
    expect(repair.content[0]?.text).toContain('"revision":0')
    expect(repair.content[0]?.text).toContain('缺少新记录时使用 action=create，且不得传 replace_ref')
    expect(repair.content[0]?.text).toContain('"requirements":[]')
    expect(review.content[0]?.text).toContain('Tender Analysis Quality Review')
    await expect(Promise.all(['project.json', 'requirements.json', 'scoring-origin.json', 'compliance.json']
      .map(name => readFile(join(workspace.projectRoot, 'analysis', name), 'utf8'))))
      .resolves.toHaveLength(4)
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
    const concludeTurn = vi.fn()
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {
      idle++
      const exec = { agent, signal: new AbortController().signal, concludeTurn } as unknown as ToolRunContext
      if (idle === 2) {
        await definitions.get('submit_project_fact')?.execute({
          field: 'project_name', value: '审计平台',
          sources: [{ file_ref: 'T1', chunk: 'chunk_0001', semantic_hint: '项目名称审计平台' }],
        }, exec)
        const staged = await definitions.get('finish_tender_analysis')?.execute({}, exec) as { revision?: number }
        reviewRevision = staged.revision
      } else if (idle === 3) {
        await definitions.get('finish_tender_analysis')?.execute({ review_revision: reviewRevision }, exec)
      }
    })
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      inbox: { append: vi.fn(), prepend: vi.fn(), nextStep: [], nextTurn: [] },
      followup,
      whenIdle,
    } as unknown as Agent

    await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), { maxRepairAttempts: 1, run: createTestBidRunContext() })

    expect(followup).toHaveBeenCalledTimes(2)
    const review = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(review.content[0]?.text).toContain('Tender Analysis Quality Review')
    expect(review.content[0]?.text).toContain(`"revision":${String(reviewRevision)}`)
    expect(concludeTurn).toHaveBeenCalledOnce()
    await expect(Promise.all(['project.json', 'requirements.json', 'scoring-origin.json', 'compliance.json']
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
    expect(text).toContain('新增使用 action=create')
    expect(text).toContain('禁止根据数量、revision、排序、历史 Run 或记忆猜测')
  })
})
