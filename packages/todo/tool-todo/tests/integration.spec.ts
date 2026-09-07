import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL todo_write tool
 * through the agent loop, exercising the same execution paths a live model would — the
 * tool/call + tool/result session events AND the todo/write event the tool
 * appends. Only the model is mocked; the tool and the session log are real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('todo_write tool through the agent loop', () => {
  it('model calls todo_write: a tool/call, a non-error tool/result, and a todo/write snapshot land', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [
          { content: 'read the code', status: 'in_progress' },
          { content: 'write the fix', status: 'pending' },
        ],
      }, 'Planning the work.'),
      textResponse('Plan recorded.'),
      toolCallResponse('call-2', 'todo_write', {
        todos: [
          { content: 'read the code', status: 'completed' },
          { content: 'write the fix', status: 'pending' },
        ],
      }),
      textResponse('List reconciled.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan a two-step task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    expect(findEvent(log, 'tool/call').data.name).toBe('todo_write')
    expect(findEvent(log, 'tool/result').data.message.content[0].isError).toBe(false)

    const todoEvent = findEvent(log, 'todo/write')
    expect(todoEvent.data.todos).toEqual([
      { content: 'read the code', status: 'in_progress' },
      { content: 'write the fix', status: 'pending' },
    ])
    expect(findEvent(log, 'todo/write', 'last').data.todos).toEqual([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'pending' },
    ])
    expect(log.some(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === ToolTodo.name)).toBe(true)
  })

  it('a second todo_write replaces the list (last-write-wins on the log)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'step one', status: 'in_progress' }] }),
      toolCallResponse('call-2', 'todo_write', {
        todos: [
          { content: 'step one', status: 'completed' },
          { content: 'step two', status: 'pending' },
        ],
      }),
      textResponse('Paused after step one.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-2'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan then update' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const todoEvents = agent.session.events.filter(e => e.type === 'todo/write')
    expect(todoEvents).toHaveLength(2)
    expect(findEvent(agent.session.events, 'todo/write', 'last').data.todos).toEqual([
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'pending' },
    ])
  })

  it('reminds at most once per turn and does not revive an older turn plan', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [{ content: 'unfinished work', status: 'in_progress' }],
      }),
      textResponse('Stopping without reconciling.'),
      textResponse('Still stopping without reconciling.'),
      textResponse('A later turn does not reuse that plan.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-bounded'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'leave stale work' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start a separate turn' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const reminders = agent.session.events.flatMap(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === ToolTodo.name
        ? [event.data]
        : [])
    expect(reminders).toHaveLength(1)
    expect(JSON.stringify(reminders[0]?.content)).toContain('No item may remain in_progress')
    expect(adapter.requests).toHaveLength(4)
    expect(findEvent(agent.session.events, 'todo/write', 'last').data.todos).toEqual([
      { content: 'unfinished work', status: 'in_progress' },
    ])
  })

  it('does not spend a reconciliation request after a max-token truncation', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [{ content: 'continue later', status: 'in_progress' }],
      }),
      maxTokensResponse('truncated'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-max-tokens'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start work' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.some(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === ToolTodo.name)).toBe(false)
    expect(findEvent(agent.session.events, 'turn/end', 'last').data.reason).toEqual({ kind: 'max-tokens' })
  })
})
