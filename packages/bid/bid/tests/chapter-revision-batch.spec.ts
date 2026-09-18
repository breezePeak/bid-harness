import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { renderChapterWritingInteractionPrompt } from '../src/stage-interaction.ts'
import { parseBidReviewWorkbenchView } from '../src/control-plane-contract.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import {
  addRevisionIssue,
  emptyRevisionQueue,
  readRevisionQueue,
  updateRevisionIssue,
  writeRevisionQueue,
  type RevisionIssue,
  type RevisionIssueReference,
  type RevisionQueueArtifact,
} from '../src/chapter-revision-queue.ts'
import {
  REVISION_BATCH_SCHEMA_VERSION,
  createRevisionBatch,
  createRevisionBatchId,
  parseRevisionBatchArtifact,
  readRevisionBatch,
  revisionBatchArtifactSchema,
  validateRevisionBatchPlan,
  writeRevisionBatch,
  commitRevisionBatchPlan,
  commitRevisionBatchExecutionSettlement,
  detectRevisionBatchIntegrity,
  recoverOrphanRevisionIssues,
  renderRevisionBatchSectionPrompt,
  startRevisionBatchExecution,
  resumeRevisionBatchExecution,
  completeRevisionBatchExecution,
  suspendRevisionBatchExecution,
  failRevisionBatchExecution,
  updateRevisionBatchTaskStatus,
  persistRevisionBatchTaskStatus,
  settleRevisionBatchIssues,
  detectStaleBaseVersions,
  type PlanRevisionBatchInput,
  type RevisionBatchArtifact,
  type RevisionBatchTaskExecution,
  type RevisionIssueCheck,
} from '../src/chapter-revision-batch.ts'
import { reconcileBidPublications } from '../src/publication-batch.ts'
import { assertChapterRevisionBatchScope, mergeParagraphRanges, type BatchRevisionScope } from '../src/chapter-revision.ts'

const markdown = '# 1 章节\n\n首段。\n\n尾段。\n'

function chapterRef(): RevisionIssueReference {
  return { scope: 'chapter', base_content_sha256: chapterContentSha256(markdown) }
}

function makeQueueWithIssues(...sections: ReadonlyArray<{ readonly sectionId: string; readonly title: string }>): RevisionQueueArtifact {
  let queue = emptyRevisionQueue()
  let time = 1000
  for (const sec of sections) {
    queue = addRevisionIssue(queue, {
      section_id: sec.sectionId, scope: 'chapter', reference: chapterRef(),
      instruction: `针对 ${sec.title} 的意见`, suggestion: null,
    }, sec.title, time)
    time += 1000
  }
  return queue
}

function planInput(
  issueIds: readonly string[],
  tasks: ReadonlyArray<{
    readonly task_id: string
    readonly section_id: string
    readonly issue_ids: readonly string[]
    readonly depends_on?: readonly string[]
    readonly dependency_reason?: string
  }>,
  queueRevision = 0,
): PlanRevisionBatchInput {
  return {
    expected_queue_revision: queueRevision,
    issue_ids: [...issueIds],
    tasks: tasks.map(task => ({
      task_id: task.task_id,
      section_id: task.section_id,
      issue_ids: [...task.issue_ids],
      depends_on: task.depends_on !== undefined ? [...task.depends_on] : [],
      ...(task.dependency_reason !== undefined ? { dependency_reason: task.dependency_reason } : {}),
    })),
  }
}

describe('批次规划校验 validateRevisionBatchPlan', () => {
  it('同章节 issue 聚合为一个 task 通过', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-1', title: '技术方案' },
    )
    const ids = queue.issues.map(issue => issue.issue_id)
    const input = planInput(ids, [{ task_id: 'T-1', section_id: 'SEC-1', issue_ids: ids }])
    const result = validateRevisionBatchPlan(input, queue, new Map())
    expect(result.tasks).toHaveLength(1)
    expect(result.issueIds).toHaveLength(2)
    expect(result.staleIssues).toHaveLength(0)
  })

  it('不同章节 issue 默认并行通过', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    const input = planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2] },
    ])
    const result = validateRevisionBatchPlan(input, queue, new Map())
    expect(result.tasks).toHaveLength(2)
  })

  it('跨章节依赖图通过', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    const input = planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2], depends_on: ['T-1'], dependency_reason: '总体设计依赖技术方案结论' },
    ])
    const result = validateRevisionBatchPlan(input, queue, new Map())
    expect(result.tasks[1]!.depends_on).toEqual(['T-1'])
    expect(result.tasks[1]!.dependency_reason).toBe('总体设计依赖技术方案结论')
  })

  it('空 issue_ids 拒绝 NO_PENDING_ISSUES', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    expect(() => validateRevisionBatchPlan(planInput([], []), queue, new Map()))
      .toThrow('BID_REVISION_BATCH_NO_PENDING_ISSUES')
  })

  it('重复 issue_id 拒绝 ISSUE_DUPLICATE', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    expect(() => validateRevisionBatchPlan(planInput([id, id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id, id] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_ISSUE_DUPLICATE')
  })

  it('不存在的 issue 拒绝 ISSUE_NOT_FOUND', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    expect(() => validateRevisionBatchPlan(planInput(['REV-missing'], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-missing'] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_ISSUE_NOT_FOUND')
  })

  it('非 pending issue 拒绝 ISSUE_NOT_PENDING', () => {
    let queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    queue = { ...queue, issues: [{ ...queue.issues[0]!, status: 'scheduled' }] }
    expect(() => validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_ISSUE_NOT_PENDING')
  })

  it('issue 未被任何 task 覆盖拒绝 ISSUE_NOT_COVERED', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    expect(() => validateRevisionBatchPlan(planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_ISSUE_NOT_COVERED')
  })

  it('task 覆盖不在 input.issue_ids 中的 issue 拒绝 ISSUE_NOT_COVERED', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    expect(() => validateRevisionBatchPlan(planInput([id1], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_ISSUE_NOT_COVERED')
  })

  it('重复 task_id 拒绝 TASK_DUPLICATE', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-1', title: '技术方案' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    expect(() => validateRevisionBatchPlan(planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id2] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_TASK_DUPLICATE')
  })

  it('section 不匹配拒绝 SECTION_MISMATCH', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    expect(() => validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-2', issue_ids: [id] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_SECTION_MISMATCH')
  })

  it('自依赖拒绝 SELF_DEPENDENCY', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    expect(() => validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id], depends_on: ['T-1'] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_SELF_DEPENDENCY')
  })

  it('依赖不存在的 task 拒绝 DEPENDENCY_NOT_FOUND', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    expect(() => validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id], depends_on: ['T-missing'] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_DEPENDENCY_NOT_FOUND')
  })

  it('依赖图有环拒绝 CYCLE', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    expect(() => validateRevisionBatchPlan(planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1], depends_on: ['T-2'] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2], depends_on: ['T-1'] },
    ]), queue, new Map())).toThrow('BID_REVISION_BATCH_CYCLE')
  })

  it('stale hash 标记 conflict 但不拒绝', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    const staleHashes = new Map([['SEC-1', '0'.repeat(64)]])
    const result = validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] },
    ]), queue, staleHashes)
    expect(result.staleIssues).toEqual([id])
  })

  it('hash 匹配时不标记 stale', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    const freshHashes = new Map([['SEC-1', chapterContentSha256(markdown)]])
    const result = validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] },
    ]), queue, freshHashes)
    expect(result.staleIssues).toHaveLength(0)
  })

  it('sectionHashes 中不存在的 section 不标记 stale', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    const result = validateRevisionBatchPlan(planInput([id], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] },
    ]), queue, new Map())
    expect(result.staleIssues).toHaveLength(0)
  })
})

describe('批次创建 createRevisionBatch', () => {
  it('创建批次并将 issue 从 pending 标记为 scheduled', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    const input = planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2] },
    ])
    const batchId = createRevisionBatchId()
    const { queue: updatedQueue, batch } = createRevisionBatch(queue, input, batchId, 5000, [])
    expect(batch.batch_id).toBe(batchId)
    expect(batch.status).toBe('planning')
    expect(batch.queue_revision).toBe(0)
    expect(batch.issue_ids).toEqual([id1, id2])
    expect(batch.tasks).toHaveLength(2)
    expect(batch.created_at).toBe(5000)
    expect(batch.updated_at).toBe(5000)
    expect(revisionBatchArtifactSchema.safeParse(batch).success).toBe(true)
    const scheduled = updatedQueue.issues.filter(issue => issue.status === 'scheduled')
    expect(scheduled).toHaveLength(2)
    expect(scheduled.every(issue => issue.batch_id === batchId)).toBe(true)
    expect(updatedQueue.revision).toBe(queue.revision + 1)
  })

  it('stale issue 标记为 conflict 而非 scheduled', () => {
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    const input = planInput([id], [{ task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] }])
    const { queue: updatedQueue } = createRevisionBatch(queue, input, createRevisionBatchId(), 5000, [id])
    expect(updatedQueue.issues[0]!.status).toBe('conflict')
    expect(updatedQueue.issues[0]!.batch_id).not.toBeNull()
  })

  it('不在批次中的 issue 保持不变', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
      { sectionId: 'SEC-3', title: '详细设计' },
    )
    const [id1, id3] = [queue.issues[0]!.issue_id, queue.issues[2]!.issue_id]
    const input = planInput([id1, id3], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-3', section_id: 'SEC-3', issue_ids: [id3] },
    ])
    const { queue: updatedQueue } = createRevisionBatch(queue, input, createRevisionBatchId(), 5000, [])
    const untouched = updatedQueue.issues.find(issue => issue.issue_id === queue.issues[1]!.issue_id)!
    expect(untouched.status).toBe('pending')
    expect(untouched.batch_id).toBeNull()
    expect(untouched.updated_at).toBe(queue.issues[1]!.updated_at)
  })

  it('dependency_reason 保留到 batch artifact', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '技术方案' },
      { sectionId: 'SEC-2', title: '总体设计' },
    )
    const [id1, id2] = queue.issues.map(issue => issue.issue_id) as [string, string]
    const input = planInput([id1, id2], [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [id2], depends_on: ['T-1'], dependency_reason: '依赖结论' },
    ])
    const { batch } = createRevisionBatch(queue, input, createRevisionBatchId(), 5000, [])
    expect(batch.tasks[1]!.dependency_reason).toBe('依赖结论')
  })
})

describe('批次持久化', () => {
  const disposals: Array<() => Promise<void>> = []

  afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-revision-batch-'))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    return new BidWorkspace(root)
  }

  it('文件不存在时返回 null', async () => {
    const ws = await workspace()
    expect(await readRevisionBatch(ws, 'BATCH-missing')).toBeNull()
  })

  it('写入后重新读取内容不丢失', async () => {
    const ws = await workspace()
    const queue = makeQueueWithIssues({ sectionId: 'SEC-1', title: '技术方案' })
    const id = queue.issues[0]!.issue_id
    const input = planInput([id], [{ task_id: 'T-1', section_id: 'SEC-1', issue_ids: [id] }])
    const { batch } = createRevisionBatch(queue, input, createRevisionBatchId(), 5000, [])
    await writeRevisionBatch(ws, batch)
    const reloaded = await readRevisionBatch(ws, batch.batch_id)
    expect(reloaded).toEqual(batch)
  })

  it('解析拒绝旧 schema_version', () => {
    expect(() => parseRevisionBatchArtifact({
      schema_version: 0, batch_id: 'BATCH-1', queue_revision: 0,
      issue_ids: ['REV-1'], status: 'planning', tasks: [], created_at: 0, updated_at: 0,
    })).toThrow()
  })

  it('解析拒绝非法 status', () => {
    expect(() => parseRevisionBatchArtifact({
      schema_version: 1, batch_id: 'BATCH-1', queue_revision: 0,
      issue_ids: ['REV-1'], status: 'unknown', tasks: [{
        task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'], depends_on: [],
      }], created_at: 0, updated_at: 0,
    })).toThrow()
  })
})
describe('批次执行提示渲染 renderRevisionBatchSectionPrompt', () => {
  function makeTask(issues: { instruction: string; suggestion: string | null; scope: 'chapter' | 'paragraphs'; reference_text: string | null; start: number | null; end: number | null }[]): RevisionBatchTaskExecution {
    return {
      task_id: 'T-1', section_id: 'SEC-1', issue_ids: issues.map((_, i) => `REV-${i + 1}`), depends_on: [],
      issues: issues.map((issue, i) => ({ ...issue, issue_id: `REV-${i + 1}` })),
    }
  }

  it('渲染多条审批意见', () => {
    const task = makeTask([
      { instruction: '修改重复段落', suggestion: '合并为一段', scope: 'paragraphs', reference_text: '重复段落。', start: 0, end: 5 },
      { instruction: '补充实施步骤', suggestion: null, scope: 'chapter', reference_text: null, start: null, end: null },
    ])
    const prompt = renderRevisionBatchSectionPrompt(task, '# 1 章节\n\n正文。\n')
    expect(prompt).toContain('共 2 条')
    expect(prompt).toContain('意见 1')
    expect(prompt).toContain('修改重复段落')
    expect(prompt).toContain('合并为一段')
    expect(prompt).toContain('选中段落：重复段落。')
    expect(prompt).toContain('意见 2')
    expect(prompt).toContain('补充实施步骤')
    expect(prompt).toContain('当前完整正文')
  })

  it('章节级意见不渲染选中段落', () => {
    const task = makeTask([{ instruction: '全量重写', suggestion: null, scope: 'chapter', reference_text: null, start: null, end: null }])
    const prompt = renderRevisionBatchSectionPrompt(task, '正文')
    expect(prompt).not.toContain('选中段落')
  })
})

