import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { BidRunContext } from './run-coordinator.ts'

/** 私有 Main Agent 任务在公开用户回合之间切换工具面的运行时。 */
export interface MainAgentPrivateRuntime<T> {
  /** 返回已经由私有完成工具确认的结果。 */
  captured(): T | undefined
  /** 判断自动续行是否属于当前私有任务。 */
  ownsMessage(message: UserMessage): boolean
  /** 在模型组装下一次请求前挂载或卸载私有工具。 */
  setToolsEnabled(enabled: boolean): void
}

/** 一个正在交错执行的 Main Agent 内部任务。 */
export interface MainAgentInterleaveOptions {
  /** 当前内部任务独占的工具名。 */
  privateTools: readonly string[]
  /** 内部任务允许调用的完整工具集合；省略时由阶段自己的 guard 约束。 */
  internalTools?: readonly string[] | undefined
  /** 判断阶段运行时生成的自动消息是否属于当前内部任务。 */
  ownsMessage?: ((message: UserMessage) => boolean) | undefined
  /** 切换私有工具的模型可见性。 */
  setPrivateToolsEnabled?: ((enabled: boolean) => void) | undefined
  /** 用户在未完成工具链中插话后使用的恢复提示。 */
  resumePrompt?: string | undefined
  /** 判断当前工具链是否已经完成，避免排入多余恢复提示。 */
  isInternalComplete?: (() => boolean) | undefined
  /** guard 诊断中的阶段任务名称。 */
  label: string
}

/** 已安装的内部任务与公开用户回合交错边界。 */
export interface MainAgentInterleave {
  /** 把一条将要进入 inbox 的消息标记为当前内部任务。 */
  own(message: UserMessage): void
  /** Remove still-pending private messages without touching user steering. */
  discardOwnedInbox(): void
  /** 释放监听器、限制和工具可见性切换。 */
  dispose(): void
}

function previousStepNeedsResume(agent: Agent): boolean {
  const previous = agent.session.events.findLast(event => event.type === 'assistant/message')
  return previous?.data.message.content.some(block => block.type === 'tool-call') === true
}

/**
 * 在同一个 Main Agent 上隔离内部任务回合和公开用户回合。
 *
 * inbox claim 发生在 system prompt 与工具 schema 组装前，因此用户消息被 claim
 * 时先卸载私有工具，再由 pre-step 把同批内部消息退回下一回合。用户插入尚未
 * 完成的工具链时，只排入一条内部恢复提示，公开回复结束后再继续原任务。
 *
 * @param agent 正在执行阶段任务和用户对话的同一个 Main Agent。
 * @param options 私有工具、内部消息和恢复策略。
 * @returns 当前内部任务的消息登记与释放句柄。
 */
