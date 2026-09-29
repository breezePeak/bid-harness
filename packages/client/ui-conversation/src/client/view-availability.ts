/** Session-local availability state for registered conversation views. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Keeps feature-owned view availability reactive without coupling views to each other. */
export class ViewAvailabilityRegistry {
  private readonly unavailable = new Map<SessionId, Set<string>>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly revisions = new Map<SessionId, number>()

  /**
   * Whether a registered view may be selected for one Session.
   * @param sessionId 会话身份。
   * @param viewId 视图身份。
   * @returns 当前视图是否可选。
   */
  available(sessionId: SessionId, viewId: string): boolean {
    return !this.unavailable.get(sessionId)?.has(viewId)
  }

  /**
   * Revision for external-store subscribers of one Session's availability.
   * @param sessionId 会话身份。
   * @returns 可用性状态的修订号。
   */
  version(sessionId: SessionId): number {
    return this.revisions.get(sessionId) ?? 0
  }

  /**
   * Subscribe to availability changes for one Session.
   * @param sessionId 会话身份。
   * @param listener 状态变更监听器。
   * @returns 取消订阅的函数。
   */
  subscribe(sessionId: SessionId, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  /**
   * Make a registered view selectable or unavailable for one Session.
   * @param sessionId 会话身份。
   * @param viewId 视图身份。
   * @param available 视图是否可选。
   */
  set(sessionId: SessionId, viewId: string, available: boolean): void {
    const current = this.unavailable.get(sessionId)
    if (available) {
      if (current?.delete(viewId) !== true) return
      if (current.size === 0) this.unavailable.delete(sessionId)
    } else {
      const next = current ?? new Set<string>()
      if (next.has(viewId)) return
      next.add(viewId)
      this.unavailable.set(sessionId, next)
    }
    this.revisions.set(sessionId, this.version(sessionId) + 1)
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}
