import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createChapterWriterChild, createChapterWriterParentResolver } from '../src/chapter-writing-child.ts'
import { createParagraphRevisionWriterChild } from '../src/chapter-paragraph-revision-child.ts'

describe('S5 reused Writer policy', () => {
  it('并发续写两个原 Writer 时只恢复一次原父会话，并只释放本次恢复的父会话', async () => {
    const root = 'D:/test-project'
    const originalParent = { id: SessionId('original-parent'), session: { header: { cwd: root } } } as unknown as Agent
    const dispose = vi.fn(async () => {})
    const inspect = vi.fn(async (id: SessionId) => ({ meta: id === originalParent.id ? { cwd: root }
      : { cwd: root, origin: 'subagent', parentSession: originalParent.id }, events: [] }))
    const resume = vi.fn(async () => ({ agent: originalParent, dispose }))
    const current = { id: SessionId('new-execution'), ctx: {
      get: (name: string) => name === 'sessionPersistence' ? { inspect } : undefined,
      agents: { get: () => undefined, resume },
    } } as unknown as Agent
    const resolver = createChapterWriterParentResolver(current, root, new AbortController().signal)
    const parents = await Promise.all([resolver.resolve('writer-a'), resolver.resolve('writer-b')])
    expect(parents).toEqual([originalParent, originalParent])
    expect(resume).toHaveBeenCalledOnce()
    await resolver.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('持久 Writer 来自其他项目时不恢复父会话或续写', async () => {
    const resume = vi.fn()
    const current = { id: SessionId('current'), ctx: {
      get: () => ({ inspect: async () => ({ meta: { cwd: 'D:/other-project', origin: 'subagent', parentSession: SessionId('other') } }) }),
      agents: { get: () => undefined, resume },
    } } as unknown as Agent
    const resolver = createChapterWriterParentResolver(current, 'D:/test-project', new AbortController().signal)
    await expect(resolver.resolve('writer')).rejects.toThrow('BID_CHAPTER_REVISION_CONTEXT_UNAVAILABLE')
    expect(resume).not.toHaveBeenCalled()
    await resolver.dispose()
  })
  it('恢复已有 Writer 时也安装 no-web guard', async () => {
    const writerId = SessionId('writer-existing')
    const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
    const tools = {
      restrict: vi.fn(() => () => {}),
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
      session: { requestHeader: () => undefined }, options: {},
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
    expect(tools.restrict).toHaveBeenCalledWith({ allow: ['grep', 'read'] })
    for (const name of ['write', 'exec', 'terminal', 'run_code']) {
      expect(guards.some(guard => guard({ name } as ToolExecution) === 'BID_CHAPTER_WRITER_TOOL_DISABLED')).toBe(true)
    }
    await writer.dispose()
    expect(subagents.drainContinuableChildren).toHaveBeenCalledWith(parent, [writerId])
  })
})

describe('S5 paragraph revision Writer policy', () => {
  it('恢复原 Writer 时隐藏全部继承工具，只注册局部提交工具', async () => {
    const writerId = SessionId('paragraph-writer-existing')
    const definitions: string[] = []
    const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = []
    const tools = {
      restrict: vi.fn((restriction: { allow?: readonly string[]; deny?: readonly string[] }) => {
        restrictions.push(restriction)
        return () => {}
      }),
      guard: vi.fn(() => () => {}),
      register: vi.fn((definition: { name: string }) => {
        definitions.push(definition.name)
        return () => {}
      }),
    }
    const child = {
      id: writerId,
      session: { events: [], header: { parentSession: 'parent' } },
      ctx: {
        get: (name: string) => name === 'tools' ? tools : undefined,
        on: vi.fn(() => () => {}),
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

    const writer = createParagraphRevisionWriterChild(
      parent, '局部修订', writerId, ['SEG-0001'], new AbortController().signal,
    )

    expect(restrictions).toContainEqual({ allow: [] })
    expect(definitions).toEqual(['submit_paragraph_revision'])
    expect(definitions).not.toEqual(expect.arrayContaining(['submit_chapter', 'grep', 'read', 'web_search', 'web_fetch']))
    await writer.dispose()
  })
})
