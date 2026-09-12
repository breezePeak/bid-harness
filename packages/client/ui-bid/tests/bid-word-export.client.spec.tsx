// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DocxFormatRequest, DocxFormatView, FormatConflict, FormatValue, FormatValues } from '@deepseek-ai/dsh-bid/control-plane'
import { BidWordExport, type BidWordExportInjected } from '../src/client/BidWordExport.tsx'
import { apply } from '../src/client/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const resolved: FormatValues = Object.fromEntries<FormatValue>(['heading1', 'heading2', 'body', 'figureCaption', 'tableCaption'].flatMap((role): Array<[string, FormatValue]> => [
  [`${role}.font`, '宋体'], [`${role}.latinFont`, 'Times New Roman'], [`${role}.size`, role.startsWith('heading') ? 16 : 12],
  [`${role}.alignment`, role.endsWith('Caption') ? 'center' : role === 'body' ? 'both' : 'left'],
  [`${role}.line`, 1.5], [`${role}.lineRule`, 'auto'], [`${role}.firstLine`, role === 'body' ? 2 : 0],
  [`${role}.firstLineUnit`, role === 'body' ? 'chars' : 'mm'],
]))

function fixture(conflicts: FormatConflict[] = []) {
  let view: DocxFormatView = {
    state: { version: 2,
      revision: 0,
      opened: true,
      template: { parserVersion: 4, hash: 'a'.repeat(64), name: '模板.docx' },
      extracted: { values: {}, candidates: [], paragraphs: [], evidence: [], warnings: [] },
      modelInterpreted: { values: {}, mapping: {}, evidence: [] },
      conflicts,
      resolved: { ...resolved },
      userConfirmed: {} },
    templateMaxBytes: 300 * 1024 * 1024,
    fields: [{ key: 'tableCaption.size', group: '表格与图表说明', label: '表题字号（磅）', value: 12 }],
    values: { ...resolved }, warnings: [], fingerprint: 'current',
  }
  const actions: BidWordExportInjected = {
    getFormat: vi.fn(async () => view),
    saveFormat: vi.fn(async (request: DocxFormatRequest) => {
      const nextConflicts = view.state.conflicts.map(conflict => request.userConfirmed[conflict.key] === undefined ? conflict : {
        ...conflict, status: 'confirmed' as const, resolvedValue: request.userConfirmed[conflict.key]!,
      })
      view = { ...view, state: { ...view.state,
        revision: request.revision + 1,
        userConfirmed: request.userConfirmed,
        conflicts: nextConflicts,
        resolved: { ...view.state.resolved, ...request.userConfirmed } },
      values: { ...view.values, ...request.userConfirmed } }
      return view
    }),
    uploadTemplate: vi.fn(async (_file: File, revision: number) => {
      view = { ...view, state: { ...view.state, revision: revision + 1,
        template: { parserVersion: 4, hash: 'b'.repeat(64), name: '新模板.docx' } } }
      return view
    }),
    preview: vi.fn(async () => ({ ...view, previewHtml: '<h1>文档标题</h1><p>正文示例</p>' })),
    generate: vi.fn(async () => ({ path: 'output/bid.docx' })),
    download: vi.fn(async () => {}),
  }
  const props = {
    sessionId: 'bid', useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ allowedActions: ['export_docx'], runtime: { stage: 'chapter_writing', status: 'completed' } }),
    ...actions,
  } as ConvViewProps & BidWordExportInjected
  return { props, actions, getView: () => view }
}

