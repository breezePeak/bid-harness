import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One feature-owned operation that continues while the conversation Session is idle. */
export interface ConversationBackgroundActivity {
  /** Stop the owning operation without cancelling an unrelated foreground turn. */
  readonly stop: () => void
}

/** Generic per-session registry for feature-owned background work. */
export interface ConversationBackgroundActivities {
  set(sessionId: SessionId, owner: string, activity: ConversationBackgroundActivity | undefined): void
  storeFor(sessionId: SessionId): SnapshotStore<ConversationBackgroundActivity | undefined>
  forget(sessionId: SessionId): void
}

/** Merge feature contributions into the single background control shown by the composer. */
export class ConversationBackgroundActivityRegistry implements ConversationBackgroundActivities {
  private readonly entries = new Map<SessionId, Map<string, ConversationBackgroundActivity>>()
  private readonly stores = new Map<SessionId, SnapshotStore<ConversationBackgroundActivity | undefined>>()

  /** @inheritdoc */
  set(sessionId: SessionId, owner: string, activity: ConversationBackgroundActivity | undefined): void {
    const entries = this.entries.get(sessionId) ?? new Map<string, ConversationBackgroundActivity>()
    if (activity === undefined) entries.delete(owner)
    else entries.set(owner, activity)
    if (entries.size === 0) this.entries.delete(sessionId)
    else this.entries.set(sessionId, entries)
    this.storeFor(sessionId).set(entries.values().next().value)
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<ConversationBackgroundActivity | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ConversationBackgroundActivity | undefined>(
      this.entries.get(sessionId)?.values().next().value,
    )
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.entries.delete(sessionId)
    this.stores.delete(sessionId)
  }
}
