import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { EmbeddedSurfaceRegistry } from '../src/client/embedded-surface.ts'

const sid = (value: string): SessionId => value as SessionId

describe('EmbeddedSurfaceRegistry', () => {
  it('notifies only when a Session portal destination changes', () => {
    const registry = new EmbeddedSurfaceRegistry()
    const listener = vi.fn()
    const sessionId = sid('session')
    const stop = registry.subscribe(sessionId, listener)
    const chat = {} as HTMLElement

    registry.setHost(sessionId, 'chat', chat)
    registry.setHost(sessionId, 'chat', chat)
    registry.setHost(sessionId, 'composer', {} as HTMLElement)
    registry.setHost(sessionId, 'chat', null)

    expect(listener).toHaveBeenCalledTimes(3)
    expect(registry.host(sessionId, 'chat')).toBeNull()
    stop()
    registry.setHost(sessionId, 'composer', null)
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
