import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  BID_RUNTIME_PROJECTION_KEY,
  getBidClientProjection,
  registerBidRuntimeProjection,
} from '@deepseek-ai/dsh-bid'

describe('Bid client projection', () => {
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
    expect(getBidClientProjection({ stage: 'tender_analysis', status: 'running' })).toEqual({
      runtime: { stage: 'tender_analysis', status: 'running' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_running' },
    })
    expect(getBidClientProjection({ stage: 'outline_confirmation', status: 'waiting_user' })).toEqual({
      runtime: { stage: 'outline_confirmation', status: 'waiting_user' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.outline_confirmation_required' },
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
    expect(getBidClientProjection({ stage: 'book_review', status: 'failed' })).toEqual({
      runtime: { stage: 'book_review', status: 'failed' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_failed' },
    })
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

    session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: { stage: 'file_intake', status: 'running' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.stage_running' },
    })

    session.append('bid.stage.failed', {
      stage: 'file_intake', status: 'failed', reason: 'document needs OCR',
    })
    expect(ctx.sessionProjections.snapshot(session).values[BID_RUNTIME_PROJECTION_KEY]).toEqual({
      runtime: { stage: 'file_intake', status: 'failed', failureReason: 'document needs OCR' },
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
  })
})
