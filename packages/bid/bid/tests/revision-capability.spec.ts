/** 审批适配器的确定性故障回归；执行响应由显式 runner 控制。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { seedCapabilityProject } from './capability-fixture.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { addRevisionIssue, readRevisionQueue, writeRevisionQueue } from '../src/chapter-revision-queue.ts'
import { readRevisionBatch, writeRevisionBatch } from '../src/chapter-revision-batch.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { freezeBidTaskSource } from '../src/bid-task-source.ts'
import { bidCapabilityTaskSchema, type BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { allowedRevisionCapabilityWrites, executeRevisionCapability, type CapabilityRevisionRunner } from '../src/bid-revision-capability.ts'
import { buildParagraphRevisionReviewPath, createParagraphRevisionReviewArtifact } from '../src/chapter-paragraph-revision-artifacts.ts'
import { parseChapterReviewArtifact } from '../src/chapter-writing-review-artifacts.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bid-revision-capability-'))
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '确定性适配器回归' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  const agent = ctx.agentLoop.create(SessionId('revision-main'), { provider: 'test', model: 'test' }, { cwd: root })
  const session = agent.session
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '逐项修订所选三章意见。' }] })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  let queue = await readRevisionQueue(workspace)
  for (let index = 1; index <= 3; index++) {
    const body = await readFile(join(workspace.projectRoot, 'chapters/sections/' + String(index).padStart(4, '0') + '.md'), 'utf8')
    queue = addRevisionIssue(queue, { section_id: 'SEC-' + String(index), scope: 'paragraphs',
      reference: { scope: 'paragraphs', base_content_sha256: chapterContentSha256(body), start: 0, end: body.length, text: body },
      instruction: '改进本选区的措辞', suggestion: null }, '章节' + String(index), Date.now())
  }
  await writeRevisionQueue(workspace, queue)
  const task = bidCapabilityTaskSchema.parse({ goal: '逐项修订所选三章意见', issue_ids: queue.issues.map(issue => issue.issue_id),
    scope: { kind: 'sections', section_ids: ['SEC-1', 'SEC-2', 'SEC-3'] }, steps: [{ description: '按原意见修订',
      scope: { source: 'task' }, call: { capability: 'chapter.revision_batch', input: {
        issue_ids: queue.issues.map(issue => issue.issue_id), tasks: queue.issues.map((issue, index) => ({
          task_id: 'task-' + String(index + 1), section_id: issue.section_id, issue_ids: [issue.issue_id],
          depends_on: index === 1 ? ['task-1'] : [], ...(index === 1 ? { dependency_reason: '保持第一章术语' } : {}),
        })),
      } } }] })
  const call = task.steps[0]!.call
  if (call.capability !== 'chapter.revision_batch') throw new Error('夹具没有修订批次')
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const sourceSnapshot = await freezeBidTaskSource(workspace, session, task, authorization)
  const allowedWrites = await allowedRevisionCapabilityWrites(call, workspace, 'step-1')
  const context: BidCapabilityExecutionContext = { canonical: workspace, working: workspace, agent,
    sourceSession: session, sourceSnapshot, run: createTestBidRunContext(), sectionIds: new Set(['SEC-1', 'SEC-2', 'SEC-3']),
    stepDirectory: join(root, 'step'), inputSources: new Map(), baselineHashes: new Map(), allowedWrites,
    stepId: 'step-1', rootWorkId: 'work-1', authorization, inputSha256: 'a'.repeat(64) }
  const runner = vi.fn<CapabilityRevisionRunner>(async (input) => {
    const batch = await readRevisionBatch(workspace, input.batchId)
    if (batch === null) throw new Error('夹具没有候选批次')
    for (const unit of input.tasks) {
      const index = Number(unit.section_id.slice(4))
      const path = join(workspace.projectRoot, 'chapters/sections/' + String(index).padStart(4, '0') + '.md')
      const before = await readFile(path, 'utf8')
      const after = before + '\n修订后的表述。\n'
      await writeFile(path, after)
      const artifact = createParagraphRevisionReviewArtifact({ batch_id: input.batchId, task_id: unit.task_id,
        section_id: unit.section_id, issue_ids: [...unit.issue_ids], before_sha256: chapterContentSha256(before),
        after_sha256: chapterContentSha256(after), writer_child_session_id: 'writer', reviewer_child_session_id: 'reviewer',
        issue_checks: unit.issue_ids.map(issue_id => ({ issue_id, status: 'satisfied', reason: '确定性测试响应' })), created_at: 1 })
      const reviewPath = join(workspace.projectRoot, buildParagraphRevisionReviewPath(input.batchId, unit.task_id))
      await mkdir(dirname(reviewPath), { recursive: true })
      await writeFile(reviewPath, JSON.stringify(artifact))
    }
    await writeRevisionBatch(workspace, { ...batch, tasks: batch.tasks.map(unit =>
      input.tasks.some(task => task.task_id === unit.task_id) ? { ...unit, status: 'completed', completed_at: 1 } : unit) })
  })
  return { workspace, call, context, runner }
}

it('混合外部缺口与职责冲突只提问资料，结果警告保留内部冲突', async () => {
  const { workspace, call, context, runner } = await fixture()
  const partial: CapabilityRevisionRunner = async (input, candidate) => {
    await runner({ ...input, tasks: input.tasks.slice(2) }, candidate)
    const batch = (await readRevisionBatch(workspace, input.batchId))!
    await writeRevisionBatch(workspace, { ...batch, tasks: batch.tasks.map(task => task.task_id === 'task-1'
      ? { ...task, status: 'needs_input', failure: { code: 'CHAPTER_EXTERNAL_INPUT_REQUIRED', message: '缺企业证书', phase: 'reviewing' } }
      : task.task_id === 'task-2' ? { ...task, status: 'blocked', failure: { code: 'DEPENDENCY_BLOCKED', message: '依赖缺资料', phase: 'reviewing' } } : task) })
    const reviewPath = join(workspace.projectRoot, 'chapters/reviews/0001.json')
    const review = parseChapterReviewArtifact(JSON.parse(await readFile(reviewPath, 'utf8')))
    await writeFile(reviewPath, JSON.stringify({ ...review, verdict: 'attention',
      assignment_conflicts: [{ task: '职责重复', basis: '与第二章业务范围冲突', related_section_ids: ['SEC-2'] }],
      external_input_gaps: [{ item_ref: 'R1', required_material: '企业证书', reason: '必须由用户提供' }],
    }))
  }
  const { result } = await executeRevisionCapability(call, context, partial)
  expect(result.needs_input).toBe(true)
  expect(result.missing_topics).toEqual(['SEC-1：缺企业证书'])
  expect(result.warnings.join('；')).toContain('职责重复')
  expect(result.warnings.join('；')).toContain('SEC-2')
})

it('过期项及其依赖保留冲突，独立任务完成后重入不再执行且正式队列保持 pending', async () => {
  const { workspace, call, context, runner } = await fixture()
  const path = join(workspace.projectRoot, 'chapters/sections/0001.md')
  await writeFile(path, (await readFile(path, 'utf8')) + '\n外部修改。\n')
  await expect(executeRevisionCapability(call, context, runner)).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: 'STALE_BASE', artifact: 'SEC-1' }),
      expect.objectContaining({ code: 'DEPENDENCY_BLOCKED', artifact: 'SEC-2' })],
  })
  expect(runner.mock.calls[0]?.[0].tasks.map(task => task.task_id)).toEqual(['task-3'])
  expect((await readRevisionBatch(workspace, 'BATCH-step-1'))?.tasks.map(task => task.status))
    .toEqual(['conflict', 'blocked', 'completed'])
  expect(context.allowedWrites.has('chapters/revisions/queue.json')).toBe(false)
  await expect(executeRevisionCapability(call, context, runner)).rejects.toThrow('STALE_BASE')
  expect(runner).toHaveBeenCalledOnce()
  expect((await readRevisionQueue(workspace)).issues.every(issue => issue.status === 'pending')).toBe(true)
})

it.each(['batch_id', 'task_id', 'section_id', 'after_sha256'] as const)('完成候选的 Delta %s 被篡改时拒绝复用', async (field) => {
  const { workspace, call, context, runner } = await fixture()
  await executeRevisionCapability(call, context, runner)
  const path = join(workspace.projectRoot, buildParagraphRevisionReviewPath('BATCH-step-1', 'task-1'))
  const artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  artifact[field] = field === 'after_sha256' ? 'b'.repeat(64) : 'wrong-identity'
  await writeFile(path, JSON.stringify(artifact))
  await expect(executeRevisionCapability(call, context, runner)).rejects.toThrow('BID_REVISION_REVIEW_INCOMPLETE')
  expect(runner).toHaveBeenCalledOnce()
})

it.each(['failed', 'needs_input'] as const)('批次 %s 保留成功项并按真实原因恢复', async (status) => {
  const { workspace, call, context, runner } = await fixture()
  const partial: CapabilityRevisionRunner = async (input, candidate) => {
    const [failed, dependent, independent] = input.tasks
    const completed = [independent!]
    await runner({ ...input, tasks: completed }, candidate)
    const batch = await readRevisionBatch(workspace, input.batchId)
    await writeRevisionBatch(workspace, { ...batch!, tasks: batch!.tasks.map(task => task.task_id === failed!.task_id
      ? { ...task, status, failure: { code: status === 'failed' ? 'CHAPTER_WRITER_SUBMISSION_INCOMPLETE' : 'MATERIAL_MISSING',
        message: status === 'failed' ? 'Writer 未提交正文' : '缺企业资质材料', phase: 'writing' } }
      : task.task_id === dependent!.task_id ? { ...task, status: 'blocked', failure: {
        code: 'DEPENDENCY_BLOCKED', message: '依赖尚未完成', phase: 'writing' } } : task) })
  }
  if (status === 'failed') await expect(executeRevisionCapability(call, context, partial)).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: 'CHAPTER_WRITER_SUBMISSION_INCOMPLETE', artifact: 'SEC-1', path: 'task-1' }),
      expect.objectContaining({ code: 'DEPENDENCY_BLOCKED', artifact: 'SEC-2' })],
  })
  else expect(await executeRevisionCapability(call, context, partial)).toMatchObject({ result: {
    needs_input: true, missing_topics: ['SEC-1：缺企业资质材料'],
  } })
  expect((await readRevisionBatch(workspace, 'BATCH-step-1'))!.tasks.map(task => task.status))
    .toEqual([status, 'blocked', 'completed'])
  expect(await executeRevisionCapability(call, context, runner)).toMatchObject({ result: { needs_input: false } })
  expect(runner.mock.calls.map(([input]) => input.tasks.map(task => task.task_id)))
    .toEqual([['task-3'], ['task-1', 'task-2']])
})
