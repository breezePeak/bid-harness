/** Session-local React portal hosts for feature views that retain the shared conversation UI. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** A place in a feature view where one resident conversation surface is rendered. */
export type EmbeddedSurfaceKind = 'chat' | 'composer' | 'review'

/** Reactive read access to a feature-owned portal destination. */
export interface EmbeddedSurface {
  /** Return the current portal destination, or null while its view is absent. */
  host(): HTMLElement | null
  /** Subscribe to destination changes. */
  subscribe(listener: () => void): () => void
}

/** Keeps portal destinations reactive without giving feature plugins access to conversation state. */
export class EmbeddedSurfaceRegistry {
  private readonly hosts = new Map<SessionId, Map<EmbeddedSurfaceKind, HTMLElement>>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()

  /**
   * Read a registered portal destination.
   * @param sessionId Session that owns the feature view.
   * @param kind Resident conversation surface being projected.
   * @returns Current portal destination, or null while its view is absent.
   */
  host(sessionId: SessionId, kind: EmbeddedSurfaceKind): HTMLElement | null {
    return this.hosts.get(sessionId)?.get(kind) ?? null
  }

  /**
   * Subscribe to portal-destination changes for one Session.
   * @param sessionId Session whose destination changes are observed.
   * @param listener Callback invoked after a destination changes.
   * @returns Disposer that removes the subscription.
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
   * Register or clear one portal destination.
   * @param sessionId Session that owns the feature view.
   * @param kind Resident conversation surface being projected.
   * @param element Portal host, or null to clear the current host.
   */
  setHost(sessionId: SessionId, kind: EmbeddedSurfaceKind, element: HTMLElement | null): void {
    const current = this.hosts.get(sessionId)
    if (element === null) {
      if (current?.delete(kind) !== true) return
      if (current.size === 0) this.hosts.delete(sessionId)
    } else {
      if (current?.get(kind) === element) return
      const next = current ?? new Map<EmbeddedSurfaceKind, HTMLElement>()
      next.set(kind, element)
      this.hosts.set(sessionId, next)
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}
