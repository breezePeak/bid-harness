import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Footer, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, VerticalMergeType, type ITableCellOptions } from 'docx'
import { describe, expect, it } from 'vitest'
import { composeDocxFromTemplate, inspectDocxTemplateStructure } from '../src/docx-compose.ts'
import { defaultDocxFormatState, formatFields } from '../src/docx-format.ts'
import type { BidWorkspace } from '../src/index.ts'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
const paragraph = (value: string) => new Paragraph(value)
const cell = (value: string, options: Omit<ITableCellOptions, 'children'> = {}) => new TableCell({
  children: [paragraph(value)],
  ...options,
})

async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-docx-compose-'))
  return { root, projectRoot: root, config: { font: '宋体', bodySize: 24, headingSize: 32 } } as BidWorkspace
}

async function template(): Promise<Buffer> {
  const header = new Header({ children: [new Paragraph({ children: [
    new ImageRun({ data: pixel, type: 'png', transformation: { width: 12, height: 12 } }),
    new TextRun(' 固定页眉'),
  ] })] })
  const footer = new Footer({ children: [paragraph('固定页脚')] })
  const table = new Table({ rows: [
    new TableRow({ tableHeader: true, children: [
      cell('序号'), cell('标的名称', { columnSpan: 2 }), cell('招标技术要求'),
      cell('投标响应内容', { columnSpan: 2 }), cell('偏离程度'), cell('备注'),
    ] }),
    new TableRow({ children: [
      cell('1', { verticalMerge: VerticalMergeType.RESTART }), cell('平台', { columnSpan: 2 }), cell('服务范围'),
      cell('待填写 A', { columnSpan: 2 }), cell('无偏离'), cell('固定备注 A'),
    ] }),
    new TableRow({ children: [
      cell('', { verticalMerge: VerticalMergeType.CONTINUE }), cell('平台', { columnSpan: 2 }), cell('交付期限'),
      cell('待填写 B', { columnSpan: 2 }), cell('无偏离'), cell('固定备注 B'),
    ] }),
  ] })
  return Packer.toBuffer(new Document({ sections: [
    { headers: { default: header }, footers: { default: footer }, children: [paragraph('固定封面'), paragraph('{{正文}}')] },
    { properties: { page: { size: { orientation: 'landscape' } } }, headers: { default: header }, footers: { default: footer },
      children: [paragraph('技术偏离表'), table, paragraph('固定说明')] },
  ] }))
}

describe('DOCX 模板合成', () => {
  it('保留模板部件和分节，只按逻辑列填写响应内容并在锚点插入其余正文', async () => {
    const original = await template()
    expect(await inspectDocxTemplateStructure(original)).toMatchObject({ bodyAnchor: 'placeholder', tables: [{
      gridColumns: 8,
      editableColumns: [{ header: '投标响应内容', gridStart: 4, gridSpan: 2 }],
    }] })
    const project = await workspace()
    await mkdir(join(project.projectRoot, 'assets'))
    await writeFile(join(project.projectRoot, 'assets', 'pixel.png'), pixel)
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const markdown = '# 技术标\n\n## 技术偏离表\n\n| 技术条款 | 响应情况 | 偏离说明 |\n| --- | --- | --- |\n| 服务范围 | 完整响应 A | 无偏离 |\n| 交付期限 | 完整响应 B | 无偏离 |\n\n## 实施方案\n\n正文内容。\n\n![示意图](assets/pixel.png)\n'
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const [before, after] = await Promise.all([JSZip.loadAsync(original), JSZip.loadAsync(result.bytes)])
    const [beforeDocument, afterDocument] = await Promise.all([
      before.file('word/document.xml')!.async('string'), after.file('word/document.xml')!.async('string'),
    ])

    expect(afterDocument).toContain('固定封面')
    expect(afterDocument).toContain('固定说明')
    expect(afterDocument).toContain('固定备注 A')
    expect(afterDocument).toContain('固定备注 B')
    expect(afterDocument).toContain('完整响应 A')
    expect(afterDocument).toContain('完整响应 B')
    expect(afterDocument).not.toContain('待填写 A')
    expect(afterDocument).not.toContain('待填写 B')
    expect(afterDocument).not.toContain('{{正文}}')
    expect(afterDocument).toContain('正文内容。')
    expect(afterDocument.match(/<w:tbl>/gu)).toHaveLength(1)
    expect(afterDocument.match(/<w:sectPr/gu)?.length).toBe(beforeDocument.match(/<w:sectPr/gu)?.length ?? 0)
    expect(await after.file('word/header1.xml')!.async('nodebuffer')).toEqual(await before.file('word/header1.xml')!.async('nodebuffer'))
    expect(await after.file('word/footer1.xml')!.async('nodebuffer')).toEqual(await before.file('word/footer1.xml')!.async('nodebuffer'))
    const templateMedia = Object.keys(before.files).filter(path => path.startsWith('word/media/') && !before.files[path]?.dir)
    expect(templateMedia.length).toBeGreaterThan(0)
    for (const path of templateMedia) expect(await after.file(path)!.async('nodebuffer')).toEqual(await before.file(path)!.async('nodebuffer'))
    expect(Object.keys(after.files).filter(path => path.startsWith('word/media/dsh-'))).toHaveLength(1)
  })
})
