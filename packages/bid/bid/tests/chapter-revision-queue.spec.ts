import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import {
  addRevisionIssue,
  commitRevisionQueueMutation,
  deleteRevisionIssue,
  emptyRevisionQueue,
  parseRevisionQueueArtifact,
  readRevisionQueue,
  revisionIssueSchema,
  revisionQueueArtifactSchema,
  updateRevisionIssue,
  validateRevisionIssueReference,
  writeRevisionQueue,
  type RevisionIssueReference,
  type RevisionQueueArtifact,
} from '../src/chapter-revision-queue.ts'

const markdown = '# 1 章节\n\n保留首段。\n\n重复段落。\n\n重复段落。\n\n保留末段。\n'

function paragraphReference(text = '重复段落。\n\n重复段落。'): RevisionIssueReference {
  const start = markdown.indexOf(text)
  return { scope: 'paragraphs', base_content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text }
}

function chapterReference(): RevisionIssueReference {
  return { scope: 'chapter', base_content_sha256: chapterContentSha256(markdown) }
}

describe('审批意见队列纯函数', () => {
  it('新建段落级 issue 成功并填充 Host 身份字段', () => {
    const queue = emptyRevisionQueue()
    const next = addRevisionIssue(queue, {
      section_id: 'SEC-1', scope: 'paragraphs', reference: paragraphReference(),
      instruction: '修改重复段落', suggestion: '合并为一段',
    }, '技术方案', 1000)
    expect(next.revision).toBe(1)
    expect(next.issues).toHaveLength(1)
    const issue = next.issues[0]!
    expect(issue.status).toBe('pending')
    expect(issue.batch_id).toBeNull()
    expect(issue.issue_id).toMatch(/^REV-/)
    expect(issue.section_title).toBe('技术方案')
    expect(issue.created_at).toBe(1000)
    expect(issue.updated_at).toBe(1000)
    expect(revisionQueueArtifactSchema.safeParse(next).success).toBe(true)
  })

  it('新建章节级 issue 成功', () => {
    const next = addRevisionIssue(emptyRevisionIssue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '全量重写', suggestion: null,
    }, '技术方案', 0)
    expect(next.issues[0]!.scope).toBe('chapter')
  })

  it('instruction 为空失败', () => {
    expect(() => addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '   ', suggestion: null,
    }, '技术方案', 0)).toThrow()
  })

  it('scope 与 reference.scope 不一致失败', () => {
    expect(() => revisionIssueSchema.parse({
      issue_id: 'REV-1', section_id: 'SEC-1', section_title: 't', scope: 'chapter',
      reference: paragraphReference(), instruction: 'x', suggestion: null,
      status: 'pending', batch_id: null, created_at: 0, updated_at: 0,
    })).toThrow()
  })

  it('pending issue 可以编辑 instruction 和 suggestion', () => {
    let queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '原意见', suggestion: null,
    }, '技术方案', 1000)
    const issueId = queue.issues[0]!.issue_id
    queue = updateRevisionIssue(queue, {
      issue_id: issueId, expected_queue_revision: queue.revision,
      instruction: '新意见', suggestion: '新建议',
    }, 2000)
    expect(queue.issues[0]!.instruction).toBe('新意见')
    expect(queue.issues[0]!.suggestion).toBe('新建议')
    expect(queue.issues[0]!.updated_at).toBe(2000)
    expect(queue.revision).toBe(2)
  })

  it('非 pending issue 不能编辑', () => {
    let queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '原意见', suggestion: null,
    }, '技术方案', 0)
    const issueId = queue.issues[0]!.issue_id
    queue = { ...queue, issues: [{ ...queue.issues[0]!, status: 'scheduled' }] }
    expect(() => updateRevisionIssue(queue, {
      issue_id: issueId, expected_queue_revision: queue.revision, instruction: '新',
    }, 0)).toThrow('BID_REVISION_ISSUE_NOT_EDITABLE')
  })

  it('编辑不存在的 issue 失败', () => {
    expect(() => updateRevisionIssue(emptyRevisionQueue(), {
      issue_id: 'REV-missing', expected_queue_revision: 0, instruction: 'x',
    }, 0)).toThrow('BID_REVISION_ISSUE_NOT_FOUND')
  })

  it('pending issue 可以删除', () => {
    let queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '原意见', suggestion: null,
    }, '技术方案', 0)
    const issueId = queue.issues[0]!.issue_id
    queue = deleteRevisionIssue(queue, { issue_id: issueId, expected_queue_revision: queue.revision })
    expect(queue.issues).toHaveLength(0)
    expect(queue.revision).toBe(2)
  })

  it('非 pending issue 不能删除', () => {
    let queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '原意见', suggestion: null,
    }, '技术方案', 0)
    const issueId = queue.issues[0]!.issue_id
    queue = { ...queue, issues: [{ ...queue.issues[0]!, status: 'completed' }] }
    expect(() => deleteRevisionIssue(queue, { issue_id: issueId, expected_queue_revision: queue.revision }))
      .toThrow('BID_REVISION_ISSUE_NOT_DELETABLE')
  })
})

