import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BidWorkspace } from './index.ts'
import { BOOK_REVIEW_SCHEMA_VERSION, DETAILED_REVIEW_NOT_IMPLEMENTED, chapterContentSha256, parseBookReviewReport } from './book-review-artifacts.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** Deterministically prepare the S7 framework report without an LLM review. */
export async function executeBookReview(workspace: BidWorkspace, task: BidStageTask): Promise<StageArtifact[]> {
  if (task.stage !== 'book_review') throw new Error('book-review-executor-stage-invalid')
  const manifestPath = join(workspace.sessionRoot, 'chapters/manifest.json')
  await assertNoLinkedPath(workspace.root, manifestPath)
  const manifest = parseChapterWritingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
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
  const report = parseBookReviewReport({
    schema_version: BOOK_REVIEW_SCHEMA_VERSION,
    scope: 'technical_bid',
    review_mode: 'framework_only',
    quality_gate: 'not_evaluated',
    confirmed_outline_sha256: manifest.confirmed_outline_sha256,
    chapters,
    issues: [],
    summary: { chapter_count: chapters.length, evaluated_chapter_count: 0, issue_count: 0, blocking_issue_count: 0 },
    limitations: [DETAILED_REVIEW_NOT_IMPLEMENTED],
  })
  const reviewRoot = join(workspace.sessionRoot, 'review')
  await assertNoLinkedPath(workspace.root, reviewRoot)
  await rm(reviewRoot, { recursive: true, force: true })
  await mkdir(reviewRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(reviewRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return [{ stage: 'book_review', type: 'book_review_report', path: 'review/report.json' }]
}
