import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BidWorkspace } from './index.ts'
import {
  BOOK_REVIEW_SCHEMA_VERSION,
  DETAILED_REVIEW_NOT_IMPLEMENTED,
  STRUCTURED_RESPONSE_POINT_COVERAGE_ONLY,
  chapterContentSha256,
  parseBookReviewReport,
} from './book-review-artifacts.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** Deterministically prepare the S7 framework report without an LLM review. */
export async function executeBookReview(workspace: BidWorkspace, task: BidStageTask): Promise<StageArtifact[]> {
  if (task.stage !== 'book_review') throw new Error('book-review-executor-stage-invalid')
  const manifestPath = join(workspace.sessionRoot, 'chapters/manifest.json')
  await assertNoLinkedPath(workspace.root, manifestPath)
  const manifest = parseChapterWritingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  const [outline, catalog] = await Promise.all([
    readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8').then(value => parseOutlineArtifact(JSON.parse(value))),
    readFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), 'utf8').then(value => parseScoringResponsePointCatalog(JSON.parse(value))),
  ])
  const chapters = await Promise.all(manifest.chapters.map(async (chapter) => {
    const content = join(workspace.sessionRoot, chapter.content_path)
    await assertNoLinkedPath(workspace.root, content)
    return {
      section_id: chapter.section_id,
      content_path: chapter.content_path,
      content_sha256: chapterContentSha256(await readFile(content, 'utf8')),
      status: 'not_evaluated' as const,
      issue_ids: [],
    }
  }))
  const responsePointCoverage = outline.sections.flatMap(section => (section.scoring_response_point_ids ?? []).map((id) => {
    const point = catalog.points.find(candidate => candidate.id === id)
    if (point === undefined) throw new Error(`unknown confirmed-outline response point ${id}`)
    const declarations = manifest.chapters.filter(chapter => chapter.covered_scoring_response_points.some(
      value => value.scoring_id === point.scoring_id && value.response_point === point.text,
    ))
    const expected = manifest.chapters.find(chapter => chapter.section_id === section.id)
    const status = declarations.length === 0 ? 'missing' : declarations.length > 1 ? 'duplicate'
      : declarations[0]?.section_id !== expected?.section_id ? 'mismatch' : 'covered'
    return { response_point_id: id, scoring_id: point.scoring_id, text: point.text, section_id: section.id, status }
  }))
  const coverageIssues = responsePointCoverage.filter(item => item.status !== 'covered').map((item, index) => ({
    issue_id: `RP-COVERAGE-${String(index + 1).padStart(4, '0')}`,
    section_id: item.section_id,
    category: 'response_point_coverage',
    severity: 'blocking' as const,
    status: 'open' as const,
    title: `评分响应点${item.status}`,
    detail: `${item.response_point_id} 的结构化章节声明为 ${item.status}。`,
    suggestion: '修正章节 Metadata 的 scoring_id 与 response_point 声明。',
  }))
  const reviewedChapters = chapters.map(chapter => ({
    ...chapter,
    issue_ids: coverageIssues.filter(issue => issue.section_id === chapter.section_id).map(issue => issue.issue_id),
  }))
  const report = parseBookReviewReport({
    schema_version: BOOK_REVIEW_SCHEMA_VERSION,
    scope: 'technical_bid',
    review_mode: 'framework_only',
    quality_gate: 'not_evaluated',
    confirmed_outline_sha256: manifest.confirmed_outline_sha256,
    chapters: reviewedChapters,
    response_point_coverage: responsePointCoverage,
    issues: coverageIssues,
    summary: {
      chapter_count: reviewedChapters.length,
      evaluated_chapter_count: 0,
      issue_count: coverageIssues.length,
      blocking_issue_count: coverageIssues.length,
    },
    limitations: [DETAILED_REVIEW_NOT_IMPLEMENTED, STRUCTURED_RESPONSE_POINT_COVERAGE_ONLY],
  })
  const reviewRoot = join(workspace.sessionRoot, 'review')
  await assertNoLinkedPath(workspace.root, reviewRoot)
  await rm(reviewRoot, { recursive: true, force: true })
  await mkdir(reviewRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(reviewRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return [{ stage: 'book_review', type: 'book_review_report', path: 'review/report.json' }]
}