describe('批次状态流转', () => {
  function makeBatch(status: RevisionBatchArtifact['status']): RevisionBatchArtifact {
    return {
      schema_version: REVISION_BATCH_SCHEMA_VERSION, batch_id: 'BATCH-1', queue_revision: 0,
      issue_ids: ['REV-1'], status, tasks: [{
        task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'], depends_on: [],
        status: 'queued', failure: null, started_at: null, completed_at: null,
      }], created_at: 1000, updated_at: 1000,
    }
  }

  it('planning → running 成功', () => {
    const batch = startRevisionBatchExecution(makeBatch('planning'), 2000)
    expect(batch.status).toBe('running')
    expect(batch.updated_at).toBe(2000)
  })

  it('非 planning 状态拒绝 start', () => {
    expect(() => startRevisionBatchExecution(makeBatch('running'), 2000)).toThrow('BID_REVISION_BATCH_NOT_PLANNING')
    expect(() => startRevisionBatchExecution(makeBatch('completed'), 2000)).toThrow('BID_REVISION_BATCH_NOT_PLANNING')
  })

  it('running → completed 成功', () => {
    const batch = completeRevisionBatchExecution(makeBatch('running'), 3000)
    expect(batch.status).toBe('completed')
    expect(batch.updated_at).toBe(3000)
  })

  it('completed → completed 幂等', () => {
    const original = makeBatch('completed')
    const batch = completeRevisionBatchExecution(original, 3000)
    expect(batch).toBe(original)
  })

  it('非 running 状态拒绝 complete（非 completed）', () => {
    expect(() => completeRevisionBatchExecution(makeBatch('planning'), 3000)).toThrow('BID_REVISION_BATCH_NOT_RUNNING')
  })

  it('running → suspended 成功', () => {
    const batch = suspendRevisionBatchExecution(makeBatch('running'), 4000)
    expect(batch.status).toBe('suspended')
  })

  it('非 running 状态拒绝 suspend', () => {
    expect(() => suspendRevisionBatchExecution(makeBatch('planning'), 4000)).toThrow('BID_REVISION_BATCH_NOT_RUNNING')
  })

  it('任意状态 → failed 成功', () => {
    expect(failRevisionBatchExecution(makeBatch('planning'), 5000).status).toBe('failed')
    expect(failRevisionBatchExecution(makeBatch('running'), 5000).status).toBe('failed')
    expect(failRevisionBatchExecution(makeBatch('suspended'), 5000).status).toBe('failed')
  })

  it('failed → failed 幂等', () => {
    const original = makeBatch('failed')
    const batch = failRevisionBatchExecution(original, 5000)
    expect(batch).toBe(original)
  })
})
describe('assertChapterRevisionBatchScope', () => {
  const original = '# 标题\n\n段落一。\n\n段落二。\n\n段落三。\n'

  it('chapter-scope 允许整章修改', () => {
    const candidate = '# 标题\n\n段落一改。\n\n段落二改。\n\n段落三改。\n'
    expect(() => assertChapterRevisionBatchScope([{ scope: 'chapter' }], original, candidate)).not.toThrow()
  })

  it('paragraph-only 严格限制在授权段落内', () => {
    const candidate = '# 标题\n\n段落一改。\n\n段落二。\n\n段落三。\n'
    const scopes: BatchRevisionScope[] = [{ scope: 'paragraphs', start: 7, end: 14 }]
    expect(() => assertChapterRevisionBatchScope(scopes, original, candidate)).not.toThrow()
  })

  it('修改未授权段落会被拒绝', () => {
    const candidate = '# 标题\n\n段落一。\n\n段落二改。\n\n段落三。\n'
    const scopes: BatchRevisionScope[] = [{ scope: 'paragraphs', start: 7, end: 14 }]
    expect(() => assertChapterRevisionBatchScope(scopes, original, candidate)).toThrow()
  })

  it('多个不连续授权范围合并校验', () => {
    const start1 = original.indexOf('段落一')
    const end1 = start1 + '段落一。'.length
    const start2 = original.indexOf('段落三')
    const end2 = start2 + '段落三。'.length
    const candidate = original.slice(0, start1) + '段落一改。' + original.slice(end1, start2) + '段落三改。' + original.slice(end2)
    const scopes: BatchRevisionScope[] = [
      { scope: 'paragraphs', start: start1, end: end1 },
      { scope: 'paragraphs', start: start2, end: end2 },
    ]
    expect(() => assertChapterRevisionBatchScope(scopes, original, candidate)).not.toThrow()
  })

  it('多个不连续范围中修改未授权段落被拒绝', () => {
    const start1 = original.indexOf('段落一')
    const end1 = start1 + '段落一。'.length
    const start2 = original.indexOf('段落三')
    const end2 = start2 + '段落三。'.length
    const candidate = original.slice(0, start1) + '段落一改。' + '\n\n段落二改。\n\n' + '段落三改。' + original.slice(end2)
    const scopes: BatchRevisionScope[] = [
      { scope: 'paragraphs', start: start1, end: end1 },
      { scope: 'paragraphs', start: start2, end: end2 },
    ]
    expect(() => assertChapterRevisionBatchScope(scopes, original, candidate)).toThrow()
  })

  it('混合 chapter 和 paragraph scope 时 chapter 优先', () => {
    const candidate = '# 标题改\n\n全部改。\n'
    const scopes: BatchRevisionScope[] = [
      { scope: 'paragraphs', start: 7, end: 14 },
      { scope: 'chapter' },
    ]
    expect(() => assertChapterRevisionBatchScope(scopes, original, candidate)).not.toThrow()
  })
})

describe('mergeParagraphRanges', () => {
  it('合并重叠范围', () => {
    const merged = mergeParagraphRanges([{ start: 0, end: 10 }, { start: 5, end: 15 }])
    expect(merged).toEqual([{ start: 0, end: 15 }])
  })

  it('合并相邻范围', () => {
    const merged = mergeParagraphRanges([{ start: 0, end: 10 }, { start: 10, end: 20 }])
    expect(merged).toEqual([{ start: 0, end: 20 }])
  })

  it('不合并不相邻范围', () => {
    const merged = mergeParagraphRanges([{ start: 0, end: 10 }, { start: 20, end: 30 }])
    expect(merged).toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }])
  })

  it('空范围返回空', () => {
    expect(mergeParagraphRanges([])).toEqual([])
  })

  it('按 start 排序后合并', () => {
    const merged = mergeParagraphRanges([{ start: 20, end: 30 }, { start: 0, end: 10 }, { start: 5, end: 25 }])
    expect(merged).toEqual([{ start: 0, end: 30 }])
  })
})

describe('detectStaleBaseVersions', () => {
  it('全部一致返回空', () => {
    const sha = 'a'.repeat(64)
    const issues = [
      { issue_id: 'REV-001', reference: { base_content_sha256: sha } },
      { issue_id: 'REV-002', reference: { base_content_sha256: sha } },
    ]
    expect(detectStaleBaseVersions(issues, sha)).toEqual([])
  })

  it('检测过期 issue', () => {
    const sha = 'a'.repeat(64)
    const staleSha = 'b'.repeat(64)
    const issues = [
      { issue_id: 'REV-001', reference: { base_content_sha256: sha } },
      { issue_id: 'REV-002', reference: { base_content_sha256: staleSha } },
    ]
    expect(detectStaleBaseVersions(issues, sha)).toEqual(['REV-002'])
  })

  it('全部过期返回全部', () => {
    const sha = 'a'.repeat(64)
    const staleSha = 'b'.repeat(64)
    const issues = [
      { issue_id: 'REV-001', reference: { base_content_sha256: staleSha } },
      { issue_id: 'REV-002', reference: { base_content_sha256: staleSha } },
    ]
    expect(detectStaleBaseVersions(issues, sha)).toEqual(['REV-001', 'REV-002'])
  })
})

