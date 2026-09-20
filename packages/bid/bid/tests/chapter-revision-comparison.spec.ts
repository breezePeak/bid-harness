import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertRevisionComparisonEquivalent,
  buildRevisionComparisonPath,
  createRevisionComparisonArtifact,
  parseRevisionComparisonArtifact,
  readRevisionComparison,
} from '../src/chapter-revision-comparison.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function artifact() {
  return createRevisionComparisonArtifact({
    batchId: 'BATCH-1', taskId: 'TASK-1', sectionId: 'SEC-1', issueIds: ['ISSUE-1', 'ISSUE-2'],
    beforeMarkdown: '# 标题\n\n旧正文\n', afterMarkdown: '# 标题\n\n新正文\n', createdAt: 1,
  })
}

describe('chapter revision comparison', () => {
  it('builds a Host-owned path and verifies both markdown hashes', () => {
    const value = artifact()
    expect(buildRevisionComparisonPath(value.batch_id, value.task_id)).toBe('chapters/revisions/comparisons/BATCH-1/TASK-1.json')
    expect(parseRevisionComparisonArtifact(value)).toEqual(value)
    expect(() => parseRevisionComparisonArtifact({ ...value, after_markdown: 'tampered' })).toThrow('BID_REVISION_COMPARISON_CORRUPT')
    expect(() => buildRevisionComparisonPath('../outside', 'TASK-1')).toThrow()
  })

  it('accepts an idempotent retry and rejects a different snapshot for the same task', () => {
    const value = artifact()
    expect(() => assertRevisionComparisonEquivalent(value, { ...value, created_at: 2 })).not.toThrow()
    expect(() => assertRevisionComparisonEquivalent(value, createRevisionComparisonArtifact({
      batchId: 'BATCH-1', taskId: 'TASK-1', sectionId: 'SEC-1', issueIds: ['ISSUE-1', 'ISSUE-2'],
      beforeMarkdown: value.before_markdown, afterMarkdown: 'different', createdAt: 2,
    }))).toThrow('BID_REVISION_COMPARISON_CONFLICT')
  })

  it('reads one exact batch task and treats a missing legacy snapshot as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-comparison-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    const value = artifact()
    const path = join(projectRoot, buildRevisionComparisonPath(value.batch_id, value.task_id))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(value)}\n`)
    const workspace = { root, projectRoot }
    await expect(readRevisionComparison(workspace, 'BATCH-1', 'TASK-1')).resolves.toEqual(value)
    await expect(readRevisionComparison(workspace, 'BATCH-1', 'TASK-MISSING')).resolves.toBeNull()
  })
})
