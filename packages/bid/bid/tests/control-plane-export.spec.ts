import { describe, expect, it } from 'vitest'
import * as controlPlane from '../src/control-plane.ts'

describe('browser-safe Bid control-plane export', () => {
  it('serves pure data contracts without the document pipeline entry', () => {
    expect(Object.keys(controlPlane).sort()).toEqual([
      'BID_CLIENT_ACTIONS',
      'BID_RUNTIME_PROJECTION_KEY',
      'BID_STAGES',
      'STAGE_RUN_STATUSES',
    ])
    expect(controlPlane.BID_RUNTIME_PROJECTION_KEY).toBe('bid.runtime')
    expect(controlPlane.BID_STAGES).toHaveLength(8)
    expect(controlPlane.BID_CLIENT_ACTIONS).toEqual([
      'upload_files',
      'retry_stage',
      'confirm_outline',
      'send_message',
    ])
  })
})
