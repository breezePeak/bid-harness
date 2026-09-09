import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mammoth from 'mammoth'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, DEFAULT_BID_CONFIG } from '../src/index.ts'
import { executeDocxExport, validateDocxExport } from '../src/docx-export.ts'
import { readDocxFormat } from '../src/docx-format-store.ts'
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
    ...(!writable ? { summary: id === 'root' ? '本章介绍部署安排与交付要求，说明项目实施的主要内容。' : '本节概述部署所需的资源配置。' } : {}),
    requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [],
    scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
  })
  const outline: OutlineArtifact = {
    schema_version: 3, scope: 'technical_bid', document_title: '项目技术标', global_compliance_ids: [],
    sections: [section('delivery', 'root', 2, 2, '交付', true), section('resource', 'branch', 1, 3, '资源配置', true),
      section('root', null, 1, 1, '实施方案', false), section('branch', 'root', 1, 2, '部署安排', false)],
  }
  const manifest: ChapterWritingManifest = {
    schema_version: 6, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(parseConfirmedOutlineArtifact(outline)),
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
  it('正文图片缺失时保留上一次成功文件及下载记录', async () => {
    const { workspace } = await exportFixture()
    await executeDocxExport(workspace)
    const previous = await readFile(join(workspace.outputRoot, 'bid.docx'))
    const saved = await readDocxFormat(workspace)
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '![实施图](missing.png)')
    await expect(executeDocxExport(workspace)).rejects.toThrow('图片不存在或无法读取')
    expect(await readFile(join(workspace.outputRoot, 'bid.docx'))).toEqual(previous)
    expect((await readDocxFormat(workspace)).state.lastExport).toEqual(saved.state.lastExport)
  })
  it('按确认目录顺序导出各级父节点概述和叶节正文，保留正文标题', async () => {
    const { workspace } = await exportFixture()
    const artifacts = await executeDocxExport(workspace)
    expect(artifacts).toEqual([{ stage: 'docx_export', type: 'docx', path: 'deliverables/bid.docx' }])
    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toEqual({ ok: true })
    const markdown = await readFile(join(workspace.outputRoot, 'bid.md'), 'utf8')
    expect(markdown).toContain('# 1 实施方案\n\n本章介绍部署安排与交付要求，说明项目实施的主要内容。\n\n## 1.1 部署安排\n\n本节概述部署所需的资源配置。\n\n### 1.1.1 资源配置')
    expect(markdown).toContain('#### 内部措施')
    expect(markdown).not.toContain('1.1.1.1')
    expect(markdown).toContain('```txt\n# 原样井号\n```')
    const { value: html } = await mammoth.convertToHtml({ buffer: await readFile(join(workspace.outputRoot, 'bid.docx')) })
    expect(html).toContain('<h3><strong>资源配置</strong></h3>')
    expect(html).toContain('<h1><strong>实施方案</strong></h1><p>本章介绍部署安排与交付要求，说明项目实施的主要内容。</p><h2><strong>部署安排</strong></h2><p>本节概述部署所需的资源配置。</p>')
    expect(html.indexOf('资源配置正文')).toBeLessThan(html.indexOf('交付正文'))
    expect(html).toContain('<h2><strong>交付</strong></h2>')
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
