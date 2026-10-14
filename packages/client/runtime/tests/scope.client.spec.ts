/**
 * Agent-scope primitive spec: the actx minted by createScope carries the
 * tag and the dispatch filter itself, so plain cordis dispatch with the actx
 * as subject routes by agent — same-agent tagged listeners receive,
 * foreign-agent ones are filtered out, untagged listeners hear everything,
 * and a subject-less root dispatch stays unfiltered. Scope-owned listeners
 * dispose with the fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createScope, scopeOf, type AgentContext } from '../src/client/agents/scope.ts'
import type { ClientContext } from '../src/client/index.ts'
import type { ISessions } from '../src/client/contract/sessions.ts'

const sid = (k: string): SessionId => k as SessionId

/**
 * 客户端会话服务与作用域访问的编译期契约。
 * @param ctx 客户端上下文。
 */
function clientSessionContracts(ctx: ClientContext): void {
  expectTypeOf(ctx.sessions).toEqualTypeOf<ISessions>()
  expectTypeOf(ctx.get('sessions')).toEqualTypeOf<ISessions | undefined>()
  expectTypeOf(ctx.sessions.scope(sid('a'))).toEqualTypeOf<AgentContext | undefined>()
  expectTypeOf<'get' extends keyof ClientContext['sessions'] ? true : false>().toEqualTypeOf<false>()
  // @ts-expect-error -- 作用域必须接收程序绑定的会话身份。
  ctx.sessions.scope('plain-session')
}
void clientSessionContracts

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only routed probe event.
     * @param payload - marker payload.
     * @mode bail
     */
    'test/scope-probe'(payload: { from: string }): true | undefined
  }
}

function bench() {
  const root = new Context()
  const a = createScope(root, sid('a'))
  const b = createScope(root, sid('b'))
  const seen: string[] = []
  const listen = (label: string, ctx: Context, answer?: true) => {
    ctx.on('test/scope-probe', (payload) => {
      seen.push(`${label}:${payload.from}`)
      return answer
    })
  }
  return { root, a, b, seen, listen }
}

describe('createScope', () => {
  it('tags the ctx (scopeOf) and leaves the root untagged', () => {
    const { root, a } = bench()
    expect(scopeOf(a.ctx)).toBe(sid('a'))
    expect(scopeOf(root)).toBeUndefined()
  })

  it('scoped dispatch reaches same-session and untagged listeners, never a foreign session', () => {
    const { root, a, b, seen, listen } = bench()
    listen('a', a.ctx)
    listen('b', b.ctx)
    listen('root', root)
    a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })
    expect(seen).toEqual(['a:a', 'root:a'])
    seen.length = 0
    b.ctx.emit(b.ctx, 'test/scope-probe', { from: 'b' })
    expect(seen).toEqual(['b:b', 'root:b'])
  })

  it('bail answers the first same-scope listener and skips filtered foreign ones', () => {
    const { a, b, listen } = bench()
    listen('b', b.ctx, true) // registered first, but foreign → filtered out
    expect(a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })).toBeUndefined()
    listen('a', a.ctx, true)
    expect(a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })).toBe(true)
  })

  it('a subject-less root dispatch is unfiltered (every listener hears it)', () => {
    const { root, a, b, seen, listen } = bench()
    listen('a', a.ctx)
    listen('b', b.ctx)
    listen('root', root)
    root.emit('test/scope-probe', { from: 'root' })
    expect(seen).toEqual(['a:root', 'b:root', 'root:root'])
  })

  it('fiber disposal removes scope-owned listeners', async () => {
    const { a, seen, listen } = bench()
    listen('a', a.ctx)
    await a.fiber.dispose()
    a.ctx.emit(a.ctx, 'test/scope-probe', { from: 'late' })
    expect(seen).toEqual([])
  })
})
