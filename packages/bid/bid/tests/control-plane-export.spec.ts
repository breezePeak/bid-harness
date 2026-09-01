import { describe, expect, it } from 'vitest'
import * as controlPlane from '@deepseek-ai/dsh-bid/control-plane'

describe('browser-safe Bid control-plane export', () => {
  it('serves pure data contracts without the document pipeline entry', () => {
    expect(Object.keys(controlPlane).sort()).toEqual([
      'BID_CLIENT_ACTIONS',
      'BID_RUNTIME_PROJECTION_KEY',
      'BID_STAGES',
      'STAGE_RUN_STATUSES',
      'applyOutlineEdits',
      'applyTenderAnalysisEdits',
      'buildOutlineView',
    ])
    expect(controlPlane.BID_RUNTIME_PROJECTION_KEY).toBe('bid.runtime')
    expect(controlPlane.BID_STAGES).toHaveLength(8)
    expect(controlPlane.BID_CLIENT_ACTIONS).toEqual([
      'upload_files',
      'retry_stage',
      'confirm_tender_analysis',
      'confirm_outline',
      'regenerate_outline',
      'complete_review',
      'send_message',
    ])
  })
})
