import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { allowedWritingCapabilitySourceWrites, allowedWritingCapabilityWrites, validateWritingCapability } from '../src/bid-writing-capability.ts'
import { seedMainTaskPlanningProject } from './fixtures/main-task-planning-loop.ts'
import { appendSemanticRevision, buildChapterRevisionLineagePath } from '../src/chapter-revision-lineage.ts'
import { buildRevisionComparisonPath, createRevisionComparisonArtifact } from '../src/chapter-revision-comparison.ts'
import { buildParagraphRevisionReviewPath, createParagraphRevisionReviewArtifact } from '../src/chapter-paragraph-revision-artifacts.ts'
import { parseChapterWritingManifest } from '../src/chapter-writing-artifacts.ts'
import { writeInputs } from './fixtures/chapter-writing-inputs.ts'

it('章节能力只授权目标正文、审核与共享索引，不授权范围外文件', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-writing-paths-')))
  await writeInputs(workspace)
  const paths = await allowedWritingCapabilityWrites(workspace, new Set(['SEC-2']))
  expect(paths).toEqual(new Set([
    'chapters/sections/0002.md', 'chapters/meta/0002.json', 'chapters/reviews/0002.json',
    'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json',
    'analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/quality-report.json',
  ]))
  expect(await allowedWritingCapabilitySourceWrites(workspace)).toEqual(new Set())
})

it('段落候选沿真实 Delta 审核链通过，篡改审核身份或正文则拒绝', async () => {
  const workspace = await seedMainTaskPlanningProject(await mkdtemp(join(tmpdir(), 'dsh-capability-writing-lineage-')))
  const bodyPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const before = await readFile(bodyPath, 'utf8')
  const after = before.replace('收集输入', '收集并登记输入')
  const comparison = createRevisionComparisonArtifact({ batchId: 'B1', taskId: 'T1', sectionId: 'S2.3',
    issueIds: ['I1'], beforeMarkdown: before, afterMarkdown: after, createdAt: 1 })
  const lineage = appendSemanticRevision(null, { sectionId: 'S2.3', batchId: 'B1', taskId: 'T1',
    baseReviewCandidateSha256: comparison.before_sha256, beforeSha256: comparison.before_sha256,
    afterSha256: comparison.after_sha256 })
  const review = createParagraphRevisionReviewArtifact({ batch_id: 'B1', task_id: 'T1', section_id: 'S2.3',
    issue_ids: ['I1'], before_sha256: comparison.before_sha256, after_sha256: comparison.after_sha256,
    writer_child_session_id: 'delta-writer', reviewer_child_session_id: 'delta-reviewer',
    issue_checks: [{ issue_id: 'I1', status: 'satisfied', reason: '已精确修改选区。' }], created_at: 1 })
  const reviewPath = join(workspace.projectRoot, buildParagraphRevisionReviewPath('B1', 'T1'))
  for (const [path, value] of [[buildRevisionComparisonPath('B1', 'T1'), comparison],
    [buildParagraphRevisionReviewPath('B1', 'T1'), review], [buildChapterRevisionLineagePath('0001'), lineage]] as const) {
    const absolute = join(workspace.projectRoot, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, JSON.stringify(value) + '\n')
  }
  const manifestPath = join(workspace.projectRoot, 'chapters/manifest.json')
  const manifest = parseChapterWritingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  manifest.chapters.find(entry => entry.section_id === 'S2.3')!.review_sha256 = comparison.after_sha256
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
  await writeFile(bodyPath, after)
  await expect(validateWritingCapability({ working: workspace }, ['S2.3'])).resolves.toBeUndefined()
  await writeFile(reviewPath, JSON.stringify({ ...review, task_id: 'forged' }) + '\n')
  await expect(validateWritingCapability({ working: workspace }, ['S2.3'])).rejects.toThrow('BID_CHAPTER_WRITING_TARGET_INVALID')
  await writeFile(reviewPath, JSON.stringify(review) + '\n')
  await writeFile(bodyPath, after + '未审核的内容。\n')
  await expect(validateWritingCapability({ working: workspace }, ['S2.3'])).rejects.toThrow('BID_CHAPTER_WRITING_TARGET_INVALID')
})
