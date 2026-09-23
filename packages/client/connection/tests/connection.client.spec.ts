/**
 * ConnectionController: stream pumping into sinks, the strict readiness
 * handshake (describe + both streams' onOpen, timeout-guarded), generation
 * abort on loss, backoff reconnection, state transitions, and sink-exception
 * isolation. Real (short) timers — the timeout and backoff are configurable,
 * so tests run them at millisecond scale.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import type { ConnectionState } from '../src/client/connection.ts'
import { ConnectionController } from '../src/client/connection.ts'
import { FakeApiClient, deferred, ok } from './fake-api.client.ts'

const SID = 'fk-c1' as SessionId
const FAST = { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, streamOpenTimeoutMs: 500 }

function subscribedFrame(lastSeq = 0) {
  return { type: 'session/subscribed', sessionId: SID, lastSeq } as const
}

describe('connection lifecycle', () => {
  it.each(['reconnect', 'restart'] as const)('握手未完成时 %s 立即建立新连接，旧响应晚到不能发布状态', async (action) => {
    const api = new FakeApiClient()
    const firstDescribe = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    const originalDescribe = api.onDescribe
    api.onDescribe = vi.fn().mockImplementationOnce(() => firstDescribe.promise).mockImplementation(originalDescribe)
    const describe = vi.spyOn(api.host, 'describe')
    const connected = vi.fn()
    const states: ConnectionState[] = []
    const controller = new ConnectionController(api, {
      onConnected: connected,
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
      if (action === 'restart') {
        controller.stop()
        controller.reconnect()
        controller.start()
        controller.start()
      } else {
        controller.reconnect()
        controller.reconnect()
      }
      await vi.waitFor(() => { expect(connected).toHaveBeenCalledTimes(1) })
      expect(describe).toHaveBeenCalledTimes(2)
      expect(describe.mock.calls[0]?.[1]?.aborted).toBe(true)
      expect(api.openMuxCount).toBe(1)
      expect(states).toEqual(action === 'restart' ? ['connected'] : ['reconnecting', 'connected'])

      firstDescribe.resolve(ok({ version: 'old', cwd: '/old', attachedSessions: 0, home: '/old', canOpenPath: false }))
      await Promise.resolve()
      await Promise.resolve()
      expect(connected).toHaveBeenCalledTimes(1)
      expect(connected).toHaveBeenCalledWith(expect.objectContaining({ version: '0-fake' }))
    } finally {
      controller.stop()
    }
  })

  it('主动恢复立即结束退避，停机清除重试定时器', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = new FakeApiClient()
    const originalDescribe = api.onDescribe
    api.onDescribe = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(originalDescribe)
    const connected = vi.fn()
    const controller = new ConnectionController(api, { onConnected: connected }, {
      ...FAST, backoffBaseMs: 60_000, backoffMaxMs: 60_000,
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(api.callsOf('host.describe')).toHaveLength(1)
      expect(connected).not.toHaveBeenCalled()
      controller.reconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(connected).toHaveBeenCalledTimes(1)
      expect(api.callsOf('host.describe')).toHaveLength(2)

      api.failStreams(new Error('offline again'))
      await vi.advanceTimersByTimeAsync(0)
      controller.stop()
      expect(vi.getTimerCount()).toBe(0)
      controller.reconnect()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.callsOf('host.describe')).toHaveLength(2)
    } finally {
      controller.stop()
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('停机后未完成的握手晚到不发布连接或重新启动流', async () => {
    const api = new FakeApiClient()
    const describe = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    api.onDescribe = () => describe.promise
    const connected = vi.fn()
    const state = vi.fn()
    const controller = new ConnectionController(api, { onConnected: connected, onStateChange: state }, FAST)
    controller.start()
    await vi.waitFor(() => { expect(api.openMuxCount).toBe(1) })
    controller.stop()
    await vi.waitFor(() => { expect(api.openMuxCount).toBe(0) })
    describe.resolve(ok({ version: 'old', cwd: '/old', attachedSessions: 0, home: '/old', canOpenPath: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(connected).not.toHaveBeenCalled()
    expect(state).not.toHaveBeenCalled()
    expect(api.callsOf('host.describe')).toHaveLength(1)
  })

  it('announces connected after describe + both streams open, then pumps frames to sinks', async () => {
    const api = new FakeApiClient()
    const muxSeen: string[] = []
    const descriptions: boolean[] = []
    let connected = 0
    const controller = new ConnectionController(api, {
      onMuxEnvelope: envelope => muxSeen.push(envelope.payload.type),
      onConnected: (description) => {
        connected++
        descriptions.push(description.canOpenPath)
      },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      api.pushMux(subscribedFrame())
      await vi.waitFor(() => { expect(muxSeen).toEqual(['session/subscribed']) })
      expect(api.callsOf('host.describe')).toHaveLength(1)
      expect(descriptions).toEqual([true])
    } finally {
      controller.stop()
    }
  })

  it('reconnects with a fresh generation when a stream fails, and stop() ends the loop', async () => {
    const api = new FakeApiClient()
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      api.failStreams(new Error('stream torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) }) // new generation after backoff
      expect(api.openMuxCount).toBe(1) // the dead generation's stream is gone, exactly one live
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
    // stop() aborts the live generation (streams tear down) and no reconnect follows.
    await vi.waitFor(() => { expect(api.openMuxCount).toBe(0) })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(api.openMuxCount).toBe(0)
  })

  it('treats describe failure as generation failure and retries', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls === 1 ? Promise.reject(new Error('host down')) : gate.promise
    }
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(2) }) // retried after backoff
      expect(connected).toBe(0) // never announced during the failed generation
      gate.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('treats a host.describe business error as generation failure', async () => {
    const api = new FakeApiClient()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls += 1
      if (describeCalls === 1) {
        return Promise.resolve({
          rpcId: 'bad-describe' as never,
          result: {
            ok: false as const,
            error: { code: 'internal' as const, message: 'not ready', details: {} },
          },
        })
      }
      return Promise.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
    }
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('converges stream/error frames into reconnect instead of dispatching them', async () => {
    const api = new FakeApiClient()
    const muxSeen: string[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, {
      onMuxEnvelope: envelope => muxSeen.push(envelope.payload.type),
      onConnected: () => { connected++ },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      api.pushMux({ type: 'stream/error', error: { code: 'internal', message: 'impl broke', details: {} } })
      await vi.waitFor(() => { expect(connected).toBe(2) }) // treated as loss → reconnect
      expect(muxSeen).toEqual([]) // never forwarded to the business sink
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('isolates sink exceptions from the pump', async () => {
    const api = new FakeApiClient()
    const seen: string[] = []
    let connected = 0
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, {
      onMuxEnvelope: (envelope) => {
        seen.push(envelope.payload.type)
        throw new Error('business layer bug')
      },
      onConnected: () => { connected++ },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      api.pushMux(subscribedFrame(1))
      api.pushMux(subscribedFrame(2))
      await vi.waitFor(() => { expect(seen).toHaveLength(2) }) // second frame still pumped
      expect(connected).toBe(1) // no reconnect triggered by the sink throw
    } finally {
      controller.stop()
      errorSpy.mockRestore()
    }
  })

  it('holds onConnected until both streams establish even after describe succeeds', async () => {
    const api = new FakeApiClient()
    api.holdStreamOpen = true // describe resolves immediately; stream establishment is in the case's hand
    let connected = 0
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.callsOf('host.describe')).toHaveLength(1) })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(connected).toBe(0) // describe alone must not announce
      api.releaseStreamOpens()
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
    }
  })

  it('rejects a generation whose streams end during readiness and retries', async () => {
    const api = new FakeApiClient()
    const firstDescribe = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls === 1
        ? firstDescribe.promise
        : Promise.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
    }
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.openMuxCount).toBe(1) })
      api.endStreams()
      firstDescribe.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))

      await vi.waitFor(() => { expect(describeCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['reconnecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('proceeds as connected via the timeout guard when a carrier never fires onOpen', async () => {
    const api = new FakeApiClient()
    api.suppressStreamOpen = true // misbehaving carrier: streams open but onOpen never fires
    let connected = 0
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, { ...FAST, streamOpenTimeoutMs: 20 })
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) }) // handshake resolved by the guard, not wedged
    } finally {
      controller.stop()
    }
  })

  it('emits deduplicated connected/reconnecting state transitions', async () => {
    const api = new FakeApiClient()
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['connected'])
      api.failStreams(new Error('torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) })
      expect(states).toEqual(['connected', 'reconnecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('does not announce a generation stopped synchronously by its connected state sink', async () => {
    const api = new FakeApiClient()
    const states: ConnectionState[] = []
    let connected = 0
    const controller = new ConnectionController(api, {
      onConnected: () => { connected++ },
      onStateChange: (state) => {
        states.push(state)
        if (state === 'connected') controller.stop()
      },
    }, FAST)

    controller.start()
    await vi.waitFor(() => { expect(states).toEqual(['connected']) })
    await vi.waitFor(() => { expect(api.openMuxCount).toBe(0) })
    expect(connected).toBe(0)
  })

  it('deduplicates consecutive reconnecting emissions across two straight failures', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls <= 2 ? Promise.reject(new Error('down')) : gate.promise
    }
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(3) })
      gate.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['reconnecting', 'connected']) // two failures, one reconnecting emission
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('runs with no sinks at all (every callback slot optional)', async () => {
    const api = new FakeApiClient()
    const controller = new ConnectionController(api, {}, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.callsOf('host.describe')).toHaveLength(1) })
      api.pushMux(subscribedFrame()) // pumped with sink undefined: dropped silently
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      controller.stop()
    }
  })

  it('start() is idempotent (one loop, one stream set)', async () => {
    const api = new FakeApiClient()
    let connected = 0
    const controller = new ConnectionController(api, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(api.openMuxCount).toBe(1)
      expect(api.callsOf('host.describe')).toHaveLength(1)
    } finally {
      controller.stop()
    }
  })
})
