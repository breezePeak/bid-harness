// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOutlineEdits, OUTLINE_CONFIRMATION_ISSUES, type BidClientProjection, type OutlineArtifact, type OutlineDraftMutationRequest, type OutlineDraftView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BidConfirmationModeControl, BidStagePanel, type BidStagePanelProps } from '../src/client/BidStagePanel.tsx'
import { apply, BidActionError, OUTLINE_CONFIRMATION_REPAIR_ACTIONS } from '../src/client/index.ts'
import { createBidConfirmationModeStore } from '../src/client/confirmation-mode.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
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
    setReviewViewAvailable: vi.fn(),
    getDetails: vi.fn(async () => ({ tender: null, outline: null, body: false, outlinePresentation: null })),
    setDetailsAvailable: vi.fn(),
    selectReviewView: vi.fn(),
    reviewSurface: { host: () => document.body, subscribe: () => () => {} },
    useStore: <T,>(selector: (state: { mode: 'manual' | 'automatic'; attempted: string[] }) => T): T => (
      selector({ mode: 'manual', attempted: [] })
    ),
    actions: {
      setMode: vi.fn(),
      markAttempted: vi.fn(),
      clearAttempted: vi.fn(),
    },
    t,
    ...patch,
  } as unknown as BidStagePanelProps
}

function confirmationStore(mode: 'manual' | 'automatic' = 'manual') {
  const instance = createBidConfirmationModeStore().create()
  if (mode !== 'manual') instance.actions.setMode(mode)
  return {
    instance,
    useStore: <T,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => T): T => selector(
      useSyncExternalStore(listener => instance.subscribe(listener), () => instance.getSnapshot()),
    ),
    actions: instance.actions,
  }
}

function outlineDraft(outline: OutlineArtifact): OutlineDraftView {
  return { schema_version: 1, scope: 'technical_bid', revision: 1, source_outline_sha256: 'a'.repeat(64), draft_outline_sha256: 'b'.repeat(64), outline }
}

function outlineStore(initial: OutlineDraftView) {
  let current = initial
  const apply = vi.fn(async (request: OutlineDraftMutationRequest) => {
    current = { ...current, revision: current.revision + 1, draft_outline_sha256: String(current.revision + 1).padStart(64, '0'), outline: applyOutlineEdits(current.outline, request.operations) }
    return current
  })
  return { apply, current: () => current }
}

