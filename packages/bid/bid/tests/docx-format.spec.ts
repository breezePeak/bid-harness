import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { BidWorkspace } from '../src/index.ts'
import { formatFields, resolveFormat, validateFormatValues } from '../src/docx-format.ts'
import { readDocxFormat, saveDocxFormat, saveDocxTemplate } from '../src/docx-format-store.ts'
import { DOCX_TEMPLATE_MAX_BYTES } from '../src/docx-format-contract.ts'
import { parseDocxTemplate, readDocxXml } from '../src/docx-template.ts'
import { renderDocx } from '../src/docx-render.ts'
import { suggestDocxFormat, validateFormatSuggestion } from '../src/docx-format-suggestions.ts'
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
  it('导出六级可编辑编号，标题文字不含手写序号，样式关联同一多级列表', async () => {
    const project = await workspace()
    const view = await readDocxFormat(project)
    const result = await renderDocx(project, '# 项目标题\n\n# **1 一级**\n\n## 1.1 二级\n\n### 1.1.1 三级\n\n#### 1.1.1.1 四级\n\n##### 1.1.1.1.1 五级\n\n###### 1.1.1.1.1.1 六级\n\n# 2 下一章\n\n# 插入新章', view.values)
    const zip = await JSZip.loadAsync(result.bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    const styles = await zip.file('word/styles.xml')!.async('string')
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    expect(document).toContain('<w:t xml:space="preserve">一级</w:t>')
    expect(document).not.toContain('>1 一级<')
    expect(document.match(/<w:numPr>/gu)).toHaveLength(8)
    const ids = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/gu)].map(match => match[1])
    expect(new Set(ids).size).toBe(1)
    for (let level = 1; level <= 6; level++) {
      const heading = new RegExp(`<w:style\\b[^>]*w:styleId="Heading${level}"[^>]*>[\\s\\S]*?<\\/w:style>`, 'u').exec(styles)?.[0]
      expect(heading).toContain(`<w:outlineLvl w:val="${level - 1}"/>`)
      expect(heading).toContain(`<w:numId w:val="${ids[0]}"/>`)
      expect(numbering).toContain(`<w:pStyle w:val="Heading${level}"/>`)
      expect(numbering).toContain(`<w:lvlText w:val="${Array.from({ length: level }, (_, index) => `%${index + 1}`).join('.')}"/>`)
    }
    expect(result.html).toContain('1.1.1.1 四级')
    expect(result.html).toContain('2 下一章')
    expect(result.html).toContain('3 插入新章')
    const none = await renderDocx(project, '# 项目标题\n\n# 1 一级', { ...view.values, 'numbering.mode': 'none' })
    const unnumbered = await JSZip.loadAsync(none.bytes)
    expect(await unnumbered.file('word/document.xml')!.async('string')).not.toContain('<w:numPr>')
    expect(none.html).not.toContain('1 一级')
  })
  it('原生编号保留模板起始值、中文格式及跨父级连续计数', async () => {
    const project = await workspace()
    const view = await readDocxFormat(project)
    const result = await renderDocx(project, '# 项目标题\n\n# 1 一级\n\n## 1.1 二级\n\n# 2 下一章\n\n## 2.1 二级', {
      ...view.values, 'numbering.mode': 'template', 'numbering.1.start': 3, 'numbering.1.format': 'chineseCounting',
      'numbering.1.text': '第%1章', 'numbering.2.restart': false,
    })
    const zip = await JSZip.loadAsync(result.bytes)
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    expect(numbering).toContain('<w:start w:val="3"/>')
    expect(numbering).toContain('<w:numFmt w:val="chineseCounting"/>')
    expect(numbering).toContain('<w:lvlText w:val="第%1章"/>')
    expect(numbering.match(/<w:lvlRestart w:val="0"\/>/gu)).toHaveLength(1)
    expect(result.html).toContain('第三章 一级')
    expect(result.html).toContain('四.2 二级')
    const parsed = await parseDocxTemplate(result.bytes, '原生编号.docx')
    expect(parsed.values).toMatchObject({ 'numbering.1.start': 3, 'numbering.1.format': 'chineseCounting',
      'numbering.1.text': '第%1章', 'numbering.2.restart': false })
  })
  it.each([
    { font: '楷体', color: 'A04020', italics: true, after: 240, size: 30 },
    { font: '仿宋', color: '207050', italics: false, after: 100, size: 22 },
  ])('从独立模板的默认值和继承链保留 $font、$color、$after 段距', async (spec) => {
    const zip = await JSZip.loadAsync(await template())
    zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="${spec.font}"/><w:color w:val="${spec.color}"/></w:rPr></w:rPrDefault>
      <w:pPrDefault><w:pPr><w:spacing w:before="80" w:after="${spec.after}"/></w:pPr></w:pPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:rPr><w:i w:val="${spec.italics}"/><w:sz w:val="${spec.size}"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Section"><w:name w:val="heading 4"/><w:basedOn w:val="Base"/><w:pPr><w:spacing w:before="0"/></w:pPr></w:style>
      </w:styles>`)
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Section"/></w:pPr><w:r><w:t>独立样式示例</w:t></w:r></w:p></w:body></w:document>')
    const project = await workspace()
    const saved = await saveDocxTemplate(project, { revision: 0, name: '继承规则.docx', bytes: await zip.generateAsync({ type: 'nodebuffer' }) })
    expect(saved.values).toMatchObject({ 'heading4.font': spec.font, 'heading4.color': spec.color,
      'heading4.italics': spec.italics, 'heading4.after': spec.after / 20, 'heading4.before': 0, 'heading4.size': spec.size / 2 })
    const result = await renderDocx(project, '# 文档标题\n\n#### 1.1.1.1 独立样式示例', saved.values)
    const output = await JSZip.loadAsync(result.bytes)
    const xml = await output.file('word/styles.xml')!.async('string')
    const heading = /<w:style\b[^>]*w:styleId="Heading4"[^>]*>[\s\S]*?<\/w:style>/u.exec(xml)?.[0]
    expect(heading).toContain(`w:color w:val="${spec.color}"`)
    expect(heading).toContain(`w:eastAsia="${spec.font}"`)
    expect(heading).toContain(`w:after="${spec.after}"`)
    expect(heading).toContain(spec.italics ? '<w:i/>' : '<w:i w:val="false"/>')
  })
  it('标题样式使用模板颜色、正斜体和间距，未声明间距不补入产品段后值', async () => {
    const project = await workspace()
    const zip = await JSZip.loadAsync(await template())
    const styles = await zip.file('word/styles.xml')!.async('string')
    zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="Fourth"><w:name w:val="heading 4"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>'))
    const source = await zip.file('word/document.xml')!.async('string')
    zip.file('word/document.xml', source.replace('<w:body>', '<w:body><w:p><w:pPr><w:pStyle w:val="Fourth"/></w:pPr><w:r><w:t>四级标题</w:t></w:r></w:p>'))
    const saved = await saveDocxTemplate(project, { revision: 0, name: '标题模板.docx', bytes: await zip.generateAsync({ type: 'nodebuffer' }) })
    expect(saved.values).toMatchObject({ 'body.after': 0, 'heading4.after': 0, 'heading4.italics': false, 'heading4.color': '000000' })
    const markdown = '# 当前项目\n\n#### 1.1.1.1 四级标题\n\n正文与*强调*。'
    const result = await renderDocx(project, markdown, saved.values)
    const output = await JSZip.loadAsync(result.bytes)
    const outputStyles = await output.file('word/styles.xml')!.async('string')
    const heading = /<w:style\b[^>]*w:styleId="Heading4"[^>]*>[\s\S]*?<\/w:style>/u.exec(outputStyles)?.[0]
    expect(heading).toContain('w:color w:val="000000"')
    expect(heading).toContain('w:i w:val="false"')
    expect(heading).toContain('w:after="0"')
    expect(heading).not.toContain('2E74B5')
    expect(result.html).toContain('font-style:normal;color:#000000')
    const custom = await saveDocxFormat(project, { revision: saved.state.revision, source: 'template', mapping: saved.state.mapping,
      overrides: { 'heading4.color': '123456', 'heading4.italics': true }, description: '' })
    const colored = await renderDocx(project, markdown, custom.values)
    expect(colored.html).toContain('font-style:italic;color:#123456')
    expect(() => validateFormatValues({ 'heading4.color': 'blue;display:none' }, saved.fields)).toThrow('六位十六进制')
    const coloredStyles = await zip.file('word/styles.xml')!.async('string')
    zip.file('word/styles.xml', coloredStyles.replace('<w:rPr><w:b/><w:sz w:val="32"/>', '<w:rPr><w:color w:val="123456"/><w:i/><w:b/><w:sz w:val="32"/>'))
    const parsed = await parseDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }), '彩色模板.docx')
    expect(parsed.candidates.find(item => item.id === 'Fourth')?.values).toMatchObject({ color: '123456', italics: true })
  })
  it('字符缩进优先于长度缩进，继承后按字符写入 Word，并刷新旧解析缓存', async () => {
    const zip = await JSZip.loadAsync(await template())
    const styles = await zip.file('word/styles.xml')!.async('string')
    zip.file('word/styles.xml', styles.replace('<w:spacing w:line="360"', '<w:ind w:firstLineChars="200" w:firstLine="200"/><w:spacing w:line="360"'))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const project = await workspace()
    const saved = await saveDocxTemplate(project, { revision: 0, name: '字符模板.docx', bytes })
    expect(saved.values).toMatchObject({ 'body.firstLine': 2, 'body.firstLineUnit': 'chars' })
    const rendered = await renderDocx(project, '正文', saved.values)
    const output = await JSZip.loadAsync(rendered.bytes)
    expect(await output.file('word/document.xml')!.async('string')).toContain('w:firstLineChars="200"')
    expect(rendered.html).toContain('text-indent:2em')
    const path = join(project.projectRoot, 'word-export/config.json')
    const stale = JSON.parse(await readFile(path, 'utf8')) as { template: { parserVersion?: number; candidates: unknown[] } }
    delete stale.template.parserVersion
    stale.template.candidates = []
    await writeFile(path, JSON.stringify(stale))
    const refreshed = await saveDocxTemplate(project, { revision: saved.state.revision, name: '字符模板.docx', bytes })
    expect(refreshed.values).toMatchObject({ 'body.firstLine': 2, 'body.firstLineUnit': 'chars' })
    zip.file('word/styles.xml', styles.replace('<w:spacing w:line="360"', '<w:ind w:firstLineChars="0" w:firstLine="200"/><w:spacing w:line="360"'))
    const zero = await parseDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }), '无缩进.docx')
    expect(zero.candidates.find(item => item.id === 'Normal')?.values).toMatchObject({ firstLine: 0, firstLineUnit: 'chars' })
  })
  it('格式识别以紧凑候选保留全部 441 个样式，记录实际模型输入并接受末尾候选', async () => {
    const view = await readDocxFormat(await workspace())
    const candidates = Array.from({ length: 441 }, (_, index) => ({
      id: `style-${index}`, name: `样式${index}`, role: 'body', sample: '正文格式样本'.repeat(25),
      values: { font: '宋体', latinFont: 'Times New Roman', size: 12, alignment: 'left', firstLine: 6.35, lineRule: 'auto', line: 1.5 },
    }))
    view.state.template = { hash: 'a'.repeat(64), name: '复杂模板.docx', candidates, values: {}, warnings: [] }
    expect(Buffer.byteLength(JSON.stringify(candidates))).toBeGreaterThan(64 * 1024)
    const generate = vi.fn(async (_request: GenerateOptions) => ({
      finish: { kind: 'stop' }, message: { content: [{ type: 'text', text: '{"changes":[],"mapping":{"body":"style-440"}}' }] },
    }))
    const append = vi.fn()
    // 该函数只读取模型路由并记录请求；文件解析及会话生命周期由各自测试覆盖。
    const ctx = { get: () => ({ generate }) } as unknown as Context
    const session = { id: 'format-test', requestHeader: () => ({ config: { provider: 'test', model: 'test' } }), append } as unknown as Session
    const result = await suggestDocxFormat(ctx, session, view, new AbortController().signal, 4096)
    expect(result.mapping.body).toBe('style-440')
    const request = generate.mock.calls[0]![0]
    const block = request.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('格式输入必须是文本')
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(64 * 1024)
    const input = JSON.parse(block.text) as { candidateColumns: string[]; candidates: unknown[][] }
    expect(input.candidateColumns).toEqual(['id', 'name', 'role', 'sample'])
    expect(input.candidates).toHaveLength(441)
    expect(input.candidates.at(-1)?.slice(0, 3)).toEqual(['style-440', '样式440', 'body'])
    const sample = input.candidates.at(-1)?.[3] as string
    expect(sample.length).toBeGreaterThan(0)
    expect(sample.length).toBeLessThanOrEqual(40)
    expect(candidates[440]!.sample.startsWith(sample)).toBe(true)
    expect(append.mock.calls[0]![0]).toBe('bid.word-format.request')
    const recorded = append.mock.calls[0]![1] as { messages: unknown }
    expect(recorded.messages).toEqual(request.messages)
    for (const candidate of candidates) candidate.name = '复杂样式'.repeat(50)
    await expect(suggestDocxFormat(ctx, session, view, new AbortController().signal, 4096)).rejects.toThrow('模板候选过多')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
  })
  it('完整保存超过 200 项实际使用的命名样式和直接格式，重新加载及缓存复用后仍可映射末尾候选', async () => {
    const zip = await JSZip.loadAsync(await template())
    const styles = await zip.file('word/styles.xml')!.async('string')
    zip.file('word/styles.xml', styles.replace('</w:styles>', Array.from({ length: 220 }, (_, index) =>
      `<w:style w:type="paragraph" w:styleId="Extra${index}"><w:name w:val="自定义${index}"/><w:basedOn w:val="Normal"/></w:style>`,
    ).join('') + '</w:styles>'))
    const document = await zip.file('word/document.xml')!.async('string')
    zip.file('word/document.xml', document.replace('<w:body>', '<w:body>' + Array.from({ length: 240 }, (_, index) =>
      `<w:p><w:pPr><w:pStyle w:val="Extra${index % 220}"/><w:spacing w:before="${index + 1}"/></w:pPr><w:r><w:t>格式样本${index}</w:t></w:r></w:p>`,
    ).join('')))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const project = await workspace()
    const saved = await saveDocxTemplate(project, { revision: 0, name: '复杂模板.docx', bytes })
    const candidates = saved.state.template!.candidates
    expect(candidates.length).toBeGreaterThan(460)
    expect(candidates.some(item => item.id === 'Extra219')).toBe(true)
    const last = candidates.find(item => item.sample === '格式样本239')!
    expect(last.values.before).toBe(12)
    expect(saved.state.mapping.body).toBe('Normal')
    const restored = await readDocxFormat(project)
    expect(restored.state.template?.candidates).toEqual(candidates)
    const mapped = await saveDocxFormat(project, {
      revision: restored.state.revision, source: 'template', mapping: { body: last.id }, overrides: {}, description: '',
    })
    expect(mapped.values['body.before']).toBe(12)
    const other = await saveDocxTemplate(project, { revision: mapped.state.revision, name: '简单模板.docx', bytes: await template() })
    const cached = await saveDocxTemplate(project, { revision: other.state.revision, name: '复杂模板.docx', bytes })
    expect(cached.state.template?.candidates).toEqual(candidates)
  })
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
  it('按声明的样式识别标题级别，局部字号不生成额外标题候选', async () => {
    const parsed = await parseDocxTemplate(await template(), '模板.docx')
    expect(parsed.candidates.find(item => item.id === 'Normal')?.values).toMatchObject({ font: '仿宋', latinFont: 'Arial', size: 14 })
    expect(parsed.candidates.filter(item => item.role === 'heading1')).toHaveLength(1)
    expect(parsed.candidates.find(item => item.role === 'heading1')?.values.size).toBe(20)
    expect(parsed.candidates.some(item => item.id === 'BaseBody')).toBe(false)
    expect(parsed.values).toMatchObject({ 'page.paper': 'A4', 'page.left': 25.4, 'page.header': 12.7 })
    const project = await workspace()
    const initial = await readDocxFormat(project)
    const bytes = await template()
    const saved = await saveDocxTemplate(project,
      { revision: 0, name: '模板.docx', bytes })
    expect(initial.state.opened).toBe(false)
    expect(saved.sources['heading1.size']).toBe('模板提取')
    expect(saved.state.mapping.heading1).toBe('ChapterStyle')
    expect(saved.state.mapping.body).toBe('Normal')
    expect(saved.values['body.size']).toBe(14)
    const renamed = await saveDocxTemplate(project,
      { revision: saved.state.revision, name: '公司模板.docx', bytes })
    expect(renamed.state.template?.name).toBe('公司模板.docx')
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
  it('拒绝无效 DOCX、DTD、循环样式和路径逃逸', async () => {
    await expect(readDocxXml({ length: DOCX_TEMPLATE_MAX_BYTES + 1 } as Uint8Array)).rejects.toThrow('不超过 300 MiB')
    await expect(readDocxXml(Buffer.from('not zip'))).rejects.toThrow('有效的 DOCX')
    const bytes = await template()
    for (const [path, content, message] of [
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
  it('只提取 XML，不执行宏、控件或嵌入对象', async () => {
    const zip = await JSZip.loadAsync(await template())
    zip.file('word/vbaProject.bin', 'macro')
    zip.file('word/activeX/activeX1.bin', 'control')
    zip.file('word/embeddings/oleObject1.bin', 'attachment')
    zip.file('word/media/image1.png', Buffer.alloc(33 * 1024 * 1024))
    const parsed = await parseDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }), '兼容模板.docx')
    expect(parsed.candidates.length).toBeGreaterThan(0)
  })
  it('拒绝格式 XML 解压超过 32 MiB 的模板', async () => {
    const zip = await JSZip.loadAsync(await template())
    zip.file('word/document.xml', ' '.repeat(32 * 1024 * 1024 + 1))
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    await expect(parseDocxTemplate(bytes, '超大XML.docx')).rejects.toThrow('DOCX 格式 XML 解压后超过 32 MiB 限制。')
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
    expect([1, 2, 2, 1, 2].map(number)).toEqual(['第一章', '一.1', '一.2', '第二章', '二.3'])
  })
})
