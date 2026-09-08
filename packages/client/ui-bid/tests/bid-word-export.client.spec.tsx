// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DocxFormatRequest, DocxFormatView } from '@deepseek-ai/dsh-bid/control-plane'
import { BidWordExport, type BidWordExportInjected } from '../src/client/BidWordExport.tsx'
afterEach(cleanup)
function fixture() {
  let view: DocxFormatView = {
    state: { version: 1, revision: 0, opened: true, source: 'default', overrides: {}, mapping: {}, description: '' },
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
          ...request.overrides } } as DocxFormatView
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
