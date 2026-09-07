// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BidReviewChapterView } from '@deepseek-ai/dsh-bid/control-plane'
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
  const reviseChapter = vi.fn(async () => {})
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
      select(useSyncExternalStore(store.subscribe, store.getSnapshot))
    ),
    actions: store.actions, getChapter, reviseChapter, registerSubmit,
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /><textarea aria-label="编写意见" /></div>)
  const drop = (sessionId = 'bid') => fireEvent.drop(view.container.firstChild!, {
    dataTransfer: { types: [CHAPTER_DRAG_TYPE], getData: () => JSON.stringify({ sessionId, sectionId: 'SEC-1' }) },
  })
  return { ...view, store, drop, getChapter, reviseChapter, submit: (...args: Parameters<ComposerSubmitHandler>) => submit!(...args) }
}

it('章节拖入生成独立标签，意见只提交给修订动作，成功刷新并释放引用', async () => {
  const view = composer()
  view.drop()
  expect(await screen.findByText('章节 · 1 实施方案')).toBeTruthy()
  expect(screen.getByRole('textbox', { name: '编写意见' })).toHaveProperty('value', '')
  await act(async () => { expect(await view.submit('请最小修改', [], undefined)).toEqual({ kind: 'success' }) })
  expect(view.reviseChapter).toHaveBeenCalledWith({ instruction: '请最小修改', reference: {
    scope: 'chapter', section_id: 'SEC-1', content_sha256: chapter.content_sha256,
  } })
  expect(view.store.getSnapshot()).toMatchObject({ reference: null, revision: 1 })
  view.unmount()
})

it('失败保留标签，缺少引用时不委托主 Agent，并拒绝其他任务的拖入', async () => {
  const view = composer()
  expect(await view.submit('重写', [], undefined)).toMatchObject({ kind: 'error' })
  view.drop('another-session')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '只能引用当前任务中的章节。')
  expect(view.getChapter).not.toHaveBeenCalled()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  view.reviseChapter.mockRejectedValueOnce(new Error('正文已变化'))
  await act(async () => { await expect(view.submit('重写', [], undefined)).rejects.toThrow('正文已变化') })
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
