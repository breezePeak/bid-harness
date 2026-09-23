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

function completeSubmission(scoring = true) {
  const source = (anchor_text: string) => [{ file_ref: 'T1', chunk: 'chunk_0001', anchor_text }]
  return {
    project_facts: [{ field: 'project_name', value: '审计平台', sources: source('项目名称：审计平台。') }],
    requirements: [{
      category: '功能要求', normalized_requirement: '系统应支持审计日志。', mandatory: true,
      sources: source('系统应支持审计日志。'),
    }],
    scoring_items: scoring ? [{
      group: '技术评分', title: '总体方案', criterion: '总体方案得 10 分。',
      score: 10, score_range: null, must_answer: true, sources: source('技术评分：总体方案得 10 分。'),
    }] : [],
    compliance_items: [{
      type: '强制要求', normalized_rule: '技术方案必须提供安全措施。', severity: 'mandatory',
      sources: source('技术方案必须提供安全措施。'),
    }],
  }
}

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
      agent, workspace, buildBidStageTask('tender_analysis'),
      { maxRepairAttempts: 1, run: createTestBidRunContext({ signal: controller.signal }) },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('allows only grep/read plus two S2 tools and requests a missing complete submission', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-executor-')))
    await workspace.import([{
      name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('# 技术要求\n\n系统应支持审计日志。'),
    }])
    const definitions = new Map<string, ToolDefinition>()
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const policies: Array<(exec: { name: string }) => string | undefined> = []
    const services = {
      tools: {
        restrict: vi.fn(() => liftRestriction),
        guard: vi.fn((next: (exec: { name: string }) => string | undefined) => { policies.push(next); return liftGuard }),
        register: vi.fn((definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          return () => { definitions.delete(definition.name) }
        }),
      },
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

    const error = await executeTenderAnalysis(
      agent, workspace, buildBidStageTask('tender_analysis'),
      { maxRepairAttempts: 1, run: createTestBidRunContext(), recovery: {
        workId: 'test-work', unit: 'analysis/project.json', instruction: '核对项目字段并补齐来源。',
        issues: [{ code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE', artifact: 'analysis/project.json', message: '项目字段缺失' }],
      } },
    ).then(() => undefined, (caught: unknown) => caught as { name: string; issues: Array<{ code: string }> })
    expect(error).toMatchObject({
      name: 'BidStageExecutionError',
      issues: [
        expect.objectContaining({ code: 'TENDER_ANALYSIS_SUBMISSION_INCOMPLETE' }),
        expect.objectContaining({ code: 'TENDER_ANALYSIS_SUBMISSION_REQUIRED' }),
      ],
    })
    expect(services.tools.restrict).toHaveBeenCalledWith({ allow: ['grep', 'read'] })
    expect(policies[0]?.({ name: 'write' })).toContain('allows only')
    expect(followup).toHaveBeenCalledTimes(2)
    const initial = followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }
    const repair = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(initial.content[0]?.text).toContain('submit_tender_analysis')
    expect(initial.content[0]?.text).toContain('核对项目字段并补齐来源。')
    expect(initial.content[0]?.text).toContain('TENDER_ANALYSIS_SUBMISSION_INCOMPLETE')
    expect(initial.content[0]?.text).toContain('四个完整数组')
    expect(initial.content[0]?.text).toContain('不得填写或猜测任何业务 ID')
    expect(repair.content[0]?.text).toContain('TENDER_ANALYSIS_SUBMISSION_REQUIRED')
    expect(repair.content[0]?.text).toContain('核对项目字段并补齐来源。')
    expect(repair.content[0]?.text).not.toContain('staged snapshot')
    expect(services.tools.register).toHaveBeenCalledTimes(2)
    expect(definitions.size).toBe(0)
    expect(liftGuard).toHaveBeenCalledTimes(3)
    expect(liftRestriction).toHaveBeenCalledOnce()
  })

  it('resubmits one corrected result after batch validation and keeps scoring in the final Artifact', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-repair-')))
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
    const concludeTurn = vi.fn()
    const followup = vi.fn()
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      inbox: { append: vi.fn(), prepend: vi.fn(), nextStep: [], nextTurn: [] },
      followup,
      whenIdle: vi.fn(async () => {
        idle++
        if (idle < 2 || idle > 3) return
        const tool = definitions.get('submit_tender_analysis')
        const exec = { agent, signal: new AbortController().signal, concludeTurn } as unknown as ToolRunContext
        await tool?.execute(idle === 2
          ? completeSubmission(false)
          : { repair: { scoring_item: completeSubmission().scoring_items[0] } }, exec)
      }),
    } as unknown as Agent

    await expect(executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), {
      maxRepairAttempts: 1, run: createTestBidRunContext(),
    })).resolves.toHaveLength(4)
    expect(followup).toHaveBeenCalledTimes(2)
    expect(concludeTurn).toHaveBeenCalledOnce()
    const repair = followup.mock.calls[1]?.[0] as { content: Array<{ text: string }> }
    expect(repair.content[0]?.text).toContain('TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY')
    expect(repair.content[0]?.text).toContain('"repair_key":"scoring_item"')
    expect(repair.content[0]?.text).toContain('不得重交完整数组')
    const scoring = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')) as {
      scoring_items: Array<{ title: string }>
    }
    expect(scoring.scoring_items).toEqual([expect.objectContaining({ title: '总体方案' })])
  })

  it('keeps S2 ordinary-tool policy and prompt paths deterministic', async () => {
    const policy = getBidStagePolicy('tender_analysis')
    expect(policy.allowedTools).toEqual(['grep', 'read', 'view_pdf_page'])
    expect(policy.forbiddenTools).toEqual(['write', 'bash', 'web_search', 'web_fetch', 'subagent'])
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-task-')))
    const text = renderTenderAnalysisTask({ id: 'session' } as Agent, workspace, buildBidStageTask('tender_analysis'))
    expect(text).toContain('.bid-harness/manifest.json')
    expect(text).toContain('chunks/index.json')
    expect(text).toContain('不得逐页浏览整份 PDF')
    expect(text).toContain('submit_tender_analysis')
    expect(text).not.toContain('action=create')

    const repair = renderTenderAnalysisRepairTask(
      { id: 'session' } as Agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      [{ code: 'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY', path: 'scoring_items', message: '缺少技术评分项。' }],
      { repair_key: 'scoring_item', item: null, related_chunks: [] },
    )
    expect(repair).toContain('缺少技术评分项')
    expect(repair).toContain('scoring_item')
  })
})
