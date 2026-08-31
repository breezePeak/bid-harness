import { describe, expect, it } from 'vitest'
import {
  BOOK_REVIEW_SCHEMA_VERSION,
  DETAILED_REVIEW_NOT_IMPLEMENTED,
  parseBookReviewReport,
} from '@deepseek-ai/dsh-bid'

const digest = 'a'.repeat(64)

function report(): Record<string, unknown> {
  return {
    schema_version: BOOK_REVIEW_SCHEMA_VERSION,
    scope: 'technical_bid',
    review_mode: 'framework_only',
    quality_gate: 'not_evaluated',
    confirmed_outline_sha256: digest,
    chapters: [{ section_id: 'SEC-1', content_path: 'chapters/sections/0001.md', content_sha256: digest, status: 'not_evaluated', issue_ids: [] }],
    issues: [],
    summary: { chapter_count: 1, evaluated_chapter_count: 0, issue_count: 0, blocking_issue_count: 0 },
    limitations: [DETAILED_REVIEW_NOT_IMPLEMENTED],
  }
}

describe('book-review report schema', () => {
  it('accepts the framework-only report', () => {
    expect(parseBookReviewReport(report()).quality_gate).toBe('not_evaluated')
  })

  it('rejects an evaluated quality result or malformed chapter hash', () => {
    expect(() => parseBookReviewReport({ ...report(), quality_gate: 'passed' })).toThrow()
    const base = report() as { chapters: Array<Record<string, unknown>> }
    expect(() => parseBookReviewReport({ ...base, chapters: [{ ...base.chapters[0], content_sha256: 'short' }] })).toThrow()
  })

  it('rejects every fixed framework field when it is changed', () => {
    for (const invalid of [
      { ...report() as object, schema_version: 2 },
      { ...report() as object, scope: 'commercial_bid' },
      { ...report() as object, review_mode: 'detailed' },
      { ...report() as object, confirmed_outline_sha256: 'bad' },
      { ...report() as object, limitations: [] },
    ]) expect(() => parseBookReviewReport(invalid)).toThrow()
  })

  it('rejects incomplete chapter placeholders and invalid issue enums', () => {
    const base = report() as { chapters: Array<Record<string, unknown>>; issues: unknown[] }
    expect(() => parseBookReviewReport({ ...base, chapters: [{ section_id: 'SEC-1' }] })).toThrow()
    const issue = { issue_id: 'ISSUE-1', section_id: 'SEC-1', category: 'general', severity: 'invalid', status: 'open', title: 'title', detail: 'detail', suggestion: 'suggestion' }
    expect(() => parseBookReviewReport({ ...base, issues: [issue] })).toThrow()
    expect(() => parseBookReviewReport({ ...base, issues: [{ ...issue, severity: 'warning', status: 'invalid' }] })).toThrow()
  })
})
