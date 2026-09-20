/** 段落修订 Delta Reviewer 的单工具协议与最小 Prompt。 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import type { ParagraphRevisionReplacement, ParagraphRevisionSegment } from './chapter-paragraph-revision.ts'

/** Delta Reviewer 唯一可见的结束工具名。 */
export const PARAGRAPH_REVISION_REVIEW_TOOL = 'finish_paragraph_revision_review'

/** Delta Reviewer 的严格决策结构。 */
export const paragraphRevisionReviewSchema = z.object({
  decision: z.enum(['accept', 'repair', 'full_review', 'needs_input']),
  issue_checks: z.array(z.object({
    issue_id: z.string().min(1),
    status: z.enum(['satisfied', 'unsatisfied', 'needs_input']),
    reason: z.string().min(1),
  }).strict()).min(1),
  semantic_preserved: z.boolean(),
  repair_instructions: z.array(z.object({
    segment_id: z.string().min(1), instruction: z.string().min(1),
  }).strict()),
  reason: z.string().min(1),
}).strict()

/** Delta Reviewer 的完整决策。 */
export type ParagraphRevisionReview = z.infer<typeof paragraphRevisionReviewSchema>

function validateReview(
  value: ParagraphRevisionReview,
  issueIds: ReadonlySet<string>,
  segmentIds: ReadonlySet<string>,
): void {
  const submitted = value.issue_checks.map(item => item.issue_id)
  if (new Set(submitted).size !== submitted.length || submitted.length !== issueIds.size
    || submitted.some(id => !issueIds.has(id))) throw new ToolArgsError(['issue_checks 必须与当前审批意见一一对应。'])
  if (value.repair_instructions.some(item => !segmentIds.has(item.segment_id))) {
    throw new ToolArgsError(['repair_instructions 只能引用当前授权 SEG。'])
  }
  if (value.decision === 'accept' && (!value.semantic_preserved || value.repair_instructions.length > 0
    || value.issue_checks.some(item => item.status !== 'satisfied'))) {
    throw new ToolArgsError(['accept 要求所有意见 satisfied、semantic_preserved=true 且无 repair_instructions。'])
  }
  if (value.decision === 'repair' && (!value.semantic_preserved || value.repair_instructions.length === 0
    || !value.issue_checks.some(item => item.status === 'unsatisfied')
    || value.issue_checks.some(item => item.status === 'needs_input'))) {
    throw new ToolArgsError(['repair 要求存在 unsatisfied、无 needs_input、semantic_preserved=true 且提供 repair_instructions。'])
  }
  if (value.decision === 'full_review' && value.semantic_preserved) {
    throw new ToolArgsError(['full_review 要求 semantic_preserved=false。'])
  }
  if (value.decision === 'needs_input' && !value.issue_checks.some(item => item.status === 'needs_input')) {
    throw new ToolArgsError(['needs_input 要求至少一个 issue_check=needs_input。'])
  }
}

/**
 * 只渲染意见和授权分段的 before/after delta。
 * @param input 章节标题、授权分段和当前替换。
 * @returns 不含整章审核资料的 Delta Review 提示。
 */
export function renderParagraphRevisionReviewerTask(input: {
  readonly title: string
  readonly segments: readonly ParagraphRevisionSegment[]
  readonly replacements: readonly ParagraphRevisionReplacement[]
}): string {
  const revised = new Map(input.replacements.map(item => [item.segment_id, item.markdown]))
  const issues = new Map(input.segments.flatMap(segment => segment.issues.map(issue => [issue.issue_id, issue] as const)))
  return [
    `章节标题：${input.title}`,
    `用户审批意见：\n${[...issues.values()].map(issue => `${issue.issue_id}: ${issue.instruction}${issue.suggestion === null ? '' : `；建议：${issue.suggestion}`}`).join('\n')}`,
    ...input.segments.map(segment => [
      segment.segment_id,
      `readonly_before:\n${segment.readonly_before}`,
      `original_text:\n${segment.original_text}`,
      `revised_text:\n${revised.get(segment.segment_id) ?? ''}`,
      `readonly_after:\n${segment.readonly_after}`,
    ].join('\n\n')),
    [
      '你只做两件事：',
      '1. 用户意见是否已经在选区内满足。',
      '2. 这次修改是否只改变表达，而没有改变已经审核过的技术语义。',
      '如果改变技术事实、参数、承诺、评分响应含义、证据含义、接口含义、handoff 等，decision=full_review。',
      '禁止检查选区外正文。禁止提出修改选区外正文。禁止产生普通 Chapter blocking_issues。',
      `调用 ${PARAGRAPH_REVISION_REVIEW_TOOL} 一次提交全部结果。`,
    ].join('\n'),
  ].join('\n\n')
}

