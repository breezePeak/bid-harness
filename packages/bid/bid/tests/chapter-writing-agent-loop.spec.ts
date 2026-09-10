import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, buildBidStageTask, executeChapterWriting, parseChapterExecutionLog, parseChapterReviewArtifact, validateChapterWriting } from '@deepseek-ai/dsh-bid'
import { CHAPTER_REVIEW_TOOLS } from '../src/chapter-writing-review.ts'
import { CHAPTER_PLAN_TOOLS } from '../src/chapter-writing-planning.ts'
import { ChapterAdapter } from './fixtures/chapter-writing-adapter.ts'
import { writeInputs } from './fixtures/chapter-writing-inputs.ts'
import { parseChapterMetadata } from '../src/chapter-writing-artifacts.ts'
import { webEvidenceContentSha256, type WebEvidenceSource } from '../src/web-evidence-source-artifacts.ts'


async function fixture(cancelWriter?: () => void, omitReviewFinish = false) {
  const ctx = new Context()
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-real-concurrent-')))
  await writeInputs(workspace)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(workspace.root, '.session-store'), compression: 'none' })
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  const adapter = new ChapterAdapter(cancelWriter, omitReviewFinish)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  for (const name of ['grep', 'read', 'web_search', 'web_fetch']) {
    ctx.effect(() => ctx.tools.register({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] }, execute: async () => ({}) }))
  }
  const agent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: workspace.root })
  const children: string[] = []
  ctx.on('agent/created', ({ agent: child }) => { if (child.session.header.parentSession === agent.id) children.push(String(child.id)) }, { global: true })
  return { ctx, workspace, adapter, agent, children }
}

