// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { DocxExportOperation } from '@deepseek-ai/dsh-bid/control-plane'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidDocxExportNotice } from '../src/client/BidDocxExportNotice.tsx'
import { bidDocxExportNoticeDefinition } from '../src/client/bid-docx-export-notice-definition.ts'

const base = {
  operationId: 'export-one', templateId: null, startedAt: 1, updatedAt: 2,
  phase: 'finalizing' as const,
}
const completed = {
  ...base, status: 'completed' as const, message: 'Word 导出完成', path: 'output/bid.docx',
  filePath: 'E:\\project\\.bid-harness\\output\\bid.docx', warnings: [],
}

afterEach(cleanup)

function event(operation: DocxExportOperation, seq = 12): SessionEvent {
  return { type: 'bid.docx_export.changed', seq, time: 1, data: { operation } }
}

function match(operation: DocxExportOperation): ConversationMatch {
  return { event: event(operation), view: undefined, role: 'start', location: { kind: 'session' } }
}

describe('Word 导出聊天结果', () => {
  it('仅将持久终态事件投影为可重放消息，并显示绝对文件位置', () => {
    expect(bidDocxExportNoticeDefinition.match(event({ ...base, status: 'running', message: '正在生成 Word' }))).toBeNull()
    expect(bidDocxExportNoticeDefinition.match(event(completed))).toEqual({ id: '12', role: 'start' })
    const start = match(completed)
    const state = bidDocxExportNoticeDefinition.start({} as ConversationNodeContext<never>, start, {} as never)
    const node = bidDocxExportNoticeDefinition.buildViewNode!({
      key: 'bid-docx-export-notice', kind: 'bid-docx-export-notice', id: '12',
      matches: [start], start, state, current: new Map(),
    })
    expect(node).toMatchObject({ id: '12', anchorSeq: 12, data: completed })
    render(<BidDocxExportNotice node={node as never} showExport={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Word 导出完成')
    expect(screen.getByRole('status').textContent).toContain(completed.filePath)
  })

  it('失败时报告未完成及原因，不显示旧成功路径', () => {
    const failed = { ...base, status: 'failed' as const, message: 'Word 导出失败', error: '生成的 Word 文件结构无效。' }
    expect(bidDocxExportNoticeDefinition.match(event(failed))).toEqual({ id: '12', role: 'start' })
    expect(bidDocxExportNoticeDefinition.match(event({ ...completed, updatedAt: 3 }, 13)))
      .toEqual({ id: '13', role: 'start' })
    render(<BidDocxExportNotice node={{ data: failed } as never} showExport={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('Word 导出失败，未完成')
    expect(screen.getByRole('alert').textContent).toContain(failed.error)
    expect(screen.queryByText(/bid\.docx/u)).toBeNull()
  })

  it('旧日志缺少绝对路径时标明相对基准并提供导出页入口', () => {
    const showExport = vi.fn()
    const { filePath: _filePath, ...historical } = completed
    render(<BidDocxExportNotice node={{ data: historical } as never} showExport={showExport} />)
    expect(screen.getByRole('status').textContent).toContain('项目数据目录内的 output/bid.docx')
    fireEvent.click(screen.getByRole('button', { name: '前往导出页查看当前文件' }))
    expect(showExport).toHaveBeenCalledOnce()
  })
})
