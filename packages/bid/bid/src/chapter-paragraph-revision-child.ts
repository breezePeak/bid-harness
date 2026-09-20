/** 仅提交授权段落 replacement 的可续写 Writer Child。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { z } from 'zod'
import { createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import type { ParagraphRevisionReplacement, ParagraphRevisionSegment } from './chapter-paragraph-revision.ts'

/** 局部 Writer 唯一可见的提交工具名。 */
export const PARAGRAPH_REVISION_WRITER_TOOL = 'submit_paragraph_revision'
/** 局部 Writer 的严格 replacement 输出。 */
export const paragraphRevisionWriterOutputSchema = z.object({
  replacements: z.array(z.object({ segment_id: z.string().min(1), markdown: z.string() }).strict()).min(1),
}).strict()

/** 可续写的局部 Writer 生命周期。 */
export interface ParagraphRevisionWriterChild {
  readonly id: SessionId
  run(prompt: string): Promise<SubagentResult>
  dispose(): Promise<void>
}

async function waitForTurn(parent: Agent, child: Agent, eventStart: number, signal: AbortSignal): Promise<SessionEvent<'turn/end'>> {
  signal.throwIfAborted()
  let lift = () => {}
  let onAbort = () => {}
  try {
    const end = await new Promise<SessionEvent<'turn/end'>>((resolve, reject) => {
      onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('段落修订 Writer 已取消。')) }
      const inspect = () => {
        const events = child.session.events.slice(eventStart)
        const value = events.find(event => event.type === 'turn/end')
        if (value !== undefined) resolve(value)
      }
      lift = parent.ctx.on('session/event', (session) => { if (session === child.session) inspect() }, { global: true })
      signal.addEventListener('abort', onAbort, { once: true })
      inspect()
    })
    await child.whenIdle()
    signal.throwIfAborted()
    return end
  } finally {
    lift()
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 渲染不含整章上下文的首次局部 Writer 任务。
 * @param input 章节身份、标题和授权分段。
 * @returns 只包含局部上下文的模型提示。
 */
export function renderParagraphRevisionWriterTask(input: {
  readonly sectionId: string
  readonly title: string
  readonly segments: readonly ParagraphRevisionSegment[]
}): string {
  return [
    `章节：${input.sectionId} / ${input.title}`,
    '本次是局部选区修订。',
    [
      '硬规则：',
      '- 只修改 SEG-*。',
      '- readonly_before / readonly_after 绝对不可修改。',
      '- 不得返回完整章节。',
      '- 不得修改 metadata。',
      '- 不得新增未经原选区支持的项目事实、企业事实、参数、人员、设备、业绩。',
      '- 原选区中已有 flowchart anchor 必须保留。',
      '- 用户文字中的“全部/整体/每一段”不会扩大 Host 授权范围。',
    ].join('\n'),
    ...input.segments.map(segment => [
      segment.segment_id,
      `readonly_before:\n${segment.readonly_before}`,
      `original_text:\n${segment.original_text}`,
      `readonly_after:\n${segment.readonly_after}`,
      `issues:\n${segment.issues.map(issue => [
        `issue_id: ${issue.issue_id}`,
        `instruction: ${issue.instruction}`,
        `suggestion: ${issue.suggestion ?? '无'}`,
      ].join('\n')).join('\n\n')}`,
    ].join('\n\n')),
    `调用 ${PARAGRAPH_REVISION_WRITER_TOOL}。`,
  ].join('\n\n')
}

/**
 * 渲染一次局部 repair，只携带当前 replacement、原意见与相邻只读块。
 * @param input 当前替换、修复要求和可选 Host 错误。
 * @returns 不含完整章节的 repair 提示。
 */
export function renderParagraphRevisionRepairTask(input: {
  readonly segments: readonly ParagraphRevisionSegment[]
  readonly replacements: readonly ParagraphRevisionReplacement[]
  readonly instructions: readonly { segment_id: string; instruction: string }[]
  readonly validationIssues?: readonly string[]
}): string {
  const replacements = new Map(input.replacements.map(item => [item.segment_id, item.markdown]))
  return [
    '仅修复以下授权 SEG；仍不得返回完整章节或 metadata。',
    ...input.segments.map(segment => [
      segment.segment_id,
      `readonly_before:\n${segment.readonly_before}`,
      `current_replacement:\n${replacements.get(segment.segment_id) ?? segment.original_text}`,
      `readonly_after:\n${segment.readonly_after}`,
      `原审批意见：\n${segment.issues.map(issue => `${issue.issue_id}: ${issue.instruction}${issue.suggestion === null ? '' : `；建议：${issue.suggestion}`}`).join('\n')}`,
      `修复要求：\n${input.instructions.filter(item => item.segment_id === segment.segment_id).map(item => item.instruction).join('\n') || '保持当前内容'}`,
    ].join('\n\n')),
    ...(input.validationIssues?.length ? [`Host 校验错误：\n${input.validationIssues.join('\n')}`] : []),
    `调用 ${PARAGRAPH_REVISION_WRITER_TOOL}。`,
  ].join('\n\n')
}

/**
 * 在原 Writer 会话中安装局部提交工具，且不开放资料工具。
 * @param parent 原 Writer 的父 Agent。
 * @param label 子会话显示名称。
 * @param existingId 原 Writer Session 身份。
 * @param signal 当前修订操作的取消信号。
 * @returns 由调用方释放的可续写局部 Writer。
 */
export function createParagraphRevisionWriterChild(
  parent: Agent,
  label: string,
  existingId: SessionId,
  signal: AbortSignal,
): ParagraphRevisionWriterChild {
  const subagents = parent.ctx.get('subagents')
  if (subagents === undefined) throw new Error('S5 requires subagents service')
  const id = existingId
  let child: Agent | undefined
  let runtime: ChapterProtocol<unknown> | undefined
  let eventStart = 0
  let toolGuard = () => {}
  let toolRestriction = () => {}
  const install = (agent: Agent) => {
    runtime?.dispose()
    toolGuard()
    toolRestriction()
    child = agent
    eventStart = agent.session.events.length
    try { parent.ctx.get('sessionTitle')?.rename(agent.session, label) } catch {}
    const tools = agent.ctx.get('tools')
    if (tools === undefined) throw new Error('S5 段落 Writer requires tools service')
    toolRestriction = tools.restrict({ allow: [] })
    toolGuard = tools.guard(exec => ['grep', 'read', 'web_search', 'web_fetch'].includes(exec.name)
      ? 'BID_PARAGRAPH_REVISION_TOOL_DISABLED'
      : undefined)
    const round = createChapterProtocol<unknown>(agent, PARAGRAPH_REVISION_WRITER_TOOL, 0)
    runtime = round
    round.register({
      name: PARAGRAPH_REVISION_WRITER_TOOL,
      description: '只提交每个授权 SEG 的替换 Markdown。',
      parameters: {
        type: 'object', properties: { replacements: { type: 'array', items: {
          type: 'object', properties: { segment_id: { type: 'string' }, markdown: { type: 'string' } },
          required: ['segment_id', 'markdown'], additionalProperties: false,
        } } }, required: ['replacements'], additionalProperties: false,
      },
      execute(args, exec) {
        const parsed = paragraphRevisionWriterOutputSchema.parse(args)
        return Promise.resolve(round.finish(exec, parsed))
      },
    })
  }
  const liftSetup = subagents.registerContinuableSetup((context) => {
    const agent = context.agent as Agent
    if (agent.id !== id || agent.session.header.parentSession !== parent.id) return () => {}
    install(agent)
    return () => runtime?.dispose()
  })
  const resident = parent.ctx.agents.get(id)
  if (resident !== undefined) install(resident)
  return {
    id,
    async run(prompt) {
      signal.throwIfAborted()
      runtime?.nextRound()
      eventStart = child?.session.events.length ?? 0
      await subagents.followup(parent, id, [{ type: 'text', text: prompt }], {
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' }, signal,
      })
      if (child === undefined || runtime === undefined) throw new Error('S5 段落 Writer 缺少提交工具。')
      const end = await waitForTurn(parent, child, eventStart, signal)
      return end.data.reason.kind === 'completed'
        ? { stopReason: 'completed', output: [], structured: runtime.captured() }
        : { stopReason: end.data.reason.kind === 'blocked' ? 'refusal' : end.data.reason.kind, output: [] } as SubagentResult
    },
    async dispose() {
      try { await subagents.drainContinuableChildren(parent, [id]) } finally {
        toolGuard()
        toolRestriction()
        runtime?.dispose()
        liftSetup()
      }
    },
  }
}
