/**
 * Queue read face for the InputState.queue projection (frozen contract in
 * ../input/contract.ts): a uSES-compatible observable over one session's
 * transient inbox rows. The Session snapshot already keeps the queue array
 * reference-stable across unrelated snapshot swaps, so this is a pure
 * projection — no second store, no copy.
 */
import type { ObservableSnapshot, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { QueuedMessage } from '../input/contract.ts'

/**
 * Project a session's transient inbox rows as a bare observable (subscribe/getSnapshot).
 * The wiring layer overlays this onto InputState.queue; the runtime
 * QueuedMessage and the input-contract QueuedMessage are structurally
 * identical.
 * @param session - the resident session face.
 * @returns the queue read face (snapshot reference stable while the queue is unchanged).
 */
export function queueReadFaceOf(session: SessionFace): ObservableSnapshot<readonly QueuedMessage[]> {
  let queue = session.getSnapshot().queue
  let outgoing = session.getSnapshot().outgoing ?? []
  let value: readonly QueuedMessage[] = [...outgoing, ...queue]
  const refresh = (): void => {
    const snapshot = session.getSnapshot()
    if (snapshot.queue === queue && snapshot.outgoing === outgoing) return
    queue = snapshot.queue
    outgoing = snapshot.outgoing ?? []
    value = [...outgoing, ...queue]
  }
  return {
    getSnapshot: () => { refresh(); return value },
    subscribe: fn => session.subscribe(() => { refresh(); fn() }),
  }
}
