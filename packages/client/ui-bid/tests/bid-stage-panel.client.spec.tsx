// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BidClientProjection } from '@deepseek-ai/dsh-bid/control-plane'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BidStagePanel, type BidStagePanelProps } from '../src/client/BidStagePanel.tsx'
import { apply } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let value = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}) as BidStagePanelProps['t']

function projection(patch: Partial<BidClientProjection> = {}): BidClientProjection {
  return {
    runtime: { stage: 'file_intake', status: 'pending' },
    allowedActions: [],
    composer: { enabled: false, reason: 'bid.upload_required' },
    ...patch,
  }
}

function props(
  value: BidClientProjection | undefined,
  patch: Partial<BidStagePanelProps> = {},
): BidStagePanelProps {
  const useProjection = (_key: string, selector?: (item: BidClientProjection | undefined) => unknown) =>
    selector === undefined ? value : selector(value)
  const useSessions = (selector: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) =>
    selector({ byId: { session_bid: { agentPreset: 'bid' } } })
  return {
    sessionId: 'session_bid',
    useProjection,
    useSessions,
    setComposerBlock: vi.fn(),
    t,
    ...patch,
  } as unknown as BidStagePanelProps
}

describe('BidStagePanel', () => {
  it('stays absent without the Host projection and follows runtime updates', () => {
    const setComposerBlock = vi.fn()
    const view = render(<BidStagePanel {...props(undefined, { setComposerBlock })} />)
    expect(screen.queryByRole('region', { name: '技术标生成' })).toBeNull()
    expect(setComposerBlock).not.toHaveBeenCalled()

    view.rerender(<BidStagePanel {...props(projection(), { setComposerBlock })} />)
    expect(screen.getByRole('region', { name: '技术标生成' })).toBeTruthy()
    expect(screen.getByText('请添加本项目资料')).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'file_intake', status: 'running' },
    }), { setComposerBlock })} />)
    expect(screen.getByText('正在上传并解析文件')).toBeTruthy()
    expect(screen.getAllByText('正在处理…').length).toBeGreaterThan(0)

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'pending' },
    }), { setComposerBlock })} />)
    expect(screen.getByText('文件接入完成，等待招标分析')).toBeTruthy()
  })

  it('stays absent for a non-Bid session even when a projection is available', () => {
    const useSessions = (selector: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) =>
      selector({ byId: { session_bid: { agentPreset: 'standard' } } })
    render(<BidStagePanel {...props(projection(), { useSessions } as Partial<BidStagePanelProps>)} />)
    expect(screen.queryByRole('region', { name: '技术标生成' })).toBeNull()
  })

  it('shows file selection only when upload_files is admitted', () => {
    const view = render(<BidStagePanel {...props(projection())} />)
    expect(screen.queryByRole('button', { name: '上传标书' })).toBeNull()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
      allowedExtensions: ['.pdf', '.docx'],
      maxFiles: 4,
    }), { uploadFiles: vi.fn(async () => {}) })} />)
    expect(screen.getByRole('button', { name: '上传标书' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '相关资料' })).toBeTruthy()
    const inputs = view.container.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(2)
    fireEvent.change(inputs[0]!, {
      target: { files: [new File(['bid'], '招标文件.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    expect(screen.getAllByText('招标资料')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '上传并解析' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传并解析' })).toHaveProperty('disabled', true)
    fireEvent.change(inputs[1]!, {
      target: { files: [new File(['reference'], '项目资料.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByRole('button', { name: '上传并解析' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '移除文件: 招标文件.pdf' }))
    expect(screen.queryByText('招标文件.pdf')).toBeNull()
    expect(screen.getByRole('button', { name: '上传并解析' })).toHaveProperty('disabled', true)
  })

  it('submits the selected files once and keeps them available after a Host refusal', async () => {
    const first = Promise.withResolvers<undefined>()
    const uploadFiles = vi.fn<(_: readonly { file: File; role: string }[]) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined)
    const view = render(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
      allowedExtensions: ['.md'],
      maxFiles: 2,
    }), { uploadFiles })} />)
    const file = new File(['# 招标要求'], 'requirements.md', { type: 'text/markdown' })
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, {
      target: { files: [file] },
    })
    fireEvent.change(inputs[1]!, {
      target: { files: [new File(['project'], 'project.md', { type: 'text/markdown' })] },
    })

    fireEvent.click(screen.getByRole('button', { name: '上传并解析' }))
    expect(uploadFiles).toHaveBeenCalledOnce()
    expect(uploadFiles).toHaveBeenCalledWith([
      { file, role: 'tender' },
      expect.objectContaining({ file: expect.any(File), role: 'reference' }),
    ])
    expect(screen.getByRole('button', { name: '正在上传…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '上传标书' })).toHaveProperty('disabled', true)
    expect(screen.getByText('请添加本项目资料')).toBeTruthy()

    act(() => { first.reject(new Error('BID_FILE_INTAKE_NOT_ALLOWED')) })
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('BID_FILE_INTAKE_NOT_ALLOWED')
    expect(screen.getByText('requirements.md')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '上传并解析' }))
    await waitFor(() => { expect(uploadFiles).toHaveBeenCalledTimes(2) })
  })

  it('shows the Host failure reason and keeps failed file intake uploadable', () => {
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'file_intake', status: 'failed', failureReason: '文档无法解析' },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    }), { uploadFiles: vi.fn(async () => {}) })} />)

    expect(screen.getByText('文件接入失败，请重新选择或再次上传文件')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('文档无法解析')
    expect(screen.getByRole('button', { name: '上传标书' })).toBeTruthy()
  })

  it('mirrors only projection.composer into the session block', async () => {
    const setComposerBlock = vi.fn()
    const view = render(<BidStagePanel {...props(projection(), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith('请先添加本项目资料') })

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: [],
      composer: { enabled: true },
    }), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith(undefined) })
  })

  it('dispatches retry and confirmation without changing projected runtime', async () => {
    const retryStage = vi.fn(async () => {})
    const confirmOutline = vi.fn(async (_operations: readonly unknown[]) => {})
    const retryProjection = projection({ allowedActions: ['retry_stage'] })
    const view = render(<BidStagePanel {...props(retryProjection, { retryStage, confirmOutline })} />)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
    expect(screen.getByText('请添加本项目资料')).toBeTruthy()

    const confirmationProjection = projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline'],
    })
    view.rerender(<BidStagePanel {...props(confirmationProjection, { retryStage, confirmOutline })} />)
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenLastCalledWith([]) })
    expect(screen.getByText('请确认技术标目录')).toBeTruthy()
  })

  it('edits outline text and emits basic structural operations', async () => {
    const confirmOutline = vi.fn(async (_operations: readonly unknown[]) => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline'],
    }), {
      confirmOutline,
      getOutlineForConfirmation: async () => ({
        schema_version: 1, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{
          id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付', writable: true,
          must_answer: ['交付计划'], requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
        }],
      }),
    })} />)
    const title = await screen.findByLabelText('SEC-1 标题')
    fireEvent.change(title, { target: { value: '更新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '新增同级' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(confirmOutline).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ type: 'update_section', section_id: 'SEC-1', title: '更新标题' }),
      expect.objectContaining({ type: 'add_section' }),
      expect.objectContaining({ type: 'delete_section', section_id: 'SEC-1' }),
    ])))
  })
})