describe('审批意见引用校验', () => {
  it('接受精确连续段落', () => {
    expect(() => { validateRevisionIssueReference(paragraphReference(), markdown) }).not.toThrow()
  })

  it('接受章节级引用', () => {
    expect(() => { validateRevisionIssueReference(chapterReference(), markdown) }).not.toThrow()
  })

  it('content sha 过期失败', () => {
    const ref = { ...chapterReference(), base_content_sha256: 'a'.repeat(64) }
    expect(() => { validateRevisionIssueReference(ref, markdown) }).toThrow('BID_CHAPTER_REVISION_CONFLICT')
  })

  it('半段选择失败', () => {
    expect(() => { validateRevisionIssueReference(paragraphReference('重复段'), markdown) })
      .toThrow('BID_CHAPTER_REVISION_SELECTION_INVALID')
  })

  it('text 与 start/end 不匹配失败', () => {
    const start = markdown.indexOf('重复段落。')
    const ref: RevisionIssueReference = {
      scope: 'paragraphs', base_content_sha256: chapterContentSha256(markdown),
      start, end: start + '重复段落。'.length, text: '其他文字。',
    }
    expect(() => { validateRevisionIssueReference(ref, markdown) }).toThrow('BID_CHAPTER_REVISION_SELECTION_INVALID')
  })

  it('跨标题非法范围失败', () => {
    const body = '# 标题\n\n首段。\n\n## 子标题\n\n尾段。\n'
    const text = body.slice(body.indexOf('首段。'), body.indexOf('尾段。') + 3)
    const ref: RevisionIssueReference = {
      scope: 'paragraphs', base_content_sha256: chapterContentSha256(body),
      start: body.indexOf('首段。'), end: body.indexOf('尾段。') + 3, text,
    }
    expect(() => { validateRevisionIssueReference(ref, body) }).toThrow('BID_CHAPTER_REVISION_SELECTION_INVALID')
  })
})

describe('审批意见队列持久化', () => {
  const disposals: Array<() => Promise<void>> = []

  afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-revision-queue-'))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    return new BidWorkspace(root)
  }

  it('文件不存在时返回空队列', async () => {
    const ws = await workspace()
    const queue = await readRevisionQueue(ws)
    expect(queue).toEqual(emptyRevisionQueue())
  })

  it('写入后重新读取内容不丢失', async () => {
    const ws = await workspace()
    const queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '意见', suggestion: null,
    }, '技术方案', 1000)
    await writeRevisionQueue(ws, queue)
    const reloaded = await readRevisionQueue(ws)
    expect(reloaded).toEqual(queue)
  })

  it('CAS 冲突时抛 BID_REVISION_QUEUE_CONFLICT', async () => {
    const ws = await workspace()
    const queue = addRevisionIssue(emptyRevisionQueue(), {
      section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(),
      instruction: '意见', suggestion: null,
    }, '技术方案', 1000)
    await writeRevisionQueue(ws, queue)
    await expect(commitRevisionQueueMutation(ws, 999, current => current))
      .rejects.toThrow('BID_REVISION_QUEUE_CONFLICT')
  })

  it('commitRevisionQueueMutation 原子递增 revision', async () => {
    const ws = await workspace()
    const first = await commitRevisionQueueMutation(ws, undefined, () => addRevisionIssue(
      emptyRevisionQueue(),
      { section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(), instruction: '一', suggestion: null },
      '技术方案', 1000,
    ))
    expect(first.revision).toBe(1)
    const second = await commitRevisionQueueMutation(ws, 1, current => addRevisionIssue(
      current,
      { section_id: 'SEC-1', scope: 'chapter', reference: chapterReference(), instruction: '二', suggestion: null },
      '技术方案', 2000,
    ))
    expect(second.revision).toBe(2)
    expect(second.issues).toHaveLength(2)
    const reloaded = await readRevisionQueue(ws)
    expect(reloaded).toEqual(second)
  })

  it('解析保留合法版本并回退非法 schema_version', async () => {
    expect(parseRevisionQueueArtifact({ schema_version: 0, revision: 0, issues: [] }).schema_version).toBe(1)
    expect(parseRevisionQueueArtifact({ revision: 0, issues: [] }).schema_version).toBe(1)
    expect(parseRevisionQueueArtifact({ schema_version: 'old', revision: 0, issues: [] }).schema_version).toBe(1)
  })
})

function emptyRevisionIssue(): RevisionQueueArtifact {
  return emptyRevisionQueue()
}
