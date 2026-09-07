/** 当前候选的只读证据包、规范 Checklist 和可分批修正的 Reviewer 记录。 */
import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidManifest, BidWorkspace } from './index.ts'
import type { ChapterContext } from './chapter-writing-executor.ts'
import type { AcceptedChapterCandidate } from './chapter-writing-artifacts.ts'
import { chapterReviewSchema, CHAPTER_REVIEW_SCHEMA_VERSION, parseChapterReview, type ChapterReview } from './chapter-writing-review-artifacts.ts'
import { resolveEvidenceChunk } from './evidence-chunk.ts'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import { readChapterWebSource } from './chapter-writing-writer.ts'
import type { WebEvidenceSource } from './web-evidence-source-artifacts.ts'

/** 仅在当前 Reviewer Child 注册的工具。 */
export const CHAPTER_REVIEW_TOOLS = ['review_coverage_items', 'review_claims', 'set_review_summary', 'finish_chapter_review'] as const

/** Checklist 的种类及其在当前章节的规范位置。 */
export interface ChapterReviewItem {
  readonly item_ref: string
  readonly kind: 'must_answer' | 'requirement' | 'response_point' | 'compliance'
  readonly id: string | null
  readonly text: string
}

/** Reviewer 可核对的来源原文；允许的声明种类不表示原文已支持某句正文。 */
export interface ChapterReviewEvidence {
  readonly source_ref: string
  readonly locator: string
  readonly category: 'tender' | 'reference' | 'reference_bid' | 'web' | 'handoff'
  readonly allowed_claim_kinds: ReadonlyArray<ChapterReview['claim_checks'][number]['kind']>
  readonly content: string
  readonly truncated: boolean
}

/**
 * 按当前章节规范顺序建立审核 Checklist。
 * @param context 含全局 Compliance 的 canonical 当前章节输入。
 * @returns 保留每个原始条目的 R1…Rn。
 */
export function buildChapterReviewChecklist(context: ChapterContext): ChapterReviewItem[] {
  const items: Omit<ChapterReviewItem, 'item_ref'>[] = [
    ...context.section.must_answer.map(text => ({ kind: 'must_answer' as const, id: null, text })),
    ...context.requirements.map(value => ({ kind: 'requirement' as const, id: value.id, text: value.normalized_requirement })),
    ...context.responsePoints.map(value => ({ kind: 'response_point' as const, id: value.id, text: value.text })),
    ...context.compliance.map(value => ({ kind: 'compliance' as const, id: value.id, text: value.normalized_rule })),
  ]
  return items.map((item, index) => ({ item_ref: `R${index + 1}`, ...item }))
}

/**
 * 仅注入当前候选实际使用的证据原文，以及相关 S2 确认事实与允许的前置 handoff。
 * @param workspace 当前资料工作区。
 * @param manifest 当前资料身份。
 * @param context 固定章节输入。
 * @param candidate 当前冻结候选。
 * @param sources 已持久化 Web 账本。
 * @param dependencies 允许传递的前置章节结论。
 * @returns 带真实来源位置、证明范围及截断标识的 E1…En。
 */
export async function buildChapterReviewEvidence(
  workspace: BidWorkspace, manifest: BidManifest, context: ChapterContext, candidate: AcceptedChapterCandidate,
  sources: readonly WebEvidenceSource[], dependencies: readonly { section_id: string; handoff: AcceptedChapterCandidate['metadata']['handoff'] }[],
): Promise<ChapterReviewEvidence[]> {
  const pack = new Map<string, Omit<ChapterReviewEvidence, 'source_ref'>>()
  const tender = (locator: string, value: unknown): void => {
    pack.set(locator, { locator, category: 'tender', allowed_claim_kinds: ['project_fact', 'technical_fact', 'commitment'], content: JSON.stringify(value), truncated: false })
  }
  tender('analysis/project.json', context.project)
  for (const item of context.requirements) tender(`analysis/requirements.json#${item.id}`, item)
  for (const item of context.compliance) tender(`analysis/compliance.json#${item.id}`, item)
  for (const item of context.scoring) tender(`analysis/scoring.json#${item.id}`, item)
  for (const material of candidate.metadata.local_materials_used) {
    const resolved = await resolveEvidenceChunk(workspace, manifest, material)
    const locator = `${resolved.file.chunksPath}/${resolved.entry.path}`
    if (pack.has(locator)) continue
    pack.set(locator, {
      locator, category: material.source_kind,
      allowed_claim_kinds: material.source_kind === 'reference' ? ['project_fact', 'technical_fact', 'commitment'] : ['technical_fact'],
      content: await readFile(resolved.path, 'utf8'), truncated: false,
    })
  }
  for (const material of candidate.metadata.web_materials_used) {
    const source = sources.find(source => source.source_id === material.source_id && source.snapshot_path === material.snapshot_path)
    if (source === undefined) throw new Error(`CHAPTER_REVIEW_EVIDENCE_MISSING: ${material.source_id}`)
    if (pack.has(source.snapshot_path)) continue
    pack.set(source.snapshot_path, {
      locator: source.snapshot_path, category: 'web', allowed_claim_kinds: ['technical_fact'],
      content: await readChapterWebSource(workspace, source), truncated: source.truncated,
    })
  }
  for (const dependency of dependencies) {
    const locator = `chapter-handoff:${dependency.section_id}`
    pack.set(locator, { locator, category: 'handoff', allowed_claim_kinds: [], content: JSON.stringify(dependency.handoff), truncated: false })
  }
  return [...pack.values()].map((item, index) => ({ source_ref: `E${index + 1}`, ...item }))
}

