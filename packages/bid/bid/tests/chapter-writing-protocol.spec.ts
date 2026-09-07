import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { outlineArtifactSha256 } from '../src/outline-confirmation-artifacts.ts'
import { attachChapterPlan } from '../src/chapter-writing-planning.ts'
import { parseChapterExecutionPlan, validateChapterExecutionPlan } from '../src/chapter-writing-plan-artifacts.ts'
import { attachChapterReview, buildChapterReviewChecklist, type ChapterReviewEvidence } from '../src/chapter-writing-review.ts'
import { outlineFixture, emptyChapterContext } from './fixtures/chapter-writing-inputs.ts'
import { validateChapterReview } from '../src/chapter-writing-executor.ts'
import { parseChapterMetadata } from '../src/chapter-writing-artifacts.ts'

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
  const agent = ctx.agentLoop.create(SessionId('protocol'), { provider: 'mock', model: 'mock' })
  let serial = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ agent, name, arguments: args, callId: CallId(`call-${serial++}`), signal: new AbortController().signal })
  return { ctx, agent, call }
}

const relation = (section_id: string) => ({ section_id, reason: `复用 ${section_id} 的接口决策` })
const draft = (section_id: string, depends: string[] = [], related: string[] = []) => ({
  section_id, depends_on: depends.map(relation), related_sections: related.map(relation), planning_notes: [],
})
const quality = {
  project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
  placeholder_free: true, obvious_repetition_free: true,
}

describe('S5 私有关系规划', () => {
  it('仅提交特殊关系仍按目录生成全部章节，upsert 不改变顺序，全局说明 trim 去重', async () => {
    const { ctx, agent, call } = await harness()
    const outline = outlineFixture()
    const hash = outlineArtifactSha256(outline)
    const runtime = attachChapterPlan(agent, outline, hash, 1)
    for (const schema of ctx.tools.schemas(agent)) assertSupportedJsonSchema(schema.parameters)
    expect((await call('finish_chapter_plan', {})).value).toMatchObject({ completed: false })
    await call('add_global_consistency_note', { note: '  统一接口命名。  ' })
    await call('add_global_consistency_note', { note: '统一接口命名。' })
    await call('set_chapter_relations', draft('SEC-3', ['SEC-2']))
    await call('set_chapter_relations', draft('SEC-3', ['SEC-1'], ['SEC-2']))
    expect((await call('finish_chapter_plan', {})).value).toEqual({ completed: true })
    const plan = parseChapterExecutionPlan(runtime.captured())
    expect(plan.sections.map(section => section.section_id)).toEqual(['SEC-1', 'SEC-2', 'SEC-3'])
    expect(plan.sections[0]?.depends_on).toEqual([])
    expect(plan.sections[2]?.depends_on).toEqual([relation('SEC-1')])
    expect(plan.sections[2]?.related_sections).toEqual([{ ...relation('SEC-2'), strength: 'weak' }])
    expect(plan.global_consistency_notes).toEqual(['统一接口命名。'])
    expect(validateChapterExecutionPlan(plan, outline, hash)).toEqual([])
    expect((await call('set_chapter_relations', draft('SEC-3'))).isError).toBe(true)
    runtime.dispose()
    expect(ctx.tools.schemas(agent)).toEqual([])
  })

  it('未知节点、自引用、重复、强弱冲突均即时拒绝且不污染关系', async () => {
    const { agent, call } = await harness()
    const outline = outlineFixture()
    const runtime = attachChapterPlan(agent, outline, outlineArtifactSha256(outline), 0)
    await call('add_global_consistency_note', { note: '统一接口。' })
    await call('set_chapter_relations', draft('SEC-3', ['SEC-1']))
    for (const invalid of [draft('UNKNOWN'), draft('STRUCT'), draft('SEC-3', ['UNKNOWN']), draft('SEC-3', ['SEC-3']), draft('SEC-3', ['SEC-2', 'SEC-2']), draft('SEC-3', [], ['SEC-2', 'SEC-2']), draft('SEC-3', ['SEC-2'], ['SEC-2'])]) {
      expect((await call('set_chapter_relations', invalid)).isError).toBe(true)
    }
    await call('finish_chapter_plan', {})
    expect(runtime.captured()?.sections[2]?.depends_on).toEqual([relation('SEC-1')])
  })

  it('环路 finish 返回具体路径，同一 Agent 局部修正后完成', async () => {
    const { agent, call } = await harness()
    const outline = outlineFixture()
    const runtime = attachChapterPlan(agent, outline, outlineArtifactSha256(outline), 0)
    await call('add_global_consistency_note', { note: '统一接口。' })
    await call('set_chapter_relations', draft('SEC-1', ['SEC-2']))
    await call('set_chapter_relations', draft('SEC-2', ['SEC-1']))
    const result = await call('finish_chapter_plan', {})
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.value)).toContain('SEC-1 → SEC-2 → SEC-1')
    expect(runtime.captured()).toBeUndefined()
    await call('set_chapter_relations', draft('SEC-2'))
    await call('finish_chapter_plan', {})
    expect(runtime.captured()?.sections[0]?.depends_on).toEqual([relation('SEC-2')])
  })

  it('最终工具失败不能伪造提交，成功后其他调用不能改写；取消不能提交', async () => {
    const { ctx, agent, call } = await harness()
    const outline = outlineFixture()
    const runtime = attachChapterPlan(agent, outline, outlineArtifactSha256(outline), 0)
    await call('add_global_consistency_note', { note: '统一接口。' })
    const undo = ctx.on('tools/post-execute', (exec, _result, next) => exec.name === 'finish_chapter_plan'
      ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'rejected' }] }) : next())
    expect((await call('finish_chapter_plan', {})).isError).toBe(true)
    expect(runtime.captured()).toBeUndefined()
    undo()
    const controller = new AbortController()
    controller.abort()
    await ctx.tools.execute({ agent, name: 'finish_chapter_plan', arguments: {}, callId: CallId('aborted'), signal: controller.signal })
    expect(runtime.captured()).toBeUndefined()
    await call('finish_chapter_plan', {})
    expect(runtime.captured()).toBeDefined()
  })

  it('嵌套完成必须等待外层工具权威成功，外层失败后可重新 finish', async () => {
    const { ctx, agent, call } = await harness()
    const outline = outlineFixture()
    const runtime = attachChapterPlan(agent, outline, outlineArtifactSha256(outline), 0)
    await call('add_global_consistency_note', { note: '统一接口。' })
    ctx.tools.register({
      name: 'transport', description: 'nested transport', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] },
      async execute(_args, exec) {
        await ctx.tools.execute({ agent, name: 'finish_chapter_plan', arguments: {}, callId: CallId('nested-finish'), signal: exec.signal, parent: exec.token })
        expect(runtime.captured()).toBeUndefined()
        return {}
      },
    })
    const undo = ctx.on('tools/post-execute', (exec, _result, next) => exec.name === 'transport'
      ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'outer failed' }] }) : next())
    expect((await call('transport', {})).isError).toBe(true)
    expect(runtime.captured()).toBeUndefined()
    undo()
    await call('finish_chapter_plan', {})
    expect(runtime.captured()).toBeDefined()
  })
})

