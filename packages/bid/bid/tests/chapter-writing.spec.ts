import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidWorkspace,
  buildBidStageTask,
  executeChapterWriting,
  outlineArtifactSha256,
  parseChapterWritingManifest,
  validateChapterWriting,
} from '@deepseek-ai/dsh-bid'

const source = [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }]

async function writeInputs(workspace: BidWorkspace): Promise<void> {
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/project.json'), `${JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_scope: ['交付'], technical_scope: ['技术'], delivery_scope: ['实施'], source_refs: source, analyzed_tender_files: ['tender'] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), `${JSON.stringify({ schema_version: 1, requirements: [1, 2, 3].map(index => ({ id: `REQ-${index}`, category: '技术', raw_text: `要求${index}`, normalized_requirement: `响应要求${index}`, mandatory: true, source_refs: source })) })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), `${JSON.stringify({ schema_version: 1, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, source_refs: source })) })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), `${JSON.stringify({ schema_version: 1, compliance_items: [] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), `${JSON.stringify({ schema_version: 1, requirement_mappings: [1, 2, 3].map(index => ({ requirement_id: `REQ-${index}`, materials: [], missing_topics: ['无历史材料'] })), scoring_mappings: [1, 2, 3].map(index => ({ scoring_id: `SCORE-${index}`, materials: [], missing_topics: ['无历史材料'] })) })}\n`)
  const outline = { schema_version: 1 as const, scope: 'technical_bid' as const, document_title: '技术标', global_compliance_ids: [], sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '目录', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...[1, 2, 3].map(index => ({ id: `SEC-${index}`, parent_id: 'STRUCT', order: index, level: 2, title: `章节${index}`, purpose: `回答主题${index}`, writable: true, must_answer: [`回答${index}`], requirement_ids: [`REQ-${index}`], scoring_ids: [`SCORE-${index}`], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ] }
  await writeFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`)
  await writeFile(join(workspace.sessionRoot, 'outline/confirmation.json'), `${JSON.stringify({ schema_version: 1, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineArtifactSha256(outline), confirmed_outline_sha256: outlineArtifactSha256(outline) })}\n`)
}

describe('chapter-writing executor and validator', () => {
  it('drives one task per writable section and publishes an ordered manifest', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-')), 'session')
    await writeInputs(workspace)
    const followup = vi.fn()
    let call = 0
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 1) return
      call++
      const serial = String(call).padStart(4, '0')
      await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
      await mkdir(join(workspace.sessionRoot, 'chapters/meta'), { recursive: true })
      await writeFile(join(workspace.sessionRoot, `chapters/sections/${serial}.md`), `章节 ${call} 正文\n`)
      const metadata = {
        section_id: `SEC-${call}`, covered_must_answer: [`回答${call}`], evidence_used: [],
        additional_materials: [], unresolved_topics: [],
      }
      await writeFile(join(workspace.sessionRoot, `chapters/meta/${serial}.json`), `${JSON.stringify(metadata)}\n`)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = { id: 'session', ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() }, followup, whenIdle } as unknown as Agent

    await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing')))
      .resolves.toEqual([{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }])
    expect(followup).toHaveBeenCalledTimes(3)
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters.map(chapter => [chapter.section_id, chapter.content_path])).toEqual([
      ['SEC-1', 'chapters/sections/0001.md'], ['SEC-2', 'chapters/sections/0002.md'], ['SEC-3', 'chapters/sections/0003.md'],
    ])
    await expect(validateChapterWriting(workspace, 'chapter_writing', [{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }]))
      .resolves.toEqual({ ok: true })
  })
})
