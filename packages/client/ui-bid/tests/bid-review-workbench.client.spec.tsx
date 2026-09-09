// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidReviewWorkbench, type BidReviewWorkbenchProps } from '../src/client/BidReviewWorkbench.tsx'
import { createBidRevisionStore } from '../src/client/revision-reference.ts'

afterEach(cleanup)

const workbench = {
  schema_version: 2 as const,
  outline: [
    { section_id: 'ROOT', parent_id: null, order: 1, title: '技术方案', summary: '说明项目实施流程、人员分工与质量控制措施。', writable: false, writing_status: 'not_started' as const, review_status: 'not_started' as const, content_available: true, page_estimate: { status: 'available' as const, pages: 2, incomplete: true } },
    { section_id: 'SEC-1', parent_id: 'ROOT', order: 1, title: '实施方案', writable: true, writing_status: 'content_ready' as const, review_status: 'reviewing' as const, content_available: true },
  ],
  summary: { chapter_count: 1, content_count: 1, reviewed_count: 0, needs_attention_count: 0, page_estimate: { status: 'available' as const, pages: 3 } },
  global_compliance: { status: 'not_required' as const, reviewed_count: 0, total_count: 0, document_issues: [], delivery_todos: [] },
}

const chapter = {
  section_id: 'SEC-1', title: '实施方案', number: '1.1', heading_path: ['技术方案', '实施方案'], writable: true,
  markdown: '章节正文', content_sha256: 'a'.repeat(64), requirement_ids: ['REQ-1'], scoring_response_point_ids: ['RP-000001'], evidence_status: 'available' as const,
  materials: [{ source_kind: 'reference_bid' as const, source_label: '参考旧标', file_id: 'ref-01.docx', usage: 'adapt', summary: '历史同类实施方案' }],
  review: { status: 'reviewing' as const, issues: [] },
}

function props(patch: Partial<BidReviewWorkbenchProps> = {}): BidReviewWorkbenchProps {
  const store = createBidRevisionStore().create()
  return {
    useStore: selector => selector(store.getSnapshot()),
    actions: store.actions,
    sessionId: 'bid' as SessionId,
    useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'bid' } } } as never),
    useProjection: () => ({ allowedActions: [], runtime: { stage: 'chapter_writing', status: 'running' } }),
    renderSlot: (name: string) => <div data-slot={name} />,
    getWorkbench: async () => workbench,
    getChapter: async () => chapter,
    ...patch,
  } as BidReviewWorkbenchProps
}

