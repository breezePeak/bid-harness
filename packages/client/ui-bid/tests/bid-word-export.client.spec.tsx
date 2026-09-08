// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DocxFormatRequest, DocxFormatView } from '@deepseek-ai/dsh-bid/control-plane'
import { BidWordExport, type BidWordExportInjected } from '../src/client/BidWordExport.tsx'
import { apply } from '../src/client/index.ts'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function fixture() {
  let view: DocxFormatView = {
    state: { version: 1, revision: 0, opened: true, source: 'default', overrides: {}, mapping: {}, description: '' },
    templateMaxBytes: 300 * 1024 * 1024,
    fields: [{ key: 'body.size', group: '正文', label: '正文字号（磅）', value: 12, min: 5, max: 96 }],
    values: { 'body.size': 12 }, sources: { 'body.size': '默认补充' }, warnings: [], fingerprint: 'current',
  }
  const actions: BidWordExportInjected = {
    getFormat: vi.fn(async () => view),
    saveFormat: vi.fn(async (request: DocxFormatRequest) => {
      view = { ...view,
        state: { ...view.state,
          ...request,
          revision: request.revision + 1 },
        values: { ...view.values,
          ...request.overrides } }
      return view
    }),
    uploadTemplate: vi.fn(async (_file: File, revision: number) => {
      view = { ...view,
        state: { ...view.state,
          revision: revision + 1,
          source: 'template',
          template: { hash: 'a'.repeat(64), name: '模板.docx', candidates: [], values: {}, warnings: [] } } }
      return view
    }),
    preview: vi.fn(async () => ({ ...view, previewHtml: '<p>当前项目预览</p>' })),
    generate: vi.fn(async () => { view = { ...view,
      state: { ...view.state,
        lastExport: { path: 'output/bid.docx',
          fingerprint: 'current' } } }; return { path: 'output/bid.docx' } }),
    download: vi.fn(async () => { }),
    suggest: vi.fn(async () => ({ overrides: { 'body.size': 15 }, mapping: {}, evidence: { 'body.size': '正文15磅' } })),
  }
  const props = {
    sessionId: 'bid', useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ allowedActions: ['export_docx'], runtime: { stage: 'chapter_writing', status: 'completed' } }),
    ...actions,
  } as ConvViewProps & BidWordExportInjected
  return { props, actions }
}
describe('Word 配置页面', () => {
  it('模板文件通过独立二进制请求发送，不进入 Remote JSON', async () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set: vi.fn() }, submitHandlers: { register: vi.fn() } },
      remote: { bid: {} },
      sessions: { scope: () => undefined },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register,
      },
    } as unknown as ClientContext
    apply(ctx)
    const registration = register.mock.calls.find(([definition]) => (definition as { id: string }).id === 'bid-word-export')
    if (registration === undefined) throw new Error('Word export registration is unavailable')
    const injected = (registration[0] as { inject: (sessionId: string) => BidWordExportInjected }).inject('session_bid')
    const view = await fixture().actions.getFormat()
    const uploadFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, value: view }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', uploadFetch)
    const bytes = Uint8Array.of(1, 2, 3, 4)
    const file = new File([bytes], '公司 模板.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    await expect(injected.uploadTemplate(file, 7)).resolves.toEqual(view)
    const [url, init] = uploadFetch.mock.calls[0]!
    if (!(url instanceof URL)) throw new Error('Template upload URL is not a URL')
    expect(url.pathname).toBe('/api/bid-docx-template')
    expect(init?.body).toBe(file)
    expect(init?.headers).toMatchObject({
      'content-type': 'application/vnd.dsh.bid-docx-template',
      'x-dsh-bid-session-id': 'session_bid',
      'x-dsh-bid-docx-name': encodeURIComponent(file.name),
      'x-dsh-bid-docx-size': '4',
      'x-dsh-bid-docx-revision': '7',
    })
  })
  it('挂载、重新进入和恢复配置都不触发解析、预览或导出', async () => {
    const { props, actions } = fixture()
    const mounted = render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    fireEvent.click(screen.getByRole('button', { name: '使用已保存配置' }))
    await screen.findByText('已恢复保存配置')
    mounted.unmount()
    render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    expect(actions.saveFormat).not.toHaveBeenCalled()
    expect(actions.preview).not.toHaveBeenCalled()
    expect(actions.generate).not.toHaveBeenCalled()
  })
  it('以部署上限校验并上传原始模板文件', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    expect(screen.getByText(/上传 DOCX 模板（最多 300 MiB）/u)).toBeDefined()
    const file = new File([Uint8Array.of(1, 2, 3)], '模板.docx')
    fireEvent.change(screen.getByLabelText('上传 DOCX 模板'), { target: { files: [file] } })
    await screen.findByText('模板已解析；请检查来源、候选和默认补充项')
    expect(actions.uploadTemplate).toHaveBeenCalledWith(file, 0)
    expect(actions.saveFormat).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('正文字号（磅）'), { target: { value: '15' } })
    const replacement = new File([Uint8Array.of(4, 5)], '替换模板.docx')
    fireEvent.change(screen.getByLabelText('上传 DOCX 模板'), { target: { files: [replacement] } })
    await waitFor(() => {
      expect(actions.saveFormat).toHaveBeenCalledWith(expect.objectContaining({
        revision: 1,
        overrides: { 'body.size': 15 },
      }))
      expect(actions.uploadTemplate).toHaveBeenCalledWith(replacement, 2)
    })

    const oversized = new File([Uint8Array.of(1)], '过大.docx')
    Object.defineProperty(oversized, 'size', { value: 300 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByLabelText('上传 DOCX 模板'), { target: { files: [oversized] } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '模板文件不能超过 300 MiB。')
    expect(actions.uploadTemplate).toHaveBeenCalledTimes(2)
  })
  it('编辑后显式保存和预览，只有点击生成才产生下载文件', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    fireEvent.change(screen.getByLabelText('正文字号（磅）'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: '更新预览' }))
    await screen.findByTitle('Word 样式预览')
    expect(actions.saveFormat).toHaveBeenCalledWith(expect.objectContaining({ overrides: { 'body.size': 15 } }))
    expect(actions.preview).toHaveBeenCalledTimes(1)
    expect(actions.generate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '下载文件' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成 Word' }))
    await screen.findByText('Word 生成成功')
    fireEvent.click(screen.getByRole('button', { name: '下载文件' }))
    await waitFor(() => { expect(actions.download).toHaveBeenCalledTimes(1) })
  })
  it('模型建议先显示覆盖差异，应用后仍需保存；模型失败不影响手动生成', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    fireEvent.change(screen.getByLabelText('格式描述'), { target: { value: '正文15磅' } })
    fireEvent.click(screen.getByRole('button', { name: '识别格式要求与模糊样式' }))
    await screen.findByText(/12 → 15/)
    expect(screen.getByLabelText('正文字号（磅）')).toHaveProperty('value', '12')
    fireEvent.click(screen.getByRole('button', { name: '应用这些建议' }))
    expect(screen.getByLabelText('正文字号（磅）')).toHaveProperty('value', '15')
    vi.mocked(actions.suggest).mockRejectedValueOnce(new Error('当前模型不可用，可以手动设置。'))
    fireEvent.click(screen.getByRole('button', { name: '识别格式要求与模糊样式' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '当前模型不可用，可以手动设置。')
    expect(screen.getByRole('button', { name: '生成 Word' })).toHaveProperty('disabled', false)
  })
  it('生成失败保留上一成功文件，不把错误显示为成功', async () => {
    const { props, actions } = fixture()
    render(<BidWordExport {...props}/>)
    await screen.findByText('配置已读取')
    fireEvent.click(screen.getByRole('button', { name: '生成 Word' }))
    await screen.findByText('Word 生成成功')
    vi.mocked(actions.generate).mockRejectedValueOnce(new Error('正文图片缺失。'))
    fireEvent.click(screen.getByRole('button', { name: '生成 Word' }))
    await screen.findByText('正文图片缺失。')
    expect(screen.getByRole('button', { name: '下载文件' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('status')).toHaveProperty('textContent', '失败')
  })
})