const text = z.string().trim().min(1)
const coverageInput = z.object({
  item_ref: text, status: z.enum(['covered', 'missing']), evidence_quote_refs: z.array(text), issue: text.nullable(),
}).strict()
const claimInput = z.object({
  claim_quote_ref: text, kind: z.enum(['project_fact', 'technical_fact', 'commitment']),
  status: z.enum(['supported', 'unsupported']), source_reference: text.nullable(), issue: text.nullable(),
}).strict()
const summaryInput = chapterReviewSchema.pick({ quality_checks: true, blocking_issues: true })
const stringParameter = { type: 'string' }
const nullableText = { oneOf: [stringParameter, { type: 'null' }] }
const qualityParameters = Object.fromEntries(Object.keys(chapterReviewSchema.shape.quality_checks.shape).map(key => [key, { type: 'boolean' }]))

/**
 * 为一个冻结候选安装 Reviewer 记录工具；各项 upsert，批次中后一个合法同键条目覆盖前项。
 * @param agent 当前 Reviewer Child。
 * @param context 当前章节 canonical 输入。
 * @param quotes 当前候选专属 Q 引用。
 * @param evidence 当前候选只读 E 引用。
 * @param maxContinuations 未 finish 时同一 Child 的有限续行次数。
 * @returns 仅在权威 finish 结果成功后可读的报告。
 */