describe('BidReviewWorkbench', () => {
  it('仅为完整目录中的非叶节显示页数，折叠不改变叶节状态点', async () => {
    const branch = { ...workbench.outline[0]!, section_id: 'BRANCH', parent_id: 'ROOT', order: 1, title: '实施安排', page_estimate: { status: 'empty' as const } }
    const leaf = { ...workbench.outline[1]!, parent_id: 'BRANCH', order: 1 }
    render(
      <BidReviewWorkbench
        {...props({ getWorkbench: async () => ({ ...workbench, outline: [workbench.outline[0]!, branch, leaf] }) })}
      />,
    )
    expect(await screen.findByText('约 2 页')).toBeTruthy()
    expect(screen.getByText('—').getAttribute('title')).toContain('正文尚未生成')
    const leafButton = screen.getByRole('button', { name: '1.1.1 实施方案' })
    expect(leafButton.querySelector('[class*="statusDot"]')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '折叠' })[0]!)
    expect(screen.queryByRole('button', { name: '1.1.1 实施方案' })).toBeNull()
    expect(screen.getByText('约 2 页')).toBeTruthy()
  })

  it('展示部分、完成、空和不可用的页数状态', async () => {
    const { rerender } = render(<BidReviewWorkbench {...props()} />)
    expect(await screen.findByText('正文共约 3 页')).toBeTruthy()
    rerender(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench, summary: { ...workbench.summary, content_count: 0, page_estimate: { status: 'empty' as const } },
      outline: workbench.outline.map(section => section.section_id === 'ROOT' ? { ...section, page_estimate: { status: 'unavailable' as const } } : section),
    }) })} />)
    expect(await screen.findByText('正文尚未生成')).toBeTruthy()
    expect(screen.getByText('暂不可用')).toBeTruthy()
  })
  it('章节支持拖入，正文右键将相邻完整段落添加为引用', async () => {
    const store = createBidRevisionStore().create()
    const markdown = '# 1.1 实施方案\n\n保留首段。\n\n修改第一段。\n\n修改第二段。\n\n保留末段。\n'
    render(<BidReviewWorkbench {...props({
      actions: store.actions, getChapter: async () => ({ ...chapter, markdown }),
      useProjection: () => ({ allowedActions: ['export_docx'], runtime: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('修改第一段。')
    const second = screen.getByText('修改第二段。')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    const title = screen.getByRole('button', { name: /1.1 实施方案/ })
    expect(title).toHaveProperty('draggable', true)
    fireEvent.dragStart(title, { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/vnd.dsh.bid-chapter+json', JSON.stringify({ sessionId: 'bid', sectionId: 'SEC-1' }))
    const range = document.createRange()
    range.setStart(first.firstChild!, 1)
    range.setEnd(second.firstChild!, 3)
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到对话框' }))
    expect(store.getSnapshot().reference?.reference).toMatchObject({
      scope: 'paragraphs', start: markdown.indexOf('修改第一段。'), end: markdown.indexOf('\n\n保留末段。'),
      text: '修改第一段。\n\n修改第二段。',
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('章节页眉只显示一次根标题，保留正文的目录编号', async () => {
    render(<BidReviewWorkbench {...props({ getChapter: async () => ({
      ...chapter, markdown: '# 1.1 实施方案\n\n## 1.1.1 工作安排\n\n章节正文',
    }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    const reader = screen.getByRole('main', { name: '正文阅读' })
    expect(reader.querySelectorAll('h1')).toHaveLength(1)
    expect(reader.querySelector('h2')?.textContent).toBe('1.1.1 工作安排')
  })

  it.each(['pending', 'failed', 'completed'] as const)('S5 %s 仍保留已有正文', async (status) => {
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], runtime: { stage: 'chapter_writing', status } }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
  })
  it('成功刷新后清除之前的请求错误', async () => {
    const getWorkbench = vi.fn(async () => workbench).mockRejectedValueOnce(new Error('BID_REVIEW_NOT_ALLOWED'))
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    expect(await screen.findByText('BID_REVIEW_NOT_ALLOWED')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.queryByText('BID_REVIEW_NOT_ALLOWED')).toBeNull()
  })

  it('较早请求的迟到错误不会覆盖成功刷新的页面', async () => {
    let rejectOld!: (reason: Error) => void
    const pending = new Promise<typeof workbench>((_resolve, reject) => { rejectOld = reject })
    const getWorkbench = vi.fn(async () => workbench).mockReturnValueOnce(pending)
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('章节正文')).toBeTruthy()
    await act(async () => { rejectOld(new Error('旧请求失败')) })
    expect(screen.queryByText('旧请求失败')).toBeNull()
    expect(screen.getByText('章节正文')).toBeTruthy()
  })

  it('shows chapter content as soon as the writer publishes it', async () => {
    render(<BidReviewWorkbench {...props()} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.getByText('正文 1/1')).toBeTruthy()
    expect(screen.getByText('参考资料')).toBeTruthy()
    expect(screen.getByText('历史同类实施方案')).toBeTruthy()
    expect(screen.getByText('Evidence：available')).toBeTruthy()
  })

  it('分开显示文档级问题和项目递交待办，不改变章节需关注计数', async () => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench,
      global_compliance: {
        status: 'needs_attention' as const, reviewed_count: 2, total_count: 2,
        document_issues: [{ compliance_id: 'GLOBAL-CONTENT', status: 'fail' as const, detail: '缺少整份文档必须具备的证明材料。', affected_section_ids: ['SEC-1'] }],
        delivery_todos: [{ compliance_id: 'GLOBAL-UPLOAD', status: 'pending' as const, detail: '尚无实际上传执行证据。', affected_section_ids: [] }],
      },
    }) })} />)
    expect(await screen.findByRole('heading', { name: '文档级合规核验' })).toBeTruthy()
    expect(screen.getByText('文档级问题')).toBeTruthy()
    expect(screen.getByText('缺少整份文档必须具备的证明材料。')).toBeTruthy()
    expect(screen.getByText('项目／交付待办')).toBeTruthy()
    expect(screen.getByText('尚无实际上传执行证据。')).toBeTruthy()
    expect(screen.getByText('需关注 0')).toBeTruthy()
  })

  it('选择需修复章节时默认展示已保存审核问题的详情、严重程度和建议', async () => {
    const issue = {
      issue_id: 'SEC-1-review-1', section_id: 'SEC-1', source: 'review' as const, category: 'blocking_issues', severity: 'blocking' as const,
      status: 'open' as const, title: '审核结论', detail: '缺少与交付节点对应的实施措施。', suggestion: '补充交付节点和责任分工。',
    }
    render(<BidReviewWorkbench {...props({ getChapter: async () => ({ ...chapter, review: { status: 'needs_attention', issues: [issue] } }) })} />)
    expect(await screen.findByText('章节审核')).toBeTruthy()
    expect(screen.getAllByText('正文需要修复')).toHaveLength(2)
    expect(screen.getByText('问题数量')).toBeTruthy()
    expect(screen.getByText('问题详情：缺少与交付节点对应的实施措施。')).toBeTruthy()
    expect(screen.getByText('严重程度：阻断')).toBeTruthy()
    expect(screen.getByText('修改建议：补充交付节点和责任分工。')).toBeTruthy()
    expect(screen.getByText('参考资料')).toBeTruthy()
  })

  it('通过章节显示审核通过而非等待状态', async () => {
    render(<BidReviewWorkbench {...props({ getChapter: async () => ({ ...chapter, review: { status: 'pass', issues: [] } }) })} />)
    expect((await screen.findAllByText('审核通过')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('本次已保存的审核报告未列出问题。')).toBeTruthy()
  })

  it('没有正文的失败章节仍可选择并显示执行记录中的失败原因', async () => {
    const failed = {
      ...workbench.outline[1]!, content_available: false,
      writing_status: 'failed' as const, review_status: 'failed' as const,
    }
    render(<BidReviewWorkbench {...props({
      getWorkbench: async () => ({
        ...workbench, outline: [workbench.outline[0]!, failed],
        summary: { ...workbench.summary, content_count: 0, needs_attention_count: 1 },
      }),
      getChapter: async sectionId => sectionId === 'SEC-1' ? ({
        ...chapter, markdown: null, content_sha256: null,
        review: { status: 'failed', issues: [{
          issue_id: 'SEC-1-writing_execution-1', section_id: 'SEC-1', source: 'writing_execution',
          category: 'CHAPTER_SUBAGENT_STOP_REASON_INVALID',
          severity: 'blocking', status: 'open', title: '章节编写执行失败', detail: 'Chapter Subagent 未正常完成：error。',
        }] },
      }) : chapter,
    })} />)
    const button = await screen.findByRole('button', { name: '1.1 实施方案' })
    expect(button).toHaveProperty('disabled', false)
    expect(screen.getByText('正文生成后即可在此查看。')).toBeTruthy()
    expect(screen.getByText('章节编写执行失败')).toBeTruthy()
    expect(screen.getByText('问题详情：Chapter Subagent 未正常完成：error。')).toBeTruthy()
  })

  it('异常审核状态没有详情时说明缺失并提供只读重新加载入口', async () => {
    const getWorkbench = vi.fn(async () => ({ ...workbench, outline: [{ ...workbench.outline[0]!, content_available: true }, { ...workbench.outline[1]!, review_status: 'needs_attention' as const }], summary: { ...workbench.summary, needs_attention_count: 1 } }))
    render(<BidReviewWorkbench {...props({ getWorkbench, getChapter: async () => ({ ...chapter, review: { status: 'needs_attention', issues: [] } }) })} />)
    expect(await screen.findByText('未取得具体原因。请重新加载章节状态；该操作只读取当前已保存的结果。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => { expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })

  it('切换章节并自动刷新后仅显示当前章节重新审核的结果', async () => {
    vi.useFakeTimers()
    let repaired = false
    const second = { ...workbench.outline[1]!, section_id: 'SEC-2', order: 2, title: '质量保障', review_status: 'needs_attention' as const }
    const getWorkbench = vi.fn(async () => ({
      ...workbench,
      outline: [workbench.outline[0]!, workbench.outline[1]!, { ...second, review_status: repaired ? 'pass' as const : 'needs_attention' as const }],
      summary: { ...workbench.summary, chapter_count: 2, content_count: 2, reviewed_count: 2, needs_attention_count: repaired ? 0 : 1 },
    }))
    const getChapter = vi.fn(async (sectionId: string) => sectionId === 'SEC-2' ? ({
      ...chapter, section_id: 'SEC-2', title: '质量保障', number: '1.2', heading_path: ['技术方案', '质量保障'],
      review: repaired ? { status: 'pass' as const, issues: [] } : { status: 'needs_attention' as const, issues: [{
        issue_id: 'SEC-2-review-1', section_id: 'SEC-2', source: 'review' as const, category: 'blocking_issues', severity: 'blocking' as const,
        status: 'open' as const, title: '审核结论', detail: '旧问题。',
      }] },
    }) : chapter)
    try {
      render(<BidReviewWorkbench {...props({ getWorkbench, getChapter })} />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      const secondButton = screen.getByRole('button', { name: '1.2 质量保障' })
      fireEvent.click(secondButton)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByText('问题详情：旧问题。')).toBeTruthy()
      repaired = true
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.getAllByText('审核通过').length).toBeGreaterThanOrEqual(2)
      expect(screen.queryByText('问题详情：旧问题。')).toBeNull()
      expect(screen.getByRole('heading', { name: '质量保障' })).toBeTruthy()
    } finally { vi.useRealTimers() }
  })

  it('默认优先叶节正文，父节点和嵌套父节点可阅读概述且刷新保留选择', async () => {
    const root = workbench.outline[0]!
    const branch = { ...root, section_id: 'BRANCH', parent_id: 'ROOT', title: '工作安排', summary: '介绍进场准备与现场实施的工作安排。' }
    const parentChapters = [root, branch].map((section, index) => ({
      ...chapter, section_id: section.section_id, title: section.title, number: index === 0 ? '1' : '1.1',
      heading_path: index === 0 ? ['技术方案'] : ['技术方案', '工作安排'], writable: false,
      markdown: section.summary!, content_sha256: null, requirement_ids: [], scoring_response_point_ids: [],
      evidence_status: 'not_applicable' as const, materials: [], review: { status: 'not_started' as const, issues: [] },
    }))
    const getChapter = vi.fn(async (sectionId: string) => parentChapters.find(item => item.section_id === sectionId) ?? chapter)
    const store = createBidRevisionStore().create()
    render(<BidReviewWorkbench {...props({
      actions: store.actions, getChapter,
      getWorkbench: async () => ({ ...workbench, outline: [root, branch, { ...workbench.outline[1]!, parent_id: 'BRANCH' }] }),
      useProjection: () => ({ allowedActions: ['export_docx'], runtime: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(getChapter).toHaveBeenNthCalledWith(1, 'SEC-1')
    for (const [index, section] of [root, branch].entries()) {
      const button = screen.getByRole('button', { name: `${index === 0 ? '1' : '1.1'} ${section.title}` })
      expect(button).toHaveProperty('disabled', false)
      expect(button).toHaveProperty('draggable', false)
      fireEvent.click(button)
      const paragraph = await screen.findByText(section.summary!)
      expect(screen.getByTitle(`${index === 0 ? '1' : '1.1'} ${section.title}`)).toBeTruthy()
      expect(screen.getByText('本章概述下属章节的主要内容。请选择子章节查看具体方案、参考资料与依据。')).toBeTruthy()
      expect(screen.queryByText('本章节暂无特定引用资料，按通用技术规范与招标文件要求编写。')).toBeNull()
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      fireEvent.contextMenu(paragraph)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(store.getSnapshot().reference).toBeNull()
      window.getSelection()!.removeAllRanges()
      getChapter.mockClear()
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      await waitFor(() => { expect(getChapter).toHaveBeenCalledWith(section.section_id) })
      expect(screen.getByText(section.summary!)).toBeTruthy()
    }
  })

  it('叶节正文未生成时默认阅读父节点概述，缺正文的叶节仍禁用', async () => {
    const root = workbench.outline[0]!
    const getChapter = vi.fn(async () => ({
      ...chapter, section_id: root.section_id, title: root.title, writable: false, markdown: root.summary!,
    }))
    render(<BidReviewWorkbench {...props({
      getChapter,
      getWorkbench: async () => ({ ...workbench, outline: [root, { ...workbench.outline[1]!, content_available: false }] }),
    })} />)
    expect(await screen.findByText(root.summary!)).toBeTruthy()
    expect(getChapter).toHaveBeenCalledWith('ROOT')
    expect(screen.getByRole('button', { name: '1.1 实施方案' })).toHaveProperty('disabled', true)
  })

  it('缺少概述的父节点保持禁用并提示概述待补充', async () => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench, outline: workbench.outline.map(section => section.writable
        ? section : (() => {
          const { summary: _summary, ...withoutSummary } = section
          return { ...withoutSummary, content_available: false, page_estimate: { status: 'empty' as const } }
        })()),
    }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    expect(screen.getByRole('button', { name: '1 技术方案' })).toHaveProperty('disabled', true)
    expect(screen.getByText('—').getAttribute('title')).toContain('正文尚未生成')
  })

  it('polls the live S5 state and supports an explicit refresh', async () => {
    vi.useFakeTimers()
    const getWorkbench = vi.fn(async () => workbench)
    render(<BidReviewWorkbench {...props({ getWorkbench })} />)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(3) })
  })

  it('offers retry when S5 fails', async () => {
    const retryStage = vi.fn(async () => {})
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], runtime: { stage: 'chapter_writing', status: 'failed', failureReason: 'writer failed' } }), retryStage })} />)
    expect(screen.getByText('章节写作失败：writer failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(retryStage).toHaveBeenCalledOnce() })
  })

  it('S5 完成后入口仅打开导出页，正文仍可查看', async () => {
    const openWordExport = vi.fn()
      .mockResolvedValue(undefined)
    render(<BidReviewWorkbench {...props({
      useProjection: () => ({ allowedActions: ['export_docx'], runtime: { stage: 'chapter_writing', status: 'completed' } }),
      openWordExport,
    })} />)

    expect(await screen.findByText('章节正文')).toBeTruthy()
    const button = screen.getByRole('button', { name: '导出 Word' })
    fireEvent.click(button)
    await waitFor(() => { expect(openWordExport).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText(/Word 已导出/)).toBeNull()
    await waitFor(() => { expect(button).toHaveProperty('disabled', false) })
    fireEvent.click(button)
    await waitFor(() => { expect(openWordExport).toHaveBeenCalledTimes(2) })
    expect(screen.getByText('章节正文')).toBeTruthy()
  })

  it('keeps legacy completed S6 projects in the S5 review workbench', async () => {
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], runtime: { stage: 'docx_export', status: 'completed' } }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
  })

  it('does not render for a non-Bid Session', () => {
    const { container } = render(<BidReviewWorkbench {...props({ useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'standard' } } } as never) })} />)
    expect(container.innerHTML).toBe('')
  })
})
