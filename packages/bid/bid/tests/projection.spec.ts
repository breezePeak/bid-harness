import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  BID_RUNTIME_PROJECTION_KEY,
  registerBidDocxExportProjection,
  getBidClientProjection,
  registerBidRuntimeProjection,
  type BidRunData,
  type BidTaskState,
} from '@deepseek-ai/dsh-bid'
import { BID_DOCX_EXPORT_PROJECTION_KEY } from '../src/docx-export-operation.ts'
import { docxExportOperationSchema } from '../src/docx-export-operation.ts'

const run: BidRunData = {
  runId: 'run-1', epoch: 1, baseProjectRevision: 1,
  work: {
    kind: 'stage_execution', workId: 'work-1', stage: 'evidence_mapping',
    requestRef: 'requests/work-1.json', requestSha256: '1'.repeat(64), inputFingerprint: '2'.repeat(64),
  },
  startedAt: 1, updatedAt: 2,
}

describe('Bid client projection', () => {
  it('独立导出事件可重放，且拒绝缺少结果的完成态', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidDocxExportProjection(ctx.sessionProjections)
    try {
      const session = ctx.sessions.create()
      const running = { operationId: 'export-1', templateId: null, startedAt: 1, updatedAt: 2,
        status: 'running' as const, phase: 'collecting' as const, message: '正在收集' }
      session.append('bid.docx_export.changed', { operation: running })
      expect(ctx.sessionProjections.snapshot(session).values[BID_DOCX_EXPORT_PROJECTION_KEY]).toEqual(running)
      session.append('bid.docx_export.changed', { operation: { ...running, status: 'failed', error: '导出中断' } })
      expect(ctx.sessionProjections.snapshot(session).values[BID_DOCX_EXPORT_PROJECTION_KEY]).toMatchObject({ status: 'failed', error: '导出中断' })
      expect(docxExportOperationSchema.safeParse({ ...running, status: 'completed' }).success).toBe(false)
      const completed = { ...running, status: 'completed', path: 'output/bid.docx', warnings: [] }
      expect(docxExportOperationSchema.safeParse({ ...completed, filePath: 'E:\\project\\.bid-harness\\output\\bid.docx' }).success).toBe(true)
      expect(docxExportOperationSchema.safeParse(completed).success).toBe(true)
      expect(docxExportOperationSchema.safeParse({ ...running, status: 'failed' }).success).toBe(false)
    } finally {
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })
  it('只投影 task，并在唯一状态变化时刷新', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidRuntimeProjection(ctx.sessionProjections)
    const listener = vi.fn()
    const unsubscribe = ctx.sessionProjections.onChanged(listener)
    try {
      const session = ctx.sessions.create()
      const waiting: BidTaskState = { stage: 'evidence_mapping', status: 'waiting_user', run: null }
      session.append('bid.project.resumed', { state: waiting, revision: 1 })
      session.append('bid.project.resumed', { state: waiting, revision: 2 })
      expect(listener).toHaveBeenCalledTimes(1)

      session.append('bid.task.changed', {
        state: { stage: 'chapter_writing', status: 'failed', run: null,
          failure: { message: '章节缺少资料。', issues: [{ code: 'MISSING_EVIDENCE', message: '缺少施工参数。' }] } },
      })
      const view = ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]
      expect(view?.task).toMatchObject({ status: 'failed', failure: { message: '章节缺少资料。' } })
      expect(view).not.toHaveProperty('runtime')
      expect(view).not.toHaveProperty('run')
    } finally {
      unsubscribe()
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })

  it('从 task 状态生成 Host 准入动作', () => {
    expect(getBidClientProjection({ stage: 'file_intake', status: 'waiting_user', run: null }).allowedActions)
      .toEqual(['upload_files', 'send_message'])
    expect(getBidClientProjection({ stage: 'evidence_mapping', status: 'waiting_user', run: null }).allowedActions)
      .toEqual(['confirm_outline', 'regenerate_outline', 'send_message'])
    expect(getBidClientProjection({ stage: 'chapter_writing', status: 'running', run: { ...run,
      work: { ...run.work, stage: 'chapter_writing' } } }).allowedActions)
      .toEqual(['send_message', 'export_docx'])
    expect(getBidClientProjection({ stage: 'evidence_mapping', status: 'suspended', run: {
      ...run, cause: 'retry_exhausted', error: { message: '模型修复次数已用尽。' },
    } }).allowedActions).toEqual(['send_message'])
  })

  it('继续结构化读取旧 resumed payload，但输出单一 task', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidRuntimeProjection(ctx.sessionProjections)
    try {
      const session = ctx.sessions.create()
      session.append('bid.project.resumed', {
        runtime: { stage: 'outline_generation', status: 'waiting_start' }, revision: 3,
      })
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]?.task)
        .toEqual({ stage: 'outline_generation', status: 'ready', run: null })
    } finally {
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })

  it('注册后的空日志以 S1 waiting_user 为初始状态', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidRuntimeProjection(ctx.sessionProjections)
    try {
      const session = ctx.sessions.create()
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toMatchObject({
        task: { stage: 'file_intake', status: 'waiting_user', run: null },
        allowedActions: ['upload_files', 'send_message'],
      })
    } finally {
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })
})