function reviewContext() {
  const context = emptyChapterContext(outlineFixture().sections[1]!)
  context.section = { ...context.section, must_answer: ['相同文字', '相同文字'] }
  context.requirements = [{ id: 'REQ-1', category: '技术', raw_text: '要求原文', normalized_requirement: '必须实施审计', mandatory: true, source_refs: [] }]
  context.compliance = [{ id: 'GLOBAL-1', type: '强制', raw_text: '全局规则', normalized_rule: '全局安全约束', severity: 'mandatory', source_refs: [] }]
  context.responsePoints = [{ id: 'RP-000001', scoring_id: 'SCORE-1', order: 1, text: '评分细项' }]
  return context
}

const evidence: ChapterReviewEvidence[] = [
  { source_ref: 'E1', locator: 'corpus/reference/chunks/chunk_0001.md', category: 'reference', allowed_claim_kinds: ['project_fact', 'technical_fact', 'commitment'], content: '企业事实原文', truncated: false },
  { source_ref: 'E2', locator: 'analysis/web-sources/WEB-test.md', category: 'web', allowed_claim_kinds: ['technical_fact'], content: '公共技术原文', truncated: false },
  { source_ref: 'E3', locator: 'chapter-handoff:SEC-2', category: 'handoff', allowed_claim_kinds: [], content: '前章结论', truncated: false },
]

const covered = (item_ref: string) => ({ item_ref, status: 'covered', evidence_quote_refs: ['Q1'], issue: null })

