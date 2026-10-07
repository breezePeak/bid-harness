/** 无 Goal 的失败纠正轮；Session 日志拥有预算、消息身份和最终结算。 */
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from './runtime-state.ts'
import type {} from './bid-events.ts'

type Round = SessionEventMap['bid.recovery.round']

/** 当前权威失败及 Main 可执行的恢复要求。 */
export interface BidRecoveryNotice {
  target: Round['target']
  fingerprint: string
  eligible: boolean
  reason: string
  facts: string[]
}

/**
 * 比较同一恢复链，新的执行 Run 或计划 attempt 不增加业务身份。
 * @param left 已保存的恢复目标。
 * @param right 当前权威恢复目标。
 * @returns 两者是否属于同一原 Work 或已保存请求。
 */
export function sameBidRecoveryTarget(left: Round['target'], right: Round['target']): boolean {
  return left.kind === 'run' ? right.kind === 'run' && left.workId === right.workId
    : right.kind === 'writing_plan' && left.requestId === right.requestId
}

/** Host 有界调度；再次派发前重新检查当前失败、授权和停止状态。 */
export class BidRecoveryDriver {
  private readonly pending = new Map<Session, Promise<void>>()
  private readonly timers = new Map<Session, ReturnType<typeof setTimeout>>()
  private readonly unconfirmedReports = new WeakMap<Session, string>()
  private disposed = false

  constructor(private readonly ctx: Context, private readonly budget: number,
    private readonly read: (session: Session) => BidRecoveryNotice | undefined,
    private readonly available: (session: Session) => boolean) {
    ctx.effect(() => async () => {
      this.disposed = true
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      // 请求的调用者及 timer 已拥有失败处理；卸载等待其 checkpoint 全部退出。
      await Promise.allSettled([...this.pending.values()])
    })
  }

  /**
   * 核验上一轮结果并安排有限续行；并发事件共享一次调度。
   * @param agent 原授权主会话的 live Agent。
   * @returns 审计事实已落盘或下一次到期唤醒已安排。
   */
  request(agent: Agent): Promise<void> {
    const existing = this.pending.get(agent.session)
    if (existing !== undefined) return existing
    const task = this.drive(agent).catch(async (error: unknown) => {
      await this.retryDispatch(agent, error)
      throw error
    }).finally(() => { this.pending.delete(agent.session) })
    this.pending.set(agent.session, task)
    return task
  }

  private async append(session: Session, round: Round): Promise<void> {
    if (this.disposed) return
    session.append('bid.recovery.round', round)
    await this.ctx.sessions.flush(session)
  }

  private active(): boolean { return !this.disposed }

  private async retryDispatch(agent: Agent, error: unknown): Promise<void> {
    if (this.disposed) return
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    const latest = agent.session.events.findLast(event => event.type === 'bid.recovery.round')
    const notice = this.read(agent.session)
    if (code === undefined || !/^(?:EIO|ETIMEDOUT|ECONNRESET|EAI_AGAIN|TRANSPORT|TIMEOUT|SERVER|RATE_LIMIT)$/u.test(code)
      || latest?.type !== 'bid.recovery.round' || notice === undefined || !this.available(agent.session)
      || !sameBidRecoveryTarget(latest.data.target, notice.target)) {
      this.ctx.logger.warn(`BID_RECOVERY_DISPATCH_BLOCKED: 恢复通知未确认：${String(error)}`)
      return
    }
    const budget = Math.min(latest.data.budget, this.budget)
    if ((latest.data.dispatchAttempts ?? 0) > budget) {
      if (latest.data.messageId !== undefined) this.unconfirmedReports.set(agent.session, latest.data.messageId)
      this.ctx.logger.warn(`BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED: 终止报告仍未确认；${String(error)}`)
      return
    }
    const dispatchAttempts = (latest.data.dispatchAttempts ?? 0) + 1
    const exhausted = dispatchAttempts > budget
    const retry: Round = { ...latest.data, budget, dispatchAttempts }
    if (exhausted) {
      retry.state = 'blocked'
      retry.reason = `BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED: ${budget} 次派发重试后仍未确认；${String(error)}`
      delete retry.messageId
      retry.messageId = String(this.message(agent, retry, notice).id)
    }
    try { await this.append(agent.session, retry) } catch (checkpointError: unknown) {
      // 确认失败时 Session 内存保留计数；存储恢复后同轮 checkpoint 会一并落盘。
      this.ctx.logger.warn(`Bid 恢复派发重试次数未确认：${String(checkpointError)}`)
      if (exhausted && retry.messageId !== undefined) this.unconfirmedReports.set(agent.session, retry.messageId)
    }
    if (!this.active()) return
    const confirmed = this.unconfirmedReports.get(agent.session) !== retry.messageId
    if (exhausted) {
      this.ctx.logger.warn(retry.reason)
      if (confirmed) {
        try { await this.notify(agent, retry, notice) } catch (reportError: unknown) {
          if (retry.messageId !== undefined) this.unconfirmedReports.set(agent.session, retry.messageId)
          this.ctx.logger.warn(`BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED: 终止报告未确认；${String(reportError)}`)
        }
      }
      return
    }
    this.schedule(agent, Date.now() + Math.min(2000, 250 * 2 ** (dispatchAttempts - 1)))
  }

