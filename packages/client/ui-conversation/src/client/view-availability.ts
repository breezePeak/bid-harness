/** Session-local availability state for registered conversation views. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Keeps feature-owned view availability reactive without coupling views to each other. */
export class ViewAvailabilityRegistry {
  private readonly unavailable = new Map<SessionId, Set<string>>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly revisions = new Map<SessionId, number>()

  /** Whether a registered view may be selected for one Session. */
  available(sessionId: SessionId, viewId: string): boolean {
    return !this.unavailable.get(sessionId)?.has(viewId)
  }

  /** Revision for external-store subscribers of one Session's availability. */
  version(sessionId: SessionId): number {
    return this.revisions.get(sessionId) ?? 0
  }

  /** Subscribe to availability changes for one Session. */
  subscribe(sessionId: SessionId, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  /** Make a registered view selectable or unavailable for one Session. */
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
