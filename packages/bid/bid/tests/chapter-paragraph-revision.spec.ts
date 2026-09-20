import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { RevisionBatchTaskExecution } from '../src/chapter-revision-batch.ts'
import {
  applyParagraphRevisionReplacements,
  buildParagraphRevisionSegments,
} from '../src/chapter-paragraph-revision.ts'
import {
  paragraphRevisionWriterOutputSchema,
  renderParagraphRevisionRepairTask,
  renderParagraphRevisionWriterTask,
} from '../src/chapter-paragraph-revision-child.ts'
import { renderParagraphRevisionReviewerTask } from '../src/chapter-paragraph-revision-review.ts'
import {
  buildParagraphRevisionReviewPath,
  createParagraphRevisionReviewArtifact,
} from '../src/chapter-paragraph-revision-artifacts.ts'
import {
  appendSemanticRevision,
  buildChapterRevisionLineagePath,
  resolveSemanticRevisionPath,
} from '../src/chapter-revision-lineage.ts'
import {
  buildRevisionComparisonPath,
  createRevisionComparisonArtifact,
} from '../src/chapter-revision-comparison.ts'
import { isParagraphOnlyRevisionTask, runParagraphRevisionScheduler } from '../src/chapter-paragraph-revision-executor.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function paragraphTask(markdown: string, selections: Array<{ text: string; instruction?: string }>): RevisionBatchTaskExecution {
  return {
    task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: selections.map((_, i) => `ISSUE-${i + 1}`), depends_on: [],
    issues: selections.map((selection, index) => {
      const start = markdown.indexOf(selection.text)
      return {
        issue_id: `ISSUE-${index + 1}`, instruction: selection.instruction ?? '写得自然一些', suggestion: null,
        scope: 'paragraphs' as const, reference_text: selection.text, start, end: start + selection.text.length,
      }
    }),
  }
}