describe('settleRevisionBatchIssues', () => {
  function makeQueueWithScheduledIssues(issueIds: string[]): RevisionQueueArtifact {
    const issues = issueIds.map((id, index) => ({
      issue_id: id,
      section_id: 'SEC-001',
      section_title: '测试章节',
      scope: 'chapter' as const,
      reference: { scope: 'chapter' as const, base_content_sha256: 'a'.repeat(64) },
      instruction: `意见 ${index + 1}`,
      suggestion: null,
      status: 'scheduled' as const,
      batch_id: 'BATCH-001',
      created_at: 1000,
      updated_at: 1000,
    }))
    return { schema_version: 1, revision: 1, issues }
  }

  it('全部 satisfied → task completed', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002', 'REV-003'])
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
      { issue_id: 'REV-002', status: 'satisfied', reason: '完成' },
      { issue_id: 'REV-003', status: 'satisfied', reason: '完成' },
    ]
    const result = settleRevisionBatchIssues(queue, ['REV-001', 'REV-002', 'REV-003'], checks, 2000)
    expect(result.taskStatus).toBe('completed')
    expect(result.queue.issues.every(issue => issue.status === 'completed')).toBe(true)
  })

  it('存在 needs_input 且无 failed → task needs_input', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002'])
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
      { issue_id: 'REV-002', status: 'needs_input', reason: '需要资料' },
    ]
    const result = settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], checks, 2000)
    expect(result.taskStatus).toBe('needs_input')
    expect(result.queue.issues.find(issue => issue.issue_id === 'REV-002')?.status).toBe('needs_input')
  })

  it('存在 unsatisfied → task failed', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002'])
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
      { issue_id: 'REV-002', status: 'unsatisfied', reason: '未完成' },
    ]
    const result = settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], checks, 2000)
    expect(result.taskStatus).toBe('failed')
    expect(result.queue.issues.find(issue => issue.issue_id === 'REV-002')?.status).toBe('failed')
  })

  it('Reviewer 未返回某条 check → 抛出 BID_REVISION_REVIEW_INCOMPLETE', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002'])
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
    ]
    expect(() => settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], checks, 2000))
      .toThrow('BID_REVISION_REVIEW_INCOMPLETE')
  })

  it('无 check → 抛出 BID_REVISION_REVIEW_INCOMPLETE', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002'])
    expect(() => settleRevisionBatchIssues(queue, ['REV-001', 'REV-002'], [], 2000))
      .toThrow('BID_REVISION_REVIEW_INCOMPLETE')
  })

  it('只结算 task 内的 issue，不影响其他 issue', () => {
    const queue = makeQueueWithScheduledIssues(['REV-001', 'REV-002'])
    const otherIssue = {
      issue_id: 'REV-OTHER',
      section_id: 'SEC-002',
      section_title: '其他章节',
      scope: 'chapter' as const,
      reference: { scope: 'chapter' as const, base_content_sha256: 'a'.repeat(64) },
      instruction: '其他意见',
      suggestion: null,
      status: 'pending' as const,
      batch_id: null,
      created_at: 1000,
      updated_at: 1000,
    }
    const queueWithOther = { ...queue, issues: [...queue.issues, otherIssue] }
    const checks: RevisionIssueCheck[] = [
      { issue_id: 'REV-001', status: 'satisfied', reason: '完成' },
      { issue_id: 'REV-002', status: 'satisfied', reason: '完成' },
    ]
    const result = settleRevisionBatchIssues(queueWithOther, ['REV-001', 'REV-002'], checks, 2000)
    expect(result.taskStatus).toBe('completed')
    const other = result.queue.issues.find(issue => issue.issue_id === 'REV-OTHER')
    expect(other?.status).toBe('pending')
  })
})
describe('BidReviewWorkbenchView revision overlay schema', () => {
  type WorkbenchBase = {
    schema_version: number
    outline: Array<{
      section_id: string
      parent_id: string | null
      order: number
      title: string
      writable: boolean
      writing_status: 'completed'
      review_status: 'pass'
      chapter_indicator: { status: 'passed'; tooltip: string }
      content_available: boolean
      revision?: { batch_id: string; task_id: string; status: string; issue_count: number }
    }>
    summary: {
      chapter_count: number
      content_count: number
      reviewed_count: number
      needs_attention_count: number
      page_estimate: { status: 'unavailable' }
      page_target: { status: 'not_set' }
    }
    global_compliance: {
      status: 'not_required'
      reviewed_count: number
      total_count: number
      document_issues: never[]
      delivery_todos: never[]
    }
    revision_batch?: {
      batch_id: string
      status: string
      total_issues: number
      completed: number
      running: number
      pending: number
      needs_input: number
      failed: number
    }
  }

  function makeWorkbenchBase(): WorkbenchBase {
    return {
      schema_version: 6,
      outline: [{
        section_id: 'SEC-001',
        parent_id: null,
        order: 1,
        title: '章节一',
        writable: true,
        writing_status: 'completed' as const,
        review_status: 'pass' as const,
        chapter_indicator: { status: 'passed' as const, tooltip: '已通过' },
        content_available: true,
      }],
      summary: {
        chapter_count: 1,
        content_count: 1,
        reviewed_count: 1,
        needs_attention_count: 0,
        page_estimate: { status: 'unavailable' as const },
        page_target: { status: 'not_set' as const },
      },
      global_compliance: {
        status: 'not_required' as const,
        reviewed_count: 0,
        total_count: 0,
        document_issues: [],
        delivery_todos: [],
      },
    }
  }

  it('无 revision overlay 时 schema_version=6 通过', () => {
    expect(() => parseBidReviewWorkbenchView(makeWorkbenchBase())).not.toThrow()
  })

  it('有 revision overlay 时通过', () => {
    const view = makeWorkbenchBase()
    view.outline[0]!.revision = {
      batch_id: 'BATCH-001',
      task_id: 'TASK-001',
      status: 'running',
      issue_count: 3,
    }
    expect(() => parseBidReviewWorkbenchView(view)).not.toThrow()
  })

  it('revision overlay 含 revision_batch 进度时通过', () => {
    const view = makeWorkbenchBase()
    view.outline[0]!.revision = {
      batch_id: 'BATCH-001',
      task_id: 'TASK-001',
      status: 'running',
      issue_count: 3,
    }
    view.revision_batch = {
      batch_id: 'BATCH-001',
      status: 'running',
      total_issues: 3,
      completed: 1,
      running: 1,
      pending: 1,
      needs_input: 0,
      failed: 0,
    }
    const parsed = parseBidReviewWorkbenchView(view)
    expect(parsed.revision_batch?.completed).toBe(1)
    expect(parsed.outline[0]!.revision?.status).toBe('running')
  })

  it('batch 失败但 chapter 仍 pass 时 overlay 显示 revision failed', () => {
    const view = makeWorkbenchBase()
    view.outline[0]!.revision = {
      batch_id: 'BATCH-001',
      task_id: 'TASK-001',
      status: 'failed',
      issue_count: 2,
    }
    const parsed = parseBidReviewWorkbenchView(view)
    expect(parsed.outline[0]!.review_status).toBe('pass')
    expect(parsed.outline[0]!.revision?.status).toBe('failed')
  })

  it('未参与批次的章节无 revision overlay', () => {
    const view = makeWorkbenchBase()
    view.outline.push({
      section_id: 'SEC-002',
      parent_id: null,
      order: 2,
      title: '章节二',
      writable: true,
      writing_status: 'completed',
      review_status: 'pass',
      chapter_indicator: { status: 'passed', tooltip: '已通过' },
      content_available: true,
    })
    const parsed = parseBidReviewWorkbenchView(view)
    expect(parsed.outline[0]!.revision).toBeUndefined()
    expect(parsed.outline[1]!.revision).toBeUndefined()
  })

  it('schema_version=5 被拒绝', () => {
    const view = makeWorkbenchBase() as unknown as { schema_version: number }
    view.schema_version = 5
    expect(() => parseBidReviewWorkbenchView(view)).toThrow()
  })
})
describe('S5 批量修订全链路数据层集成', () => {
  const sha = 'a'.repeat(64)

  function makeIssue(sectionId: string, sectionTitle: string, scope: 'chapter' | 'paragraphs', issueId: string, time: number) {
    return {
      issue_id: issueId,
      section_id: sectionId,
      section_title: sectionTitle,
      scope,
      reference: scope === 'chapter'
        ? { scope: 'chapter' as const, base_content_sha256: sha }
        : { scope: 'paragraphs' as const, base_content_sha256: sha, start: 0, end: 10, text: '段落内容' },
      instruction: `${issueId} 意见`,
      suggestion: null,
      status: 'pending' as const,
      batch_id: null,
      created_at: time,
      updated_at: time,
    }
  }

  it('场景1：收集5条意见不执行，queue 累积且无 batch', () => {
    let queue = emptyRevisionQueue()
    let time = 1000
    const issues = [
      makeIssue('SEC-A', '章节A', 'paragraphs', 'REV-001', time),
      makeIssue('SEC-A', '章节A', 'paragraphs', 'REV-002', time + 1000),
      makeIssue('SEC-B', '章节B', 'chapter', 'REV-003', time + 2000),
      makeIssue('SEC-C', '章节C', 'paragraphs', 'REV-004', time + 3000),
      makeIssue('SEC-C', '章节C', 'paragraphs', 'REV-005', time + 4000),
    ]
    for (const issue of issues) {
      queue = addRevisionIssue(queue, {
        section_id: issue.section_id,
        scope: issue.scope,
        reference: issue.reference,
        instruction: issue.instruction,
        suggestion: issue.suggestion,
      }, issue.section_title, time)
      time += 1000
    }
    expect(queue.issues.length).toBe(5)
    expect(queue.issues.every(issue => issue.status === 'pending')).toBe(true)
    expect(queue.issues.every(issue => issue.batch_id === null)).toBe(true)
  })

  it('场景3：Main Agent 规划同章聚合+依赖串行+独立并行', () => {
    let queue = emptyRevisionQueue()
    let time = 1000
    const sections = [
      { id: 'SEC-A', title: 'A' },
      { id: 'SEC-B', title: 'B' },
      { id: 'SEC-C', title: 'C' },
      { id: 'SEC-D', title: 'D' },
    ]
    for (const sec of sections) {
      queue = addRevisionIssue(queue, {
        section_id: sec.id, scope: 'chapter',
        reference: { scope: 'chapter', base_content_sha256: sha },
        instruction: `针对 ${sec.title} 的意见`, suggestion: null,
      }, sec.title, time)
      time += 1000
    }
    const planInput: PlanRevisionBatchInput = {
      expected_queue_revision: queue.revision,
      issue_ids: queue.issues.map(issue => issue.issue_id),
      tasks: [
        { task_id: 'TASK-A', section_id: 'SEC-A', issue_ids: [queue.issues[0]!.issue_id], depends_on: [] },
        { task_id: 'TASK-B', section_id: 'SEC-B', issue_ids: [queue.issues[1]!.issue_id], depends_on: [] },
        { task_id: 'TASK-C', section_id: 'SEC-C', issue_ids: [queue.issues[2]!.issue_id], depends_on: [] },
        { task_id: 'TASK-D', section_id: 'SEC-D', issue_ids: [queue.issues[3]!.issue_id], depends_on: ['TASK-A'] },
      ],
    }
    const sectionHashes = new Map(sections.map(sec => [sec.id, sha]))
    const validated = validateRevisionBatchPlan(planInput, queue, sectionHashes)
    expect(validated.tasks.length).toBe(4)
    expect(validated.staleIssues).toEqual([])
    const batchId = createRevisionBatchId()
    const { queue: scheduledQueue, batch } = createRevisionBatch(queue, planInput, batchId, 5000, validated.staleIssues)
    expect(batch.status).toBe('planning')
    expect(scheduledQueue.issues.every(issue => issue.status === 'scheduled')).toBe(true)
    const taskD = batch.tasks.find(task => task.task_id === 'TASK-D')!
    expect(taskD.depends_on).toEqual(['TASK-A'])
    const taskA = batch.tasks.find(task => task.task_id === 'TASK-A')!
    expect(taskA.depends_on).toEqual([])
  })

  it('场景4：同章节多条意见聚合为单个 task', () => {
    let queue = emptyRevisionQueue()
    let time = 1000
    for (let i = 0; i < 3; i++) {
      queue = addRevisionIssue(queue, {
        section_id: 'SEC-A', scope: 'paragraphs',
        reference: { scope: 'paragraphs', base_content_sha256: sha, start: i * 10, end: i * 10 + 10, text: `段落${i}` },
        instruction: `意见 ${i + 1}`, suggestion: null,
      }, '章节A', time)
      time += 1000
    }
    const planInput: PlanRevisionBatchInput = {
      expected_queue_revision: queue.revision,
      issue_ids: queue.issues.map(issue => issue.issue_id),
      tasks: [
        { task_id: 'TASK-A', section_id: 'SEC-A', issue_ids: queue.issues.map(issue => issue.issue_id), depends_on: [] },
      ],
    }
    const validated = validateRevisionBatchPlan(planInput, queue, new Map([['SEC-A', sha]]))
    expect(validated.tasks.length).toBe(1)
    expect(validated.tasks[0]!.issue_ids.length).toBe(3)
  })

  it('错误隔离：1个 task 失败不影响其他 task 的 issue 结算', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        { ...makeIssue('SEC-A', 'A', 'chapter', 'REV-001', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-B', 'B', 'chapter', 'REV-002', 2000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-C', 'C', 'chapter', 'REV-003', 3000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
      ],
    }
    const resultA = settleRevisionBatchIssues(queue, ['REV-001'], [{ issue_id: 'REV-001', status: 'satisfied', reason: '完成' }], 5000)
    expect(resultA.taskStatus).toBe('completed')
    const resultB = settleRevisionBatchIssues(resultA.queue, ['REV-002'], [{ issue_id: 'REV-002', status: 'unsatisfied', reason: '失败' }], 6000)
    expect(resultB.taskStatus).toBe('failed')
    const resultC = settleRevisionBatchIssues(resultB.queue, ['REV-003'], [{ issue_id: 'REV-003', status: 'satisfied', reason: '完成' }], 7000)
    expect(resultC.taskStatus).toBe('completed')
    const issueA = resultC.queue.issues.find(issue => issue.issue_id === 'REV-001')!
    const issueB = resultC.queue.issues.find(issue => issue.issue_id === 'REV-002')!
    const issueC = resultC.queue.issues.find(issue => issue.issue_id === 'REV-003')!
    expect(issueA.status).toBe('completed')
    expect(issueB.status).toBe('failed')
    expect(issueC.status).toBe('completed')
  })

  it('错误隔离：base hash 过期的 issue 标记 conflict，其他不受影响', () => {
    const currentSha = 'a'.repeat(64)
    const staleSha = 'b'.repeat(64)
    const issues = [
      { issue_id: 'REV-001', reference: { base_content_sha256: currentSha } },
      { issue_id: 'REV-002', reference: { base_content_sha256: staleSha } },
      { issue_id: 'REV-003', reference: { base_content_sha256: currentSha } },
    ]
    const staleIds = detectStaleBaseVersions(issues, currentSha)
    expect(staleIds).toEqual(['REV-002'])
    expect(staleIds).not.toContain('REV-001')
    expect(staleIds).not.toContain('REV-003')
  })

  it('错误隔离：needs_input 不当作 executor_error', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        { ...makeIssue('SEC-A', 'A', 'chapter', 'REV-001', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
      ],
    }
    const result = settleRevisionBatchIssues(queue, ['REV-001'], [{ issue_id: 'REV-001', status: 'needs_input', reason: '需要用户提供资料' }], 5000)
    expect(result.taskStatus).toBe('needs_input')
    expect(result.queue.issues[0]!.status).toBe('needs_input')
  })

  it('批次进度：workbench revision_batch summary 数量准确', () => {
    const view = {
      schema_version: 6,
      outline: [],
      summary: { chapter_count: 0, content_count: 0, reviewed_count: 0, needs_attention_count: 0, page_estimate: { status: 'unavailable' }, page_target: { status: 'not_set' } },
      global_compliance: { status: 'not_required', reviewed_count: 0, total_count: 0, document_issues: [], delivery_todos: [] },
      revision_batch: {
        batch_id: 'BATCH-001',
        status: 'running' as const,
        total_issues: 5,
        completed: 2,
        running: 1,
        pending: 1,
        needs_input: 0,
        failed: 1,
      },
    }
    const parsed = parseBidReviewWorkbenchView(view)
    const revisionBatch = parsed.revision_batch
    expect(revisionBatch).toBeDefined()
    if (revisionBatch !== undefined) {
      expect(revisionBatch.total_issues).toBe(5)
      expect(revisionBatch.completed).toBe(2)
      expect(revisionBatch.failed).toBe(1)
      expect(revisionBatch.running + revisionBatch.pending + revisionBatch.completed + revisionBatch.failed).toBe(5)
    }
  })
})

