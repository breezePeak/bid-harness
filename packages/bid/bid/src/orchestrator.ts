import type { Session } from '@deepseek-ai/dsh-session'
import type {
  BidClientAction,
  BidControlState,
  BidPromptAdmission,
  BidRuntimeState,
  BidStage,
  BidStageTask,
  StageArtifact,
  StageValidationResult,
  StageValidationIssue,
} from './control-plane-contract.ts'
import { BidStageAttentionRequiredError, BidStageExecutionError } from './control-plane-contract.ts'
import {
  BID_INITIAL_CONTROL_STATE,
  bidRuntimeView,
  buildBidStageTask,
  getBidClientProjection,
  getBidStagePolicy,
  reduceBidControlState,
} from './runtime-state.ts'
import { BidRunCoordinator, DirectBidRunScheduler, type BidRunContext } from './run-coordinator.ts'

/** Executor port used by program and agent stages. */
export interface BidStageExecutorPort {
  /**
   * Report whether this executor implements one automatic stage.
   * @param stage - stage considered for automatic execution.
   * @returns whether {@link execute} can execute the stage.
   */
  canExecute(stage: BidStage): boolean

  /**
   * Execute one host-created stage assignment.
   * @param task - immutable-in-intent assignment derived from the stage policy.
   * @returns workspace artifact references produced by the executor.
   */
  execute(task: BidStageTask, run: BidRunContext): Promise<StageArtifact[]>
}

/** Validator port that authorizes stage completion from produced artifacts. */
export interface BidStageValidatorPort {
  /**
   * Validate one stage's complete artifact set.
   * @param stage - stage requesting completion.
   * @param artifacts - workspace references returned by the executor.
   * @returns whether the stage may complete, with actionable issues on rejection.
   */
  validate(stage: BidStage, artifacts: StageArtifact[]): Promise<StageValidationResult>
}

/** Prepare the model-context commit applied after a successful stage completion event. */
export type BidStageContextTransition = (fromStage: BidStage, toStage: BidStage) => Promise<() => void>

/** Result of validating and recording one explicit user-confirmed stage. */
export type BidStageConfirmationResult =
  | { readonly ok: true; readonly state: BidRuntimeState }
  | { readonly ok: false; readonly validation: StageValidationResult & { readonly ok: false } }

/** Durable outcome of one executor and validator attempt. */
export type StageExecutionSettlement = 'completed' | 'waiting_user' | 'attention_required' | 'failed' | 'aborted'

/** Stable rejection codes for host-side Bid operation admission. */
export type BidOrchestratorErrorCode =
  | 'BID_ACTION_NOT_ALLOWED'
  | 'BID_CONFIRM_NOT_ALLOWED'
  | 'BID_OUTLINE_FEEDBACK_REQUIRED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_AUTOMATIC_STAGE_NOT_ALLOWED'
  | 'BID_PROGRAM_STAGE_NOT_ALLOWED'
  | 'BID_RESUME_NOT_ALLOWED'
  | 'BID_STAGE_START_NOT_ALLOWED'
  | 'BID_STAGE_RESET_NOT_ALLOWED'

/** Host-side rejection for an operation that is invalid in current session state. */
export class BidOrchestratorError extends Error {
  /**
   * Create one stable admission rejection.
   * @param code - machine-readable rejection code.
   * @param message - operator-facing failure detail.
   */
  constructor(public readonly code: BidOrchestratorErrorCode, message: string) {
    super(message)
    this.name = 'BidOrchestratorError'
  }
}

/** Session-scoped Bid state driver over the shared DSH session event log. */
export class BidOrchestrator {
  private operation: Promise<BidRuntimeState> | undefined
  private readonly runs: BidRunCoordinator

  /**
   * Create a driver for one exact live or replayed session.
   * @param session - session whose log owns all Bid state.
   * @param executor - program and agent execution adapter.
   * @param validator - artifact validation adapter.
   * @param signal - optional operation cancellation.
   * @param prepareContextTransition - optional Host callback that prepares the successor handoff before completion commits.
   */
  constructor(
    private readonly session: Session,
    private readonly executor: BidStageExecutorPort,
    private readonly validator: BidStageValidatorPort,
    private readonly signal?: AbortSignal,
    private readonly prepareContextTransition?: BidStageContextTransition,
    runs?: BidRunCoordinator,
  ) {
    this.runs = runs ?? new BidRunCoordinator(
      session,
      new DirectBidRunScheduler(),
      { drain: () => Promise.resolve() },
      () => 0,
      signal,
    )
  }

