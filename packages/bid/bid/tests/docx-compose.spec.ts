import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Footer, Header, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, VerticalMergeType, type ITableCellOptions } from 'docx'
import { describe, expect, it } from 'vitest'
import { composeDocxFromTemplate, inspectDocxTemplateStructure } from '../src/docx-compose.ts'
import { defaultDocxFormatState, formatFields } from '../src/docx-format.ts'
import { readBuiltInDocxTemplateBytes } from '../src/docx-format-store.ts'
import type { BidWorkspace } from '../src/index.ts'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
const paragraph = (value: string) => new Paragraph(value)
const cell = (value: string, options: Omit<ITableCellOptions, 'children'> = {}) => new TableCell({
  children: [new Paragraph({ indent: { firstLine: 480 }, children: [new TextRun(value)] })],
  ...options,
})

async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-docx-compose-'))
  return { root, projectRoot: root, config: { font: '宋体', bodySize: 24, headingSize: 32 } } as BidWorkspace
}

async function template(includeTableCaption = true, tableCaptionStyle?: string): Promise<Buffer> {
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
      children: [
        ...(includeTableCaption ? [tableCaptionStyle === undefined
          ? paragraph('技术偏离表')
          : new Paragraph({ style: tableCaptionStyle, children: [new TextRun('技术偏离表')] })] : []),
        table, paragraph('固定说明'),
      ] },
  ] }))
}