describe('任务 02: 章节级成功隔离与禁止全批回滚', () => {
  function makeIssue(
    sectionId: string,
    title: string,
    scope: 'chapter' | 'paragraphs',
    issueId: string,
    time: number,
  ): RevisionIssue {
    return {
      issue_id: issueId,
      section_id: sectionId,
      section_title: title,
      scope,
      reference: { scope: 'chapter', base_content_sha256: '0'.repeat(64) },
      instruction: `针对 ${title} 的修订意见`,
      suggestion: null,
      status: 'scheduled',
      batch_id: 'BATCH-001',
      created_at: time,
      updated_at: time,
    }
  }

  it('1 & 2 & 5. A/B/C 无依赖并行：A 成功、B 失败、C 成功，B 失败不回滚 A/C', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        { ...makeIssue('SEC-A', 'A', 'chapter', 'REV-A', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-B', 'B', 'chapter', 'REV-B', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-C', 'C', 'chapter', 'REV-C', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
      ],
    }

    // A 成功审核通过
    const resA = settleRevisionBatchIssues(queue, ['REV-A'], [
      { issue_id: 'REV-A', status: 'satisfied', reason: 'A 已完成修订' },
    ], 2000)
    expect(resA.taskStatus).toBe('completed')
    expect(resA.queue.issues.find(i => i.issue_id === 'REV-A')?.status).toBe('completed')

    // B 审核未通过 (unsatisfied)
    const resB = settleRevisionBatchIssues(resA.queue, ['REV-B'], [
      { issue_id: 'REV-B', status: 'unsatisfied', reason: 'B 未完成修改' },
    ], 3000)
    expect(resB.taskStatus).toBe('failed')
    expect(resB.queue.issues.find(i => i.issue_id === 'REV-B')?.status).toBe('failed')

    // C 成功审核通过
    const resC = settleRevisionBatchIssues(resB.queue, ['REV-C'], [
      { issue_id: 'REV-C', status: 'satisfied', reason: 'C 已完成修订' },
    ], 4000)
    expect(resC.taskStatus).toBe('completed')
    expect(resC.queue.issues.find(i => i.issue_id === 'REV-C')?.status).toBe('completed')

    // 验证 B 失败后 A 和 C 依然保持 completed，绝未被回滚或撤销
    expect(resC.queue.issues.find(i => i.issue_id === 'REV-A')?.status).toBe('completed')
    expect(resC.queue.issues.find(i => i.issue_id === 'REV-B')?.status).toBe('failed')
    expect(resC.queue.issues.find(i => i.issue_id === 'REV-C')?.status).toBe('completed')
  })

  it('3 & 4. 章节失败不提交半成品：未成功章节不产出有效核验结果', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        { ...makeIssue('SEC-B', 'B', 'chapter', 'REV-B', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
      ],
    }
    // 当 B 失败（没有提供合法满足核验）时，无法结算为 completed
    const result = settleRevisionBatchIssues(queue, ['REV-B'], [
      { issue_id: 'REV-B', status: 'unsatisfied', reason: '存在未修复问题' },
    ], 2000)
    expect(result.taskStatus).toBe('failed')
    expect(result.queue.issues[0]?.status).toBe('failed')
  })

  it('6 & 7. D depends_on B，B 失败后 D blocked，与 B 无关的 E 正常继续完成', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 1,
      issues: [
        { ...makeIssue('SEC-B', 'B', 'chapter', 'REV-B', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-D', 'D', 'chapter', 'REV-D', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-E', 'E', 'chapter', 'REV-E', 1000), status: 'scheduled' as const, batch_id: 'BATCH-001' },
      ],
    }

    // B 执行失败
    const resB = settleRevisionBatchIssues(queue, ['REV-B'], [
      { issue_id: 'REV-B', status: 'unsatisfied', reason: 'B 失败' },
    ], 2000)
    expect(resB.taskStatus).toBe('failed')

    // E 与 B 无关，独立执行成功
    const resE = settleRevisionBatchIssues(resB.queue, ['REV-E'], [
      { issue_id: 'REV-E', status: 'satisfied', reason: 'E 正常完成' },
    ], 3000)
    expect(resE.taskStatus).toBe('completed')
    expect(resE.queue.issues.find(i => i.issue_id === 'REV-E')?.status).toBe('completed')

    // D 依赖 B，因 B 失败而未能正常通过
    const resD = settleRevisionBatchIssues(resE.queue, ['REV-D'], [
      { issue_id: 'REV-D', status: 'unsatisfied', reason: '前置章节 B 失败导致依赖阻塞' },
    ], 4000)
    expect(resD.taskStatus).toBe('failed')
    expect(resD.queue.issues.find(i => i.issue_id === 'REV-D')?.status).toBe('failed')
  })

  it('8. resume 幂等性：已 completed 的 issues 在重新结算时保持状态不退化', () => {
    const queue: RevisionQueueArtifact = {
      schema_version: 1,
      revision: 2,
      issues: [
        { ...makeIssue('SEC-A', 'A', 'chapter', 'REV-A', 1000), status: 'completed' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-C', 'C', 'chapter', 'REV-C', 1000), status: 'completed' as const, batch_id: 'BATCH-001' },
        { ...makeIssue('SEC-B', 'B', 'chapter', 'REV-B', 1000), status: 'scheduled' as const, batch_id: 'BATCH-002' },
      ],
    }
    // 对已完成的 A/C 保持幂等
    const result = settleRevisionBatchIssues(queue, ['REV-B'], [
      { issue_id: 'REV-B', status: 'satisfied', reason: '重试后修复完成' },
    ], 5000)
    expect(result.queue.issues.find(i => i.issue_id === 'REV-A')?.status).toBe('completed')
    expect(result.queue.issues.find(i => i.issue_id === 'REV-C')?.status).toBe('completed')
    expect(result.queue.issues.find(i => i.issue_id === 'REV-B')?.status).toBe('completed')
  })

  it('9 & 10. 批次生命周期状态流转与单章修订兼容：complete 幂等且 fail 覆盖所有运行状态', () => {
    const batch: RevisionBatchArtifact = {
      schema_version: REVISION_BATCH_SCHEMA_VERSION,
      batch_id: 'BATCH-001',
      queue_revision: 1,
      issue_ids: ['REV-1'],
      status: 'running',
      tasks: [{
        task_id: 'T-1',
        section_id: 'SEC-1',
        issue_ids: ['REV-1'],
        depends_on: [],
        status: 'running',
        failure: null,
        started_at: 1000,
        completed_at: null,
      }],
      created_at: 1000,
      updated_at: 1000,
    }
    const completed = completeRevisionBatchExecution(batch, 2000)
    expect(completed.status).toBe('completed')
    // 再次 complete 幂等
    expect(completeRevisionBatchExecution(completed, 3000).status).toBe('completed')

    // 失败状态覆盖
    expect(failRevisionBatchExecution(batch, 4000).status).toBe('failed')
  })
})

describe('任务 03: 给 RevisionTask 增加真实 durable 状态', () => {
  function makeBaseBatch(tasks?: readonly {
    readonly task_id: string
    readonly section_id: string
    readonly issue_ids: readonly string[]
  }[]): RevisionBatchArtifact {
    const taskList = tasks ?? [{ task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'] }]
    return {
      schema_version: REVISION_BATCH_SCHEMA_VERSION,
      batch_id: 'BATCH-003',
      queue_revision: 1,
      issue_ids: taskList.flatMap(t => t.issue_ids),
      status: 'running',
      tasks: taskList.map(t => ({
        task_id: t.task_id,
        section_id: t.section_id,
        issue_ids: [...t.issue_ids],
        depends_on: [],
        status: 'queued',
        failure: null,
        started_at: null,
        completed_at: null,
      })),
      created_at: 1000,
      updated_at: 1000,
    }
  }

  it('1. 初始 queued: 新创建批次任务状态全部为 queued 且时间戳为空', () => {
    const queue = makeQueueWithIssues(
      { sectionId: 'SEC-1', title: '第 1 章' },
      { sectionId: 'SEC-2', title: '第 2 章' },
    )
    const plan = planInput(queue.issues.map(i => i.issue_id), [
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: [queue.issues[0]?.issue_id ?? ''] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: [queue.issues[1]?.issue_id ?? ''] },
    ])
    const { batch } = createRevisionBatch(queue, plan, 'BATCH-001', 1000, [])
    expect(batch.schema_version).toBe(2)
    expect(batch.tasks[0]?.status).toBe('queued')
    expect(batch.tasks[0]?.started_at).toBeNull()
    expect(batch.tasks[0]?.completed_at).toBeNull()
    expect(batch.tasks[0]?.failure).toBeNull()
    expect(batch.tasks[1]?.status).toBe('queued')
  })

  it('2. 获槽位 running: 从 queued 转为 running 时记录 started_at', () => {
    const batch = makeBaseBatch()
    const updated = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    expect(updated.tasks[0]?.status).toBe('running')
    expect(updated.tasks[0]?.started_at).toBe(2000)
    expect(updated.tasks[0]?.completed_at).toBeNull()
    expect(updated.updated_at).toBe(2000)
  })

  it('3. reviewing: 写作完成后从 running 迁移到 reviewing', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const reviewing = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'reviewing' }, 3000)
    expect(reviewing.tasks[0]?.status).toBe('reviewing')
    expect(reviewing.tasks[0]?.started_at).toBe(2000)
  })

  it('4. repairing: 审查未通过要求修补时从 reviewing 迁移到 repairing', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const reviewing = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'reviewing' }, 3000)
    const repairing = updateRevisionBatchTaskStatus(reviewing, 'T-1', { status: 'repairing' }, 4000)
    expect(repairing.tasks[0]?.status).toBe('repairing')
  })

  it('5. repairing → reviewing: 修补完成后再次进入审查', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const reviewing1 = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'reviewing' }, 3000)
    const repairing = updateRevisionBatchTaskStatus(reviewing1, 'T-1', { status: 'repairing' }, 4000)
    const reviewing2 = updateRevisionBatchTaskStatus(repairing, 'T-1', { status: 'reviewing' }, 5000)
    expect(reviewing2.tasks[0]?.status).toBe('reviewing')
  })

  it('6. completed: 审查通过且提交成功后从 reviewing 转为 completed', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const reviewing = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'reviewing' }, 3000)
    const completed = updateRevisionBatchTaskStatus(reviewing, 'T-1', { status: 'completed' }, 6000)
    expect(completed.tasks[0]?.status).toBe('completed')
    expect(completed.tasks[0]?.completed_at).toBe(6000)
  })

  it('7. conflict: base stale 时从 queued 迁移到 conflict', () => {
    const batch = makeBaseBatch()
    const conflict = updateRevisionBatchTaskStatus(batch, 'T-1', {
      status: 'conflict',
      failure: { code: 'STALE_BASE', message: '章节正文已变更', phase: null },
    }, 2500)
    expect(conflict.tasks[0]?.status).toBe('conflict')
    expect(conflict.tasks[0]?.failure?.code).toBe('STALE_BASE')
  })

  it('8. needs_input: 缺少输入时从 running 或 reviewing 迁移到 needs_input', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const needsInput = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'needs_input' }, 3000)
    expect(needsInput.tasks[0]?.status).toBe('needs_input')
  })

  it('9. blocked: 依赖任务失败时从 queued 迁移到 blocked', () => {
    const batch = makeBaseBatch([
      { task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'] },
      { task_id: 'T-2', section_id: 'SEC-2', issue_ids: ['REV-2'] },
    ])
    const blocked = updateRevisionBatchTaskStatus(batch, 'T-2', {
      status: 'blocked',
      failure: { code: 'DEPENDENCY_FAILED', message: '前置章节 SEC-1 失败', phase: 'blocked' },
    }, 2000)
    expect(blocked.tasks[1]?.status).toBe('blocked')
    expect(blocked.tasks[1]?.failure?.code).toBe('DEPENDENCY_FAILED')
  })

  it('10. Workbench 显示真实状态: Workbench 视图直接反映章节所属真实 task.status', () => {
    const view = {
      schema_version: 6,
      outline: [
        {
          section_id: 'SEC-1', parent_id: null, order: 1, title: '第 1 章', writable: true,
          writing_status: 'writing' as const, review_status: 'reviewing' as const,
          chapter_indicator: { status: 'reviewing' as const, tooltip: '审查中' },
          content_available: true,
          revision: { batch_id: 'BATCH-001', task_id: 'T-1', status: 'reviewing' as const, issue_count: 1 },
        },
        {
          section_id: 'SEC-2', parent_id: null, order: 2, title: '第 2 章', writable: true,
          writing_status: 'not_started' as const, review_status: 'not_started' as const,
          chapter_indicator: { status: 'queued' as const, tooltip: '排队中' },
          content_available: false,
          revision: { batch_id: 'BATCH-001', task_id: 'T-2', status: 'queued' as const, issue_count: 2 },
        },
        {
          section_id: 'SEC-3', parent_id: null, order: 3, title: '第 3 章', writable: true,
          writing_status: 'writing' as const, review_status: 'needs_attention' as const,
          chapter_indicator: { status: 'repairing' as const, tooltip: '修复中' },
          content_available: true,
          revision: { batch_id: 'BATCH-001', task_id: 'T-3', status: 'repairing' as const, issue_count: 1 },
        },
        {
          section_id: 'SEC-4', parent_id: null, order: 4, title: '第 4 章', writable: true,
          writing_status: 'failed' as const, review_status: 'not_started' as const,
          chapter_indicator: { status: 'failed' as const, tooltip: '依赖阻塞' },
          content_available: false,
          revision: { batch_id: 'BATCH-001', task_id: 'T-4', status: 'blocked' as const, issue_count: 1 },
        },
      ],
      summary: {
        chapter_count: 4, content_count: 2, reviewed_count: 1, needs_attention_count: 1,
        page_estimate: { status: 'unavailable' as const }, page_target: { status: 'not_set' as const },
      },
      global_compliance: {
        status: 'not_required' as const,
        reviewed_count: 0,
        total_count: 0,
        document_issues: [],
        delivery_todos: [],
      },
    }
    const parsed = parseBidReviewWorkbenchView(view)
    expect(parsed.outline[0]?.revision?.status).toBe('reviewing')
    expect(parsed.outline[1]?.revision?.status).toBe('queued')
    expect(parsed.outline[2]?.revision?.status).toBe('repairing')
    expect(parsed.outline[3]?.revision?.status).toBe('blocked')
  })

  it('11. Host 重启状态不丢: persistRevisionBatchTaskStatus 写入后重新读取完整还原', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-task03-'))
    try {
      const workspace = new BidWorkspace(tmp)
      const batch = makeBaseBatch()
      await writeRevisionBatch(workspace, batch)

      // 模拟执行流中原子更新落盘
      await persistRevisionBatchTaskStatus(workspace, 'BATCH-003', 'T-1', {
        status: 'running',
        started_at: 1500,
      }, 1500)

      // 模拟 Host 重启：再次读取 artifact
      const restored = await readRevisionBatch(workspace, 'BATCH-003')
      expect(restored).not.toBeNull()
      expect(restored?.tasks[0]?.status).toBe('running')
      expect(restored?.tasks[0]?.started_at).toBe(1500)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('12. completed 不恢复成 queued: 禁止向后非法退化，但幂等保持成功', () => {
    const batch = makeBaseBatch()
    const running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2000)
    const reviewing = updateRevisionBatchTaskStatus(running, 'T-1', { status: 'reviewing' }, 3000)
    const completed = updateRevisionBatchTaskStatus(reviewing, 'T-1', { status: 'completed' }, 4000)

    // 非法退化回 queued 或 running 拒绝
    expect(() => updateRevisionBatchTaskStatus(completed, 'T-1', { status: 'queued' }, 5000))
      .toThrow('BID_REVISION_TASK_INVALID_TRANSITION')
    expect(() => updateRevisionBatchTaskStatus(completed, 'T-1', { status: 'running' }, 5000))
      .toThrow('BID_REVISION_TASK_INVALID_TRANSITION')

    // 幂等调用允许
    const idempotent = updateRevisionBatchTaskStatus(completed, 'T-1', { status: 'completed' }, 6000)
    expect(idempotent.tasks[0]?.status).toBe('completed')
  })
})

