/** Native Goal ownership and admission for one Bid main Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-goal-round-driver'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidRunContext } from './run-coordinator.ts'
import { bidRunRecoveryEligibility, bidWritingPlanRecoveryEligibility } from './bid-recovery.ts'
import { isBidMainSession } from './stage-interaction.ts'

const OBJECTIVE = '完成当前技术标的 S2 招标信息提取、S3 初步目录、S4 资料映射与目录深化、S5 正文编写及既定审核。正常阶段由 Host 和现有 subagent 执行；遇到可恢复失败时读取真实诊断，保留已完成成果，仅通过受控恢复工具改进失败任务的处理办法。到正式确认时等待用户；S4 确认后直接开始 S5。S1 文件处理、S6 Word 导出不属于本目标；不修改上游事实、正式确认和验收规则。'

/**
 * The latest durable binding is the only Goal authorized for this Session.
 * @param session - Main Bid Session containing binding events.
 * @returns Latest binding, if S2 ever admitted a Goal.
 */
export function bidGoalBinding(session: Session): Session['events'][number] & { type: 'bid.goal.bound' } | undefined {
  const event = session.events.findLast(event => event.type === 'bid.goal.bound')
  return event?.type === 'bid.goal.bound' ? event : undefined
}

/** Host-owned bridge; all asynchronous flushes and listeners share its lifetime. */
export class BidGoalBridge {
  private readonly creating = new Set<Agent>()
  private readonly pending = new Set<Session>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly warned = new Set<Session>()
  private readonly internalChanges = new Set<Session>()
  private readonly disposeGate: () => void
  private closed = false

  /**
   * @param ctx - Context with native Goal and round-driver services.
   * @param canDrive - Synchronous Host snapshot check for recoverable work.
   * @param onBindingFailure - Host fallback after a binding checkpoint fails.
   */
  constructor(private readonly ctx: Context, private readonly canDrive: (session: Session) => boolean,
    private readonly onBindingFailure: (session: Session) => void) {
    this.disposeGate = ctx.goalRoundDriver.registerGate((agent, goal) => {
      if (!isBidMainSession(agent.session)) return
      const bound = bidGoalBinding(agent.session)
      if (bound?.data.goalId !== goal.id && !this.creating.has(agent)) return
      if (this.closed || this.pending.has(agent.session) || !this.canDrive(agent.session)) return 'wait'
    })
  }

  /**
   * Bind only after the S2 running checkpoint admitted its actual work.
   * @param session 进入 S2 的主会话。
   * @param run 刚通过运行检查点的 S2 执行。
   */
  onS2Admitted(session: Session, run: BidRunContext): void {
    if (this.closed || !isBidMainSession(session)
      || run.work.kind !== 'stage_execution' || run.work.stage !== 'tender_analysis') return
    try {
      const agent = this.ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const bound = bidGoalBinding(session)
      const goal = this.ctx.goals.get(agent)
      if (bound?.data.initialS2WorkId === run.work.workId) return
      if (bound !== undefined && goal?.id === bound.data.goalId && goal.phase !== 'complete') return
      if (goal !== undefined && goal.phase !== 'complete') {
        if (!this.warned.has(session)) {
          this.warned.add(session)
          this.ctx.logger.warn('Bid S2 未接入自动 Goal：主会话已有其他未完成目标。')
        }
        return
      }
      this.creating.add(agent)
      let created: GoalView
      try {
        created = this.ctx.goals.create(agent, { objective: OBJECTIVE })
        session.append('bid.goal.bound', {
          goalId: created.id,
          ownerSessionId: String(session.id),
          initialS2WorkId: run.work.workId,
        })
        this.pending.add(session)
      } finally {
        this.creating.delete(agent)
      }
      const task = this.ctx.sessions.flush(session).then(() => {
        this.pending.delete(session)
        this.request(session)
      }, (_error: unknown) => {
        this.pending.delete(session)
        const current = this.ctx.goals.get(agent)
        if (current?.id === created.id && current.activation === 'armed') this.ctx.goals.disarm(agent)
        this.ctx.logger.warn('Bid Goal 绑定未能持久化，自动续行已停用。')
        this.onBindingFailure(session)
      })
      this.tasks.add(task)
      void task.finally(() => { this.tasks.delete(task) })
    } catch (_error: unknown) {
      this.ctx.logger.warn('Bid S2 Goal 绑定失败；原阶段执行继续。')
    }
  }

