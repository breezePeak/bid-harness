import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writerRuns: [] as unknown[],
  reviewerRuns: [] as unknown[],
  writerOutputs: [] as unknown[],
  reviewerOutputs: [] as unknown[],
}))

vi.mock('../src/chapter-paragraph-revision-child.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chapter-paragraph-revision-child.ts')>()
  return {
    ...actual,
    createParagraphRevisionWriterChild: () => ({
      id: SessionId('writer'),
      async run(prompt: string) {
        mocks.writerRuns.push(prompt)
        return { stopReason: 'completed' as const, output: [], structured: mocks.writerOutputs.shift() }
      },
      async dispose() {},
    }),
  }
})

vi.mock('../src/chapter-paragraph-revision-review.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chapter-paragraph-revision-review.ts')>()
  return {
    ...actual,
    createParagraphRevisionReviewerChild: () => ({
      id: SessionId('reviewer'),
      async run(prompt: string) {
        mocks.reviewerRuns.push(prompt)
        return { stopReason: 'completed' as const, output: [], structured: mocks.reviewerOutputs.shift() }
      },
      async dispose() {},
    }),
  }
})

import { BidWorkspace } from '../src/index.ts'
import { executeParagraphRevisionTask } from '../src/chapter-paragraph-revision-executor.ts'
import { chapterLocation } from '../src/chapter-storage.ts'
import { chapterCandidateSha256 } from '../src/chapter-writing-review-artifacts.ts'
import { buildParagraphRevisionReviewPath } from '../src/chapter-paragraph-revision-artifacts.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
beforeEach(() => {
  mocks.writerRuns.length = 0
  mocks.reviewerRuns.length = 0
  mocks.writerOutputs.length = 0
  mocks.reviewerOutputs.length = 0
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-paragraph-executor-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  const original = '# 标题\n\n原段落。\n'
  const metadata = {
    section_id: 'SEC-1', covered_must_answer: [], covered_scoring_response_point_ids: [],
    covered_scoring_response_points: [], local_materials_used: [], web_materials_used: [], unresolved_topics: [],
    handoff: { section_id: 'SEC-1', decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] },
    flowcharts: [],
  }
  const review = {
    schema_version: 8, section_id: 'SEC-1', verdict: 'pass', must_answer_coverage: [], requirement_coverage: [],
    response_point_coverage: [], compliance_coverage: [], acceptance_criteria_results: [], global_compliance_checks: [],
    assignment_conflicts: [], external_input_gaps: [], claim_checks: [], quality_checks: {
      bidder_response_voice: true, project_specific: true, structure_complete: true,
      legacy_project_pollution_free: true, placeholder_free: true, obvious_repetition_free: true,
    }, blocking_issues: [], candidate_sha256: chapterCandidateSha256(original),
    writer_child_session_id: 'writer', reviewer_child_session_id: 'chapter-reviewer',
  }
  const manifest = {
    schema_version: 6, scope: 'technical_bid', confirmed_outline_sha256: 'a'.repeat(64), chapters: [{
      content_path: 'chapters/sections/0001.md', requirement_ids: [], scoring_ids: [], compliance_ids: [],
      review_path: 'chapters/reviews/0001.json', review_sha256: chapterCandidateSha256(original), ...metadata,
    }],
  }
  await Promise.all(['chapters/sections', 'chapters/meta', 'chapters/reviews'].map(path => mkdir(join(workspace.projectRoot, path), { recursive: true })))
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), original)
  await writeFile(join(workspace.projectRoot, 'chapters/meta/0001.json'), metadataBytes)
  await writeFile(join(workspace.projectRoot, 'chapters/reviews/0001.json'), JSON.stringify(review))
  await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), JSON.stringify(manifest))
  const start = original.indexOf('原段落。')
  return {
    workspace, original, metadataBytes,
    input: {
      parent: {} as Agent,
      workspace,
      batchId: 'BATCH-1',
      task: {
        task_id: 'TASK-1', section_id: 'SEC-1', issue_ids: ['ISSUE-1'], depends_on: [],
        issues: [{ issue_id: 'ISSUE-1', instruction: '写得自然一些', suggestion: null, scope: 'paragraphs' as const,
          reference_text: '原段落。', start, end: start + '原段落。'.length }],
      },
      location: chapterLocation('SEC-1', 1), title: '标题', writerId: 'writer', signal: new AbortController().signal,
      customerTextContext: {
        outline: { sections: [{ id: 'SEC-1' }] }, requirements: { requirements: [] }, scoring: { scoring_items: [] },
        compliance: { compliance_items: [] }, responsePoints: { points: [] }, acceptanceCriterionIds: [],
      },
    },
  }
}