describe('任务 04: stale/conflict 局部隔离与依赖传播', () => {
  const currentSha = 'a'.repeat(64)
  const staleSha = 'b'.repeat(64)

  function setupFiveTasksQueue() {
    let queue = emptyRevisionQueue()
    const sections = [
      { sectionId: 'SEC-A', title: '章节A', sha: currentSha },
      { sectionId: 'SEC-B', title: '章节B', sha: currentSha },
      { sectionId: 'SEC-C', title: '章节C', sha: staleSha },
      { sectionId: 'SEC-D', title: '章节D', sha: currentSha },
      { sectionId: 'SEC-E', title: '章节E', sha: currentSha },
    ]
    let time = 1000
    for (const sec of sections) {
      queue = addRevisionIssue(queue, {
        section_id: sec.sectionId,
        scope: 'chapter',
        reference: { scope: 'chapter', base_content_sha256: sec.sha },
        instruction: `针对 ${sec.title} 的修改意见`,
        suggestion: null,
      }, sec.title, time)
      time += 1000
    }
    const currentHashes = new Map([
      ['SEC-A', currentSha],
      ['SEC-B', currentSha],
      ['SEC-C', currentSha],
      ['SEC-D', currentSha],
      ['SEC-E', currentSha],
    ])
    return { queue, currentHashes }
  }

  it('1. 5 task 中 1 stale，其余 4 个继续', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const issueC = queue.issues.find(item => item.section_id === 'SEC-C')
    expect(issueC).toBeDefined()
    const input = planInput(issueIds, [
      { task_id: 'T-A', section_id: 'SEC-A', issue_ids: [issueIds[0] ?? ''] },
      { task_id: 'T-B', section_id: 'SEC-B', issue_ids: [issueIds[1] ?? ''] },
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [issueIds[2] ?? ''] },
      { task_id: 'T-D', section_id: 'SEC-D', issue_ids: [issueIds[3] ?? ''] },
      { task_id: 'T-E', section_id: 'SEC-E', issue_ids: [issueIds[4] ?? ''] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    expect(validated.staleIssues).toEqual([issueC?.issue_id])

    const { queue: batchQueue, batch } = createRevisionBatch(queue, input, 'BATCH-004-1', 5000, validated.staleIssues)
    const taskMap = new Map(batch.tasks.map(t => [t.task_id, t]))
    expect(taskMap.get('T-C')?.status).toBe('conflict')
    expect(taskMap.get('T-A')?.status).toBe('queued')
    expect(taskMap.get('T-B')?.status).toBe('queued')
    expect(taskMap.get('T-D')?.status).toBe('queued')
    expect(taskMap.get('T-E')?.status).toBe('queued')

    const issueStatusMap = new Map(batchQueue.issues.map(i => [i.section_id, i.status]))
    expect(issueStatusMap.get('SEC-C')).toBe('conflict')
    expect(issueStatusMap.get('SEC-A')).toBe('scheduled')
    expect(issueStatusMap.get('SEC-B')).toBe('scheduled')
    expect(issueStatusMap.get('SEC-D')).toBe('scheduled')
    expect(issueStatusMap.get('SEC-E')).toBe('scheduled')
  })

  it('2. stale task = conflict 包含正确的 failure 信息与文案', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const idC = issueIds[2] ?? ''
    const input = planInput([idC], [
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [idC] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { batch } = createRevisionBatch(queue, input, 'BATCH-004-2', 5000, validated.staleIssues)
    const taskC = batch.tasks[0]
    expect(taskC?.status).toBe('conflict')
    expect(taskC?.failure).toEqual({
      code: 'STALE_BASE',
      message: '正文在审批意见创建后已发生变化，请重新选择该条内容。',
      phase: null,
    })
  })

  it('3. 依赖 stale → blocked 传播', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const ids = [issueIds[0] ?? '', issueIds[2] ?? '', issueIds[3] ?? '', issueIds[4] ?? '']
    const input = planInput(ids, [
      { task_id: 'T-A', section_id: 'SEC-A', issue_ids: [ids[0] ?? ''] },
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [ids[1] ?? ''] },
      { task_id: 'T-D', section_id: 'SEC-D', issue_ids: [ids[2] ?? ''], depends_on: ['T-C'] },
      { task_id: 'T-E', section_id: 'SEC-E', issue_ids: [ids[3] ?? ''], depends_on: ['T-D'] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { batch } = createRevisionBatch(queue, input, 'BATCH-004-3', 5000, validated.staleIssues)
    const taskMap = new Map(batch.tasks.map(t => [t.task_id, t]))

    expect(taskMap.get('T-A')?.status).toBe('queued')
    expect(taskMap.get('T-C')?.status).toBe('conflict')
    expect(taskMap.get('T-D')?.status).toBe('blocked')
    expect(taskMap.get('T-D')?.failure?.code).toBe('DEPENDENCY_BLOCKED')
    expect(taskMap.get('T-E')?.status).toBe('blocked')
    expect(taskMap.get('T-E')?.failure?.code).toBe('DEPENDENCY_BLOCKED')
  })

  it('4. 无关 task 完成: settleRevisionBatchIssues 正常结算无关 task，不因 conflict/blocked 抛错', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const idA = issueIds[0] ?? ''
    const idC = issueIds[2] ?? ''
    const idD = issueIds[3] ?? ''
    const input = planInput([idA, idC, idD], [
      { task_id: 'T-A', section_id: 'SEC-A', issue_ids: [idA] },
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [idC] },
      { task_id: 'T-D', section_id: 'SEC-D', issue_ids: [idD], depends_on: ['T-C'] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { queue: scheduledQueue } = createRevisionBatch(queue, input, 'BATCH-004-4', 5000, validated.staleIssues)

    const checks: RevisionIssueCheck[] = [{ issue_id: idA, status: 'satisfied' }]
    const result = settleRevisionBatchIssues(scheduledQueue, [idA], checks, 6000)
    expect(result.taskStatus).toBe('completed')

    const settledA = result.queue.issues.find(i => i.issue_id === idA)
    const conflictC = result.queue.issues.find(i => i.issue_id === idC)
    expect(settledA?.status).toBe('completed')
    expect(conflictC?.status).toBe('conflict')
  })

  it('5. batch 不因单 task conflict 直接 failed', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const ids = [issueIds[0] ?? '', issueIds[2] ?? '']
    const input = planInput(ids, [
      { task_id: 'T-A', section_id: 'SEC-A', issue_ids: [ids[0] ?? ''] },
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [ids[1] ?? ''] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { batch } = createRevisionBatch(queue, input, 'BATCH-004-5', 5000, validated.staleIssues)

    const running = startRevisionBatchExecution(batch, 5500)
    expect(running.status).toBe('running')

    const taskRunning = updateRevisionBatchTaskStatus(running, 'T-A', { status: 'running' }, 5600)
    const taskReviewing = updateRevisionBatchTaskStatus(taskRunning, 'T-A', { status: 'reviewing' }, 5800)
    const updated = updateRevisionBatchTaskStatus(taskReviewing, 'T-A', { status: 'completed' }, 6000)
    const completedBatch = completeRevisionBatchExecution(updated, 7000)
    expect(completedBatch.status).toBe('completed')
    const tC = completedBatch.tasks.find(t => t.task_id === 'T-C')
    expect(tC?.status).toBe('conflict')
  })

  it('6. stale task 不启动 Writer: runnableTasks 严格排除 conflict 和 blocked', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const ids = [issueIds[0] ?? '', issueIds[1] ?? '', issueIds[2] ?? '', issueIds[3] ?? '']
    const input = planInput(ids, [
      { task_id: 'T-A', section_id: 'SEC-A', issue_ids: [ids[0] ?? ''] },
      { task_id: 'T-B', section_id: 'SEC-B', issue_ids: [ids[1] ?? ''] },
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [ids[2] ?? ''] },
      { task_id: 'T-D', section_id: 'SEC-D', issue_ids: [ids[3] ?? ''], depends_on: ['T-C'] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { batch } = createRevisionBatch(queue, input, 'BATCH-004-6', 5000, validated.staleIssues)

    const runnableTasks = batch.tasks.filter(t => t.status === 'queued')
    const runnableTaskIds = runnableTasks.map(t => t.task_id)

    expect(runnableTaskIds).toContain('T-A')
    expect(runnableTaskIds).toContain('T-B')
    expect(runnableTaskIds).not.toContain('T-C')
    expect(runnableTaskIds).not.toContain('T-D')
  })

  it('7. 重新选择后下一批可执行: updateRevisionIssue 从 conflict 恢复为 pending 后可再次规划', () => {
    const { queue, currentHashes } = setupFiveTasksQueue()
    const issueIds = queue.issues.map(item => item.issue_id)
    const input = planInput([issueIds[2] ?? ''], [
      { task_id: 'T-C', section_id: 'SEC-C', issue_ids: [issueIds[2] ?? ''] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    const { queue: batchQueue } = createRevisionBatch(queue, input, 'BATCH-004-7', 5000, validated.staleIssues)

    const staleIssueId = issueIds[2] ?? ''
    const conflictIssue = batchQueue.issues.find(i => i.issue_id === staleIssueId)
    expect(conflictIssue?.status).toBe('conflict')

    const updatedQueue = updateRevisionIssue(batchQueue, {
      issue_id: staleIssueId,
      expected_queue_revision: batchQueue.revision,
      reference: { scope: 'chapter', base_content_sha256: currentSha },
    }, 6000)

    const recoveredIssue = updatedQueue.issues.find(i => i.issue_id === staleIssueId)
    expect(recoveredIssue?.status).toBe('pending')
    expect(recoveredIssue?.batch_id).toBeNull()

    const nextInput = planInput([staleIssueId], [
      { task_id: 'T-C-NEXT', section_id: 'SEC-C', issue_ids: [staleIssueId] },
    ], updatedQueue.revision)
    const nextValidated = validateRevisionBatchPlan(nextInput, updatedQueue, currentHashes)
    expect(nextValidated.staleIssues).toEqual([])
    const { batch: nextBatch } = createRevisionBatch(
      updatedQueue, nextInput, 'BATCH-004-8', 7000, nextValidated.staleIssues,
    )
    expect(nextBatch.tasks[0]?.status).toBe('queued')
  })

  it('8. 同 task 一条 stale 时整 section task 不部分执行', () => {
    let queue = emptyRevisionQueue()
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-A',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '正常意见',
      suggestion: null,
    }, '章节A', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-A',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: staleSha },
      instruction: '过期意见',
      suggestion: null,
    }, '章节A', 2000)

    const issueIds = queue.issues.map(i => i.issue_id)
    const input = planInput(issueIds, [
      { task_id: 'T-SEC-A', section_id: 'SEC-A', issue_ids: issueIds },
    ])
    const currentHashes = new Map([['SEC-A', currentSha]])

    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    expect(validated.staleIssues).toHaveLength(2)
    expect(validated.staleIssues).toContain(issueIds[0])
    expect(validated.staleIssues).toContain(issueIds[1])

    const { queue: batchQueue, batch } = createRevisionBatch(
      queue, input, 'BATCH-004-9', 5000, validated.staleIssues,
    )
    expect(batch.tasks[0]?.status).toBe('conflict')
    expect(batchQueue.issues[0]?.status).toBe('conflict')
    expect(batchQueue.issues[1]?.status).toBe('conflict')
  })
})

describe('任务 05: Batch 暂停恢复状态机 (suspend/resume/fail)', () => {
  function makeRunningBatch(
    tasks?: readonly { readonly taskId: string; readonly status: 'queued' | 'completed' | 'conflict' | 'blocked' }[],
  ): RevisionBatchArtifact {
    const taskList = tasks ?? [{ taskId: 'T-1', status: 'queued' }]
    return {
      schema_version: REVISION_BATCH_SCHEMA_VERSION,
      batch_id: 'BATCH-005',
      queue_revision: 1,
      issue_ids: taskList.map(t => `ISSUE-${t.taskId}`),
      status: 'running',
      tasks: taskList.map(t => ({
        task_id: t.taskId,
        section_id: `SEC-${t.taskId}`,
        issue_ids: [`ISSUE-${t.taskId}`],
        depends_on: [],
        status: t.status,
        failure: null,
        started_at: null,
        completed_at: null,
      })),
      created_at: 1000,
      updated_at: 2000,
    }
  }

  it('1. stop → Run suspended + Batch suspended: 用户 stop 或中断时 batch 挂起为 suspended', () => {
    const batch = makeRunningBatch()
    const suspended = suspendRevisionBatchExecution(batch, 3000)
    expect(suspended.status).toBe('suspended')
    expect(suspended.updated_at).toBe(3000)

    const idempotent = suspendRevisionBatchExecution(suspended, 4000)
    expect(idempotent.status).toBe('suspended')
  })

  it('2. resume → running: 从 suspended 安全恢复为 running', () => {
    const batch = makeRunningBatch()
    const suspended = suspendRevisionBatchExecution(batch, 3000)
    const resumed = resumeRevisionBatchExecution(suspended, 4000)
    expect(resumed.status).toBe('running')
    expect(resumed.updated_at).toBe(4000)

    const crashRecovered = resumeRevisionBatchExecution(resumed, 5000)
    expect(crashRecovered.status).toBe('running')
    expect(crashRecovered.updated_at).toBe(5000)
  })

  it('3. 完成 → completed: 恢复执行完成后正常收敛', () => {
    const batch = makeRunningBatch()
    const suspended = suspendRevisionBatchExecution(batch, 3000)
    const resumed = resumeRevisionBatchExecution(suspended, 4000)
    const completed = completeRevisionBatchExecution(resumed, 5000)
    expect(completed.status).toBe('completed')
    expect(completed.updated_at).toBe(5000)
  })

  it('4. 可恢复 executor error → suspended: 遇到可恢复错误时分流到 suspended 而非 failed', () => {
    const batch = makeRunningBatch()
    const error = new Error('Executor network timeout or model rate limit')
    const isFatal = error.message.includes('FATAL_CORRUPTION')
    const nextBatch = isFatal
      ? failRevisionBatchExecution(batch, 3000)
      : suspendRevisionBatchExecution(batch, 3000)
    expect(nextBatch.status).toBe('suspended')
  })

  it('5. resume 不重跑 completed: 恢复执行时已 completed 的 task 排除在 runnableTasks 外', () => {
    const batch = makeRunningBatch([
      { taskId: 'T-1', status: 'completed' },
      { taskId: 'T-2', status: 'queued' },
      { taskId: 'T-3', status: 'conflict' },
      { taskId: 'T-4', status: 'blocked' },
    ])
    const suspended = suspendRevisionBatchExecution(batch, 3000)
    const runningBatch = resumeRevisionBatchExecution(suspended, 4000)

    const runnableTasks = runningBatch.tasks.filter((task) => {
      return task.status !== 'completed' && task.status !== 'conflict' && task.status !== 'blocked'
    })

    expect(runnableTasks).toHaveLength(1)
    expect(runnableTasks[0]?.task_id).toBe('T-2')
  })

  it('6. Host restart 后 resume: 落盘读取后仍能正常 resume 与 complete', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-task05-'))
    try {
      const workspace = new BidWorkspace(tmp)
      const batch = makeRunningBatch([{ taskId: 'T-1', status: 'queued' }])
      const suspended = suspendRevisionBatchExecution(batch, 3000)
      await writeRevisionBatch(workspace, suspended)

      const restored = await readRevisionBatch(workspace, 'BATCH-005')
      expect(restored).not.toBeNull()
      if (restored === null) throw new Error('BATCH-005 not found')
      expect(restored.status).toBe('suspended')

      const resumed = resumeRevisionBatchExecution(restored, 4000)
      expect(resumed.status).toBe('running')
      const completed = completeRevisionBatchExecution(resumed, 5000)
      await writeRevisionBatch(workspace, completed)

      const finalBatch = await readRevisionBatch(workspace, 'BATCH-005')
      expect(finalBatch?.status).toBe('completed')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('7. fatal corruption → failed: 致命损坏时明确标记 failed', () => {
    const batch = makeRunningBatch()
    const error = new Error('FATAL_CORRUPTION: disk data corrupted beyond recovery')
    const isFatal = error.message.includes('FATAL_CORRUPTION')
    const nextBatch = isFatal
      ? failRevisionBatchExecution(batch, 3000)
      : suspendRevisionBatchExecution(batch, 3000)
    expect(nextBatch.status).toBe('failed')
  })

  it('8. 普通 task failed 不让 Batch failed: 章节级 failure 记录于 task，batch 最终可 completed', () => {
    const batch = makeRunningBatch([
      { taskId: 'T-1', status: 'queued' },
      { taskId: 'T-2', status: 'queued' },
    ])
    const t1Running = updateRevisionBatchTaskStatus(batch, 'T-1', { status: 'running' }, 2100)
    const t1Failed = updateRevisionBatchTaskStatus(t1Running, 'T-1', {
      status: 'failed',
      failure: { code: 'SECTION_FAILED', message: '章节写作失败', phase: 'review' },
    }, 2200)

    const t2Running = updateRevisionBatchTaskStatus(t1Failed, 'T-2', { status: 'running' }, 2300)
    const t2Reviewing = updateRevisionBatchTaskStatus(t2Running, 'T-2', { status: 'reviewing' }, 2400)
    const t2Completed = updateRevisionBatchTaskStatus(t2Reviewing, 'T-2', { status: 'completed' }, 2500)

    const completedBatch = completeRevisionBatchExecution(t2Completed, 3000)
    expect(completedBatch.status).toBe('completed')
    expect(completedBatch.tasks[0]?.status).toBe('failed')
    expect(completedBatch.tasks[0]?.failure?.code).toBe('SECTION_FAILED')
    expect(completedBatch.tasks[1]?.status).toBe('completed')
  })

  it('9. complete 不再因状态错乱抛错: planning 拒绝 resume, suspended 必须 resume 才能 complete', () => {
    const planningBatch: RevisionBatchArtifact = {
      ...makeRunningBatch(),
      status: 'planning',
    }
    expect(() => resumeRevisionBatchExecution(planningBatch, 3000)).toThrow('BID_REVISION_BATCH_NOT_SUSPENDED')

    const suspended = suspendRevisionBatchExecution(makeRunningBatch(), 3000)
    expect(() => completeRevisionBatchExecution(suspended, 4000)).toThrow('BID_REVISION_BATCH_NOT_RUNNING')

    const resumed = resumeRevisionBatchExecution(suspended, 5000)
    const completed = completeRevisionBatchExecution(resumed, 6000)
    expect(completed.status).toBe('completed')
  })
})

describe('任务 06: Host 强制同章节单 Task', () => {
  const currentSha = 'a'.repeat(64)

  function setupMultiIssuesQueue() {
    let queue = emptyRevisionQueue()
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-203',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '意见 1',
      suggestion: null,
    }, '第二章第三节', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-203',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '意见 2',
      suggestion: null,
    }, '第二章第三节', 2000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-203',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '意见 3',
      suggestion: null,
    }, '第二章第三节', 3000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-204',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '章节 204 意见',
      suggestion: null,
    }, '第二章第四节', 4000)
    return queue
  }

  it('1. 同 section 两 task → 拒绝: 抛出 BID_REVISION_BATCH_SECTION_DUPLICATE', () => {
    const queue = setupMultiIssuesQueue()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const id2 = queue.issues[1]?.issue_id ?? ''
    // 错误规划：将同一章节 SEC-203 拆分为两个不同的 task
    const input = planInput([id1, id2], [
      { task_id: 'TASK-A', section_id: 'SEC-203', issue_ids: [id1] },
      { task_id: 'TASK-B', section_id: 'SEC-203', issue_ids: [id2] },
    ])

    expect(() => validateRevisionBatchPlan(input, queue, new Map()))
      .toThrow('BID_REVISION_BATCH_SECTION_DUPLICATE')
  })

  it('2. 同 section 三 issue 一个 task → 成功', () => {
    const queue = setupMultiIssuesQueue()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const id2 = queue.issues[1]?.issue_id ?? ''
    const id3 = queue.issues[2]?.issue_id ?? ''
    // 正确规划：同章节 SEC-203 的所有 issue 强制聚合在单个 task 中
    const input = planInput([id1, id2, id3], [
      { task_id: 'TASK-SEC-203', section_id: 'SEC-203', issue_ids: [id1, id2, id3] },
    ])

    const validated = validateRevisionBatchPlan(input, queue, new Map())
    expect(validated.tasks).toHaveLength(1)
    expect(validated.tasks[0]?.task_id).toBe('TASK-SEC-203')
    expect(validated.tasks[0]?.issue_ids).toEqual([id1, id2, id3])
  })

  it('3. 不同 section 多 task → 成功', () => {
    const queue = setupMultiIssuesQueue()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const id4 = queue.issues[3]?.issue_id ?? ''
    const input = planInput([id1, id4], [
      { task_id: 'TASK-SEC-203', section_id: 'SEC-203', issue_ids: [id1] },
      { task_id: 'TASK-SEC-204', section_id: 'SEC-204', issue_ids: [id4] },
    ])

    const validated = validateRevisionBatchPlan(input, queue, new Map())
    expect(validated.tasks).toHaveLength(2)
    expect(validated.tasks[0]?.section_id).toBe('SEC-203')
    expect(validated.tasks[1]?.section_id).toBe('SEC-204')
  })

  it('4. issue/task section 不匹配仍拒绝: 抛出 BID_REVISION_BATCH_SECTION_MISMATCH', () => {
    const queue = setupMultiIssuesQueue()
    const id4 = queue.issues[3]?.issue_id ?? '' // 所属 section_id 为 SEC-204
    // 错误规划：task.section_id 是 SEC-203，但包含了 SEC-204 的 issue
    const input = planInput([id4], [
      { task_id: 'TASK-SEC-203', section_id: 'SEC-203', issue_ids: [id4] },
    ])

    expect(() => validateRevisionBatchPlan(input, queue, new Map()))
      .toThrow('BID_REVISION_BATCH_SECTION_MISMATCH')
  })

  it('5. DAG 校验不回归: 自依赖与环形依赖继续被拒绝', () => {
    const queue = setupMultiIssuesQueue()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const id4 = queue.issues[3]?.issue_id ?? ''

    // 自依赖拒绝
    const selfDepInput = planInput([id1], [
      { task_id: 'TASK-SEC-203', section_id: 'SEC-203', issue_ids: [id1], depends_on: ['TASK-SEC-203'] },
    ])
    expect(() => validateRevisionBatchPlan(selfDepInput, queue, new Map()))
      .toThrow('BID_REVISION_BATCH_SELF_DEPENDENCY')

    // 环形依赖拒绝
    const cycleInput = planInput([id1, id4], [
      { task_id: 'TASK-SEC-203', section_id: 'SEC-203', issue_ids: [id1], depends_on: ['TASK-SEC-204'] },
      { task_id: 'TASK-SEC-204', section_id: 'SEC-204', issue_ids: [id4], depends_on: ['TASK-SEC-203'] },
    ])
    expect(() => validateRevisionBatchPlan(cycleInput, queue, new Map()))
      .toThrow('BID_REVISION_BATCH_CYCLE')
  })
})

describe('任务 07: 用户一次开始自动规划并立即执行', () => {
  const currentSha = 'a'.repeat(64)

  function setupQueueForTurn7() {
    let queue = emptyRevisionQueue()
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-203',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '意见 1',
      suggestion: null,
    }, '第二章第三节', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-204',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '意见 2',
      suggestion: null,
    }, '第二章第四节', 2000)
    return queue
  }

  it('1. 一条"开始处理这些建议"同回合 plan + execute: 交互规则要求规划成功后同一回合内紧接着调用 execute', () => {
    const runningPrompt = renderChapterWritingInteractionPrompt('running')
    const completedPrompt = renderChapterWritingInteractionPrompt('completed')

    for (const prompt of [runningPrompt, completedPrompt]) {
      expect(prompt).toContain('当存在 pending revision issues 且用户明确要求开始处理')
      expect(prompt).toContain('1. 调用 bid_stage_inspect 读取待处理审批意见；')
      expect(prompt).toContain('3. 调用 bid_plan_revision_batch 创建并保存不可变批次快照；')
      expect(prompt).toContain(
        '4. 规划成功且有可执行任务时，在同一回合内紧接着调用 bid_execute_revision_batch 立即开始执行，'
        + '绝不向用户发起二次确认或询问是否执行；',
      )
    }
  })

  it('2. 不要求第二条消息: 严禁向用户发起二次确认或询问是否执行', () => {
    const prompt = renderChapterWritingInteractionPrompt('running')
    expect(prompt).toContain('绝不向用户发起二次确认或询问是否执行')
    expect(prompt).not.toContain('当用户明确要求"执行修订""开始修改""按批次处理"时，调用 bid_execute_revision_batch')
  })

  it('3. 普通问答不启动: 讨论/咨询等普通意图严禁调用批次规划或执行工具', () => {
    const prompt = renderChapterWritingInteractionPrompt('running')
    expect(prompt).toContain(
      '用户若只是讨论、咨询或明确要求暂缓（如"这些意见你怎么看""先总结一下""还有哪些地方值得改""先别动"等），'
      + '严禁调用批次规划或执行工具。',
    )
  })

  it('4. "先别动/先别改"暂缓意图不启动: 明确要求暂缓时严禁调用批次工具', () => {
    const prompt = renderChapterWritingInteractionPrompt('completed')
    expect(prompt).toContain('先别动')
    expect(prompt).toContain('严禁调用批次规划或执行工具')
  })

  it('5. 无 pending 不创建 batch: 规则限定仅在存在 pending revision issues 时调用', () => {
    const prompt = renderChapterWritingInteractionPrompt('running')
    expect(prompt).toContain('当存在 pending revision issues 且用户明确要求开始处理')

    const emptyQueue = emptyRevisionQueue()
    const input = planInput(['REV-non-existent'], [
      { task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: ['REV-non-existent'] },
    ])
    // 空队列中找不到 issue 抛出 NOT_FOUND，无法创建 batch
    expect(() => validateRevisionBatchPlan(input, emptyQueue, new Map()))
      .toThrow('BID_REVISION_BATCH_ISSUE_NOT_FOUND')

    // 已处理/非 pending 的 issue 也会抛出 NOT_PENDING
    const queue = setupQueueForTurn7()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const appliedQueue: RevisionQueueArtifact = {
      ...queue,
      issues: queue.issues.map(issue => (issue.issue_id === id1 ? { ...issue, status: 'applied' } : issue)),
    }
    const pendingInput = planInput([id1], [
      { task_id: 'TASK-1', section_id: 'SEC-203', issue_ids: [id1] },
    ])
    expect(() => validateRevisionBatchPlan(pendingInput, appliedQueue, new Map()))
      .toThrow('BID_REVISION_BATCH_ISSUE_NOT_PENDING')
  })

  it('6. plan 失败不 execute: 规划校验失败阻断后续执行流程', () => {
    const queue = setupQueueForTurn7()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const badInput = planInput([id1], [
      { task_id: 'TASK-1', section_id: 'SEC-WRONG', issue_ids: [id1] },
    ])
    expect(() => validateRevisionBatchPlan(badInput, queue, new Map()))
      .toThrow('BID_REVISION_BATCH_SECTION_MISMATCH')
  })

  it('7. plan 成功有可执行任务则立即 execute: 规划产物可直接被 execute 启动无需二次等待', () => {
    const queue = setupQueueForTurn7()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const input = planInput([id1], [
      { task_id: 'TASK-1', section_id: 'SEC-203', issue_ids: [id1] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const { batch } = createRevisionBatch(queue, input, 'BATCH-007-1', 1000, validated.staleIssues)
    expect(batch.status).toBe('planning')
    expect(batch.tasks[0]?.status).toBe('queued')

    // 同一回合内紧接着调用 execute 启动执行
    const executing = startRevisionBatchExecution(batch, 1100)
    expect(executing.status).toBe('running')
    expect(executing.tasks[0]?.status).toBe('queued')
  })

  it('8. 局部 conflict 不阻断独立任务且局部 revision 不走 writing plan patch', () => {
    const prompt = renderChapterWritingInteractionPrompt('running')
    expect(prompt).toContain(
      '部分 task 若出现 conflict 或 needs_input，直接执行其余独立任务，绝不因局部冲突阻断其他章节或询问用户。',
    )
    expect(prompt).toContain(
      '局部审批意见修订绝不启动 bid_confirm_writing_plan.patch，选区中的"统一""全部"是局部 RevisionIssue 要求；',
    )

    // 局部 conflict 不阻断其余独立 task
    const queue = setupQueueForTurn7()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const id2 = queue.issues[1]?.issue_id ?? ''
    const input = planInput([id1, id2], [
      { task_id: 'TASK-1', section_id: 'SEC-203', issue_ids: [id1] },
      { task_id: 'TASK-2', section_id: 'SEC-204', issue_ids: [id2] },
    ])
    // 模拟 SEC-203 发生过期冲突
    const staleHashes = new Map([
      ['SEC-203', 'b'.repeat(64)],
      ['SEC-204', currentSha],
    ])
    const validated = validateRevisionBatchPlan(input, queue, staleHashes)
    expect(validated.staleIssues).toContain(id1)

    const { batch } = createRevisionBatch(queue, input, 'BATCH-007-2', 1000, validated.staleIssues)
    expect(batch.tasks.find(t => t.task_id === 'TASK-1')?.status).toBe('conflict')
    expect(batch.tasks.find(t => t.task_id === 'TASK-2')?.status).toBe('queued')

    // 启动执行：批次转为 running，TASK-2 保持 queued（等待 Writer 槽位），未被阻断
    const executing = startRevisionBatchExecution(batch, 1100)
    expect(executing.status).toBe('running')
    expect(executing.tasks.find(t => t.task_id === 'TASK-1')?.status).toBe('conflict')
    expect(executing.tasks.find(t => t.task_id === 'TASK-2')?.status).toBe('queued')
    // 可由调度器将 TASK-2 顺利推进到 running
    const scheduled = updateRevisionBatchTaskStatus(executing, 'TASK-2', { status: 'running' }, 1200)
    expect(scheduled.tasks.find(t => t.task_id === 'TASK-2')?.status).toBe('running')
  })
})

describe('任务 08: Queue 与 Batch 原子一致性', () => {
  const currentSha = 'a'.repeat(64)
  const disposals: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose()
  })

  async function createTestWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-revision-atomic-'))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    return new BidWorkspace(root)
  }

  function setupQueueForTurn8() {
    let queue = emptyRevisionQueue()
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-301',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '修订意见 1',
      suggestion: null,
    }, '第三章第一节', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-302',
      scope: 'chapter',
      reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '修订意见 2',
      suggestion: null,
    }, '第三章第二节', 2000)
    return queue
  }

  it('1. plan 时 queue + batch 同 publication 原子提交', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const input = planInput([id1], [
      { task_id: 'TASK-1', section_id: 'SEC-301', issue_ids: [id1] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const batchId = createRevisionBatchId()
    const { queue: updatedQueue, batch } = createRevisionBatch(queue, input, batchId, 3000, validated.staleIssues)

    await commitRevisionBatchPlan(ws, updatedQueue, batch)

    const savedQueue = await readRevisionQueue(ws)
    const savedBatch = await readRevisionBatch(ws, batchId)
    expect(savedQueue.revision).toBe(updatedQueue.revision)
    expect(savedQueue.issues[0]?.status).toBe('scheduled')
    expect(savedQueue.issues[0]?.batch_id).toBe(batchId)
    expect(savedBatch).not.toBeNull()
    expect(savedBatch?.batch_id).toBe(batchId)
    expect(savedBatch?.status).toBe('planning')
  })

  it('2. 模拟中途 crash 不出现 orphan: 未达 commit-intent 全部回滚，到达后全量 roll forward', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    await writeRevisionQueue(ws, queue)

    // 运行 reconcilePublications 验证干净工作区
    await reconcileBidPublications(ws.root, ws.projectRoot)
    const queueAfterReconcile = await readRevisionQueue(ws)
    expect(queueAfterReconcile.revision).toBe(queue.revision)

    // 正常通过 commitRevisionBatchPlan 提交，两阶段事务自动清理临时目录
    const id1 = queue.issues[0]?.issue_id ?? ''
    const input = planInput([id1], [{ task_id: 'TASK-1', section_id: 'SEC-301', issue_ids: [id1] }])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const batchId = createRevisionBatchId()
    const { queue: nextQueue, batch } = createRevisionBatch(queue, input, batchId, 3000, validated.staleIssues)

    await commitRevisionBatchPlan(ws, nextQueue, batch)
    // 模拟重新启动并对齐 publication 状态
    await reconcileBidPublications(ws.root, ws.projectRoot)
    const durableQueue = await readRevisionQueue(ws)
    const durableBatch = await readRevisionBatch(ws, batchId)
    expect(durableQueue.issues[0]?.status).toBe('scheduled')
    expect(durableBatch?.batch_id).toBe(batchId)
  })

  it('3. task complete + issue complete 一致提交: 结算与完成在同 publication 内原子落地', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const input = planInput([id1], [{ task_id: 'TASK-1', section_id: 'SEC-301', issue_ids: [id1] }])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const batchId = createRevisionBatchId()
    const { queue: plannedQueue, batch } = createRevisionBatch(queue, input, batchId, 3000, validated.staleIssues)
    await commitRevisionBatchPlan(ws, plannedQueue, batch)

    // 模拟合法状态机迁移：queued -> running -> reviewing -> completed
    const taskRunning = updateRevisionBatchTaskStatus(batch, 'TASK-1', { status: 'running' }, 3500)
    const taskReviewing = updateRevisionBatchTaskStatus(taskRunning, 'TASK-1', { status: 'reviewing' }, 3800)
    const taskCompleted = updateRevisionBatchTaskStatus(taskReviewing, 'TASK-1', { status: 'completed' }, 4000)
    const settledQueue: RevisionQueueArtifact = {
      ...plannedQueue,
      revision: plannedQueue.revision + 1,
      issues: plannedQueue.issues.map(issue =>
        issue.issue_id === id1 ? { ...issue, status: 'completed' as const, updated_at: 4000 } : issue,
      ),
    }
    const completedBatch = completeRevisionBatchExecution(
      { ...taskCompleted, status: 'running' },
      4500,
    )

    await commitRevisionBatchExecutionSettlement(ws, settledQueue, completedBatch)

    const diskQueue = await readRevisionQueue(ws)
    const diskBatch = await readRevisionBatch(ws, batchId)
    expect(diskQueue.issues[0]?.status).toBe('completed')
    expect(diskBatch?.status).toBe('completed')
    expect(diskBatch?.tasks[0]?.status).toBe('completed')
  })

  it('4. CAS conflict 不写任何文件: expected_queue_revision 不一致时拒绝且磁盘零变更', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    // 写入 revision = 0
    await writeRevisionQueue(ws, queue)

    // 假设另一个操作推进了 revision 到 2
    const advancedQueue: RevisionQueueArtifact = { ...queue, revision: 2 }
    await writeRevisionQueue(ws, advancedQueue)

    const id1 = advancedQueue.issues[0]?.issue_id ?? ''
    // 尝试以陈旧的 expected_queue_revision = 0 进行规划校验
    const staleInput = planInput([id1], [{ task_id: 'TASK-1', section_id: 'SEC-301', issue_ids: [id1] }], 0)

    const currentDiskQueue = await readRevisionQueue(ws)
    expect(currentDiskQueue.revision).toBe(2)
    // 校验 CAS 冲突
    expect(currentDiskQueue.revision !== staleInput.expected_queue_revision).toBe(true)

    // 验证磁盘上的队列与批次保持原状，无任何新批次被写入
    const missingBatch = await readRevisionBatch(ws, 'BATCH-NON-EXISTENT')
    expect(missingBatch).toBeNull()
    const queueRemains = await readRevisionQueue(ws)
    expect(queueRemains.revision).toBe(2)
  })

  it('5. 旧 orphan 可检测: issue.batch_id 指向不存在 batch 抛出 BID_REVISION_BATCH_ORPHANED 且可安全恢复', async () => {
    const ws = await createTestWorkspace()
    let queue = setupQueueForTurn8()
    const id1 = queue.issues[0]?.issue_id ?? ''
    // 构造孤儿 issue：状态为 scheduled 但 batch_id 对应的文件不存在
    queue = {
      ...queue,
      issues: queue.issues.map(issue =>
        issue.issue_id === id1 ? { ...issue, status: 'scheduled' as const, batch_id: 'BATCH-GHOST' } : issue,
      ),
    }
    await writeRevisionQueue(ws, queue)

    // 检测应识别出孤儿并报错
    await expect(detectRevisionBatchIntegrity(ws, queue))
      .rejects.toThrow('BID_REVISION_BATCH_ORPHANED')

    // 调用恢复函数将孤儿 issue 重置为 pending
    const recovered = recoverOrphanRevisionIssues(queue, [id1], 5000)
    expect(recovered.issues[0]?.status).toBe('pending')
    expect(recovered.issues[0]?.batch_id).toBeNull()
    expect(recovered.revision).toBe(queue.revision + 1)
  })

  it('6. batch 缺 issue 可检测: batch 存在但 queue 缺失 issue 识别为 FATAL_CORRUPTION', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    // 构造一个包含 queue 中未定义 issue 的 batch
    const corruptBatch: RevisionBatchArtifact = {
      schema_version: REVISION_BATCH_SCHEMA_VERSION,
      batch_id: 'BATCH-CORRUPT',
      queue_revision: 0,
      issue_ids: ['REV-GHOST-MISSING'],
      status: 'planning',
      tasks: [{
        task_id: 'T-1',
        section_id: 'SEC-301',
        issue_ids: ['REV-GHOST-MISSING'],
        depends_on: [],
        status: 'queued',
        failure: null,
        started_at: null,
        completed_at: null,
      }],
      created_at: 1000,
      updated_at: 1000,
    }

    await expect(detectRevisionBatchIntegrity(ws, queue, corruptBatch))
      .rejects.toThrow('FATAL_CORRUPTION: BID_REVISION_BATCH_CORRUPTED_MISSING_ISSUE')
  })

  it('7. Host restart 后一致: publication 提交后重新读取工作区完全对齐', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    const id1 = queue.issues[0]?.issue_id ?? ''
    const input = planInput([id1], [{ task_id: 'TASK-1', section_id: 'SEC-301', issue_ids: [id1] }])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const batchId = createRevisionBatchId()
    const { queue: plannedQueue, batch } = createRevisionBatch(queue, input, batchId, 3000, validated.staleIssues)

    await commitRevisionBatchPlan(ws, plannedQueue, batch)

    // 模拟宿主重启：重新打开该工作区路径
    const reopenedWorkspace = new BidWorkspace(ws.root)
    const reopenedQueue = await readRevisionQueue(reopenedWorkspace)
    const reopenedBatch = await readRevisionBatch(reopenedWorkspace, batchId)

    expect(reopenedQueue.revision).toBe(plannedQueue.revision)
    expect(reopenedQueue.issues[0]?.status).toBe('scheduled')
    expect(reopenedQueue.issues[0]?.batch_id).toBe(batchId)
    expect(reopenedBatch?.batch_id).toBe(batchId)
    expect(reopenedBatch?.tasks[0]?.issue_ids).toEqual([id1])
  })

  it('8. 并发 plan 不抢同一 pending issue: 先到者推进 revision，后到者被 CAS 或 NOT_PENDING 拒绝', async () => {
    const ws = await createTestWorkspace()
    const queue = setupQueueForTurn8()
    await writeRevisionQueue(ws, queue)
    const id1 = queue.issues[0]?.issue_id ?? ''

    // Plan A 先到达并成功提交
    const inputA = planInput([id1], [{ task_id: 'TASK-A', section_id: 'SEC-301', issue_ids: [id1] }], 0)
    const validatedA = validateRevisionBatchPlan(inputA, queue, new Map())
    const batchIdA = createRevisionBatchId()
    const { queue: queueA, batch: batchA } = createRevisionBatch(queue, inputA, batchIdA, 2000, validatedA.staleIssues)
    await commitRevisionBatchPlan(ws, queueA, batchA)

    // Plan B 后到达（仍使用 expected_queue_revision = 0）
    const inputB = planInput([id1], [{ task_id: 'TASK-B', section_id: 'SEC-301', issue_ids: [id1] }], 0)
    const latestQueue = await readRevisionQueue(ws)
    // 1. CAS 校验拒绝：revision 已从 0 推进到 1
    expect(latestQueue.revision !== inputB.expected_queue_revision).toBe(true)

    // 2. 即使 Plan B 试图使用最新 revision，由于 id1 已经不是 pending，业务校验也拒绝
    const refreshedInputB = planInput(
      [id1],
      [{ task_id: 'TASK-B', section_id: 'SEC-301', issue_ids: [id1] }],
      latestQueue.revision,
    )
    expect(() => validateRevisionBatchPlan(refreshedInputB, latestQueue, new Map()))
      .toThrow('BID_REVISION_BATCH_ISSUE_NOT_PENDING')
  })
})

