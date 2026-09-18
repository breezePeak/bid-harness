// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BidDeleteRevisionIssueRequest, BidRevisionIssueView, BidRevisionQueueView, BidReviewChapterView, BidUpdateRevisionIssueRequest } from '@deepseek-ai/dsh-bid/control-plane'
import type { ComposerSubmitHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { BidComposerContext, type BidComposerContextProps } from '../src/client/BidComposerContext.tsx'
import { CHAPTER_DRAG_TYPE, createBidRevisionStore, selectedParagraphReference } from '../src/client/revision-reference.ts'

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges() })

const chapter: BidReviewChapterView = {
  section_id: 'SEC-1', title: '实施方案', number: '1', heading_path: ['实施方案'], writable: true,
  markdown: '# 1 实施方案\n\n首段。\n\n重复**段落**。\n\n重复**段落**。\n\n尾段。\n',
  content_sha256: 'a'.repeat(64), requirement_ids: [], scoring_response_point_ids: [],
  evidence_status: 'available', review: { status: 'pass', issues: [] },
}

function composer() {
  const store = createBidRevisionStore().create()
  const sendMessage = vi.fn(async () => {})
  const getChapter = vi.fn(async () => chapter)
  let submit: ComposerSubmitHandler | undefined
  const registerSubmit = vi.fn((handler: ComposerSubmitHandler) => {
    submit = handler
    return () => { submit = undefined }
  })
  const props = {
    sessionId: 'bid', disabled: false,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) => (
      select(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot()))
    ),
    actions: store.actions, getChapter, sendMessage, registerSubmit,
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /><textarea aria-label="编写意见" /></div>)
  const drop = (sessionId = 'bid') => fireEvent.drop(view.container.firstChild!, {
    dataTransfer: { types: [CHAPTER_DRAG_TYPE], getData: () => JSON.stringify({ sessionId, sectionId: 'SEC-1' }) },
  })
  return { ...view, store, drop, getChapter, sendMessage, submit: (...args: Parameters<ComposerSubmitHandler>) => submit!(...args) }
}

it('章节拖入生成独立标签，引用随普通消息交给主 Agent 判断，成功后释放引用', async () => {
  const view = composer()
  view.drop()
  expect(await screen.findByText('章节 · 1 实施方案')).toBeTruthy()
  expect(screen.getByRole('textbox', { name: '编写意见' })).toHaveProperty('value', '')
  await act(async () => { expect(await view.submit('请最小修改', [], undefined)).toEqual({ kind: 'success' }) })
  expect(view.sendMessage).toHaveBeenCalledTimes(1)
  expect(view.sendMessage).toHaveBeenCalledWith(
    expect.stringContaining('请最小修改'),
    'queue',
    undefined,
    undefined,
  )
  expect(view.sendMessage).toHaveBeenCalledWith(
    expect.stringContaining('"kind":"bid_chapter_reference"'),
    'queue',
    undefined,
    undefined,
  )
  expect(view.store.getSnapshot()).toMatchObject({ reference: null, revision: 1 })
  view.unmount()
})

it('失败保留标签，缺少引用时交还普通写作要求消息，并拒绝其他任务的拖入', async () => {
  const view = composer()
  expect(await view.submit('调整整体写作要求', [], undefined)).toBeUndefined()
  view.drop('another-session')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '只能引用当前任务中的章节。')
  expect(view.getChapter).not.toHaveBeenCalled()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  view.sendMessage.mockRejectedValueOnce(new Error('发送失败'))
  await act(async () => { await expect(view.submit('这是什么意思', [], undefined)).rejects.toThrow('发送失败') })
  expect(view.store.getSnapshot().reference).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '移除章节引用' }))
  await waitFor(() => { expect(view.store.getSnapshot().reference).toBeNull() })
})

it('正文选择映射到完整相邻段落的 Markdown 位置，重复段落不混淆', () => {
  const markdown = chapter.markdown!
  const offset = markdown.indexOf('首段。')
  const view = render(<MarkdownText text={markdown.slice(offset)} paragraphSourceOffset={offset} />)
  const paragraphs = view.container.querySelectorAll('p')
  const range = document.createRange()
  range.setStart(paragraphs[1]!.firstChild!, 1)
  range.setEnd(paragraphs[2]!.lastChild!, 1)
  const selection = window.getSelection()!
  selection.addRange(range)
  const selected = selectedParagraphReference(view.container, selection, chapter)
  const start = markdown.indexOf('重复')
  const end = markdown.indexOf('\n\n尾段')
  expect(selected?.reference).toEqual({ scope: 'paragraphs', section_id: 'SEC-1',
    content_sha256: chapter.content_sha256, start, end, text: markdown.slice(start, end) })
  selection.removeAllRanges()
  range.setStart(paragraphs[2]!.firstChild!, 0)
  range.setEnd(paragraphs[2]!.lastChild!, 1)
  selection.addRange(range)
  expect(selectedParagraphReference(view.container, selection, chapter)?.reference)
    .toMatchObject({ start: markdown.lastIndexOf('重复'), end })
})

