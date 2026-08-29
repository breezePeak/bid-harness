// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  return {
    useProjection,
    setComposerBlock: vi.fn(),
    t,
    ...patch,
  } as unknown as BidStagePanelProps
}

describe('BidStagePanel', () => {
  it('stays absent without the Host projection and follows runtime updates', () => {
    const setComposerBlock = vi.fn()
    const view = render(<BidStagePanel {...props(undefined, { setComposerBlock })} />)
    expect(screen.queryByText('技术标生成')).toBeNull()
    expect(setComposerBlock).not.toHaveBeenCalled()

    view.rerender(<BidStagePanel {...props(projection(), { setComposerBlock })} />)
    expect(screen.getByText('技术标生成')).toBeTruthy()
    expect(screen.getByText('请上传本次招标文件')).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'running' },
    }), { setComposerBlock })} />)
    expect(screen.getByText('正在分析招标文件')).toBeTruthy()
    expect(screen.getAllByText('正在处理…').length).toBeGreaterThan(0)
  })

  it('shows file selection only when upload_files is admitted', () => {
    const view = render(<BidStagePanel {...props(projection())} />)
    expect(screen.queryByRole('button', { name: '上传招标文件' })).toBeNull()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
      allowedExtensions: ['.pdf', '.docx'],
      maxFiles: 4,
    }))} />)
    expect(screen.getByRole('button', { name: '上传招标文件' })).toBeTruthy()
    const input = view.container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input!, {
      target: { files: [new File(['bid'], '招标文件.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除文件: 招标文件.pdf' }))
    expect(screen.queryByText('招标文件.pdf')).toBeNull()
  })

  it('mirrors only projection.composer into the session block', async () => {
    const setComposerBlock = vi.fn()
    const view = render(<BidStagePanel {...props(projection(), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith('请先上传本次招标文件') })

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: [],
      composer: { enabled: true },
    }), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith(undefined) })
  })

  it('dispatches retry and confirmation without changing projected runtime', async () => {
    const retryStage = vi.fn(async () => {})
    const confirmOutline = vi.fn(async (_confirmed: boolean) => {})
    const retryProjection = projection({ allowedActions: ['retry_stage'] })
    const view = render(<BidStagePanel {...props(retryProjection, { retryStage, confirmOutline })} />)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
    expect(screen.getByText('请上传本次招标文件')).toBeTruthy()

    const confirmationProjection = projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline'],
    })
    view.rerender(<BidStagePanel {...props(confirmationProjection, { retryStage, confirmOutline })} />)
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenLastCalledWith(true) })
    fireEvent.click(screen.getByRole('button', { name: '需要修改' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenLastCalledWith(false) })
    expect(screen.getByText('请确认技术标目录')).toBeTruthy()
  })
})

describe('ui-bid browser plugin', () => {
  it('registers the Bid input-dock entry and scopes composer blocks by session', () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const set = vi.fn()
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set } },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register,
      },
    } as unknown as ClientContext

    apply(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.dock', id: 'bid', order: -10,
    }), BidStagePanel)
    const options = register.mock.calls[0]![0] as unknown as {
      inject: (sessionId: string) => { setComposerBlock: (reason: string | undefined) => void }
    }
    const injected = options.inject('session_bid')
    injected.setComposerBlock('请先上传')
    expect(set).toHaveBeenLastCalledWith('session_bid', { reason: '请先上传' })
    injected.setComposerBlock(undefined)
    expect(set).toHaveBeenLastCalledWith('session_bid', undefined)
  })
})