  /**
   * Ask the existing serial driver to reconsider one live main Session.
   * @param session 需要重新检查 Goal 准入的主会话。
   */
  request(session: Session): void {
    if (this.closed || this.pending.has(session)) return
    const agent = this.ctx.agents.get(session.id)
    if (agent !== undefined && agent.session === session && bidGoalBinding(session)?.data.goalId === this.ctx.goals.get(agent)?.id) {
      this.ctx.goalRoundDriver.request(agent)
    }
  }

  /**
   * Current native authority plus the shared durable recovery decision.
   * @param session 待检查的主会话。
   * @returns 绑定 Goal 是否仍授权恢复工作。
   */
  canRecover(session: Session): boolean {
    const agent = this.ctx.agents.get(session.id)
    const bound = bidGoalBinding(session)
    const goal = agent === undefined ? undefined : this.ctx.goals.get(agent)
    return agent?.session === session && bound?.data.ownerSessionId === String(session.id)
      && goal?.id === bound.data.goalId && goal.phase === 'active' && goal.activation === 'armed'
      && (bidRunRecoveryEligibility(session, goal.id).eligible
        || bidWritingPlanRecoveryEligibility(session, goal.id).eligible)
  }

  /**
   * Whether a native change was made by the Host rather than by the user.
   * @param session 待检查的主会话。
   * @returns 当前 Goal 变更是否由 Host 发起。
   */
  isInternalChange(session: Session): boolean { return this.internalChanges.has(session) }

  /**
   * Withdraw a bound Goal's automatic authority before a stop or reset drains work.
   * @param session 需要撤销自动续行权限的主会话。
   */
  pause(session: Session): void {
    this.change(session, (goal) => {
      if (goal.view.phase === 'active') this.ctx.goals.pause(goal.agent, { id: goal.view.id, revision: goal.view.revision })
    })
  }

  /**
   * A successful explicit reset may rearm its retained Goal.
   * @param session 已完成显式重置的主会话。
   */
  resumeAfterReset(session: Session): void {
    this.change(session, (goal) => {
      if (goal.view.phase !== 'complete' && (goal.view.phase !== 'active' || goal.view.activation === 'disarmed')) {
        this.ctx.goals.resume(goal.agent, { id: goal.view.id, revision: goal.view.revision })
      }
    })
  }

  /**
   * Host completion follows only the committed S5 result.
   * @param session S5 已正式完成的主会话。
   */
  complete(session: Session): void {
    this.change(session, (goal) => {
      if (goal.view.phase !== 'complete') this.ctx.goals.complete(goal.agent, { id: goal.view.id, revision: goal.view.revision })
    })
  }

  /**
   * An explicit rewind to S1 ends the old generation's automatic authority.
   * @param session 已重置到 S1 的主会话。
   */
  clearAfterS1Reset(session: Session): void {
    this.change(session, (goal) => {
      this.ctx.goals.clear(goal.agent, { id: goal.view.id, revision: goal.view.revision })
    })
  }

  private change(session: Session, mutate: (goal: { agent: Agent; view: GoalView }) => void): void {
    if (this.closed || this.internalChanges.has(session)) return
    const agent = this.ctx.agents.get(session.id)
    const view = agent === undefined ? undefined : this.ctx.goals.get(agent)
    if (agent?.session !== session || view === undefined || bidGoalBinding(session)?.data.goalId !== view.id) return
    this.internalChanges.add(session)
    try { mutate({ agent, view }) } finally { this.internalChanges.delete(session) }
  }

  /** Release admission first, then wait for already-started durability work. */
  async dispose(): Promise<void> {
    this.closed = true
    this.disposeGate()
    await Promise.allSettled(this.tasks)
    this.creating.clear()
    this.pending.clear()
    this.warned.clear()
    this.internalChanges.clear()
  }
}
