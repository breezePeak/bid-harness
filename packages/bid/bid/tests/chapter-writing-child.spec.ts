import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createChapterWriterChild } from '../src/chapter-writing-child.ts'

describe('S5 reused Writer policy', () => {
  it('恢复已有 Writer 时也安装 no-web guard', async () => {
    const writerId = SessionId('writer-existing')
    const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
    const tools = {
      guard: vi.fn((guard: (execution: Readonly<ToolExecution>) => string | undefined) => {
        guards.push(guard)
        return () => {}
      }),
      register: vi.fn(() => () => {}),
    }
    const listeners = new Map<string, (...args: never[]) => void>()
    const child = {
      id: writerId,
      session: { events: [], header: { parentSession: 'parent' } },
      ctx: {
        get: (name: string) => name === 'tools' ? tools : undefined,
        on: (name: string, listener: (...args: never[]) => void) => {
          listeners.set(name, listener)
          return () => { listeners.delete(name) }
        },
      },
    } as unknown as Agent
    const subagents = {
      registerContinuableSetup: vi.fn(() => () => {}),
      drainContinuableChildren: vi.fn(async () => {}),
    }
    const parent = {
      id: SessionId('parent'),
      ctx: {
        get: (name: string) => name === 'subagents' ? subagents : undefined,
        agents: { get: (id: SessionId) => id === writerId ? child : undefined },
      },
    } as unknown as Agent

    const writer = createChapterWriterChild(
      parent,
      '已有章节 Writer',
      0,
      async () => {},
      new AbortController().signal,
      writerId,
      undefined,
      false,
    )

    expect(guards.some(guard => guard({ name: 'web_search' } as ToolExecution) === 'BID_WEB_ACCESS_DISABLED')).toBe(true)
    expect(guards.some(guard => guard({ name: 'web_fetch' } as ToolExecution) === 'BID_WEB_ACCESS_DISABLED')).toBe(true)
    expect(guards.every(guard => guard({ name: 'read' } as ToolExecution) === undefined)).toBe(true)
    await writer.dispose()
    expect(subagents.drainContinuableChildren).toHaveBeenCalledWith(parent, [writerId])
  })
})
