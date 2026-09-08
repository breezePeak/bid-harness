import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { describe, expect, it } from 'vitest'
import type { BidWorkspace } from '../src/index.ts'
import { formatFields, resolveFormat, validateFormatValues } from '../src/docx-format.ts'
import { readDocxFormat, saveDocxFormat, saveDocxTemplate } from '../src/docx-format-store.ts'
import { DOCX_TEMPLATE_MAX_BYTES } from '../src/docx-format-contract.ts'
import { parseDocxTemplate, readDocxXml } from '../src/docx-template.ts'
import { renderDocx } from '../src/docx-render.ts'
import { validateFormatSuggestion } from '../src/docx-format-suggestions.ts'
import { createHeadingNumberer } from '../src/docx-numbering.ts'
const defaults = { font: '宋体', bodySize: 24, headingSize: 32 }
async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-word-format-'))
  // 这些纯文件函数不依赖 Host；只提供它们实际读取的工作区字段。
  return { root, projectRoot: root, config: defaults } as BidWorkspace
}
async function template(): Promise<Buffer> {
  return Packer.toBuffer(new Document({ styles: { paragraphStyles: [
    { id: 'BaseBody',
      name: 'Base Body',
      run: { font: { eastAsia: '仿宋',
        ascii: 'Arial' },
      size: 28 },
      paragraph: { spacing: { line: 360 } } },
    { id: 'Normal', name: 'Normal', basedOn: 'BaseBody' },
    { id: 'ChapterStyle', name: '章标题', paragraph: { outlineLevel: 0 }, run: { size: 40 } },
  ] },
  sections: [{ properties: { page: { margin: { left: 1440,
    right: 1440,
    header: 720 },
  size: { width: 11906,
    height: 16838 } } },
  children: [
    new Paragraph({ style: 'Normal', children: [new TextRun('旧公司正文')] }),
    new Paragraph({ style: 'ChapterStyle', children: [new TextRun('第一章 旧项目')] }),
    new Paragraph({ style: 'ChapterStyle', children: [new TextRun({ text: '手动变体', size: 48 })] }),
  ] }] }))
}
describe('项目 Word 格式链路', () => {
  it('提示招标格式条款与明确冲突，不将未解析的要求标记为符合', async () => {
    const project = await workspace()
    await mkdir(join(project.projectRoot, 'analysis'))
    await writeFile(join(project.projectRoot, 'analysis/requirements.json'), JSON.stringify({
      schema_version: 1,
      requirements: [{ id: 'R1', category: '格式', raw_text: '正文字号为15磅。正文使用仿宋。',
        normalized_requirement: '正文字号为15磅。正文使用仿宋。', mandatory: true,
        source_refs: [{ file_id: 'F1', chunk: 'chunk-1', line_start: 1, line_end: 1 }] }],
    }))
    const view = await readDocxFormat(project)
    expect(view.warnings).toContain('格式冲突：招标要求正文字号 15 磅，当前为 12 磅。')
    expect(view.warnings).toContain('格式冲突：招标要求正文字体 仿宋，当前为 宋体。')
    const saved = await saveDocxFormat(project, {
      revision: 0, source: 'default', mapping: {}, description: '', overrides: { 'body.size': 15, 'body.font': '仿宋' },
    })
    expect(saved.warnings.some(message => message.startsWith('格式冲突'))).toBe(false)
    expect(saved.warnings.some(message => message.startsWith('招标格式要求（请核对）'))).toBe(true)
  })
  it('读取继承及直接格式变体，含多个一级标题候选时明确待确认', async () => {
    const parsed = await parseDocxTemplate(await template(), '模板.docx')
    expect(parsed.candidates.find(item => item.id === 'Normal')?.values).toMatchObject({ font: '仿宋', latinFont: 'Arial', size: 14 })
    expect(parsed.candidates.some(item => item.values.size === 24 && item.sample === '手动变体')).toBe(true)
    expect(parsed.values).toMatchObject({ 'page.paper': 'A4', 'page.left': 25.4, 'page.header': 12.7 })
    const project = await workspace()
    const initial = await readDocxFormat(project)
    const saved = await saveDocxTemplate(project,
      { revision: 0, name: '模板.docx', bytes: await template() })
    expect(initial.state.opened).toBe(false)
    expect(saved.sources['heading1.size']).toBe('待确认')
    expect(saved.state.mapping.body).toBe('Normal')
    expect(saved.values['body.size']).toBe(14)
  })
  it('跨工作区实例恢复配置、保留手动覆盖并拒绝旧版本与非法字段', async () => {
    const project = await workspace()
    const first = await saveDocxFormat(project,
      { revision: 0,
        source: 'default',
        mapping: {},
        overrides: { 'body.size': 15 },
        description: '正文15磅' })
    const second = await readDocxFormat({ root: project.root, projectRoot: project.projectRoot, config: project.config } as BidWorkspace)
    expect(second.state).toEqual(first.state)
    expect(second.values['body.size']).toBe(15)
    expect(second.sources['body.size']).toBe('用户修改')
    await expect(saveDocxFormat(project,
      { revision: 0,
        source: 'default',
        mapping: {},
        overrides: {},
        description: '' })).rejects.toThrow('其他页面')
    expect(() => validateFormatValues({ '../path': 'x' }, formatFields(defaults))).toThrow('配置无效')
    expect(() => validateFormatValues({ 'body.size': -1 }, formatFields(defaults))).toThrow('配置无效')
    expect(() => validateFormatValues({ 'numbering.1.text': '%2' }, formatFields(defaults))).toThrow('不能引用下级')
  })
  it('用同一配置渲染标题、富文本、嵌套列表、表格和图片，不带旧模板文字', async () => {
    const project = await workspace()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(project.root, 'image.png'), png)
    const view = resolveFormat({ version: 1,
      revision: 0,
      opened: true,
      source: 'default',
      mapping: {},
      overrides: { 'body.size': 15,
        'heading1.size': 22,
        'header.text': '当前项目' },
      description: '' },
    formatFields(defaults))
    const markdown = '# 当前项目技术标\n\n# 1 实施方案\n\n**加粗**与*斜体*和[链接](https://example.com)。\n\n1. 一级\n   - 二级\n\n| 表头 | 说明 |\n| --- | --- |\n| 单元格 | **值** |\n\n![示意图](image.png)\n\n```txt\n# 代码内容\n```'
    const result = await renderDocx(project, markdown, view.values)
    await expect(readDocxXml(result.bytes)).resolves.toBeDefined()
    const zip = await JSZip.loadAsync(result.bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('w:val="Title"')
    expect(xml).toContain('w:val="Heading1"')
    expect(xml).toContain('w:sz w:val="30"')
    expect(xml).toContain('w:sz w:val="44"')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('w:drawing')
    expect(result.html).toContain('<strong>加粗</strong>')
    expect(result.html).toContain('font-size:15pt')
    expect(result.html).toContain('data:image/png;base64,')
    expect(xml).not.toContain('旧公司')
    await expect(renderDocx(project, '<script>bad</script>', view.values)).rejects.toThrow('第 1 行不支持 html')
    await expect(renderDocx(project, '![远程](https://example.com/a.png)', view.values)).rejects.toThrow('不自动访问外部资源')
  })
  it('拒绝无效 DOCX、DTD、活动内容、循环样式和路径逃逸', async () => {
    await expect(readDocxXml({ length: DOCX_TEMPLATE_MAX_BYTES + 1 } as Uint8Array)).rejects.toThrow('不超过 300 MiB')
    await expect(readDocxXml(Buffer.from('not zip'))).rejects.toThrow('有效的 DOCX')
    const bytes = await template()
    for (const [path, content, message] of [
      ['word/activeX/active.xml', '<x/>', '活动控件'],
      ['../escaped.xml', '<x/>', '不安全路径'],
      ['word/document.xml', '<!DOCTYPE x [<!ENTITY b "boom">]><x/>', 'DTD'],
    ]) {
      const zip = await JSZip.loadAsync(bytes)
      zip.file(path!, content!)
      await expect(readDocxXml(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(message!)
    }
    const zip = await JSZip.loadAsync(bytes)
    zip.file('word/styles.xml',
      '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:basedOn w:val="Normal"/></w:style></w:styles>')
    await expect(parseDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }), '坏模板.docx')).rejects.toThrow('循环继承')
  })
  it('模型只能建议有用户原话的合法字段和存在的候选', async () => {
    const view = await saveDocxFormat(await workspace(),
      { revision: 0,
        source: 'default',
        overrides: {},
        mapping: {},
        description: '正文15磅' })
    expect(validateFormatSuggestion({ changes: [{ key: 'body.size',
      value: 15,
      evidence: '正文15磅' }],
    mapping: {} },
    view).overrides).toEqual({ 'body.size': 15 })
    expect(() => validateFormatSuggestion({ changes: [{ key: 'body.size',
      value: 15,
      evidence: '不存在的原话' }],
    mapping: {} },
    view)).toThrow('用户原话')
    expect(() => validateFormatSuggestion({ changes: [], mapping: { body: 'invented' } }, view)).toThrow('不存在')
  })
  it('模板编号按层级重启或连续，编号文字只生成一次', async () => {
    const view = await saveDocxFormat(await workspace(),
      { revision: 0,
        source: 'default',
        overrides: { 'numbering.mode': 'template',
          'numbering.1.format': 'chineseCounting',
          'numbering.1.text': '第%1章',
          'numbering.2.text': '%1.%2',
          'numbering.2.restart': false },
        mapping: {},
        description: '' })
    const number = createHeadingNumberer(view.values)
    expect(['1', '1.1', '1.2', '2', '2.1'].map(number)).toEqual(['第一章', '一.1', '一.2', '第二章', '二.3'])
  })
})