  /** Split Workflow and Run state replayed from the Session log. */
  get controlState(): BidControlState {
    return this.session.events.reduce(reduceBidControlState, BID_INITIAL_CONTROL_STATE)
  }

  /** Current state replayed from the session log. */
  get state(): BidRuntimeState {
    return bidRuntimeView(this.controlState)
  }

  /** Read cancellation without retaining a stale narrowing across an await. */
  private isAborted(): boolean {
    return this.signal?.aborted === true
  }

  /**
   * Drive pending stages after file intake until user input, failure, or final completion. Concurrent callers share the same drive.
   * A fresh file-intake stage waits for {@link runCurrentProgramStage} because its executor requires user files. A running state
   * without this instance's operation is a replayed interruption; the driver records failure so the Host can offer a full retry.
   * @returns the state at the stopping point.
   */
  drive(): Promise<BidRuntimeState> {
    if (this.operation !== undefined) return this.operation
    return this.begin(() => {
      const state = this.state
      if (state.status === 'running') return Promise.resolve(this.state)
      return this.driveLoop()
    })
  }

  /** Reconcile a suspended attempt through the stage Executor's durable checkpoints, then continue unfinished work. */
  resume(suspendedRunId: string): Promise<BidRuntimeState> {
    this.assertIdle()
    const control = this.controlState
    const suspended = control.run
    if (suspended?.status !== 'suspended' || suspended.runId !== suspendedRunId || suspended.stage !== control.workflow.stage) {
      throw new BidOrchestratorError('BID_RESUME_NOT_ALLOWED', 'the requested suspended Bid Run is no longer current')
    }
    return this.begin(async () => {
      const settlement = await this.executeStage(suspended.stage)
      return settlement === 'completed' ? this.driveLoop() : this.state
    })
  }

