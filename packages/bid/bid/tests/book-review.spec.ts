import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  buildBidStageTask,
  executeBookReview,
  parseBookReviewReport,
  validateBookReview,
} from '@deepseek-ai/dsh-bid'

async function setup(): Promise<BidWorkspace> {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-book-review-')), 'session')
  await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), '正文\n')
  await writeFile(join(workspace.sessionRoot, 'chapters/manifest.json'), `${JSON.stringify({ schema_version: 2, scope: 'technical_bid', confirmed_outline_sha256: 'a'.repeat(64), chapters: [{ section_id: 'SEC-1', content_path: 'chapters/sections/0001.md', requirement_ids: [], scoring_ids: [], compliance_ids: [], covered_must_answer: [], evidence_used: [], additional_materials: [], external_evidence_used: [], additional_external_materials: [], unresolved_topics: [] }] })}\n`)
  return workspace
}

describe('book-review executor and validator', () => {
  it('creates a framework-only report and detects changed chapter content', async () => {
    const workspace = await setup()
    const artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    const report = parseBookReviewReport(JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8')))
    expect(report.review_mode).toBe('framework_only')
    await expect(validateBookReview(workspace, 'book_review', artifacts)).resolves.toEqual({ ok: true })
    await writeFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), '已修改\n')
    await expect(validateBookReview(workspace, 'book_review', artifacts)).resolves.toMatchObject({ ok: false })
  })

  it('rejects invented detailed findings in a framework-only report', async () => {
    const workspace = await setup()
    const artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    const report = JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8'))
    report.issues.push({ issue_id: 'ISSUE-1', section_id: 'SEC-1', category: 'content', severity: 'warning', status: 'open', title: 'invented', detail: 'invented', suggestion: 'invented' })
    report.chapters[0].issue_ids.push('ISSUE-1')
    report.summary.issue_count = 1
    await writeFile(join(workspace.sessionRoot, 'review/report.json'), `${JSON.stringify(report)}\n`)
    await expect(validateBookReview(workspace, 'book_review', artifacts)).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'BOOK_REVIEW_FAKE_AUDIT' })]),
    })
  })

  it('rejects a missing report, an invalid artifact reference, and duplicate chapters', async () => {
    const workspace = await setup()
    const artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    await rm(join(workspace.sessionRoot, 'review/report.json'))
    await expect(validateBookReview(workspace, 'book_review', artifacts)).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'BOOK_REVIEW_ARTIFACT_INVALID' })]),
    })
    await executeBookReview(workspace, buildBidStageTask('book_review'))
    await expect(validateBookReview(workspace, 'book_review', [{ stage: 'book_review', type: 'book_review_report', path: 'review/other.json' }])).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'BOOK_REVIEW_ARTIFACT_SET_INVALID' })]),
    })
    const report = JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8'))
    report.chapters.push({ ...report.chapters[0] })
    report.summary.chapter_count = 2
    await writeFile(join(workspace.sessionRoot, 'review/report.json'), `${JSON.stringify(report)}\n`)
    await expect(validateBookReview(workspace, 'book_review', artifacts)).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'BOOK_REVIEW_SECTION_DUPLICATE' })]),
    })
  })
})
