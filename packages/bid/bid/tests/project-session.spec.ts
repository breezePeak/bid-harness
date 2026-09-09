import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  BID_INITIAL_RUNTIME_STATE, BidHostRuntime, BidOrchestrator, BidWorkspace,
  checkpointBidProjectState, getBidClientProjection, parseEvidenceMapArtifact,
  parseTenderScoringArtifact, readBidProjectState, reduceBidRuntimeState, validateTenderAnalysis,
  type BidStageExecutorPort, type BidStageValidatorPort,
} from '@deepseek-ai/dsh-bid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedConversation, seedProjectArtifacts } from './fixtures/project-session.ts'

interface HostExecution {
  readonly inFlight: Map<string, unknown>
  automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator
}

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

function runtime(session: Session) {
  return session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-session-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  const workspace = new BidWorkspace(root)
  const host = ctx.bid as unknown as HostExecution
  const executor: BidStageExecutorPort = { canExecute: () => false, execute: vi.fn(async () => []) }
  const validator: BidStageValidatorPort = { validate: async () => ({ ok: true, issues: [] }) }
  host.automaticOrchestrator = (agent, current, signal) => new BidOrchestrator(agent.session, executor, {
    validate: (stage, artifacts) => stage === 'tender_analysis' ? validateTenderAnalysis(current, stage, artifacts) : validator.validate(stage, artifacts),
  }, signal)
  const fresh = async (id: string, cwd = root, waitForIdle = true) => {
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd, agentPreset: 'bid' } })
    await vi.waitFor(() => {
      expect(handle.agent.session.events.some(event => event.type === 'bid.project.resumed'), `${id} 应完成项目恢复`).toBe(true)
      if (waitForIdle) expect(host.inFlight.size).toBe(0)
    })
    return handle.agent
  }
  return { ctx, workspace, fresh, host, executor, validator }
}