describe('paragraph revision range and prompts', () => {
  it('merges adjacent selections and changes only authorized bytes', () => {
    const markdown = '# 标题\n\nA\n\nB\n\nC\n\nD\n'
    const task = paragraphTask(markdown, [{ text: 'B' }, { text: 'C' }])
    const segments = buildParagraphRevisionSegments(markdown, task)
    expect(segments).toHaveLength(2)
    const revised = applyParagraphRevisionReplacements(markdown, segments, [
      { segment_id: 'SEG-001', markdown: 'B2' },
      { segment_id: 'SEG-002', markdown: 'C2' },
    ])
    expect(revised).toBe('# 标题\n\nA\n\nB2\n\nC2\n\nD\n')
  })

  it('rejects incomplete, duplicate and unknown replacements', () => {
    const markdown = 'A\n\nB\n\nC'
    const segments = buildParagraphRevisionSegments(markdown, paragraphTask(markdown, [{ text: 'B' }]))
    expect(() => applyParagraphRevisionReplacements(markdown, segments, [])).toThrow('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
    expect(() => applyParagraphRevisionReplacements(markdown, segments, [
      { segment_id: 'UNKNOWN', markdown: 'B2' },
    ])).toThrow('BID_PARAGRAPH_REVISION_REPLACEMENTS_INVALID')
  })

  it('keeps Writer and Reviewer prompts delta-only and omits metadata from output schema', () => {
    const markdown = '# 标题\n\nA\n\nB\n\nC'
    const segments = buildParagraphRevisionSegments(markdown, paragraphTask(markdown, [{ text: 'B' }]))
    const prompt = renderParagraphRevisionWriterTask({ sectionId: 'SEC-1', title: '标题', segments })
    for (const forbidden of ['Current Chapter Blueprint', 'Relevant Requirements', 'Evidence Pack', 'Review Checklist', '当前完整正文', 'Writer Candidate']) {
      expect(prompt).not.toContain(forbidden)
    }
    expect(prompt).toContain('SEG-001')
    expect(prompt).toContain('original_text')
    expect(prompt).toContain('readonly_before')
    expect(prompt).toContain('readonly_after')
    expect(prompt).toContain('instruction')
    expect(paragraphRevisionWriterOutputSchema.safeParse({ replacements: [{ segment_id: 'SEG-001', markdown: 'B2' }], metadata: {} }).success).toBe(false)
    expect(renderParagraphRevisionReviewerTask({
      title: '标题', segments, replacements: [{ segment_id: 'SEG-001', markdown: 'B2' }],
    })).not.toContain('Evidence Pack')
    expect(renderParagraphRevisionRepairTask({
      segments, replacements: [{ segment_id: 'SEG-001', markdown: 'B2' }],
      instructions: [{ segment_id: 'SEG-001', instruction: '减少排比' }],
    })).not.toContain(markdown)
  })
})

describe('semantic revision lineage', () => {
  it('validates two continuous semantic-preserved revisions and rejects a broken chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-paragraph-lineage-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    const workspace = { root, projectRoot }
    await mkdir(projectRoot, { recursive: true })
    let lineage = null
    const revisions = [
      { batch: 'B1', task: 'T1', before: 'H0', after: 'H1' },
      { batch: 'B2', task: 'T2', before: 'H1', after: 'H2' },
    ]
    let previous = '# 标题\n\n原文'
    const baseHash = createRevisionComparisonArtifact({
      batchId: 'B0', taskId: 'T0', sectionId: 'SEC-1', issueIds: ['I0'],
      beforeMarkdown: previous, afterMarkdown: previous, createdAt: 1,
    }).before_sha256
    let lastHash = baseHash
    for (const [index, item] of revisions.entries()) {
      const next = `${previous}${index + 1}`
      const comparison = createRevisionComparisonArtifact({
        batchId: item.batch, taskId: item.task, sectionId: 'SEC-1', issueIds: [`I${index + 1}`],
        beforeMarkdown: previous, afterMarkdown: next, createdAt: index + 2,
      })
      lineage = appendSemanticRevision(lineage, {
        sectionId: 'SEC-1', baseReviewCandidateSha256: baseHash, batchId: item.batch, taskId: item.task,
        beforeSha256: comparison.before_sha256, afterSha256: comparison.after_sha256,
      })
      const review = createParagraphRevisionReviewArtifact({
        batch_id: item.batch, task_id: item.task, section_id: 'SEC-1', issue_ids: [`I${index + 1}`],
        before_sha256: comparison.before_sha256, after_sha256: comparison.after_sha256,
        writer_child_session_id: 'writer', reviewer_child_session_id: 'reviewer',
        issue_checks: [{ issue_id: `I${index + 1}`, status: 'satisfied', reason: '已满足' }], created_at: index + 2,
      })
      const comparisonPath = join(projectRoot, buildRevisionComparisonPath(item.batch, item.task))
      const reviewPath = join(projectRoot, buildParagraphRevisionReviewPath(item.batch, item.task))
      await mkdir(join(comparisonPath, '..'), { recursive: true })
      await mkdir(join(reviewPath, '..'), { recursive: true })
      await writeFile(comparisonPath, JSON.stringify(comparison))
      await writeFile(reviewPath, JSON.stringify(review))
      previous = next
      lastHash = comparison.after_sha256
    }
    const lineagePath = join(projectRoot, buildChapterRevisionLineagePath('0001'))
    await mkdir(join(lineagePath, '..'), { recursive: true })
    await writeFile(lineagePath, JSON.stringify(lineage))
    expect(await resolveSemanticRevisionPath(workspace, '0001', 'SEC-1', baseHash, lastHash)).toMatchObject({
      valid: true, from_markdown: '# 标题\n\n原文', entries: [{ batch_id: 'B1' }, { batch_id: 'B2' }],
    })
    expect((await resolveSemanticRevisionPath(workspace, '0001', 'SEC-1', 'f'.repeat(64), lastHash)).valid).toBe(false)
    if (lineage === null) throw new Error('lineage missing')
    await writeFile(lineagePath, JSON.stringify({
      ...lineage,
      revisions: lineage.revisions.map((entry, index) => index === 1 ? { ...entry, before_sha256: 'f'.repeat(64) } : entry),
    }))
    expect((await resolveSemanticRevisionPath(workspace, '0001', 'SEC-1', baseHash, lastHash)).valid).toBe(false)
  })
})

describe('paragraph revision scheduler', () => {
  it('routes only by issue scope, not natural-language breadth', () => {
    const task = paragraphTask('A\n\nB', [{ text: 'A', instruction: '把整体和每一段都改写' }])
    expect(isParagraphOnlyRevisionTask(task)).toBe(true)
    expect(isParagraphOnlyRevisionTask({
      ...task,
      issues: [{ ...task.issues[0]!, scope: 'chapter', reference_text: null, start: null, end: null }],
    })).toBe(false)
  })

  it('waits for the current wave before running a full-review fallback', async () => {
    const events: string[] = []
    const first = paragraphTask('A\n\nB', [{ text: 'A' }])
    const second = { ...paragraphTask('C\n\nD', [{ text: 'C' }]), task_id: 'TASK-2', section_id: 'SEC-2' }
    const results = await runParagraphRevisionScheduler({
      tasks: [{ task: first, value: undefined }, { task: second, value: undefined }],
      maxConcurrency: 2,
      async run(item) {
        events.push(`run:${item.task.task_id}`)
        await Promise.resolve()
        events.push(`settled:${item.task.task_id}`)
        return item.task.task_id === 'TASK-1' ? { status: 'full_review' } : { status: 'completed' }
      },
      async fallback(item) {
        events.push(`fallback:${item.task.task_id}`)
        return { status: 'completed' }
      },
    })
    expect(events.indexOf('fallback:TASK-1')).toBeGreaterThan(events.indexOf('settled:TASK-2'))
    expect(results.get('TASK-1')).toEqual({ status: 'completed' })
    expect(results.get('TASK-2')).toEqual({ status: 'completed' })
  })
})
