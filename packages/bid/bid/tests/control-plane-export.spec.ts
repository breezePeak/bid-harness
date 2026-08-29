import { describe, expect, it } from 'vitest'
import {
  BID_CLIENT_ACTIONS,
  BID_STAGES,
  getBidClientProjection,
  getBidStagePolicy,
} from '../src/control-plane.ts'

describe('browser-safe Bid control-plane export', () => {
  it('serves pure data contracts without the document pipeline entry', () => {
    expect(BID_STAGES).toHaveLength(8)
    expect(BID_CLIENT_ACTIONS).toEqual([
      'upload_files',
      'retry_stage',
      'confirm_outline',
      'send_message',
    ])
    expect(getBidStagePolicy('docx_export')).toMatchObject({
      executor: 'program',
      nextStage: null,
    })
    expect(getBidClientProjection({ stage: 'docx_export', status: 'completed' })).toEqual({
      runtime: { stage: 'docx_export', status: 'completed' },
      allowedActions: [],
      composer: { enabled: false, reason: 'bid.completed' },
    })
  })
})
