import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import { describe, expect, it } from 'vitest'
import { extractDocument } from '../src/document-extract.ts'

describe('extractDocument', () => {
  it('writes Markdown, structure, and metadata for a DOCX with headings and a table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    const source = join(root, '招标 文件.DOCX')
    const document = new Document({ sections: [{ children: [
      new Paragraph({ text: '技术要求', heading: 'Heading1' }),
      new Paragraph('项目实施管理'),
      new Table({ rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph('项目')] }), new TableCell({ children: [new Paragraph('要求')] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph('实施')] }), new TableCell({ children: [new Paragraph('完整')] })] }),
      ] }),
    ] }] })
    await writeFile(source, await Packer.toBuffer(document))

    const result = await extractDocument({ sourcePath: source, outputDir: join(root, 'corpus') })

    expect(result).toMatchObject({ parseStatus: 'success', fileType: 'docx', pageCount: null, needsOcr: false })
    const markdown = await readFile(result.documentPath!, 'utf8')
    expect(markdown).toContain('# 技术要求')
    expect(markdown).toContain('项目实施管理')
    expect(markdown).toContain('| 项目 | 要求 |')
    expect(JSON.parse(await readFile(result.structurePath!, 'utf8'))).toMatchObject({ sections: [{ level: 1, title: '技术要求', page_start: null }] })
    expect(JSON.parse(await readFile(result.metadataPath!, 'utf8'))).toMatchObject({ source_file: '招标 文件.DOCX', parse_status: 'success', page_count: null })
  })

  it('reports explicit status for missing and unsupported sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-extract-'))
    await expect(extractDocument({ sourcePath: join(root, 'missing.pdf'), outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'failed', error: { code: 'FILE_NOT_FOUND' } })
    const source = join(root, 'source.txt')
    await writeFile(source, 'text')
    await expect(extractDocument({ sourcePath: source, outputDir: join(root, 'corpus') })).resolves.toMatchObject({ parseStatus: 'unsupported_format', error: { code: 'UNSUPPORTED_FORMAT' } })
  })
})
