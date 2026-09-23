// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BidAddRevisionIssueRequest,
  BidRevisionComparisonView,
  DocxTemplateId,
} from '@deepseek-ai/dsh-bid/control-plane'
import { BidReviewWorkbench, type BidReviewWorkbenchProps } from '../src/client/BidReviewWorkbench.tsx'
import { createBidRevisionStore } from '../src/client/revision-reference.ts'

afterEach(cleanup)

const pageBasis = { source: 'template' as const, method: 'fast' as const,
  template: { id: 'a'.repeat(64) as DocxTemplateId, name: '项目技术标模板.docx', revision: 2 } }

const workbench = {
  schema_version: 6 as const,
  outline: [
    { section_id: 'ROOT', parent_id: null, order: 1, title: '技术方案', summary: '说明项目实施流程、人员分工与质量控制措施。', writable: false, writing_status: 'not_started' as const, review_status: 'not_started' as const, chapter_indicator: { status: 'not_started' as const, tooltip: '章节概述' }, content_available: true, page_estimate: { status: 'available' as const, pages: 2, incomplete: true, ...pageBasis } },
    { section_id: 'SEC-1', parent_id: 'ROOT', order: 1, title: '实施方案', writable: true, writing_status: 'content_ready' as const, review_status: 'reviewing' as const, chapter_indicator: { status: 'reviewing' as const, tooltip: '正在审核' }, content_available: true },
  ],
  summary: { chapter_count: 1, content_count: 1, reviewed_count: 0, needs_attention_count: 0, page_estimate: { status: 'available' as const, pages: 3, ...pageBasis }, page_target: { status: 'not_required' as const } },
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
    useProjection: () => ({ allowedActions: [], task: { stage: 'chapter_writing', status: 'running' } }),
    renderSlot: (name: string) => <div data-slot={name} />,
    getWorkbench: async () => workbench,
    getChapter: async () => chapter,
    ...patch,
  } as BidReviewWorkbenchProps
}