describe('ui-bid browser plugin', () => {
  it('registers the Bid input-dock entry, scopes composer blocks, and calls the Bid Remote', async () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const set = vi.fn()
    const remoteUpload = vi.fn<(_sessionId: string, _files: readonly unknown[]) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'tender_analysis' as const, status: 'pending' as const } },
      })
    const remoteRetry = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'evidence_mapping' as const, status: 'pending' as const } },
      })
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set } },
      remote: { bid: { uploadFiles: remoteUpload, retryStage: remoteRetry } },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register,
      },
    } as unknown as ClientContext

    apply(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.dock', id: 'bid', order: -10,
    }), BidStagePanel)
    const registration = register.mock.calls[0]
    if (registration === undefined) throw new Error('Bid dock registration is unavailable')
    const options = registration[0] as {
      inject: (sessionId: string) => {
        setComposerBlock: (reason: string | undefined) => void
        uploadFiles: (files: readonly { file: File; role: 'tender' | 'reference' }[]) => Promise<void>
        retryStage: () => Promise<void>
      }
    }
    const injected = options.inject('session_bid')
    injected.setComposerBlock('请先上传')
    expect(set).toHaveBeenLastCalledWith('session_bid', { reason: '请先上传' })
    injected.setComposerBlock(undefined)
    expect(set).toHaveBeenLastCalledWith('session_bid', undefined)

    const file = new File([Uint8Array.of(1, 2, 3)], 'requirements.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => Uint8Array.of(1, 2, 3).buffer,
    })
    await injected.uploadFiles([{ file, role: 'reference' }])
    expect(remoteUpload).toHaveBeenCalledWith('session_bid', [{
      name: 'requirements.md',
      role: 'reference',
      mediaType: 'text/markdown',
      size: 3,
      data: 'AQID',
    }])

    remoteUpload.mockResolvedValueOnce({
      ok: true,
      value: {
        ok: false,
        error: { code: 'BID_FILE_TYPE_UNSUPPORTED', message: '不支持该文件类型' },
      },
    })
    await expect(injected.uploadFiles([{ file, role: 'reference' }])).rejects.toThrow('不支持该文件类型 (BID_FILE_TYPE_UNSUPPORTED)')

    await injected.retryStage()
    expect(remoteRetry).toHaveBeenCalledWith('session_bid')
  })
})
