/** Bounded Main-Agent completion decisions and durable S5 review history. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import type { WritingPlan } from './writing-requirements.ts'
import type { HostAcceptanceResult } from './acceptance-criteria.ts'

const requirementResultSchema = z.object({
  requirement_id: z.string().min(1),
  status: z.enum(['met', 'unmet']),
  note: z.string().trim().min(1),
  section_ids: z.array(z.string().min(1)),
}).strict()

const revisionSchema = z.object({
  section_id: z.string().min(1),
  instruction: z.string().trim().min(1),
}).strict()

const completionDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete'),
    reason: z.string().trim().min(1),
    requirements: z.array(requirementResultSchema),
  }).strict(),
  z.object({
    action: z.literal('revise'),
    reason: z.string().trim().min(1),
    requirements: z.array(requirementResultSchema),
    sections: z.array(revisionSchema).min(1),
  }).strict(),
])

/** One Main-Agent verdict over every current writing-plan requirement. */
export type ChapterWritingCompletionDecision = z.infer<typeof completionDecisionSchema>

/** Stable requirement identity presented to and returned by the Main Agent. */
export interface ChapterWritingRequirement {
  readonly id: string
  readonly text: string
  readonly priority: 'required' | 'preferred'
  readonly section_id: string | null
}

/** Private completion tool used only by the S5 final-review turn. */
export const CHAPTER_WRITING_COMPLETION_TOOLS = ['submit_chapter_writing_completion_review'] as const

/** One durable completion-review and optional revision round. */
export interface ChapterWritingCompletionRound {
  readonly plan_version: number
  readonly format_revision: number | null
  readonly before_pages: number | null
  readonly before_document_sha256: string
  readonly reason: string
  readonly requirements: ChapterWritingCompletionDecision['requirements']
  readonly sections: readonly {
    readonly section_id: string
    readonly instruction: string
    readonly before_sha256: string
    readonly after_sha256: string
  }[]
  readonly after_pages: number | null
  readonly after_document_sha256: string
}

