import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  BID_INITIAL_RUNTIME_STATE, BidHostRuntime, BidOrchestrator, BidWorkspace,
  buildBidStageTask, checkpointBidProjectState, getBidClientProjection, parseEvidenceMapArtifact,
  outlineArtifactSha256,
  parseGlobalComplianceReviewArtifact, validateGlobalComplianceReview,
  parseTenderComplianceArtifact, parseTenderScoringArtifact, readBidProjectState, reduceBidRuntimeState, validateTenderAnalysis,
  type BidStage, type BidStageExecutorPort, type BidStageValidatorPort, type StageSchedulerControl,
} from '@deepseek-ai/dsh-bid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareBidStageContextTransition } from '../src/stage-context.ts'
import { seedConversation, seedProjectArtifacts } from './fixtures/project-session.ts'

interface HostExecution {
  readonly inFlight: Map<string, unknown>
  automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator
}

function toolCall(name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ProjectSessionAdapter extends LlmAdapter {
  readonly script: StreamChunk[][] = []
  readonly mainSessionIds = new Set<string>()
  requestGate?: Promise<void>
  onRequest?: () => void
  childGate?: Promise<void>
  onChildRequest?: () => void

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.mainSessionIds.has(String(options.sessionId))) {
      this.onChildRequest?.()
      await this.childGate
      yield* answer('S4 Mapping Child 已完成。')
      return
    }
    this.onRequest?.()
    await this.requestGate
    const response = this.script.shift()
    if (response === undefined) throw new Error('Project Session 模型脚本已耗尽')
    yield* response
  }
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
  const adapter = new ProjectSessionAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  const workspace = new BidWorkspace(root)
  const host = ctx.bid as unknown as HostExecution
  const executeStage = vi.fn<BidStageExecutorPort['execute']>(async () => [])
  const executor: BidStageExecutorPort = { canExecute: () => false, execute: executeStage }
  const validator: BidStageValidatorPort = { validate: async () => ({ ok: true, issues: [] }) }
  host.automaticOrchestrator = (agent, current, signal) => new BidOrchestrator(agent.session, {
    canExecute: stage => executor.canExecute(stage),
    execute: async (task) => {
      const active = [...host.inFlight.values()].find(value => (value as { session?: Session }).session === agent.session) as {
        stageControl?: StageSchedulerControl
      } | undefined
      await active?.stageControl?.waitUntilRunnable(signal)
      return executor.execute(task)
    },
  }, {
    validate: (stage, artifacts) => stage === 'tender_analysis' ? validateTenderAnalysis(current, stage, artifacts) : validator.validate(stage, artifacts),
  }, signal, (fromStage, toStage) => prepareBidStageContextTransition(agent.session, current, fromStage, toStage))
  const fresh = async (id: string, cwd = root, waitForIdle = true) => {
    adapter.mainSessionIds.add(id)
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd, agentPreset: 'bid' } })
    await vi.waitFor(() => {
      expect(handle.agent.session.events.some(event => event.type === 'bid.project.resumed'), `${id} 应完成项目恢复`).toBe(true)
      if (waitForIdle) expect(host.inFlight.size).toBe(0)
    })
    return handle.agent
  }
  return { ctx, workspace, fresh, host, executor, executeStage, validator, adapter }
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
    const { ctx, workspace, fresh, executor } = await fixture()
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
    const s3Contexts: string[] = []
    executor.canExecute = stage => stage === 'outline_generation'
    executor.execute = vi.fn(async () => {
      s3Contexts.push(JSON.stringify(b.session.deriveMessages()))
      if (s3Contexts.length === 1) throw new Error('模拟 S3 模型失败')
      return []
    })
    const confirmation = await ctx.bid.confirmTenderAnalysis(b.session, [{ type: 'update_project', fields: { project_name: '项目 B' } }])
    expect(confirmation).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'failed', failureReason: 'executor failed: Error: 模拟 S3 模型失败' } })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8'))).toMatchObject({ project_name: '项目 B' })
    const unchangedOrigin = parseTenderScoringArtifact(JSON.parse(await readFile(scoringOriginPath, 'utf8')))
    const confirmedScoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
    expect(unchangedOrigin.scoring_items.map(item => item.id)).toEqual(['SCORE-1', 'SCORE-2'])
    expect(confirmedScoring.scoring_items.map(item => item.id)).toEqual(['SCORE-1'])
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(b.session.deriveMessages())).not.toContain('SC-009')
    expect(JSON.stringify(b.session.deriveMessages())).toContain('analysis/scoring.json')
    expect(JSON.stringify(b.session.events)).toContain('SC-009')
    expect(await ctx.bid.retryStage(b.session)).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'waiting_user' } })
    expect(s3Contexts).toHaveLength(2)
    expect(s3Contexts.every(context => !context.includes('SC-009'))).toBe(true)
    expect(s3Contexts.every(context => context.includes('analysis/scoring.json'))).toBe(true)
    expect((await readBidProjectState(workspace))!.revision).toBeGreaterThan(before)
    expect(runtime(a.session)).toEqual({ stage: 'outline_generation', status: 'waiting_user' })
    const c = await fresh('session-c')
    expect(runtime(c.session)).toEqual({ stage: 'outline_generation', status: 'waiting_user' })
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
      schema_version: 6, section_id: 'SEC-1', verdict: 'repair', candidate_sha256: createHash('sha256').update('# 技术方案\n\n已有正文。\n').digest('hex'), writer_child_session_id: 'writer-a', reviewer_child_session_id: 'reviewer-a',
      must_answer_coverage: [{ item: '按期交付', status: 'missing', evidence_quotes: [], issue: '正文没有交付节点。' }],
      requirement_coverage: [{ requirement_id: 'REQ-1', item: '按期交付', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      response_point_coverage: [{ response_point_id: 'RP-000001', item: '说明技术方案', status: 'covered', evidence_quotes: ['已有正文。'], issue: null }],
      compliance_coverage: [],
      acceptance_criteria_results: [],
      global_compliance_checks: [],
      assignment_conflicts: [],
      claim_checks: [{ claim_quote: '按期交付', kind: 'commitment', status: 'unsupported', source_reference: null, issue: '未说明保障措施。' }],
      quality_checks: {
        bidder_response_voice: true,
        project_specific: false, structure_complete: true, legacy_project_pollution_free: true,
        placeholder_free: true, obvious_repetition_free: true,
      },
      blocking_issues: ['补充交付节点和保障措施。'],
    }))
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('review-projection')

    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')),
      section_id: 'SEC-2',
    }))
    expect((await ctx.bid.getReviewWorkbench(agent.session)).outline[0]).toMatchObject({ review_status: 'reviewing' })
    expect((await ctx.bid.getReviewChapter(agent.session, 'SEC-1')).review).toEqual({ status: 'reviewing', issues: [] })
    await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')),
      section_id: 'SEC-1',
    }))

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
        input: { plan_version: 1, section_epoch: 0, dependencies: [] },
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

  it('S5 工作台将文档级缺口和递交待确认与章节状态分开投影', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const source = (JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as { requirements: Array<{ source_refs: unknown[] }> }).requirements[0]!.source_refs
    outline.global_compliance_ids = ['GLOBAL-CONTENT', 'GLOBAL-UPLOAD']
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline))
    await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [
      { id: 'GLOBAL-CONTENT', type: '材料', raw_text: '须包含资格材料', normalized_rule: '整份文档包含资格材料', severity: 'mandatory', source_refs: source },
      { id: 'GLOBAL-UPLOAD', type: '递交', raw_text: '截止前上传', normalized_rule: '截止前完成上传', severity: 'fatal', source_refs: source },
    ] }))
    const globalReport = {
      schema_version: 1, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), items: [
        { compliance_id: 'GLOBAL-CONTENT', item: '整份文档包含资格材料', category: 'document_requirement', owners: [{ kind: 'document' }], status: 'fail', checked_chapters: [], evidence: [], affected_section_ids: ['SEC-1'], issue: '缺少资格材料。' },
        { compliance_id: 'GLOBAL-UPLOAD', item: '截止前完成上传', category: 'delivery_requirement', owners: [{ kind: 'delivery' }], status: 'pending', checked_chapters: [], evidence: [], affected_section_ids: [], issue: '缺少实际上传执行证据。' },
      ],
    } as const
    await writeFile(join(workspace.projectRoot, 'chapters/global-compliance-review.json'), JSON.stringify(globalReport))
    expect(validateGlobalComplianceReview(
      parseGlobalComplianceReviewArtifact(globalReport), outline,
      parseTenderComplianceArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/compliance.json'), 'utf8'))),
      [{ section_id: 'SEC-1', title: '技术方案', markdown: '# 技术方案\n\n已有正文。\n', candidate_sha256: createHash('sha256').update('# 技术方案\n\n已有正文。\n').digest('hex') }],
      await workspace.readManifest(),
    )).toEqual([])
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('global-review-projection')
    const view = await ctx.bid.getReviewWorkbench(agent.session)
    expect(view.summary.needs_attention_count).toBe(0)
    expect(view.global_compliance).toEqual({
      status: 'needs_attention', reviewed_count: 2, total_count: 2,
      document_issues: [{ compliance_id: 'GLOBAL-CONTENT', status: 'fail', detail: '缺少资格材料。', affected_section_ids: ['SEC-1'] }],
      delivery_todos: [{ compliance_id: 'GLOBAL-UPLOAD', status: 'pending', detail: '缺少实际上传执行证据。', affected_section_ids: [] }],
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
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toEqual(['send_message', 'export_docx', 'revise_chapter'])
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

  it('S5 完成后普通消息保持完成态，由主 Agent 判断是否需要调整计划', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('writing-plan-update')

    await expect(ctx.serial('session/prompt-admission', {
      session: agent.session,
      mode: 'queue',
      content: [{ type: 'text', text: '为什么第二章这样安排？' }],
    })).resolves.toBeUndefined()

    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: { stage: 'chapter_writing', status: 'completed' } })
    await expect(readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).resolves.toContain('已有正文')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('多轮用户原话通过稳定引用共同进入一个 Task Contract patch', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('multi-turn-contract')
    for (const content of ['第二章写详细一点。', '对，其他章节不用动。']) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: content }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const inspected = await ctx.tools.execute({
      agent, name: 'bid_stage_inspect', arguments: { view: 'task_contract_context' },
      callId: CallId('multi-turn-inspect'), signal: new AbortController().signal,
    })
    expect(inspected.isError).toBe(false)
    const refs = (inspected.value as { task_contract_context: { user_messages: Array<{ ref: object; text: string }> } })
      .task_contract_context.user_messages
    expect(refs.map(item => item.text)).toEqual(['第二章写详细一点。', '对，其他章节不用动。'])

    const committed = await ctx.tools.execute({
      agent, name: 'bid_confirm_writing_plan', arguments: {
        update_kind: 'patch', base_plan_version: 1,
        user_message_refs: refs.map(item => item.ref), summary: '只细化现有技术方案章节。',
        affected_section_ids: [],
        sections: [{
          section_id: 'SEC-1', task: '详细完成技术方案。',
          add_user_message_refs: refs.map(item => item.ref),
        }],
      },
      callId: CallId('multi-turn-commit'), signal: new AbortController().signal,
    })
    expect(committed.isError, JSON.stringify(committed)).toBe(false)
    expect(committed.value).toMatchObject({ ok: true, plan_version: 2 })
    const plan = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')) as {
      user_requirements: string[]
      sections: Array<{ user_requirements: string[] }>
      revision: { affected_section_ids: string[] }
    }
    expect(plan.user_requirements).toEqual([
      '没有特殊要求，直接开始', '第二章写详细一点。', '对，其他章节不用动。',
    ])
    expect(plan.sections[0]?.user_requirements).toEqual(['第二章写详细一点。', '对，其他章节不用动。'])
    expect(plan.revision.affected_section_ids).toEqual(['SEC-1'])
  })

  it('S5 完成且无运行操作时通过真实工具读取任务上下文，不重开写作', async () => {
    const { ctx, workspace, fresh, host, executeStage } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('completed-inspect')

    const result = await ctx.tools.execute({
      agent,
      name: 'bid_stage_inspect',
      arguments: { view: 'task_contract_context' },
      callId: CallId('completed-inspect'),
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: false,
      value: {
        runtime: { stage: 'chapter_writing', status: 'completed' },
        task_contract_context: {
          requirements: { requirements: [{ id: 'REQ-1' }] },
          evidence: { section_mappings: [{ section_id: 'SEC-1' }] },
        },
      },
    })
    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
    expect(host.inFlight.size).toBe(0)
    expect(executeStage).not.toHaveBeenCalled()
  })

  it('S5 运行中主 Agent 回答普通消息且不取消当前写作', async () => {
    const { ctx, workspace, fresh, host, executor, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const agent = await fresh('writing-plan-pause')
    const gate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'chapter_writing'
    vi.mocked(executor.execute).mockImplementationOnce(() => gate.promise)
    const retry = ctx.bid.retryStage(agent.session)
    await vi.waitFor(() => {
      expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'running' })
      expect(host.inFlight.size).toBe(1)
    })

    const admission = ctx.serial('session/prompt-admission', {
      session: agent.session,
      mode: 'steer',
      content: [{ type: 'text', text: '现在写到哪了？' }],
    })
    await expect(admission).resolves.toBeUndefined()
    adapter.script.push(
      toolCall('bid_stage_inspect', { view: 'summary' }),
      answer('正文仍在写作，当前任务继续运行。'),
    )
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '现在写到哪了？' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.script).toEqual([])
    expect(agent.session.events.some(event => event.type === 'tool/call' && event.data.name === 'bid_stage_inspect')).toBe(true)
    expect(agent.session.deriveMessages().at(-1)?.content).toContainEqual({ type: 'text', text: '正文仍在写作，当前任务继续运行。' })
    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'running' })
    expect(host.inFlight.size).toBe(1)
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
    gate.resolve([])
    await retry

    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
    expect(agent.session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'chapter_writing')).toBe(true)
    await expect(readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['tender_analysis', 'outline_generation'] as const)(
    '%s 运行任务未完成时同 Session 先回答，另一 Session 不能 steer',
    async (stage: BidStage) => {
      const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
      await seedProjectArtifacts(workspace)
      await checkpointBidProjectState(workspace, { stage, status: 'failed' })
      const agent = await fresh(`live-${stage}`)
      const gate = Promise.withResolvers<never[]>()
      executor.canExecute = candidate => candidate === stage
      executeStage.mockImplementationOnce(() => gate.promise)
      const retry = ctx.bid.retryStage(agent.session)
      await vi.waitFor(() => { expect(runtime(agent.session)).toEqual({ stage, status: 'running' }) })
      await vi.waitFor(() => { expect(executeStage).toHaveBeenCalledOnce() })
      const artifactBefore = await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
      const projectBefore = await readBidProjectState(workspace)

      await expect(ctx.serial('session/prompt-admission', {
        session: agent.session, mode: 'steer', content: [{ type: 'text', text: '现在做到哪了？' }],
      })).resolves.toBeUndefined()
      const other = await fresh(`other-${stage}`, workspace.root, false)
      await expect(ctx.serial('session/prompt-admission', {
        session: other.session, mode: 'steer', content: [{ type: 'text', text: '查看进度' }],
      })).resolves.toMatchObject({ reason: 'bid.stage_running' })

      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('当前阶段仍在执行，后台任务未停止。'))
      agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在做到哪了？' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(agent.session.deriveMessages().at(-1)?.content)
        .toContainEqual({ type: 'text', text: '当前阶段仍在执行，后台任务未停止。' })
      expect(runtime(agent.session)).toEqual({ stage, status: 'running' })
      expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
      expect(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')).toBe(artifactBefore)
      expect(await readBidProjectState(workspace)).toEqual(projectBefore)
      gate.resolve([])
      await retry
    },
  )

  it('暂停阶段只拦住 operation 调度门，继续不取消当前任务', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'failed' })
    const agent = await fresh('pause-stage-scheduling')
    const tenderArtifacts = buildBidStageTask('tender_analysis').requiredArtifacts.map((path, index) => ({
      stage: 'tender_analysis' as const, type: `artifact-${String(index)}`, path,
    }))
    const tenderGate = Promise.withResolvers<typeof tenderArtifacts>()
    executor.canExecute = stage => stage === 'tender_analysis'
    executeStage.mockImplementationOnce(() => tenderGate.promise)
    const retry = ctx.bid.retryStage(agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toEqual({ stage: 'tender_analysis', status: 'running' }) })

    adapter.script.push(toolCall('bid_pause_stage', {}), answer('已暂停后续任务调度；当前任务继续安全收敛。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '暂停当前阶段' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const active = host.inFlight.values().next().value as {
      controller: AbortController
      stageControl: StageSchedulerControl
    }
    expect(active.stageControl.paused()).toBe(true)
    expect(active.controller.signal.aborted).toBe(false)
    let laterTaskAdmitted = false
    const laterTask = active.stageControl.waitUntilRunnable(active.controller.signal).then(() => { laterTaskAdmitted = true })
    await Promise.resolve()
    expect(laterTaskAdmitted).toBe(false)

    adapter.script.push(toolCall('bid_resume_stage', {}), answer('已继续当前阶段。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await laterTask
    expect(laterTaskAdmitted).toBe(true)
    expect(active.stageControl.paused()).toBe(false)
    tenderGate.resolve(tenderArtifacts)
    const retryResult = await retry
    expect(retryResult).toEqual({ ok: true, value: { stage: 'tender_analysis', status: 'waiting_user' } })
    expect(executeStage.mock.calls).toHaveLength(1)
    expect(active.controller.signal.aborted).toBe(false)
  })

  it('S4 Mapping Child 未完成时 Main Agent 先回复，Child 与阶段随后继续', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('live-evidence-child')
    const childReady = Promise.withResolvers<SessionId>()
    const childStarted = Promise.withResolvers<undefined>()
    const releaseChild = Promise.withResolvers<undefined>()
    adapter.childGate = releaseChild.promise
    adapter.onChildRequest = () => { childStarted.resolve(undefined) }
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(async () => {
      const operation = host.inFlight.values().next().value as { controller: AbortController }
      const run = await ctx.subagents.start('spawn', {
        parent: agent,
        prompt: [{ type: 'text', text: '执行 S4 Mapping 子任务。' }],
        signal: operation.controller.signal,
      })
      childReady.resolve(run.id)
      try {
        await run.result
        return []
      } finally {
        await run.dispose()
      }
    })
    const retry = ctx.bid.retryStage(agent.session)
    try {
      const childId = await childReady.promise
      await childStarted.promise
      expect(ctx.agents.get(childId)).toBeDefined()

      adapter.script.push(toolCall('bid_stage_inspect', { view: 'summary' }), answer('Mapping Child 仍在后台执行。'))
      agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在查到哪里了？' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(agent.session.deriveMessages().at(-1)?.content)
        .toContainEqual({ type: 'text', text: 'Mapping Child 仍在后台执行。' })
      expect(ctx.agents.get(childId)).toBeDefined()
      expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'running' })
      expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
      releaseChild.resolve(undefined)
      await retry
      expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
    } finally {
      releaseChild.resolve(undefined)
    }
  })

  it('Host 管理的 Child 报告不唤醒 Main Agent', async () => {
    const { ctx, workspace, fresh, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('quiet-host-child-report')
    const stageGate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = ctx.bid.retryStage(agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'running' }) })

    const onRequest = vi.fn()
    adapter.onRequest = onRequest
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '内部研究结果。' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('mapping-child') },
    }))
    await agent.whenIdle()

    expect(onRequest).not.toHaveBeenCalled()
    stageGate.reject(new Error('模拟 S4 执行失败'))
    await expect(retry).resolves.toMatchObject({ ok: true, value: {
      stage: 'evidence_mapping', status: 'failed',
    } })
    expect(ctx.sessionProjections.snapshot(agent.session).values['bid.runtime']).toMatchObject({
      runtime: { stage: 'evidence_mapping', status: 'failed' },
      allowedActions: ['retry_stage'],
    })
  })

  it('停止当前回复不取消 S4 operation 或后台任务', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('cancel-public-reply')
    const stageGate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = ctx.bid.retryStage(agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'running' }) })

    const requestStarted = Promise.withResolvers<undefined>()
    const responseGate = Promise.withResolvers<undefined>()
    adapter.onRequest = () => { requestStarted.resolve(undefined) }
    adapter.requestGate = responseGate.promise
    adapter.script.push(answer('这条回复不应完成。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '查看当前进度' }], source: { kind: 'user' } }))
    await requestStarted.promise
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    responseGate.resolve(undefined)
    await agent.whenIdle()

    expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'running' })
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: false } } })
    stageGate.resolve([])
    await retry
  })

  it('停止任务只取消同 Session 的阶段 controller，并进入现有重试状态', async () => {
    const { ctx, workspace, fresh, host, executor, executeStage, adapter } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed' })
    const agent = await fresh('stop-stage')
    const stageGate = Promise.withResolvers<never[]>()
    executor.canExecute = stage => stage === 'evidence_mapping'
    executeStage.mockImplementationOnce(() => stageGate.promise)
    const retry = ctx.bid.retryStage(agent.session)
    await vi.waitFor(() => { expect(runtime(agent.session)).toEqual({ stage: 'evidence_mapping', status: 'running' }) })

    const other = await fresh('stop-stage-other', workspace.root, false)
    await expect(ctx.bid.stopStage(other.session)).resolves.toMatchObject({
      ok: false, error: { code: 'BID_STAGE_OWNED_BY_ANOTHER_SESSION' },
    })
    adapter.script.push(toolCall('bid_stop_stage', {}), answer('已停止当前阶段任务；当前聊天仍可继续。'))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: '请停止当前阶段' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(runtime(agent.session)).toMatchObject({
      stage: 'evidence_mapping', status: 'failed', failureReason: '用户已明确停止当前阶段；可从该阶段重试。',
    })
    expect(agent.session.events.some(event => event.type === 'tool/call' && event.data.name === 'bid_stop_stage')).toBe(true)
    expect(host.inFlight.values().next().value).toMatchObject({ controller: { signal: { aborted: true } } })
    stageGate.resolve([])
    const stopped = await retry
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) throw new Error('停止阶段后重试应返回失败状态')
    expect(stopped.value).toMatchObject({ stage: 'evidence_mapping', status: 'failed' })
    await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
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
    await seedProjectArtifacts(otherWorkspace)
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
