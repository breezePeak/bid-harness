import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  BID_RUNTIME_PROJECTION_KEY,
  getBidClientProjection,
  registerBidRuntimeProjection,
} from '@deepseek-ai/dsh-bid'

describe('Bid client projection', () => {
  it('相同项目状态的新修订不推送投影，失败问题变化仍刷新客户端', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidRuntimeProjection(ctx.sessionProjections)
    const listener = vi.fn()
    const unsubscribe = ctx.sessionProjections.onChanged(listener)
    try {
      const session = ctx.sessions.create()
      const waiting = { stage: 'evidence_mapping' as const, status: 'waiting_user' as const }
      session.append('bid.project.resumed', { runtime: waiting, revision: 1 })
      expect(listener).toHaveBeenCalledTimes(1)
      session.append('bid.project.resumed', { runtime: { ...waiting }, revision: 2 })
      expect(listener).toHaveBeenCalledTimes(1)

      const failed = {
        stage: 'chapter_writing' as const, status: 'failed' as const, failureReason: '章节缺少资料。',
        failureIssues: [{ code: 'MISSING_EVIDENCE', message: '缺少施工参数。', artifact: 'chapters/section-1.md', path: 'body' }],
      }
      session.append('bid.project.resumed', { runtime: failed, revision: 3 })
      expect(listener).toHaveBeenCalledTimes(2)
      session.append('bid.project.resumed', { runtime: {
        ...failed,
        failureIssues: [{ path: 'body', artifact: 'chapters/section-1.md', message: '缺少施工参数。', code: 'MISSING_EVIDENCE' }],
      }, revision: 4 })
      expect(listener).toHaveBeenCalledTimes(2)
      session.append('bid.project.resumed', { runtime: {
        ...failed, failureIssues: [{ ...failed.failureIssues[0]!, message: '缺少项目进度参数。' }],
      }, revision: 5 })
      expect(listener).toHaveBeenCalledTimes(3)
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]?.runtime.failureIssues?.[0]?.message)
        .toBe('缺少项目进度参数。')
    } finally {
      unsubscribe()
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })

  it('将项目恢复事件应用到当前 Session，并继续处理当前阶段确认', async () => {
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const disposeProjection = registerBidRuntimeProjection(ctx.sessionProjections)
    try {
      const session = ctx.sessions.create()
      session.append('bid.project.resumed', {
        runtime: { stage: 'evidence_mapping', status: 'waiting_user' }, revision: 12,
      })
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
        runtime: { stage: 'evidence_mapping', status: 'waiting_user' },
        allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'],
        composer: { enabled: true },
      })
      session.append('bid.user_confirmation.received', { stage: 'evidence_mapping', confirmed: true })
      session.append('bid.stage.completed', { stage: 'evidence_mapping', status: 'completed', artifacts: [] })
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]?.runtime)
        .toEqual({ stage: 'chapter_writing', status: 'pending' })
      session.append('bid.project.resumed', {
        runtime: { stage: 'outline_generation', status: 'pending' }, revision: 14,
      })
      expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]?.runtime)
        .toEqual({ stage: 'outline_generation', status: 'pending' })
    } finally {
      disposeProjection()
      await projections.dispose()
      await sessions.dispose()
    }
  })

  it('derives allowed actions and composer capability from host runtime state', () => {
    expect(getBidClientProjection({ stage: 'file_intake', status: 'pending' })).toEqual({
      runtime: { stage: 'file_intake', status: 'pending' },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.upload_required' },
    })
    expect(getBidClientProjection({ stage: 'tender_analysis', status: 'pending' })).toEqual({
      runtime: { stage: 'tender_analysis', status: 'pending' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_pending' },
    })
    expect(getBidClientProjection({ stage: 'evidence_mapping', status: 'waiting_start' })).toEqual({
      runtime: { stage: 'evidence_mapping', status: 'waiting_start' },
      allowedActions: ['start_stage'],
      composer: { enabled: false, reason: 'bid.stage_start_required' },
    })
    expect(getBidClientProjection({ stage: 'tender_analysis', status: 'running' })).toEqual({
      runtime: { stage: 'tender_analysis', status: 'running' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_running' },
    })
    expect(getBidClientProjection({ stage: 'tender_analysis', status: 'waiting_user' })).toEqual({
      runtime: { stage: 'tender_analysis', status: 'waiting_user' },
      allowedActions: ['confirm_tender_analysis', 'send_message'],
      composer: { enabled: true },
    })
    expect(getBidClientProjection({ stage: 'outline_generation', status: 'waiting_user' })).toEqual({
      runtime: { stage: 'outline_generation', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'],
      composer: { enabled: true },
    })
    expect(getBidClientProjection({ stage: 'evidence_mapping', status: 'waiting_user' })).toEqual({
      runtime: { stage: 'evidence_mapping', status: 'waiting_user' },
      allowedActions: ['confirm_outline', 'regenerate_outline', 'send_message'],
      composer: { enabled: true },
    })
    expect(getBidClientProjection({
      stage: 'file_intake', status: 'failed', failureReason: 'document needs OCR',
    })).toEqual({
      runtime: { stage: 'file_intake', status: 'failed', failureReason: 'document needs OCR' },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    })
    expect(getBidClientProjection({
      stage: 'tender_analysis', status: 'failed', failureReason: 'invalid citation',
    })).toEqual({
      runtime: { stage: 'tender_analysis', status: 'failed', failureReason: 'invalid citation' },
      allowedActions: ['retry_stage'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    })
    expect(getBidClientProjection({ stage: 'chapter_writing', status: 'failed' })).toEqual({
      runtime: { stage: 'chapter_writing', status: 'failed' },
      allowedActions: ['retry_stage'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    })
    expect(getBidClientProjection({ stage: 'chapter_writing', status: 'completed' })).toEqual({
      runtime: { stage: 'chapter_writing', status: 'completed' },
      allowedActions: ['export_docx'],
      composer: { enabled: false, reason: 'bid.completed' },
    })
    expect(getBidClientProjection({ stage: 'docx_export', status: 'completed' }).allowedActions).toEqual(['export_docx'])
  })

  it('registers bid.runtime as a whole-value DSH session projection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    registerBidRuntimeProjection(ctx.sessionProjections)
    const session = ctx.sessions.create()

    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: { stage: 'file_intake', status: 'pending' },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.upload_required' },
    })

    const resetSession = ctx.sessions.create()
    resetSession.append('bid.project.resumed', {
      runtime: { stage: 'evidence_mapping', status: 'waiting_start' }, revision: 1,
    })
    expect(ctx.sessionProjections.snapshot(resetSession).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: { stage: 'evidence_mapping', status: 'waiting_start' },
      allowedActions: ['start_stage'],
      composer: { enabled: false, reason: 'bid.stage_start_required' },
    })

    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: { stage: 'file_intake', status: 'running' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_running' },
    })

    session.append('bid.stage.failed', {
      stage: 'file_intake', status: 'failed', reason: 'document needs OCR', issues: [{
        code: 'DOCUMENT_INVALID',
        artifact: 'manifest.json',
        path: 'files[0]',
        message: 'document cannot be parsed',
      }],
    })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: {
        stage: 'file_intake',
        status: 'failed',
        failureReason: 'document needs OCR',
        failureIssues: [{ code: 'DOCUMENT_INVALID', artifact: 'manifest.json', path: 'files[0]', message: 'document cannot be parsed' }],
      },
      allowedActions: ['upload_files'],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    })

    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toMatchObject({
      runtime: { stage: 'file_intake', status: 'running' },
      allowedActions: [],
    })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).not.toHaveProperty(
      'runtime.failureReason',
    )
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).not.toHaveProperty(
      'runtime.failureIssues',
    )
  })
})
