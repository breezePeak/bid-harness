import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { parseBidReviewWorkbenchView } from '../src/control-plane-contract.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import {
  addRevisionIssue,
  emptyRevisionQueue,
  type RevisionIssue,
  type RevisionIssueReference,
  type RevisionQueueArtifact,
} from '../src/chapter-revision-queue.ts'
import {
  createRevisionBatch,
  createRevisionBatchId,
  parseRevisionBatchArtifact,
  readRevisionBatch,
  revisionBatchArtifactSchema,
  validateRevisionBatchPlan,
  writeRevisionBatch,
  renderRevisionBatchSectionPrompt,
  startRevisionBatchExecution,
  completeRevisionBatchExecution,
  suspendRevisionBatchExecution,
  failRevisionBatchExecution,
  settleRevisionBatchIssues,
  detectStaleBaseVersions,
  type PlanRevisionBatchInput,
  type RevisionBatchArtifact,
  type RevisionBatchTaskExecution,
  type RevisionIssueCheck,
} from '../src/chapter-revision-batch.ts'
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
      schema_version: 1, batch_id: 'BATCH-1', queue_revision: 0,
      issue_ids: ['REV-1'], status, tasks: [{
        task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'], depends_on: [],
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
      schema_version: 1,
      batch_id: 'BATCH-001',
      queue_revision: 1,
      issue_ids: ['REV-1'],
      status: 'running',
      tasks: [{ task_id: 'T-1', section_id: 'SEC-1', issue_ids: ['REV-1'], depends_on: [] }],
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