it('跨标题选择不生成段落引用', () => {
  const markdown = '首段。\n\n## 标题\n\n尾段。\n'
  const view = render(<MarkdownText text={markdown} paragraphSourceOffset={0} />)
  const paragraphs = view.container.querySelectorAll('p')
  const range = document.createRange()
  range.setStart(paragraphs[0]!.firstChild!, 0)
  range.setEnd(paragraphs[1]!.firstChild!, 1)
  window.getSelection()!.addRange(range)
  expect(selectedParagraphReference(view.container, window.getSelection(), { ...chapter, markdown })).toBeNull()
})
function queueView(issues: readonly BidRevisionIssueView[]): BidRevisionQueueView {
  return { schema_version: 1, revision: 1, issues }
}

function makeIssue(overrides: Partial<BidRevisionIssueView> & { issue_id: string }): BidRevisionIssueView {
  return {
    section_id: 'SEC-1', section_title: '1.1 实施方案', scope: 'paragraphs',
    reference: { scope: 'paragraphs', base_content_sha256: 'a'.repeat(64), start: 0, end: 10, text: '首段内容。' },
    instruction: '改成步骤化', suggestion: null, status: 'pending', batch_id: null,
    created_at: 0, updated_at: 0, ...overrides,
  }
}

function composerWithQueue(queue: BidRevisionQueueView) {
  const store = createBidRevisionStore().create()
  const sendMessage = vi.fn(async () => {})
  const getChapter = vi.fn(async () => chapter)
  const getRevisionQueue = vi.fn(async () => queue)
  const updateRevisionIssue = vi.fn(async (_request: BidUpdateRevisionIssueRequest) => queue)
  const deleteRevisionIssue = vi.fn(async (_request: BidDeleteRevisionIssueRequest) => queue)
  const registerSubmit = vi.fn((_handler: ComposerSubmitHandler) => () => {})
  const props = {
    sessionId: 'bid', disabled: false,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())),
    actions: store.actions, getChapter, sendMessage, registerSubmit,
    getRevisionQueue, updateRevisionIssue, deleteRevisionIssue,
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /><textarea aria-label="编写意见" /></div>)
  return { ...view, store, sendMessage, getRevisionQueue, updateRevisionIssue, deleteRevisionIssue }
}

it('待处理队列逐条显示 pending issue，不合并', async () => {
  const queue = queueView([
    makeIssue({ issue_id: 'REV-001', instruction: '问题一' }),
    makeIssue({ issue_id: 'REV-002', instruction: '问题二' }),
    makeIssue({ issue_id: 'REV-003', section_title: '3.2 质量控制', instruction: '问题三' }),
  ])
  const view = composerWithQueue(queue)
  expect(await screen.findByText('待处理审批意见 3')).toBeTruthy()
  expect(screen.getByText('REV-001')).toBeTruthy()
  expect(screen.getByText('REV-002')).toBeTruthy()
  expect(screen.getByText('REV-003')).toBeTruthy()
  expect(screen.getByText('问题一')).toBeTruthy()
  expect(screen.getByText('问题二')).toBeTruthy()
  expect(screen.getByText('问题三')).toBeTruthy()
  view.unmount()
})

it('chapter scope 显示"整个章节"，paragraph scope 显示引用摘要', async () => {
  const queue = queueView([
    makeIssue({ issue_id: 'REV-001', scope: 'chapter', reference: { scope: 'chapter', base_content_sha256: 'a'.repeat(64) } }),
    makeIssue({ issue_id: 'REV-002', scope: 'paragraphs', reference: { scope: 'paragraphs', base_content_sha256: 'a'.repeat(64), start: 0, end: 5, text: '首段。' } }),
  ])
  const view = composerWithQueue(queue)
  expect(await screen.findByText('REV-001')).toBeTruthy()
  expect(screen.getByText('范围：整个章节')).toBeTruthy()
  expect(screen.getByText(/引用：首段。/)).toBeTruthy()
  view.unmount()
})

it('pending issue 可编辑和删除，scheduled/running 只读', async () => {
  const queue = queueView([
    makeIssue({ issue_id: 'REV-001', status: 'pending' }),
    makeIssue({ issue_id: 'REV-002', status: 'scheduled' }),
    makeIssue({ issue_id: 'REV-003', status: 'running' }),
  ])
  const view = composerWithQueue(queue)
  await screen.findByText('REV-001')
  expect(screen.getAllByRole('button', { name: '编辑' }).length).toBe(1)
  expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(1)
  expect(screen.getByText('已排队')).toBeTruthy()
  expect(screen.getByText('处理中')).toBeTruthy()
  view.unmount()
})

