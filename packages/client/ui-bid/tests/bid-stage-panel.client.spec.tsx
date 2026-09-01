// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BidClientProjection } from '@deepseek-ai/dsh-bid/control-plane'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BidStagePanel, type BidStagePanelProps } from '../src/client/BidStagePanel.tsx'
import { apply, BidActionError } from '../src/client/index.ts'
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
    setReviewViewAvailable: vi.fn(),
    selectReviewView: vi.fn(),
    reviewSurface: { host: () => document.body, subscribe: () => () => {} },
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
    }), { uploadFiles: vi.fn(async () => []) })} />)
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

  it('clears the browser upload queue when file intake advances to tender analysis', () => {
    const view = render(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { uploadFiles: vi.fn(async () => []) })} />)
    const inputs = view.container.querySelectorAll('input[type="file"]')
    fireEvent.change(inputs[0]!, {
      target: { files: [new File(['tender'], '招标文件.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.change(inputs[1]!, {
      target: { files: [new File(['reference'], '项目资料.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.getByText('招标文件.pdf')).toBeTruthy()
    expect(screen.getByText('项目资料.pdf')).toBeTruthy()
    expect(screen.getByText('招标资料')).toBeTruthy()
    expect(screen.getByText('相关资料')).toBeTruthy()
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
    expect(screen.queryByText('招标资料')).toBeNull()
    expect(screen.queryByText('相关资料')).toBeNull()
    expect(screen.queryByRole('button', { name: '移除文件: 招标文件.pdf' })).toBeNull()
    expect(screen.queryByRole('button', { name: '移除文件: 项目资料.pdf' })).toBeNull()

    view.rerender(<BidStagePanel {...props(projection({
      allowedActions: ['upload_files'],
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.queryByText('招标文件.pdf')).toBeNull()
    expect(screen.queryByText('项目资料.pdf')).toBeNull()
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
    ], expect.any(Function))
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
    }), { uploadFiles: vi.fn(async () => []) })} />)

    expect(screen.getByText('文件接入失败，请重新选择或再次上传文件')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('文档无法解析')
    expect(screen.getByRole('button', { name: '上传标书' })).toBeTruthy()
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

  it('moves the composer into the shared S7 workbench only while review waits for the user', async () => {
    const setComposerBlock = vi.fn()
    const selectReviewView = vi.fn()
    const setReviewViewAvailable = vi.fn()
    const view = render(<BidStagePanel {...props(projection({
      runtime: { stage: 'book_review', status: 'running' },
      composer: { enabled: false, reason: 'bid.stage_running' },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith('当前阶段正在处理，请稍候', false) })
    expect(setReviewViewAvailable).toHaveBeenLastCalledWith(false)
    expect(selectReviewView).not.toHaveBeenCalled()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'book_review', status: 'waiting_user' },
      composer: { enabled: true },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    await waitFor(() => { expect(setComposerBlock).toHaveBeenLastCalledWith(undefined, true) })
    expect(selectReviewView).toHaveBeenCalledOnce()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'book_review', status: 'waiting_user' },
      composer: { enabled: true },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    expect(selectReviewView).toHaveBeenCalledOnce()

    view.rerender(<BidStagePanel {...props(projection({
      runtime: { stage: 'tender_analysis', status: 'running' },
      composer: { enabled: false, reason: 'bid.stage_running' },
    }), { setComposerBlock, selectReviewView, setReviewViewAvailable })} />)
    expect(setReviewViewAvailable).toHaveBeenLastCalledWith(false)
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
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    })
    view.rerender(<BidStagePanel {...props(confirmationProjection, { retryStage, confirmOutline })} />)
    fireEvent.click(screen.getByRole('button', { name: '使用该目录' }))
    await waitFor(() => { expect(confirmOutline).toHaveBeenLastCalledWith([]) })
    expect(screen.getByText('请确认技术标目录')).toBeTruthy()
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
            score: 10 - index, score_range: null, must_answer: true, response_points: [`${title}响应重点`],
            source_refs: [{ file_id: 'tender', chunk: 'chunk.md', line_start: 1, line_end: 2 }],
          })),
        },
      }),
    })} />)

    expect(await screen.findByLabelText('技术标分析结果')).toBeTruthy()
    expect(screen.getByText('总体方案')).toBeTruthy()
    expect(screen.getByText('实施方案')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('项目技术重点'), { target: { value: '安全架构\n兼容既有系统' } })
    fireEvent.click(screen.getByText('总体方案'))
    expect(screen.getByText('总体方案完整合理得 10 分')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('SCORE-1 评分目标理解'), { target: { value: '总体方案完整、合理且可实施' } })
    fireEvent.change(screen.getByLabelText('SCORE-1 技术标需要重点响应'), { target: { value: '总体架构\n实施路径' } })
    fireEvent.click(screen.getByRole('button', { name: '确认技术标分析' }))
    expect(screen.getByRole('button', { name: '正在确认…' })).toHaveProperty('disabled', true)
    await waitFor(() => {
      expect(confirmTenderAnalysis).toHaveBeenCalledWith(expect.arrayContaining([
        { type: 'update_project', fields: { key_technical_points: ['安全架构', '兼容既有系统'] } },
        expect.objectContaining({
          type: 'update_scoring_item', scoring_id: 'SCORE-1', criterion: '总体方案完整、合理且可实施',
          response_points: ['总体架构', '实施路径'],
        }),
      ]))
    })
    confirmation.reject(new BidActionError('BID_INVALID_TENDER_ANALYSIS_EDIT', '修改无效', [{ code: 'EDIT_INVALID', message: '响应重点不能为空' }]))
    expect(await screen.findByText('EDIT_INVALID: 响应重点不能为空')).toBeTruthy()
    expect(screen.getByLabelText('技术标分析结果')).toBeTruthy()
  })

  it('edits outline text and emits basic structural operations', async () => {
    const confirmOutline = vi.fn(async (_operations: readonly unknown[]) => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
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
    fireEvent.click(screen.getAllByRole('button', { name: '新增同级' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '使用该目录' }))
    await waitFor(() => {
      expect(confirmOutline).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ type: 'update_section', section_id: 'SEC-1', title: '更新标题' }),
        expect.objectContaining({ type: 'add_section' }),
        expect.objectContaining({ type: 'delete_section', section_id: 'SEC-1' }),
      ]))
    })
  })

  it('shows separate outline acceptance and feedback-regeneration rows', async () => {
    const regenerateOutline = vi.fn(async (_feedback: string) => {})
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      confirmOutline: vi.fn(async () => {}),
      regenerateOutline,
    })} />)

    expect(screen.getByText('确认后将按当前目录开始章节编写')).toBeTruthy()
    const feedback = screen.getByLabelText('修改目录')
    const regenerate = screen.getByRole('button', { name: '重新生成目录' })
    expect(regenerate).toHaveProperty('disabled', true)
    fireEvent.change(feedback, { target: { value: '  标书目录颗粒度太粗了  ' } })
    expect(regenerate).toHaveProperty('disabled', false)
    fireEvent.click(regenerate)
    await waitFor(() => { expect(regenerateOutline).toHaveBeenCalledWith('标书目录颗粒度太粗了') })
  })

  it('immediately previews hierarchy, order, and derived section numbers', async () => {
    render(<BidStagePanel {...props(projection({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline'],
    }), {
      confirmOutline: vi.fn(async () => {}),
      getOutlineForConfirmation: async () => ({
        schema_version: 1, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: ['A', 'B', 'C'].map((id, index) => ({
          id, parent_id: null, order: index + 1, level: 1, title: id, purpose: `${id} purpose`, writable: true,
          must_answer: [`${id} answer`], requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
        })),
      }),
    })} />)
    await screen.findByLabelText('C 标题')
    expect(screen.getByLabelText('C 章节编号').textContent).toBe('3')
    fireEvent.click(screen.getAllByRole('button', { name: '上移' })[2]!)
    expect(screen.getByLabelText('C 章节编号').textContent).toBe('2')
    expect(screen.getByLabelText('B 章节编号').textContent).toBe('3')
    fireEvent.click(screen.getAllByRole('button', { name: '缩进' })[2]!)
    expect(screen.getByLabelText('B 章节编号').textContent).toBe('2.1')
    fireEvent.click(screen.getAllByRole('button', { name: '新增同级' })[0]!)
    expect(await screen.findByLabelText('tmp-1 章节编号')).toBeTruthy()
  })
})

describe('ui-bid browser plugin', () => {
  it('declares every client service read by its slot injections', async () => {
    const { inject } = await import('../src/client/index.ts')
    expect(inject).toContain('sessions')
  })

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
