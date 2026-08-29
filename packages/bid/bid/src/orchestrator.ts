import type { Session } from '@deepseek-ai/dsh-session'
import type {
  BidClientAction,
  BidPromptAdmission,
  BidRuntimeState,
  BidStage,
  BidStageTask,
  StageArtifact,
  StageValidationResult,
} from './control-plane-contract.ts'
import {
  BID_INITIAL_RUNTIME_STATE,
  buildBidStageTask,
  getBidClientProjection,
  getBidStagePolicy,
  reduceBidRuntimeState,
} from './runtime-state.ts'

/** Executor port used by program and agent stages. */
export interface BidStageExecutorPort {
  /**
   * Execute one host-created stage assignment.
   * @param task - immutable-in-intent assignment derived from the stage policy.
   * @returns workspace artifact references produced by the executor.
   */
  execute(task: BidStageTask): Promise<StageArtifact[]>
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

/** Stable rejection codes for host-side Bid operation admission. */
export type BidOrchestratorErrorCode =
  | 'BID_ACTION_NOT_ALLOWED'
  | 'BID_CONFIRM_NOT_ALLOWED'
  | 'BID_OPERATION_IN_PROGRESS'
  | 'BID_RETRY_NOT_ALLOWED'

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

  /**
   * Create a driver for one exact live or replayed session.
   * @param session - session whose log owns all Bid state.
   * @param executor - program and agent execution adapter.
   * @param validator - artifact validation adapter.
   */
  constructor(
    private readonly session: Session,
    private readonly executor: BidStageExecutorPort,
    private readonly validator: BidStageValidatorPort,
  ) {}

  /** Current state replayed from the session log. */
  get state(): BidRuntimeState {
    return this.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
  }

  /**
   * Drive pending stages until user input, failure, or final completion. Concurrent callers share the same drive.
   * @returns the state at the stopping point.
   */
  drive(): Promise<BidRuntimeState> {
    if (this.operation !== undefined) return this.operation
    return this.begin(() => this.driveLoop())
  }

  /**
   * Retry the current failed stage and continue automatic execution after success.
   * @returns the state at the next stopping point.
   * @throws {@link BidOrchestratorError} unless the session is failed and idle.
   */
  retry(): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    if (state.status !== 'failed') {
      throw new BidOrchestratorError(
        'BID_RETRY_NOT_ALLOWED',
        `cannot retry Bid stage ${JSON.stringify(state.stage)} while status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      if (getBidStagePolicy(state.stage).executor === 'user') {
        this.session.append('bid.user_confirmation.required', {
          stage: state.stage,
          status: 'waiting_user',
        })
        return this.state
      }
      const completed = await this.executeStage(state.stage)
      return completed ? this.driveLoop() : this.state
    })
  }

  /**
   * Record and validate an explicit outline decision. A rejection remains waiting for another decision.
   * @param confirmed - whether the user accepts the current outline.
   * @returns the state after recording the decision and any automatic continuation.
   * @throws {@link BidOrchestratorError} unless outline confirmation is waiting and the driver is idle.
   */
  confirm(confirmed: boolean): Promise<BidRuntimeState> {
    this.assertIdle()
    const state = this.state
    if (state.stage !== 'outline_confirmation' || state.status !== 'waiting_user') {
      throw new BidOrchestratorError(
        'BID_CONFIRM_NOT_ALLOWED',
        `cannot confirm Bid outline while stage is ${JSON.stringify(state.stage)} and status is ${JSON.stringify(state.status)}`,
      )
    }
    return this.begin(async () => {
      this.session.append('bid.user_confirmation.received', {
        stage: 'outline_confirmation',
        confirmed,
      })
      if (!confirmed) return this.state

      const artifact: StageArtifact = {
        stage: 'outline_confirmation',
        type: 'outline_confirmation',
        path: 'outline/confirmation.json',
      }
      const validation = await this.validate('outline_confirmation', [artifact])
      if (!validation.ok) return this.state
      this.session.append('bid.stage.completed', {
        stage: 'outline_confirmation',
        status: 'completed',
        artifacts: [artifact],
      })
      return this.driveLoop()
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

  /** Reject a second mutating command while another command owns the session driver. */
  private assertIdle(): void {
    if (this.operation === undefined) return
    throw new BidOrchestratorError('BID_OPERATION_IN_PROGRESS', 'a Bid orchestrator operation is already in progress')
  }

  /** Continue the automatic control loop from the current log-derived state. */
  private async driveLoop(): Promise<BidRuntimeState> {
    while (true) {
      const state = this.state
      if (state.status !== 'pending') return state
      const policy = getBidStagePolicy(state.stage)
      if (policy.executor === 'user') {
        this.session.append('bid.user_confirmation.required', {
          stage: state.stage,
          status: 'waiting_user',
        })
        return this.state
      }
      if (!await this.executeStage(state.stage)) return this.state
    }
  }

  /** Execute and validate one non-user stage, recording its complete outcome. */
  private async executeStage(stage: BidStage): Promise<boolean> {
    this.session.append('bid.stage.started', { stage, status: 'running' })
    let artifacts: StageArtifact[]
    try {
      artifacts = await this.executor.execute(buildBidStageTask(stage))
    } catch (error: unknown) {
      this.fail(stage, `executor failed: ${String(error)}`)
      return false
    }
    const validation = await this.validate(stage, artifacts)
    if (!validation.ok) return false
    this.session.append('bid.stage.completed', {
      stage,
      status: 'completed',
      artifacts,
    })
    return true
  }

  /** Validate artifacts, converting rejection and validator failures into the stage log. */
  private async validate(stage: BidStage, artifacts: StageArtifact[]): Promise<StageValidationResult> {
    let result: StageValidationResult
    try {
      result = await this.validator.validate(stage, artifacts)
    } catch (error: unknown) {
      this.fail(stage, `validator failed: ${String(error)}`)
      return { ok: false, issues: [{ code: 'VALIDATOR_FAILED', message: String(error) }] }
    }
    if (!result.ok) {
      this.fail(stage, result.issues.map(issue => `${issue.code}: ${issue.message}`).join('; '))
    }
    return result
  }

  /** Append the sole failed-state transition. */
  private fail(stage: BidStage, reason: string): void {
    this.session.append('bid.stage.failed', { stage, status: 'failed', reason })
  }
}
