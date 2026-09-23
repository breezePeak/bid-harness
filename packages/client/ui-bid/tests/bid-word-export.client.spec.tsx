// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BidPageEstimate, DocxFormatRequest, DocxFormatView, DocxTemplateId, DocxTemplateLibraryView, FormatConflict, FormatValue, FormatValues } from '@deepseek-ai/dsh-bid/control-plane'
import { BidWordExport, type BidWordExportInjected } from '../src/client/BidWordExport.tsx'
import { apply } from '../src/client/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const resolved: FormatValues = { ...Object.fromEntries<FormatValue>(['heading1', 'heading2', 'body', 'figureCaption', 'tableCaption'].flatMap((role): Array<[string, FormatValue]> => [
  [`${role}.font`, '宋体'], [`${role}.latinFont`, 'Times New Roman'], [`${role}.size`, role.startsWith('heading') ? 16 : 12],
  [`${role}.alignment`, role.endsWith('Caption') ? 'center' : role === 'body' ? 'both' : 'left'],
  [`${role}.line`, 1.5], [`${role}.lineRule`, 'auto'], [`${role}.firstLine`, role === 'body' ? 2 : 0],
  [`${role}.firstLineUnit`, role === 'body' ? 'chars' : 'mm'],
])), 'body.bold': false, 'heading3.bold': true, 'page.orientation': 'portrait' }

function fixture(conflicts: FormatConflict[] = []) {
  const templateId = 'a'.repeat(64) as DocxTemplateId
  let library: DocxTemplateLibraryView = {
    version: 1,
    revision: 1,
    estimateTemplateId: templateId,
    templateMaxBytes: 300 * 1024 * 1024,
    templates: [{ id: templateId, hash: templateId, name: '模板.docx', parserVersion: 4,
      createdAt: '2026-09-12T00:00:00.000Z', formatRevision: 0, conflictCount: conflicts.length }],
  }
  let view: DocxFormatView = {
    state: { version: 2,
      revision: 0,
      opened: true,
      template: { parserVersion: 4, hash: templateId, name: '模板.docx' },
      extracted: { values: {}, candidates: [], paragraphs: [], evidence: [], warnings: [] },
      modelInterpreted: { values: {}, mapping: {}, evidence: [] },
      conflicts,
      resolved: { ...resolved },
      userConfirmed: {} },
    templateId,
    library,
    templateMaxBytes: library.templateMaxBytes,
    fields: [
      { key: 'page.orientation', group: '页面设置', label: '方向', value: 'portrait', options: ['portrait', 'landscape'] },
      { key: 'body.font', group: '正文', label: '正文中文字体', value: '宋体' },
      { key: 'body.bold', group: '正文', label: '正文加粗', value: false },
      { key: 'heading3.bold', group: '标题', label: '三级标题加粗', value: true },
      { key: 'tableCaption.size', group: '表格与图表说明', label: '表题字号（磅）', value: 12, min: 5, max: 96 },
    ],
    values: { ...resolved }, warnings: [], fingerprint: 'current',
  }
  const actions: BidWordExportInjected = {
    getLibrary: vi.fn(async () => library),
    getFormat: vi.fn(async (selectedId: DocxTemplateId | null): Promise<DocxFormatView> => selectedId === null
      ? { ...view, templateId: null, library, state: { ...view.state, template: undefined } }
      : { ...view, templateId: selectedId, library }),
    saveFormat: vi.fn(async (selectedId: DocxTemplateId | null, request: DocxFormatRequest): Promise<DocxFormatView> => {
      const nextConflicts = view.state.conflicts.map(conflict => request.userConfirmed[conflict.key] === undefined ? conflict : {
        ...conflict, status: 'confirmed' as const, resolvedValue: request.userConfirmed[conflict.key]!,
      })
      library = { ...library, templates: library.templates.map(template => template.id === selectedId
        ? { ...template, formatRevision: request.revision + 1, conflictCount: nextConflicts.filter(item => item.status === 'conflict').length }
        : template) }
      view = { ...view, templateId: selectedId, library, state: { ...view.state,
        revision: request.revision + 1,
        userConfirmed: request.userConfirmed,
        conflicts: nextConflicts,
        resolved: { ...view.state.resolved, ...request.userConfirmed } },
      values: { ...view.values, ...request.userConfirmed } }
      return view
    }),
    uploadTemplate: vi.fn(async (_file: File, revision: number) => {
      const id = 'b'.repeat(64) as DocxTemplateId
      library = { ...library, revision: revision + 1, templates: [...library.templates,
        { id, hash: id, name: '新模板.docx', parserVersion: 4, createdAt: '2026-09-12T01:00:00.000Z', formatRevision: 1, conflictCount: 0 }] }
      view = { ...view, templateId: id, library, state: { ...view.state, revision: 1,
        template: { parserVersion: 4, hash: id, name: '新模板.docx' } } }
      return view
    }),
    preview: vi.fn(async (selectedId: DocxTemplateId | null): Promise<DocxFormatView> => (
      { ...view, templateId: selectedId, library, previewHtml: '<h1>文档标题</h1><p>正文示例</p>' }
    )),
    estimatePages: vi.fn(async (selectedId: DocxTemplateId | null): Promise<BidPageEstimate> => ({
      status: 'available', pages: selectedId === null ? 180 : 188,
      source: selectedId === null ? 'default' : 'template', method: 'rendered',
      template: selectedId === null ? null : { id: selectedId, name: selectedId === templateId ? '模板.docx' : '新模板.docx', revision: 1 } })),
    setEstimateTemplate: vi.fn(async (selectedId: DocxTemplateId | null, revision: number): Promise<DocxTemplateLibraryView> => {
      library = { ...library, revision: revision + 1, estimateTemplateId: selectedId }
      return library
    }),
    generate: vi.fn(async () => ({ path: 'output/bid.docx' })),
    download: vi.fn(async () => {}),
    showTask: vi.fn(),
  }
  const props = {
    sessionId: 'bid', useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: (key: string) => key === 'bid.docx_export' ? null : {
      allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' },
    },
    ...actions,
  } as ConvViewProps & BidWordExportInjected
  return { props, actions, getView: () => view, getLibrary: () => library, templateId }
}