describe('S5 Reviewer 分批记录', () => {
  it('全局 Compliance、重复文本独立编号，乱序分批与同批 upsert 按 canonical 顺序组装', async () => {
    const { ctx, agent, call } = await harness()
    const context = reviewContext()
    const checklist = buildChapterReviewChecklist(context)
    expect(checklist).toHaveLength(5)
    expect(checklist[4]).toMatchObject({ item_ref: 'R5', kind: 'compliance', id: 'GLOBAL-1' })
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '完整正文证据']]), evidence, 1)
    for (const schema of ctx.tools.schemas(agent)) assertSupportedJsonSchema(schema.parameters)
    await call('review_coverage_items', { items: [covered('R5'), covered('R2')] })
    expect((await call('finish_chapter_review', {})).value).toEqual({ completed: false, missing_items: ['R1', 'R3', 'R4'], missing_summary: true })
    await call('review_coverage_items', { items: [covered('R4'), { item_ref: 'R1', status: 'missing', evidence_quote_refs: [], issue: '未响应' }, covered('R1'), covered('R3')] })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: [] })
    await call('finish_chapter_review', {})
    const report = runtime.captured()!
    expect(report.verdict).toBe('pass')
    expect(report.must_answer_coverage.map(item => item.item)).toEqual(['相同文字', '相同文字'])
    expect(report.compliance_coverage[0]?.item).toBe('全局安全约束')
    expect(report.blocking_issues).toEqual([])
    const metadata = parseChapterMetadata({
      section_id: context.section.id, covered_must_answer: context.section.must_answer,
      covered_scoring_response_point_ids: [], covered_scoring_response_points: [],
      local_materials_used: [], web_materials_used: [], unresolved_topics: [],
      handoff: { section_id: context.section.id, decisions: [], terminology: [],
        numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [],
      },
    })
    expect(validateChapterReview(context, { section_id: context.section.id, markdown: '完整正文证据', metadata }, report)).toEqual([])
  })

  it('批次明确返回接受项和失败项，无效 R/Q/status 不覆盖已接受记录', async () => {
    const { agent, call } = await harness()
    const context = reviewContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文']]), evidence, 0)
    const result = await call('review_coverage_items', { items: [
      covered('R1'), covered('R999'), { ...covered('R1'), evidence_quote_refs: ['Q999'] },
      { ...covered('R2'), evidence_quote_refs: [] }, { ...covered('R2'), issue: 'covered 不能带问题' },
      { ...covered('R2'), status: 'missing', issue: 'missing 不能带 Q' },
      { ...covered('R2'), status: 'missing', evidence_quote_refs: [] },
    ] })
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ recorded: ['R1'] })
    expect((result.value as { rejected: unknown[] }).rejected).toHaveLength(6)
    expect((await call('finish_chapter_review', {})).value).toMatchObject({ missing_items: ['R2', 'R3', 'R4', 'R5'] })
    expect(runtime.captured()).toBeUndefined()
  })

  it.each(['coverage', 'quality', 'extra', 'claim'])('单独的 %s 问题均得到合法 repair；可撤销 summary 和修正派生问题', async (kind) => {
    const { agent, call } = await harness()
    const context = reviewContext()
    const runtime = attachChapterReview(agent, context, new Map([['Q1', '正文']]), evidence, 0)
    await call('review_coverage_items', { items: buildChapterReviewChecklist(context).map(item => covered(item.item_ref)) })
    await call('set_review_summary', { quality_checks: quality, blocking_issues: ['  可撤销  ', '可撤销'] })
    await call('set_review_summary', { quality_checks: { ...quality, structure_complete: kind !== 'quality' }, blocking_issues: kind === 'extra' ? ['额外问题'] : [] })
    if (kind === 'coverage') await call('review_coverage_items', { items: [{ item_ref: 'R1', status: 'missing', evidence_quote_refs: [], issue: '具体缺口' }] })
    await call('review_claims', { items: [{ claim_quote_ref: 'Q1', kind: 'project_fact', status: 'unsupported', source_reference: null, issue: '原文没有支持' }] })
    if (kind !== 'claim') await call('review_claims', { items: [{ claim_quote_ref: 'Q1', kind: 'project_fact', status: 'supported', source_reference: 'E1', issue: null }] })
    expect((await call('finish_chapter_review', {})).value).toEqual({ completed: true })
    expect(runtime.captured()?.verdict).toBe('repair')
    expect(runtime.captured()?.blocking_issues).not.toContain('可撤销')
    if (kind !== 'claim') expect(runtime.captured()?.blocking_issues.join()).not.toContain('原文没有支持')
    expect(runtime.captured()?.claim_checks[0]?.source_reference).toBe(kind === 'claim' ? null : evidence[0]?.locator)
  })

  it('来源和 Q 身份属于当前包，Web 或 handoff 不能洗成企业事实证据', async () => {
    const { agent, call } = await harness()
    attachChapterReview(agent, reviewContext(), new Map([['Q1', '正文']]), evidence, 0)
    const base = { claim_quote_ref: 'Q1', kind: 'project_fact', status: 'supported', source_reference: 'E1', issue: null }
    const result = await call('review_claims', { items: [base, { ...base, source_reference: 'E999' }, { ...base, source_reference: 'E2' }, { ...base, source_reference: 'E3' }, { ...base, claim_quote_ref: 'Q999' }, { ...base, status: 'unsupported', source_reference: null }] })
    expect(result.isError).toBeFalsy()
    expect((result.value as { rejected: unknown[] }).rejected).toHaveLength(5)
    expect(result.value).toMatchObject({ recorded: ['Q1/project_fact'] })
  })

  it('三章注册互不可见，释放一个 scope 不影响其他章', async () => {
    const { ctx, agent } = await harness()
    const second = ctx.agentLoop.create(SessionId('second'), { provider: 'mock', model: 'mock' })
    const third = ctx.agentLoop.create(SessionId('third'), { provider: 'mock', model: 'mock' })
    const runtime = attachChapterReview(agent, reviewContext(), new Map([['Q1', '第一章']]), evidence, 0)
    expect(ctx.tools.schemas(second)).toEqual([])
    expect(ctx.tools.schemas(third)).toEqual([])
    const secondRuntime = attachChapterReview(second, reviewContext(), new Map([['Q1', '第二章']]), evidence, 0)
    runtime.dispose()
    expect(ctx.tools.schemas(agent)).toEqual([])
    expect(ctx.tools.schemas(second)).toHaveLength(4)
    secondRuntime.dispose()
    expect(ctx.tools.schemas(second)).toEqual([])
  })
})