describe('BidReviewWorkbench', () => {
  it('renders historical comparison as shared rows with after on the left', async () => {
    let compare: ((target: { issueId: string; sectionId: string }) => void) | undefined
    render(<BidReviewWorkbench {...props({
      getRevisionComparison: async () => ({
        issue_id: 'ISSUE-1', batch_id: 'BATCH-1', task_id: 'TASK-1', section_id: 'SEC-1', section_title: '实施方案',
        before_markdown: '# 实施方案\n\nAAA\n\nCCC\n', after_markdown: '# 实施方案\n\nAAA\n\nBBB\n\nCCC\n',
        before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64),
      }),
      onCompareRevision: listener => { compare = listener; return () => {} },
    })} />)
    await screen.findByText('章节正文')
    act(() => { compare?.({ issueId: 'ISSUE-1', sectionId: 'SEC-1' }) })
    await screen.findByRole('heading', { name: '本次修改对比' })
    const headers = screen.getAllByText(/修改[前后]/u).map(element => element.textContent)
    expect(headers).toEqual(['修改后', '修改前'])
    const inserted = screen.getByText('BBB').closest('[data-kind="insert"]')
    expect(inserted?.children[0]?.textContent).toContain('BBB')
    expect(inserted?.children[1]?.textContent).toBe('')
  })

  it('keeps the latest comparison when an earlier request resolves last', async () => {
    let compare: ((target: { issueId: string; sectionId: string }) => void) | undefined
    const first = Promise.withResolvers<BidRevisionComparisonView>()
    const second = Promise.withResolvers<BidRevisionComparisonView>()
    const comparison = (issueId: string, text: string) => ({
      issue_id: issueId, batch_id: `BATCH-${issueId}`, task_id: `TASK-${issueId}`, section_id: 'SEC-1', section_title: '实施方案',
      before_markdown: '# 实施方案\n\n旧正文\n', after_markdown: `# 实施方案\n\n${text}\n`,
      before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64),
    })
    render(<BidReviewWorkbench {...props({
      getRevisionComparison: issueId => issueId === 'A' ? first.promise : second.promise,
      onCompareRevision: listener => { compare = listener; return () => {} },
    })} />)
    await screen.findByText('章节正文')
    act(() => {
      compare?.({ issueId: 'A', sectionId: 'SEC-1' })
      compare?.({ issueId: 'B', sectionId: 'SEC-1' })
    })
    await act(async () => { second.resolve(comparison('B', 'B 修改后')); await second.promise })
    expect(await screen.findByText('B 修改后')).toBeTruthy()
    await act(async () => { first.resolve(comparison('A', 'A 修改后')); await first.promise })
    expect(screen.queryByText('A 修改后')).toBeNull()
    expect(screen.getByText('B 修改后')).toBeTruthy()
  })

  it('shows the legacy snapshot message without replacing history with current content', async () => {
    let compare: ((target: { issueId: string; sectionId: string }) => void) | undefined
    render(<BidReviewWorkbench {...props({
      getRevisionComparison: async () => { throw Object.assign(new Error('not available'), { code: 'BID_REVISION_COMPARISON_NOT_AVAILABLE' }) },
      onCompareRevision: listener => { compare = listener; return () => {} },
    })} />)
    await screen.findByText('章节正文')
    act(() => { compare?.({ issueId: 'OLD', sectionId: 'SEC-1' }) })
    expect((await screen.findByRole('alert')).textContent).toContain('该修复记录创建于历史对比快照功能启用前，无法还原完整修改前版本。')
  })
  it('仅为完整目录中的非叶节显示页数，折叠不改变叶节状态点', async () => {
    const branch = { ...workbench.outline[0]!, section_id: 'BRANCH', parent_id: 'ROOT', order: 1, title: '实施安排', page_estimate: { status: 'empty' as const, ...pageBasis } }
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
    expect(screen.getByText('无页数目标')).toBeTruthy()
    rerender(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench, summary: { ...workbench.summary, content_count: 0, page_estimate: { status: 'empty' as const, ...pageBasis } },
      outline: workbench.outline.map(section => section.section_id === 'ROOT' ? { ...section, page_estimate: { status: 'unavailable' as const } } : section),
    }) })} />)
    expect(await screen.findByText('正文尚未生成')).toBeTruthy()
    expect(screen.getByText('暂不可用')).toBeTruthy()
  })

  it('优先使用服务端提供的章节状态指标', async () => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench,
      outline: workbench.outline.map(section => section.writable
        ? { ...section, chapter_indicator: { status: 'queued' as const, tooltip: '等待编写' } }
        : section),
    }) })} />)
    const leaf = await screen.findByRole('button', { name: '1.1 实施方案' })
    expect(leaf.querySelector('[class*="statusDotQueued"]')).toBeTruthy()
    expect(leaf.querySelector('[title]')?.getAttribute('title')).toContain('实施方案：等待编写')
  })

  it.each([
    ['not_started', '未开始', 'statusDotGray'],
    ['queued', '等待执行', 'statusDotQueued'],
    ['writing', '正在编写', 'statusDotBlue'],
    ['repairing', '正在修复', 'statusDotBlue'],
    ['content_ready', '正文已编写，等待审核', 'statusDotBlue'],
    ['reviewing', '正在审核', 'statusDotYellow'],
    ['needs_input', '缺少项目资料，正文无需重写', 'statusDotYellow'],
    ['needs_attention', '正文需要修复：2 个问题', 'statusDotOrange'],
    ['passed', '审核通过', 'statusDotGreen'],
    ['failed', '章节编写执行失败', 'statusDotRed'],
    ['failed', '章节审核执行失败', 'statusDotRed'],
    ['failed', '章节修复执行失败', 'statusDotRed'],
  ] as const)('按 Host 状态 %s 显示 %s', async (status, tooltip, className) => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench,
      outline: [workbench.outline[0]!, {
        ...workbench.outline[1]!,
        chapter_indicator: { status, tooltip },
      }],
    }) })} />)
    const leaf = await screen.findByRole('button', { name: '1.1 实施方案' })
    expect(leaf.querySelector(`[class*="${className}"]`)).toBeTruthy()
    expect(screen.getByTitle(`1.1 实施方案：${tooltip}`)).toBeTruthy()
  })

  it('当前审核阶段覆盖旧的待修复结论', async () => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench,
      outline: [workbench.outline[0]!, {
        ...workbench.outline[1]!, review_status: 'needs_attention' as const,
        chapter_indicator: { status: 'reviewing' as const, tooltip: '正在审核' },
      }],
    }) })} />)
    const leaf = await screen.findByRole('button', { name: '1.1 实施方案' })
    expect(leaf.querySelector('[class*="statusDotYellow"]')).toBeTruthy()
    expect(leaf.querySelector('[class*="statusDotOrange"]')).toBeNull()
    expect(screen.getByTitle('1.1 实施方案：正在审核')).toBeTruthy()
  })

  it('分开显示页数目标、正文估算和未达差额', async () => {
    render(<BidReviewWorkbench {...props({ getWorkbench: async () => ({
      ...workbench,
      summary: { ...workbench.summary, page_target: {
        status: 'below',
        target: { kind: 'minimum', min_pages: 200, max_pages: null, estimate_basis: '按当前 Word 格式估算。' },
        estimated_pages: 150.25, difference: 49.75, format_revision: 2, format_source: 'template',
        format_template_id: pageBasis.template.id, estimate_method: 'fast',
      } },
    }) })} />)
    const status = await screen.findByText('目标 至少 200 页 · 尚差 49.75 页')
    expect(status.closest('[title]')?.getAttribute('title')).toContain('当前正文估算 150.25 页')
  })
  it('章节支持拖入，正文右键将相邻完整段落添加为引用', async () => {
    const store = createBidRevisionStore().create()
    const markdown = '# 1.1 实施方案\n\n保留首段。\n\n修改第一段。\n\n修改第二段。\n\n保留末段。\n'
    render(<BidReviewWorkbench {...props({
      actions: store.actions, getChapter: async () => ({ ...chapter, markdown }),
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
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
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], task: { stage: 'chapter_writing', status } }) })} />)
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
    const complianceBtn = await screen.findByRole('button', { name: /文档级合规检查/ })
    expect(complianceBtn).toBeTruthy()
    expect(complianceBtn.textContent).toContain('1')
    expect(screen.queryByRole('heading', { name: '文档级合规核验' })).toBeNull()

    fireEvent.click(complianceBtn)
    expect(await screen.findByRole('heading', { name: '文档级合规核验' })).toBeTruthy()
    expect(screen.getByText('GLOBAL-CONTENT')).toBeTruthy()
    expect(screen.getByText('高风险')).toBeTruthy()
    expect(screen.getByText('缺少整份文档必须具备的证明材料。')).toBeTruthy()
    expect(screen.getByText('GLOBAL-UPLOAD')).toBeTruthy()
    expect(screen.getByText('待确认')).toBeTruthy()
    expect(screen.getByText('尚无实际上传执行证据。')).toBeTruthy()
    expect(screen.getByText('需关注 0')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('heading', { name: '文档级合规核验' })).toBeNull()
  })

  it('审核问题限制在独立滚动区域，并可逐条展开或折叠为一行', async () => {
    const issue = {
      issue_id: 'SEC-1-review-1', section_id: 'SEC-1', source: 'review' as const, category: 'blocking_issues', severity: 'high' as const,
      status: 'open' as const, title: '审核结论', detail: '缺少与交付节点对应的实施措施。', suggestion: '补充交付节点和责任分工。',
    }
    const secondIssue = { ...issue, issue_id: 'SEC-1-review-2', title: '格式问题', detail: '表格标题不完整。' }
    render(<BidReviewWorkbench {...props({ getChapter: async () => ({ ...chapter, review: { status: 'needs_attention', issues: [issue, secondIssue] } }) })} />)
    expect(await screen.findByText('章节审核')).toBeTruthy()
    expect(screen.getAllByText('正文需要修复')).toHaveLength(2)
    expect(screen.getByText('问题数量')).toBeTruthy()
    const issueList = screen.getByRole('list', { name: '审核问题列表，共 2 个问题' })
    expect(issueList.querySelectorAll('details')).toHaveLength(2)
    const firstIssue = screen.getByText('审核结论').closest('details')
    expect(firstIssue?.open).toBe(false)
    fireEvent.click(screen.getByText('审核结论'))
    expect(firstIssue?.open).toBe(true)
    expect(screen.getByText('问题详情：缺少与交付节点对应的实施措施。')).toBeTruthy()
    expect(firstIssue?.textContent).toContain('严重程度：高风险')
    expect(firstIssue?.textContent).toContain('修改建议：补充交付节点和责任分工。')
    fireEvent.click(screen.getByText('审核结论'))
    expect(firstIssue?.open).toBe(false)
    expect(screen.getByText('参考资料')).toBeTruthy()
  })

  it('通过章节显示审核通过而非等待状态', async () => {
    render(<BidReviewWorkbench {...props({ getChapter: async () => ({ ...chapter, review: { status: 'pass', issues: [] } }) })} />)
    expect((await screen.findAllByText('审核通过')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('本次已保存的审核报告未列出问题。')).toBeTruthy()
  })

  it('缺少资质资料时显示黄色状态并说明正文无需重写', async () => {
    const pendingInput = {
      ...workbench.outline[1]!, review_status: 'needs_input' as const,
      chapter_indicator: { status: 'needs_attention' as const, tooltip: '缺少项目资料，正文无需重写' },
    }
    render(<BidReviewWorkbench {...props({
      getWorkbench: async () => ({
        ...workbench,
        outline: [workbench.outline[0]!, pendingInput],
        summary: { ...workbench.summary, reviewed_count: 1, needs_attention_count: 1 },
      }),
      getChapter: async () => ({ ...chapter, review: { status: 'needs_input' as const, issues: [{
        issue_id: 'SEC-1-external-input-1', section_id: 'SEC-1', source: 'review' as const,
        category: 'external_input_gaps', severity: 'medium' as const, status: 'open' as const,
        title: '待补项目资料：企业资质证书', detail: '当前项目资料未提供。',
      }] } }),
    })} />)

    expect(await screen.findByTitle('1.1 实施方案：缺少项目资料，正文无需重写')).toBeTruthy()
    expect(screen.getAllByText('待补项目资料')).toHaveLength(2)
    expect(screen.getByText('严重程度：中风险')).toBeTruthy()
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
          severity: 'high', status: 'open', title: '章节编写执行失败', detail: 'Chapter Subagent 未正常完成：error。',
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
        issue_id: 'SEC-2-review-1', section_id: 'SEC-2', source: 'review' as const, category: 'blocking_issues', severity: 'high' as const,
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
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
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
          return { ...withoutSummary, content_available: false, page_estimate: { status: 'empty' as const, ...pageBasis } }
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

  it('S5 失败时不渲染顶部报错横幅与重试按钮', () => {
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], task: { stage: 'chapter_writing', status: 'failed', failureReason: 'writer failed' } }) })} />)
    expect(screen.queryByText(/章节写作失败/)).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('S5 完成后入口仅打开导出页，正文仍可查看', async () => {
    const openWordExport = vi.fn()
      .mockResolvedValue(undefined)
    render(<BidReviewWorkbench {...props({
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
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
    render(<BidReviewWorkbench {...props({ useProjection: () => ({ allowedActions: [], task: { stage: 'docx_export', status: 'completed' } }) })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
  })

  it('does not render for a non-Bid Session', () => {
    const { container } = render(<BidReviewWorkbench {...props({ useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'standard' } } } as never) })} />)
    expect(container.innerHTML).toBe('')
  })

  it('单段右键打开审批意见弹框，填写后保存调用 addRevisionIssue 且不发聊天消息', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    const markdown = '# 1.1 实施方案\n\n首段内容。\n\n重复段落。\n\n重复段落。\n\n尾段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('首段内容。')
    const range = document.createRange()
    range.setStart(first.firstChild!, 0)
    range.setEnd(first.lastChild!, first.lastChild!.textContent!.length)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    expect(textareas).toHaveLength(1)
    fireEvent.change(textareas[0]!, { target: { value: '这里结构太散，改成分步骤描述。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    const call = addRevisionIssue.mock.calls[0]![0]
    expect(call.scope).toBe('paragraphs')
    expect(call.section_id).toBe('SEC-1')
    expect(call.instruction).toBe('这里结构太散，改成分步骤描述。')
    expect(call.suggestion).toBeNull()
    if (call.reference.scope === 'paragraphs') {
      expect(call.reference.base_content_sha256).toBe(chapter.content_sha256)
      expect(call.reference.text).toBe('首段内容。')
    }
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('连续三段右键生成连续段落引用，offset 跨段落准确', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    const markdown = '# 1.1 实施方案\n\n首段内容。\n\n重复段落。\n\n重复段落。\n\n尾段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('首段内容。')
    const last = screen.getByText('重复段落。', { selector: 'p:nth-of-type(3)' })
    const range = document.createRange()
    range.setStart(first.firstChild!, 0)
    range.setEnd(last.lastChild!, last.lastChild!.textContent!.length)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '前三段需要重写。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    const call = addRevisionIssue.mock.calls[0]![0]
    if (call.reference.scope === 'paragraphs') {
      const expectedStart = markdown.indexOf('首段内容。')
      const expectedEnd = markdown.indexOf('\n\n尾段内容')
      expect(call.reference.start).toBe(expectedStart)
      expect(call.reference.end).toBe(expectedEnd)
      expect(call.reference.text).toBe(markdown.slice(expectedStart, expectedEnd))
    }
  })

  it('章节级审批意见：右键当前章节标题区域打开审批弹框，scope 为 chapter', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    expect(screen.getByText(/整个章节/)).toBeTruthy()
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '整章重写。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    const call = addRevisionIssue.mock.calls[0]![0]
    expect(call.scope).toBe('chapter')
    expect(call.section_id).toBe('SEC-1')
    if (call.reference.scope === 'chapter') {
      expect(call.reference.base_content_sha256).toBe(chapter.content_sha256)
    }
  })

  it('章节级审批意见：右键左侧章节目录中可写章节，读取最新章节后打开弹框', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const leafButton = await screen.findByRole('button', { name: '1.1 实施方案' })
    const treeRow = leafButton.closest('div[class*="treeRow"]')!
    fireEvent.contextMenu(treeRow, { clientX: 80, clientY: 80 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    expect(screen.getByText(/整个章节/)).toBeTruthy()
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '目录右键意见。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    const call = addRevisionIssue.mock.calls[0]![0]
    expect(call.scope).toBe('chapter')
    expect(call.section_id).toBe('SEC-1')
  })

  it('非可写父节点章节右键不拦截，保留浏览器默认右键', async () => {
    const addRevisionIssue = vi.fn(async () => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const rootButton = await screen.findByRole('button', { name: /技术方案/ })
    const rootRow = rootButton.closest('div[class*="treeRow"]')!
    const event = fireEvent.contextMenu(rootRow, { clientX: 100, clientY: 100 })
    expect(event).toBe(true)
    expect(screen.queryByRole('menu', { name: '章节操作' })).toBeNull()
  })

  it('空修改意见时显示验证错误，不调用 addRevisionIssue', async () => {
    const addRevisionIssue = vi.fn(async () => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    expect((await screen.findByRole('alert')).textContent).toBe('请填写修改意见。')
    expect(addRevisionIssue).not.toHaveBeenCalled()
  })

  it('保存成功后正文不变化且不额外调用 getChapter', async () => {
    const addRevisionIssue = vi.fn(async () => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    const getChapter = vi.fn(async () => chapter)
    render(<BidReviewWorkbench {...props({
      addRevisionIssue, getChapter,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    expect(await screen.findByText('章节正文')).toBeTruthy()
    const callsBefore = getChapter.mock.calls.length
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '意见' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    expect(screen.getByText('章节正文')).toBeTruthy()
    expect(getChapter.mock.calls.length).toBe(callsBefore)
  })

  it('过期正文引用被拒绝时显示"正文已变化，请重新选择内容。"', async () => {
    const addRevisionIssue = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { code: 'BID_CHAPTER_REVISION_CONFLICT' })
    })
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '意见' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    expect((await screen.findByRole('alert')).textContent).toBe('正文已变化，请重新选择内容。')
    expect(screen.getByRole('dialog', { name: '添加审批意见' })).toBeTruthy()
  })

  it('queue revision 冲突时通知队列变更并提示重试', async () => {
    const notifyRevisionQueueChanged = vi.fn()
    const addRevisionIssue = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { code: 'BID_REVISION_QUEUE_CONFLICT' })
    })
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      actions: { setReference: vi.fn(), clearReference: vi.fn(), notifyRevisionQueueChanged, setSelectedSectionId: vi.fn() },
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '意见' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    expect((await screen.findByRole('alert')).textContent).toBe('队列已更新，请重试。')
    expect(notifyRevisionQueueChanged).toHaveBeenCalled()
  })

  it('相同文字在章节出现两次时 offset 仍准确', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    const markdown = '# 1.1 实施方案\n\n首段内容。\n\n重复段落。\n\n重复段落。\n\n尾段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const duplicates = await screen.findAllByText('重复段落。')
    const second = duplicates[1]!
    const range = document.createRange()
    range.setStart(second.firstChild!, 0)
    range.setEnd(second.lastChild!, second.lastChild!.textContent!.length)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(second, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: '第二处重复段落需改。' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' })) })
    await waitFor(() => { expect(addRevisionIssue).toHaveBeenCalledTimes(1) })
    const call = addRevisionIssue.mock.calls[0]![0]
    if (call.reference.scope === 'paragraphs') {
      const expectedStart = markdown.lastIndexOf('重复段落。')
      expect(call.reference.start).toBe(expectedStart)
      expect(call.reference.text).toBe('重复段落。')
    }
  })

  it('取消按钮关闭弹框且不保存', async () => {
    const addRevisionIssue = vi.fn(async (_req: BidAddRevisionIssueRequest) => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const title = await screen.findByRole('heading', { name: '实施方案' })
    fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '添加审批意见' }))
    await screen.findByRole('dialog', { name: '添加审批意见' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(addRevisionIssue).not.toHaveBeenCalled()
  })

  it('addRevisionIssue 未注入时不显示"添加审批意见"菜单项且无临时按钮', async () => {
    render(<BidReviewWorkbench {...props({
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    await screen.findByText('章节正文')
    expect(screen.queryByRole('button', { name: '对本章添加审批意见' })).toBeNull()
    const first = screen.getByText('章节正文')
    const range = document.createRange()
    range.selectNodeContents(first)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
    expect(screen.queryByRole('menuitem', { name: '添加审批意见' })).toBeNull()
    const title = screen.getByRole('heading', { name: '实施方案' })
    const event = fireEvent.contextMenu(title, { clientX: 100, clientY: 100 })
    expect(event).toBe(true)
    expect(screen.queryByRole('menu', { name: '章节操作' })).toBeNull()
  })

  it('右键点击点位于选区外部段落时，不拦截右键且不显示选区菜单', async () => {
    const addRevisionIssue = vi.fn(async () => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    const markdown = '# 1.1 实施方案\n\n首段内容。\n\n中段内容。\n\n末段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('首段内容。')
    const last = screen.getByText('末段内容。')
    const range = document.createRange()
    range.selectNodeContents(first)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const event = fireEvent.contextMenu(last, { clientX: 200, clientY: 200 })
    expect(event).toBe(true)
    expect(screen.queryByRole('menu', { name: '选中段落操作' })).toBeNull()
  })

  it('选区为空或折叠时右键不拦截，保留浏览器原生右键', async () => {
    const addRevisionIssue = vi.fn(async () => ({ schema_version: 1 as const, revision: 1, issues: [] }))
    render(<BidReviewWorkbench {...props({
      addRevisionIssue,
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const text = await screen.findByText('章节正文')
    window.getSelection()!.removeAllRanges()
    const event = fireEvent.contextMenu(text, { clientX: 100, clientY: 100 })
    expect(event).toBe(true)
    expect(screen.queryByRole('menu', { name: '选中段落操作' })).toBeNull()
  })

  it('右键菜单支持"添加到对话框"，设置 reference 并关闭菜单', async () => {
    const setReference = vi.fn()
    const markdown = '# 1.1 实施方案\n\n首段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      actions: { setReference, clearReference: vi.fn(), notifyRevisionQueueChanged: vi.fn(), setSelectedSectionId: vi.fn() },
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('首段内容。')
    const range = document.createRange()
    range.selectNodeContents(first)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
    const addItem = await screen.findByRole('menuitem', { name: '添加到对话框' })
    fireEvent.click(addItem)
    expect(setReference).toHaveBeenCalledTimes(1)
    const ref = setReference.mock.calls[0]![0]
    expect(ref.reference.scope).toBe('paragraphs')
    expect(ref.reference.text).toBe('首段内容。')
    expect(screen.queryByRole('menu', { name: '选中段落操作' })).toBeNull()
  })

  it('右键菜单在视口边缘时自适应定位，不溢出视口', async () => {
    const markdown = '# 1.1 实施方案\n\n首段内容。\n'
    render(<BidReviewWorkbench {...props({
      getChapter: async () => ({ ...chapter, markdown }),
      addRevisionIssue: vi.fn(),
      useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
    })} />)
    const first = await screen.findByText('首段内容。')
    const range = document.createRange()
    range.selectNodeContents(first)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    // 模拟在右下角 (window.innerWidth = 1024, window.innerHeight = 768)
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
    fireEvent.contextMenu(first, { clientX: 1020, clientY: 760 })
    const menu = await screen.findByRole('menu', { name: '选中段落操作' })
    expect(menu.style.left).toBe(`${1024 - 160 - 8}px`)
    expect(menu.style.top).toBe(`${768 - 88 - 8}px`)
  })

  describe('批量审核修改全局唯一性保证', () => {
    it('正文详情工作台内部不挂载私有悬浮面板，由会话全局唯一渲染', async () => {
      render(<BidReviewWorkbench {...props({
        useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
      })} />)

      expect(await screen.findByText('实施方案')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '展开批量审核修改' })).toBeNull()
      expect(screen.queryByRole('heading', { name: '批量审核修改' })).toBeNull()
    })
  })

  describe('批量修订复用原进度条与轮询', () => {
    it('1. 普通 S5 使用唯一进度条显示正文统计', async () => {
      render(<BidReviewWorkbench {...props({
        getWorkbench: async () => workbench,
      })} />)
      expect(await screen.findByText('正文 1/1')).toBeTruthy()
      const progress = screen.getByRole('progressbar', { name: 'S5 正文进度：1/1 章已生成' })
      expect(progress.getAttribute('value')).toBe('1')
      expect(progress.getAttribute('max')).toBe('1')
      expect(screen.getAllByRole('progressbar')).toHaveLength(1)
      expect(screen.queryByText(/修订进度/)).toBeNull()
      expect(screen.queryByText(/批量修订/)).toBeNull()
      expect(document.querySelectorAll('[class*="revisionBatchPill"]')).toHaveLength(0)
    })

    it('2. RevisionBatch 按 Issue 数统计：3 个章节 8 个 Issue 显示 3/8', async () => {
      const batchWorkbench = {
        ...workbench,
        outline: [
          workbench.outline[0]!,
          { ...workbench.outline[1]!, section_id: 'SEC-1', revision: { batch_id: 'B1', task_id: 'T1', status: 'completed' as const, issue_count: 4 } },
          { ...workbench.outline[1]!, section_id: 'SEC-2', revision: { batch_id: 'B1', task_id: 'T2', status: 'running' as const, issue_count: 3 } },
          { ...workbench.outline[1]!, section_id: 'SEC-3', revision: { batch_id: 'B1', task_id: 'T3', status: 'queued' as const, issue_count: 1 } },
        ],
        revision_batch: {
          batch_id: 'B1', status: 'running' as const, total_issues: 8,
          completed: 3, running: 2, pending: 3, needs_input: 0, failed: 0, conflict: 0,
        },
      }
      render(<BidReviewWorkbench {...props({ getWorkbench: async () => batchWorkbench })} />)
      expect(await screen.findByText('修订进度 3/8')).toBeTruthy()
      const progress = screen.getByRole('progressbar', { name: '批量修订进度：3/8 条审批意见已处理' })
      expect(progress.getAttribute('value')).toBe('3')
      expect(progress.getAttribute('max')).toBe('8')
      expect(screen.getAllByRole('progressbar')).toHaveLength(1)
      expect(screen.queryByText('正文 1/1')).toBeNull()
      expect(screen.queryByText('1/3')).toBeNull()
    })

    it('3. 一个章节多 Issue 场景：单章多个已完成 Issue 按 Issue 变化而非 task 数', async () => {
      const batchWorkbench = {
        ...workbench,
        outline: [
          workbench.outline[0]!,
          { ...workbench.outline[1]!, section_id: 'SEC-A', revision: { batch_id: 'B1', task_id: 'T1', status: 'running' as const, issue_count: 6 } },
          { ...workbench.outline[1]!, section_id: 'SEC-B', revision: { batch_id: 'B1', task_id: 'T2', status: 'queued' as const, issue_count: 1 } },
        ],
        revision_batch: {
          batch_id: 'B1', status: 'running' as const, total_issues: 7,
          completed: 4, running: 2, pending: 1, needs_input: 0, failed: 0, conflict: 0,
        },
      }
      render(<BidReviewWorkbench {...props({ getWorkbench: async () => batchWorkbench })} />)
      expect(await screen.findByText('修订进度 4/7')).toBeTruthy()
      expect(screen.queryByText('0/2')).toBeNull()
      expect(screen.queryByText('1/2')).toBeNull()
    })

    it('4. terminal 异常状态计入已处理并达到 100%，异常统计仍单独显示', async () => {
      const batchWorkbench = {
        ...workbench,
        revision_batch: {
          batch_id: 'B1', status: 'completed' as const, total_issues: 8,
          completed: 5, needs_input: 1, failed: 1, conflict: 1, running: 0, pending: 0,
        },
      }
      render(<BidReviewWorkbench {...props({ getWorkbench: async () => batchWorkbench })} />)
      expect(await screen.findByText('修订进度 8/8')).toBeTruthy()
      const batchPill = document.querySelector('[class*="revisionBatchPill"]')
      expect(batchPill).toBeTruthy()
      expect(batchPill?.textContent).toContain('待补资料 1')
      expect(batchPill?.textContent).toContain('正文冲突 1')
      expect(batchPill?.textContent).toContain('失败 1')
    })

    it('5. pending Issue 但 Batch 尚未创建：不切换到修订进度', async () => {
      render(<BidReviewWorkbench {...props({
        getWorkbench: async () => workbench,
      })} />)
      expect(await screen.findByText('正文 1/1')).toBeTruthy()
      expect(screen.queryByText(/修订进度/)).toBeNull()
    })

    it('6. 实时轮询：projection 处于 completed 但 revision_batch 为 running 时持续轮询并实时刷新', async () => {
      vi.useFakeTimers()
      try {
        let count = 0
        const getWorkbench = vi.fn(async () => {
          count++
          const completed = count === 1 ? 1 : count === 2 ? 3 : count === 3 ? 6 : 8
          return {
            ...workbench,
            revision_batch: {
              batch_id: 'B1', status: 'running' as const, total_issues: 8,
              completed, running: 8 - completed, pending: 0, needs_input: 0, failed: 0, conflict: 0,
            },
          }
        })
        render(<BidReviewWorkbench {...props({
          getWorkbench,
          useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
        })} />)
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        expect(screen.getByText('修订进度 1/8')).toBeTruthy()
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(screen.getByText('修订进度 3/8')).toBeTruthy()
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(screen.getByText('修订进度 6/8')).toBeTruthy()
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(screen.getByText('修订进度 8/8')).toBeTruthy()
        expect(getWorkbench.mock.calls.length).toBeGreaterThanOrEqual(4)
      } finally {
        vi.useRealTimers()
      }
    })

    it('7. 完成后停止轮询：revision_batch 处于 completed 且普通 S5 不在 running 时停止轮询', async () => {
      vi.useFakeTimers()
      try {
        const getWorkbench = vi.fn(async () => ({
          ...workbench,
          revision_batch: {
            batch_id: 'B1', status: 'completed' as const, total_issues: 8,
            completed: 8, running: 0, pending: 0, needs_input: 0, failed: 0, conflict: 0,
          },
        }))
        render(<BidReviewWorkbench {...props({
          getWorkbench,
          useProjection: () => ({ allowedActions: ['export_docx'], task: { stage: 'chapter_writing', status: 'completed' } }),
        })} />)
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        const initialCalls = getWorkbench.mock.calls.length
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(getWorkbench.mock.calls.length).toBe(initialCalls)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
