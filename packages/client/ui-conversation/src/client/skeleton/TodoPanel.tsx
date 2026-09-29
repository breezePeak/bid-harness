import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { PlanListPanel, type PlanListLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'

export interface TodoPanelProps {
  /** The session's current multi-step plan; hidden after completion or when the agent stops. */
  todos: readonly TodoItem[]
  /** Whether the owning agent is currently running. */
  running: boolean
  /** The dock entry's locale seat, passed down as a plain prop. */
  t: TodoDockProps['t']
}

export function TodoPanel({ todos, running, t }: TodoPanelProps) {
  if (!running || todos.length < 2 || todos.every(item => item.status === 'completed')) return null
  const labels: PlanListLabels = {
    title: t('todo.title'),
    completed: count => t('todo.progress.done', { done: count }),
    active: count => t('todo.progress.active', { active: count }),
    unfinished: count => t('todo.progress.unfinished', { active: count }),
    pending: count => t('todo.progress.pending', { pending: count }),
  }
  return <PlanListPanel
    items={todos.map(item => ({ key: item.content, content: item.content, status: item.status }))}
    running={running}
    labels={labels}
    testId="todo-panel"
  />
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type TodoDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'conversation'>

/** Dock adapter: combines the Host-computed list with the authoritative agent-running bit. */
export function TodoDock({ useProjection, useSession, t }: TodoDockProps) {
  const todos = useProjection('todos')
  const running = useSession(session => session.running)
  return <TodoPanel todos={todos ?? []} running={running} t={t} />
}

/**
 * The plan strip as a plain registrant plugin (QueueDock posture), following
 * the input-dock declaration across independent activation and reload.
 */
export const todoDockEntry = {
  name: 'conversation-todo-dock',
  inject: ['slots'],
  /**
   * Register the plan strip before the goal and queue entries (order 0).
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({ name: 'conversation.input.dock', id: 'todo', order: 0, locale: NS }, TodoDock))
  },
}
