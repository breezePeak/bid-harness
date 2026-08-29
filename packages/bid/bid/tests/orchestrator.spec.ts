import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  BID_INITIAL_RUNTIME_STATE,
  BID_STAGES,
  BidOrchestrator,
  BidOrchestratorError,
  buildBidStageTask,
  getBidStagePolicy,
  reduceBidRuntimeState,
  type BidStage,
  type BidStageExecutorPort,
  type BidStageTask,
  type BidStageValidatorPort,
  type StageArtifact,
} from '@deepseek-ai/dsh-bid'

const artifactsFor = (task: BidStageTask): StageArtifact[] => task.requiredArtifacts.map(path => ({
  stage: task.stage,
  type: path,
  path,
}))

class RecordingExecutor implements BidStageExecutorPort {
  readonly tasks: BidStageTask[] = []

  constructor(private readonly run: (task: BidStageTask) => Promise<StageArtifact[]> = async task => artifactsFor(task)) {}

  async execute(task: BidStageTask): Promise<StageArtifact[]> {
    this.tasks.push(task)
    return this.run(task)
  }
}

class StageValidator implements BidStageValidatorPort {
  constructor(private readonly invalidStage?: BidStage) {}

  async validate(stage: BidStage): Promise<{ ok: true } | { ok: false; issues: { code: string; message: string }[] }> {
    return stage === this.invalidStage
      ? { ok: false, issues: [{ code: 'INVALID_STAGE_ARTIFACTS', message: `${stage} artifacts failed validation` }] }
      : { ok: true }
  }
}

const createSession = (id: string): Session => Session.create(SessionId(id))

describe('Bid runtime state and policies', () => {
  it('defines the only policy and deterministic task for every fixed stage', () => {
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).executor)).toEqual([
      'program',
      'agent',
      'agent',
      'agent',
      'user',
      'agent',
      'agent',
      'program',
    ])
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).nextStage)).toEqual([
      'tender_analysis',
      'evidence_mapping',
      'outline_generation',
      'outline_confirmation',
      'chapter_writing',
      'book_review',
      'docx_export',
      null,
    ])
    for (const stage of BID_STAGES) {
      const task = buildBidStageTask(stage)
      expect(task).toMatchObject({
        stage,
        inputs: getBidStagePolicy(stage).requiredInputs,
        requiredArtifacts: getBidStagePolicy(stage).requiredArtifacts,
        allowedTools: getBidStagePolicy(stage).allowedTools,
      })
    }
    const detached = getBidStagePolicy('tender_analysis')
    detached.requiredInputs.push('mutated')
    expect(getBidStagePolicy('tender_analysis').requiredInputs).not.toContain('mutated')
  })

  it('starts at file intake and returns the same state reference for non-Bid events and confirmations', () => {
    const state = BID_INITIAL_RUNTIME_STATE
    const unrelated = reduceBidRuntimeState(state, {
      type: 'turn/start',
      seq: 0,
      time: 0,
      data: { turn: 1 },
    })
    const decision = reduceBidRuntimeState(state, {
      type: 'bid.user_confirmation.received',
      seq: 1,
      time: 0,
      data: { stage: 'outline_confirmation', confirmed: true },
    })
    expect(state).toEqual({ stage: 'file_intake', status: 'pending' })
    expect(unrelated).toBe(state)
    expect(decision).toBe(state)
  })

  it('folds valid transitions and ignores events that jump to another stage', () => {
    const next = reduceBidRuntimeState(BID_INITIAL_RUNTIME_STATE, {
      type: 'bid.stage.completed',
      seq: 0,
      time: 0,
      data: { stage: 'file_intake', status: 'completed', artifacts: [] },
    })
    const illegal = reduceBidRuntimeState(next, {
      type: 'bid.stage.completed',
      seq: 1,
      time: 0,
      data: { stage: 'docx_export', status: 'completed', artifacts: [] },
    })
    expect(next).toEqual({ stage: 'tender_analysis', status: 'pending' })
    expect(illegal).toBe(next)

    const running = reduceBidRuntimeState(next, {
      type: 'bid.stage.started',
      seq: 2,
      time: 0,
      data: { stage: 'tender_analysis', status: 'running' },
    })
    expect(running).toEqual({ stage: 'tender_analysis', status: 'running' })
  })
})

