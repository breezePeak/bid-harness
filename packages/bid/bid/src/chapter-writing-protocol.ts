/** S5 执行私有工具：调用者隔离、可恢复参数错误及权威结果确认。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolArgsError, type ToolDefinition, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z, ZodError } from 'zod'

/**
 * 将参数解析错误转换为当前回合可纠正的工具错误。
 * @param schema 当前工具的参数解析器。
 * @param value 模型参数。
 * @returns 已解析参数；格式错误允许当前回合纠正。
 */
export function chapterToolArgs<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    if (!(error instanceof ZodError)) throw error
    throw new ToolArgsError(error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`))
  }
}

/** 一次 planning、Writer 或 Reviewer 执行的工具及已提交结果。 */
export interface ChapterProtocol<T> {
  /**
   * 读取经过权威工具结果确认的提交。
   * @returns 权威工具结果已确认的结果；失败或未提交时为 undefined。
   */
  captured(): T | undefined
  /**
   * 注册当前 Agent 私有的工具及参数检查。
   * @param definition 本次执行私有的工具定义。
   */
  register(definition: Omit<ToolDefinition, 'output'>): void
  /**
   * 暂存完整结果并请求结束当前回合。
   * @param exec 本次 finish 的真实调用。
   * @param value 校验通过的完整结果。
   * @returns 待权威结果确认的完成回执。
   */
  finish(exec: ToolRunContext, value: T): { completed: true }
  /** 清除本轮提交并开始下一轮；旧调用不能提交到新轮次，已释放注册不会重新启用。 */
  nextRound(): void
  /** 释放全部注册，并禁止尚未完成的工具发布结果。 */
  dispose(): void
}

/**
 * 将 S5 私有工具绑定到一个真实 Agent；Child scope 同时拥有所有注册。
 * @param agent 唯一允许调用的 Agent。
 * @param finishName 本次协议的完成工具。
 * @param maxContinuations 普通文本结束但未提交时，同一 Child 的最大续行次数。
 * @returns 执行私有工具注册及提交句柄。
 */
export function createChapterProtocol<T>(agent: Agent, finishName: string, maxContinuations: number): ChapterProtocol<T> {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('S5 requires tools service')
  let staged = new WeakMap<ToolExecution, T>()
  const executionRounds = new WeakMap<ToolRunContext, number>()
  let round = 0
  let pending: { parent: ToolExecution['token']; value: T } | undefined
  let captured: T | undefined
  let disposed = false
  let continuations = 0
  const disposers: Array<() => void> = []
  const ensureOpen = (exec: ToolRunContext): void => {
    if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
    exec.signal.throwIfAborted()
    if (disposed || captured !== undefined || pending !== undefined) throw new ToolArgsError(['本次提交已结束。'])
  }
  disposers.push(tools.guard(exec => disposed || captured !== undefined || pending !== undefined
    ? `S5 提交已结束，不能执行 ${exec.name}。` : undefined))
  disposers.push(agent.ctx.on('tools/result', (exec, result) => {
    if (disposed || exec.agent !== agent) return
    const value = staged.get(exec)
    if (value !== undefined) {
      staged.delete(exec)
      if (result.isError || exec.signal.aborted) return
      if (exec.parent === undefined) captured = value
      else pending = { parent: exec.parent, value }
      return
    }
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (!result.isError && !exec.signal.aborted) captured = entry.value
  }))
  disposers.push(agent.ctx.on('agent/turn-stopping', ({ signal }) => {
    if (disposed || captured !== undefined || signal.aborted || continuations >= maxContinuations) return
    continuations++
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `尚未完成 ${finishName}。已接受的记录仍保留；请补齐缺项、修正具体错误并调用 ${finishName}。普通文本不能完成提交。` }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }))
  }))
  return {
    captured: () => captured,
    register(definition) {
      disposers.push(tools.register({
        ...definition,
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        presentCall: () => ({ card: 'generic', title: definition.name }),
        async execute(args, exec) {
          ensureOpen(exec)
          executionRounds.set(exec, round)
          return definition.execute(args, exec)
        },
      }))
    },
    finish(exec, value) {
      ensureOpen(exec)
      if (executionRounds.get(exec) !== round) throw new ToolArgsError(['该调用所属的提交轮次已结束。'])
      staged.set(exec, value)
      exec.concludeTurn()
      return { completed: true }
    },
    nextRound() {
      round++
      staged = new WeakMap()
      pending = undefined
      captured = undefined
      continuations = 0
    },
    dispose() {
      disposed = true
      pending = undefined
      for (const dispose of disposers.reverse()) dispose()
      disposers.length = 0
    },
  }
}
