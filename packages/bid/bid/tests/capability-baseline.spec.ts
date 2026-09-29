import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace, parseChapterMetadata, parseChapterWritingManifest, parseOrMigrateChapterExecutionLog, parseEvidenceMapArtifact, parseScoringResponsePointCatalog, parseWritingPlan } from '@deepseek-ai/dsh-bid'
import { parseChapterReviewArtifact } from '../src/chapter-writing-review-artifacts.ts'
import { chapterContentSha256, assertChapterRevisionScope } from '../src/chapter-revision.ts'
import { captureCapabilityBaseline, seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(variant: 'complete' | 'partial'): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-capability-baseline-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, variant)
  return workspace
}

describe('T01 旧项目黄金基线', () => {
  it.each(['complete', 'partial'] as const)('%s 项目保留章节、资料、计划、Child 与导出身份', async (variant) => {
    const workspace = await fixture(variant)
    const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8')) as unknown
    const manifest = parseChapterWritingManifest(await read('chapters/manifest.json'))
    const log = parseOrMigrateChapterExecutionLog(await read('chapters/execution-log.json'))
    const plan = parseWritingPlan(await read('chapters/writing-plan.json'))
    const evidence = parseEvidenceMapArtifact(await read('analysis/evidence-map.json'))
    const responsePoints = parseScoringResponsePointCatalog(await read('analysis/scoring-response-points.json'))
    expect(plan.sections).toHaveLength(5)
    expect(log.sections).toHaveLength(5)
    expect(evidence.section_mappings).toHaveLength(5)
    expect(responsePoints.points).toHaveLength(5)
    expect(manifest.chapters).toHaveLength(variant === 'complete' ? 5 : 2)
    for (const chapter of manifest.chapters) {
      const number = chapter.content_path.match(/\d{4}/u)?.[0]
      expect(number).toBeDefined()
      const body = await readFile(join(workspace.projectRoot, chapter.content_path), 'utf8')
      expect(parseChapterMetadata(await read(`chapters/meta/${number}.json`)).section_id).toBe(chapter.section_id)
      expect(parseChapterReviewArtifact(await read(chapter.review_path)).candidate_sha256).toBe(chapterContentSha256(body))
      expect(log.sections.find(section => section.section_id === chapter.section_id)?.attempts.map(attempt => attempt.role)).toEqual(['writer', 'reviewer'])
    }
    const baseline = await captureCapabilityBaseline(workspace)
    expect(baseline).toMatchSnapshot()
  })

  it('部分完成项目的未写叶节不借用相邻正文', async () => {
    const workspace = await fixture('partial')
    const baseline = await captureCapabilityBaseline(workspace) as {
      chapters: Array<{ section_id: string }>
      export_pending_sections: number
    }
    expect(baseline.chapters.map(chapter => chapter.section_id)).toEqual(['SEC-1', 'SEC-2'])
    expect(baseline.export_pending_sections).toBe(3)
  })

  it('连续段落修订保留选区前后与相邻章节', async () => {
    const workspace = await fixture('complete')
    const path = join(workspace.projectRoot, 'chapters/sections/0001.md')
    const original = await readFile(path, 'utf8')
    const adjacent = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
    const selected = '流程二：校验结果。'
    const start = original.indexOf(selected)
    const request = { instruction: '缩短流程二', reference: {
      scope: 'paragraphs' as const, section_id: 'SEC-1', content_sha256: chapterContentSha256(original),
      start, end: start + selected.length, text: selected,
    } }
    const candidate = original.slice(0, start) + '流程二：校验。' + original.slice(start + selected.length)
    expect(() => { assertChapterRevisionScope(request, original, candidate) }).not.toThrow()
    expect(() => { assertChapterRevisionScope(request, original, candidate.replace('流程一', '错误改动')) }).toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')).toBe(adjacent)
  })
})