  /**
   * Start the stage selected by a completed reset and continue to its normal stopping point.
   * @returns the state at validation, failure, or workflow completion.
   * @throws {@link BidOrchestratorError} unless the current stage is waiting for this explicit start.
   */
  startResetStage(): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    if (state.status !== 'waiting_start' || state.stage === 'file_intake') {
      throw new BidOrchestratorError(
        'BID_STAGE_START_NOT_ALLOWED',
        `cannot start Bid stage ${JSON.stringify(state.stage)} while status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      if (getBidStagePolicy(state.stage).userGate === 'before_execution') {
        this.session.append('bid.user_confirmation.required', { stage: state.stage, status: 'waiting_user' })
        return this.state
      }
      const settlement = await this.executeStage(state.stage)
      return settlement === 'completed' ? this.driveLoop() : this.state
    })
  }

  /**
   * Execute the current program-owned stage once without driving its successor.
   * @returns the log-derived state after the stage records completion or failure.
   * @throws {@link BidOrchestratorError} unless the current stage is an idle pending or failed program stage.
   */
  runCurrentProgramStage(): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    const policy = getBidStagePolicy(state.stage)
    if (policy.executor !== 'program' || (state.status !== 'pending' && state.status !== 'failed')) {
      throw new BidOrchestratorError(
        'BID_PROGRAM_STAGE_NOT_ALLOWED',
        `cannot run Bid program stage ${JSON.stringify(state.stage)} while status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      await this.executeStage(state.stage)
      return this.state
    })
  }

  /**
   * Execute the current pending automatic stage once and stop at its successor.
   * @returns the state after one executor and Validator settlement.
   * @throws {@link BidOrchestratorError} unless an idle non-user, non-file-intake stage is pending.
   */
  runCurrentAutomaticStage(): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    const policy = getBidStagePolicy(state.stage)
    if (state.status !== 'pending' || state.stage === 'file_intake' || policy.userGate === 'before_execution') {
      throw new BidOrchestratorError(
        'BID_AUTOMATIC_STAGE_NOT_ALLOWED',
        `cannot run Bid automatic stage ${JSON.stringify(state.stage)} while status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      await this.executeStage(state.stage)
      return this.state
    })
  }

  /**
   * Execute a pending before-execution stage after its Host-owned plan has been confirmed.
   * @returns State after the confirmed stage settles.
   */
  runConfirmedStage(): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    if (state.status !== 'pending' || getBidStagePolicy(state.stage).userGate !== 'before_execution') {
      throw new BidOrchestratorError(
        'BID_AUTOMATIC_STAGE_NOT_ALLOWED',
        `cannot run confirmed Bid stage ${JSON.stringify(state.stage)} while status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      const settlement = await this.executeStage(state.stage)
      return settlement === 'completed' ? this.driveLoop() : this.state
    })
  }

  /**
   * Revalidate canonical artifacts and complete a stage that is waiting after successful automatic validation.
   * Validation rejection leaves the replayed stage in `waiting_user` so the caller can return issues for another edit.
   * @param stage - waiting stage whose policy requires post-validation confirmation.
   * @param artifacts - canonical artifact references reread by the stage validator.
   * @returns the continued runtime state, or validation issues without a state transition.
   */
  confirmValidatedStage(stage: BidStage, artifacts: StageArtifact[]): Promise<BidStageConfirmationResult> {
    this.assertIdle()
    const state = this.state
    const policy = getBidStagePolicy(stage)
    if (state.stage !== stage || state.status !== 'waiting_user'
      || policy.userGate !== 'after_validation') {
      throw new BidOrchestratorError(
        'BID_CONFIRM_NOT_ALLOWED',
        `cannot confirm Bid stage ${JSON.stringify(stage)} while stage is ${JSON.stringify(state.stage)} and status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.beginConfirmation(async () => {
      let validation: StageValidationResult
      try {
        validation = await this.validator.validate(stage, artifacts)
      } catch (error: unknown) {
        validation = { ok: false, issues: [{ code: 'VALIDATOR_FAILED', message: String(error) }] }
      }
      if (!validation.ok) return { ok: false, validation }
      const commitContext = await this.prepareStageContextTransition(stage)
      this.session.append('bid.user_confirmation.received', { stage, confirmed: true })
      this.session.append('bid.stage.completed', { stage, status: 'completed', artifacts })
      commitContext()
      return { ok: true, state: await this.driveLoop() }
    })
  }

  /**
   * Enforce one client business action against current host state.
   * @param action - requested client action.
   * @throws {@link BidOrchestratorError} when the action is not currently admitted.
   */
  admitAction(action: BidClientAction): void {
    if (getBidClientProjection(this.state).allowedActions.includes(action)) return
    throw new BidOrchestratorError(
      'BID_ACTION_NOT_ALLOWED',
      `Bid action ${JSON.stringify(action)} is not allowed for the current stage state`,
    )
  }

  /**
   * Admit an ordinary composer message only for a pending agent stage.
   * @param input - untrusted client text.
   * @returns an accepted stage input or a stable host rejection reason.
   */
  admitPrompt(input: string): BidPromptAdmission {
    const projection = getBidClientProjection(this.state)
    if (!projection.allowedActions.includes('send_message')) {
      return {
        admitted: false,
        reason: projection.composer.enabled ? 'bid.stage_pending' : projection.composer.reason,
      }
    }
    if (input.trim().length === 0) return { admitted: false, reason: 'bid.prompt_empty' }
    return { admitted: true, stage: projection.runtime.stage, input }
  }

  /** Install one operation before its first async step, then release the slot after settlement. */
  private begin(run: () => Promise<BidRuntimeState>): Promise<BidRuntimeState> {
    const operation = Promise.resolve().then(run)
    this.operation = operation
    void operation.then(
      () => { if (this.operation === operation) this.operation = undefined },
      () => { if (this.operation === operation) this.operation = undefined },
    )
    return operation
  }

  /** Install a confirmation operation that may return validation issues instead of a runtime state. */
  private beginConfirmation(run: () => Promise<BidStageConfirmationResult>): Promise<BidStageConfirmationResult> {
    const operation = Promise.resolve().then(run)
    const stateOperation = operation.then(result => result.ok ? result.state : this.state)
    this.operation = stateOperation
    return operation.finally(() => {
      if (this.operation === stateOperation) this.operation = undefined
    })
  }

  /** Reject a second mutating command while another command owns the session driver. */
  private assertIdle(): void {
    if (this.operation === undefined) return
    throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', 'a Bid orchestrator operation is already in progress')
  }

  /** Continue the automatic control loop from the current log-derived state. */
  private async driveLoop(): Promise<BidRuntimeState> {
    while (true) {
      if (this.isAborted()) return this.state
      const state = this.state
      if (state.status !== 'pending') return state
      if (state.stage === 'file_intake') return state
      const policy = getBidStagePolicy(state.stage)
      if (policy.userGate === 'before_execution') {
        this.session.append('bid.user_confirmation.required', {
          stage: state.stage,
          status: 'waiting_user',
        })
        return this.state
      }
      if (!this.executor.canExecute(state.stage)) return state
      if (await this.executeStage(state.stage) !== 'completed') return this.state
    }
  }

  /** Execute and validate one non-user stage, recording its complete outcome. */
  private async executeStage(stage: BidStage): Promise<StageExecutionSettlement> {
    if (this.isAborted()) return 'aborted'
    const run = this.runs.start(stage)
    let artifacts: StageArtifact[]
    try {
      artifacts = await this.executor.execute(buildBidStageTask(stage), run)
    } catch (error: unknown) {
      if (this.isAborted()) {
        await this.runs.suspend('user_stop')
        return 'aborted'
      }
      if (error instanceof BidStageAttentionRequiredError) {
        this.runs.complete(run)
        this.attentionRequired(stage, error.message, [...error.issues])
        return 'attention_required'
      }
      if (error instanceof BidStageExecutionError) {
        await this.runs.suspend('retry_exhausted', { message: error.message, issues: [...error.issues] })
        return 'failed'
      }
      await this.runs.suspend('executor_error', { message: `executor failed: ${String(error)}` })
      return 'failed'
    }
    if (this.isAborted()) { await this.runs.suspend('user_stop'); return 'aborted' }
    const validation = await this.validate(stage, artifacts)
    if (this.isAborted()) { await this.runs.suspend('user_stop'); return 'aborted' }
    if (!validation.ok) {
      await this.runs.suspend('retry_exhausted', {
        message: stage === 'tender_analysis' ? '招标分析结果未通过校验。' : validation.issues.map(formatStageValidationIssue).join('; '),
        issues: validation.issues,
      })
      return 'failed'
    }
    if (getBidStagePolicy(stage).userGate === 'after_validation') {
      this.runs.complete(run)
      this.session.append('bid.user_confirmation.required', { stage, status: 'waiting_user' })
      return 'waiting_user'
    }
    let commitContext: () => void
    try {
      commitContext = await this.prepareStageContextTransition(stage)
    } catch (error: unknown) {
      await this.runs.suspend('executor_error', { message: `stage context transition failed: ${String(error)}` })
      return 'failed'
    }
    if (this.isAborted()) { await this.runs.suspend('user_stop'); return 'aborted' }
    run.commits.assertWritable(run)
    this.runs.complete(run)
    this.session.append('bid.stage.completed', {
      stage,
      status: 'completed',
      artifacts,
    })
    commitContext()
    return 'completed'
  }

  /** Prepare the successor handoff before committing completion; the returned mutation runs immediately after it. */
  private async prepareStageContextTransition(stage: BidStage): Promise<() => void> {
    const nextStage = getBidStagePolicy(stage).nextStage
    if (nextStage === null || this.prepareContextTransition === undefined) return () => {}
    return this.prepareContextTransition(stage, nextStage)
  }

  /** Validate artifacts without changing Workflow or Run ownership. */
  private async validate(stage: BidStage, artifacts: StageArtifact[]): Promise<StageValidationResult> {
    let result: StageValidationResult
    try {
      result = await this.validator.validate(stage, artifacts)
    } catch {
      const issues = [{ code: 'VALIDATOR_FAILED', message: 'The stage validator could not complete.' }]
      return { ok: false, issues }
    }
    return result
  }

  /** Preserve usable S5 artifacts when a bounded business correction cannot reach its confirmed target. */
  private attentionRequired(stage: BidStage, reason: string, issues: StageValidationIssue[]): void {
    this.session.append('bid.stage.attention_required', { stage, status: 'attention_required', reason, issues })
  }
}

/**
 * Format one browser-safe issue for compact logs and non-S2 summaries.
 * @param issue Validation issue with optional Artifact and field paths.
 * @returns Stable colon-delimited summary without raw values.
 */
export function formatStageValidationIssue(issue: StageValidationIssue): string {
  return [issue.code, issue.artifact, issue.path, issue.message].filter(value => value !== undefined).join(': ')
}