it('编辑 pending issue 调用 updateRevisionIssue 且不发聊天消息', async () => {
  const queue = queueView([makeIssue({ issue_id: 'REV-001', instruction: '原意见', suggestion: null })])
  const view = composerWithQueue(queue)
  await screen.findByText('REV-001')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  await screen.findByRole('dialog', { name: '编辑审批意见' })
  const instructionTextarea = document.getElementById('edit-instruction') as HTMLTextAreaElement
  const suggestionTextarea = document.getElementById('edit-suggestion') as HTMLTextAreaElement
  fireEvent.change(instructionTextarea, { target: { value: '修改后的意见' } })
  fireEvent.change(suggestionTextarea, { target: { value: '新增建议' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
  await waitFor(() => { expect(view.updateRevisionIssue).toHaveBeenCalledTimes(1) })
  expect(view.sendMessage).not.toHaveBeenCalled()
  const call = view.updateRevisionIssue.mock.calls[0]![0]
  expect(call.issue_id).toBe('REV-001')
  expect(call.instruction).toBe('修改后的意见')
  expect(call.suggestion).toBe('新增建议')
  view.unmount()
})

it('删除 pending issue 调用 deleteRevisionIssue 且不发聊天消息', async () => {
  const queue = queueView([makeIssue({ issue_id: 'REV-001' })])
  const view = composerWithQueue(queue)
  await screen.findByText('REV-001')
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  await screen.findByRole('dialog', { name: '确认删除' })
  const allDeleteBtns = screen.getAllByRole('button', { name: '删除' })
  await act(async () => { fireEvent.click(allDeleteBtns[allDeleteBtns.length - 1]!) })
  await waitFor(() => { expect(view.deleteRevisionIssue).toHaveBeenCalledTimes(1) })
  expect(view.sendMessage).not.toHaveBeenCalled()
  expect(view.deleteRevisionIssue.mock.calls[0]![0].issue_id).toBe('REV-001')
  view.unmount()
})

it('completed issue 不显示在待处理区域', async () => {
  const queue = queueView([
    makeIssue({ issue_id: 'REV-001', status: 'pending' }),
    makeIssue({ issue_id: 'REV-002', status: 'completed' }),
  ])
  const view = composerWithQueue(queue)
  expect(await screen.findByText('待处理审批意见 1')).toBeTruthy()
  expect(screen.getByText('REV-001')).toBeTruthy()
  expect(screen.queryByText('REV-002')).toBeNull()
  view.unmount()
})

it('queue revision 冲突时重新拉取队列', async () => {
  const queue = queueView([makeIssue({ issue_id: 'REV-001' })])
  const store = createBidRevisionStore().create()
  const getRevisionQueue = vi.fn(async () => queue)
  const updateRevisionIssue = vi.fn(async () => {
    throw Object.assign(new Error('conflict'), { code: 'BID_REVISION_QUEUE_CONFLICT' })
  })
  const props = {
    sessionId: 'bid', disabled: false,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())),
    actions: store.actions, getChapter: vi.fn(async () => chapter), sendMessage: vi.fn(async () => {}),
    registerSubmit: vi.fn(() => () => {}), getRevisionQueue, updateRevisionIssue, deleteRevisionIssue: vi.fn(async () => queue),
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /></div>)
  await screen.findByText('REV-001')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  await screen.findByRole('dialog', { name: '编辑审批意见' })
  const textareas = screen.getAllByRole('textbox')
  fireEvent.change(textareas[0]!, { target: { value: '新意见' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
  expect(await screen.findByRole('alert')).toBeTruthy()
  await waitFor(() => { expect(getRevisionQueue.mock.calls.length).toBeGreaterThanOrEqual(2) })
  view.unmount()
})

it('getRevisionQueue 未注入时不显示队列区域', async () => {
  const store = createBidRevisionStore().create()
  const props = {
    sessionId: 'bid', disabled: false,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())),
    actions: store.actions, getChapter: vi.fn(async () => chapter), sendMessage: vi.fn(async () => {}),
    registerSubmit: vi.fn(() => () => {}),
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /></div>)
  await waitFor(() => { expect(view.container.innerHTML).toBeTruthy() })
  expect(screen.queryByText(/待处理审批意见/)).toBeNull()
  view.unmount()
})

it('store 发送 notifyRevisionQueueChanged 信号后，ComposerContext 立即刷新并展示新 Issue 卡片', async () => {
  let currentQueue = queueView([])
  const store = createBidRevisionStore().create()
  const getRevisionQueue = vi.fn(async () => currentQueue)
  const props = {
    sessionId: 'bid', disabled: false,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
    useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'completed' } }),
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())),
    actions: store.actions, getChapter: vi.fn(async () => chapter), sendMessage: vi.fn(async () => {}),
    registerSubmit: vi.fn(() => () => {}), getRevisionQueue,
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /></div>)
  await waitFor(() => { expect(getRevisionQueue).toHaveBeenCalledTimes(1) })
  expect(screen.queryByText('REV-NEW')).toBeNull()

  // 模拟 Host 产生了新 Issue，Workbench 保存成功后发出信号
  currentQueue = queueView([makeIssue({ issue_id: 'REV-NEW', instruction: '新意见卡片' })])
  await act(async () => {
    store.actions.notifyRevisionQueueChanged()
  })

  await waitFor(() => { expect(getRevisionQueue).toHaveBeenCalledTimes(2) })
  expect(await screen.findByText('REV-NEW')).toBeTruthy()
  expect(screen.getByText('新意见卡片')).toBeTruthy()
  view.unmount()
})
