/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

const selections = new WeakMap<Context, ModelSelectionRef>()

/**
 * 读取当前 Agent 已选择的模型，不等待下一次对话组装。
 * @param agentCtx 安装模型选择的 Agent 上下文。
 * @returns 当前选择的副本；未安装或未选择时为 undefined。
 */
export function currentModelSelection(agentCtx: Context): ModelSelection | undefined {
  const selected = selections.get(agentCtx)?.current
  return selected === undefined ? undefined : { ...selected }
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns 卸载当前选择记录及两个作用域监听器的函数。
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const disposeSelection = () => {
    if (selections.get(agentCtx) === selection) selections.delete(agentCtx)
  }
  agentCtx.effect(() => {
    selections.set(agentCtx, selection)
    return disposeSelection
  })
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    disposeSelection()
    disposeAssembly()
    disposeRequest()
  }
}
