/** Main-Agent document acceptance and bounded read-only chapter inspection. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import type { WritingPlan } from './writing-requirements.ts'
import { semanticAcceptanceSubmissionSchema, type HostAcceptanceResult } from './acceptance-criteria.ts'
import type { ChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'

const revisionSchema = z.object({
  section_id: z.string().min(1),
  instruction: z.string().trim().min(1),
}).strict()

const completionSubmissionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete'),
    reason: z.string().trim().min(1),
    document_acceptance: z.array(semanticAcceptanceSubmissionSchema),
  }).strict(),
  z.object({
    action: z.literal('revise'),
    reason: z.string().trim().min(1),
    document_acceptance: z.array(semanticAcceptanceSubmissionSchema),
    sections: z.array(revisionSchema).min(1),
  }).strict(),
])

const durableAcceptanceResultSchema = z.object({
  criterion_id: z.string().min(1),
  evaluator: z.enum(['semantic', 'deterministic']),
  status: z.enum(['met', 'unmet', 'unavailable']),
  evidence_quotes: z.array(z.object({ section_id: z.string().min(1), quote: z.string().trim().min(1) }).strict()),
  measured: z.union([z.number(), z.string()]).nullable(),
  reason: z.string().trim().min(1),
}).strict()

/** One final Main-Agent decision over document-level criteria only. */
export interface ChapterWritingCompletionDecision {
  readonly action: 'complete' | 'revise'
  readonly reason: string
  readonly document_acceptance_results: readonly z.infer<typeof durableAcceptanceResultSchema>[]
  readonly sections?: readonly z.infer<typeof revisionSchema>[]
}

/** Current authoritative section-level acceptance facts. */
export interface SectionAcceptanceAuthority {
  readonly section_id: string
  readonly review: Pick<ChapterReviewArtifact, 'verdict' | 'blocking_issues' | 'acceptance_criteria_results'>
}

/** Private tools used only by the S5 final-review turn. */
export const CHAPTER_WRITING_COMPLETION_TOOLS = ['read_completed_chapter', 'submit_chapter_writing_completion_review'] as const