describe('S5 真实 DSH Child 接入', () => {
  it('连续两轮语义修复后通过：Writer 会话不变，其他独立章节并发完成', async () => {
    const { ctx, workspace, adapter, agent } = await fixture()
    adapter.repairReviews = 2
    try {
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 3, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      const writers = log.sections[0]!.attempts.filter(attempt => attempt.role === 'writer')
      const reviewers = log.sections[0]!.attempts.filter(attempt => attempt.role === 'reviewer')
      expect(writers).toHaveLength(3)
      expect(new Set(writers.map(attempt => attempt.child_session_id)).size).toBe(1)
      expect(new Set(reviewers.map(attempt => attempt.child_session_id)).size).toBe(3)
      expect(writers.every(attempt => attempt.accepted && attempt.stop_reason === 'completed')).toBe(true)
      expect(reviewers.at(-1)!.issues).toEqual([])
      expect(log.observed_max_concurrency).toBe(3)
      expect(log.sections.slice(1).map(section => section.attempts.filter(attempt => attempt.role === 'writer').length)).toEqual([1, 1])
      const review = parseChapterReviewArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')))
      expect(review.verdict).toBe('pass')
      expect(review.writer_child_session_id).toBe(writers[0]!.child_session_id)
    } finally { await ctx.fiber.dispose() }
  })

  it.each([0, 1, 3])('修复上限为 %i 时保留最后已审候选，不无限循环', async (maxRepairAttempts) => {
    const { ctx, workspace, adapter, agent } = await fixture()
    adapter.reviewPreamble = false
    try {
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      const writers = log.sections[0]!.attempts.filter(attempt => attempt.role === 'writer')
      expect(writers).toHaveLength(maxRepairAttempts + 1)
      expect(new Set(writers.map(attempt => attempt.child_session_id)).size).toBe(1)
      const review = parseChapterReviewArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')))
      expect(review.verdict).toBe('repair')
      expect(review.writer_child_session_id).toBe(writers.at(-1)!.child_session_id)
    } finally { await ctx.fiber.dispose() }
  })

  it('修复中的模型错误不消耗语义修复次数，并在同一会话恢复', async () => {
    const { ctx, workspace, adapter, agent } = await fixture()
    adapter.repairReviews = 1
    adapter.failWriterStep = 2
    try {
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      const writers = log.sections[0]!.attempts.filter(attempt => attempt.role === 'writer')
      expect(writers.map(attempt => attempt.stop_reason)).toEqual(['completed', 'error', 'completed'])
      expect(new Set(writers.map(attempt => attempt.child_session_id)).size).toBe(1)
      expect(log.sections[0]!.attempts.at(-1)!.issues).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('修复只返回普通文本时不能沿用旧提交冒充新候选', async () => {
    const { ctx, workspace, adapter, agent } = await fixture()
    adapter.omitRepairSubmission = true
    try {
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      const writers = log.sections[0]!.attempts.filter(attempt => attempt.role === 'writer')
      expect(writers.map(attempt => attempt.accepted)).toEqual([true, false])
      expect(writers[1]!.issues).toContainEqual(expect.objectContaining({ code: 'CHAPTER_SUBAGENT_STRUCTURED_MISSING' }))
      expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toContain('首次候选')
      expect(log.sections[0]!.attempts.filter(attempt => attempt.role === 'reviewer')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('等待 Reviewer 时取消，释放所有 Writer 且不发布完成 manifest', async () => {
    const controller = new AbortController()
    const { ctx, workspace, adapter, agent, children } = await fixture()
    adapter.onReview = () => { controller.abort() }
    try {
      await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: 3, maxConcurrency: 3, signal: controller.signal,
      })).rejects.toThrow()
      for (const id of children) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await ctx.fiber.dispose() }
  })

  it('候选池坏来源不阻塞三章，已发 W1 损坏后由同一 Writer 工具拒绝并纠错，释放 Child 和私有工具', async () => {
    const { ctx, workspace, adapter, agent, children } = await fixture()
    try {
      const content = '公开技术措施与审计依据。'
      const sources: WebEvidenceSource[] = ['a', 'b', 'c'].map(key => ({
        source_id: `WEB-${key.repeat(16)}`,
        requested_url: `https://${key}.example/standard`, final_url: `https://${key}.example/standard`,
        status_code: 200, truncated: false, fetched_at: '2026-09-07T00:00:00.000Z',
        content_sha256: webEvidenceContentSha256(content), snapshot_path: `analysis/web-sources/WEB-${key.repeat(16)}.md`,
      }))
      await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
      await writeFile(join(workspace.projectRoot, sources[0]!.snapshot_path), '初始 Hash 不匹配。')
      await writeFile(join(workspace.projectRoot, sources[2]!.snapshot_path), content)
      await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ schema_version: 2, stage: 'evidence_mapping', sources }))
      const childSessions = new Map<string, Session>()
      ctx.on('agent/created', ({ agent: child }) => {
        if (child.session.header.parentSession === agent.id) childSessions.set(String(child.id), child.session)
      }, { global: true })
      let damagedWriter: string | undefined
      ctx.on('agent/request', async ({ agent: child }, next) => {
        const request = await next()
        const prompt = child.session.deriveMessages().flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        if (damagedWriter === undefined && ctx.tools.schemas(child).some(tool => tool.name === 'submit_chapter')
          && prompt.split('\n').some(line => line.startsWith('Current Chapter Blueprint：') && line.includes('"id":"SEC-2"'))) {
          const verified = prompt.split('\n').find(line => line.startsWith('Verified Web Snapshots：'))!
          expect(JSON.parse(verified.slice('Verified Web Snapshots：'.length))).toEqual([
            expect.objectContaining({ web_ref: 'W1', url: sources[2]!.final_url }),
          ])
          expect(prompt).toContain('Snapshot Hash')
          expect(prompt).toContain('ENOENT')
          expect(await readFile(join(workspace.projectRoot, sources[2]!.snapshot_path), 'utf8')).toBe(content)
          damagedWriter = String(child.id)
          await writeFile(join(workspace.projectRoot, sources[2]!.snapshot_path), 'W1 发出后正文被替换。')
        }
        return request
      }, { global: true })
      adapter.writerMetadata = (sectionId, step) => sectionId === 'SEC-2' && step === 0
        ? { web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '公开依据', supports: '技术措施' }] }
        : {}
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      expect(damagedWriter).toBeDefined()
      const events = childSessions.get(damagedWriter!)!.events
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls.map(event => event.data.name)).toEqual(['submit_chapter', 'submit_chapter'])
      expect(JSON.parse(calls[0]!.data.arguments)).toMatchObject({ metadata: { web_materials_used: [{ web_ref: 'W1' }] } })
      expect(JSON.parse(calls[1]!.data.arguments)).toHaveProperty('metadata', {})
      const results = events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(results[0]!.data.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ isError: true })]))
      expect(JSON.stringify(results[0]!.data)).toContain('Snapshot Hash')
      expect(JSON.stringify(results[0]!.data)).toContain(sources[2]!.snapshot_path)
      expect(results[1]!.data.message.content.some(block => 'isError' in block && block.isError)).toBe(false)
      expect(adapter.requests.get(damagedWriter!)!.steps).toBe(2)
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(log.observed_max_concurrency).toBe(3)
      expect(log.sections.map(section => section.status)).toEqual(['completed', 'completed', 'completed'])
      expect(log.sections.map(section => section.attempts.filter(attempt => attempt.role === 'writer').length)).toEqual([2, 1, 1])
      for (const index of [1, 2, 3]) {
        const metadata = parseChapterMetadata(JSON.parse(await readFile(join(workspace.projectRoot, `chapters/meta/${String(index).padStart(4, '0')}.json`), 'utf8')))
        expect(metadata.web_materials_used).toEqual([])
      }
      expect(new Set(children).size).toBe(7)
      for (const id of children) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
      expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['grep', 'read', 'web_fetch', 'web_search'])
    } finally { await ctx.fiber.dispose() }
  }, 30_000)

  it('三章并发，首轮工具隔离，同一 Writer 纠错、同一 Reviewer 续行并保留合法 repair', async () => {
    const { ctx, workspace, adapter, agent, children } = await fixture()
    try {
      const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3 })
      await expect(validateChapterWriting(workspace, 'chapter_writing', artifacts)).resolves.toEqual({ ok: true })
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(log.observed_max_concurrency).toBe(3)
      expect(log.sections.map(section => section.attempts.filter(attempt => attempt.role === 'writer').length)).toEqual([2, 1, 1])
      expect(log.sections.every(section => section.status === 'completed' && section.attempts.every(attempt => attempt.accepted))).toBe(true)
      const requests = [...adapter.requests.values()]
      expect(requests.filter(item => item.role === 'plan').map(item => item.tools)).toEqual([
        ['grep', 'read', 'web_fetch', 'web_search', ...CHAPTER_PLAN_TOOLS].sort(),
      ])
      expect(requests.filter(item => item.role === 'writer')).toHaveLength(3)
      expect(requests.filter(item => item.role === 'review')).toHaveLength(4)
      for (const request of requests.filter(item => item.role === 'writer')) {
        expect(request.tools).toEqual(['grep', 'read', 'submit_chapter', 'web_fetch', 'web_search'])
        expect(request.steps).toBe(request === requests.find(item => item.role === 'writer') ? 3 : 2)
      }
      for (const request of requests.filter(item => item.role === 'review')) {
        expect(request.tools).toEqual([...CHAPTER_REVIEW_TOOLS].sort())
        expect(request.steps).toBe(7)
      }
      const review = parseChapterReviewArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), 'utf8')))
      expect(review.verdict).toBe('repair')
      expect(review.blocking_issues.join()).toContain('实际设备数量')
      expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['grep', 'read', 'web_fetch', 'web_search'])
      expect(new Set(children).size).toBe(7)
      for (const id of children) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  }, 30_000)

  it('首次 Writer 请求中取消，释放全部 Child 和私有工具且不发布完成产物', async () => {
    const controller = new AbortController()
    const { ctx, workspace, agent, children } = await fixture(() => { controller.abort() })
    try {
      await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 1, maxConcurrency: 3, signal: controller.signal })).rejects.toThrow()
      for (const id of children) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
      expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['grep', 'read', 'web_fetch', 'web_search'])
      await expect(readFile(join(workspace.projectRoot, 'chapters/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await ctx.fiber.dispose() }
  }, 30_000)
  it('Reviewer 只返回普通文本时有界续行，缺 finish 不能生成正式报告', async () => {
    const { ctx, workspace, adapter, agent, children } = await fixture(undefined, true)
    try {
      await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: 1, maxConcurrency: 1,
      })).rejects.toThrow('CHAPTER_REVIEWER_FINISH_REQUIRED')
      const reviewers = [...adapter.requests.values()].filter(item => item.role === 'review')
      expect(reviewers).toHaveLength(3)
      expect([...adapter.requests.values()].filter(item => item.role === 'writer')).toHaveLength(3)
      for (const reviewer of reviewers) expect(reviewer.steps).toBe(2)
      await expect(readFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const id of children) expect(ctx.agents.get(SessionId(id))).toBeUndefined()
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('finish_chapter_review')
    } finally { await ctx.fiber.dispose() }
  }, 30_000)

})