describe('DOCX 模板合成', () => {
  it('按固定章节唯一六列表格填满内置技术偏离表', async () => {
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const rows = [1, 2, 3].map(index => `| ${index} | 智慧平台 | 技术要求 ${index} 的完整原文 | 我方将执行具体响应措施 ${index}、完成验证并保留交付记录。 | 满足、响应 | |`).join('\n')
    const markdown = `# 技术标\n\n# 技术偏离表\n\n表 技术偏离表\n\n| 序号 | 标的名称 | 招标技术要求 | 投标响应内容 | 偏离程度 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n# 实施方案\n\n正文。\n`
    const result = await composeDocxFromTemplate(project, await readBuiltInDocxTemplateBytes(), markdown, values, {}, 'svg', {
      omitSourceTitle: true, fixedSectionTitle: '技术偏离表',
    })
    const document = await (await JSZip.loadAsync(result.bytes)).file('word/document.xml')!.async('string')
    const table = document.match(/<w:tbl>[^]*?dsh-technical-deviation-table[^]*?<\/w:tbl>/u)?.[0] ?? ''
    const outputRows = table.match(/<w:tr(?:\s[^>]*)?>[^]*?<\/w:tr>/gu) ?? []
    expect(outputRows).toHaveLength(4)
    expect(outputRows.map(row => row.match(/<w:tc>/gu)?.length)).toEqual([6, 6, 6, 6])
    for (const value of ['智慧平台', '技术要求 1 的完整原文', '技术要求 2 的完整原文', '技术要求 3 的完整原文',
      '我方将执行具体响应措施 1、完成验证并保留交付记录。', '我方将执行具体响应措施 2、完成验证并保留交付记录。',
      '我方将执行具体响应措施 3、完成验证并保留交付记录。', '满足、响应']) expect(table).toContain(value)
    expect(table).not.toMatch(/<w:(?:gridSpan|vMerge)\b/u)
  })

  it('合并 numbering 定义时同步源根节点使用的命名空间', async () => {
    const templateZip = await JSZip.loadAsync(await readBuiltInDocxTemplateBytes())
    const targetNumbering = await templateZip.file('word/numbering.xml')!.async('string')
    templateZip.file('word/numbering.xml', targetNumbering.replace(/\sxmlns:w15="[^"]+"/u, ''))
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const markdown = '# 技术标\n\n# 技术偏离表\n\n表 技术偏离表\n\n| 序号 | 标的名称 | 招标技术要求 | 投标响应内容 | 偏离程度 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 平台 | 系统应支持审计日志 | 我方将启用审计日志、执行留存检索并完成核验记录。 | 满足、响应 | |\n\n# 实施方案\n\n## 交付步骤\n\n正文。\n'
    const result = await composeDocxFromTemplate(project, await templateZip.generateAsync({ type: 'nodebuffer' }), markdown, values, {}, 'svg', {
      omitSourceTitle: true, fixedSectionTitle: '技术偏离表',
    })
    const numbering = await (await JSZip.loadAsync(result.bytes)).file('word/numbering.xml')!.async('string')
    expect(numbering).toContain('w15:restartNumberingAfterBreak')
    expect(numbering).toMatch(/xmlns:w15="[^"]+"/u)
    const declared = new Set([...numbering.matchAll(/xmlns:([\w.-]+)=/gu)].map(match => match[1]))
    const used = new Set([...numbering.matchAll(/<(?:\/)?([\w.-]+):|\s([\w.-]+):[\w.-]+=/gu)]
      .flatMap(match => [match[1], match[2]]).filter((prefix): prefix is string => prefix !== undefined && !['xml', 'xmlns'].includes(prefix)))
    expect([...used].filter(prefix => !declared.has(prefix))).toEqual([])
  })

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
    const markdown = '# 技术标\n\n## 技术偏离表\n\n表前说明。\n\n表 响应表\n\n| 技术条款 | 响应情况 | 偏离说明 |\n| --- | --- | --- |\n| 服务范围 | 完整响应 A | 无偏离 |\n| 交付期限 | 完整响应 B | 无偏离 |\n\n## 实施方案\n\n正文内容。\n\n![示意图](assets/pixel.png)\n'
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const [before, after] = await Promise.all([JSZip.loadAsync(original), JSZip.loadAsync(result.bytes)])
    const [beforeDocument, afterDocument] = await Promise.all([
      before.file('word/document.xml')!.async('string'), after.file('word/document.xml')!.async('string'),
    ])

    expect(afterDocument).toContain('固定封面')
    expect(afterDocument).toContain('固定说明')
    expect(afterDocument).toContain('表前说明。')
    expect(afterDocument).toContain('固定备注 A')
    expect(afterDocument).toContain('固定备注 B')
    expect(afterDocument).toContain('完整响应 A')
    expect(afterDocument).toContain('完整响应 B')
    expect(afterDocument).not.toContain('待填写 A')
    expect(afterDocument).not.toContain('待填写 B')
    expect(afterDocument).not.toContain('{{正文}}')
    expect(afterDocument).toContain('正文内容。')
    expect(afterDocument.match(/<w:tbl>/gu)).toHaveLength(1)
    const tableXml = afterDocument.match(/<w:tbl>[\s\S]*?<\/w:tbl>/u)?.[0] ?? ''
    expect(tableXml).toContain('<w:ind w:firstLine="0" w:firstLineChars="0"/>')
    expect(tableXml).not.toContain('w:firstLine="480"')
    expect(afterDocument.match(/<w:sectPr/gu)?.length).toBe(beforeDocument.match(/<w:sectPr/gu)?.length ?? 0)
    expect(await after.file('word/header1.xml')!.async('nodebuffer')).toEqual(await before.file('word/header1.xml')!.async('nodebuffer'))
    expect(await after.file('word/footer1.xml')!.async('nodebuffer')).toEqual(await before.file('word/footer1.xml')!.async('nodebuffer'))
    const templateMedia = Object.keys(before.files).filter(path => path.startsWith('word/media/') && !before.files[path]?.dir)
    expect(templateMedia.length).toBeGreaterThan(0)
    for (const path of templateMedia) expect(await after.file(path)!.async('nodebuffer')).toEqual(await before.file(path)!.async('nodebuffer'))
    expect(Object.keys(after.files).filter(path => path.startsWith('word/media/dsh-'))).toHaveLength(1)
  })

  it('模板没有表题时把源表题移到目标表格上方并保留表前说明', async () => {
    const original = await template(false)
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const markdown = '# 技术标\n\n表前说明。\n\n表 响应表\n\n| 技术条款 | 响应情况 | 偏离说明 |\n| --- | --- | --- |\n| 服务范围 | 完整响应 | 无偏离 |\n'
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const zip = await JSZip.loadAsync(result.bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    const captionStart = document.indexOf('<w:pStyle w:val="DshTableCaption"/>')
    const tableStart = document.indexOf('<w:tbl>')
    expect(captionStart).toBeGreaterThan(-1)
    expect(captionStart).toBeLessThan(tableStart)
    expect(document.slice(captionStart, tableStart)).toContain('响应表')
    expect(document.match(/响应表/gu)).toHaveLength(1)
    expect(document).toContain('表前说明。')
  })

  it('模板已有明确表题时保留目标题注并删除重复源题注', async () => {
    const original = await template(true, 'DshTableCaption')
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const markdown = '# 技术标\n\n表 响应表\n\n| 技术条款 | 响应情况 | 偏离说明 |\n| --- | --- | --- |\n| 服务范围 | 完整响应 | 无偏离 |\n'
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const zip = await JSZip.loadAsync(result.bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    expect(document).not.toContain('响应表')
    expect(document).toContain('技术偏离表')
  })

  it('渲染流程图时图片在图题之前且图题使用 DshFigureCaption，无重复编号', async () => {
    const original = await template(false)
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const spec = {
      type: 'flowchart' as const,
      schema_version: 1 as const,
      id: 'FLOW-SEC-1-1',
      title: '项目实施组织架构图',
      direction: 'TB' as const,
      nodes: [
        { id: 'N1', type: 'start' as const, text: '启动' },
        { id: 'N2', type: 'end' as const, text: '结束' },
      ],
      edges: [{ from: 'N1', to: 'N2' }],
    }
    const markdown = `# 技术标\n\n\`\`\`flowchart\n${JSON.stringify(spec)}\n\`\`\`\n`
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const zip = await JSZip.loadAsync(result.bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    const imagePos = document.indexOf('<w:drawing>')
    const captionPos = document.indexOf('<w:pStyle w:val="DshFigureCaption"/>')
    expect(imagePos).toBeGreaterThan(-1)
    expect(captionPos).toBeGreaterThan(-1)
    expect(imagePos).toBeLessThan(captionPos)
    expect(document).toContain('项目实施组织架构图')
    expect(document).not.toContain('图 1 项目实施组织架构图')
  })

  it('模板合成时在 styles.xml 中补齐 DshFigureCaption 与 DshTableCaption', async () => {
    const original = await template(false)
    const project = await workspace()
    const values = defaultDocxFormatState(formatFields(project.config)).resolved
    const spec = {
      type: 'flowchart' as const,
      schema_version: 1 as const,
      id: 'FLOW-SEC-1-1',
      title: '测试图',
      direction: 'TB' as const,
      nodes: [
        { id: 'N1', type: 'start' as const, text: '启动' },
        { id: 'N2', type: 'end' as const, text: '结束' },
      ],
      edges: [{ from: 'N1', to: 'N2' }],
    }
    const markdown = `# 技术标\n\n\`\`\`flowchart\n${JSON.stringify(spec)}\n\`\`\`\n\n表 测试表\n\n| 列 |\n| --- |\n| 内容 |\n`
    const result = await composeDocxFromTemplate(project, original, markdown, values)
    const zip = await JSZip.loadAsync(result.bytes)
    const styles = await zip.file('word/styles.xml')!.async('string')
    expect(styles).toContain('DshFigureCaption')
    expect(styles).toContain('DshTableCaption')
  })
})
