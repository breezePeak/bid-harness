/** 公共能力的模型输入与 Host 权威执行字段分开；此模块不执行写入。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidRunContext } from './run-coordinator.ts'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions/types'
import { outlineEditOperationSchema } from './outline-confirmation-edits.ts'
import { chapterRevisionReferenceSchema } from './chapter-revision.ts'
import { tenderAnalysisEditOperationSchema } from './tender-analysis-confirmation.ts'
import { writingPlanInputSchema } from './writing-requirements.ts'
import { chapterBlockAssignmentSchema } from './chapter-content-reuse.ts'
import { outlineBusinessBindingSchema } from './outline-confirmation-edits.ts'

const sectionIds = z.array(z.string().trim().min(1)).min(1).refine(
  ids => new Set(ids).size === ids.length, 'section_ids must be unique',
)
const scoringIds = z.array(z.string().trim().min(1)).refine(
  ids => new Set(ids).size === ids.length, 'selected_scoring_ids must be unique',
)
const instruction = z.string().trim().min(1).max(4_000)

/** 用户授权的任务根范围；空章节集合没有“全部章节”的含义。 */
export const bidCapabilityScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('sections'), section_ids: sectionIds }).strict(),
  z.object({ kind: z.literal('paragraphs'), reference: chapterRevisionReferenceSchema.options[1] }).strict(),
])

/** 步骤范围只能由任务、前一步真实结果或明确 ID 得到。 */
export const bidCapabilityStepScopeSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('task') }).strict(),
  z.object({ source: z.literal('previous_targets') }).strict(),
  z.object({ source: z.literal('section_ids'), section_ids: sectionIds }).strict(),
])

/** 静态能力 ID，业务参数随 ID 分支校验。 */
export const bidCapabilityInputSchema = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('tender.analyze'), input: z.object({}).strict() }).strict(),
  z.object({ capability: z.literal('tender.update'), input: z.object({
    operations: z.array(tenderAnalysisEditOperationSchema).default([]),
    selected_scoring_ids: scoringIds.optional(),
  }).strict().refine(value => value.operations.length > 0 || value.selected_scoring_ids !== undefined) }).strict(),
  z.object({ capability: z.literal('outline.generate'), input: z.object({}).strict() }).strict(),
  z.object({ capability: z.literal('outline.update'), input: z.object({
    operations: z.array(outlineEditOperationSchema).min(1),
    business_bindings: z.array(outlineBusinessBindingSchema).default([]),
    content_assignments: z.array(chapterBlockAssignmentSchema).default([]),
    allow_content_deletion: z.boolean().default(false),
    defer_content_migration: z.boolean().default(false),
  }).strict() }).strict(),
  z.object({ capability: z.literal('outline.refine'), input: z.object({ feedback: instruction }).strict() }).strict(),
  z.object({ capability: z.literal('chapter.reorganize'), input: z.object({
    instruction, source_section_ids: sectionIds,
    assignments: z.array(chapterBlockAssignmentSchema).min(1).optional(),
    allow_content_deletion: z.boolean().default(false),
  }).strict() }).strict(),
  z.object({ capability: z.literal('evidence.research'), input: z.object({
    mode: z.enum(['replace', 'supplement']), reason: instruction,
    allow_outline_refinement: z.boolean(),
  }).strict() }).strict(),
  z.object({ capability: z.literal('writing.plan'), input: writingPlanInputSchema }).strict(),
  z.object({ capability: z.literal('chapter.write'), input: z.object({ instruction }).strict() }).strict(),
  z.object({ capability: z.literal('chapter.revise'), input: z.object({
    instruction, reference: chapterRevisionReferenceSchema,
  }).strict() }).strict(),
  z.object({ capability: z.literal('chapter.review'), input: z.object({ reason: instruction }).strict() }).strict(),
  z.object({ capability: z.literal('document.review'), input: z.object({ reason: instruction }).strict() }).strict(),
  z.object({ capability: z.literal('docx.export'), input: z.object({
    template_id: z.string().min(1).nullable(),
  }).strict() }).strict(),
])

/** 模型选择的单一步骤；身份和文件路径由 Host 填充。 */
export const bidCapabilityStepSchema = z.object({
  scope: bidCapabilityStepScopeSchema,
  call: bidCapabilityInputSchema,
}).strict()

/** 模型只选择有序能力及业务范围；身份和文件路径由 Host 填充。 */
export const bidCapabilityTaskSchema = z.object({
  goal: instruction,
  scope: bidCapabilityScopeSchema,
  steps: z.array(bidCapabilityStepSchema).min(1),
}).strict()

/** Host 核对过产物后形成的步骤结果。 */
export const bidCapabilityResultSchema = z.object({
  target_section_ids: z.array(z.string().min(1)),
  changed_artifacts: z.array(z.string().min(1)),
  change_summary: z.string().trim().min(1).max(2_000),
  warnings: z.array(z.string().trim().min(1)),
  missing_topics: z.array(z.string().trim().min(1)),
  needs_input: z.boolean(),
}).strict()

/** Host 生成的执行身份；模型调用不能设置这些字段。 */
export interface BidCapabilityExecutionContext {
  readonly canonical: BidWorkspace
  readonly working: BidWorkspace
  readonly agent: Agent
  readonly run: BidRunContext
  readonly sectionIds: ReadonlySet<string> | null
  /** 结构操作产出并经 Host 核对属于任务根范围的新后代。 */
  readonly authorizedNewDescendants?: ReadonlySet<string>
  readonly stepDirectory: string
  readonly inputSources: ReadonlyMap<string, string>
  readonly baselineHashes: ReadonlyMap<string, string>
  readonly allowedWrites: ReadonlySet<string>
  readonly stepId: string
  readonly rootWorkId: string
  readonly authorization: { readonly session_id: string; readonly message_id: string }
  readonly inputSha256: string
  readonly inputAnswer?: AskUserQuestionAnswerItem
}

export type BidCapabilityId = z.infer<typeof bidCapabilityInputSchema>['capability']
export type BidCapabilityScope = z.infer<typeof bidCapabilityScopeSchema>
export type BidCapabilityStepScope = z.infer<typeof bidCapabilityStepScopeSchema>
export type BidCapabilityCall = z.infer<typeof bidCapabilityInputSchema>
export type BidCapabilityResult = z.infer<typeof bidCapabilityResultSchema>
export type BidCapabilityTask = z.infer<typeof bidCapabilityTaskSchema>
export type BidCapabilityStep = z.infer<typeof bidCapabilityStepSchema>
