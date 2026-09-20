import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { attachChapterReview, buildChapterReviewChecklist, type ChapterReviewEvidence, type ChapterRevisionReviewIssue } from '../src/chapter-writing-review.ts'
import { emptyChapterContext, outlineFixture } from './fixtures/chapter-writing-inputs.ts'
import { validateChapterReview } from '../src/chapter-writing-executor.ts'
import { settleRevisionBatchIssues, type RevisionIssueCheck } from '../src/chapter-revision-batch.ts'
import type { RevisionQueueArtifact } from '../src/chapter-revision-queue.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId('reviewer-protocol'), { provider: 'mock', model: 'mock' })
  let serial = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ agent, name, arguments: args, callId: CallId(`call-${serial++}`), signal: new AbortController().signal })
  return { ctx, agent, call }
}

const evidence: readonly ChapterReviewEvidence[] = [{
  source_ref: 'E1', locator: 'tender.json', category: 'tender',
  allowed_claim_kinds: ['project_fact', 'technical_fact', 'commitment'], content: '招标文件原文', truncated: false,
}]

const quality = {
  bidder_response_voice: true,
  project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
  placeholder_free: true, obvious_repetition_free: true,
}

const covered = (item_ref: string) => ({ item_ref, status: 'covered', evidence_quote_refs: ['Q1'], issue: null })

function makeContext() {
  const context = emptyChapterContext(outlineFixture().sections[1]!)
  context.sectionWritingPlan = { ...context.sectionWritingPlan, acceptance_criteria: [] }
  return context
}

function makeQueue(issueIds: string[]): RevisionQueueArtifact {
  return {
    schema_version: 1,
    revision: 1,
    issues: issueIds.map(id => ({
      issue_id: id,
      section_id: 'SEC-001',
      section_title: '技术架构',
      scope: 'chapter' as const,
      reference: { scope: 'chapter' as const, base_content_sha256: '0'.repeat(64) },
      instruction: `指令 ${id}`,
      suggestion: null,
      status: 'scheduled' as const,
      batch_id: 'BATCH-1',
      created_at: 1000,
      updated_at: 1000,
    })),
  }
}

