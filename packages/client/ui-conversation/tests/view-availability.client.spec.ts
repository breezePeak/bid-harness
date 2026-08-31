import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ViewAvailabilityRegistry } from '../src/client/view-availability.ts'

const sid = (value: string): SessionId => value as SessionId

describe('ViewAvailabilityRegistry', () => {
  it('hides a view only for its Session and notifies that Session', () => {
    const registry = new ViewAvailabilityRegistry()
    const sessionId = sid('session')
    const listener = vi.fn()
    registry.subscribe(sessionId, listener)

    registry.set(sessionId, 'bid-review', false)

    expect(registry.available(sessionId, 'bid-review')).toBe(false)
    expect(registry.available(sid('other'), 'bid-review')).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    registry.set(sessionId, 'bid-review', true)
    expect(registry.available(sessionId, 'bid-review')).toBe(true)
  })
})
