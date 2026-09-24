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
  type BidRunContext,
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
  it('accepts an explicit S1 upload from the initial waiting state', async () => {
    const current = await session()
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute },
      { validate: async () => ({ ok: true }) })

    await expect(orchestrator.runCurrentProgramStage()).resolves.toMatchObject({
      stage: 'tender_analysis', status: 'ready',
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![0].stage).toBe('file_intake')
  })

  it('finishes the linear workflow at S5 and leaves S6 for on-demand export', async () => {
    expect(BID_STAGES).toEqual(['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export'])
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).userGate)).toEqual(['none', 'after_validation', 'after_validation', 'after_validation', 'before_execution', 'none'])

    const current = await session()
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute }, { validate: async () => ({ ok: true }) })
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user', run: null })
    await expect(orchestrator.confirmValidatedStage('tender_analysis', artifacts('tender_analysis'))).resolves.toEqual({ ok: true, state: { stage: 'outline_generation', status: 'waiting_user', run: null } })
    await expect(orchestrator.confirmValidatedStage('outline_generation', artifacts('outline_generation'))).resolves.toEqual({ ok: true, state: { stage: 'evidence_mapping', status: 'waiting_user', run: null } })
    await expect(orchestrator.confirmValidatedStage('evidence_mapping', artifacts('evidence_mapping'))).resolves.toEqual({ ok: true, state: { stage: 'chapter_writing', status: 'waiting_user', run: null } })
    expect(execute.mock.calls.map(call => call[0].stage)).toEqual(['tender_analysis', 'outline_generation', 'evidence_mapping'])
    current.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
    await expect(orchestrator.runConfirmedStage()).resolves.toEqual({ stage: 'chapter_writing', status: 'completed', run: null })
    expect(execute.mock.calls.map(call => call[0].stage)).toEqual(['tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing'])
  })

  it('keeps a reset S5 at the writing-requirements gate without executing chapters', async () => {
    const current = await session()
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute }, { validate: async () => ({ ok: true }) })
    current.append('bid.project.resumed', { state: { stage: 'chapter_writing', status: 'waiting_user', run: null }, revision: 1 })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'chapter_writing', status: 'waiting_user', run: null })
    expect(execute).not.toHaveBeenCalled()
  })

  it('commits an outline confirmation from its explicit running Work', async () => {
    const current = await session()
    current.append('bid.project.resumed', {
      state: { stage: 'evidence_mapping', status: 'waiting_user', run: null },
      revision: 4,
    })
    const run = {
      runId: 'run-outline-confirmation',
      epoch: 1,
      baseProjectRevision: 4,
      work: {
        kind: 'outline_confirmation' as const,
        workId: 'work-outline-confirmation',
        stage: 'evidence_mapping' as const,
        requestRef: 'requests/work-outline-confirmation.json',
        requestSha256: '0'.repeat(64),
        inputFingerprint: '1'.repeat(64),
      },
      startedAt: 1,
      updatedAt: 1,
    }
    current.append('bid.run.started', { run })
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => false, execute: async () => [] },
      { validate: async () => ({ ok: true }) },
    )

    await expect(orchestrator.commitPrevalidatedStage(
      'evidence_mapping',
      artifacts('evidence_mapping'),
      async (commitWorkflow) => {
        current.append('bid.run.completed', { run })
        commitWorkflow()
      },
    )).resolves.toEqual({ stage: 'chapter_writing', status: 'waiting_user', run: null })
  })

  it('keeps non-S2 validation issues out of the run error summary', async () => {
    const current = await session()
    const issue = { code: 'CHAPTER_REVIEW_TEXT_INVALID', message: '覆盖记录文本必须匹配当前章节 canonical 条目。' }
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute: async task => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues: [issue] }) },
    )
    current.append('bid.project.resumed', { state: { stage: 'chapter_writing', status: 'waiting_user', run: null }, revision: 1 })
    current.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
    await expect(orchestrator.runConfirmedStage()).resolves.toMatchObject({ stage: 'chapter_writing', status: 'suspended' })
    expect(orchestrator.state).toMatchObject({ status: 'suspended', run: {
      error: { code: 'BID_STAGE_VALIDATION_FAILED', message: '当前阶段结果未通过校验。', issues: [issue] },
    },
    })
  })

  it('records executor validation issues on the current stage', async () => {
    const current = await session()
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: stage => stage === 'tender_analysis', execute: async (task: BidStageTask) => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues: [{ code: 'INVALID_ARTIFACT', message: 'Artifact rejected.', artifact: 'analysis/scoring.json' }] }) },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toMatchObject({ stage: 'tender_analysis', status: 'suspended' })
    expect(orchestrator.state).toMatchObject({ status: 'suspended', run: { cause: 'retry_exhausted',
      error: { issues: [{ code: 'INVALID_ARTIFACT', artifact: 'analysis/scoring.json' }] } } })
  })

  it('starts a reset S2 directly from ready without a second confirmation', async () => {
    const current = await session()
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute },
      { validate: async () => ({ ok: true }) },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    current.append('bid.task.changed', { state: { stage: 'tender_analysis', status: 'ready', run: null } })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user', run: null })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0].stage).toBe('tender_analysis')
    expect(typeof execute.mock.calls[0]?.[1].runId).toBe('string')
    expect(current.events.some(event => event.type === 'bid.run.decision.required')).toBe(false)
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

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toMatchObject({ stage: 'tender_analysis', status: 'suspended' })
    expect(orchestrator.state).toMatchObject({ status: 'suspended', run: { cause: 'user_stop' } })
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
      .resolves.toMatchObject({ ok: true, state: { stage: 'outline_generation', status: 'waiting_user', run: null } })
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
    expect(orchestrator.state).toEqual({ stage: 'tender_analysis', status: 'waiting_user', run: null })
    expect(current.deriveMessages()).toEqual(before)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('same-stage resume does not prepare a cross-stage context boundary', async () => {
    const current = await session()
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })
    const prepare = vi.fn(async () => () => {})
    let valid = false
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute: async task => artifacts(task.stage) },
      { validate: async () => valid
        ? { ok: true }
        : { ok: false, issues: [{ code: 'MODEL_FAILED', message: '模型失败' }] } },
      undefined,
      prepare,
    )

    await orchestrator.runCurrentAutomaticStage()
    const suspended = orchestrator.state
    expect(suspended.status).toBe('suspended')
    if (suspended.status !== 'suspended') throw new Error('测试未进入挂起态')
    valid = true
    await expect(orchestrator.resume(suspended.run.runId)).resolves.toEqual({
      stage: 'tender_analysis', status: 'waiting_user', run: null,
    })
    expect(prepare).not.toHaveBeenCalled()
  })
})