describe('任务 01: Reviewer 真正审核 RevisionIssue', () => {
  const issues: ChapterRevisionReviewIssue[] = [
    { issue_id: 'REV-001', scope: 'chapter', instruction: '完善架构图说明', suggestion: '增加模块交互细节', reference_text: null },
    { issue_id: 'REV-002', scope: 'paragraphs', instruction: '修改过时的接口版本', suggestion: '更新为 v2.0', reference_text: '使用 v1.0 接口' },
  ]

  it('1. 2 条 issue 全 satisfied → finish 成功且 verdict 为 pass', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    const revResult = await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '架构图说明已补充完整' },
        { issue_id: 'REV-002', status: 'satisfied', reason: '已更新为 v2.0 接口' },
      ],
    })
    expect(revResult.isError).toBeFalsy()
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    const finishRes = await call('finish_chapter_review', {})
    expect(finishRes.isError).toBeFalsy()

    const review = runtime.captured()
    expect(review).toBeDefined()
    expect(review?.verdict).toBe('pass')
    expect(review?.revision_issue_checks).toEqual([
      { issue_id: 'REV-001', status: 'satisfied', reason: '架构图说明已补充完整' },
      { issue_id: 'REV-002', status: 'satisfied', reason: '已更新为 v2.0 接口' },
    ])
  })

  it('2. 1 satisfied + 1 unsatisfied → verdict 联动为 repair，blocking 包含未满足项', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '架构图说明已补充完整' },
        { issue_id: 'REV-002', status: 'unsatisfied', reason: '正文仍然残留 v1.0 描述' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})

    const review = runtime.captured()
    expect(review).toBeDefined()
    expect(review?.verdict).toBe('repair')
    expect(review?.blocking_issues).toContain('审批意见未满足：REV-002 unsatisfied: 正文仍然残留 v1.0 描述')
  })

  it('段落修订不把选区外既存缺陷自动升级为 blocking issue', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues, true)
    const checklist = buildChapterReviewChecklist(context)

    await call('review_coverage_items', { items: checklist.map((item, index) => index === 0
      ? { item_ref: item.item_ref, status: 'missing', evidence_quote_refs: [], issue: '选区外原文已有缺失' }
      : covered(item.item_ref)) })
    await call('review_revision_issues', { items: issues.map(issue => ({ issue_id: issue.issue_id, status: 'satisfied', reason: '选区内意见已完成' })) })
    await call('set_review_summary', {
      quality_checks: { ...quality, obvious_repetition_free: false },
      blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false,
    })
    await call('finish_chapter_review', {})

    expect(runtime.captured()?.verdict).toBe('pass')
    expect(runtime.captured()?.blocking_issues).toEqual([])
  })

  it('3. unsatisfied 会被纳入 blocking_issues 并可被 validateChapterReview 正确接受', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const candidate = {
      section_id: context.section.id,
      markdown: '# 标题\n\n正文内容',
      metadata: {
        section_id: context.section.id,
        covered_must_answer: context.section.must_answer,
        covered_scoring_response_point_ids: [],
        covered_scoring_response_points: [],
        local_materials_used: [],
        web_materials_used: [],
        unresolved_topics: [],
        handoff: {
          section_id: context.section.id, decisions: [], terminology: [],
          numbers_and_parameters: [], interfaces: [], deployment_constraints: [],
          cross_reference_targets: [], unresolved_topics: [],
        },
        flowcharts: [],
      },
    }
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '已完成' },
        { issue_id: 'REV-002', status: 'unsatisfied', reason: '接口描述未修改' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})

    const review = runtime.captured()!
    const issuesList = validateChapterReview(context, candidate, review)
    expect(issuesList).toEqual([])
    expect(review.verdict).toBe('repair')
  })

  it('4. repair 后重新审核全 satisfied', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 1, [], issues)

    // 第一轮 repair
    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '已完成' },
        { issue_id: 'REV-002', status: 'unsatisfied', reason: '未完成' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})
    expect(runtime.captured()?.verdict).toBe('repair')

    // 第二轮进入 repair 后全 satisfied
    runtime.nextRound()
    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '已完成' },
        { issue_id: 'REV-002', status: 'satisfied', reason: '修复后已完成' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})
    expect(runtime.captured()?.verdict).toBe('pass')
  })

  it('5. needs_input 不无限 repair，引导至 attention', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
        { issue_id: 'REV-002', status: 'needs_input', reason: '需要用户提供第三方系统的最新接口文档' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})

    const review = runtime.captured()
    expect(review?.verdict).toBe('attention')
    expect(review?.blocking_issues).toEqual([])
  })

  it('6. 未知 issue_id 被 review_revision_issues 拒绝', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    const res = await call('review_revision_issues', {
      items: [{ issue_id: 'REV-UNKNOWN', status: 'satisfied', reason: '不存在' }],
    })
    const output = (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
    expect(output).toContain('未知审批意见 REV-UNKNOWN')
  })

  it('7. 漏 issue 时 finish 失败并返回 missing_revision_issue_ids', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    // 只记录 REV-001，漏了 REV-002
    await call('review_revision_issues', {
      items: [{ issue_id: 'REV-001', status: 'satisfied', reason: '完成' }],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    const finishRes = await call('finish_chapter_review', {})
    const text = (finishRes as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}'
    const output = JSON.parse(text) as { completed: boolean; missing_revision_issue_ids: string[] }
    expect(output.completed).toBe(false)
    expect(output.missing_revision_issue_ids).toEqual(['REV-002'])
    expect(runtime.captured()).toBeUndefined()
  })

  it('8. 非 revision batch Reviewer 行为不变', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    // revisionIssues 为空
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], [])

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    const finishRes = await call('finish_chapter_review', {})
    expect(finishRes.isError).toBeFalsy()

    const review = runtime.captured()
    expect(review?.verdict).toBe('pass')
    expect(review?.revision_issue_checks).toBeUndefined()
  })

  it('9. review artifact 真实包含 revision_issue_checks', async () => {
    const { agent, call } = await harness()
    const context = makeContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文内容']]), evidence, 0, [], issues)

    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('review_revision_issues', {
      items: [
        { issue_id: 'REV-001', status: 'satisfied', reason: '原因1' },
        { issue_id: 'REV-002', status: 'satisfied', reason: '原因2' },
      ],
    })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [], assignment_conflicts: [], external_input_gaps: [], external_input_only: false })
    await call('finish_chapter_review', {})

    const review = runtime.captured()!
    expect(review.revision_issue_checks).toHaveLength(2)
    expect(review.revision_issue_checks?.[0]).toEqual({ issue_id: 'REV-001', status: 'satisfied', reason: '原因1' })
    expect(review.revision_issue_checks?.[1]).toEqual({ issue_id: 'REV-002', status: 'satisfied', reason: '原因2' })
  })

  it('10. settle 根据 checks 正确结算；缺少 check 抛出 BID_REVISION_REVIEW_INCOMPLETE', () => {
    const queue = makeQueue(['REV-001', 'REV-002'])

    // 成功结算场景
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '已按要求修改' },
      { issue_id: 'REV-002', status: 'needs_input', reason: '需要补充数据' },
    ]
    const result = settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], checks, 2000)
    expect(result.taskStatus).toBe('needs_input')
    expect(result.queue.issues.find(i => i.issue_id === 'REV-001')?.status).toBe('completed')
    expect(result.queue.issues.find(i => i.issue_id === 'REV-002')?.status).toBe('needs_input')

    // 缺少 check 拒绝静默标记 failed，而是严格抛出异常
    expect(() => settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], [checks[0]!], 2000))
      .toThrow('BID_REVISION_REVIEW_INCOMPLETE')
  })
})
