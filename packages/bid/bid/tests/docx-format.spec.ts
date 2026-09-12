import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { BidWorkspace } from '../src/index.ts'
import { defaultDocxFormatState, formatFields, resolveFormat, validateFormatValues } from '../src/docx-format.ts'
import { readDocxFormat, saveDocxFormat, saveDocxFormatInterpretation, saveDocxTemplate } from '../src/docx-format-store.ts'
import { DOCX_TEMPLATE_MAX_BYTES, DOCX_TEMPLATE_PARSER_VERSION } from '../src/docx-format-contract.ts'
import { parseDocxTemplate, readDocxXml } from '../src/docx-template.ts'
import { renderDocx } from '../src/docx-render.ts'
import { suggestDocxFormat, validateFormatSuggestion } from '../src/docx-format-suggestions.ts'
import { createCaptionNumberer, createHeadingNumberer } from '../src/docx-numbering.ts'

const defaults = { font: '宋体', bodySize: 24, headingSize: 32 }
async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-word-format-'))
  return { root, projectRoot: root, config: defaults } as BidWorkspace
}
async function template(): Promise<Buffer> {
  return Packer.toBuffer(new Document({ styles: { paragraphStyles: [
    { id: 'Normal', name: 'Normal', run: { font: { eastAsia: '仿宋', ascii: 'Arial' }, size: 28 },
      paragraph: { spacing: { line: 360 } } },
    { id: 'ChapterStyle', name: 'Heading 1', paragraph: { outlineLevel: 0 }, run: { size: 40 } },
    { id: 'Caption', name: 'Caption', run: { size: 24 }, paragraph: { alignment: 'center' } },
  ] }, sections: [{ properties: { page: { margin: { left: 1440, right: 1440, header: 720 },
    size: { width: 11906, height: 16838 } } }, children: [
    new Paragraph({ style: 'Normal', children: [new TextRun('正文小四宋体，英文及数字 Times New Roman，首行缩进 2 字符，1.5 倍行距。')] }),
    new Paragraph({ style: 'ChapterStyle', children: [new TextRun({ text: '第一章 标题', size: 48, font: { eastAsia: '宋体' } })] }),
    new Paragraph({ style: 'Caption', children: [new TextRun({ text: '图1 图片标题', size: 26 })] }),
    new Paragraph({ style: 'Caption', children: [new TextRun({ text: '表1 表格标题', size: 26 })] }),
  ] }] }))
}