/** 可续写的 Delta Reviewer 生命周期。 */
export interface ParagraphRevisionReviewerChild {
  readonly id: SessionId
  run(prompt: string): Promise<SubagentResult>
  dispose(): Promise<void>
}

async function waitForTurn(parent: Agent, child: Agent, eventStart: number, signal: AbortSignal): Promise<SessionEvent<'turn/end'>> {
  let lift = () => {}
  let onAbort = () => {}
  try {
    const end = await new Promise<SessionEvent<'turn/end'>>((resolve, reject) => {
      onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('段落修订 Reviewer 已取消。')) }
      const inspect = () => {
        const value = child.session.events.slice(eventStart).find(event => event.type === 'turn/end')
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
 * 创建只暴露 finish 工具的轻量 Reviewer。
 * @param parent 当前 S5 父 Agent。
 * @param label Reviewer 子会话名称。
 * @param issueIds 必须逐项判定的审批意见身份。
 * @param segmentIds 可被 repair 指令引用的授权分段身份。
 * @param signal 当前修订操作的取消信号。
 * @returns 由调用方释放的 Delta Reviewer。
 */
export function createParagraphRevisionReviewerChild(
  parent: Agent,
  label: string,
  issueIds: readonly string[],
  segmentIds: readonly string[],
  signal: AbortSignal,
): ParagraphRevisionReviewerChild {
  const subagents = parent.ctx.get('subagents')
  if (subagents === undefined) throw new Error('S5 requires subagents service')
  const id = SessionId(randomUUID())
  let child: Agent | undefined
  let runtime: ChapterProtocol<ParagraphRevisionReview> | undefined
  let eventStart = 0
  let started = false
  const install = (agent: Agent) => {
    runtime?.dispose()
    child = agent
    eventStart = agent.session.events.length
    const round = createChapterProtocol<ParagraphRevisionReview>(agent, PARAGRAPH_REVISION_REVIEW_TOOL, 0)
    runtime = round
    round.register({
      name: PARAGRAPH_REVISION_REVIEW_TOOL,
      description: '一次提交局部修订的意见满足度和语义保持结论。',
      parameters: {
        type: 'object', properties: {
          decision: { type: 'string', enum: ['accept', 'repair', 'full_review', 'needs_input'] },
          issue_checks: { type: 'array', items: { type: 'object', properties: {
            issue_id: { type: 'string' }, status: { type: 'string', enum: ['satisfied', 'unsatisfied', 'needs_input'] }, reason: { type: 'string' },
          }, required: ['issue_id', 'status', 'reason'], additionalProperties: false } },
          semantic_preserved: { type: 'boolean' },
          repair_instructions: { type: 'array', items: { type: 'object', properties: {
            segment_id: { type: 'string' }, instruction: { type: 'string' },
          }, required: ['segment_id', 'instruction'], additionalProperties: false } },
          reason: { type: 'string' },
        }, required: ['decision', 'issue_checks', 'semantic_preserved', 'repair_instructions', 'reason'], additionalProperties: false,
      },
      execute(args, exec) {
        const parsed = chapterToolArgs(paragraphRevisionReviewSchema, args)
        validateReview(parsed, new Set(issueIds), new Set(segmentIds))
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
  return {
    id,
    async run(prompt) {
      signal.throwIfAborted()
      if (!started) {
        await subagents.startContinuable({
          provider: 'spawn', childId: id, label, signal,
          request: {
            parent, prompt: [{ type: 'text', text: prompt }], maxDepth: 1, toolFilter: { allow: [] },
            persona: `你是段落修订 Delta Reviewer。只通过 ${PARAGRAPH_REVISION_REVIEW_TOOL} 提交结论。`,
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
      if (child === undefined || runtime === undefined) throw new Error('S5 Delta Reviewer 缺少结束工具。')
      const end = await waitForTurn(parent, child, eventStart, signal)
      return end.data.reason.kind === 'completed'
        ? { stopReason: 'completed', output: [], structured: runtime.captured() }
        : { stopReason: end.data.reason.kind === 'blocked' ? 'refusal' : end.data.reason.kind, output: [] } as SubagentResult
    },
    async dispose() {
      try { await subagents.drainContinuableChildren(parent, [id]) } finally { runtime?.dispose(); liftSetup() }
    },
  }
}
