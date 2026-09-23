/** Stream ownership follows the consumer fiber across dependency restarts. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
})

describe('connection consumer lifecycle', () => {
  it('reconnects a restarted Cordis consumer and keeps the new owner after stale cleanup', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', search: '?fixture' })
    const ctx = new Context()
    context = ctx
    await ctx.plugin({ apply })
    const connection = ctx.get('connection') as ConnectionHandle
    const connected: number[] = []
    const loops: ReturnType<ConnectionHandle['start']>[] = []
    let generation = 0
    const consumer = ctx.inject(['connection'], (scope) => {
      const current = ++generation
      const connectionScope = scope as Context & { connection: ConnectionHandle }
      const loop = connectionScope.connection.start({ onConnected: () => { connected.push(current) } })
      loops.push(loop)
      scope.effect(() => () => { loop.stop() }, 'test: consumer stream')
    })
    await consumer
    await vi.waitFor(() => { expect(connected).toEqual([1]) })

    await consumer.restart()
    await vi.waitFor(() => { expect(connected).toEqual([1, 2]) })
    expect(connection.hostDescription.getSnapshot()?.canOpenPath).toBe(true)

    loops[0]!.stop()
    expect(connection.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    expect(() => connection.start({})).toThrow(/already owned by another consumer/)

    await consumer.dispose()
    expect(connection.hostDescription.getSnapshot()).toBeUndefined()
  })
})
