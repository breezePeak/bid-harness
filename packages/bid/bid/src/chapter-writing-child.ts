/** 同一章节 Writer 的可续写会话、逐轮提交与取消清理。 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import { chapterWriterOutputSchema } from './chapter-writing-writer.ts'

/** 一个章节独占的 Writer；修复保留会话，提交状态每轮重建。 */
export interface ChapterWriterChild {
  /** 初次写作和所有修复共用的持久化会话身份。 */
  readonly id: SessionId
  /**
   * 提交初始任务或修复意见，等待本轮结束及私有工具的权威结果。
   * @param prompt 本轮章节任务。
   * @returns 本轮停止原因及成功提交的候选。
   */
  run(prompt: string): Promise<SubagentResult>
  /** 取消并等待 Writer 静止，再释放私有注册；历史会话保留。 */
  dispose(): Promise<void>
}

/** 等待独占 Writer 的本轮日志；开始前的 idle 与旧 turn/end 不算本轮完成。 */
async function waitForWriterTurn(parent: Agent, child: Agent, eventStart: number, signal: AbortSignal): Promise<SessionEvent<'turn/end'>> {
  signal.throwIfAborted()
  let lift = () => {}
  let onAbort = () => {}
  try {
    const end = await new Promise<SessionEvent<'turn/end'>>((resolve, reject) => {
      onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('S5 Writer 已取消。')) }
      const inspect = () => {
        const events = child.session.events.slice(eventStart)
        const end = events.find(event => event.type === 'turn/end')
        if (end !== undefined) resolve(end)
        else if (events.some(event => event.type === 'agent/inbox/spliced'
          && event.data.outcome === 'canceled' && event.data.inserted.length === 0)) {
          reject(new Error('S5 Writer 本轮输入已取消。'))
        }
      }
      lift = parent.ctx.on('session/event', (session) => { if (session === child.session) inspect() }, { global: true })
      signal.addEventListener('abort', onAbort, { once: true })
      inspect()
    })
    // turn/end 在驱动完全静止前发布；下一轮只能在私有工具退出后进入。
    await child.whenIdle()
    signal.throwIfAborted()
    return end
  } finally {
    lift()
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 为一个章节建立独立可续写 Writer，首个请求前安装逐轮提交工具。
 * @param parent 直接调度此章节的 Agent。
 * @param label 历史列表中的稳定章节名称。
 * @param maxContinuations 缺少提交时同轮补充提示的上限。
 * @param validate 验证候选引用；可纠正错误由工具返回给原 Writer。
 * @param signal 章节所属阶段的取消信号。
 * @param existingId 已完成章节的原 Writer 身份；只恢复原会话，不能创建替代会话。
 * @returns 由调用方 finally 释放的章节 Writer。
 */
export function createChapterWriterChild(
  parent: Agent, label: string, maxContinuations: number,
  validate: (child: Agent, value: unknown) => Promise<void>, signal: AbortSignal, existingId?: SessionId,
  chapterTitle?: string,
): ChapterWriterChild {
  const subagents = parent.ctx.get('subagents')
  if (subagents === undefined) throw new Error('S5 requires subagents service')
  const id = existingId ?? SessionId(randomUUID())
  let child: Agent | undefined
  let started = existingId !== undefined
  let runtime: ChapterProtocol<unknown> | undefined
  let eventStart = 0
  const install = (agent: Agent) => {
    runtime?.dispose()
    child = agent
    eventStart = agent.session.events.length
    if (chapterTitle) {
      const titles = parent.ctx.get('sessionTitle')
      if (titles !== undefined) {
        try { titles.rename(agent.session, chapterTitle) } catch {}
      } else {
        try {
          agent.session.append('session/title', {
            title: chapterTitle,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        } catch {}
      }
    }
    const round = createChapterProtocol<unknown>(agent, 'submit_chapter', maxContinuations)
    runtime = round
    round.register({
      name: 'submit_chapter', description: '提交当前章节完整正文和资料使用记录。引用错误可在本轮修正；成功后等待审查意见。',
      parameters: { ...chapterWriterOutputSchema },
      async execute(args, exec) {
        await validate(agent, args)
        exec.signal.throwIfAborted()
        return round.finish(exec, args)
      },
    })
  }
  const liftSetup = subagents.registerContinuableSetup((childContext) => {
    const agent = childContext.agent as Agent
    if (agent.id !== id || agent.session.header.parentSession !== parent.id) return () => {}
    install(agent)
    return () => { runtime?.dispose() }
  })
  const resident = parent.ctx.agents.get(id)
  if (resident !== undefined) install(resident)
  return {
    id,
    async run(prompt) {
      signal.throwIfAborted()
      if (!started) {
        await subagents.startContinuable({
          provider: 'spawn', childId: id, label, signal,
          request: {
            parent, prompt: [{ type: 'text', text: prompt }], maxDepth: 1,
            toolFilter: { allow: ['grep', 'read', 'web_search', 'web_fetch'] },
            persona: '你是技术标章节写作 Subagent。只写指定章节；通过 submit_chapter 提交候选，并在本会话根据审查意见修改。',
          },
        })
        started = true
      } else {
        runtime?.nextRound()
        eventStart = child?.session.events.length ?? 0
        await subagents.followup(parent, id, [{ type: 'text', text: prompt }], {
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' }, signal,
        })
      }
      if (child === undefined || runtime === undefined) throw new Error('S5 Writer 缺少逐轮提交工具。')
      const end = await waitForWriterTurn(parent, child, eventStart, signal)
      const reason = end.data.reason
      switch (reason.kind) {
        case 'completed': return { stopReason: 'completed', output: [], structured: runtime.captured() }
        case 'aborted': return { stopReason: 'aborted', output: [] }
        case 'max-tokens': return { stopReason: 'max-tokens', output: [] }
        case 'blocked': return { stopReason: 'refusal', output: [] }
        case 'error': {
          const code = /^[A-Za-z0-9_.:-]{1,128}$/u.test(reason.error.code) ? reason.error.code : 'UNKNOWN'
          return { stopReason: 'error', output: [], diagnostic: `章节模型回合失败（${code}）。` }
        }
        // TurnEndReason 可由插件扩展；未完成回合不能作为成功提交。
        default: return { stopReason: 'error', output: [], diagnostic: '章节回合未正常完成。' }
      }
    },
    async dispose() {
      try { await subagents.drainContinuableChildren(parent, [id]) } finally {
        runtime?.dispose()
        liftSetup()
      }
    },
  }
}