  private received(agent: Agent, messageId: string | undefined): boolean {
    return messageId !== undefined && (agent.session.events.some(event => event.type === 'user/message'
      && String(event.data.id) === messageId)
      || this.enqueued(agent.session, messageId) !== undefined)
  }

  private enqueued(session: Session, messageId: string | undefined) {
    return messageId === undefined ? undefined : session.events.find(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => String(message.id) === messageId))
  }

  private message(agent: Agent, round: Round, notice: BidRecoveryNotice) {
    const blocked = round.state === 'blocked'
    const previous = agent.session.events.findLast(event => event.type === 'bid.recovery.round'
      && event.data.round === round.round - 1 && sameBidRecoveryTarget(event.data.target, round.target))
    const fresh = createUserMessage({ content: [{ type: 'text', text: [...notice.facts,
      ...(blocked ? [round.reason, '恢复已终止。报告原始失败、已尝试的动作和具体 blocker。'] : [
        `纠正轮：${round.round}/${round.budget}。仅文字回复不算恢复；必须执行具体修复并核验结果。`,
        ...(previous?.type === 'bid.recovery.round' && previous.data.state === 'no_effect'
          ? ['上一轮没有有效动作，请落实修复。'] : []),
      ])].join('\n') }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice',
      summary: blocked ? 'Bid 恢复终止' : 'Bid 执行失败，交由主 Agent 处理' } })
    return round.messageId === undefined ? fresh : freezeMessage({ ...fresh, id: MessageId(round.messageId) })
  }

  private async notify(agent: Agent, round: Round, notice: BidRecoveryNotice): Promise<void> {
    if (this.disposed || this.received(agent, round.messageId)
      || round.messageId !== undefined && this.unconfirmedReports.get(agent.session) === round.messageId) return
    const blocked = round.state === 'blocked'
    const message = this.message(agent, round, notice)
    if (round.messageId === undefined) await this.append(agent.session, { ...round, messageId: String(message.id) })
    else await this.ctx.sessions.flush(agent.session)
    if (!this.active()) return
    const confirmed = this.read(agent.session)
    if (this.available(agent.session) && confirmed !== undefined && (blocked || confirmed.eligible)
      && sameBidRecoveryTarget(confirmed.target, round.target) && confirmed.fingerprint === round.fingerprint
      && !this.received(agent, String(message.id))) agent.steer(message)
  }

  private schedule(agent: Agent, nextAt: number): void {
    if (this.disposed || this.timers.has(agent.session)) return
    const timer = setTimeout(() => {
      this.timers.delete(agent.session)
      void this.request(agent).catch((error: unknown) => {
        this.ctx.logger.warn(`Bid 失败纠正轮派发失败：${String(error)}`)
      })
    }, Math.max(0, nextAt - Date.now()))
    this.timers.set(agent.session, timer)
  }

  private async drive(agent: Agent): Promise<void> {
    const session = agent.session
    if (!this.active() || !this.available(session)) return
    const notice = this.read(session)
    const latest = session.events.findLast(event => event.type === 'bid.recovery.round')
    let prior = latest?.type === 'bid.recovery.round' ? latest.data : undefined
    if (notice === undefined) {
      if (prior === undefined || ['recovered', 'waiting_input', 'cancelled', 'blocked'].includes(prior.state)) return
      const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      if (task.status === 'running') return
      if (prior.target.kind === 'writing_plan') {
        const writing = session.events.findLast(event => event.type === 'bid.writing_entry.changed')
        if (writing?.type === 'bid.writing_entry.changed' && writing.data.view.phase === 'planning') return
      }
      const state = task.status === 'suspended' && task.run.cause === 'user_stop' ? 'cancelled'
        : task.status === 'suspended' && task.run.cause === 'awaiting_input' ? 'waiting_input'
          : task.status === 'failed' ? 'blocked' : 'recovered'
      await this.append(session, { ...prior, state, reason: `恢复核验结果：${task.status}。` })
      return
    }
    if (prior !== undefined && !sameBidRecoveryTarget(prior.target, notice.target)) prior = undefined
    const budget = Math.min(prior?.budget ?? this.budget, this.budget)
    if ((prior?.dispatchAttempts ?? 0) > budget && prior?.state !== 'blocked') return
    if (prior !== undefined && prior.budget !== budget) {
      prior = { ...prior, budget }
      await this.append(session, prior)
    }
    if (prior?.state === 'blocked') {
      await this.notify(agent, prior, notice)
      return
    }
    if (prior?.state === 'notified') {
      const receipt = session.events.findLast(event => event.type === 'user/message' && String(event.data.id) === prior?.messageId)
      const enqueued = this.enqueued(session, prior.messageId)
      const consumed = enqueued === undefined ? undefined : foldConsumedWork(session.events.filter(event => event.seq >= enqueued.seq))
      const ended = receipt === undefined ? consumed?.end
        : session.events.findLast(event => event.type === 'turn/end' && event.seq > receipt.seq)
      const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => String(message.id) === prior?.messageId)
      if (queued || (receipt !== undefined || enqueued !== undefined) && ended === undefined && consumed?.droppedUnrun !== true) return
      if (receipt !== undefined || ended !== undefined || consumed?.droppedUnrun === true) {
        const executed = session.events.some(event => event.type === 'bid.recovery.requested'
          && event.seq > (receipt?.seq ?? enqueued?.seq ?? -1)
          && sameBidRecoveryTarget(event.data.target, notice.target))
        prior = { ...prior, state: executed ? 'failed' : 'no_effect', reason: executed
          ? '执行后原失败仍存在，必须调整策略。' : 'Main 本轮没有落地恢复动作，原失败仍存在。' }
        await this.append(session, prior)
      } else {
        await this.notify(agent, prior, notice)
        return
      }
    }
    if (!notice.eligible || (prior?.round ?? 0) >= budget && prior?.state !== 'scheduled') {
      const reason = !notice.eligible ? notice.reason
        : `BID_RECOVERY_BUDGET_EXHAUSTED: ${budget} 轮纠正后仍未解除原失败；${notice.reason}`
      const blocked: Round = { ownerSessionId: String(session.id), target: notice.target, fingerprint: notice.fingerprint,
        round: prior?.round ?? 0, budget, state: 'blocked', reason,
        ...(prior?.dispatchAttempts === undefined ? {} : { dispatchAttempts: prior.dispatchAttempts }) }
      await this.notify(agent, blocked, notice)
      return
    }
    let scheduled: Round
    if (prior?.state === 'scheduled') {
      scheduled = { ...prior, target: notice.target, fingerprint: notice.fingerprint, budget, reason: notice.reason }
      if (prior.fingerprint !== notice.fingerprint || JSON.stringify(prior.target) !== JSON.stringify(notice.target)
        || prior.budget !== budget) await this.append(session, scheduled)
    }
    else {
      scheduled = { ownerSessionId: String(session.id), target: notice.target, fingerprint: notice.fingerprint,
        round: (prior?.round ?? 0) + 1, budget, state: 'scheduled',
        nextAt: Date.now() + (prior === undefined ? 0 : Math.min(2000, 250 * 2 ** prior.round)), reason: notice.reason }
      await this.append(session, scheduled)
    }
    if (this.disposed || !this.available(session)) return
    const nextAt = scheduled.nextAt ?? 0
    if (nextAt > Date.now()) {
      this.schedule(agent, nextAt)
      return
    }
    const current = this.read(session)
    if (current === undefined || !sameBidRecoveryTarget(current.target, scheduled.target)) return
    if (current.fingerprint !== scheduled.fingerprint || JSON.stringify(current.target) !== JSON.stringify(scheduled.target)) {
      scheduled = { ...scheduled, target: current.target, fingerprint: current.fingerprint, reason: current.reason }
      await this.append(session, scheduled)
    }
    if (!current.eligible || !this.available(session)) {
      this.schedule(agent, Date.now())
      return
    }
    await this.notify(agent, { ...scheduled, state: 'notified' }, current)
  }
}