describe('paragraph revision executor', () => {
  it('normal style revision uses one Writer and one Delta Reviewer and leaves metadata bytes unchanged', async () => {
    const { workspace, metadataBytes, input } = await fixture()
    mocks.writerOutputs.push({ replacements: [{ segment_id: 'SEG-001', markdown: '修改后的自然段落。' }] })
    mocks.reviewerOutputs.push({
      decision: 'accept', issue_checks: [{ issue_id: 'ISSUE-1', status: 'satisfied', reason: '表达已自然' }],
      semantic_preserved: true, repair_instructions: [], reason: '仅改变表达',
    })

    await expect(executeParagraphRevisionTask(input)).resolves.toEqual({ status: 'completed' })
    expect(mocks.writerRuns).toHaveLength(1)
    expect(mocks.reviewerRuns).toHaveLength(1)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe('# 标题\n\n修改后的自然段落。\n')
    expect(await readFile(join(workspace.projectRoot, 'chapters/meta/0001.json'))).toEqual(metadataBytes)
    await expect(readFile(join(workspace.projectRoot, buildParagraphRevisionReviewPath('BATCH-1', 'TASK-1')))).resolves.toBeInstanceOf(Buffer)
  })

  it('full_review keeps the original chapter and publishes no Fast Path artifact', async () => {
    const { workspace, original, input } = await fixture()
    mocks.writerOutputs.push({ replacements: [{ segment_id: 'SEG-001', markdown: '接口版本改为 v2。' }] })
    mocks.reviewerOutputs.push({
      decision: 'full_review', issue_checks: [{ issue_id: 'ISSUE-1', status: 'satisfied', reason: '文字已修改' }],
      semantic_preserved: false, repair_instructions: [], reason: '改变接口技术语义',
    })

    await expect(executeParagraphRevisionTask(input)).resolves.toEqual({ status: 'full_review' })
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(original)
    await expect(readFile(join(workspace.projectRoot, buildParagraphRevisionReviewPath('BATCH-1', 'TASK-1')))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('needs_input keeps the original chapter unchanged', async () => {
    const { workspace, original, input } = await fixture()
    mocks.writerOutputs.push({ replacements: [{ segment_id: 'SEG-001', markdown: '待确认的改写。' }] })
    mocks.reviewerOutputs.push({
      decision: 'needs_input', issue_checks: [{ issue_id: 'ISSUE-1', status: 'needs_input', reason: '缺少用户偏好' }],
      semantic_preserved: true, repair_instructions: [], reason: '需要用户输入',
    })

    await expect(executeParagraphRevisionTask(input)).resolves.toEqual({ status: 'needs_input' })
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(original)
  })

  it('allows exactly one semantic repair round', async () => {
    const { workspace, input } = await fixture()
    mocks.writerOutputs.push(
      { replacements: [{ segment_id: 'SEG-001', markdown: '第一版。' }] },
      { replacements: [{ segment_id: 'SEG-001', markdown: '第二版更自然。' }] },
    )
    mocks.reviewerOutputs.push(
      {
        decision: 'repair', issue_checks: [{ issue_id: 'ISSUE-1', status: 'unsatisfied', reason: '仍然生硬' }],
        semantic_preserved: true, repair_instructions: [{ segment_id: 'SEG-001', instruction: '减少模板句式' }], reason: '需要一次修复',
      },
      {
        decision: 'accept', issue_checks: [{ issue_id: 'ISSUE-1', status: 'satisfied', reason: '表达自然' }],
        semantic_preserved: true, repair_instructions: [], reason: '通过',
      },
    )

    await expect(executeParagraphRevisionTask(input)).resolves.toEqual({ status: 'completed' })
    expect(mocks.writerRuns).toHaveLength(2)
    expect(mocks.reviewerRuns).toHaveLength(2)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toContain('第二版更自然。')
  })

  it('fails after the second unsatisfied review without a third Writer call', async () => {
    const { workspace, original, input } = await fixture()
    mocks.writerOutputs.push(
      { replacements: [{ segment_id: 'SEG-001', markdown: '第一版。' }] },
      { replacements: [{ segment_id: 'SEG-001', markdown: '第二版。' }] },
    )
    mocks.reviewerOutputs.push(...[1, 2].map(round => ({
      decision: 'repair', issue_checks: [{ issue_id: 'ISSUE-1', status: 'unsatisfied', reason: `第 ${round} 轮仍生硬` }],
      semantic_preserved: true, repair_instructions: [{ segment_id: 'SEG-001', instruction: '继续调整' }], reason: '仍未满足',
    })))

    await expect(executeParagraphRevisionTask(input)).resolves.toMatchObject({
      status: 'failed', code: 'PARAGRAPH_REVISION_NOT_SATISFIED',
    })
    expect(mocks.writerRuns).toHaveLength(2)
    expect(mocks.reviewerRuns).toHaveLength(2)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(original)
  })
})