/** Restart-stable S5 completion ledger. */
export interface ChapterWritingCompletionState {
  readonly schema_version: 1
  readonly confirmed_outline_sha256: string
  readonly rounds: readonly ChapterWritingCompletionRound[]
  readonly completion?: {
    readonly plan_version: number
    readonly format_revision: number | null
    readonly pages: number | null
    readonly document_sha256: string
    readonly reason: string
    readonly requirements: ChapterWritingCompletionDecision['requirements']
  }
  readonly stopped_reason?: 'round_limit' | 'section_budget' | 'no_progress'
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const roundSchema = z.object({
  plan_version: z.number().int().positive(),
  format_revision: z.number().int().nonnegative().nullable(),
  before_pages: z.number().nonnegative().nullable(),
  before_document_sha256: hash,
  reason: z.string().min(1),
  requirements: z.array(requirementResultSchema),
  sections: z.array(z.object({
    section_id: z.string().min(1), instruction: z.string().min(1),
    before_sha256: hash, after_sha256: hash,
  }).strict()),
  after_pages: z.number().nonnegative().nullable(),
  after_document_sha256: hash,
}).strict()

const stateSchema = z.object({
  schema_version: z.literal(1),
  confirmed_outline_sha256: hash,
  rounds: z.array(roundSchema),
  completion: z.object({
    plan_version: z.number().int().positive(),
    format_revision: z.number().int().nonnegative().nullable(),
    pages: z.number().nonnegative().nullable(),
    document_sha256: hash,
    reason: z.string().min(1),
    requirements: z.array(requirementResultSchema),
  }).strict().optional(),
  stopped_reason: z.enum(['round_limit', 'section_budget', 'no_progress']).optional(),
}).strict()

/**
 * Parse the durable S5 completion ledger.
 * @param value Untrusted persisted JSON.
 * @returns Strict completion-review state.
 */
export function parseChapterWritingCompletionState(value: unknown): ChapterWritingCompletionState {
  const parsed = stateSchema.parse(value)
  return {
    schema_version: parsed.schema_version,
    confirmed_outline_sha256: parsed.confirmed_outline_sha256,
    rounds: parsed.rounds,
    ...(parsed.completion === undefined ? {} : { completion: parsed.completion }),
    ...(parsed.stopped_reason === undefined ? {} : { stopped_reason: parsed.stopped_reason }),
  }
}

/**
 * Expand every writing-plan obligation into a stable review item.
 * @param plan Current confirmed writing plan.
 * @returns Document criteria followed by section criteria in plan order.
 */
export function chapterWritingRequirements(plan: WritingPlan): ChapterWritingRequirement[] {
  return [
    ...plan.document_acceptance.map(item => ({
      id: item.id, text: item.description, priority: item.priority, section_id: null,
    })),
    ...plan.sections.flatMap(section => section.acceptance_criteria.map(item => ({
      id: item.id,
      text: item.description,
      priority: item.priority,
      section_id: section.section_id,
    }))),
  ]
}

/**
 * Register the single bounded S5 completion submission tool.
 * @param agent Main Agent that owns the current plan.
 * @param requirements Complete current requirement set.
 * @param sectionIds Writable sections available for targeted revision.
 * @param hostResults Authoritative deterministic measurements.
 * @param maxContinuations Maximum turns without a valid finish.
 * @returns Scoped protocol whose captured result becomes available after authoritative tool success.
 */
export function attachChapterWritingCompletionReview(
  agent: Agent,
  requirements: readonly ChapterWritingRequirement[],
  sectionIds: readonly string[],
  hostResults: readonly HostAcceptanceResult[],
  maxContinuations: number,
): ChapterProtocol<ChapterWritingCompletionDecision> {
  const required = new Set(requirements.map(item => item.id))
  const blocking = new Set(requirements.filter(item => item.priority === 'required').map(item => item.id))
  const allowedSections = new Set(sectionIds)
  const runtime = createChapterProtocol<ChapterWritingCompletionDecision>(agent, CHAPTER_WRITING_COMPLETION_TOOLS[0], maxContinuations)
  runtime.register({
    name: CHAPTER_WRITING_COMPLETION_TOOLS[0],
    description: '逐项验收当前写作计划；全部满足时完成，否则提交原 Writer 要执行的具体章节修订。',
    parameters: {
      oneOf: [{
        type: 'object', properties: {
          action: { type: 'string', enum: ['complete'] }, reason: { type: 'string' },
          requirements: { type: 'array', items: { type: 'object', properties: {
            requirement_id: { type: 'string' }, status: { type: 'string', enum: ['met', 'unmet'] },
            note: { type: 'string' }, section_ids: { type: 'array', items: { type: 'string' } },
          }, required: ['requirement_id', 'status', 'note', 'section_ids'], additionalProperties: false } },
        }, required: ['action', 'reason', 'requirements'], additionalProperties: false,
      }, {
        type: 'object', properties: {
          action: { type: 'string', enum: ['revise'] }, reason: { type: 'string' },
          requirements: { type: 'array', items: { type: 'object', properties: {
            requirement_id: { type: 'string' }, status: { type: 'string', enum: ['met', 'unmet'] },
            note: { type: 'string' }, section_ids: { type: 'array', items: { type: 'string' } },
          }, required: ['requirement_id', 'status', 'note', 'section_ids'], additionalProperties: false } },
          sections: { type: 'array', items: { type: 'object', properties: {
            section_id: { type: 'string' }, instruction: { type: 'string' },
          }, required: ['section_id', 'instruction'], additionalProperties: false } },
        }, required: ['action', 'reason', 'requirements', 'sections'], additionalProperties: false,
      }],
    },
    execute(args, exec) {
      const decision = chapterToolArgs(completionDecisionSchema, args)
      const seen = new Set<string>()
      for (const result of decision.requirements) {
        if (!required.has(result.requirement_id)) throw new ToolArgsError([`requirements: 未知要求 ${result.requirement_id}。`])
        if (seen.has(result.requirement_id)) throw new ToolArgsError([`requirements: 重复要求 ${result.requirement_id}。`])
        if (result.section_ids.some(id => !allowedSections.has(id))) throw new ToolArgsError([`requirements: ${result.requirement_id} 引用了未知章节。`])
        seen.add(result.requirement_id)
      }
      const missing = [...required].filter(id => !seen.has(id))
      if (missing.length > 0) throw new ToolArgsError([`requirements: 缺少 ${missing.join(', ')}。`])
      if (decision.action === 'complete') {
        if (decision.requirements.some(item => item.status !== 'met' && blocking.has(item.requirement_id))) {
          throw new ToolArgsError(['complete: 仍有未满足的 required 条件。'])
        }
      } else {
        if (decision.requirements.every(item => item.status === 'met')) throw new ToolArgsError(['revise: 未指出未满足要求。'])
        const selected = new Set<string>()
        for (const item of decision.sections) {
          if (!allowedSections.has(item.section_id)) throw new ToolArgsError([`sections: 未知可写章节 ${item.section_id}。`])
          if (selected.has(item.section_id)) throw new ToolArgsError([`sections: 重复章节 ${item.section_id}。`])
          selected.add(item.section_id)
        }
      }
      for (const result of hostResults) {
        const submitted = decision.requirements.find(item => item.requirement_id === result.criterion_id)
        const expected = result.status === 'met' ? 'met' : 'unmet'
        if (submitted?.status !== expected) throw new ToolArgsError([`requirements: ${result.criterion_id} 必须服从 Host 测量 ${result.status}。`])
      }
      return Promise.resolve(runtime.finish(exec, decision))
    },
  })
  return runtime
}

/**
 * Render one bounded whole-plan review without copying complete chapter bodies.
 * @param input Current plan identity, criteria, Host results, and chapter summaries.
 * @returns Model-visible final review task.
 */
export function renderChapterWritingCompletionTask(input: {
  planVersion: number
  requirements: readonly ChapterWritingRequirement[]
  hostResults: readonly HostAcceptanceResult[]
  sections: readonly { section_id: string; number: string; title: string; pages: number | null; content_sha256: string; summary: string }[]
}): string {
  return [
    '当前阶段：chapter_writing / Final Plan Review。你是制定当前写作计划的 Bid Main Agent；逐项判断全部要求是否已由正文完成，不生成正文。',
    `计划版本：${input.planVersion}`,
    `全部待验收要求：${JSON.stringify(input.requirements)}`,
    `Host 确定性验收结果：${JSON.stringify(input.hostResults)}`,
    `有界章节摘要与正文身份：${JSON.stringify(input.sections)}`,
    '必须为每个 requirement_id 提交一次 met/unmet、简短依据和相关章节。deterministic 条件服从 Host 测量；semantic 条件由你结合摘要与既有审核判断。',
    'required 全部满足时可以 action=complete，并在结果中明确保留未满足的 preferred 条件；需要继续改进时 action=revise，选择最小充分章节范围并为每章写具体修改要求。不得修改目录、虚构事实、复制整书差额、清空已有正文或靠重复内容凑指标。',
    '只调用 submit_chapter_writing_completion_review；普通文本不能完成本轮验收。',
  ].join('\n')
}
