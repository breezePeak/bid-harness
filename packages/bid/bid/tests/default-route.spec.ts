import { expect, it } from 'vitest'
import { DEFAULT_BID_ROUTE, defaultBidNextStage, defaultBidUserGate } from '../src/default-route.ts'
import { getBidStagePolicy } from '../src/runtime-state.ts'

it('默认整本路线的顺序与首次确认点由同一表述决定', () => {
  expect(DEFAULT_BID_ROUTE).toEqual([
    'file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing',
  ])
  for (const [index, stage] of DEFAULT_BID_ROUTE.entries()) {
    const policy = getBidStagePolicy(stage)
    expect(policy.nextStage).toBe(defaultBidNextStage(stage))
    expect(policy.nextStage).toBe(DEFAULT_BID_ROUTE[index + 1] ?? null)
    expect(policy.userGate).toBe(defaultBidUserGate(stage))
  }
  expect(defaultBidUserGate('tender_analysis')).toBe('after_validation')
  expect(defaultBidUserGate('outline_generation')).toBe('after_validation')
  expect(defaultBidUserGate('evidence_mapping')).toBe('after_validation')
  expect(defaultBidUserGate('chapter_writing')).toBe('before_execution')
  expect(defaultBidNextStage('docx_export')).toBeNull()
})
