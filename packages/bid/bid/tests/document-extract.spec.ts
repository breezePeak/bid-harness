import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlignmentType, Document, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import { describe, expect, it } from 'vitest'
import { extractDocument, pdfPageText, sectionsFromMarkdown } from '../src/document-extract.ts'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('extractDocument', () => {
  it('converts positioned PDF items into spaces, tabs, and physical lines', () => {
    const item = (str: string, x: number, y: number, width = 1, hasEOL = false) => ({
      str, transform: [1, 0, 0, 1, x, y], width, height: 10, hasEOL,
    })
    expect(pdfPageText([
      null, {}, item('', 0, 10), item('A', 0, 10), item('B', 20, 10), item('C', 23, 10),
      item('D', 0, 30), item('E', 1, 30, 1, true), item('F', 0, 40),
    ])).toBe('A\tB C\nDE\nF')
  })

  it('indexes nested headings across page markers', () => {
    expect(sectionsFromMarkdown('<!-- page: 1 -->\n# One\nbody\n## Child\n<!-- page: 2 -->\nbody\n# Two\n')).toMatchObject([
      { title: 'One', page_start: 1, page_end: 2 },
      { title: 'Child', parent_id: 'section_001', page_start: 1, page_end: 2 },
      { title: 'Two', parent_id: null, page_start: 2, page_end: 2 },
    ])
  })
  it('extracts a real two-page Chinese PDF with page lines and section coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const result = await extractDocument({ sourcePath: fixture('bid-document.pdf'), outputDir: join(root, 'corpus') })

    expect(result).toMatchObject({ parseStatus: 'success', fileType: 'pdf', pageCount: 2, needsOcr: false })
    const markdown = await readFile(result.documentPath!, 'utf8')
    expect(markdown).toContain('<!-- page: 1 -->')
    expect(markdown).toContain('<!-- page: 2 -->')
    expect(markdown).toContain('项目实施管理')
    expect(markdown).toContain('评分项')
    expect(markdown.split('\n').filter(Boolean).every(line => line.length < 100)).toBe(true)
    const structure = JSON.parse(await readFile(result.structurePath!, 'utf8')) as { sections: Record<string, unknown>[] }
    expect(structure.sections[0]).toMatchObject({ title: '第一章 项目实施管理', page_start: 1, page_end: 2 })
  })

  it('marks a real text-free PDF as needing OCR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const result = await extractDocument({ sourcePath: fixture('scanned-document.pdf'), outputDir: join(root, 'corpus') })
    expect(result).toMatchObject({ parseStatus: 'needs_ocr', fileType: 'pdf', pageCount: 2, needsOcr: true })
    expect(JSON.parse(await readFile(result.metadataPath!, 'utf8'))).toMatchObject({ parse_status: 'needs_ocr', needs_ocr: true })
  })

  it('extracts DOCX headings, lists, tables, and Chinese without invented pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const source = join(root, '招标 文件.DOCX')
    const document = new Document({
      numbering: { config: [{ reference: 'ordered', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
      sections: [{ children: [
        new Paragraph({ text: '技术要求', heading: 'Heading1' }),
        new Paragraph({ text: '项目实施管理', heading: 'Heading2' }),
        new Paragraph({ text: '质量检查', heading: 'Heading3' }),
        new Paragraph({ text: '编制实施方案', numbering: { reference: 'ordered', level: 0 } }),
        new Paragraph({ text: '完成验收', bullet: { level: 0 } }),
        new Table({ rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph('项目')] }), new TableCell({ children: [new Paragraph('要求')] })] }),
          new TableRow({ children: [new TableCell({ children: [new Paragraph('实施|换行'), new Paragraph('第二行')] })] }),
        ] }),
      ] }],
    })
    await writeFile(source, await Packer.toBuffer(document))

    const outputDir = join(root, 'corpus')
    const first = await extractDocument({ sourcePath: source, outputDir })
    const second = await extractDocument({ sourcePath: source, outputDir })

    expect(first).toMatchObject({ parseStatus: 'success', fileType: 'docx', pageCount: null, needsOcr: false })
    expect(second).toMatchObject({ parseStatus: 'success' })
    const markdown = await readFile(first.documentPath!, 'utf8')
    expect(markdown).toContain('# 技术要求')
    expect(markdown).toContain('## 项目实施管理')
    expect(markdown).toContain('### 质量检查')
    expect(markdown).toContain('1. 编制实施方案')
    expect(markdown).toContain('- 完成验收')
    expect(markdown).toContain('| 项目 | 要求 |')
    expect(markdown).toContain('实施\\|换行')
    expect(JSON.parse(await readFile(first.structurePath!, 'utf8'))).toMatchObject({ sections: [
      { id: 'section_001', parent_id: null, level: 1, title: '技术要求', page_start: null, page_end: null },
      { id: 'section_002', parent_id: 'section_001', level: 2, title: '项目实施管理', page_start: null, page_end: null },
      { id: 'section_003', parent_id: 'section_002', level: 3, title: '质量检查', page_start: null, page_end: null },
    ] })
  })

  it('preserves DOCX comparison operators before scoring tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const source = join(root, '评分文件.docx')
    const row = (title: string, score: string) => new TableRow({ children: [
      new TableCell({ children: [new Paragraph(title)] }),
      new TableCell({ children: [new Paragraph(score)] }),
    ] })
    const document = new Document({ sections: [{ children: [
      new Paragraph('异常低价：投标报价<全部通过符合性审查供应商报价平均值×50%。'),
      new Table({ rows: [
        row('评审内容、方法及标准', '100分'),
        row('二、技术、服务部分（60分）', ''),
        row('1.对项目的理解', '5分'),
        row('2.设计方案（45分）', '45分'),
      ] }),
      new Paragraph('后续规则：报价>采购最高限价的投标无效。'),
    ] }] })
    await writeFile(source, await Packer.toBuffer(document))

    const result = await extractDocument({ sourcePath: source, outputDir: join(root, 'corpus') })

    expect(result).toMatchObject({ parseStatus: 'success', fileType: 'docx' })
    const markdown = await readFile(result.documentPath!, 'utf8')
    expect(markdown).toContain('投标报价<全部通过符合性审查供应商报价平均值×50%')
    expect(markdown).toContain('二、技术、服务部分（60分）')
    expect(markdown).toContain('2.设计方案（45分）')
  })

  it('extracts a real Chinese Word 97-2003 DOC without system executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const result = await extractDocument({ sourcePath: fixture('bid-document.doc'), outputDir: join(root, 'corpus') })

    expect(result).toMatchObject({ parseStatus: 'success', fileType: 'doc', pageCount: null, needsOcr: false })
    const markdown = await readFile(result.documentPath!, 'utf8')
    expect(markdown).toContain('项目实施管理')
    expect(markdown).toContain('本项目采用分阶段交付。')
    expect(markdown).toContain('编制实施方案')
    expect(markdown).toContain('评分项')
    expect(JSON.parse(await readFile(result.metadataPath!, 'utf8'))).toMatchObject({ parser: 'word-extractor', page_count: null })
  })

  it.each([
    ['broken.pdf', 'PDF_PARSE_FAILED'],
    ['broken.docx', 'DOCX_PARSE_FAILED'],
    ['broken.doc', 'DOC_PARSE_FAILED'],
  ])('reports %s corruption without crashing', async (name, code) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const source = join(root, name)
    await writeFile(source, 'not a document')
    await expect(extractDocument({ sourcePath: source, outputDir: join(root, 'corpus') })).resolves.toMatchObject({
      parseStatus: 'failed', error: { code },
    })
  })

  it('reports explicit status for missing and unsupported sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    await expect(extractDocument({ sourcePath: join(root, 'missing.pdf'), outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'failed', error: { code: 'FILE_NOT_FOUND' } })
    await expect(extractDocument({ sourcePath: '\u0000.pdf', outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'failed', error: { code: 'SOURCE_READ_FAILED' } })
    const directory = join(root, 'directory.pdf')
    await mkdir(directory)
    await expect(extractDocument({ sourcePath: directory, outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'failed', error: { code: 'SOURCE_NOT_FILE' } })
    const source = join(root, 'source.txt')
    await writeFile(source, 'text')
    await expect(extractDocument({ sourcePath: source, outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'unsupported_format', error: { code: 'UNSUPPORTED_FORMAT' } })
    await expect(extractDocument({ sourcePath: join(root, 'source'), outputDir: join(root, 'corpus') })).resolves.toMatchObject({ error: { message: 'Unsupported document format: (none)' } })
  })

  it('reports output failures after a successful parse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const output = join(root, 'blocked')
    await writeFile(output, 'not a directory')
    await expect(extractDocument({ sourcePath: fixture('bid-document.doc'), outputDir: output })).resolves.toMatchObject({
      parseStatus: 'failed', error: { code: 'OUTPUT_WRITE_FAILED' },
    })
  })
})
