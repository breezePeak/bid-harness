import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import {
  DETAILED_REVIEW_NOT_IMPLEMENTED,
  chapterContentSha256,
  parseBookReviewReport,
} from './book-review-artifacts.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const REPORT = 'review/report.json'

function reject(
  issues: StageValidationIssue[],
  code: string,
  message: string,
  artifact = REPORT,
): void { issues.push({ code, message, artifact }) }

/** Validate report identity, all chapter paths and hashes, and framework-only semantics. */
export async function validateBookReview(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'book_review') reject(issues, 'BOOK_REVIEW_STAGE_INVALID', 'The book-review validator only accepts book_review.')
  if (artifacts.length !== 1 || artifacts[0]?.stage !== 'book_review' || artifacts[0]?.type !== 'book_review_report' || artifacts[0]?.path !== REPORT) reject(issues, 'BOOK_REVIEW_ARTIFACT_SET_INVALID', 'The executor must return review/report.json exactly once.')
  let report: ReturnType<typeof parseBookReviewReport>
  let manifest: ReturnType<typeof parseChapterWritingManifest>
  try {
    const reportPath = within(workspace.sessionRoot, REPORT)
    const manifestPath = within(workspace.sessionRoot, 'chapters/manifest.json')
    await Promise.all([assertNoLinkedPath(workspace.root, reportPath), assertNoLinkedPath(workspace.root, manifestPath)])
    const [reportRaw, manifestRaw] = await Promise.all([readFile(reportPath, 'utf8'), readFile(manifestPath, 'utf8')])
    report = parseBookReviewReport(JSON.parse(reportRaw))
    manifest = parseChapterWritingManifest(JSON.parse(manifestRaw))
  } catch {
    reject(issues, 'BOOK_REVIEW_ARTIFACT_INVALID', 'The review report or chapter manifest is missing or invalid.')
    return { ok: false, issues }
  }
  if (report.confirmed_outline_sha256 !== manifest.confirmed_outline_sha256) reject(issues, 'BOOK_REVIEW_OUTLINE_HASH_INVALID', 'The report does not match the confirmed outline.')
  const expected = new Map(manifest.chapters.map(chapter => [chapter.section_id, chapter]))
  const seen = new Set<string>()
  for (const chapter of report.chapters) {
    if (seen.has(chapter.section_id)) reject(issues, 'BOOK_REVIEW_SECTION_DUPLICATE', 'The report contains a duplicate chapter.')
    seen.add(chapter.section_id)
    const source = expected.get(chapter.section_id)
    if (source === undefined) { reject(issues, 'BOOK_REVIEW_SECTION_UNKNOWN', 'The report references an unknown chapter.'); continue }
    if (chapter.content_path !== source.content_path) reject(issues, 'BOOK_REVIEW_CONTENT_PATH_INVALID', 'The report content path does not match the chapter manifest.')
    try {
      const content = within(workspace.sessionRoot, chapter.content_path)
      await assertNoLinkedPath(workspace.root, content)
      if (!(await lstat(content)).isFile()) throw new Error('not-file')
      if (chapter.content_sha256 !== chapterContentSha256(await readFile(content, 'utf8'))) reject(issues, 'BOOK_REVIEW_CONTENT_CHANGED', 'The chapter body differs from the reviewed content.')
    } catch { reject(issues, 'BOOK_REVIEW_CONTENT_INVALID', 'A reviewed chapter body is missing or linked.') }
  }
  for (const id of expected.keys()) if (!seen.has(id)) reject(issues, 'BOOK_REVIEW_SECTION_MISSING', 'The report omits a chapter.')
  const issuesById = new Map<string, (typeof report.issues)[number]>()
  for (const issue of report.issues) {
    if (issuesById.has(issue.issue_id)) reject(issues, 'BOOK_REVIEW_ISSUE_DUPLICATE', 'The report contains a duplicate issue id.')
    issuesById.set(issue.issue_id, issue)
    if (!expected.has(issue.section_id)) reject(issues, 'BOOK_REVIEW_ISSUE_SECTION_UNKNOWN', 'An issue references an unknown chapter.')
  }
  const referencedIssueIds = new Set<string>()
  for (const chapter of report.chapters) {
    for (const issueId of chapter.issue_ids) {
      if (referencedIssueIds.has(`${chapter.section_id}:${issueId}`)) reject(issues, 'BOOK_REVIEW_CHAPTER_ISSUE_DUPLICATE', 'A chapter lists an issue more than once.')
      referencedIssueIds.add(`${chapter.section_id}:${issueId}`)
      const issue = issuesById.get(issueId)
      if (issue === undefined) reject(issues, 'BOOK_REVIEW_CHAPTER_ISSUE_UNKNOWN', 'A chapter lists an issue absent from the report.')
      else if (issue.section_id !== chapter.section_id) reject(issues, 'BOOK_REVIEW_CHAPTER_ISSUE_MISMATCH', 'A chapter lists an issue belonging to another chapter.')
    }
  }
  for (const issue of report.issues) if (!referencedIssueIds.has(`${issue.section_id}:${issue.issue_id}`)) reject(issues, 'BOOK_REVIEW_ISSUE_UNREFERENCED', 'A report issue is not listed by its chapter.')
  if (report.issues.length > 0 || report.chapters.some(chapter => chapter.issue_ids.length > 0)) reject(issues, 'BOOK_REVIEW_FAKE_AUDIT', 'framework_only reports must not claim detailed review findings.')
  if (report.summary.chapter_count !== report.chapters.length || report.summary.issue_count !== report.issues.length || report.summary.blocking_issue_count !== report.issues.filter(issue => issue.severity === 'blocking').length) reject(issues, 'BOOK_REVIEW_SUMMARY_INVALID', 'The review summary does not match its report entries.')
  if (!report.limitations.includes(DETAILED_REVIEW_NOT_IMPLEMENTED)) reject(issues, 'BOOK_REVIEW_LIMITATION_MISSING', 'The report must state that detailed review is not implemented.')
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