describe('BidStagePanel', () => {
  it('确认模式默认手动并可从输入工具栏切换为自动确认', () => {
    const store = confirmationStore()
    render(<BidConfirmationModeControl {...({
      sessionId: 'session_bid',
      useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { session_bid: { agentPreset: 'bid' } } }),
      useStore: store.useStore,
      actions: store.actions,
      t,
    } as unknown as Parameters<typeof BidConfirmationModeControl>[0])} />)

    expect(screen.getByRole('button', { name: '确认模式' }).textContent).toContain('手动确认')
    fireEvent.click(screen.getByRole('button', { name: '确认模式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '自动确认' }))
    expect(screen.getByRole('button', { name: '确认模式' }).textContent).toContain('自动确认')
    expect(store.instance.getSnapshot().mode).toBe('automatic')
  })

  it('自动确认目录等待草稿保存，并按 revision 与摘要只提交一次', async () => {
    const mode = confirmationStore()
    const initial = outlineDraft({
      schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{
        id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付', writable: true,
        must_answer: ['交付计划'], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
        scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
      }],
    })
    const saved = { ...initial, revision: 2, draft_outline_sha256: 'c'.repeat(64) }
    let finishSave!: (value: OutlineDraftView) => void
    const save = new Promise<OutlineDraftView>((resolve) => { finishSave = resolve })
    const applyOutlineDraftOperations = vi.fn(async () => save)
    const confirmOutline = vi.fn(async () => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      ...mode,
      getOutlineDraft: async () => initial,
      applyOutlineDraftOperations,
      confirmOutline,
    })} />)
    const title = await screen.findByLabelText('SEC-1 标题')
    fireEvent.click(screen.getByRole('button', { name: '编辑 交付方案' }))
    fireEvent.change(title, { target: { value: '更新后的交付方案' } })
    fireEvent.blur(title)
    await waitFor(() => { expect(applyOutlineDraftOperations).toHaveBeenCalledOnce() })

    act(() => { mode.actions.setMode('automatic') })
    expect(confirmOutline).not.toHaveBeenCalled()
    await act(async () => { finishSave(saved); await save })

    await waitFor(() => {
      expect(confirmOutline).toHaveBeenCalledOnce()
      expect(confirmOutline).toHaveBeenCalledWith({
        expected_revision: 2,
        expected_draft_sha256: 'c'.repeat(64),
      })
    })
  })

  it('自动目录确认失败后不循环重试', async () => {
    const mode = confirmationStore('automatic')
    const draft = outlineDraft({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [] })
    const confirmOutline = vi.fn(async () => { throw new Error('确认失败') })
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'evidence_mapping', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), { ...mode, getOutlineDraft: async () => draft, confirmOutline })} />)

    expect((await screen.findByRole('alert')).textContent).toContain('确认失败')
    await act(async () => { await Promise.resolve() })
    expect(confirmOutline).toHaveBeenCalledOnce()
  })

  it('S5 手动模式请求写作要求，自动模式直接启动且不处理失败或等待开始', async () => {
    const manualMode = confirmationStore()
    const requestWritingRequirements = vi.fn(async () => {})
    const autoStartChapterWriting = vi.fn(async () => {})
    const waiting = projection({
      runtime: { stage: 'chapter_writing', status: 'waiting_user' },
      allowedActions: ['request_writing_requirements', 'auto_start_chapter_writing', 'send_message'],
      composer: { enabled: true },
    })
    const manual = render(<BidStagePanel {...props(waiting, {
      ...manualMode, requestWritingRequirements, autoStartChapterWriting,
    })} />)
    await waitFor(() => { expect(requestWritingRequirements).toHaveBeenCalledOnce() })
    expect(autoStartChapterWriting).not.toHaveBeenCalled()
    manual.unmount()

    const automaticMode = confirmationStore('automatic')
    const automatic = render(<BidStagePanel {...props(waiting, {
      ...automaticMode, requestWritingRequirements, autoStartChapterWriting,
    })} />)
    await waitFor(() => { expect(autoStartChapterWriting).toHaveBeenCalledOnce() })
    expect(requestWritingRequirements).toHaveBeenCalledOnce()
    automatic.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'chapter_writing', status: 'failed', failureReason: '正文失败' },
      allowedActions: ['retry_stage'],
    }), { ...automaticMode, requestWritingRequirements, autoStartChapterWriting })} />)
    automatic.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'chapter_writing', status: 'waiting_start' },
      allowedActions: ['start_stage'],
    }), { ...automaticMode, requestWritingRequirements, autoStartChapterWriting })} />)
    await act(async () => { await Promise.resolve() })
    expect(autoStartChapterWriting).toHaveBeenCalledOnce()
  })

  it('会话摘要尚未补齐 preset 时仍以 Bid 投影开放分析视图', async () => {
    const setDetailsAvailable = vi.fn()
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'waiting_user' },
      allowedActions: ['confirm_tender_analysis'],
      composer: { enabled: false, reason: 'bid.tender_analysis_confirmation_required' },
    }), {
      useSessions: selector => selector({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }),
      setDetailsAvailable,
    })} />)

    expect(screen.getByText('请检查并确认技术标分析结果')).toBeTruthy()
    await waitFor(() => { expect(setDetailsAvailable).toHaveBeenCalledWith(null, false, true) })
  })

  it('确认数据与当前客户端版本不一致时保留确认提示而不让面板崩溃', async () => {
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'waiting_user' },
      allowedActions: ['confirm_tender_analysis'],
      composer: { enabled: false, reason: 'bid.tender_analysis_confirmation_required' },
    }), {
      getTenderAnalysisForConfirmation: async () => ({
        project: {}, requirements: { requirements: [] }, scoring: { scoring_items: [] }, compliance: { compliance_items: [] },
      }) as never,
    })} />)

    expect(screen.getByText('请检查并确认技术标分析结果')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('确认数据缺少评分项选择状态，请重启服务后重试。')
    expect(screen.queryByLabelText('技术标分析结果')).toBeNull()
  })

  it('等待态开放 Composer，阶段修改完成自动读取新 revision 并重新提示确认', async () => {
    const setComposerBlock = vi.fn()
    let draft = outlineDraft({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [] })
    const getOutlineDraft = vi.fn(async () => draft)
    const getEvidenceMappingProgress = vi.fn(async () => ({
      total: 1, initial: 1, supplemental: 0, completed: 1, running: 0, not_started: 0, failed: 0,
    }))
    const confirmOutline = vi.fn(async () => {})
    const shared = {
      setComposerBlock, getOutlineDraft, getEvidenceMappingProgress, confirmOutline, regenerateOutline: vi.fn(async () => {}),
    }
    const waiting = projection({ runtime: { stage: 'evidence_mapping', status: 'waiting_user' }, allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'], composer: { enabled: true } })
    const view = render(<BidStagePanel {...props(waiting, shared)} />)
    await waitFor(() => { expect(getOutlineDraft).toHaveBeenCalledOnce() })
    expect(setComposerBlock).toHaveBeenLastCalledWith(undefined, false)
    expect(screen.getByRole('button', { name: '使用该目录' })).toBeTruthy()
    view.rerender(<BidStagePanel {...props(projection({ runtime: { stage: 'evidence_mapping', status: 'running' }, composer: { enabled: false, reason: 'bid.stage_running' } }), shared)} />)
    expect(setComposerBlock).toHaveBeenLastCalledWith('当前阶段正在处理，请稍候', false)
    draft = { ...draft, revision: 2, draft_outline_sha256: 'c'.repeat(64) }
    view.rerender(<BidStagePanel {...props({ ...waiting }, shared)} />)
    expect(await screen.findByText('已更新，请重新确认。')).toBeTruthy()
    expect(setComposerBlock).toHaveBeenLastCalledWith(undefined, false)
    fireEvent.click(screen.getByRole('button', { name: '使用该目录' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenCalledWith({ expected_revision: 2, expected_draft_sha256: 'c'.repeat(64) }) })
    expect(getEvidenceMappingProgress.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
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

  it('shows the current S4 Mapping Task counts while the Host runs evidence mapping', async () => {
    const getEvidenceMappingProgress = vi.fn(async () => ({
      total: 10,
      initial: 8,
      supplemental: 2,
      completed: 3,
      running: 2,
      not_started: 5,
      failed: 0,
    }))
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'evidence_mapping', status: 'running' },
      composer: { enabled: false, reason: 'bid.stage_running' },
    }), { getEvidenceMappingProgress })} />)

    expect(await screen.findByText('研究任务：分支 8 个 · 复核 2 个 · 共 10 个 · 已完成 3 · 进行中 2 · 未开始 5')).toBeTruthy()
    expect(screen.getByText('研究任务')).toBeTruthy()
    expect(screen.getByText('3 / 10 (30%)')).toBeTruthy()
    expect(screen.getByText('分支 8')).toBeTruthy()
    expect(screen.getByText('复核 2')).toBeTruthy()
    expect(screen.getByText('进行中 2')).toBeTruthy()
    expect(screen.getByText('已完成 3')).toBeTruthy()
    expect(screen.getByText('未开始 5')).toBeTruthy()
    expect(getEvidenceMappingProgress).toHaveBeenCalledOnce()
  })

  it('shows reset completion and starts only after the user confirms', async () => {
    const startStage = vi.fn(async () => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'evidence_mapping', status: 'waiting_start' },
      allowedActions: ['start_stage'],
      composer: { enabled: false, reason: 'bid.stage_start_required' },
    }), { startStage })} />)

    expect(screen.getByText('阶段已重置完毕，请确认后开始执行')).toBeTruthy()
    expect(screen.getByText('等待开始')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开始本阶段' }))
    await waitFor(() => { expect(startStage).toHaveBeenCalledOnce() })
  })

  it('运行中单独显示停止任务，并调用阶段控制而不是聊天取消', async () => {
    const stopStage = vi.fn(async () => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'evidence_mapping', status: 'running' },
      allowedActions: ['send_message', 'stop_stage'],
      composer: { enabled: true },
    }), { stopStage })} />)

    const button = screen.getByRole('button', { name: '停止任务' })
    expect(button.getAttribute('title')).toContain('“停止回复”仅停止聊天回复')
    fireEvent.click(button)
    await waitFor(() => { expect(stopStage).toHaveBeenCalledOnce() })
  })

  it('stays absent for a non-Bid session even when a projection is available', () => {
    const useSessions = (selector: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) =>
      selector({ byId: { session_bid: { agentPreset: 'standard' } } })
    render(<BidStagePanel {...props(projection(), { useSessions } as Partial<BidStagePanelProps>)} />)
    expect(screen.queryByRole('region', { name: '技术标生成' })).toBeNull()
  })

  it('shows file selection only when upload_files is admitted', async () => {
    const view = render(<BidStagePanel {...props(projection())} />)
    expect(screen.queryByRole('button', { name: '招标文件' })).toBeNull()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
      allowedExtensions: ['.pdf', '.docx'],
      maxFiles: 4,
    }), { uploadFiles: vi.fn(async () => []) })} />)
    expect(screen.getByRole('button', { name: '上传招标文件' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传人工框架 / 半成品标书' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传参考旧标书' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传其他技术资料' })).toBeTruthy()
    const inputs = view.container.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(4)
    fireEvent.change(inputs[0]!, {
      target: { files: [new File(['bid'], '招标文件.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    expect(screen.getAllByText('招标文件')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '上传并解析' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传并解析' })).toHaveProperty('disabled', false)
    fireEvent.change(inputs[1]!, {
      target: { files: [new File(['framework'], '人工框架.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.change(inputs[1]!, {
      target: { files: [new File(['replacement'], '替换框架.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.change(inputs[2]!, {
      target: { files: [new File(['reference-bid'], '旧标书.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.change(inputs[3]!, {
      target: { files: [new File(['reference'], '项目资料.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.queryByText('人工框架.pdf')).toBeNull()
    expect(screen.getByText('替换框架.pdf')).toBeTruthy()
    expect(screen.getByText('旧标书.pdf')).toBeTruthy()
    expect(screen.getByText('项目资料.pdf')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除文件: 招标文件.pdf' }))
    expect(screen.queryByText('招标文件.pdf')).toBeNull()
    expect(screen.getByRole('button', { name: '上传并解析' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '上传并解析' }))
    expect((await screen.findByRole('alert')).textContent).toContain('请至少选择一个招标文件')
  })

  it('clears the browser upload queue when file intake advances to tender analysis', () => {
    const view = render(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { uploadFiles: vi.fn(async () => []) })} />)
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, {
      target: { files: [new File(['tender'], '招标文件.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.change(inputs[3]!, {
      target: { files: [new File(['reference'], '项目资料.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    expect(screen.getByText('项目资料.pdf')).toBeTruthy()
    expect(screen.getByText('招标文件')).toBeTruthy()
    expect(screen.getByText('其他技术资料')).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除文件: 招标文件.pdf' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除文件: 项目资料.pdf' })).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'file_intake', status: 'running' },
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    expect(screen.getByText('项目资料.pdf')).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'running' },
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.getByText('招标分析')).toBeTruthy()
    expect(screen.getByText('正在分析招标文件')).toBeTruthy()
    expect(screen.queryByText('招标文件.pdf')).toBeNull()
    expect(screen.queryByText('项目资料.pdf')).toBeNull()
    expect(screen.queryByText('招标文件')).toBeNull()
    expect(screen.queryByText('其他技术资料')).toBeNull()
    expect(screen.queryByRole('button', { name: '移除文件: 招标文件.pdf' })).toBeNull()
    expect(screen.queryByRole('button', { name: '移除文件: 项目资料.pdf' })).toBeNull()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.queryByText('招标文件.pdf')).toBeNull()
    expect(screen.queryByText('项目资料.pdf')).toBeNull()
  })

  it('keeps partial file-intake failures visible after the stage advances', async () => {
    const uploadFiles = vi.fn(async () => [{
      name: '旧标书.pdf',
      role: 'reference_bid' as const,
      status: 'failed' as const,
      error: { code: 'BID_FILE_TYPE_UNSUPPORTED' as const, message: '文件类型不受支持' },
    }])
    const view = render(<BidStagePanel {...props(projection({ allowedActions: ['upload_files'] }), { uploadFiles })} />)
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, { target: { files: [new File(['tender'], '招标文件.pdf', { type: 'application/pdf' })] } })
    fireEvent.change(inputs[2]!, { target: { files: [new File(['reference'], '旧标书.pdf', { type: 'application/pdf' })] } })
    fireEvent.click(screen.getByRole('button', { name: '上传并解析' }))

    expect((await screen.findByRole('alert')).textContent).toContain('旧标书.pdf: 文件类型不受支持')
    expect(uploadFiles).toHaveBeenCalledWith(
      [
        expect.objectContaining({ role: 'tender' }),
        expect.objectContaining({ role: 'reference_bid' }),
      ],
      expect.any(Function),
    )
    view.rerender(<BidStagePanel {...props(projection({ runtime: { stage: 'tender_analysis', status: 'pending' } }), { uploadFiles })} />)
    expect(screen.getByRole('alert').textContent).toContain('旧标书.pdf: 文件类型不受支持')
  })

  it('does not carry a browser upload queue into another file-intake Session', () => {
    const useSessions = ((selector: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) => selector({
      byId: {
        session_bid: { agentPreset: 'bid' },
        session_other: { agentPreset: 'bid' },
      },
    })) as unknown as BidStagePanelProps['useSessions']
    const view = render(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { uploadFiles: vi.fn(async () => []), useSessions })} />)
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, {
      target: { files: [new File(['tender'], '上一会话标书.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('上一会话标书.pdf')).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { sessionId: 'session_other' as BidStagePanelProps['sessionId'], uploadFiles: vi.fn(async () => []), useSessions })} />)

    expect(screen.queryByText('上一会话标书.pdf')).toBeNull()
  })

  it('submits the selected files once and keeps them available after a Host refusal', async () => {
    const first = Promise.withResolvers<readonly never[]>()
    const uploadFiles = vi.fn(async () => first.promise)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([])
    const view = render(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
      allowedExtensions: ['.md'],
      maxFiles: 1,
    }), { uploadFiles })} />)
    const file = new File(['# 招标要求'], 'requirements.md', { type: 'text/markdown' })
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('button', { name: '上传并解析' }))
    expect(uploadFiles).toHaveBeenCalledOnce()
    expect(uploadFiles).toHaveBeenCalledWith([
      { file, role: 'tender' },
    ], expect.any(Function))
    expect(screen.getByRole('button', { name: '正在上传…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '上传招标文件' })).toHaveProperty('disabled', true)
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
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.getByText('文件接入失败，请重新选择或再次上传文件')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('文档无法解析')
    expect(screen.getByRole('button', { name: '上传招标文件' })).toBeTruthy()
  })

  it('shows every structured S2 validation issue and keeps retry available', () => {
    const retryStage = vi.fn(async () => {})
    render(<BidStagePanel {...props(projection({
      runtime: {
        stage: 'tender_analysis',
        status: 'failed',
        failureReason: '招标分析结果未通过校验。',
        failureIssues: [
          {
            code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
            artifact: 'analysis/scoring.json',
            path: 'scoring_items[2].response_points',
            message: '至少需要一项技术响应重点。',
          },
          {
            code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
            artifact: 'analysis/compliance.json',
            path: 'compliance_items[0].severity',
            message: '只能使用 fatal、mandatory 或 warning。',
          },
        ],
      },
      allowedActions: ['retry_stage'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    }), { retryStage })} />)

    expect(screen.getByText('校验发现 2 个问题')).toBeTruthy()
    expect(screen.getByText('文件：analysis/scoring.json')).toBeTruthy()
    expect(screen.getByText('字段：scoring_items[2].response_points')).toBeTruthy()
    expect(screen.getByText('原因：至少需要一项技术响应重点。')).toBeTruthy()
    expect(screen.getByText('文件：analysis/compliance.json')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认技术标分析' })).toBeNull()
  })

  it('mirrors only projection.composer into the session block', async () => {
    const setComposerBlock = vi.fn()
    const view = render(<BidStagePanel {...props(projection(), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith('请先添加本项目资料', false) })

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: [],
      composer: { enabled: true },
    }), { setComposerBlock })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith(undefined, false) })
  })

  it('exposes the shared workbench throughout S5 without moving the composer', async () => {
    const setComposerBlock = vi.fn()
    const selectReviewView = vi.fn()
    const setReviewViewAvailable = vi.fn()
    const view = render(<BidStagePanel {...props(projection({
      runtime: { stage: 'chapter_writing', status: 'running' },
      composer: { enabled: false, reason: 'bid.stage_running' },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith('当前阶段正在处理，请稍候', false) })
    expect(setReviewViewAvailable).toHaveBeenLastCalledWith(true)
    expect(selectReviewView).toHaveBeenCalledOnce()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'docx_export', status: 'completed' },
      allowedActions: ['export_docx'],
      composer: { enabled: false, reason: 'bid.completed' },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    expect(setReviewViewAvailable).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('正文编写')).toBeTruthy()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'running' },
      composer: { enabled: false, reason: 'bid.stage_running' },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    expect(setReviewViewAvailable).toHaveBeenLastCalledWith(false)
  })

  it('dispatches retry and confirmation without changing projected runtime', async () => {
    const retryStage = vi.fn(async () => {})
    const confirmOutline = vi.fn(async () => {})
    const draft = outlineDraft({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [] })
    const retryProjection = projection({ allowedActions: ['retry_stage'] })
    const view = render(<BidStagePanel {...props(retryProjection, { retryStage, confirmOutline })} />)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
    expect(screen.getByText('请添加本项目资料')).toBeTruthy()

    const confirmationProjection = projection({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    })
    view.rerender(<BidStagePanel {...props(confirmationProjection, { retryStage, confirmOutline, getOutlineDraft: async () => draft })} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用该目录' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '使用该目录' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenLastCalledWith({ expected_revision: 1, expected_draft_sha256: 'b'.repeat(64) }) })
    expect(screen.getByText('请确认技术标目录')).toBeTruthy()
  })

  it('discards an action failure after the Host advances the stage', async () => {
    const retry = Promise.withResolvers<undefined>()
    const retryStage = vi.fn(() => retry.promise)
    const view = render(<BidStagePanel {...props(projection({
      runtime: { stage: 'file_intake', status: 'failed', failureReason: '网络错误' },
      allowedActions: ['retry_stage'],
    }), { retryStage })} />)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'evidence_mapping', status: 'waiting_user' },
      allowedActions: ['confirm_outline'],
      composer: { enabled: true },
    }), { retryStage, getOutlineDraft: async () => outlineDraft({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [] }) })} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用该目录' })).toBeTruthy() })
    await act(async () => {
      retry.reject(new Error('client api: bid/retryStage failed: Failed to fetch (internal)'))
      await retry.promise.catch(() => {})
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows every technical scoring item, emits controlled S2 edits, and keeps invalid confirmation editable', async () => {
    const confirmation = Promise.withResolvers<undefined>()
    const confirmTenderAnalysis = vi.fn(async (_operations: readonly unknown[]) => confirmation.promise)
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'waiting_user' },
      allowedActions: ['confirm_tender_analysis'],
      composer: { enabled: false, reason: 'bid.tender_analysis_confirmation_required' },
    }), {
      confirmTenderAnalysis,
      getTenderAnalysisForConfirmation: async () => ({
        project: {
          schema_version: 1, project_name: '原项目', tender_name: '招标', purchaser: '采购人', owner: '建设单位',
          project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['建设平台'],
          technical_scope: ['总体架构'], delivery_scope: ['部署交付'], implementation_constraints: ['三个月上线'],
          key_technical_points: ['安全架构'], source_refs: [{ file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 2 }],
          analyzed_tender_files: ['tender'],
        },
        scoring: {
          schema_version: 1,
          scoring_items: ['总体方案', '实施方案'].map((title, index) => ({
            id: `SCORE-${String(index + 1)}`, parent: null, group: '技术评分', title,
            raw_text: `${title}完整合理得 ${String(10 - index)} 分`, criterion: `${title}完整合理`,
            score: 10 - index, score_range: null, must_answer: true,
            source_refs: [{ file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 2 }],
          })),
        },
        selected_scoring_ids: ['SCORE-1', 'SCORE-2'],
        requirements: { schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '满足安全要求', normalized_requirement: '满足安全要求', mandatory: true, source_refs: [{ file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 2 }] }] },
        compliance: { schema_version: 1, compliance_items: [{ id: 'COMP-1', type: '合规', raw_text: '不得偏离', normalized_rule: '不得偏离', severity: 'mandatory', source_refs: [{ file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 2 }] }] },
      }),
    })} />)

    expect(await screen.findByLabelText('技术标分析结果')).toBeTruthy()
    // 双栏工作台在左侧保留全量索引，右侧只编辑当前选中项。
    fireEvent.click(screen.getByRole('button', { name: /项目整体情况/ }))
    fireEvent.click(screen.getByText('项目技术重点'))
    fireEvent.change(screen.getByLabelText('项目技术重点'), { target: { value: '安全架构\n兼容既有系统' } })
    fireEvent.click(screen.getByRole('button', { name: /技术评分要点/ }))
    expect(screen.getByDisplayValue('总体方案')).toBeTruthy()
    expect(screen.getByText('实施方案')).toBeTruthy()
    fireEvent.click(screen.getByText('实施方案'))
    expect(screen.getByDisplayValue('实施方案')).toBeTruthy()
    fireEvent.click(screen.getByText('总体方案'))
    expect(screen.getByText('总体方案完整合理得 10 分')).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText('评分目标理解')[0]!, { target: { value: '总体方案完整、合理且可实施' } })
    fireEvent.click(screen.getByRole('button', { name: '确认技术标分析' }))
    expect(screen.getByRole('button', { name: '正在确认…' })).toHaveProperty('disabled', true)
    await waitFor(() => {
      expect(confirmTenderAnalysis).toHaveBeenCalledWith(expect.arrayContaining([
        { type: 'update_project', fields: { key_technical_points: ['安全架构', '兼容既有系统'] } },
        { type: 'update_scoring_item', scoring_id: 'SCORE-1', fields: { criterion: '总体方案完整、合理且可实施' } },
      ]))
    })
    confirmation.reject(new BidActionError('BID_INVALID_TENDER_ANALYSIS_EDIT', '修改无效', [{ code: 'EDIT_INVALID', message: '规范化字段不能为空' }]))
    expect(await screen.findByText('EDIT_INVALID: 规范化字段不能为空')).toBeTruthy()
    expect(screen.getByLabelText('技术标分析结果')).toBeTruthy()
  })

  it('edits outline text and emits basic structural operations', async () => {
    const confirmOutline = vi.fn(async () => {})
    const initial = outlineDraft({
      schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{
        id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付', writable: true,
        must_answer: ['交付计划'], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
      }],
    })
    const store = outlineStore(initial)
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      confirmOutline,
      getOutlineDraft: async () => initial,
      applyOutlineDraftOperations: store.apply,
    })} />)
    const title = await screen.findByLabelText('SEC-1 标题')
    fireEvent.click(screen.getByRole('button', { name: `编辑 ${(title as HTMLInputElement).value}` }))
    fireEvent.change(title, { target: { value: '更新标题' } })
    fireEvent.blur(title)
    fireEvent.click(screen.getAllByRole('button', { name: '新增同级' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '使用该目录' }))
    await waitFor(() => {
      expect(store.apply.mock.calls.flatMap(call => call[0].operations)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'update_section', section_id: 'SEC-1', title: '更新标题' }),
        expect.objectContaining({ type: 'add_section' }),
        expect.objectContaining({ type: 'delete_section', section_id: 'SEC-1' }),
      ]))
      expect(confirmOutline).toHaveBeenCalledWith({
        expected_revision: store.current().revision,
        expected_draft_sha256: store.current().draft_outline_sha256,
      })
    })
  })

  it('目录确认仅在审核页面显示，不显示修改目录输入框', async () => {
    const draft = outlineDraft({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [] })
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      confirmOutline: vi.fn(async () => {}),
      getOutlineDraft: async () => draft,
    })} />)

    expect(await screen.findByText('确认后将按当前目录开始章节编写')).toBeTruthy()
    const dock = within(screen.getByRole('region', { name: '技术标生成' }))
    expect(dock.queryByRole('button', { name: '使用该目录' })).toBeNull()
    expect(dock.queryByLabelText('修改目录')).toBeNull()
    expect(screen.queryByLabelText('修改目录')).toBeNull()
    expect(screen.getByRole('button', { name: '使用该目录' })).toBeTruthy()
  })

  it('immediately previews hierarchy, order, and derived section numbers', async () => {
    const initial = outlineDraft({
      schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: ['A', 'B', 'C'].map((id, index) => ({
        id, parent_id: null, order: index + 1, level: 1, title: id, purpose: `${id} purpose`, writable: true,
        must_answer: [`${id} answer`], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
      })),
    })
    const store = outlineStore(initial)
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      confirmOutline: vi.fn(async () => {}),
      getOutlineDraft: async () => initial,
      applyOutlineDraftOperations: store.apply,
    })} />)
    await screen.findByLabelText('C 标题')
    expect(screen.getByLabelText('C 章节编号').textContent).toBe('3')
    fireEvent.focus(screen.getByLabelText('C 标题'))
    fireEvent.click(screen.getByRole('button', { name: '上移' }))
    await waitFor(() => { expect(screen.getByLabelText('C 章节编号').textContent).toBe('2') })
    expect(screen.getByLabelText('B 章节编号').textContent).toBe('3')
    fireEvent.focus(screen.getByLabelText('B 标题'))
    fireEvent.click(screen.getByRole('button', { name: '缩进' }))
    await waitFor(() => { expect(screen.getByLabelText('B 章节编号').textContent).toBe('2.1') })
    fireEvent.click(screen.getAllByRole('button', { name: '新增同级' })[0]!)
    expect(await screen.findByLabelText('SEC-001 章节编号')).toBeTruthy()
  })
})
describe('ui-bid browser plugin', () => {
  it('covers every Host S5 issue with the same browser repair action', () => {
    expect(Object.keys(OUTLINE_CONFIRMATION_REPAIR_ACTIONS).sort()).toEqual(Object.keys(OUTLINE_CONFIRMATION_ISSUES).sort())
    for (const [code, definition] of Object.entries(OUTLINE_CONFIRMATION_ISSUES)) {
      expect(OUTLINE_CONFIRMATION_REPAIR_ACTIONS[code as keyof typeof OUTLINE_CONFIRMATION_REPAIR_ACTIONS]).toBe(definition.repair_action)
      expect(definition.user_visible).toBe(true)
      expect(typeof definition.user_editable).toBe('boolean')
      expect(typeof definition.owner).toBe('string')
      expect(typeof definition.repair_action).toBe('string')
    }
  })

  it('declares every client service read by its slot injections', async () => {
    const { inject } = await import('../src/client/index.ts')
    expect(inject).toContain('sessions')
  })

  it('registers the Bid input-dock entry, scopes composer blocks, and calls the Bid Remote', async () => {
    const register = vi.fn((_definition: unknown, _component: unknown) => () => {})
    const set = vi.fn()
    const remoteRetry = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'evidence_mapping' as const, status: 'pending' as const } },
      })
    const remoteStart = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'evidence_mapping' as const, status: 'waiting_user' as const } },
      })
    const remoteStop = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'evidence_mapping' as const, status: 'failed' as const } },
      })
    const remoteRequestWritingRequirements = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'chapter_writing' as const, status: 'waiting_user' as const } },
      })
    const remoteAutoStartChapterWriting = vi.fn<(_sessionId: string) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true as const,
        value: { ok: true as const, value: { stage: 'chapter_writing' as const, status: 'running' as const } },
      })
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: { register: vi.fn(() => () => {}) },
      conversation: { blocks: { set } },
      remote: { bid: {
        retryStage: remoteRetry,
        startStage: remoteStart,
        stopStage: remoteStop,
        requestWritingRequirements: remoteRequestWritingRequirements,
        autoStartChapterWriting: remoteAutoStartChapterWriting,
      } },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register,
      },
    } as unknown as ClientContext

    apply(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.dock', id: 'bid', order: -10,
    }), BidStagePanel)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.left', id: 'bid-confirmation-mode', order: 20,
    }), BidConfirmationModeControl)
    const registration = register.mock.calls.find(([definition]) => (definition as { name: string }).name === 'conversation.input.dock')
    if (registration === undefined) throw new Error('Bid dock registration is unavailable')
    const options = registration[0] as {
      inject: (sessionId: string) => {
        setComposerBlock: (reason: string | undefined) => void
        uploadFiles: (files: readonly { file: File; role: 'tender' | 'outline_framework' | 'reference_bid' | 'reference' }[]) => Promise<void>
        retryStage: () => Promise<void>
        startStage: () => Promise<void>
        stopStage: () => Promise<void>
        requestWritingRequirements: () => Promise<void>
        autoStartChapterWriting: () => Promise<void>
      }
    }
    const injected = options.inject('session_bid')
    injected.setComposerBlock('请先上传')
    expect(set).toHaveBeenLastCalledWith('session_bid', { reason: '请先上传' })
    injected.setComposerBlock(undefined)
    expect(set).toHaveBeenLastCalledWith('session_bid', undefined)

    const uploadFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      new Request(input, init)
      return new Response(JSON.stringify({
        ok: true,
        value: { stage: 'tender_analysis', status: 'pending' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', uploadFetch)
    const tenderBytes = Uint8Array.from({ length: 2049 }, (_, index) => index % 256)
    const tender = new File([tenderBytes], 'requirements.md', { type: 'text/markdown' })
    const referenceBidBytes = Uint8Array.of(4, 5)
    const referenceBid = new File([referenceBidBytes], 'reference-bid.md', { type: 'text/markdown' })
    await injected.uploadFiles([{ file: tender, role: 'tender' }, { file: referenceBid, role: 'reference_bid' }])
    expect(uploadFetch).toHaveBeenCalledTimes(1)
    const init = uploadFetch.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init).not.toHaveProperty('duplex')
    expect(init.body).toBeInstanceOf(Blob)
    expect(init.headers).toMatchObject({
      'x-dsh-bid-session-id': 'session_bid',
      'x-dsh-bid-files': encodeURIComponent(JSON.stringify([
        {
          name: 'requirements.md',
          role: 'tender',
          mediaType: 'text/markdown',
          size: 2049,
        },
        {
          name: 'reference-bid.md',
          role: 'reference_bid',
          mediaType: 'text/markdown',
          size: 2,
        },
      ])),
    })
    const uploadedBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => { resolve(new Uint8Array(reader.result as ArrayBuffer)) })
      reader.addEventListener('error', () => { reject(reader.error ?? new Error('FileReader failed')) })
      reader.readAsArrayBuffer(init.body as Blob)
    })
    expect(uploadedBytes).toEqual(Uint8Array.from([...tenderBytes, ...referenceBidBytes]))

    uploadFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error: { code: 'BID_FILE_TYPE_UNSUPPORTED', message: '不支持该文件类型' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(injected.uploadFiles([{ file: tender, role: 'tender' }])).rejects.toThrow('不支持该文件类型 (BID_FILE_TYPE_UNSUPPORTED)')

    await injected.retryStage()
    expect(remoteRetry).toHaveBeenCalledWith('session_bid')
    await injected.startStage()
    expect(remoteStart).toHaveBeenCalledWith('session_bid')
    await injected.stopStage()
    expect(remoteStop).toHaveBeenCalledWith('session_bid')
    await injected.requestWritingRequirements()
    expect(remoteRequestWritingRequirements).toHaveBeenCalledWith('session_bid')
    await injected.autoStartChapterWriting()
    expect(remoteAutoStartChapterWriting).toHaveBeenCalledWith('session_bid')
  })

  it('supports direct editing of the selected S2 review item and submits the change', async () => {
    const confirmTenderAnalysis = vi.fn(async () => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'waiting_user' },
      allowedActions: ['confirm_tender_analysis'],
      composer: { enabled: false, reason: 'bid.tender_analysis_confirmation_required' },
    }), {
      confirmTenderAnalysis,
      getTenderAnalysisForConfirmation: async () => ({
        project: {
          schema_version: 1, project_name: '原项目名称', tender_name: '原招标名称', purchaser: '采购方', owner: '业主单位',
          project_background: ['项目背景条目一', '项目背景条目二'], project_objectives: ['目标一'], project_scope: ['范围一'],
          technical_scope: ['技术范围一'], delivery_scope: ['交付范围一'], implementation_constraints: ['约束一'],
          key_technical_points: ['技术重点一'], source_refs: [], analyzed_tender_files: ['tender'],
        },
        scoring: {
          schema_version: 1,
          scoring_items: [{
            id: 'SCORE-1', parent: null, group: '技术评分', title: '初始评分项',
            raw_text: '初始评分条款原文', criterion: '初始评分标准', score: 10, score_range: null, must_answer: true,
            source_refs: [],
          }],
        },
        selected_scoring_ids: ['SCORE-1'],
        requirements: { schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '要求原文', normalized_requirement: '初始技术要求', mandatory: true, source_refs: [] }] },
        compliance: { schema_version: 1, compliance_items: [{ id: 'COMP-1', type: '合规', raw_text: '合规原文', normalized_rule: '初始合规规则', severity: 'mandatory', source_refs: [] }] },
      }),
    })} />)

    expect(await screen.findByLabelText('技术标分析结果')).toBeTruthy()
    expect(screen.getByDisplayValue('原项目名称')).toBeTruthy()
    expect(screen.getByText('项目背景')).toBeTruthy()
    const input = screen.getByDisplayValue('原项目名称')
    fireEvent.change(input, { target: { value: '直接修改后的新项目名称' } })
    expect(screen.getByDisplayValue('直接修改后的新项目名称')).toBeTruthy()

    // 顶部红框确认按钮提交
    fireEvent.click(screen.getByRole('button', { name: '确认技术标分析' }))
    await waitFor(() => {
      expect(confirmTenderAnalysis).toHaveBeenCalledWith(expect.arrayContaining([
        { type: 'update_project', fields: { project_name: '直接修改后的新项目名称' } },
      ]))
    })
  })

  it('renders uploaded files with card format, metadata, badges and omits inline help prose', () => {
    const intake = projection({
      runtime: { stage: 'file_intake', status: 'pending' },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.upload_required' },
    })
    const { container } = render(<BidStagePanel {...props(intake)} />)

    // 1. 验证移除了红框中的三行说明文字
    expect(screen.queryByText('已有目录或已写一部分正文，系统将优先继承并补充。')).toBeNull()
    expect(screen.queryByText('与当前项目相似，系统可复用结构和技术内容，但会按当前项目改写。')).toBeNull()
    expect(screen.queryByText('产品、平台、案例、公司能力和通用技术资料。')).toBeNull()

    // 2. 模拟用户选择了文件
    const fileInputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]')
    expect(fileInputs.length).toBe(4)
    const tenderInput = fileInputs[0]!
    const frameworkInput = fileInputs[1]!

    const file1 = new File(['content-1'.repeat(200)], '招标文件-2026年项目.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const file2 = new File(['framework-content'.repeat(500)], '人工框架-CW.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })

    fireEvent.change(tenderInput, { target: { files: [file1] } })
    fireEvent.change(frameworkInput, { target: { files: [file2] } })

    // 3. 验证卡片展示：文件名、角色胶囊、文件大小
    expect(screen.getByText('招标文件-2026年项目.docx')).toBeTruthy()
    expect(screen.getByText('人工框架-CW.docx')).toBeTruthy()
    expect(screen.getByText('招标文件')).toBeTruthy()
    expect(screen.getByText('人工框架')).toBeTruthy()
    expect(screen.getByText('1.8 KB')).toBeTruthy()
    expect(screen.getByText('8.3 KB')).toBeTruthy()

    // 4. 验证删除功能
    const removeButtons = screen.getAllByLabelText(/移除文件/)
    expect(removeButtons).toHaveLength(2)
    fireEvent.click(removeButtons[0]!)

    expect(screen.queryByText('招标文件-2026年项目.docx')).toBeNull()
    expect(screen.getByText('人工框架-CW.docx')).toBeTruthy()
  })
})
