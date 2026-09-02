import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BID_SESSION_EVENT_TYPES,
  BID_STAGES,
  getBidStagePolicy,
  STAGE_RUN_STATUSES,
  type BidSessionEventMap,
  type BidStagePolicy,
  type BidStageTask,
  type StageValidationResult,
} from '@deepseek-ai/dsh-bid'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { BidEvidenceMappingProgress } from '@deepseek-ai/dsh-bid/control-plane'

describe('bid control-plane public contract', () => {
  it('exports the fixed stage, status, and event names', () => {
    expect(BID_STAGES).toEqual([
      'file_intake',
      'tender_analysis',
      'outline_generation',
      'evidence_mapping',
      'chapter_writing',
      'docx_export',
    ])
    expect(STAGE_RUN_STATUSES).toEqual(['pending', 'running', 'waiting_user', 'failed', 'completed'])
    expect(BID_SESSION_EVENT_TYPES).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.failed',
      'bid.stage.reset',
      'bid.user_confirmation.required',
      'bid.user_confirmation.received',
    ])
  })

  it('expresses a stage policy and task through the package entry', () => {
    const policy: BidStagePolicy = {
      stage: 'tender_analysis',
      executor: 'agent',
      requiredInputs: ['manifest.json'],
      allowedTools: ['grep', 'read', 'write'],
      forbiddenTools: ['bash'],
      requiredArtifacts: ['analysis/requirements.json'],
      validator: 'tender-analysis-validator',
      userGate: 'none',
      nextStage: 'outline_generation',
    }
    const task: BidStageTask = {
      stage: 'tender_analysis',
      objective: 'Extract tender requirements and atomic scoring items.',
      inputs: policy.requiredInputs,
      requiredArtifacts: policy.requiredArtifacts,
      allowedTools: policy.allowedTools,
      constraints: ['Write only the required analysis artifacts.'],
    }

    expect(policy.nextStage).toBe('outline_generation')
    expect(task).toMatchObject({ stage: 'tender_analysis', requiredArtifacts: ['analysis/requirements.json'] })
  })

  it('exports S3 Mapping progress through the browser-safe entry', () => {
    expectTypeOf<BidEvidenceMappingProgress>().toEqualTypeOf<{
      readonly total: number
      readonly completed: number
      readonly running: number
      readonly not_started: number
      readonly failed: number
    }>()
  })

  it('limits evidence mapping Main-Agent policy to planning tools', () => {
    const policy = getBidStagePolicy('evidence_mapping')

    expect(policy.allowedTools).toEqual(['read', 'write'])
    expect(policy.forbiddenTools).toEqual(['bash'])
  })

  it('distinguishes successful and failed validation with multiple issues', () => {
    const success: StageValidationResult = { ok: true }
    const failure: StageValidationResult = {
      ok: false,
      issues: [
        { code: 'MISSING_ARTIFACT', message: 'Requirements are missing.', artifact: 'analysis/requirements.json' },
        { code: 'EMPTY_SCORING', message: 'No scoring items were extracted.' },
      ],
    }

    expect(success.ok).toBe(true)
    expect(failure).toMatchObject({ ok: false, issues: [{ code: 'MISSING_ARTIFACT' }, { code: 'EMPTY_SCORING' }] })
  })

  it('merges bid payloads into the shared session event map', () => {
    expectTypeOf<BidSessionEventMap>().toEqualTypeOf<Pick<SessionEventMap, typeof BID_SESSION_EVENT_TYPES[number]>>()
    expectTypeOf<SessionEventMap['bid.stage.started']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status: 'running'
    }>()
    expectTypeOf<SessionEventMap['bid.stage.failed']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status: 'failed'
      reason: string
      issues?: Array<{
        code: string
        message: string
        artifact?: string | undefined
        path?: string | undefined
      }>
    }>()
    expectTypeOf<SessionEventMap['bid.stage.reset']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status: 'pending'
    }>()
    expectTypeOf<SessionEventMap['bid.user_confirmation.received']>().toEqualTypeOf<
      | {
        stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
        confirmed: true
      }
      | { stage: 'outline_generation' | 'evidence_mapping'; confirmed: false; feedback: string }
    >()
  })
})
