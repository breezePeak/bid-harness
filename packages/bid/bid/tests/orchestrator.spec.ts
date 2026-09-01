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

  constructor(
    private readonly run: (task: BidStageTask) => Promise<StageArtifact[]> = async task => artifactsFor(task),
    private readonly executableStages: readonly BidStage[] = BID_STAGES,
  ) {}

  canExecute(stage: BidStage): boolean {
    return this.executableStages.includes(stage)
  }

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
const confirmTenderAnalysis = (orchestrator: BidOrchestrator) => orchestrator.confirmValidatedStage(
  'tender_analysis',
  artifactsFor(buildBidStageTask('tender_analysis')),
)

describe('Bid runtime state and policies', () => {
  it('defines the only policy and deterministic task for every fixed stage', () => {
    expect(BID_STAGES.map(stage => getBidStagePolicy(stage).executor)).toEqual([
      'program',
      'agent',
      'agent',
      'agent',
      'user',
      'agent',
      'program',
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
    expect(getBidStagePolicy('file_intake').requiredArtifacts).toEqual(['manifest.json'])
    expect(getBidStagePolicy('tender_analysis').requiredInputs).toEqual(['manifest.json'])
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

  it('starts at file intake and ignores unrelated or out-of-state confirmation events', () => {
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

  it('regenerates after outline feedback and requires acceptance before completion can advance', () => {
    const outlinePending = { stage: 'outline_confirmation', status: 'pending' } as const
    const forgedStart = reduceBidRuntimeState(outlinePending, {
      type: 'bid.stage.started',
      seq: 0,
      time: 0,
      data: { stage: 'outline_confirmation', status: 'running' },
    })
    const waiting = reduceBidRuntimeState(outlinePending, {
      type: 'bid.user_confirmation.required',
      seq: 1,
      time: 0,
      data: { stage: 'outline_confirmation', status: 'waiting_user' },
    })
    const rejected = reduceBidRuntimeState(waiting, {
      type: 'bid.user_confirmation.received',
      seq: 2,
      time: 0,
      data: { stage: 'outline_confirmation', confirmed: false, feedback: '拆细实施章节' },
    })
    const premature = reduceBidRuntimeState(rejected, {
      type: 'bid.stage.completed',
      seq: 3,
      time: 0,
      data: { stage: 'outline_confirmation', status: 'completed', artifacts: [] },
    })
    const forgedFailure = reduceBidRuntimeState(waiting, {
      type: 'bid.stage.failed',
      seq: 4,
      time: 0,
      data: { stage: 'outline_confirmation', status: 'failed', reason: 'forged' },
    })
    const accepted = reduceBidRuntimeState(waiting, {
      type: 'bid.user_confirmation.received',
      seq: 5,
      time: 0,
      data: { stage: 'outline_confirmation', confirmed: true },
    })
    const advanced = reduceBidRuntimeState(accepted, {
      type: 'bid.stage.completed',
      seq: 6,
      time: 0,
      data: { stage: 'outline_confirmation', status: 'completed', artifacts: [] },
    })

    expect(forgedStart).toBe(outlinePending)
    expect(rejected).toEqual({ stage: 'outline_generation', status: 'pending' })
    expect(premature).toBe(rejected)
    expect(forgedFailure).toBe(waiting)
    expect(accepted).toEqual({ stage: 'outline_confirmation', status: 'running' })
    expect(advanced).toEqual({ stage: 'chapter_writing', status: 'pending' })
  })

  it('folds valid transitions and ignores completion events from an illegal stage or status', () => {
    const premature = reduceBidRuntimeState(BID_INITIAL_RUNTIME_STATE, {
      type: 'bid.stage.completed',
      seq: 0,
      time: 0,
      data: { stage: 'file_intake', status: 'completed', artifacts: [] },
    })
    expect(premature).toBe(BID_INITIAL_RUNTIME_STATE)

    const running = reduceBidRuntimeState(BID_INITIAL_RUNTIME_STATE, {
      type: 'bid.stage.started',
      seq: 1,
      time: 0,
      data: { stage: 'file_intake', status: 'running' },
    })
    const failed = reduceBidRuntimeState(running, {
      type: 'bid.stage.failed',
      seq: 2,
      time: 0,
      data: { stage: 'file_intake', status: 'failed', reason: 'parser unavailable' },
    })
    const restarted = reduceBidRuntimeState(failed, {
      type: 'bid.stage.started',
      seq: 3,
      time: 0,
      data: { stage: 'file_intake', status: 'running' },
    })
    const next = reduceBidRuntimeState({ ...running, failureReason: 'stale' }, {
      type: 'bid.stage.completed',
      seq: 4,
      time: 0,
      data: { stage: 'file_intake', status: 'completed', artifacts: [] },
    })
    const illegal = reduceBidRuntimeState(next, {
      type: 'bid.stage.completed',
      seq: 5,
      time: 0,
      data: { stage: 'docx_export', status: 'completed', artifacts: [] },
    })
    expect(failed).toEqual({ stage: 'file_intake', status: 'failed', failureReason: 'parser unavailable' })
    expect(restarted).toEqual({ stage: 'file_intake', status: 'running' })
    expect(next).toEqual({ stage: 'tender_analysis', status: 'pending' })
    expect(illegal).toBe(next)

    const tenderRunning = reduceBidRuntimeState(next, {
      type: 'bid.stage.started',
      seq: 6,
      time: 0,
      data: { stage: 'tender_analysis', status: 'running' },
    })
    expect(tenderRunning).toEqual({ stage: 'tender_analysis', status: 'running' })
  })
})

describe('BidOrchestrator', () => {
  it('waits for explicit completion after validating the deterministic book review', async () => {
    const session = createSession('bid-book-review-gate')
    for (const stage of ['file_intake', 'tender_analysis', 'evidence_mapping', 'outline_generation'] as const) {
      session.append('bid.stage.started', { stage, status: 'running' })
      if (stage === 'tender_analysis') session.append('bid.user_confirmation.required', { stage, status: 'waiting_user' })
      if (stage === 'tender_analysis') session.append('bid.user_confirmation.received', { stage, confirmed: true })
      session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    session.append('bid.user_confirmation.required', { stage: 'outline_confirmation', status: 'waiting_user' })
    session.append('bid.user_confirmation.received', { stage: 'outline_confirmation', confirmed: true })
    session.append('bid.stage.completed', { stage: 'outline_confirmation', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    session.append('bid.stage.completed', { stage: 'chapter_writing', status: 'completed', artifacts: [] })
    const executor = new RecordingExecutor(undefined, ['book_review'])
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'book_review', status: 'waiting_user' })
    expect(session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'book_review')).toBe(false)
    await expect(orchestrator.confirmValidatedStage('book_review', artifactsFor(buildBidStageTask('book_review')))).resolves.toMatchObject({
      ok: true,
      state: { stage: 'docx_export', status: 'pending' },
    })
  })

  it('waits for external input instead of driving a fresh file-intake stage', async () => {
    const session = createSession('bid-drive-waits-for-files')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.drive()).resolves.toEqual({ stage: 'file_intake', status: 'pending' })
    expect(executor.tasks).toHaveLength(0)
    expect(session.events).toHaveLength(0)
  })

  it('runs the current program stage once and stops at its pending successor', async () => {
    const session = createSession('bid-run-program-stage')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.runCurrentProgramStage()).resolves.toEqual({
      stage: 'tender_analysis',
      status: 'pending',
    })
    expect(executor.tasks.map(task => task.stage)).toEqual(['file_intake'])
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.completed'])
    expect(() => orchestrator.runCurrentProgramStage()).toThrow(
      expect.objectContaining({ code: 'BID_PROGRAM_STAGE_NOT_ALLOWED' }),
    )
  })

  it('runs tender analysis once and stops for user confirmation before evidence mapping', async () => {
    const session = createSession('bid-run-tender-analysis')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await orchestrator.runCurrentProgramStage()
    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis',
      status: 'waiting_user',
    })
    expect(executor.tasks.map(task => task.stage)).toEqual(['file_intake', 'tender_analysis'])
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed', 'bid.stage.started', 'bid.user_confirmation.required',
    ])
    expect(session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'tender_analysis')).toBe(false)
    expect(executor.tasks.some(task => task.stage === 'evidence_mapping')).toBe(false)
  })

  it('retries only failed tender analysis and stops before evidence mapping execution', async () => {
    const session = createSession('bid-retry-single-stage')
    let tenderAttempts = 0
    const executor = new RecordingExecutor(async (task) => {
      if (task.stage === 'tender_analysis' && tenderAttempts++ === 0) throw new Error('invalid artifacts')
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await orchestrator.runCurrentProgramStage()
    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis', status: 'failed', failureReason: 'executor failed: Error: invalid artifacts',
    })
    await expect(orchestrator.retryCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis', status: 'waiting_user',
    })

    expect(executor.tasks.map(task => task.stage)).toEqual([
      'file_intake', 'tender_analysis', 'tender_analysis',
    ])
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
      'bid.stage.started', 'bid.user_confirmation.required',
    ])
    expect(() => orchestrator.retryCurrentAutomaticStage()).toThrow(
      expect.objectContaining({ code: 'BID_RETRY_NOT_ALLOWED' }),
    )
  })

  it('persists structured tender-analysis issues and clears them when retry starts', async () => {
    const session = createSession('bid-tender-validation-issues')
    let tenderValidationAttempts = 0
    const validator: BidStageValidatorPort = {
      validate: async stage => stage === 'tender_analysis' && tenderValidationAttempts++ === 0
        ? { ok: false, issues: [{
          code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
          artifact: 'analysis/scoring.json',
          path: 'scoring_items[2].response_points',
          message: '至少需要一项技术响应重点。',
        }] }
        : { ok: true },
    }
    const orchestrator = new BidOrchestrator(session, new RecordingExecutor(), validator)

    await orchestrator.runCurrentProgramStage()
    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis',
      status: 'failed',
      failureReason: '招标分析结果未通过校验。',
      failureIssues: [{
        code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
        artifact: 'analysis/scoring.json',
        path: 'scoring_items[2].response_points',
        message: '至少需要一项技术响应重点。',
      }],
    })
    expect(session.events.at(-1)).toMatchObject({
      type: 'bid.stage.failed',
      data: { issues: [{ artifact: 'analysis/scoring.json', path: 'scoring_items[2].response_points' }] },
    })

    const retry = orchestrator.retryCurrentAutomaticStage()
    expect(reduceBidRuntimeState(orchestrator.state, {
      type: 'bid.stage.started', seq: 99, time: 0, data: { stage: 'tender_analysis', status: 'running' },
    })).not.toHaveProperty('failureIssues')
    await expect(retry).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
  })

  it('keeps tender analysis failed when its single retry fails again', async () => {
    const session = createSession('bid-retry-single-stage-failed')
    const executor = new RecordingExecutor(async (task) => {
      if (task.stage === 'tender_analysis') throw new Error('still invalid')
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await orchestrator.runCurrentProgramStage()
    await orchestrator.runCurrentAutomaticStage()
    await expect(orchestrator.retryCurrentAutomaticStage()).resolves.toEqual({
      stage: 'tender_analysis', status: 'failed', failureReason: 'executor failed: Error: still invalid',
    })
    expect(executor.tasks.map(task => task.stage)).toEqual([
      'file_intake', 'tender_analysis', 'tender_analysis',
    ])
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
      'bid.stage.started', 'bid.stage.failed',
    ])
  })

  it('automatically executes successful stages until outline confirmation waits for the user', async () => {
    const session = createSession('bid-drive-success')
    const executor = new RecordingExecutor(undefined, [
      'tender_analysis',
      'evidence_mapping',
      'outline_generation',
    ])
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.runCurrentProgramStage()).resolves.toEqual({
      stage: 'tender_analysis',
      status: 'pending',
    })
    await expect(orchestrator.drive()).resolves.toEqual({
      stage: 'tender_analysis',
      status: 'waiting_user',
    })
    await expect(confirmTenderAnalysis(orchestrator)).resolves.toMatchObject({
      ok: true,
      state: {
        stage: 'outline_confirmation',
        status: 'waiting_user',
      },
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

    await expect(orchestrator.runCurrentProgramStage()).resolves.toEqual({
      stage: 'file_intake', status: 'failed', failureReason: 'INVALID_STAGE_ARTIFACTS: file_intake artifacts failed validation',
      failureIssues: [{ code: 'INVALID_STAGE_ARTIFACTS', message: 'file_intake artifacts failed validation' }],
    })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(session.events.at(-1)?.data).toMatchObject({ reason: 'INVALID_STAGE_ARTIFACTS: file_intake artifacts failed validation' })
  })

  it('records an executor exception as failure', async () => {
    const session = createSession('bid-executor-failure')
    const executor = new RecordingExecutor(async () => { throw new Error('offline') })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.runCurrentProgramStage()).resolves.toEqual({
      stage: 'file_intake', status: 'failed', failureReason: 'executor failed: Error: offline',
    })
    expect(session.events.at(-1)).toMatchObject({
      type: 'bid.stage.failed',
      data: { stage: 'file_intake', reason: 'executor failed: Error: offline' },
    })
  })

  it('rejects retry outside failed state and retries the exact failed stage', async () => {
    const session = createSession('bid-retry')
    let tenderAttempts = 0
    const executor = new RecordingExecutor(async (task) => {
      if (task.stage === 'tender_analysis' && tenderAttempts++ === 0) throw new Error('transient')
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator('evidence_mapping'))

    expect(() => orchestrator.retry()).toThrow(BidOrchestratorError)
    await orchestrator.runCurrentProgramStage()
    await orchestrator.drive()
    await expect(orchestrator.retry()).resolves.toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    await expect(confirmTenderAnalysis(orchestrator)).resolves.toMatchObject({ ok: true, state: {
      stage: 'evidence_mapping',
      status: 'failed',
      failureReason: 'INVALID_STAGE_ARTIFACTS: evidence_mapping artifacts failed validation',
    } })
    expect(executor.tasks.map(task => task.stage)).toEqual([
      'file_intake', 'tender_analysis', 'tender_analysis', 'evidence_mapping',
    ])
  })

  it('restarts failed file intake only through a new program-stage execution', async () => {
    const session = createSession('bid-file-intake-reupload')
    let attempts = 0
    const executor = new RecordingExecutor(async (task) => {
      if (attempts++ === 0) throw new Error('invalid batch')
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.runCurrentProgramStage()).resolves.toMatchObject({
      stage: 'file_intake', status: 'failed', failureReason: 'executor failed: Error: invalid batch',
    })
    expect(() => orchestrator.retry()).toThrow(BidOrchestratorError)
    await expect(orchestrator.runCurrentProgramStage()).resolves.toEqual({
      stage: 'tender_analysis', status: 'pending',
    })
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.failed', 'bid.stage.started', 'bid.stage.completed',
    ])
  })

  it('regenerates a rejected outline from durable feedback before accepting it', async () => {
    const session = createSession('bid-confirm')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())
    await orchestrator.runCurrentProgramStage()
    await orchestrator.drive()
    await confirmTenderAnalysis(orchestrator)

    await expect(orchestrator.reviseOutline('  拆细实施章节  ')).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'waiting_user',
    })
    expect(session.events.find(event => event.type === 'bid.user_confirmation.received' && !event.data.confirmed)).toMatchObject({
      type: 'bid.user_confirmation.received',
      data: { confirmed: false, feedback: '拆细实施章节' },
    })
    expect(executor.tasks.filter(task => task.stage === 'outline_generation')).toHaveLength(2)

    await expect(orchestrator.confirm()).resolves.toEqual({ stage: 'book_review', status: 'waiting_user' })
    const confirmationCompletion = session.events.find(event =>
      event.type === 'bid.stage.completed' && event.data.stage === 'outline_confirmation')
    expect(confirmationCompletion).toMatchObject({
      data: {
        artifacts: [
          { stage: 'outline_confirmation', type: 'confirmed_outline', path: 'outline/confirmed-outline.json' },
          { stage: 'outline_confirmation', type: 'outline_confirmation', path: 'outline/confirmation.json' },
        ],
      },
    })
  })

  it('retries failed user validation by waiting for another decision without invoking an executor', async () => {
    const session = createSession('bid-confirm-retry')
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator('outline_confirmation'))
    await orchestrator.runCurrentProgramStage()
    await orchestrator.drive()
    await confirmTenderAnalysis(orchestrator)
    const taskCount = executor.tasks.length

    await expect(orchestrator.confirm()).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'failed',
      failureReason: 'INVALID_STAGE_ARTIFACTS: outline_confirmation artifacts failed validation',
      failureIssues: [{ code: 'INVALID_STAGE_ARTIFACTS', message: 'outline_confirmation artifacts failed validation' }],
    })
    await expect(orchestrator.retry()).resolves.toEqual({
      stage: 'outline_confirmation',
      status: 'waiting_user',
    })
    expect(executor.tasks).toHaveLength(taskCount)
    expect(session.events.at(-1)?.type).toBe('bid.user_confirmation.required')
  })

  it('retries a failed after-validation stage back to user confirmation', async () => {
    const session = createSession('bid-review-retry')
    for (const stage of ['file_intake', 'tender_analysis', 'evidence_mapping', 'outline_generation'] as const) {
      session.append('bid.stage.started', { stage, status: 'running' })
      if (stage === 'tender_analysis') session.append('bid.user_confirmation.required', { stage, status: 'waiting_user' })
      if (stage === 'tender_analysis') session.append('bid.user_confirmation.received', { stage, confirmed: true })
      session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    session.append('bid.user_confirmation.required', { stage: 'outline_confirmation', status: 'waiting_user' })
    session.append('bid.user_confirmation.received', { stage: 'outline_confirmation', confirmed: true })
    session.append('bid.stage.completed', { stage: 'outline_confirmation', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    session.append('bid.stage.completed', { stage: 'chapter_writing', status: 'completed', artifacts: [] })
    session.append('bid.stage.started', { stage: 'book_review', status: 'running' })
    session.append('bid.stage.failed', { stage: 'book_review', status: 'failed', reason: 'report unavailable' })
    const executor = new RecordingExecutor()
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await expect(orchestrator.retry()).resolves.toEqual({ stage: 'book_review', status: 'waiting_user' })
    expect(executor.tasks.map(task => task.stage)).toEqual(['book_review'])
    expect(session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'book_review')).toBe(false)
  })

  it('replays state entirely from copied session events', async () => {
    const source = createSession('bid-replay-source')
    const orchestrator = new BidOrchestrator(source, new RecordingExecutor(), new StageValidator('evidence_mapping'))
    await orchestrator.runCurrentProgramStage()
    await orchestrator.drive()
    const replayed = Session.create(SessionId('bid-replayed'), source.events)
    const restored = new BidOrchestrator(replayed, new RecordingExecutor(), new StageValidator())
    expect(restored.state).toEqual(orchestrator.state)
  })

  it('continues a restored executable stage without depending on its name', async () => {
    const source = createSession('bid-restored-executable-source')
    const initial = new BidOrchestrator(source, new RecordingExecutor(undefined, ['tender_analysis']), new StageValidator())
    await initial.runCurrentProgramStage()
    await initial.runCurrentAutomaticStage()
    await confirmTenderAnalysis(initial)
    const replayed = Session.create(SessionId('bid-restored-executable'), source.events)
    const executor = new RecordingExecutor(undefined, ['evidence_mapping'])
    const restored = new BidOrchestrator(replayed, executor, new StageValidator())

    await expect(restored.drive()).resolves.toEqual({ stage: 'outline_generation', status: 'pending' })
    expect(executor.tasks.map(task => task.stage)).toEqual(['evidence_mapping'])
  })

  it('coalesces concurrent drive calls before the executor can run twice', async () => {
    const session = createSession('bid-concurrent-drive')
    let release: (() => void) | undefined
    const firstExecution = new Promise<void>((resolve) => { release = resolve })
    const executor = new RecordingExecutor(async (task) => {
      if (task.stage === 'tender_analysis') await firstExecution
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    await orchestrator.runCurrentProgramStage()
    const first = orchestrator.drive()
    const second = orchestrator.drive()
    expect(second).toBe(first)
    release?.()
    await Promise.all([first, second])
    expect(executor.tasks.filter(task => task.stage === 'tender_analysis')).toHaveLength(1)
  })

  it('rejects a concurrent program-stage execution instead of sharing it', async () => {
    const session = createSession('bid-concurrent-program')
    let release: (() => void) | undefined
    const firstExecution = new Promise<void>((resolve) => { release = resolve })
    const executor = new RecordingExecutor(async (task) => {
      await firstExecution
      return artifactsFor(task)
    })
    const orchestrator = new BidOrchestrator(session, executor, new StageValidator())

    const first = orchestrator.runCurrentProgramStage()
    expect(() => orchestrator.runCurrentProgramStage()).toThrow(
      expect.objectContaining({ code: 'BID_OPERATION_IN_PROGRESS' }),
    )
    release?.()
    await first
    expect(executor.tasks).toHaveLength(1)
  })

  it('enforces confirm and prompt admission on the host', async () => {
    const session = createSession('bid-admission')
    const orchestrator = new BidOrchestrator(session, new RecordingExecutor(), new StageValidator())

    expect(() => orchestrator.confirm()).toThrow(BidOrchestratorError)
    expect(() => orchestrator.reviseOutline('')).toThrow(BidOrchestratorError)
    expect(orchestrator.admitPrompt('analyze this')).toEqual({ admitted: false, reason: 'bid.upload_required' })
    expect(() => { orchestrator.admitAction('retry_stage') }).toThrow(BidOrchestratorError)

    session.append('bid.stage.started', {
      stage: 'file_intake',
      status: 'running',
    })
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
