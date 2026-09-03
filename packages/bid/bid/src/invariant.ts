/** Bid 项目恢复事件的修订号单调关系。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './bid-events.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-bid'
export const name = 'bid-invariant'
export const inject = ['invariants']
/** 每个 Session 可重复接收同一修订，但不能回退到更早的项目状态。 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'bid.project.resumed') return
    const previous = session.events.findLast(item => item.type === 'bid.project.resumed')
    if (previous !== undefined && event.data.revision < previous.data.revision) {
      fail(`Bid 项目修订号不能从 ${previous.data.revision} 回退到 ${event.data.revision}。`)
    }
  }, { global: true })
}
/** Register the package companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
