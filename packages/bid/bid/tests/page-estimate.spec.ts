import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { describe, expect, it, vi } from 'vitest'
import { defaultDocxFormatState, formatFields } from '../src/docx-format.ts'
import { readDocxFormat, saveDocxTemplate, setEstimateDocxTemplate, writeDocxFormat } from '../src/docx-format-store.ts'
import { clearPageEstimateCache, estimateChapterCandidatePages, estimateChapterWritingPages,
  estimateDocxMarkdownPages, estimateReviewPages } from '../src/page-estimate.ts'
import type { BidWorkspace } from '../src/index.ts'
import type { OutlineArtifact } from '../src/outline-generation-artifacts.ts'

const defaults = { font: '宋体', bodySize: 24, headingSize: 32 }

async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-page-estimate-'))
  return { root, projectRoot: root, config: defaults } as BidWorkspace
}

function values(overrides = {}) {
  return { ...defaultDocxFormatState(formatFields(defaults)).resolved, ...overrides }
}

function pdf(pages: number): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${String(index + 3)} 0 R`).join(' ')}] /Count ${String(pages)} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'),
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return Buffer.from(source)
}

const outline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术标',
  global_compliance_ids: [],
  sections: [
    { id: 'ROOT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '组织正文', writable: false,
      summary: '总体说明。', must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
      scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    { id: 'LEAF', parent_id: 'ROOT', order: 1, level: 2, title: '工作安排', purpose: '说明工作安排', writable: true,
      must_answer: ['说明工作安排'], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
      scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
  ],
}

async function wordTemplate(label: string, size: number): Promise<Buffer> {
  return Packer.toBuffer(new Document({ styles: { paragraphStyles: [{ id: 'Normal', name: 'Normal',
    run: { size: size * 2 }, paragraph: { spacing: { line: 360 } } }] }, sections: [{ children: [
    new Paragraph({ style: 'Normal', children: [new TextRun(`${label} 正文`)] }),
  ] }] }))
}

describe('Word page estimate', () => {
  it('先汇总父节点和全文再取整，父节点包含自身概述及全部后代', async () => {
    const project = await workspace()
    const sections = [
      { section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: false, markdown: '父章节概述。' },
      { section_id: 'one', parent_id: 'root', number: '1.1', depth: 2, title: '一', writable: true, markdown: '甲。' },
      { section_id: 'two', parent_id: 'root', number: '1.2', depth: 2, title: '二', writable: true, markdown: '乙。' },
    ] as const
    const estimate = await estimateReviewPages(project, '技术标', sections, values())
    const root = estimate.sections.get('root')!
    const one = estimate.sections.get('one')!
    const two = estimate.sections.get('two')!
    expect(root.pages).toBeGreaterThan(one.pages + two.pages)
    expect(Math.ceil(estimate.total)).toBe(1)
    expect(Math.ceil(one.pages) + Math.ceil(two.pages)).toBe(2)
    expect(root.incomplete).toBe(false)
  })

  it('正文、格式或模板身份变化前复用缓存，变化后不复用旧快照', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    const base = [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '已生成正文。' }] as const
    const initial = await readDocxFormat(project)
    const first = await estimateReviewPages(project, '技术标', base, initial.values, 'template-a:1')
    expect(await estimateReviewPages(project, '技术标', base, initial.values, 'template-a:1')).toBe(first)
    const revised = await estimateReviewPages(project, '技术标', [{ ...base[0], markdown: '修订后的正文。' }], values())
    const reformatted = await estimateReviewPages(project, '技术标', base, values({ 'body.size': 18 }))
    const templateChanged = await estimateReviewPages(project, '技术标', base, initial.values, 'template-b:1')
    expect(revised).not.toBe(first)
    expect(reformatted).not.toBe(first)
    expect(templateChanged).not.toBe(first)
  })

  it('较早估算完成后不覆盖较新的内容快照', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    const old = estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '旧正文。' }], values())
    const current = await estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '新正文。' }], values())
    await old
    expect(await estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '新正文。' }], values())).toBe(current)
  })

  it('只统计已有正文，缺失叶节使父章节标记为仅统计已生成内容', async () => {
    const estimate = await estimateReviewPages(await workspace(), '技术标', [
      { section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: false, markdown: '概述。' },
      { section_id: 'ready', parent_id: 'root', number: '1.1', depth: 2, title: '已生成', writable: true, markdown: '正文。' },
      { section_id: 'pending', parent_id: 'root', number: '1.2', depth: 2, title: '待生成', writable: true, markdown: '' },
    ], values())
    expect(estimate.sections.get('root')).toMatchObject({ hasContent: true, incomplete: true })
    expect(estimate.total).toBeGreaterThan(0)
  })

  it('S5 整书、父节点和 Writer candidate 读取同一个页数基准模板', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    await mkdir(join(project.projectRoot, 'chapters/sections'), { recursive: true })
    await writeFile(join(project.projectRoot, 'chapters/sections/0001.md'), '# 工作安排\n\n已生成正文。\n')
    const uploaded = await saveDocxTemplate(project, { revision: 0, name: '模板 A.docx', bytes: await wordTemplate('A', 18) })

    const document = await estimateChapterWritingPages(project, outline)
    const candidate = await estimateChapterCandidatePages(project, outline, 'LEAF', '# 工作安排\n\n候选正文。')
    expect(document.format).toMatchObject({ source: 'template', template_id: uploaded.templateId, template_name: '模板 A.docx' })
    expect(candidate.format).toMatchObject({ source: 'template', template_id: uploaded.templateId, template_name: '模板 A.docx' })
    expect(document.sections.get('ROOT')).toMatchObject({ hasContent: true })

    await setEstimateDocxTemplate(project, null, uploaded.library.revision)
    const defaultEstimate = await estimateChapterWritingPages(project, outline)
    expect(defaultEstimate.format).toMatchObject({ source: 'default', template_id: null })
    expect(defaultEstimate.total).not.toBe(document.total)
  })

  it('真实分页按正文、格式和图片摘要缓存，并合并同一时刻的重复请求', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    await mkdir(join(project.projectRoot, 'assets'), { recursive: true })
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(project.projectRoot, 'assets/pixel.png'), image)
    const renderPdf = vi.fn(async () => pdf(2))
    const markdown = '# 文档\n\n正文。\n\n![图](assets/pixel.png)\n'

    const [first, concurrent] = await Promise.all([
      estimateDocxMarkdownPages(project, markdown, null, { renderPdf }),
      estimateDocxMarkdownPages(project, markdown, null, { renderPdf }),
    ])
    expect(first).toMatchObject({ pages: 2, method: 'rendered', format: { source: 'default', template_id: null } })
    expect(concurrent.fingerprint).toBe(first.fingerprint)
    expect(renderPdf).toHaveBeenCalledOnce()
    expect((await estimateDocxMarkdownPages(project, markdown, null, { renderPdf })).fingerprint).toBe(first.fingerprint)
    expect(renderPdf).toHaveBeenCalledOnce()

    const contentChanged = await estimateDocxMarkdownPages(project, `${markdown}\n新增正文。`, null, { renderPdf })
    expect(contentChanged.fingerprint).not.toBe(first.fingerprint)
    expect(renderPdf).toHaveBeenCalledTimes(2)

    const current = await readDocxFormat(project, null)
    await writeDocxFormat(project, null, { ...current.state, revision: current.state.revision + 1,
      resolved: { ...current.state.resolved, 'body.size': 18 } })
    const formatChanged = await estimateDocxMarkdownPages(project, markdown, null, { renderPdf })
    expect(formatChanged.fingerprint).not.toBe(first.fingerprint)
    expect(renderPdf).toHaveBeenCalledTimes(3)

    await writeFile(join(project.projectRoot, 'assets/pixel.png'), Buffer.concat([image, Buffer.from([0])]))
    const assetChanged = await estimateDocxMarkdownPages(project, markdown, null, { renderPdf })
    expect(assetChanged.fingerprint).not.toBe(formatChanged.fingerprint)
    expect(renderPdf).toHaveBeenCalledTimes(4)
  })

  it('真实分页不可用时回退 fast 并明确标记，失败缓存不污染其他项目', async () => {
    clearPageEstimateCache()
    const unavailable = vi.fn(async () => { throw new Error('LibreOffice unavailable') })
    const markdown = '# 文档\n\n正文。\n'
    const firstProject = await workspace()
    const first = await estimateDocxMarkdownPages(firstProject, markdown, null, { renderPdf: unavailable })
    const again = await estimateDocxMarkdownPages(firstProject, markdown, null, { renderPdf: unavailable })
    expect(first.method).toBe('fast')
    expect(again.method).toBe('fast')
    expect(unavailable).toHaveBeenCalledOnce()

    const available = vi.fn(async () => pdf(3))
    const other = await estimateDocxMarkdownPages(await workspace(), markdown, null, { renderPdf: available })
    expect(other).toMatchObject({ method: 'rendered', pages: 3 })
    expect(available).toHaveBeenCalledOnce()
  })
})