describe('Word 导出页面', () => {
  it('只显示上传区、主要格式表、效果预览和单一导出按钮', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByLabelText('上传 Word 模板')).toBeDefined()
    expect(screen.getByRole('table', { name: '当前模板主要格式' })).toBeDefined()
    expect(screen.getAllByText('三号（16pt）')).toHaveLength(2)
    expect(screen.getAllByText('小四（12pt）')).toHaveLength(3)
    const exportButton = screen.getByRole('button', { name: '导出 Word' })
    expect(exportButton.closest('header')).not.toBeNull()
    expect(screen.getByRole('button', { name: '修改全部参数' })).toBeDefined()
    expect(screen.getAllByRole('button', { name: '修改' })).toHaveLength(5)
    expect(screen.queryByText('格式描述')).toBeNull()
    expect(screen.queryByText('页面设置')).toBeNull()
    expect(screen.getByText('系统默认模板')).toBeDefined()
    expect(screen.queryByText('系统默认格式')).toBeNull()
    expect(actions.preview).toHaveBeenCalledOnce()
  })

  it('系统默认模板展示 Host 返回的 resolved 并使用 null 读取预览', async () => {
    const { props, actions, getView } = fixture()
    vi.mocked(actions.getFormat).mockImplementation(async selectedId => selectedId === null
      ? { ...getView(), templateId: null, state: { ...getView().state, template: undefined,
        resolved: { ...getView().state.resolved, 'body.size': 13 } },
      values: { ...getView().values, 'body.size': 13 } }
      : { ...getView(), templateId: selectedId })
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    fireEvent.click(screen.getByRole('radio', { name: /系统默认模板/u }))
    await screen.findByText('13pt')
    expect(actions.getFormat).toHaveBeenLastCalledWith(null)
    expect(actions.preview).toHaveBeenLastCalledWith(null)

    fireEvent.click(screen.getByRole('radio', { name: /模板\.docx/u }))
    await waitFor(() => { expect(screen.queryByText('13pt')).toBeNull() })
  })

  it('选择模板后自动解析并立即刷新 resolved 预览', async () => {
    const { props, actions } = fixture()
    let finishUpload: (view: DocxFormatView) => void = () => {}
    vi.mocked(actions.uploadTemplate).mockImplementationOnce(async () => new Promise((resolve) => { finishUpload = resolve }))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const file = new File([Uint8Array.of(1, 2, 3)], '新模板.docx')
    fireEvent.change(screen.getByLabelText('上传 Word 模板'), { target: { files: [file] } })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '正在解析模板…')
    finishUpload(await actions.getFormat('b'.repeat(64) as DocxTemplateId))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '模板已加入项目模板库')
    expect(actions.uploadTemplate).toHaveBeenCalledWith(file, 1)
    expect(actions.preview).toHaveBeenCalledTimes(2)
  })

  it('模型解释失败时告知用户确定性模板解析仍已保留', async () => {
    const { props, actions, getView } = fixture()
    const warning = '模板解析完成；自动格式解释未应用（模型格式解释包含未知字段：heading.font。），可重新上传模板重试。'
    vi.mocked(actions.uploadTemplate).mockImplementationOnce(async () => ({ ...getView(), warnings: [warning] }))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    fireEvent.change(screen.getByLabelText('上传 Word 模板'), {
      target: { files: [new File([Uint8Array.of(1)], '模板.docx')] },
    })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', warning)
    expect(screen.getByRole('table', { name: '当前模板主要格式' })).toBeDefined()
  })

  it('冲突参数也允许输入模板候选之外的合法值', async () => {
    const conflict: FormatConflict = { key: 'tableCaption.size', resolvedValue: 12, status: 'conflict', evidence: [
      { key: 'tableCaption.size', value: 12, source: 'template_instruction', text: '表题 12 磅' },
      { key: 'tableCaption.size', value: 16, source: 'named_style', text: 'Caption' },
    ] }
    const { props, actions } = fixture([conflict])
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByText('待确认')).toBeDefined()
    const tableCaptionRow = screen.getByRole('row', { name: /表题/u })
    fireEvent.click(within(tableCaptionRow).getByRole('button', { name: '修改小四（12pt）' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('修改表题字号（磅）')).toBeDefined()
    expect(within(dialog).queryByLabelText('正文中文字体')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('表题字号（磅）'), { target: { value: '18' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }))
    await screen.findByText('Word 参数已保存，仍可继续修改')
    expect(actions.saveFormat).toHaveBeenCalledWith('a'.repeat(64), { revision: 0,
      userConfirmed: { 'tableCaption.size': 18 } })
    expect(screen.queryByText('待确认')).toBeNull()
    expect(actions.preview).toHaveBeenCalledTimes(2)
  })

  it('全部参数在保存后仍可再次修改', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/> )
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '修改全部参数' }))
    const first = screen.getByRole('dialog')
    expect(within(first).getByLabelText('方向')).toBeDefined()
    expect(within(first).getByLabelText('正文中文字体')).toBeDefined()
    expect(within(first).getByLabelText('正文加粗')).toBeDefined()
    fireEvent.change(within(first).getByLabelText('正文中文字体'), { target: { value: '仿宋' } })
    fireEvent.click(within(first).getByRole('checkbox', { name: '正文加粗' }))
    fireEvent.click(within(first).getByRole('button', { name: '保存全部参数' }))
    await screen.findByText('Word 参数已保存，仍可继续修改')

    fireEvent.click(screen.getByRole('button', { name: '修改全部参数' }))
    const second = screen.getByRole('dialog')
    expect(within(second).getByLabelText('正文中文字体')).toHaveProperty('value', '仿宋')
    expect(within(second).getByRole('checkbox', { name: '正文加粗' })).toHaveProperty('checked', true)
    expect(actions.saveFormat).toHaveBeenCalledOnce()
  })

  it('点击某一行只编辑该类型参数', async () => {
    const { props } = fixture()
    render(<BidWordExport {...props}/> )
    await screen.findByTitle('Word 效果预览')
    const bodyRow = screen.getByRole('row', { name: /^正文/u })
    fireEvent.click(within(bodyRow).getByRole('button', { name: '修改' }))
    const dialog = screen.getByRole('dialog', { name: '修改所选 Word 参数' })
    expect(within(dialog).getByLabelText('正文中文字体')).toBeDefined()
    expect(within(dialog).getByLabelText('正文加粗')).toBeDefined()
    expect(within(dialog).queryByLabelText('方向')).toBeNull()
    expect(within(dialog).queryByLabelText('表题字号（磅）')).toBeNull()
  })

  it('存在未确认冲突时导出按钮提示数量并定位首项', async () => {
    const conflicts: FormatConflict[] = ['tableCaption.size', 'body.font'].map((key, index) => ({
      key, resolvedValue: index ? '宋体' : 12, status: 'conflict', evidence: [
        { key, value: index ? '宋体' : 12, source: 'direct_format' },
        { key, value: index ? '仿宋' : 16, source: 'named_style' },
      ],
    }))
    const { props, actions } = fixture(conflicts)
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '当前模板仍有 2 项格式差异，请先确认或修改。')
    expect(actions.generate).not.toHaveBeenCalled()
  })

  it('主要表格之外的模板内差异也打开全部参数编辑器', async () => {
    const conflict: FormatConflict = { key: 'heading3.bold', resolvedValue: true, status: 'conflict', evidence: [
      { key: 'heading3.bold', value: true, source: 'direct_format' },
      { key: 'heading3.bold', value: false, source: 'named_style' },
    ] }
    const { props } = fixture([conflict])
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const entry = screen.getByRole('button', { name: '三级标题加粗：是' })
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '修改全部参数' }))
    fireEvent.click(entry)
    expect(screen.getByRole('dialog', { name: '修改三级标题加粗' })).toBeDefined()
  })

  it('无冲突时一个按钮完成生成和下载', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    await waitFor(() => { expect(actions.download).toHaveBeenCalledOnce() })
    expect(actions.generate).toHaveBeenCalledOnce()
    expect(actions.download).toHaveBeenCalledOnce()
  })

  it('恢复导出中投影时只查看同一任务，卸载后不触发自动下载', async () => {
    const { props, actions, templateId } = fixture()
    const running = { operationId: 'export-1', templateId, startedAt: 1, updatedAt: 2,
      status: 'running', phase: 'exporting', message: '正在生成 Word' }
    const view = render(<BidWordExport {...props} useProjection={(key: string) => key === 'bid.docx_export' ? running : props.useProjection(key as never)}/> )
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '导出中 · 查看任务' }))
    expect(actions.showTask).toHaveBeenCalledOnce()
    expect(actions.generate).not.toHaveBeenCalled()
    view.unmount()

    let complete!: (value: { path: string }) => void
    vi.mocked(actions.generate).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const next = render(<BidWordExport {...props}/> )
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    expect(actions.generate).toHaveBeenCalledOnce()
    next.unmount()
    complete({ path: 'output/bid.docx' })
    await Promise.resolve()
    expect(actions.download).not.toHaveBeenCalled()
  })

  it('恢复完成结果时下载绑定原导出模板', async () => {
    const { props, actions, templateId } = fixture()
    const completed = { operationId: 'export-1', templateId, startedAt: 1, updatedAt: 2,
      status: 'completed', phase: 'finalizing', message: 'Word 导出完成', path: 'output/bid.docx', warnings: [] }
    render(<BidWordExport {...props} useProjection={(key: string) => key === 'bid.docx_export' ? completed : props.useProjection(key as never)}/> )
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('radio', { name: /系统默认模板/u }))
    await waitFor(() => { expect(actions.getFormat).toHaveBeenLastCalledWith(null) })
    fireEvent.click(screen.getByRole('button', { name: '下载本次 Word' }))
    expect(actions.download).toHaveBeenLastCalledWith(templateId)
  })

  it('切换导出模板时把同一模板 ID 传给预览、测算和导出且不改变 S5 基准', async () => {
    const { props, actions, templateId, getView } = fixture()
    const secondId = 'b'.repeat(64) as DocxTemplateId
    const library = await actions.getLibrary()
    const secondLibrary = { ...library, templates: [...library.templates, {
      id: secondId, hash: secondId, name: '公司标准模板.docx', parserVersion: 4,
      createdAt: '2026-09-12T01:00:00.000Z', formatRevision: 3, conflictCount: 0,
    }] }
    vi.mocked(actions.getLibrary).mockResolvedValueOnce(secondLibrary)
    vi.mocked(actions.getFormat).mockImplementation(async selectedId => ({ ...getView(),
      templateId: selectedId, library: secondLibrary }))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    fireEvent.click(screen.getByRole('radio', { name: /公司标准模板\.docx/u }))
    await waitFor(() => {
      expect(actions.getFormat).toHaveBeenCalledWith(secondId)
      expect(actions.preview).toHaveBeenCalledWith(secondId)
      expect(actions.estimatePages).toHaveBeenCalledWith(secondId)
    })
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    await waitFor(() => { expect(actions.download).toHaveBeenCalledOnce() })
    expect(actions.generate).toHaveBeenLastCalledWith(secondId)
    expect(actions.download).toHaveBeenLastCalledWith(secondId)
    expect(actions.setEstimateTemplate).not.toHaveBeenCalled()
    expect((await actions.getLibrary()).estimateTemplateId).toBe(templateId)
  })

  it('S5 运行中导出已保存正文，并显示后端返回的内容范围', async () => {
    const { props, actions } = fixture()
    const message = 'Word 已生成，已按完整目录收录现有正文；缺失正文的章节已标注。'
    vi.mocked(actions.generate).mockResolvedValue({ path: 'output/bid.docx', warnings: [{ code: 'DOCX_EXPORT_CONTENT_SNAPSHOT', message }] })
    render(<BidWordExport {...props} useProjection={(key: string) => key === 'bid.docx_export' ? null : ({
      allowedActions: ['send_message', 'export_docx'],
      task: { stage: 'chapter_writing', status: 'running' },
    })}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByRole('status').textContent).toContain('按目录导出所有已保存正文；缺失正文的章节会保留标题并标注。')
    const button = screen.getByRole('button', { name: '导出 Word' })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await waitFor(() => { expect(actions.download).toHaveBeenCalledOnce() })
    expect(actions.generate).toHaveBeenCalledOnce()
    expect(actions.download).toHaveBeenCalledOnce()
  })

  it('模板文件仍通过独立二进制请求发送', async () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      conversationEvents: { register: vi.fn(() => () => {}) }, locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set: vi.fn() }, submitHandlers: { register: vi.fn() } }, remote: { bid: {} },
      sessions: { scope: () => undefined },
      slots: { inject: vi.fn((_name: string, factory: () => unknown) => factory()), register } } as unknown as ClientContext
    apply(ctx)
    const registration = register.mock.calls.find(([definition]) => (definition as { id: string }).id === 'bid-word-export')
    if (!registration) throw new Error('Word export registration is unavailable')
    const injected = (registration[0] as { inject: (sessionId: string) => BidWordExportInjected }).inject('session_bid')
    const view = await fixture().actions.getFormat('a'.repeat(64) as DocxTemplateId)
    const uploadFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, value: view }), { status: 200,
      headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', uploadFetch)
    const file = new File([Uint8Array.of(1, 2, 3, 4)], '公司 模板.docx')
    await expect(injected.uploadTemplate(file, 7)).resolves.toEqual(view)
    const [url, init] = uploadFetch.mock.calls[0]!
    expect(new URL(url instanceof Request ? url.url : url).pathname).toBe('/api/bid-docx-template')
    expect(init?.body).toBe(file)
    expect(init?.headers).toMatchObject({ 'x-dsh-bid-session-id': 'session_bid',
      'x-dsh-bid-docx-name': encodeURIComponent(file.name), 'x-dsh-bid-docx-size': '4', 'x-dsh-bid-docx-revision': '7' })
  })

  it('上传前按 Host 上限拒绝超大文件', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const file = new File([Uint8Array.of(1)], '过大.docx')
    Object.defineProperty(file, 'size', { value: 300 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByLabelText('上传 Word 模板'), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '模板文件不能超过 300 MiB。')
    await waitFor(() => { expect(actions.uploadTemplate).not.toHaveBeenCalled() })
  })

  it('模板上传失败后保留此前选择和格式结果', async () => {
    const conflict: FormatConflict = { key: 'heading3.bold', resolvedValue: true, status: 'conflict', evidence: [
      { key: 'heading3.bold', value: true, source: 'direct_format' },
      { key: 'heading3.bold', value: false, source: 'named_style' },
    ] }
    const { props, actions } = fixture([conflict])
    vi.mocked(actions.uploadTemplate).mockRejectedValueOnce(new Error('格式配置无效：body.size'))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByText('模板.docx')).toBeDefined()
    const file = new File([Uint8Array.of(1, 2, 3)], '失败模板.docx')
    fireEvent.change(screen.getByLabelText('上传 Word 模板'), { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '格式配置无效：body.size')
    expect(screen.getByText('模板.docx')).toBeDefined()
    expect(screen.getByRole('table', { name: '当前模板主要格式' })).toBeDefined()
    expect(screen.getByLabelText('其他模板内格式差异')).toBeDefined()
    expect(screen.getByTitle('Word 效果预览')).toBeDefined()
    expect(screen.getByRole('button', { name: '导出 Word' })).toHaveProperty('disabled', false)
  })

  it('保存全部参数一次确认全部模板内差异且不重新触发页数测算', async () => {
    const conflicts: FormatConflict[] = [
      { key: 'tableCaption.size', resolvedValue: 12, status: 'conflict', evidence: [
        { key: 'tableCaption.size', value: 12, source: 'template_instruction' },
        { key: 'tableCaption.size', value: 16, source: 'named_style' },
      ] },
      { key: 'heading3.bold', resolvedValue: true, status: 'conflict', evidence: [
        { key: 'heading3.bold', value: true, source: 'direct_format' },
        { key: 'heading3.bold', value: false, source: 'named_style' },
      ] },
    ]
    const { props, actions } = fixture(conflicts)
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const initialEstimateCalls = vi.mocked(actions.estimatePages).mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: '修改全部参数' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存全部参数' }))
    await screen.findByText('Word 参数已保存，仍可继续修改')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(vi.mocked(actions.estimatePages).mock.calls.length).toBe(initialEstimateCalls)
    expect(screen.queryByText('待确认')).toBeNull()
    expect(screen.queryByLabelText('其他模板内格式差异')).toBeNull()
  })

  it('页数测算未完成时不阻碍直接导出 Word', async () => {
    const { props, actions } = fixture()
    vi.mocked(actions.estimatePages).mockImplementation(() => new Promise(() => {}))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const exportButton = screen.getByRole('button', { name: '导出 Word' })
    expect(exportButton).toHaveProperty('disabled', false)
    fireEvent.click(exportButton)
    await waitFor(() => { expect(actions.download).toHaveBeenCalledOnce() })
    expect(actions.generate).toHaveBeenCalledOnce()
  })

  it('上传按钮位于模板列表前且不显示冗余说明，上传过程中呈现加载效果与禁用状态', async () => {
    const { props, actions } = fixture()
    let finishUpload: (view: DocxFormatView) => void = () => {}
    vi.mocked(actions.uploadTemplate).mockImplementationOnce(async () => new Promise((resolve) => { finishUpload = resolve }))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    expect(screen.queryByText(/模板只提供解析后的排版格式/u)).toBeNull()
    const uploadInput = screen.getByLabelText('上传 Word 模板')
    const uploadTrigger = uploadInput.closest('label')
    expect(uploadTrigger).not.toBeNull()
    expect(uploadTrigger?.textContent).toContain('上传新模板')

    const file = new File([Uint8Array.of(1, 2, 3)], '新模板.docx')
    fireEvent.change(uploadInput, { target: { files: [file] } })

    expect(uploadTrigger?.className).toContain('uploadTriggerDisabled')
    expect(uploadTrigger?.textContent).toContain('正在上传模板…')
    expect(uploadInput).toHaveProperty('disabled', true)

    finishUpload(await actions.getFormat('b'.repeat(64) as DocxTemplateId))
    await waitFor(() => {
      expect(uploadInput).toHaveProperty('disabled', false)
      expect(uploadTrigger?.textContent).toContain('上传新模板')
    })
  })

  it('导出完成后降级等提示展示在“导出 Word”标题后方且成功为绿色', async () => {
    const { props, actions } = fixture()
    const downgradeMsg = 'Visio 不可用，流程图已自动降级为图片模式导出；缺失正文的章节已标注。'
    vi.mocked(actions.generate).mockResolvedValueOnce({
      path: 'output/bid.docx',
      warnings: [{ code: 'DOCX_EXPORT_MODE_FALLBACK', message: downgradeMsg }],
    })
    const rendered = render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    const exportButton = screen.getByRole('button', { name: '导出 Word' })
    fireEvent.click(exportButton)

    await waitFor(() => { expect(actions.download).toHaveBeenCalledOnce() })
    const completed = { operationId: 'export-1', templateId: 'a'.repeat(64), startedAt: 1, updatedAt: 2,
      status: 'completed', phase: 'finalizing', message: 'Word 导出完成', path: 'output/bid.docx',
      warnings: [{ code: 'DOCX_EXPORT_MODE_FALLBACK', message: downgradeMsg }] }
    rendered.rerender(<BidWordExport {...props} useProjection={(key: string) => key === 'bid.docx_export' ? completed : props.useProjection(key as never)}/> )
    const feedback = await screen.findByText(downgradeMsg)
    expect(feedback.closest('header')).not.toBeNull()
    expect(feedback.className).toContain('exportFeedbackSuccess')
  })

  it('导出失败时错误提示展示在“导出 Word”标题后方且失败为红色', async () => {
    const { props, actions } = fixture()
    vi.mocked(actions.generate).mockRejectedValueOnce(new Error('生成 Word 异常：IO 错误'))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    const exportButton = screen.getByRole('button', { name: '导出 Word' })
    fireEvent.click(exportButton)

    const feedback = await screen.findByText('生成 Word 异常：IO 错误')
    expect(feedback.getAttribute('role')).toBe('alert')
  })

  it('导出校验失败时展示首个正文问题及其错误码', async () => {
    const { props, actions } = fixture()
    vi.mocked(actions.generate).mockRejectedValueOnce(Object.assign(new Error('当前已保存正文无法导出，请检查正文完整性。'), {
      issues: [{
        code: 'DOCX_EXPORT_TECHNICAL_DEVIATION_INVALID',
        message: '技术偏离表必须使用六列标准表头，请修订正文后重新导出 Word。',
      }],
    }))
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')

    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))

    const feedback = await screen.findByText('技术偏离表必须使用六列标准表头，请修订正文后重新导出 Word。 (DOCX_EXPORT_TECHNICAL_DEVIATION_INVALID)')
    expect(feedback.getAttribute('role')).toBe('alert')
    expect(screen.queryByText('当前已保存正文无法导出，请检查正文完整性。 (BID_DOCX_EXPORT_FAILED)')).toBeNull()
  })
})
