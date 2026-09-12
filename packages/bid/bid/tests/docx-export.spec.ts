import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mammoth from 'mammoth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace, DEFAULT_BID_CONFIG } from '../src/index.ts'
import { assessDocxExportPageTarget, executeDocxExport, validateDocxExport } from '../src/docx-export.ts'
import { readDocxFormat } from '../src/docx-format-store.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from '../src/outline-confirmation-artifacts.ts'
import { parseWritingPlan } from '../src/writing-requirements.ts'
import type { OutlineArtifact, OutlineSection } from '../src/outline-generation-artifacts.ts'
import type { ChapterWritingManifest } from '../src/chapter-writing-artifacts.ts'

const reads = vi.hoisted(() => ({ afterRead: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args)
    if (typeof args[0] === 'string') await reads.afterRead?.(args[0])
    return value
  } }
})
afterEach(() => { reads.afterRead = undefined })

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
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline))
  await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), JSON.stringify(manifest))
  await writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [] }))
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify({ schema_version: 1, scoring_items: [] }))
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] }))
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), JSON.stringify({ schema_version: 1, scope: 'technical_bid', scoring_sha256: 'a'.repeat(64), next_sequence: 1, points: [] }))
  await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify({
    schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
    confirmed_outline_sha256: outlineArtifactSha256(parseConfirmedOutlineArtifact(outline)),
    user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
    user_requirements: ['按确认目录生成技术标。'], global_instructions: ['完整响应已确认的技术要求。'], document_acceptance: [],
    sections: ['resource', 'delivery'].map(section_id => ({
      section_id, task: '完成本章技术响应。', user_message_refs: [], user_requirements: [], writing_instructions: [], acceptance_criteria: [],
    })),
    revision: null,
  }))
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 资源配置\n\n资源配置正文。\n\n## 内部措施\n\n保留正文。\n\n```txt\n# 原样井号\n```\n')
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), '交付正文。')
  return { workspace, manifest, outline }
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

  it('S5 快照保留执行中和待执行章节的已保存正文，缺失正文时保留目录并标注', async () => {
    const { workspace, outline } = await exportFixture()
    await writeFile(join(workspace.projectRoot, 'chapters/manifest.json'), '{}')
    const executionLog = {
      schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(parseConfirmedOutlineArtifact(outline)),
      writing_plan_version: 1, max_concurrency: 2, observed_max_concurrency: 2,
      sections: [
        { section_id: 'resource', depends_on: [], related_sections: [], epoch: 0, status: 'completed', attempts: [],
          final_writer_child_session_id: 'writer-resource', final_reviewer_child_session_id: 'reviewer-resource' },
        { section_id: 'delivery', depends_on: [], related_sections: [], epoch: 0, status: 'running', attempts: [],
          final_writer_child_session_id: null, final_reviewer_child_session_id: null },
      ],
    }
    await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify(executionLog))

    const artifacts = await executeDocxExport(workspace, undefined, 'deliverables/partial.docx')

    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toEqual({ ok: true })
    const markdown = await readFile(join(workspace.outputRoot, 'partial.md'), 'utf8')
    expect(markdown).toContain('# 1 实施方案')
    expect(markdown).toContain('## 1.1 部署安排')
    expect(markdown).toContain('### 1.1.1 资源配置')
    expect(markdown).toContain('资源配置正文。')
    expect(markdown).toContain('## 1.2 交付')
    expect(markdown).toContain('交付正文。')

    executionLog.sections[0] = { ...executionLog.sections[0]!, status: 'pending',
      final_writer_child_session_id: null, final_reviewer_child_session_id: null }
    await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify(executionLog))
    await rm(join(workspace.projectRoot, 'chapters/sections/0002.md'))
    await executeDocxExport(workspace, undefined, 'deliverables/pending.docx')
    const pending = await readFile(join(workspace.outputRoot, 'pending.md'), 'utf8')
    expect(pending).toContain('资源配置正文。')
    expect(pending).toContain('## 1.2 交付\n\n（本节尚无已保存正文。）')
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '  \n')
    await executeDocxExport(workspace, undefined, 'deliverables/summary.docx')
    expect(await readFile(join(workspace.outputRoot, 'summary.md'), 'utf8')).toContain('本章介绍部署安排与交付要求')
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify({ ...outline,
      sections: outline.sections.filter(section => section.writable)
        .map((section, index) => ({ ...section, parent_id: null, order: index + 1, level: 1 })) }))
    await expect(executeDocxExport(workspace, undefined, 'deliverables/empty.docx'))
      .rejects.toThrow('DOCX_EXPORT_NO_SAVED_CHAPTERS')
  })

  it('技术偏离表审核失败时仍导出表格及后续章节，保留确认目录编号', async () => {
    const { workspace, outline } = await exportFixture()
    const resource = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
    const nextOutline = { ...outline, sections: [
      { ...outline.sections[0]!, id: 'deviation', parent_id: null, order: 1, level: 1, title: '技术偏离表' },
      ...outline.sections.map(section => section.id === 'root' ? { ...section, order: 2 } : section),
    ] }
    const hash = outlineArtifactSha256(parseConfirmedOutlineArtifact(nextOutline))
    const plan = parseWritingPlan(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')))
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(nextOutline))
    await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify({ ...plan,
      confirmed_outline_sha256: hash, sections: [{ ...plan.sections[0]!, section_id: 'deviation' }, ...plan.sections] }))
    await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify({
      schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: hash,
      writing_plan_version: 1, max_concurrency: 2, observed_max_concurrency: 2,
      sections: ['deviation', 'resource', 'delivery'].map(section_id => ({
        section_id, depends_on: [], related_sections: [], epoch: 0, status: 'failed', attempts: [],
        final_writer_child_session_id: null, final_reviewer_child_session_id: null,
      })),
    }))
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 1 技术偏离表\n\n| 技术条款 | 响应情况 | 偏离说明 |\n| --- | --- | --- |\n| 服务范围 | 全部响应 | 无偏离 |\n')
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), resource)
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0003.md'), '交付正文。')

    await executeDocxExport(workspace, undefined, 'deliverables/deviation.docx')

    const markdown = await readFile(join(workspace.outputRoot, 'deviation.md'), 'utf8')
    expect(markdown).toContain('# 1 技术偏离表')
    expect(markdown).toContain('# 2 实施方案')
    expect(markdown).toContain('### 2.1.1 资源配置')
    expect(markdown).toContain('## 2.2 交付')
    const { value: html } = await mammoth.convertToHtml({ buffer: await readFile(join(workspace.outputRoot, 'deviation.docx')) })
    expect(html).toContain('<h1><strong>技术偏离表</strong></h1>')
    expect(html).toContain('无偏离')
    expect(html).toContain('<table>')
    expect(html).toContain('资源配置正文。')
    expect(html).toContain('交付正文。')
  })

  it.each(['正文', '确认目录'])('快照读取期间%s变化时拒绝导出，保留上次成功文件', async (changed) => {
    const { workspace, outline } = await exportFixture()
    await executeDocxExport(workspace)
    const previous = await readFile(join(workspace.outputRoot, 'bid.docx'))
    const saved = await readDocxFormat(workspace)
    const chapterPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
    reads.afterRead = async (path) => {
      if (path !== chapterPath) return
      reads.afterRead = undefined
      if (changed === '正文') await writeFile(chapterPath, '修订后的正文。')
      else await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify({ ...outline, document_title: '修改后的技术标' }))
    }

    await expect(executeDocxExport(workspace, undefined, 'deliverables/bid.docx'))
      .rejects.toThrow('DOCX_EXPORT_SNAPSHOT_CHANGED')
    expect(await readFile(join(workspace.outputRoot, 'bid.docx'))).toEqual(previous)
    expect((await readDocxFormat(workspace)).state.lastExport).toEqual(saved.state.lastExport)
  })

  it('DOCX 可读取但正文低于已确认下限时仍生成文件并单独报告篇幅', async () => {
    const { workspace, outline } = await exportFixture()
    const artifacts = await executeDocxExport(workspace)
    const plan = parseWritingPlan({
      schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
      confirmed_outline_sha256: outlineArtifactSha256(parseConfirmedOutlineArtifact(outline)),
      user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
      user_requirements: ['至少 200 页。'], global_instructions: ['完整响应招标要求。'],
      document_acceptance: [{
        id: 'AC-000001', scope: { kind: 'document' }, description: '整本至少 200 页。', priority: 'required',
        evaluator: { kind: 'deterministic', metric: 'estimated_pages', min: 200, max: null },
      }],
      sections: ['resource', 'delivery'].map((section_id, index) => ({
        section_id, task: '完成本章技术响应。', user_message_refs: [], user_requirements: [], writing_instructions: [],
        acceptance_criteria: [{
          id: `AC-00000${index + 2}`, scope: { kind: 'section', section_id }, description: '完成本章任务。',
          priority: 'required', evaluator: { kind: 'semantic' },
        }],
      })),
      revision: null,
    })
    await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), `${JSON.stringify(plan)}\n`)

    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toEqual({ ok: true })
    const warnings = await assessDocxExportPageTarget(workspace)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('DOCX_EXPORT_PAGE_TARGET_BELOW')
    await expect(readFile(join(workspace.outputRoot, 'bid.docx'))).resolves.not.toHaveLength(0)
  })

  it.each(['缺失', '损坏'])('审核和执行产物%s不阻止已有正文导出', async (state) => {
    const { workspace } = await exportFixture()
    for (const path of ['chapters/manifest.json', 'chapters/execution-log.json', 'chapters/writing-plan.json',
      'analysis/requirements.json', 'analysis/scoring.json', 'analysis/compliance.json', 'analysis/scoring-response-points.json']) {
      const absolute = join(workspace.projectRoot, path)
      if (state === '缺失') await rm(absolute, { force: true })
      else await writeFile(absolute, 'invalid-json')
    }
    await expect(executeDocxExport(workspace)).resolves.toHaveLength(1)
    const markdown = await readFile(join(workspace.outputRoot, 'bid.md'), 'utf8')
    expect(markdown).toContain('资源配置正文。')
    expect(markdown).toContain('交付正文。')
  })

  it('空章节保留目录标注，未保存的 DOCX 校验失败', async () => {
    const { workspace } = await exportFixture()
    const artifacts = [{ stage: 'docx_export', type: 'docx', path: 'deliverables/bid.docx' }] as const
    await expect(validateDocxExport(workspace, 'docx_export', artifacts)).resolves.toMatchObject({ ok: false })
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '')
    await expect(executeDocxExport(workspace)).resolves.toHaveLength(1)
    expect(await readFile(join(workspace.outputRoot, 'bid.md'), 'utf8')).toContain('### 1.1.1 资源配置\n\n（本节尚无已保存正文。）')
  })

  it('导出不审查或修改已保存正文中的编号', async () => {
    const { workspace } = await exportFixture()
    const requirementsPath = join(workspace.projectRoot, 'analysis/requirements.json')
    const contentPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
    const requirement = {
      id: 'REQ-001', category: '技术', raw_text: '系统应提供审计功能。', normalized_requirement: '提供审计功能。',
      mandatory: true, source_refs: [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }],
    }
    await writeFile(requirementsPath, JSON.stringify({ schema_version: 1, requirements: [requirement] }))
    await writeFile(contentPath, '# 资源配置\n\n我方按 REQ-001 实施审计控制。')
    await expect(executeDocxExport(workspace)).resolves.toHaveLength(1)
    expect(await readFile(join(workspace.outputRoot, 'bid.md'), 'utf8')).toContain('我方按 REQ-001 实施审计控制。')
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