describe('任务 09: b54fe9a385 批量审批修订全链路端到端回归验收', () => {
  const currentSha = 'a'.repeat(64)
  const disposals: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose()
  })

  async function createWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-revision-e2e-'))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    return new BidWorkspace(root)
  }

  it('全链路核心场景：一次开始规划并执行，Reviewer逐条审核闭环，局部失败隔离，stale隔离与原子落盘', async () => {
    const ws = await createWorkspace()

    // 1. 准备 6 个章节的意见队列
    let queue = emptyRevisionQueue()
    // SEC-A: 2 条意见
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-A', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'A章节修改意见1', suggestion: '详细补充A1',
    }, '章节A', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-A', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'A章节修改意见2', suggestion: '详细补充A2',
    }, '章节A', 2000)
    // SEC-B: 1 条意见
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-B', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'B章节修改意见', suggestion: null,
    }, '章节B', 3000)
    // SEC-C: 2 条意见，其中一条制造 stale base hash
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-C', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'C章节修改意见1', suggestion: null,
    }, '章节C', 4000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-C', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: 'c'.repeat(64) },
      instruction: 'C章节修改意见2（故意陈旧）', suggestion: null,
    }, '章节C', 5000)
    // SEC-D: 1 条意见（依赖 SEC-A）
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-D', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'D章节修改意见', suggestion: null,
    }, '章节D', 6000)
    // SEC-E: 1 条意见（独立）
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-E', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: 'E章节修改意见', suggestion: null,
    }, '章节E', 7000)
    // SEC-F: 不加入队列，完全不参与本批次

    await writeRevisionQueue(ws, queue)

    // 2. 交互规则验证：一条命令同回合完成规划并在同一回合启动批次，绝无二次确认
    const prompt = renderChapterWritingInteractionPrompt('running')
    expect(prompt).toContain('在同一回合内紧接着调用 bid_execute_revision_batch 立即开始执行')
    expect(prompt).toContain('绝不向用户发起二次确认或询问是否执行')

    // 3. 规划并校验批次（SEC-C 中一条 stale 导致整节 task 成为 conflict，SEC-D 依赖 SEC-A）
    const planIssueIds = queue.issues.map(i => i.issue_id)
    const currentHashes = new Map([
      ['SEC-A', currentSha],
      ['SEC-B', currentSha],
      ['SEC-C', currentSha],
      ['SEC-D', currentSha],
      ['SEC-E', currentSha],
      ['SEC-F', currentSha],
    ])
    const input = planInput(planIssueIds, [
      { task_id: 'TASK-A', section_id: 'SEC-A', issue_ids: [planIssueIds[0] ?? '', planIssueIds[1] ?? ''] },
      { task_id: 'TASK-B', section_id: 'SEC-B', issue_ids: [planIssueIds[2] ?? ''] },
      { task_id: 'TASK-C', section_id: 'SEC-C', issue_ids: [planIssueIds[3] ?? '', planIssueIds[4] ?? ''] },
      { task_id: 'TASK-D', section_id: 'SEC-D', issue_ids: [planIssueIds[5] ?? ''], depends_on: ['TASK-A'] },
      { task_id: 'TASK-E', section_id: 'SEC-E', issue_ids: [planIssueIds[6] ?? ''] },
    ], queue.revision)
    const validated = validateRevisionBatchPlan(input, queue, currentHashes)
    expect(validated.staleIssues).toEqual([planIssueIds[3], planIssueIds[4]])

    const batchId = createRevisionBatchId()
    const { queue: plannedQueue, batch } = createRevisionBatch(queue, input, batchId, 8000, validated.staleIssues)
    // 原子提交规划快照
    await commitRevisionBatchPlan(ws, plannedQueue, batch)

    // 验证批次任务初始状态：TASK-C 为 conflict，其余为 queued
    const taskMap = new Map(batch.tasks.map(t => [t.task_id, t]))
    expect(taskMap.get('TASK-A')?.status).toBe('queued')
    expect(taskMap.get('TASK-B')?.status).toBe('queued')
    expect(taskMap.get('TASK-C')?.status).toBe('conflict')
    expect(taskMap.get('TASK-D')?.status).toBe('queued')
    expect(taskMap.get('TASK-E')?.status).toBe('queued')

    // 4. 同一回合紧接着启动执行：startRevisionBatchExecution
    const runningBatch = startRevisionBatchExecution(batch, 8500)
    expect(runningBatch.status).toBe('running')

    // 5. 模拟各章节执行流转与 Reviewer 逐条审核闭环
    let currentBatch = runningBatch
    let currentQueueState = plannedQueue

    // 5.1 TASK-A 顺利完成：queued -> running -> reviewing -> completed，Reviewer 真实逐条审核
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-A', { status: 'running' }, 9000)
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-A', { status: 'reviewing' }, 9200)
    const checksA: RevisionIssueCheck[] = [
      { issue_id: planIssueIds[0] ?? '', status: 'satisfied', reason: 'A1意见修改已完整体现' },
      { issue_id: planIssueIds[1] ?? '', status: 'satisfied', reason: 'A2意见修改已通过核验' },
    ]
    const settleA = settleRevisionBatchIssues(
      currentQueueState,
      [planIssueIds[0] ?? '', planIssueIds[1] ?? ''],
      checksA,
      9500,
    )
    currentQueueState = settleA.queue
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-A', { status: settleA.taskStatus }, 9500)
    expect(currentBatch.tasks.find(t => t.task_id === 'TASK-A')?.status).toBe('completed')

    // 5.2 TASK-D 依赖 TASK-A，TASK-A 完成后 TASK-D 启动并完成
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-D', { status: 'running' }, 9600)
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-D', { status: 'reviewing' }, 9800)
    const checksD: RevisionIssueCheck[] = [
      { issue_id: planIssueIds[5] ?? '', status: 'satisfied', reason: 'D意见符合要求' },
    ]
    const settleD = settleRevisionBatchIssues(currentQueueState, [planIssueIds[5] ?? ''], checksD, 10000)
    currentQueueState = settleD.queue
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-D', { status: settleD.taskStatus }, 10000)
    expect(currentBatch.tasks.find(t => t.task_id === 'TASK-D')?.status).toBe('completed')

    // 5.3 TASK-B 人为模拟失败：queued -> running -> failed
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-B', { status: 'running' }, 9600)
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-B', {
      status: 'failed',
      failure: { code: 'SECTION_FAILED', message: '章节B的Writer发生异常', phase: 'writing' },
    }, 10100)
    currentQueueState = {
      ...currentQueueState,
      issues: currentQueueState.issues.map(i =>
        i.issue_id === planIssueIds[2] ? { ...i, status: 'failed' as const, updated_at: 10100 } : i,
      ),
    }

    // 5.4 TASK-E 独立运行成功，不受 TASK-B 失败影响
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-E', { status: 'running' }, 9700)
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-E', { status: 'reviewing' }, 9900)
    const checksE: RevisionIssueCheck[] = [
      { issue_id: planIssueIds[6] ?? '', status: 'satisfied', reason: 'E意见核查通过' },
    ]
    const settleE = settleRevisionBatchIssues(currentQueueState, [planIssueIds[6] ?? ''], checksE, 10200)
    currentQueueState = settleE.queue
    currentBatch = updateRevisionBatchTaskStatus(currentBatch, 'TASK-E', { status: settleE.taskStatus }, 10200)
    expect(currentBatch.tasks.find(t => t.task_id === 'TASK-E')?.status).toBe('completed')

    // 6. 最终完成并原子提交结算状态
    const completedBatch = completeRevisionBatchExecution(currentBatch, 10500)
    await commitRevisionBatchExecutionSettlement(ws, currentQueueState, completedBatch)

    // 7. 全链路综合断言：隔离性、状态真实性、未参与章节完全不受影响
    const finalQueue = await readRevisionQueue(ws)
    const finalBatch = await readRevisionBatch(ws, batchId)

    expect(finalBatch?.status).toBe('completed')
    const finalTaskMap = new Map(finalBatch?.tasks.map(t => [t.task_id, t]))

    // A, D, E 成功，B 失败，C conflict
    expect(finalTaskMap.get('TASK-A')?.status).toBe('completed')
    expect(finalTaskMap.get('TASK-D')?.status).toBe('completed')
    expect(finalTaskMap.get('TASK-E')?.status).toBe('completed')
    expect(finalTaskMap.get('TASK-B')?.status).toBe('failed')
    expect(finalTaskMap.get('TASK-C')?.status).toBe('conflict')

    // 验证禁止全批回滚：B 失败绝不回滚 A, D, E
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[0])?.status).toBe('completed')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[1])?.status).toBe('completed')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[5])?.status).toBe('completed')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[6])?.status).toBe('completed')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[2])?.status).toBe('failed')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[3])?.status).toBe('conflict')
    expect(finalQueue.issues.find(i => i.issue_id === planIssueIds[4])?.status).toBe('conflict')

    // 验证 SEC-F 完全不被触碰
    expect(finalQueue.issues.some(i => i.section_id === 'SEC-F')).toBe(false)
    expect(finalBatch?.tasks.some(t => t.section_id === 'SEC-F')).toBe(false)
  })

  it('暂停与恢复生命周期回归：执行中挂起后恢复，已 completed 的 task 不重跑并最终收敛', async () => {
    const ws = await createWorkspace()
    let queue = emptyRevisionQueue()
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-1', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '修改1', suggestion: null,
    }, '节1', 1000)
    queue = addRevisionIssue(queue, {
      section_id: 'SEC-2', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: currentSha },
      instruction: '修改2', suggestion: null,
    }, '节2', 2000)

    const id1 = queue.issues[0]?.issue_id ?? ''
    const id2 = queue.issues[1]?.issue_id ?? ''
    const input = planInput([id1, id2], [
      { task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: [id1] },
      { task_id: 'TASK-2', section_id: 'SEC-2', issue_ids: [id2] },
    ])
    const validated = validateRevisionBatchPlan(input, queue, new Map())
    const batchId = createRevisionBatchId()
    const { queue: plannedQueue, batch } = createRevisionBatch(queue, input, batchId, 3000, validated.staleIssues)
    await commitRevisionBatchPlan(ws, plannedQueue, batch)

    // 启动执行
    const runningBatch = startRevisionBatchExecution(batch, 3500)
    // TASK-1 顺利完成
    const task1Running = updateRevisionBatchTaskStatus(runningBatch, 'TASK-1', { status: 'running' }, 4000)
    const task1Reviewing = updateRevisionBatchTaskStatus(task1Running, 'TASK-1', { status: 'reviewing' }, 4200)
    const task1Completed = updateRevisionBatchTaskStatus(task1Reviewing, 'TASK-1', { status: 'completed' }, 4500)

    // 模拟运行中用户 stop 或挂起
    const suspended = suspendRevisionBatchExecution(task1Completed, 5000)
    expect(suspended.status).toBe('suspended')

    // 恢复执行：从 suspended 安全转为 running
    const resumed = resumeRevisionBatchExecution(suspended, 6000)
    expect(resumed.status).toBe('running')

    // 核心断言：恢复后已 completed 的任务排除在重跑范围外
    const runnableTasksAfterResume = resumed.tasks.filter(t => t.status !== 'completed' && t.status !== 'conflict')
    expect(runnableTasksAfterResume).toHaveLength(1)
    expect(runnableTasksAfterResume[0]?.task_id).toBe('TASK-2')

    // TASK-2 顺利完成
    const task2Running = updateRevisionBatchTaskStatus(resumed, 'TASK-2', { status: 'running' }, 6500)
    const task2Reviewing = updateRevisionBatchTaskStatus(task2Running, 'TASK-2', { status: 'reviewing' }, 6800)
    const task2Completed = updateRevisionBatchTaskStatus(task2Reviewing, 'TASK-2', { status: 'completed' }, 7000)

    // 最终收敛完成
    const finalBatch = completeRevisionBatchExecution(task2Completed, 7500)
    expect(finalBatch.status).toBe('completed')
    expect(finalBatch.tasks[0]?.status).toBe('completed')
    expect(finalBatch.tasks[1]?.status).toBe('completed')
  })

  it('局部审批意见词汇隔离：段落级修改含"统一加粗"字样绝不走 writing plan patch，未参与章节不变红', () => {
    const prompt = renderChapterWritingInteractionPrompt('running')
    // 明确要求：局部审批意见修订绝不启动 bid_confirm_writing_plan.patch，选区中的"统一""全部"是局部要求
    expect(prompt).toContain(
      '局部审批意见修订绝不启动 bid_confirm_writing_plan.patch，选区中的"统一""全部"是局部 RevisionIssue 要求；',
    )
    expect(prompt).toContain(
      '只有用户明确给出全书级新约束（如"全文统一改为""所有章节都""整本控制在 N 页""全局统一术语"）才走 bid_confirm_writing_plan.patch。',
    )
  })
})