/** One durable completion-review and optional revision round. */
export interface ChapterWritingCompletionRound {
  readonly plan_version: number
  readonly format_revision: number | null
  readonly before_pages: number | null
  readonly before_document_sha256: string
  readonly reason: string
  readonly document_acceptance_results: ChapterWritingCompletionDecision['document_acceptance_results']
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
  readonly schema_version: 2
  readonly confirmed_outline_sha256: string
  readonly rounds: readonly ChapterWritingCompletionRound[]
  readonly completion?: {
    readonly plan_version: number
    readonly format_revision: number | null
    readonly pages: number | null
    readonly document_sha256: string
    readonly reason: string
    readonly document_acceptance_results: ChapterWritingCompletionDecision['document_acceptance_results']
  }
  readonly stopped_reason?: 'round_limit' | 'no_progress'
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const roundSchema = z.object({
  plan_version: z.number().int().positive(),
  format_revision: z.number().int().nonnegative().nullable(),
  before_pages: z.number().nonnegative().nullable(),
  before_document_sha256: hash,
  reason: z.string().min(1),
  document_acceptance_results: z.array(durableAcceptanceResultSchema),
  sections: z.array(z.object({
    section_id: z.string().min(1), instruction: z.string().min(1),
    before_sha256: hash, after_sha256: hash,
  }).strict()),
  after_pages: z.number().nonnegative().nullable(),
  after_document_sha256: hash,
}).strict()

const stateSchema = z.object({
  schema_version: z.literal(2),
  confirmed_outline_sha256: hash,
  rounds: z.array(roundSchema),
  completion: z.object({
    plan_version: z.number().int().positive(),
    format_revision: z.number().int().nonnegative().nullable(),
    pages: z.number().nonnegative().nullable(),
    document_sha256: hash,
    reason: z.string().min(1),
    document_acceptance_results: z.array(durableAcceptanceResultSchema),
  }).strict().optional(),
  stopped_reason: z.enum(['round_limit', 'no_progress']).optional(),
}).strict()

/**
 * 解析持久化的 S5 整书验收账本。
 * @param value 未信任的磁盘数据。
 * @returns 当前格式的整书验收状态。
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

function requiredSectionFailures(plan: WritingPlan, sections: readonly SectionAcceptanceAuthority[]): string[] {
  return sections.flatMap((section) => {
    const contract = plan.sections.find(item => item.section_id === section.section_id)
    if (contract === undefined) return [section.section_id]
    return section.review.acceptance_criteria_results.some(result => result.status !== 'met'
      && contract.acceptance_criteria.find(criterion => criterion.id === result.criterion_id)?.priority === 'required')
      ? [section.section_id] : []
  })
}

/**
 * 在现有 Main Agent 上注册整书验收和有界章节只读工具；章节验收是不可覆盖的输入事实。
 * @param agent 执行最终整书验收的 Main Agent。
 * @param plan 当前已确认的 Writing Plan。
 * @param sections 最新 Chapter Reviewer 的章节验收事实。
 * @param chapterBodies 可按章节读取的已完成正文及其身份。
 * @param hostResults Host 计算的 document deterministic 结果。
 * @param maxContinuations 未完成工具协议时允许的续行次数。
 * @returns 捕获最终整书决定并管理私有工具生命周期的协议。
 */
export function attachChapterWritingCompletionReview(
  agent: Agent,
  plan: WritingPlan,
  sections: readonly SectionAcceptanceAuthority[],
  chapterBodies: ReadonlyMap<string, { readonly markdown: string; readonly content_sha256: string }>,
  hostResults: readonly HostAcceptanceResult[],
  maxContinuations: number,
): ChapterProtocol<ChapterWritingCompletionDecision> {
  const semantic = plan.document_acceptance.filter(criterion => criterion.evaluator.kind === 'semantic')
  const allowedSections = new Set(plan.sections.map(section => section.section_id))
  const blockedSections = new Set(requiredSectionFailures(plan, sections))
  const quoteRefs = new Map<string, { section_id: string; quote: string }>()
  const runtime = createChapterProtocol<ChapterWritingCompletionDecision>(agent, 'submit_chapter_writing_completion_review', maxContinuations)
  runtime.register({
    name: 'read_completed_chapter',
    description: '按 section_id 读取当前已完成章节的有界正文片段；只读，不修改 Artifact。',
    parameters: {
      type: 'object', properties: {
        section_id: { type: 'string' }, start: { type: 'integer' }, length: { type: 'integer' },
      }, required: ['section_id', 'start', 'length'], additionalProperties: false,
    },
    execute(args) {
      const input = chapterToolArgs(z.object({
        section_id: z.string().min(1), start: z.number().int().nonnegative(), length: z.number().int().min(1).max(12_000),
      }).strict(), args)
      const chapter = chapterBodies.get(input.section_id)
      if (chapter === undefined) throw new ToolArgsError([`section_id: 未知或未完成章节 ${input.section_id}。`])
      const quote = chapter.markdown.slice(input.start, input.start + input.length)
      if (quote.length === 0) throw new ToolArgsError(['start: 超出当前章节正文。'])
      const ref = `DQ${quoteRefs.size + 1}`
      quoteRefs.set(ref, { section_id: input.section_id, quote })
      return Promise.resolve({
        quote_ref: ref, section_id: input.section_id, content_sha256: chapter.content_sha256,
        start: input.start, end: input.start + quote.length, markdown: quote,
        truncated: input.start + quote.length < chapter.markdown.length,
      })
    },
  })
  runtime.register({
    name: 'submit_chapter_writing_completion_review',
    description: '提交 document acceptance 结论；章节 acceptance 只消费 Chapter Reviewer 权威结果。',
    parameters: {
      oneOf: [{
        type: 'object', properties: {
          action: { type: 'string', enum: ['complete'] }, reason: { type: 'string' },
          document_acceptance: { type: 'array', items: {
            type: 'object', properties: {
              criterion_id: { type: 'string' }, status: { type: 'string', enum: ['met', 'unmet'] },
              evidence_quote_refs: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
            }, required: ['criterion_id', 'status', 'evidence_quote_refs', 'reason'], additionalProperties: false,
          } },
        }, required: ['action', 'reason', 'document_acceptance'], additionalProperties: false,
      }, {
        type: 'object', properties: {
          action: { type: 'string', enum: ['revise'] }, reason: { type: 'string' },
          document_acceptance: { type: 'array', items: {
            type: 'object', properties: {
              criterion_id: { type: 'string' }, status: { type: 'string', enum: ['met', 'unmet'] },
              evidence_quote_refs: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
            }, required: ['criterion_id', 'status', 'evidence_quote_refs', 'reason'], additionalProperties: false,
          } },
          sections: { type: 'array', items: { type: 'object', properties: {
            section_id: { type: 'string' }, instruction: { type: 'string' },
          }, required: ['section_id', 'instruction'], additionalProperties: false } },
        }, required: ['action', 'reason', 'document_acceptance', 'sections'], additionalProperties: false,
      }],
    },
    execute(args, exec) {
      const submission = chapterToolArgs(completionSubmissionSchema, args)
      const seen = new Set<string>()
      const semanticResults = submission.document_acceptance.map((result) => {
        const criterion = semantic.find(item => item.id === result.criterion_id)
        if (criterion === undefined) throw new ToolArgsError([`document_acceptance: 未知 semantic criterion ${result.criterion_id}。`])
        if (seen.has(result.criterion_id)) throw new ToolArgsError([`document_acceptance: 重复 criterion ${result.criterion_id}。`])
        seen.add(result.criterion_id)
        const evidence = result.evidence_quote_refs.map((ref) => {
          const quote = quoteRefs.get(ref)
          if (quote === undefined) throw new ToolArgsError([`evidence_quote_refs: 未知当前正文引用 ${ref}。`])
          return quote
        })
        return {
          criterion_id: result.criterion_id, evaluator: 'semantic' as const, status: result.status,
          evidence_quotes: evidence, measured: null, reason: result.reason,
        }
      })
      const missing = semantic.filter(criterion => !seen.has(criterion.id))
      if (missing.length > 0) throw new ToolArgsError([`document_acceptance: 缺少 ${missing.map(item => item.id).join(', ')}。`])
      const deterministicResults = plan.document_acceptance.filter(criterion => criterion.evaluator.kind === 'deterministic').map((criterion) => {
        const result = hostResults.find(item => item.criterion_id === criterion.id)
        if (result === undefined) throw new ToolArgsError([`document_acceptance: Host 缺少 ${criterion.id} 的确定性结果。`])
        return {
          criterion_id: criterion.id, evaluator: 'deterministic' as const, status: result.status,
          evidence_quotes: [], measured: result.measured, reason: result.message,
        }
      })
      const byId = new Map([...semanticResults, ...deterministicResults].map(result => [result.criterion_id, result]))
      const results = plan.document_acceptance.map((criterion) => {
        const result = byId.get(criterion.id)
        if (result === undefined) throw new Error(`S5 final review lost ${criterion.id}`)
        return result
      })
      if (submission.action === 'complete') {
        const documentBlocked = plan.document_acceptance.some(criterion => criterion.priority === 'required'
          && results.find(result => result.criterion_id === criterion.id)?.status !== 'met')
        if (documentBlocked || blockedSections.size > 0) {
          throw new ToolArgsError(['complete: required document 或 Chapter Reviewer 权威 section criterion 仍未满足。'])
        }
      } else {
        const selected = new Set<string>()
        for (const section of submission.sections) {
          if (!allowedSections.has(section.section_id)) throw new ToolArgsError([`sections: 未知可写章节 ${section.section_id}。`])
          if (selected.has(section.section_id)) throw new ToolArgsError([`sections: 重复章节 ${section.section_id}。`])
          selected.add(section.section_id)
        }
        const omitted = [...blockedSections].filter(sectionId => !selected.has(sectionId))
        if (omitted.length > 0) throw new ToolArgsError([`sections: 必须修复 required section criterion 未满足的章节 ${omitted.join(', ')}。`])
      }
      return Promise.resolve(runtime.finish(exec, {
        action: submission.action,
        reason: submission.reason,
        document_acceptance_results: results,
        ...(submission.action === 'revise' ? { sections: submission.sections } : {}),
      }))
    },
  })
  return runtime
}

/**
 * 渲染不复制完整章节正文的有界整书验收任务。
 * @param input 当前计划、Host 结果、章节摘要与固定合规审核。
 * @returns Final Main Agent 的整书验收提示。
 */
export function renderChapterWritingCompletionTask(input: {
  plan: WritingPlan
  hostResults: readonly HostAcceptanceResult[]
  sections: readonly {
    section_id: string
    number: string
    title: string
    pages: number | null
    content_sha256: string
    summary: string
    review: SectionAcceptanceAuthority['review']
  }[]
  globalReview: unknown
}): string {
  return [
    '当前阶段：chapter_writing / Final Document Review。你是制定当前写作计划的 Bid Main Agent；只判断 document_acceptance，并消费 Chapter Reviewer 已确定的 section 结论，不生成正文。',
    `计划版本：${input.plan.plan_version}`,
    `Document Acceptance：${JSON.stringify(input.plan.document_acceptance)}`,
    `Host Document Deterministic Results：${JSON.stringify(input.hostResults)}`,
    `章节摘要、正文身份与 Chapter Reviewer 权威结果：${JSON.stringify(input.sections)}`,
    `文档级固定合规审核：${JSON.stringify(input.globalReview)}`,
    '只为 evaluator.kind=semantic 的 document criterion 提交 criterion_id、met/unmet、reason 和可选 evidence_quote_refs；deterministic 结果由 Host 合入，绝不能重新判断 section criterion。',
    '摘要不足以判断跨章术语、重复、矛盾或整书逻辑时，调用 read_completed_chapter 按 section_id 分段读取当前正文；返回的 DQ 引用可用于 document acceptance。',
    'required document 条件和各 Chapter Reviewer 的 required section 条件全部满足时可以 action=complete。否则 action=revise，选择最小充分章节并给原 Writer 具体修改要求；不得修改目录、虚构事实、清空已有正文或靠重复内容凑指标。',
    '只使用 read_completed_chapter 和 submit_chapter_writing_completion_review；普通文本不能完成本轮验收。',
  ].join('\n')
}