export function installMainAgentInterleave(
  agent: Agent,
  options: MainAgentInterleaveOptions,
): MainAgentInterleave {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error(`${options.label} requires tools service`)
  const owned = new Set<string>()
  const privateNames = new Set(options.privateTools)
  const internalNames = options.internalTools === undefined ? undefined : new Set(options.internalTools)
  let mode: 'internal' | 'user' | undefined
  let claimBoundary = ''
  let claimHasUser = false
  let publicRestriction: (() => void) | undefined
  let resumeQueued = false
  let disposed = false

  const owns = (message: UserMessage): boolean => owned.has(String(message.id)) || options.ownsMessage?.(message) === true
  const setMode = (next: 'internal' | 'user'): void => {
    if (mode === next) return
    if (next === 'user') {
      options.setPrivateToolsEnabled?.(false)
      publicRestriction ??= tools.restrict({ allow: [] })
    } else {
      publicRestriction?.()
      publicRestriction = undefined
      options.setPrivateToolsEnabled?.(true)
    }
    mode = next
  }
  const queueResume = (): void => {
    if (resumeQueued || options.resumePrompt === undefined || options.isInternalComplete?.() === true
      || !previousStepNeedsResume(agent)) return
    const message = createUserMessage({
      content: [{ type: 'text', text: options.resumePrompt }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    })
    owned.add(String(message.id))
    resumeQueued = true
    agent.inbox.append('next-turn', message)
  }

  const disposers = [
    tools.guard((exec) => {
      if (exec.agent !== agent) return
      if (privateNames.has(exec.name)) {
        return mode === 'internal' ? undefined : `${options.label} 私有工具只允许内部任务回合调用。`
      }
      if (mode === 'internal' && internalNames !== undefined && !internalNames.has(exec.name)) {
        return `${options.label} 内部任务回合只允许当前阶段工具。`
      }
    }),
    agent.ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject !== agent) return
      const prior = agent.session.events.findLast(event => event.type === 'step/end' && event.data.turn === turn)
      const priorStep = prior?.type === 'step/end' ? prior.data.step : 0
      const boundary = `${String(turn)}:${String(priorStep)}`
      if (claimBoundary !== boundary) {
        claimBoundary = boundary
        claimHasUser = false
      }
      if (message.source.kind === 'user') {
        const interrupted = mode === 'internal'
        claimHasUser = true
        setMode('user')
        if (interrupted) queueResume()
        return
      }
      if (!owns(message)) return
      resumeQueued = false
      if (!claimHasUser) setMode('internal')
    }),
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (payload.agent !== agent || decision.kind === 'reject') return decision
      const internal = decision.messages.filter(owns)
      if (decision.messages.some(message => message.source.kind === 'user')) {
        setMode('user')
        if (internal.length > 0) {
          for (const deferred of internal.reverse()) agent.inbox.prepend('next-turn', deferred)
          return { kind: 'enter' as const, messages: decision.messages.filter(message => !internal.includes(message)) }
        }
      } else if (internal.length > 0) setMode('internal')
      return decision
    }),
  ]

  return {
    own(message) { owned.add(String(message.id)) },
    discardOwnedInbox() {
      for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
        if (owned.has(String(message.id))) agent.inbox.remove(message.id)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      publicRestriction?.()
      publicRestriction = undefined
      options.setPrivateToolsEnabled?.(true)
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/**
 * 运行一个必须通过私有完成工具提交结果的 Main Agent 任务。
 * @param agent 任务与用户对话共用的 Main Agent。
 * @param prompt 内部任务提示。
 * @param privateTools 当前任务独占的私有工具。
 * @param runtime 私有完成协议。
 * @param run Host 阶段的执行所有权。
 * @param label 诊断所用任务名。
 * @returns 私有工具已确认的权威结果。
 */
export async function runMainAgentProtocol<T>(
  agent: Agent,
  prompt: string,
  privateTools: readonly string[],
  runtime: MainAgentPrivateRuntime<T>,
  run?: BidRunContext,
  label = 'Bid Main Agent',
): Promise<T> {
  const signal = run?.signal
  signal?.throwIfAborted()
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
  })
  const interleave = installMainAgentInterleave(agent, {
    privateTools,
    internalTools: privateTools,
    ownsMessage: value => runtime.ownsMessage(value),
    setPrivateToolsEnabled: (enabled) => { runtime.setToolsEnabled(enabled) },
    isInternalComplete: () => runtime.captured() !== undefined,
    label,
  })
  interleave.own(message)
  const unbindMainAgent = run?.bindMainAgent({
    cancel: () => { agent.cancel({ kind: 'hook', reason: 'bid-run-suspended' }, { keepInbox: true }) },
    whenIdle: () => agent.whenIdle(),
    discardOwnedInbox: () => interleave.discardOwnedInbox(),
  })
  const settled = Promise.withResolvers<T>()
  let finished = false
  const finish = (value: T): void => {
    if (finished) return
    finished = true
    settled.resolve(value)
  }
  const fail = (error: unknown): void => {
    if (finished) return
    finished = true
    settled.reject(error)
  }
  const inspect = (): void => {
    const value = runtime.captured()
    if (value !== undefined) finish(value)
  }
  const disposers = [
    agent.ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) fail(error) }),
    agent.ctx.on('tools/result', (exec) => { if (exec.agent === agent) queueMicrotask(inspect) }),
    agent.ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      queueMicrotask(() => {
        inspect()
        const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
          .some(value => value.id === message.id || runtime.ownsMessage(value))
        if (!finished && !queued) fail(new Error(`${label} 私有任务未成功提交。`))
      })
    }),
  ]
  const abort = (): void => {
    fail(signal?.reason instanceof Error ? signal.reason : new Error(`${label} 私有任务已取消。`))
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    agent.followup(message)
    void agent.whenIdle().catch(fail)
    return await settled.promise
  } finally {
    signal?.removeEventListener('abort', abort)
    unbindMainAgent?.()
    for (const dispose of disposers.reverse()) dispose()
    interleave.dispose()
  }
}