describe('Word 导出页面', () => {
  it('只显示上传区、主要格式表、效果预览和单一导出按钮', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByLabelText('上传 Word 模板')).toBeDefined()
    expect(screen.getByRole('table', { name: '模板主要格式' })).toBeDefined()
    expect(screen.getAllByText('三号（16pt）')).toHaveLength(2)
    expect(screen.getAllByText('小四（12pt）')).toHaveLength(3)
    const exportButton = screen.getByRole('button', { name: '导出 Word' })
    expect(exportButton.closest('header')).not.toBeNull()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['导出 Word'])
    expect(screen.queryByText('格式描述')).toBeNull()
    expect(screen.queryByText('页面设置')).toBeNull()
    expect(actions.preview).toHaveBeenCalledOnce()
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
    finishUpload(await actions.getFormat())
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '模板解析完成')
    expect(actions.uploadTemplate).toHaveBeenCalledWith(file, 0)
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
    expect(screen.getByRole('table', { name: '模板主要格式' })).toBeDefined()
  })

  it('冲突单元格标红并只允许选择证据中的值', async () => {
    const conflict: FormatConflict = { key: 'tableCaption.size', resolvedValue: 12, status: 'conflict', evidence: [
      { key: 'tableCaption.size', value: 12, source: 'template_instruction', text: '表题 12 磅' },
      { key: 'tableCaption.size', value: 16, source: 'named_style', text: 'Caption' },
    ] }
    const { props, actions } = fixture([conflict])
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByText('待确认')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '小四（12pt）' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('表题字号（磅）存在冲突')).toBeDefined()
    expect(within(dialog).getByText('来源：模板格式说明')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('radio', { name: /16/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await screen.findByText('格式已确认')
    expect(actions.saveFormat).toHaveBeenCalledWith({ revision: 0, userConfirmed: { 'tableCaption.size': 16 } })
    expect(screen.queryByText('待确认')).toBeNull()
    expect(actions.preview).toHaveBeenCalledTimes(2)
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
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '当前仍有 2 项格式冲突，请先确认。')
    expect(actions.generate).not.toHaveBeenCalled()
  })

  it('主要表格之外的冲突仍提供简短确认入口', async () => {
    const conflict: FormatConflict = { key: 'heading3.bold', resolvedValue: true, status: 'conflict', evidence: [
      { key: 'heading3.bold', value: true, source: 'direct_format' },
      { key: 'heading3.bold', value: false, source: 'named_style' },
    ] }
    const { props } = fixture([conflict])
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    const entry = screen.getByRole('button', { name: 'heading3.bold：是' })
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    expect(document.activeElement).toBe(entry)
    fireEvent.click(entry)
    expect(screen.getByRole('dialog', { name: 'heading3.bold存在冲突' })).toBeDefined()
  })

  it('无冲突时一个按钮完成生成和下载', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByTitle('Word 效果预览')
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    await screen.findByText('Word 导出完成')
    expect(actions.generate).toHaveBeenCalledOnce()
    expect(actions.download).toHaveBeenCalledOnce()
  })

  it('S5 运行中导出已保存正文，并显示后端返回的内容范围', async () => {
    const { props, actions } = fixture()
    const message = 'Word 已生成，已按完整目录收录现有正文；缺失正文的章节已标注。'
    vi.mocked(actions.generate).mockResolvedValue({ path: 'output/bid.docx', warnings: [{ code: 'DOCX_EXPORT_CONTENT_SNAPSHOT', message }] })
    render(<BidWordExport {...props} useProjection={() => ({
      allowedActions: ['send_message', 'stop_stage', 'export_docx'],
      runtime: { stage: 'chapter_writing', status: 'running' },
    })}/>)
    await screen.findByTitle('Word 效果预览')
    expect(screen.getByRole('status')).toHaveProperty('textContent', '按目录导出所有已保存正文；缺失正文的章节会保留标题并标注。')
    const button = screen.getByRole('button', { name: '导出 Word' })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await screen.findByText(message)
    expect(actions.generate).toHaveBeenCalledOnce()
    expect(actions.download).toHaveBeenCalledOnce()
  })

  it('模板文件仍通过独立二进制请求发送', async () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const ctx = { effect: (factory: () => unknown) => factory(), locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set: vi.fn() }, submitHandlers: { register: vi.fn() } }, remote: { bid: {} },
      sessions: { scope: () => undefined },
      slots: { inject: vi.fn((_name: string, factory: () => unknown) => factory()), register } } as unknown as ClientContext
    apply(ctx)
    const registration = register.mock.calls.find(([definition]) => (definition as { id: string }).id === 'bid-word-export')
    if (!registration) throw new Error('Word export registration is unavailable')
    const injected = (registration[0] as { inject: (sessionId: string) => BidWordExportInjected }).inject('session_bid')
    const view = await fixture().actions.getFormat()
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

  it('模板上传失败后不把上传前格式显示成本次识别结果', async () => {
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
    expect(screen.queryByText('模板.docx')).toBeNull()
    expect(screen.queryByRole('table', { name: '模板主要格式' })).toBeNull()
    expect(screen.queryByLabelText('其他格式冲突')).toBeNull()
    expect(screen.queryByTitle('Word 效果预览')).toBeNull()
    expect(screen.getByText('尚无本次模板识别结果。')).toBeDefined()
    expect(screen.getByRole('button', { name: '导出 Word' })).toHaveProperty('disabled', true)
  })
})
