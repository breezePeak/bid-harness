import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  buildBidStageTask,
  executeBookReview,
  parseChapterWritingManifest,
  parseBookReviewReport,
  parseConfirmedOutlineArtifact,
  validateBookReview,
} from '@deepseek-ai/dsh-bid'

async function setup(): Promise<BidWorkspace> {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-book-review-')), 'session')
  await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), '正文\n')
  await writeFile(join(workspace.sessionRoot, 'chapters/manifest.json'), `${JSON.stringify({ schema_version: 4, scope: 'technical_bid', confirmed_outline_sha256: 'a'.repeat(64), chapters: [{ section_id: 'SEC-1', content_path: 'chapters/sections/0001.md', requirement_ids: [], scoring_ids: ['S-1'], compliance_ids: [], covered_must_answer: ['说明架构。'], covered_scoring_response_point_ids: ['RP-000001'], covered_scoring_response_points: [{ scoring_id: 'S-1', response_point: '说明总体技术架构' }], assigned_source_mapping_ids: [], source_mapping_usage: [], source_mapping_ids_used: [], evidence_used: [], additional_materials: [], external_evidence_used: [], additional_external_materials: [], unresolved_topics: [], handoff: { section_id: 'SEC-1', decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] }, review_path: 'chapters/reviews/0001.json', review_sha256: 'a'.repeat(64) }] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), `${JSON.stringify({ schema_version: 2, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '总体技术架构', purpose: '说明架构。', writable: true, must_answer: ['说明架构。'], requirement_ids: [], scoring_ids: ['S-1'], compliance_ids: [], origin: 'generated', content_mode: 'write_new', source_mapping_ids: [], scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'S-1', response_point: '说明总体技术架构' }], suggested_tables: [], suggested_figures: [], writing_notes: [] }] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), `${JSON.stringify({ schema_version: 1, scope: 'technical_bid', scoring_sha256: 'b'.repeat(64), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'S-1', order: 1, text: '说明总体技术架构' }] })}\n`)
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
    const report = parseBookReviewReport(JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8')))
    report.issues.push({ issue_id: 'ISSUE-1', section_id: 'SEC-1', category: 'content', severity: 'warning', status: 'open', title: 'invented', detail: 'invented', suggestion: 'invented' })
    report.chapters[0]!.issue_ids.push('ISSUE-1')
    report.summary.issue_count = 1
    await writeFile(join(workspace.sessionRoot, 'review/report.json'), `${JSON.stringify(report)}\n`)
    const validation = await validateBookReview(workspace, 'book_review', artifacts)
    expect(validation.ok).toBe(false)
    if (validation.ok) throw new Error('Expected S7 validation failure')
    expect(validation.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_FAKE_AUDIT')
  })

  it('rejects a missing report, an invalid artifact reference, and duplicate chapters', async () => {
    const workspace = await setup()
    const artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    await rm(join(workspace.sessionRoot, 'review/report.json'))
    const missing = await validateBookReview(workspace, 'book_review', artifacts)
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('Expected missing S7 report failure')
    expect(missing.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_ARTIFACT_INVALID')
    await executeBookReview(workspace, buildBidStageTask('book_review'))
    const invalidReference = await validateBookReview(
      workspace,
      'book_review',
      [{ stage: 'book_review', type: 'book_review_report', path: 'review/other.json' }],
    )
    expect(invalidReference.ok).toBe(false)
    if (invalidReference.ok) throw new Error('Expected invalid S7 Artifact reference failure')
    expect(invalidReference.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_ARTIFACT_SET_INVALID')
    const report = parseBookReviewReport(JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8')))
    report.chapters.push(report.chapters[0]!)
    report.summary.chapter_count = 2
    await writeFile(join(workspace.sessionRoot, 'review/report.json'), `${JSON.stringify(report)}\n`)
    const duplicate = await validateBookReview(workspace, 'book_review', artifacts)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) throw new Error('Expected duplicate S7 chapter failure')
    expect(duplicate.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_SECTION_DUPLICATE')
  })

  it('reports missing and unknown S6 text declarations without claiming semantic review', async () => {
    const workspace = await setup()
    const manifestPath = join(workspace.sessionRoot, 'chapters/manifest.json')
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    manifest.chapters[0]!.covered_scoring_response_point_ids = []
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    let artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    const report = parseBookReviewReport(JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8')))
    expect(report.response_point_coverage).toEqual([expect.objectContaining({ response_point_id: 'RP-000001', status: 'missing' })])
    expect(report.summary.blocking_issue_count).toBe(1)
    expect(report.limitations).toEqual(expect.arrayContaining(['DETAILED_REVIEW_NOT_IMPLEMENTED', 'STRUCTURED_RESPONSE_POINT_COVERAGE_ONLY']))
    manifest.chapters[0]!.covered_scoring_response_point_ids = ['RP-999999']
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    const mismatch = await validateBookReview(workspace, 'book_review', artifacts)
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) throw new Error('Expected response-point mismatch')
    expect(mismatch.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_RESPONSE_POINT_MISMATCH')
  })

  it('detects duplicate declarations and an outline id absent from the catalog', async () => {
    const workspace = await setup()
    const manifestPath = join(workspace.sessionRoot, 'chapters/manifest.json')
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    await writeFile(join(workspace.sessionRoot, 'chapters/sections/0002.md'), '重复声明\n')
    manifest.chapters.push({ ...manifest.chapters[0]!, section_id: 'SEC-2', content_path: 'chapters/sections/0002.md' })
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    const artifacts = await executeBookReview(workspace, buildBidStageTask('book_review'))
    const report = parseBookReviewReport(JSON.parse(await readFile(join(workspace.sessionRoot, 'review/report.json'), 'utf8')))
    expect(report.response_point_coverage).toEqual([expect.objectContaining({ response_point_id: 'RP-000001', status: 'duplicate' })])
    const outlinePath = join(workspace.sessionRoot, 'outline/confirmed-outline.json')
    const outline = parseConfirmedOutlineArtifact(JSON.parse(await readFile(outlinePath, 'utf8')))
    outline.sections[0]!.scoring_response_point_ids = ['RP-999999']
    await writeFile(outlinePath, `${JSON.stringify(outline)}\n`)
    const unknown = await validateBookReview(workspace, 'book_review', artifacts)
    expect(unknown.ok).toBe(false)
    if (unknown.ok) throw new Error('Expected unknown outline response-point failure')
    expect(unknown.issues.map(issue => issue.code)).toContain('BOOK_REVIEW_OUTLINE_RESPONSE_POINT_UNKNOWN')
  })
})