describe('Workspace 项目与独立 Session', () => {
  it('详情从已发布产物恢复，S4 运行中忽略正在改写的目录', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    for (const [path, title] of [
      ['initial-confirmed-outline.json', 'S3 已确认目录'],
      ['outline.json', 'S4 已生成目录'],
      ['confirmed-outline.json', 'S4 最终确认目录'],
    ]) {
      await writeFile(join(workspace.projectRoot, 'outline', path!), JSON.stringify({ ...outline, sections: outline.sections.map(section => ({ ...section, title })) }))
    }
    const cases = [
      ['file_intake', 'pending', false, null, false],
      ['tender_analysis', 'waiting_user', true, null, false],
      ['outline_generation', 'pending', true, null, false],
      ['outline_generation', 'waiting_user', true, null, false],
      ['evidence_mapping', 'pending', true, 'S3 已确认目录', false],
      ['evidence_mapping', 'failed', true, 'S3 已确认目录', false],
      ['evidence_mapping', 'waiting_user', true, 'S4 已生成目录', false],
      ['chapter_writing', 'pending', true, 'S4 最终确认目录', true],
      ['chapter_writing', 'failed', true, 'S4 最终确认目录', true],
      ['chapter_writing', 'completed', true, 'S4 最终确认目录', true],
      ['docx_export', 'completed', true, 'S4 最终确认目录', true],
    ] as const
    for (const [index, [stage, status, tender, title, body]] of cases.entries()) {
      await checkpointBidProjectState(workspace, { stage, status })
      const agent = await fresh(`details-${String(index)}`)
      const details = await ctx.bid.getDetails(agent.session)
      expect(details.tender !== null).toBe(tender)
      expect(details.outline?.sections[0]?.title ?? null).toBe(title)
      expect(details.body).toBe(body)
      if (title === null) expect(details.outlinePresentation).toBeNull()
      else if (body || stage === 'evidence_mapping' && status === 'waiting_user') {
        expect(details.outlinePresentation?.source).toBe(body ? 'final_confirmed' : 'final_candidate')
        expect(details.outlinePresentation?.baseline?.sections[0]?.title).toBe('S3 已确认目录')
        expect(details.outlinePresentation?.evidence?.section_mappings[0]?.missing_topics).toEqual(['待补充实施材料'])
        expect(details.outlinePresentation?.errors).toEqual([])
      } else expect(details.outlinePresentation).toEqual({ source: 'initial_confirmed', baseline: null, evidence: null, errors: [] })
    }
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('S5 运行中读取详情不等待写作任务，不调用确认接口；上下文损坏保留最终版本状态', async () => {
    const { ctx, workspace, fresh, host, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(outline))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('details-in-flight')
    agent.session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    const review = vi.spyOn(ctx.bid, 'getOutlineReviewContext')
    const before = agent.session.events.length
    host.inFlight.set(process.platform === 'win32' ? workspace.root.toLowerCase() : workspace.root, { done: new Promise(() => {}) })
    try {
      const result = await ctx.bid.getDetails(agent.session)
      expect(result.outlinePresentation).toMatchObject({ source: 'final_confirmed', baseline: outline, errors: [] })
      await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), '{')
      await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), '{')
      const broken = await ctx.bid.getDetails(agent.session)
      expect(broken.outline).toEqual(outline)
      expect(broken.outlinePresentation).toMatchObject({ source: 'final_confirmed', baseline: null, evidence: null })
      expect(broken.outlinePresentation?.errors.join('\n')).toContain('initial-confirmed-outline.json 读取失败')
      expect(broken.outlinePresentation?.errors.join('\n')).toContain('evidence-map.json 读取失败')
      expect(review).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
      expect(agent.session.events).toHaveLength(before)
    } finally { host.inFlight.clear() }
  })
  it('fresh Session 保留 S4 项目，聊天、推理、工具和 conversation nodes 均为空', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    seedConversation(a.session)
    const fork = vi.spyOn(ctx.sessions, 'fork')
    const b = await fresh('session-b')

    expect(runtime(b.session)).toEqual(state)
    expect(b.session.header.parentSession).toBeUndefined()
    expect(b.session.header.seedLength).toBeUndefined()
    expect(b.session.surface.nodes).toEqual([])
    expect(b.session.deriveMessages()).toEqual([])
    expect(b.session.events.every(event => event.type === 'bid.project.resumed')).toBe(true)
    expect(fork).not.toHaveBeenCalled()
    expect(executor.execute).not.toHaveBeenCalled()
    expect(a.session.deriveMessages()).toHaveLength(3)
    expect(await ctx.bid.getOutlineForConfirmation(b.session)).toEqual(outline)
    expect((await new BidWorkspace(b.session.header.cwd!).readManifest()).files).toHaveLength(1)
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(evidence.section_mappings[0]?.missing_topics).toEqual(['待补充实施材料'])
  })

  it('新项目初始化 S1，S2 在新 Session 中读取、编辑并继续确认', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const a = await fresh('session-a')
    expect(await readBidProjectState(workspace)).toMatchObject({ schema_version: 1, runtime: { stage: 'file_intake', status: 'pending' } })
    await seedProjectArtifacts(workspace)
    const scoringOriginPath = join(workspace.projectRoot, 'analysis/scoring-origin.json')
    const scoringOrigin = JSON.parse(await readFile(scoringOriginPath, 'utf8')) as { scoring_items: Array<Record<string, unknown>> }
    scoringOrigin.scoring_items.push({ ...scoringOrigin.scoring_items[0], id: 'SCORE-2', title: '实施方案', score: 5 })
    await writeFile(scoringOriginPath, `${JSON.stringify(scoringOrigin)}\n`)
    await writeFile(join(workspace.projectRoot, 'analysis/tender-analysis-selection.json'), JSON.stringify({ schema_version: 1, selected_scoring_ids: ['SCORE-1', 'SCORE-2'] }))
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'waiting_user' })
    const b = await fresh('session-b')
    expect((await ctx.bid.getTenderAnalysisForConfirmation(b.session)).project.project_name).toBe('项目 A')
    b.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'S2 原始评分含有已排除的 SC-009。' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }), { surfaceOp: 'append' })
    await ctx.bid.setTenderScoringSelection(b.session, 'SCORE-2', false)
    const selection = await ctx.bid.getTenderAnalysisForConfirmation((await fresh('session-selection')).session)
    expect(selection.selected_scoring_ids).toEqual(['SCORE-1'])
    await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), JSON.stringify({
      schema_version: 1, points: [{ scoring_id: 'SCORE-2', order: 1, text: '过期响应点' }],
    }))
    await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), '{}')
    const before = (await readBidProjectState(workspace))!.revision
    const confirmation = await ctx.bid.confirmTenderAnalysis(b.session, [{ type: 'update_project', fields: { project_name: '项目 B' } }])
    expect(confirmation).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'pending' } })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8'))).toMatchObject({ project_name: '项目 B' })
    const unchangedOrigin = parseTenderScoringArtifact(JSON.parse(await readFile(scoringOriginPath, 'utf8')))
    const confirmedScoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
    expect(unchangedOrigin.scoring_items.map(item => item.id)).toEqual(['SCORE-1', 'SCORE-2'])
    expect(confirmedScoring.scoring_items.map(item => item.id)).toEqual(['SCORE-1'])
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(b.session.deriveMessages())).not.toContain('SC-009')
    expect(JSON.stringify(b.session.deriveMessages())).toContain('analysis/scoring.json')
    expect((await readBidProjectState(workspace))!.revision).toBeGreaterThan(before)
    expect(runtime(a.session)).toEqual({ stage: 'outline_generation', status: 'pending' })
    const c = await fresh('session-c')
    expect(runtime(c.session)).toEqual({ stage: 'outline_generation', status: 'pending' })
    expect((await ctx.bid.getDetails(c.session)).tender?.project.project_name).toBe('项目 B')
  })

  it('S5 失败后新 Session 继续读取已有正文和执行日志，并从 S5 retry', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    const failed = { stage: 'chapter_writing', status: 'failed', failureReason: '章节执行失败' } as const
    await checkpointBidProjectState(workspace, failed)
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual(failed)
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toContain('retry_stage')
    expect(await ctx.bid.getReviewWorkbench(b.session)).toMatchObject({ outline: [{ section_id: 'SEC-1', writing_status: 'completed', content_available: true }], summary: { content_count: 1 } })
    expect(await ctx.bid.getReviewChapter(b.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
    executor.canExecute = stage => stage === 'chapter_writing'
    expect(await ctx.bid.retryStage(b.session)).toEqual({ ok: true, value: { stage: 'chapter_writing', status: 'completed' } })
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'chapter_writing' }))
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: { stage: 'chapter_writing', status: 'completed' } })
  })

  it('S5 工作台投影已保存审核报告，并从失败执行记录读取章节原因', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await mkdir(join(workspace.projectRoot, 'chapters/reviews'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      schema_version: 2, section_id: 'SEC-1', verdict: 'repair', candidate_sha256: createHash('sha256').update('# 技术方案\n\n已有正文。\n').digest('hex'), writer_child_session_id: 'writer-a', reviewer_child_session_id: 'reviewer-a',
      must_answer_coverage: [{ item: '按期交付', status: 'missing', evidence_quotes: [], issue: '正文没有交付节点。' }],
      requirement_coverage: [{ requirement_id: 'REQ-1', item: '按期交付', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      response_point_coverage: [{ response_point_id: 'RP-000001', item: '说明技术方案', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      compliance_coverage: [],
      claim_checks: [{ claim_quote: '按期交付', kind: 'commitment', status: 'unsupported', source_reference: null, issue: '未说明保障措施。' }],
      quality_checks: {
        project_specific: false, structure_complete: true, legacy_project_pollution_free: true,
        placeholder_free: true, obvious_repetition_free: true,
      },
      blocking_issues: ['补充交付节点和保障措施。'],
    }))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('review-projection')

    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({ review_status: 'needs_attention' })
    expect((await ctx.bid.getReviewWorkbench(agent.session)).summary).toMatchObject({ reviewed_count: 1, needs_attention_count: 1 })
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toMatchObject({
      status: 'needs_attention', issues: expect.arrayContaining([
        expect.objectContaining({ category: 'must_answer_coverage', detail: '正文没有交付节点。' }),
        expect.objectContaining({ category: 'claim_checks', detail: '按期交付：未说明保障措施。' }),
        expect.objectContaining({ category: 'quality_checks', detail: 'project_specific：false' }),
      ]),
    })

    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n修订后的正文。\n')
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]?.review_status).toBe('reviewing')
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toEqual({ status: 'reviewing', issues: [] })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n已有正文。\n')

    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = JSON.parse(await readFile(logPath, 'utf8')) as { sections: Array<Record<string, unknown>> }
    log.sections[0] = {
      ...log.sections[0], status: 'failed', attempts: [{
        role: 'reviewer', attempt: 1, child_session_id: 'reviewer-b', label: 'S5 审核',
        started_at: '2026-09-09T00:00:00.000Z', ended_at: '2026-09-09T00:00:01.000Z', stop_reason: 'error', accepted: false,
        issues: [{ code: 'CHAPTER_REVIEWER_STOP_REASON_INVALID', message: 'Chapter Reviewer 未正常完成：error。' }],
      }], final_writer_child_session_id: 'writer-a', final_reviewer_child_session_id: null,
    }
    await writeFile(logPath, `${JSON.stringify(log)}\n`)
    await rm(join(workspace.projectRoot, 'chapters/sections/0001.md'))

    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({ writing_status: 'failed', review_status: 'failed', content_available: false })
    expect((await ctx.bid.getReviewWorkbench(agent.session)).summary.needs_attention_count).toBe(1)
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toMatchObject({
      status: 'failed', issues: expect.arrayContaining([expect.objectContaining({
        source: 'review_execution', title: '章节审核执行失败', detail: 'Chapter Reviewer 未正常完成：error。',
      })]),
    })
  })

  it('各级父节点从确认目录读取概述，不计入叶节写作和审查进度', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const leaf = outline.sections[0]!
    outline.sections = [
      { ...leaf, id: 'ROOT', title: '项目实施', writable: false, must_answer: [], summary: '本章介绍实施安排及具体技术方案。' },
      { ...leaf, id: 'BRANCH', parent_id: 'ROOT', level: 2, title: '实施安排', writable: false, must_answer: [], summary: '本节概括技术方案的主要内容。' },
      { ...leaf, parent_id: 'BRANCH', level: 3 },
    ]
    const outlinePath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
    await writeFile(outlinePath, JSON.stringify(outline))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('branch-summary')
    const workbench = await ctx.bid.getReviewWorkbench(agent.session)
    expect(workbench).toMatchObject({
      outline: [
        { section_id: 'ROOT', content_available: true },
        { section_id: 'BRANCH', content_available: true },
        { section_id: 'SEC-1', content_available: true },
      ],
      summary: { chapter_count: 1, content_count: 1, reviewed_count: 0 },
    })
    expect(workbench.summary.page_estimate).toMatchObject({ status: 'available', pages: expect.any(Number) })
    expect(workbench.outline.find(section => section.section_id === 'ROOT')?.page_estimate).toMatchObject({ status: 'available', pages: expect.any(Number) })
    for (const [sectionId, number, summary] of [
      ['ROOT', '1', '本章介绍实施安排及具体技术方案。'],
      ['BRANCH', '1.1', '本节概括技术方案的主要内容。'],
    ] as const) {
      expect(await ctx.bid.getReviewChapter(agent.session, sectionId)).toMatchObject({
        number, writable: false, markdown: summary, content_sha256: null, evidence_status: 'not_applicable',
      })
    }
    expect(await ctx.bid.getReviewChapter(agent.session, leaf.id)).toMatchObject({ number: '1.1.1', writable: true, markdown: '# 技术方案\n\n已有正文。\n' })
    delete outline.sections[0]!.summary
    await writeFile(outlinePath, JSON.stringify(outline))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]?.content_available).toBe(false)
    expect((await ctx.bid.getReviewChapter(agent.session, 'ROOT')).markdown).toBeNull()
  })

  it('页数估算失败不阻塞正文工作台读取', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '![远程图](https://example.com/image.png)')
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('page-estimate-failure')
    const workbench = await ctx.bid.getReviewWorkbench(agent.session)
    expect(workbench.summary.page_estimate).toEqual({ status: 'unavailable' })
    expect(await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).toMatchObject({ markdown: '![远程图](https://example.com/image.png)' })
  })

  it('旧 S6 已完成项目仍保留审核工作台和按需导出动作', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'docx_export', status: 'completed' })
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'docx_export', status: 'completed' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toEqual(['export_docx', 'revise_chapter'])
    expect(await ctx.bid.exportDocx(b.session)).toMatchObject({ ok: true })
    expect(runtime(b.session)).toEqual({ stage: 'docx_export', status: 'completed' })
  })

  it('S5 完成后可重复导出独立 Word 文件且不改变审核阶段', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('session-export')

    const first = await ctx.bid.exportDocx(agent.session)
    const second = await ctx.bid.exportDocx(agent.session)

    expect(first).toMatchObject({ ok: true, value: { path: expect.stringMatching(/^output\/bid-\d+-[a-f0-9]{6}\.docx$/u) } })
    expect(second).toMatchObject({ ok: true })
    if (!first.ok || !second.ok) throw new Error('DOCX export failed')
    expect(second.value.path).not.toBe(first.value.path)
    expect((await readFile(join(workspace.projectRoot, first.value.path))).readUInt32LE(0)).toBe(0x04034b50)
    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: { stage: 'chapter_writing', status: 'completed' } })
  })

  it('旧 Session 日志落盘失败不会让新聊天以 S1 覆盖已有 S4 项目', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    const saved = (await readBidProjectState(workspace))!
    const flush = vi.fn((session: Session) => {
      if (session === a.session) throw new Error('旧聊天落盘失败')
    })
    const release = ctx.on('session/flush', flush, { global: true })
    try {
      const b = await fresh('session-b')
      expect(flush).toHaveBeenCalledWith(a.session)
      expect(runtime(b.session)).toEqual(state)
      expect(b.session.deriveMessages()).toEqual([])
      const restored = (await readBidProjectState(workspace))!
      expect(restored.runtime).toEqual(saved.runtime)
      expect(restored.revision).toBeGreaterThanOrEqual(saved.revision)
      expect(executor.execute).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('reset 删除后续产物并等待用户确认，确认后才执行当前阶段', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const a = await fresh('session-a')
    expect(await ctx.bid.resetStage(a, 'outline_generation')).toEqual({ stage: 'outline_generation', status: 'waiting_start' })
    expect(executor.execute).not.toHaveBeenCalled()
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'outline_generation', status: 'waiting_start' })
    expect(b.session.deriveMessages()).toEqual([])
    executor.canExecute = stage => stage === 'outline_generation'
    expect(await ctx.bid.startStage(b.session)).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'waiting_user' } })
    expect(executor.execute).toHaveBeenCalledOnce()
  })

  it('等待确认投影出现后，目录读取等待操作落盘并返回实际目录', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'outline_generation', status: 'failed' })
    const a = await fresh('session-a')
    executor.canExecute = stage => stage === 'outline_generation'
    const checkpoint = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const release = ctx.on('session/flush', async (session) => {
      if (session === a.session && runtime(session).status === 'waiting_user') {
        checkpoint.resolve(undefined)
        await gate.promise
      }
    }, { global: true })
    const retry = ctx.bid.retryStage(a.session)
    try {
      await checkpoint.promise
      let settled = false
      const draft = ctx.bid.getOutlineDraft(a.session).finally(() => { settled = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      gate.resolve(undefined)
      expect((await retry).ok).toBe(true)
      expect((await draft).outline).toEqual(outline)
    } finally { gate.resolve(undefined); release(); await retry }
  })

  it('后端中断的 running 在原阶段恢复为 failed，保留已有章节', async () => {
    const { workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'running' })
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'chapter_writing', status: 'failed', failureReason: '阶段执行因后端停止而中断，请重试当前阶段。' })
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: runtime(b.session) })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('同一真实目录的 Session 共用锁，不同 Workspace 可并行执行', async () => {
    const { ctx, workspace, fresh, executor, host } = await fixture()
    await seedProjectArtifacts(workspace)
    const alias = join(workspace.root, 'workspace-link')
    await symlink(workspace.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const otherRoot = join(workspace.root, 'other-project')
    await mkdir(otherRoot)
    const otherWorkspace = new BidWorkspace(otherRoot)
    const failed = { stage: 'chapter_writing', status: 'failed' } as const
    await checkpointBidProjectState(workspace, failed)
    await checkpointBidProjectState(otherWorkspace, failed)
    const a = await fresh('session-a')
    const b = await fresh('session-b', alias)
    const c = await fresh('session-c', otherRoot)
    const gate = Promise.withResolvers<undefined>()
    executor.canExecute = stage => stage === 'chapter_writing'
    executor.execute = vi.fn(async () => { await gate.promise; return [] })
    const operationA = ctx.bid.retryStage(a.session)
    try {
      await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1))
      expect(await ctx.bid.retryStage(b.session)).toMatchObject({ ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS' } })
      const operationC = ctx.bid.retryStage(c.session)
      await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(2))
      const d = await fresh('session-d', alias, false)
      expect(runtime(d.session)).toEqual({ stage: 'chapter_writing', status: 'running' })
      expect(d.session.deriveMessages()).toEqual([])
      expect(await ctx.bid.getReviewChapter(d.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
      gate.resolve(undefined)
      expect((await operationA).ok).toBe(true)
      expect((await operationC).ok).toBe(true)
      await vi.waitFor(() => expect(host.inFlight.size).toBe(0))
      expect(runtime(d.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
      expect(executor.execute).toHaveBeenCalledTimes(2)
    } finally { gate.resolve(undefined); await operationA }
  })
})
