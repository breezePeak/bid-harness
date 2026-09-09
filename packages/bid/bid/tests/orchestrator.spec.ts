import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  BID_STAGES,
  BidOrchestrator,
  buildBidStageTask,
  getBidStagePolicy,
  type BidStage,
  type BidStageTask,
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
  it('finishes the linear workflow at S5 and leaves S6 for on-demand export', async () => {
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
    await expect(orchestrator.confirmValidatedStage('evidence_mapping', artifacts('evidence_mapping'))).resolves.toEqual({ ok: true, state: { stage: 'chapter_writing', status: 'completed' } })
    expect(execute.mock.calls.map(call => call[0].stage)).toEqual(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'])
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

  it('starts a reset stage only after the explicit post-reset confirmation', async () => {
    const current = await session()
    const execute = vi.fn(async task => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute },
      { validate: async () => ({ ok: true }) },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    current.append('bid.stage.reset', { stage: 'tender_analysis', status: 'waiting_start' })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_start' })
    expect(execute).not.toHaveBeenCalled()
    await expect(orchestrator.startResetStage()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'tender_analysis' }))
    expect(() => orchestrator.startResetStage()).toThrow(expect.objectContaining({ code: 'BID_STAGE_START_NOT_ALLOWED' }))
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

  it('commits the context boundary after completion and before the successor executor', async () => {
    const current = await session()
    const order: string[] = []
    const execute = vi.fn(async (task: BidStageTask) => {
      order.push(`execute:${task.stage}`)
      expect(order).toContain('context:commit')
      return artifacts(task.stage)
    })
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: stage => stage === 'outline_generation', execute },
      { validate: async () => { order.push('validate'); return { ok: true } } },
      undefined,
      async (fromStage, toStage) => {
        order.push(`prepare:${fromStage}:${toStage}`)
        return () => {
          expect(current.events.at(-1)).toMatchObject({ type: 'bid.stage.completed', data: { stage: fromStage } })
          order.push('context:commit')
        }
      },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    current.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    current.append('bid.user_confirmation.required', { stage: 'tender_analysis', status: 'waiting_user' })

    await expect(orchestrator.confirmValidatedStage('tender_analysis', artifacts('tender_analysis')))
      .resolves.toMatchObject({ ok: true, state: { stage: 'outline_generation', status: 'waiting_user' } })
    expect(order).toEqual([
      'validate',
      'prepare:tender_analysis:outline_generation',
      'context:commit',
      'execute:outline_generation',
      'validate',
    ])
  })

  it('confirmation validation failure preserves the waiting-stage model context', async () => {
    const current = await session()
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    current.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    current.append('bid.user_confirmation.required', { stage: 'tender_analysis', status: 'waiting_user' })
    current.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '保留当前 S2 修改上下文' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = current.deriveMessages()
    const prepare = vi.fn(async () => () => {})
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => false, execute: async () => [] },
      { validate: async () => ({ ok: false, issues: [{ code: 'INVALID_FINAL_ARTIFACT', message: '拒绝最终产物' }] }) },
      undefined,
      prepare,
    )

    await expect(orchestrator.confirmValidatedStage('tender_analysis', artifacts('tender_analysis'))).resolves.toEqual({
      ok: false,
      validation: { ok: false, issues: [{ code: 'INVALID_FINAL_ARTIFACT', message: '拒绝最终产物' }] },
    })
    expect(orchestrator.state).toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    expect(current.deriveMessages()).toEqual(before)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('same-stage retry does not prepare a cross-stage context boundary', async () => {
    const current = await session()
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    current.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    current.append('bid.stage.failed', { stage: 'tender_analysis', status: 'failed', reason: '模型失败' })
    const prepare = vi.fn(async () => () => {})
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute: async task => artifacts(task.stage) },
      { validate: async () => ({ ok: true }) },
      undefined,
      prepare,
    )

    await expect(orchestrator.retryCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis', status: 'waiting_user',
    })
    expect(prepare).not.toHaveBeenCalled()
  })
})