describe('项目 Word 格式链路', () => {
  it('角色识别后仍合并 Named Style、段落和 Run 直接格式并保留冲突', async () => {
    const parsed = await parseDocxTemplate(await template(), '模板.docx')
    const heading = parsed.extracted.candidates.filter(candidate => candidate.roles.includes('heading1'))
    expect(heading.some(candidate => candidate.id === 'ChapterStyle' && candidate.values.size === 20)).toBe(true)
    expect(heading.some(candidate => candidate.id.startsWith('direct-') && candidate.values.size === 24 && candidate.values.font === '宋体')).toBe(true)
    const saved = await saveDocxTemplate(await workspace(), { revision: 0, name: '模板.docx', bytes: await template() })
    expect(saved.state.conflicts.find(conflict => conflict.key === 'heading1.size')).toMatchObject({
      resolvedValue: 24,
      status: 'conflict',
    })
    expect(saved.state.resolved['heading1.font']).toBe('宋体')
  })

  it('把 asciiTheme、hAnsiTheme 和 eastAsiaTheme 解析为 Theme 中的真实字体', async () => {
    const zip = await JSZip.loadAsync(await template())
    zip.file('word/theme/theme1.xml', '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Custom"><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface="宋体"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="等线"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>')
    zip.file('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="majorEastAsia"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>')
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>')
    const parsed = await parseDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }), 'Theme.docx')
    const normal = parsed.extracted.candidates.find(candidate => candidate.id === 'Normal')
    expect(normal?.values).toMatchObject({ font: '宋体', latinFont: 'Arial' })
    expect(Object.values(normal?.values ?? {})).not.toContain('majorEastAsia')
    expect(Object.values(normal?.values ?? {})).not.toContain('minorAscii')
  })

  it('模型只把模板正文中的明确格式说明写入 modelInterpreted', async () => {
    const project = await workspace()
    const extracted = await saveDocxTemplate(project, { revision: 0, name: '说明模板.docx', bytes: await template() })
    const suggestion = validateFormatSuggestion({ rules: [
      { key: 'body.font', value: '宋体', evidence: '正文小四宋体' },
      { key: 'body.size', value: '小四', evidence: '正文小四宋体' },
      { key: 'body.latinFont', value: 'Times New Roman', evidence: '英文及数字 Times New Roman' },
      { key: 'body.firstLine', value: '2字符', evidence: '首行缩进 2 字符' },
      { key: 'body.line', value: '1.5倍', evidence: '1.5 倍行距' },
    ], mapping: { body: 'Normal' } }, extracted)
    const saved = await saveDocxFormatInterpretation(project, extracted.state.revision, suggestion)
    expect(saved.state.modelInterpreted.values).toMatchObject({ 'body.font': '宋体', 'body.latinFont': 'Times New Roman',
      'body.size': 12, 'body.firstLine': 2, 'body.firstLineUnit': 'chars', 'body.line': 1.5, 'body.lineRule': 'auto' })
    expect(saved.state.modelInterpreted.evidence.find(item => item.key === 'body.size')?.value).toBe(12)
    expect(saved.state.resolved['body.font']).toBe('宋体')
    expect(() => validateFormatSuggestion({ rules: [{ key: 'body.size', value: 15, evidence: '模板里没有这句话' }], mapping: {} }, extracted)).toThrow('模板原文')
  })

  it('在严格字段校验前统一转换模板说明中的字号、行距和缩进', () => {
    const fields = formatFields(defaults)
    const source = '各级标题均为三号宋体，正文（包括图表标题）小四宋体，首行缩进2字符，段前段后0行，行距1.5倍。'
    const view = resolveFormat(defaultDocxFormatState(fields), fields)
    view.state.extracted.paragraphs = [source]
    const suggestion = validateFormatSuggestion({ rules: [
      ...Array.from({ length: 6 }, (_, index) => ({ key: `heading${String(index + 1)}.size`, value: '三号', evidence: source })),
      { key: 'body.size', value: '小四', evidence: source },
      { key: 'figureCaption.size', value: '小四', evidence: source },
      { key: 'tableCaption.size', value: '小四', evidence: source },
      { key: 'body.firstLine', value: '2字符', evidence: source },
      { key: 'body.before', value: '0行', evidence: source },
      { key: 'body.after', value: '0行', evidence: source },
      { key: 'body.line', value: '1.5倍', evidence: source },
    ], mapping: {} }, view)
    expect(suggestion.values).toMatchObject({
      'heading1.size': 16,
      'heading6.size': 16,
      'body.size': 12,
      'figureCaption.size': 12,
      'tableCaption.size': 12,
      'body.firstLine': 2,
      'body.firstLineUnit': 'chars',
      'body.before': 0,
      'body.after': 0,
      'body.line': 1.5,
      'body.lineRule': 'auto',
    })
    expect(Object.values(suggestion.values).some(value => typeof value === 'string' && /号|磅|pt|字符|倍|行/iu.test(value))).toBe(false)
    expect(suggestion.evidence.find(item => item.key === 'body.firstLineUnit')).toMatchObject({ value: 'chars', text: source })
  })

  it('Word Caption 和题注样式可同时映射图题与表题并保留多个样本', async () => {
    const parsed = await parseDocxTemplate(await template(), '题注.docx')
    const caption = parsed.extracted.candidates.find(candidate => candidate.id === 'Caption')
    expect(caption?.roles).toEqual(['figureCaption', 'tableCaption'])
    expect(caption?.samples).toEqual(['图1 图片标题', '表1 表格标题'])
    const direct = parsed.extracted.candidates.find(candidate => candidate.id.startsWith('direct-')
      && candidate.samples.includes('图1 图片标题'))
    expect(direct?.roles).toEqual(['figureCaption', 'tableCaption'])
    expect(direct?.samples).toEqual(['图1 图片标题', '表1 表格标题'])
    expect(parsed.extracted.values).toMatchObject({
      'figureCaption.numbering.prefix': '图',
      'tableCaption.numbering.prefix': '表',
    })
  })

  it('同一字段保存所有相异证据及优先级选出的 resolvedValue', async () => {
    const fields = formatFields(defaults)
    const state = defaultDocxFormatState(fields)
    state.extracted.candidates = [{ id: 'caption', name: 'Caption', roles: ['tableCaption'], samples: ['表1'],
      values: { size: 16 }, evidence: [
        { key: 'size', value: 12, source: 'named_style', text: 'Caption 样式' },
        { key: 'size', value: 16, source: 'direct_format', text: '表1' },
      ] }]
    state.modelInterpreted = { values: { 'tableCaption.size': 14 }, mapping: { tableCaption: 'caption' }, evidence: [
      { key: 'tableCaption.size', value: 14, source: 'template_instruction', text: '表题使用 14 磅' },
    ] }
    const view = resolveFormat(state, fields)
    const conflict = view.state.conflicts.find(item => item.key === 'tableCaption.size')
    expect(conflict?.evidence.map(item => item.value)).toEqual(expect.arrayContaining([12, 16, 14]))
    expect(conflict).toMatchObject({ resolvedValue: 14, status: 'conflict' })
  })

  it('用户确认冲突后只更新 userConfirmed 和 resolved', async () => {
    const project = await workspace()
    const extracted = await saveDocxTemplate(project, { revision: 0, name: '冲突模板.docx', bytes: await template() })
    const confirmed = await saveDocxFormat(project, { revision: extracted.state.revision,
      userConfirmed: { 'heading1.size': 20 } })
    expect(confirmed.state.extracted).toEqual(extracted.state.extracted)
    expect(confirmed.state.modelInterpreted).toEqual(extracted.state.modelInterpreted)
    expect(confirmed.state.userConfirmed).toEqual({ 'heading1.size': 20 })
    expect(confirmed.state.resolved['heading1.size']).toBe(20)
    expect(confirmed.state.conflicts.find(conflict => conflict.key === 'heading1.size')?.status).toBe('confirmed')
    await expect(saveDocxFormat(project, { revision: confirmed.state.revision,
      userConfirmed: { 'heading1.size': 21 } })).rejects.toThrow('候选')
    const replaced = await saveDocxTemplate(project, { revision: confirmed.state.revision,
      name: '替换模板.docx', bytes: await template() })
    expect(replaced.state.userConfirmed).toEqual({})
    expect(replaced.state.conflicts.find(conflict => conflict.key === 'heading1.size')?.status).toBe('conflict')
  })

  it('浏览器 HTML 与最终 DOCX 使用同一份 resolved 格式和原生图表编号', async () => {
    const project = await workspace()
    const fields = formatFields(defaults)
    const state = defaultDocxFormatState(fields)
    state.userConfirmed = {}
    const view = resolveFormat({ ...state, modelInterpreted: { values: { 'body.size': 15 }, mapping: {}, evidence: [
      { key: 'body.size', value: 15, source: 'template_instruction', text: '正文 15 磅' },
    ] } }, fields)
    const rendered = await renderDocx(project, '正文\n\n图 图片标题\n\n表 表格标题', view.state.resolved)
    const zip = await JSZip.loadAsync(rendered.bytes)
    const styles = await zip.file('word/styles.xml')!.async('string')
    const document = await zip.file('word/document.xml')!.async('string')
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    expect(rendered.html).toContain('font-size:15pt')
    expect(styles).toContain('<w:sz w:val="30"/>')
    expect(document.match(/<w:numPr>/gu)).toHaveLength(2)
    expect(numbering).toContain('<w:lvlText w:val="图%1 "/>')
    expect(numbering).toContain('<w:lvlText w:val="表%1 "/>')
    expect(document).not.toContain('图 图片标题')
  })

  it('自动模型请求包含实际模板正文和多角色候选并记录到会话', async () => {
    const project = await workspace()
    const view = await saveDocxTemplate(project, { revision: 0, name: '模型模板.docx', bytes: await template() })
    const generate = vi.fn(async (_request: GenerateOptions) => ({ finish: { kind: 'stop' }, message: { content: [{ type: 'text', text: '{"rules":[{"key":"body.font","value":"宋体","evidence":"正文小四宋体"}],"mapping":{"figureCaption":"Caption","tableCaption":"Caption"}}' }] } }))
    const append = vi.fn()
    const ctx = { get: () => ({ generate }) } as unknown as Context
    const session = { id: 'format-test', requestHeader: () => ({ config: { provider: 'test', model: 'test' } }), append } as unknown as Session
    const result = await suggestDocxFormat(ctx, session, view, new AbortController().signal, 4096)
    expect(result.mapping).toEqual({ figureCaption: 'Caption', tableCaption: 'Caption' })
    const request = generate.mock.calls[0]![0]
    const block = request.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('格式输入必须是文本')
    const input = JSON.parse(block.text) as { templateParagraphs: string[]; candidateColumns: string[] }
    expect(input.templateParagraphs.join('')).toContain('正文小四宋体')
    expect(input.candidateColumns).toEqual(['id', 'name', 'roles', 'samples'])
    expect(append.mock.calls[0]![0]).toBe('bid.word-format.request')
  })

  it('标题及图表编号在浏览器预览中独立计数', () => {
    const values = defaultDocxFormatState(formatFields(defaults)).resolved
    const heading = createHeadingNumberer(values)
    expect([1, 2, 1].map(heading)).toEqual(['1', '1.1', '2'])
    const caption = createCaptionNumberer(values)
    expect([caption('figureCaption'), caption('tableCaption'), caption('figureCaption')]).toEqual(['图1 ', '表1 ', '图2 '])
  })

  it('解析缓存随 parser version 刷新并拒绝旧配置格式', async () => {
    const project = await workspace()
    const bytes = await template()
    const saved = await saveDocxTemplate(project, { revision: 0, name: '模板.docx', bytes })
    expect(saved.state.template?.parserVersion).toBe(DOCX_TEMPLATE_PARSER_VERSION)
    const config = join(project.projectRoot, 'word-export/config.json')
    await writeFile(config, `${JSON.stringify({ ...saved.state, version: 1 })}\n`)
    await expect(readDocxFormat(project)).rejects.toThrow('版本过旧')
  })

  it('拒绝无效 DOCX、DTD、循环样式、危险路径和超限 XML', async () => {
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
    const cyclic = await JSZip.loadAsync(bytes)
    cyclic.file('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:basedOn w:val="Normal"/></w:style></w:styles>')
    await expect(parseDocxTemplate(await cyclic.generateAsync({ type: 'nodebuffer' }), '坏模板.docx')).rejects.toThrow('循环继承')
    const oversized = await JSZip.loadAsync(bytes)
    oversized.file('word/document.xml', ' '.repeat(32 * 1024 * 1024 + 1))
    await expect(parseDocxTemplate(await oversized.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), '超大 XML.docx')).rejects.toThrow('解压后超过')
  })

  it('字段校验拒绝未知键、越界值和无效编号', () => {
    const fields = formatFields(defaults)
    expect(() => validateFormatValues({ '../path': 'x' }, fields)).toThrow('配置无效')
    expect(() => validateFormatValues({ 'body.size': -1 }, fields)).toThrow('配置无效')
    expect(() => validateFormatValues({ 'numbering.1.text': '%2' }, fields)).toThrow('不能引用下级')
  })

  it('字号兼容数字、pt、磅和完整常用中文字号表并拒绝非法单位', () => {
    const fields = formatFields(defaults)
    const cases: Array<[number | string, number]> = [
      [16, 16], ['16', 16], ['16pt', 16], ['16 pt', 16], ['16磅', 16],
      ['初号', 42], ['小初', 36], ['一号', 26], ['小一', 24], ['二号', 22], ['小二', 18],
      ['三号', 16], ['小三', 15], ['四号', 14], ['小四', 12], ['五号', 10.5], ['小五', 9],
      ['六号', 7.5], ['小六', 6.5], ['七号', 5.5], ['八号', 5],
    ]
    for (const [input, expected] of cases)
      expect(validateFormatValues({ 'body.size': input }, fields)).toEqual({ 'body.size': expected })
    expect(validateFormatValues({ 'body.line': '1.5 倍', 'body.firstLine': '2 字符',
      'page.top': '25.4mm', 'table.width': '80%' }, fields)).toEqual({
      'body.line': 1.5, 'body.lineRule': 'auto', 'body.firstLine': 2, 'body.firstLineUnit': 'chars',
      'page.top': 25.4, 'table.width': 80,
    })
    expect(validateFormatValues({ 'body.line': '18磅' }, fields)).toEqual({ 'body.line': 18, 'body.lineRule': 'exact' })
    expect(() => validateFormatValues({ 'body.size': '十六号' }, fields)).toThrow('body.size')
    expect(() => validateFormatValues({ 'body.size': '16px' }, fields)).toThrow('body.size')
    expect(() => validateFormatValues({ 'body.before': '1行' }, fields)).toThrow('body.before')
  })

  it('候选来源的带单位数值也在进入 resolved 前标准化', () => {
    const fields = formatFields(defaults)
    const state = defaultDocxFormatState(fields)
    state.extracted.candidates = [{ id: 'body-format', name: '正文说明', roles: ['body'], samples: [],
      values: { size: '12 pt', line: '1.5倍', firstLine: '2字符', before: '0行', after: '0行' },
      evidence: [
        { key: 'size', value: '12 pt', source: 'named_style' },
        { key: 'line', value: '1.5倍', source: 'named_style' },
        { key: 'firstLine', value: '2字符', source: 'named_style' },
        { key: 'before', value: '0行', source: 'named_style' },
        { key: 'after', value: '0行', source: 'named_style' },
      ] }]
    const view = resolveFormat(state, fields)
    expect(view.state.resolved).toMatchObject({ 'body.size': 12, 'body.line': 1.5, 'body.lineRule': 'auto',
      'body.firstLine': 2, 'body.firstLineUnit': 'chars', 'body.before': 0, 'body.after': 0 })
    expect(view.state.extracted.candidates[0]?.values).toMatchObject({ size: 12, line: 1.5, lineRule: 'auto',
      firstLine: 2, firstLineUnit: 'chars', before: 0, after: 0 })
    expect(view.state.conflicts.flatMap(conflict => conflict.evidence).filter(item => item.key === 'body.size')
      .every(item => typeof item.value === 'number')).toBe(true)
  })

  it('配置指纹只读取 resolved 而不重新猜测模板', async () => {
    const project = await workspace()
    const view = await saveDocxTemplate(project, { revision: 0, name: '模板.docx', bytes: await template() })
    const persisted = JSON.parse(await readFile(join(project.projectRoot, 'word-export/config.json'), 'utf8')) as { resolved: unknown }
    expect(persisted.resolved).toEqual(view.state.resolved)
    expect((await readDocxFormat(project)).values).toBeDefined()
  })
})
