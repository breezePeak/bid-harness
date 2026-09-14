import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { BidRunContext } from './run-coordinator.ts'

/** Execution Agent 私有任务的完成协议。 */
export interface MainAgentPrivateRuntime<T> {
  /** 返回已经由私有完成工具确认的结果。 */
  captured(): T | undefined
  /** 判断自动续行是否属于当前私有任务。 */
  ownsMessage(message: UserMessage): boolean
  /** 在模型组装下一次请求前挂载或卸载私有工具。 */
  setToolsEnabled(enabled: boolean): void
}

/** Execution Agent 内部任务的工具约束。 */
export interface MainAgentProtocolOptions {
  /** 当前内部任务独占的工具名。 */
  privateTools: readonly string[]
  /** 内部任务允许调用的完整工具集合；省略时由阶段自己的 guard 约束。 */
  internalTools?: readonly string[] | undefined
  /** 切换私有工具的模型可见性。 */
  setPrivateToolsEnabled?: ((enabled: boolean) => void) | undefined
  /** guard 诊断中的阶段任务名称。 */
  label: string
}

/** 已安装的 Execution Agent 私有任务边界。 */
export interface MainAgentProtocol {
  /** 把一条将要进入 inbox 的消息登记为当前任务。 */
  own(message: UserMessage): void
  /** 移除仍在等待的当前任务消息。 */
  discardOwnedInbox(): void
  /** 释放工具限制与可见性切换。 */
  dispose(): void
}

/**
 * 限制 Execution Agent 只调用当前内部任务允许的工具。
 * @param agent 只执行 Host 内部任务的 Execution Agent。
 * @param options 私有工具与内部工具集合。
 * @returns 当前内部任务的消息登记与释放句柄。
 */
export function installMainAgentProtocol(
  agent: Agent,
  options: MainAgentProtocolOptions,
): MainAgentProtocol {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error(`${options.label} requires tools service`)
  const owned = new Set<string>()
  const privateNames = new Set(options.privateTools)
  const internalNames = options.internalTools === undefined ? undefined : new Set(options.internalTools)
  let disposed = false

  const discardOwnedInbox = (): void => {
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (owned.has(String(message.id))) agent.inbox.remove(message.id)
    }
  }
  options.setPrivateToolsEnabled?.(true)

  const liftGuard = tools.guard((exec) => {
    if (exec.agent !== agent) return
    if (privateNames.has(exec.name)) return
    if (internalNames !== undefined && !internalNames.has(exec.name)) {
      return `${options.label} 内部任务回合只允许当前阶段工具。`
    }
  })

  return {
    own(message) { owned.add(String(message.id)) },
    discardOwnedInbox,
    dispose() {
      if (disposed) return
      disposed = true
      discardOwnedInbox()
      options.setPrivateToolsEnabled?.(true)
      liftGuard()
    },
  }
}

/**
 * 运行一个必须通过私有完成工具提交结果的 Main Agent 任务。
 * @param agent 只执行 Host 内部任务的 Execution Agent。
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
  const protocol = installMainAgentProtocol(agent, {
    privateTools,
    internalTools: privateTools,
    setPrivateToolsEnabled: (enabled) => { runtime.setToolsEnabled(enabled) },
    label,
  })
  protocol.own(message)
  const unbindMainAgent = run?.bindMainAgent({
    cancel: () => { agent.cancel({ kind: 'hook', reason: 'bid-run-suspended' }, { keepInbox: true }) },
    whenIdle: () => agent.whenIdle(),
    discardOwnedInbox: () => { protocol.discardOwnedInbox() },
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
    protocol.dispose()
  }
}
