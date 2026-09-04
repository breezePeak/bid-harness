import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mammoth from 'mammoth'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, DEFAULT_BID_CONFIG } from '../src/index.ts'
import { executeDocxExport, validateDocxExport } from '../src/docx-export.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from '../src/outline-confirmation-artifacts.ts'
import type { OutlineArtifact, OutlineSection } from '../src/outline-generation-artifacts.ts'
import type { ChapterWritingManifest } from '../src/chapter-writing-artifacts.ts'

async function exportFixture() {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-bid-export-')), { ...DEFAULT_BID_CONFIG, outputDirectory: 'deliverables' })
  const section = (
    id: string,
    parent_id: string | null,
    order: number,
    level: number,
    title: string,
    writable: boolean,
  ): OutlineSection => ({
    id, parent_id, order, level, title, writable, purpose: title, must_answer: writable ? [title] : [],
    requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [],
    scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  })
  const outline: OutlineArtifact = {
    schema_version: 3, scope: 'technical_bid', document_title: '项目技术标', global_compliance_ids: [],
    sections: [section('delivery', 'root', 2, 2, '交付', true), section('resource', 'branch', 1, 3, '资源配置', true),
      section('root', null, 1, 1, '实施方案', false), section('branch', 'root', 1, 2, '部署安排', false)],
  }
  const manifest: ChapterWritingManifest = {
    schema_version: 5, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(parseConfirmedOutlineArtifact(outline)),
    chapters: ['resource', 'delivery'].map((id, index) => ({
      section_id: id, content_path: `chapters/sections/000${index + 1}.md`, requirement_ids: [], scoring_ids: [], compliance_ids: [],
      covered_must_answer: [], covered_scoring_response_point_ids: [], covered_scoring_response_points: [],
      local_materials_used: [], web_materials_used: [], unresolved_topics: [],
      review_path: `chapters/reviews/000${index + 1}.json`, review_sha256: 'a'.repeat(64),
      handoff: {
        section_id: id, decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [],
        deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [],
      },
    })).reverse(),
  }
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline))
  await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), JSON.stringify(manifest))
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 资源配置\n\n资源配置正文。\n\n## 内部措施\n\n保留正文。\n\n```txt\n# 原样井号\n```\n')
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), '交付正文。')
  return { workspace, manifest }
}

describe('Bid DOCX export', () => {
  it('按确认目录顺序导出完整正文并保留结构标题层级', async () => {
    const { workspace } = await exportFixture()
    const artifacts = await executeDocxExport(workspace)
    expect(artifacts).toEqual([{ stage: 'docx_export', type: 'docx', path: 'deliverables/bid.docx' }])
    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toEqual({ ok: true })
    const markdown = await readFile(join(workspace.outputRoot, 'bid.md'), 'utf8')
    expect(markdown).toContain('## 1 实施方案\n\n### 1.1 部署安排\n\n#### 1.1.1 资源配置')
    expect(markdown).toContain('###### 内部措施')
    expect(markdown).toContain('```txt\n# 原样井号\n```')
    const { value: html } = await mammoth.convertToHtml({ buffer: await readFile(join(workspace.outputRoot, 'bid.docx')) })
    expect(html).toContain('<h4>1.1.1 资源配置</h4>')
    expect(html.indexOf('资源配置正文')).toBeLessThan(html.indexOf('交付正文'))
    expect(html).toContain('<h3>1.2 交付</h3>')
  })

  it.each(['hash', 'missing', 'duplicate', 'unknown', 'path'] as const)('拒绝 %s 不匹配的章节记录', async (invalid) => {
    const { workspace, manifest } = await exportFixture()
    if (invalid === 'hash') manifest.confirmed_outline_sha256 = 'b'.repeat(64)
    if (invalid === 'missing') manifest.chapters.pop()
    if (invalid === 'duplicate') manifest.chapters.push(manifest.chapters[0]!)
    if (invalid === 'unknown') manifest.chapters[0]!.section_id = 'unknown'
    if (invalid === 'path') manifest.chapters[0]!.content_path = 'chapters/sections/0001.md'
    await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), JSON.stringify(manifest))
    await expect(executeDocxExport(workspace)).rejects.toThrow(invalid === 'hash' ? 'DOCX_EXPORT_OUTLINE_MISMATCH' : 'DOCX_EXPORT_CHAPTER_SET_INVALID')
    await expect(readFile(join(workspace.outputRoot, 'bid.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('拒绝空正文及未保存的 DOCX', async () => {
    const { workspace } = await exportFixture()
    const artifacts = [{ stage: 'docx_export', type: 'docx', path: 'deliverables/bid.docx' }] as const
    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toMatchObject({ ok: false })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '')
    await expect(executeDocxExport(workspace)).rejects.toThrow('章节正文为空')
  })

  it('校验输出目录内的按需文件并拒绝路径逃逸', async () => {
    const { workspace } = await exportFixture()
    const artifacts = await executeDocxExport(workspace, undefined, 'deliverables/bid-1.docx')
    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toEqual({ ok: true })
    await writeFile(join(workspace.projectRoot, 'escaped.docx'), await readFile(join(workspace.outputRoot, 'bid-1.docx')))
    await expect(validateDocxExport(workspace, 'docx_export', [{
      stage: 'docx_export', type: 'docx', path: 'deliverables/../escaped.docx',
    }])).resolves.toMatchObject({ ok: false })
  })
})
