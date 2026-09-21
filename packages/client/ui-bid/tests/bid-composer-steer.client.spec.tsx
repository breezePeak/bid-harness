// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BidReviewChapterView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ComposerSubmitForward, ComposerSubmitHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BidComposerContext, type BidComposerContextProps } from '../src/client/BidComposerContext.tsx'
import { CHAPTER_DRAG_TYPE, createBidRevisionStore } from '../src/client/revision-reference.ts'

afterEach(cleanup)

const chapter: BidReviewChapterView = {
  section_id: 'SEC-1', title: '实施方案', number: '1', heading_path: ['实施方案'], writable: true,
  markdown: '# 1 实施方案\n\n正文。\n', content_sha256: 'a'.repeat(64), requirement_ids: [],
  scoring_response_point_ids: [], evidence_status: 'available', review: { status: 'pass', issues: [] },
}

function composer() {
  const store = createBidRevisionStore().create()
  const forward = vi.fn<ComposerSubmitForward>(async () => ({ kind: 'success' }))
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
    actions: store.actions,
    getChapter: vi.fn(async () => chapter),
    registerSubmit,
  } as BidComposerContextProps
  const view = render(<div data-composer-card=""><BidComposerContext {...props} /></div>)
  const drop = () => fireEvent.drop(view.container.firstChild!, {
    dataTransfer: { types: [CHAPTER_DRAG_TYPE], getData: () => JSON.stringify({ sessionId: 'bid', sectionId: 'SEC-1' }) },
  })
  return {
    ...view,
    store,
    forward,
    drop,
    submit: (
      text: string,
      imageIds: Parameters<ComposerSubmitHandler>[1],
      signal: AbortSignal | undefined,
      mode: Parameters<ComposerSubmitHandler>[3] = 'queue',
      submissionId = 'submission-1',
    ) => submit!(text, imageIds, signal, mode, submissionId, forward),
  }
}

it('章节引用提交原样透传 steer 和 signal，发送成功后才清除引用', async () => {
  const view = composer()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  const signal = new AbortController().signal
  await act(async () => {
    await expect(view.submit('请继续这一节', [], signal, 'steer')).resolves.toEqual({ kind: 'success' })
  })
  expect(view.forward).toHaveBeenCalledWith(expect.stringContaining('"kind":"bid_chapter_reference"'), [])
  expect(view.store.getSnapshot().reference).toBeNull()
})

it('章节引用默认保留 queue，未带引用交还普通发送', async () => {
  const view = composer()
  expect(view.submit('普通要求', [], undefined, 'steer')).toBeUndefined()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  await act(async () => {
    await expect(view.submit('排队修改', [], undefined, 'queue')).resolves.toEqual({ kind: 'success' })
  })
  expect(view.forward).toHaveBeenCalledWith(expect.stringContaining('排队修改'), [])
})

it('章节引用发送失败不清除引用且不重复发送', async () => {
  const view = composer()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  view.forward.mockRejectedValueOnce(new Error('发送失败'))
  await act(async () => {
    await expect(view.submit('失败后保留', [], undefined, 'steer')).rejects.toThrow('发送失败')
  })
  expect(view.forward).toHaveBeenCalledTimes(1)
  expect(view.store.getSnapshot().reference).not.toBeNull()
})

it('章节引用可随图片发送并保留图片顺序，包括仅图片消息', async () => {
  const view = composer()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  const images = ['image-1', 'image-2'] as never
  await act(async () => {
    await expect(view.submit('', images, undefined, 'steer', 'submission-image')).resolves.toEqual({ kind: 'success' })
  })
  expect(view.forward).toHaveBeenCalledWith(expect.stringContaining('"kind":"bid_chapter_reference"'), images)
  expect(view.store.getSnapshot().reference).toBeNull()
})

it('forward 返回失败时保留引用且不重复发送', async () => {
  const view = composer()
  view.drop()
  await screen.findByText('章节 · 1 实施方案')
  view.forward.mockResolvedValueOnce({ kind: 'error', text: '发送失败' })
  await act(async () => {
    await expect(view.submit('失败后保留', ['image-1'] as never, undefined)).resolves.toEqual({
      kind: 'error',
      text: '发送失败',
    })
  })
  expect(view.forward).toHaveBeenCalledTimes(1)
  expect(view.store.getSnapshot().reference).not.toBeNull()
})