describe('BidOrchestrator', () => {
  it('automatically executes successful stages until outline confirmation waits for the user', async () => {
    const session = createSession('bid-drive-success')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.drive()).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'waiting_user',
    })
    expect(executor.tasks.map(task => task.stage)).toEqual([
      'file_intake',
      'tender_analysis',
      'evidence_mapping',
      'outline_generation',
    ])
    expect(session.events.at(-1)).toMatchObject({
      type: 'bid.user_confirmation.required',
      data: { stage: 'outline_confirmation', status: 'waiting_user' },
    })
  })

  it('records validation rejection and remains failed on the current stage', async () => {
    const session = createSession('bid-validator-failure')
    const orchestrator = new BidOrchestrator(session, new RecordingExecutor(), new StageValidator('file_intake'))

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'file_intake', status: 'failed' })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(session.events.at(-1)?.data).toMatchObject({ reason: 'INVALID_STAGE_ARTIFACTS: file_intake artifacts failed validation' })
  })

  it('records an executor exception as failure', async () => {
    const session = createSession('bid-executor-failure')
    const executor = new RecordingExecutor(async () => { throw new Error('offline') })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'file_intake', status: 'failed' })
    expect(session.events.at(-1)).toMatchObject({
      type: 'bid.stage.failed',
      data: { stage: 'file_intake', reason: 'executor failed: Error: offline' },
    })
  })

  it('rejects retry outside failed state and retries the exact failed stage', async () => {
    const session = createSession('bid-retry')
    let attempts = 0
    const executor = new RecordingExecutor(async (task) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator('tender_analysis'))

    expect(() => orchestrator.retry()).toThrow(BidOrchestratorError)
    await orchestrator.drive()
    await expect(orchestrator.retry()).resolves.toEqual({ stage: 'tender_analysis', status: 'failed' })
    expect(executor.tasks.map(task => task.stage)).toEqual(['file_intake', 'file_intake', 'tender_analysis'])
  })

  it('keeps a rejected outline waiting and validates an accepted outline before continuing', async () => {
    const session = createSession('bid-confirm')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())
    await orchestrator.drive()

    await expect(orchestrator.confirm(false)).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'waiting_user',
    })
    expect(session.events.at(-1)).toMatchObject({
      type: 'bid.user_confirmation.received',
      data: { confirmed: false },
    })

    await expect(orchestrator.confirm(true)).resolves.toEqual({ stage: 'docx_export', status: 'completed' })
    const confirmationCompletion = session.events.find(event =>
      event.type === 'bid.stage.completed' && event.data.stage === 'outline_confirmation')
    expect(confirmationCompletion).toMatchObject({
      data: {
        artifacts: [{
          stage: 'outline_confirmation',
          type: 'outline_confirmation',
          path: 'outline/confirmation.json',
        }],
      },
    })
  })

  it('retries failed user validation by waiting for another decision without invoking an executor', async () => {
    const session = createSession('bid-confirm-retry')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator('outline_confirmation'))
    await orchestrator.drive()
    const taskCount = executor.tasks.length

    await expect(orchestrator.confirm(true)).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'failed',
    })
    await expect(orchestrator.retry()).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'waiting_user',
    })
    expect(executor.tasks).toHaveLength(taskCount)
    expect(session.events.at(-1)?.type).toBe('bid.user_confirmation.required')
  })

  it('replays state entirely from copied session events', async () => {
    const source = createSession('bid-replay-source')
    const orchestrator = new BidOrchestrator(source, new RecordingExecutor(), new StageValidator('evidence_mapping'))
    await orchestrator.drive()
    const replayed = Session.create(SessionId('bid-replayed'), source.events)
    const restored = new BidOrchestrator(replayed, new RecordingExecutor(), new StageValidator())
    expect(restored.state).toEqual(orchestrator.state)
  })

  it('coalesces concurrent drive calls before the executor can run twice', async () => {
    const session = createSession('bid-concurrent-drive')
    let release: (() => void) | undefined
    const firstExecution = new Promise<void>((resolve) => { release = resolve })
    const executor = new RecordingExecutor(async (task) => {
      if (task.stage === 'file_intake') await firstExecution
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    const first = orchestrator.drive()
    const second = orchestrator.drive()
    expect(second).toBe(first)
    release?.()
    await Promise.all([first, second])
    expect(executor.tasks.filter(task => task.stage === 'file_intake')).toHaveLength(1)
  })

  it('enforces confirm and prompt admission on the host', async () => {
    const session = createSession('bid-admission')
    const orchestrator = new BidOrchestrator(session, new RecordingExecutor(), new StageValidator())

    expect(() => orchestrator.confirm(true)).toThrow(BidOrchestratorError)
    expect(orchestrator.admitPrompt('analyze this')).toEqual({ admitted: false, reason: 'bid.upload_required' })
    expect(() => { orchestrator.admitAction('retry_stage') }).toThrow(BidOrchestratorError)

    session.append('bid.stage.completed', {
      stage: 'file_intake',
      status: 'completed',
      artifacts: [],
    })
    expect(orchestrator.admitPrompt('  ')).toEqual({ admitted: false, reason: 'bid.stage_pending' })
    expect(orchestrator.admitPrompt('Use the uploaded tender.')).toEqual({
      admitted: false,
      reason: 'bid.stage_pending',
    })
    expect(() => { orchestrator.admitAction('send_message') }).toThrow(BidOrchestratorError)
  })
})
