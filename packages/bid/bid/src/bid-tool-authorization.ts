/** Bid 公开工具只接纳当前用户 turn 或原生 Driver 接纳的当前 Goal 轮次。 */
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { Session } from '@deepseek-ai/dsh-session'

/** 消息引用保持与持久 Work 和队列相同的结构。 */
type Authorization = { session_id: string; message_id: string }
/**
 * 从当前未结束 turn 解析授权，Goal 必须属于精确 live Main Agent。
 * @param subject 工具调用者；Host 内部接纳直接用户消息时可传其 Session。
 * @returns 当前授权；没有合法输入时返回 undefined。
 */
export function resolveBidToolAuthorization(subject: Agent | Session): Authorization | undefined {
  const agent = 'session' in subject ? subject : undefined
  const session = agent?.session ?? subject as Session
  if (agent !== undefined) {
    const registry = agent.ctx.get('agents')
    if (registry?.get(agent.id) !== agent || session.header.origin === 'subagent'
      || resolveSessionPreset(session) !== 'bid' || session.header.cwd === undefined) return
  }
  const goal = agent?.status === 'running' && agent.ctx.get('agents')?.currentInitiator() === agent
    ? agent.ctx.get('goals')?.get(agent) : undefined
  const boundary = session.events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (session.events[boundary]?.type !== 'turn/start') return
  const message = session.events.slice(boundary + 1).findLast(event => event.type === 'user/message'
    && (event.data.source.kind === 'user'
      || (event.data.source.kind === 'goal' && goal?.phase === 'active' && goal.activation === 'armed'
        && event.data.source.round > 0 && event.data.source.goalId === goal.id
        && event.data.source.revision === goal.revision && event.data.source.round === goal.roundsStarted)))
  if (message?.type === 'user/message') return { session_id: String(session.id), message_id: String(message.data.id) }
}

/**
 * 校验已经接纳的消息引用；历史 Goal 消息只能重放已保存 Work，不能授予新工具调用权限。
 * @param session 拥有原始消息的会话。
 * @param authorization 持久化消息引用。
 * @returns 消息属于用户或已记录的原生 Goal 轮次时返回 true。
 */
export function hasBidTaskAuthorization(session: Session, authorization: Authorization): boolean {
  if (authorization.session_id !== String(session.id)) return false
  const index = session.events.findIndex(event => event.type === 'user/message'
    && String(event.data.id) === authorization.message_id)
  const message = session.events[index]
  if (message?.type !== 'user/message') return false
  const source = message.data.source
  if (source.kind === 'user') return true
  if (source.kind !== 'goal' || source.round <= 0) return false
  const change = session.events.slice(0, index).findLast(event => event.type === 'goal/change')
  return change?.type === 'goal/change' && change.data.operation !== 'clear'
    && change.data.goal.id === source.goalId && change.data.goal.revision === source.revision
    && change.data.goal.phase === 'active'
}
