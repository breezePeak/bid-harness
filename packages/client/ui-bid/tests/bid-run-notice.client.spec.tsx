// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BidRunNotice as BidRunNoticeData } from '@deepseek-ai/dsh-bid/control-plane'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidRunNotice } from '../src/client/BidRunNotice.tsx'
import { bidRunNoticeDefinition } from '../src/client/bid-run-notice-definition.ts'

const data = {
  noticeId: 'run:one:suspended', supersedesTurn: null, runId: 'one', stage: 'evidence_mapping' as const,
  kind: 'interrupted' as const, severity: 'error' as const, message: '当前阶段已中断，已保存已完成进度。',
}

afterEach(cleanup)

function event(): SessionEvent {
  return { type: 'bid.run.notice', seq: 12, time: 1, data } as unknown as SessionEvent
}

function match(): ConversationMatch {
  return { event: event(), view: undefined, role: 'start', location: { kind: 'session' } }
}

describe('Bid Run conversation notice', () => {
  it('projects one durable notice by its stable identity', () => {
    const accepted = bidRunNoticeDefinition.match(event())
    expect(accepted).toEqual({ id: data.noticeId, role: 'start' })
    const state = bidRunNoticeDefinition.start({} as ConversationNodeContext<BidRunNoticeData>, match(), {} as never)
    const node = bidRunNoticeDefinition.buildViewNode!({
      key: 'bid-run-notice', kind: 'bid-run-notice', id: data.noticeId,
      matches: [match()], start: match(), state, current: new Map(),
    })
    expect(node).toMatchObject({ id: data.noticeId, anchorSeq: 12, data })
  })

  it('collapses an error notice to its important summary and expands the full diagnostic', () => {
    const message = 'BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。；CHAPTER_REVIEW_TEXT_INVALID: 覆盖记录文本必须匹配当前章节 canonical 条目。'
    const props = { node: { data: { ...data, message } } } as unknown as Parameters<typeof BidRunNotice>[0]
    render(<BidRunNotice {...props} />)
    const row = screen.getByRole('button', { name: /任务运行失败/u })
    expect(row.textContent).toContain('BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。')
    expect(screen.queryByText(message)).toBeNull()

    fireEvent.click(row)
    expect(screen.getByText(message)).toBeTruthy()
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a stopped notice neutral and non-expandable', () => {
    const props = { node: { data: { ...data, severity: 'info', kind: 'stopped' } } } as unknown as Parameters<typeof BidRunNotice>[0]
    render(<BidRunNotice {...props} />)
    expect(screen.getByRole('status').textContent).toBe(data.message)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('发布后的文件自动出现，读取失败可重试，刷新后仍从 Host 取得最终版本', async () => {
    const view = { receipt: 'c'.repeat(64), files: [{ position: 0, name: '方案-修改版.docx', mediaType: 'application/octet-stream', bytes: 32, preview: true }] }
    const getDeliverables = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValue(view)
    const artifactUrl = (work: string, receipt: string, position: number, mode: string) => `/api/bid/artifacts?work=${work}&receipt=${receipt}&position=${String(position)}&mode=${mode}`
    const props = { node: { data: { ...data, kind: 'completed', severity: 'info', workId: 'work-one' } }, getDeliverables, artifactUrl } as unknown as Parameters<typeof BidRunNotice>[0]
    const first = render(<BidRunNotice {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain('连接中断')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    const download = await screen.findByRole('link', { name: '下载' })
    expect(download.getAttribute('href')).toBe(artifactUrl('work-one', view.receipt, 0, 'download'))
    expect(download.getAttribute('download')).toBe(view.files[0]!.name)
    expect(screen.getByRole('link', { name: '查看' }).getAttribute('href')).toBe(artifactUrl('work-one', view.receipt, 0, 'preview'))
    first.unmount()
    render(<BidRunNotice {...props} />)
    await screen.findByRole('link', { name: '下载' })
    expect(getDeliverables).toHaveBeenCalledTimes(3)
  })

  it('已切换通知后到达的文件列表不能覆盖当前任务', async () => {
    type View = Awaited<ReturnType<Parameters<typeof BidRunNotice>[0]['getDeliverables']>>
    let release!: (value: View) => void
    const getDeliverables = vi.fn().mockImplementationOnce(() => new Promise<View>((resolve) => { release = resolve }))
      .mockResolvedValue({ receipt: 'b'.repeat(64), files: [{ position: 0, name: '当前图.png', mediaType: 'image/png', bytes: 2, preview: true }] })
    const props = { node: { data: { ...data, kind: 'completed', severity: 'info', workId: 'old' } }, getDeliverables, artifactUrl: () => '/api/bid/artifacts' } as unknown as Parameters<typeof BidRunNotice>[0]
    const mounted = render(<BidRunNotice {...props} />)
    mounted.rerender(<BidRunNotice {...props} node={{ ...props.node, data: { ...props.node.data, workId: 'new', noticeId: 'new' } }} />)
    await screen.findByText('当前图.png')
    await act(async () => { release({ receipt: 'a'.repeat(64), files: [{ position: 0, name: '旧图.png', mediaType: 'image/png', bytes: 1, preview: true }] }) })
    expect(screen.queryByText('旧图.png')).toBeNull()
  })
})
