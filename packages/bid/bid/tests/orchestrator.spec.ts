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
  type BidRunData,
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

function recordFailedOutlineRun(current: Awaited<ReturnType<typeof session>>, noticeRunId?: string): BidRunData {
  const failedRun: BidRunData = {
    runId: 'failed-outline-run', epoch: 1, baseProjectRevision: 4, startedAt: 1, updatedAt: 1,
    work: { kind: 'stage_execution', workId: 'outline-work', stage: 'outline_generation',
      requestRef: 'requests/outline-work.json', requestSha256: '0'.repeat(64), inputFingerprint: '1'.repeat(64) },
  }
  current.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'ready', run: null } })
  current.append('bid.run.started', { run: failedRun })
  current.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'failed', run: null,
    failure: { code: 'BID_STAGE_EXECUTION_FAILED', message: '目录候选需要修复。' } } })
  current.append('bid.run.notice', { noticeId: `run:${noticeRunId ?? failedRun.runId}:failed`,
    runId: noticeRunId ?? failedRun.runId, stage: 'outline_generation',
    kind: 'interrupted', severity: 'error', supersedesTurn: null, message: '目录候选需要修复。' })
  return failedRun
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

  it.each(['file_intake', 'docx_export'] as const)('程序阶段 %s 校验失败保存可序列化的失败终态', async (stage) => {
    const current = await session()
    current.append('bid.task.changed', { state: { stage, status: 'ready', run: null } })
    const issues = [{ code: 'INVALID_ARTIFACT', message: '阶段产物未通过校验。' }]
    const orchestrator = new BidOrchestrator(current,
      { canExecute: () => true, execute: async task => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues }) })

    await expect(orchestrator.runCurrentProgramStage()).resolves.toMatchObject({ stage, status: 'failed', run: null,
      failure: { code: 'BID_STAGE_VALIDATION_FAILED', issues } })
    const terminal = current.events.findLast(event => event.type === 'bid.task.changed')
    expect(terminal).toMatchObject({ type: 'bid.task.changed', data: { state: { stage, status: 'failed' } } })
  })

  it('finishes the linear workflow at S5 and leaves S6 for on-demand export', async () => {
    expect(BID_STAGES).toEqual(['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export'])
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).userGate)).toEqual(['none', 'after_validation', 'after_validation', 'after_validation', 'none', 'none'])

    const current = await session()
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute }, { validate: async () => ({ ok: true }) })
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user', run: null })
    await expect(orchestrator.confirmValidatedStage('tender_analysis', artifacts('tender_analysis'))).resolves.toEqual({ ok: true, state: { stage: 'outline_generation', status: 'waiting_user', run: null } })
    await expect(orchestrator.confirmValidatedStage('outline_generation', artifacts('outline_generation'))).resolves.toEqual({ ok: true, state: { stage: 'evidence_mapping', status: 'waiting_user', run: null } })
    await expect(orchestrator.confirmValidatedStage('evidence_mapping', artifacts('evidence_mapping'))).resolves.toEqual({ ok: true, state: { stage: 'chapter_writing', status: 'completed', run: null } })
    expect(current.events.some(event => event.type === 'bid.user_confirmation.required' && event.data.stage === 'chapter_writing')).toBe(false)
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
    )).resolves.toEqual({ stage: 'chapter_writing', status: 'ready', run: null })
  })

  it('非 S2 校验失败保留具体问题，使用阶段通用错误摘要', async () => {
    const current = await session()
    const issue = { code: 'CHAPTER_REVIEW_TEXT_INVALID', message: '覆盖记录文本必须匹配当前章节 canonical 条目。' }
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: () => true, execute: async task => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues: [issue] }) },
    )
    current.append('bid.project.resumed', { state: { stage: 'chapter_writing', status: 'waiting_user', run: null }, revision: 1 })
    current.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
    await expect(orchestrator.runConfirmedStage()).resolves.toMatchObject({ stage: 'chapter_writing', status: 'failed' })
    expect(orchestrator.state).toMatchObject({ status: 'failed', run: null,
      failure: { code: 'BID_STAGE_VALIDATION_FAILED', message: '当前阶段结果未通过校验。', issues: [issue] },
    })
  })

  it('校验失败在当前阶段保存具体产物问题', async () => {
    const current = await session()
    const orchestrator = new BidOrchestrator(
      current,
      { canExecute: stage => stage === 'tender_analysis', execute: async (task: BidStageTask) => artifacts(task.stage) },
      { validate: async () => ({ ok: false, issues: [{ code: 'INVALID_ARTIFACT', message: 'Artifact rejected.', artifact: 'analysis/scoring.json' }] }) },
    )
    current.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    current.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: artifacts('file_intake') })

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toMatchObject({ stage: 'tender_analysis', status: 'failed' })
    expect(orchestrator.state).toMatchObject({ status: 'failed', run: null,
      failure: { issues: [{ code: 'INVALID_ARTIFACT', artifact: 'analysis/scoring.json' }] } })
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

  it('同阶段恢复失败任务不切换模型上下文', async () => {
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
    expect(orchestrator.state.status).toBe('failed')
    const started = current.events.findLast(event => event.type === 'bid.run.started')
    if (started?.type !== 'bid.run.started') throw new Error('测试没有原 Run 记录')
    valid = true
    await expect(orchestrator.resume(started.data.run.runId)).resolves.toEqual({
      stage: 'tender_analysis', status: 'waiting_user', run: null,
    })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('从失败通知对应的原 Run 恢复同一 Work，校验通过后等待用户确认', async () => {
    const current = await session()
    const failedRun = recordFailedOutlineRun(current)
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const onAccepted = vi.fn()
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute },
      { validate: async () => ({ ok: true }) })

    expect(orchestrator.state.status).toBe('failed')
    await expect(orchestrator.resume(failedRun.runId, onAccepted)).resolves.toEqual({
      stage: 'outline_generation', status: 'waiting_user', run: null,
    })
    expect(execute).toHaveBeenCalledOnce()
    const resumed = execute.mock.calls[0]![1]
    expect(resumed.work).toEqual(failedRun.work)
    expect(resumed.resumeOf).toEqual({ runId: failedRun.runId, cause: 'executor_error' })
    expect(resumed.runId).not.toBe(failedRun.runId)
    expect(onAccepted).toHaveBeenCalledWith(resumed)
    expect(current.events.filter(event => event.type === 'bid.run.started').at(-1))
      .toMatchObject({ data: { run: { work: failedRun.work, resumeOf: { runId: failedRun.runId, cause: 'executor_error' } } } })
  })

  it.each(['wrong_run', 'unmatched_notice'] as const)('失败 Run 恢复拒绝 %s，不执行其他任务', async (kind) => {
    const current = await session()
    const failedRun = recordFailedOutlineRun(current, kind === 'wrong_run' ? undefined : 'other-run')
    const execute = vi.fn(async (task: BidStageTask, _run: BidRunContext) => artifacts(task.stage))
    const onAccepted = vi.fn()
    const orchestrator = new BidOrchestrator(current, { canExecute: () => true, execute },
      { validate: async () => ({ ok: true }) })

    expect(() => orchestrator.resume(kind === 'wrong_run' ? 'other-run' : failedRun.runId, onAccepted))
      .toThrow(expect.objectContaining({ code: 'BID_RESUME_NOT_ALLOWED' }))
    expect(orchestrator.state.status).toBe('failed')
    expect(execute).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
    expect(current.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
  })
})
