import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  BID_STAGES,
  BidOrchestrator,
  buildBidStageTask,
  getBidStagePolicy,
  type BidStage,
  type StageArtifact,
} from '@deepseek-ai/dsh-bid'

function artifacts(stage: BidStage): StageArtifact[] {
  return buildBidStageTask(stage).requiredArtifacts.map((path, index) => ({ stage, type: `artifact-${String(index)}`, path }))
}

async function session() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create()
}

describe('BidOrchestrator', () => {
  it('uses the six-stage order and pauses for the three post-validation confirmations', async () => {
    expect(BID_STAGES).toEqual(['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export'])
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).userGate)).toEqual(['none', 'after_validation', 'after_validation', 'after_validation', 'none', 'none'])

    const current = await session()
    const execute = vi.fn(async task => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute }, { validate: async () => ({ ok: true }) })
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    await expect(orchestrator.confirmValidatedStage('tender_analysis', artifacts('tender_analysis'))).resolves.toEqual({ ok: true, state: { stage: 'outline_generation', status: 'waiting_user' } })
    await expect(orchestrator.confirmValidatedStage('outline_generation', artifacts('outline_generation'))).resolves.toEqual({ ok: true, state: { stage: 'evidence_mapping', status: 'waiting_user' } })
    await expect(orchestrator.confirmValidatedStage('evidence_mapping', artifacts('evidence_mapping'))).resolves.toEqual({ ok: true, state: { stage: 'docx_export', status: 'completed' } })
    expect(execute.mock.calls.map(call => call[0].stage)).toEqual(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export'])
  })

  it('records executor validation issues on the current stage', async () => {
    const current = await session()
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: stage => stage === 'tender_analysis', execute: async task => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues: [{ code: 'INVALID_ARTIFACT', message: 'Artifact rejected.', artifact: 'analysis/scoring.json' }] }) },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toMatchObject({
      stage: 'tender_analysis', status: 'failed', failureIssues: [{ code: 'INVALID_ARTIFACT', artifact: 'analysis/scoring.json' }],
    })
  })

  it('leaves a cancelled stage for reset without recording a failure', async () => {
    const current = await session()
    const controller = new AbortController()
    const orchestrator = new BidOrchestrator(
      current,
      {
        canExecute: stage => stage === 'tender_analysis',
        execute: async () => {
          controller.abort()
          controller.signal.throwIfAborted()
          return []
        },
      },
      { validate: async () => ({ ok: true }) },
      controller.signal,
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toMatchObject({
      stage: 'tender_analysis', status: 'running',
    })
    expect(current.events.some(event => event.type === 'bid.stage.failed')).toBe(false)
  })
})