export function attachChapterReview(
  agent: Agent, context: ChapterContext, quotes: ReadonlyMap<string, string>,
  evidence: readonly ChapterReviewEvidence[], maxContinuations: number,
): ChapterProtocol<ChapterReview> {
  const runtime = createChapterProtocol<ChapterReview>(agent, 'finish_chapter_review', maxContinuations)
  const checklist = buildChapterReviewChecklist(context)
  const coverage = new Map<string, z.infer<typeof coverageInput>>()
  const claims = new Map<string, z.infer<typeof claimInput>>()
  let summary: z.infer<typeof summaryInput> | undefined
  const quote = (ref: string): string => {
    const content = quotes.get(ref)
    if (content === undefined) throw new ToolArgsError([`未知当前候选原文引用 ${ref}。`])
    return content
  }
  const batch = (args: unknown, accept: (value: unknown) => string) => {
    const input = chapterToolArgs(z.object({ items: z.array(z.unknown()) }).strict(), args)
    const recorded = new Set<string>()
    const rejected: Array<{ index: number; issue: string }> = []
    for (const [index, value] of input.items.entries()) {
      try { recorded.add(accept(value)) } catch (error: unknown) {
        if (!(error instanceof ToolArgsError)) throw error
        rejected.push({ index, issue: error.message })
      }
    }
    return Promise.resolve({ recorded: [...recorded], rejected })
  }
  try {
    runtime.register({
      name: 'review_coverage_items', description: '分批记录 R 项的实际正文覆盖。每项独立接受或报告错误；同一 R 后续合法条目覆盖已有判断。',
      parameters: {
        type: 'object', properties: { items: { type: 'array', items: {
          type: 'object', properties: { item_ref: stringParameter, status: { type: 'string', enum: ['covered', 'missing'] }, evidence_quote_refs: { type: 'array', items: stringParameter }, issue: nullableText },
          required: ['item_ref', 'status', 'evidence_quote_refs', 'issue'], additionalProperties: false,
        } } }, required: ['items'], additionalProperties: false,
      },
      execute: args => batch(args, (value) => {
        const item = chapterToolArgs(coverageInput, value)
        if (!checklist.some(entry => entry.item_ref === item.item_ref)) throw new ToolArgsError([`item_ref: 未知 ${item.item_ref}。`])
        for (const ref of item.evidence_quote_refs) quote(ref)
        if (item.status === 'covered' && (item.evidence_quote_refs.length === 0 || item.issue !== null)) throw new ToolArgsError([`${item.item_ref}: covered 至少引用一个 Q，issue 必须为 null。`])
        if (item.status === 'missing' && (item.evidence_quote_refs.length !== 0 || item.issue === null)) throw new ToolArgsError([`${item.item_ref}: missing 不得引用 Q，必须说明具体 issue。`])
        coverage.set(item.item_ref, item)
        return item.item_ref
      }),
    })
    runtime.register({
      name: 'review_claims', description: '分批核验实质性事实、技术参数和承诺；只用当前 Q 原文及有资格的 E 来源，来源存在不等于语义支持。',
      parameters: {
        type: 'object', properties: { items: { type: 'array', items: {
          type: 'object', properties: { claim_quote_ref: stringParameter, kind: { type: 'string', enum: ['project_fact', 'technical_fact', 'commitment'] }, status: { type: 'string', enum: ['supported', 'unsupported'] }, source_reference: nullableText, issue: nullableText },
          required: ['claim_quote_ref', 'kind', 'status', 'source_reference', 'issue'], additionalProperties: false,
        } } }, required: ['items'], additionalProperties: false,
      },
      execute: args => batch(args, (value) => {
        const item = chapterToolArgs(claimInput, value)
        quote(item.claim_quote_ref)
        const source = evidence.find(entry => entry.source_ref === item.source_reference)
        if (item.source_reference !== null && source === undefined) throw new ToolArgsError([`source_reference: 未知 ${item.source_reference}。`])
        if (item.status === 'supported' && (source === undefined || !source.allowed_claim_kinds.includes(item.kind) || item.issue !== null)) {
          throw new ToolArgsError(['supported 必须引用有资格支撑当前声明种类的 E，且 issue 为 null；S2 不能证明企业业绩，旧标书、Web 和 handoff 不能证明本项目企业事实。'])
        }
        if (item.status === 'unsupported' && item.issue === null) throw new ToolArgsError(['unsupported 必须说明具体 issue。'])
        const key = `${item.claim_quote_ref}/${item.kind}`
        claims.set(key, item)
        return key
      }),
    })
    runtime.register({
      name: 'set_review_summary', description: '整体替换质量检查和额外阻断问题；可用空 blocking_issues 撤销误判。',
      parameters: {
        type: 'object', properties: {
          quality_checks: { type: 'object', properties: qualityParameters, required: Object.keys(qualityParameters), additionalProperties: false },
          blocking_issues: { type: 'array', items: stringParameter },
        }, required: ['quality_checks', 'blocking_issues'], additionalProperties: false,
      },
      execute(args) {
        summary = chapterToolArgs(summaryInput, args)
        summary.blocking_issues = [...new Set(summary.blocking_issues.map(value => value.trim()))]
        return Promise.resolve({ recorded: true })
      },
    })
    runtime.register({
      name: 'finish_chapter_review', description: '检查是否记录全部 R 与质量总结，再生成 pass 或 repair 报告并结束；repair 也可正常提交。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute(args, exec) {
        chapterToolArgs(z.object({}).strict(), args)
        const missing = checklist.filter(item => !coverage.has(item.item_ref)).map(item => item.item_ref)
        if (missing.length > 0 || summary === undefined) {
          return Promise.resolve({ completed: false, missing_items: missing, missing_summary: summary === undefined })
        }
        const entries = checklist.map((item) => {
          const result = coverage.get(item.item_ref)
          if (result === undefined) throw new Error(`S5 review lost coverage ${item.item_ref}`)
          return { item, result, value: {
            item: item.text, status: result.status, evidence_quotes: result.evidence_quote_refs.map(quote), issue: result.issue,
          } }
        })
        const quoteOrder = [...quotes.keys()]
        const claimChecks = [...claims.values()].sort((a, b) =>
          quoteOrder.indexOf(a.claim_quote_ref) - quoteOrder.indexOf(b.claim_quote_ref) || a.kind.localeCompare(b.kind),
        ).map(item => ({
          claim_quote: quote(item.claim_quote_ref), kind: item.kind, status: item.status,
          source_reference: evidence.find(source => source.source_ref === item.source_reference)?.locator ?? null, issue: item.issue,
        }))
        const blocking = [...new Set([
          ...summary.blocking_issues,
          ...entries.filter(entry => entry.result.status === 'missing').map(entry => `未覆盖：${entry.item.text}；${entry.result.issue}`),
          ...Object.entries(summary.quality_checks).filter(([, value]) => !value).map(([key]) => `质量检查未通过：${key}`),
          ...claimChecks.filter(item => item.status === 'unsupported').map(item => `声明无依据：${item.claim_quote}；${item.issue}`),
        ])]
        const review = parseChapterReview({
          schema_version: CHAPTER_REVIEW_SCHEMA_VERSION, section_id: context.section.id, verdict: blocking.length === 0 ? 'pass' : 'repair',
          must_answer_coverage: entries.filter(entry => entry.item.kind === 'must_answer').map(entry => entry.value),
          requirement_coverage: entries.filter(entry => entry.item.kind === 'requirement').map(entry => ({ ...entry.value, requirement_id: entry.item.id })),
          response_point_coverage: entries.filter(entry => entry.item.kind === 'response_point').map(entry => ({ ...entry.value, response_point_id: entry.item.id })),
          compliance_coverage: entries.filter(entry => entry.item.kind === 'compliance').map(entry => ({ ...entry.value, compliance_id: entry.item.id })),
          claim_checks: claimChecks, quality_checks: summary.quality_checks, blocking_issues: blocking,
        })
        return Promise.resolve(runtime.finish(exec, review))
      },
    })
    return runtime
  } catch (error: unknown) {
    runtime.dispose()
    throw error
  }
}
