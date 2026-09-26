/** 公共能力的模型输入与 Host 权威执行字段分开；此模块不执行写入。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidRunContext } from './run-coordinator.ts'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions/types'
import { outlineEditOperationSchema } from './outline-confirmation-edits.ts'
import { chapterRevisionReferenceSchema } from './chapter-revision.ts'
import { tenderAnalysisEditOperationSchema } from './tender-analysis-confirmation.ts'
import { writingPlanInputSchema, type WritingMessageSession } from './writing-requirements.ts'
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
    template_id: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  }).strict() }).strict(),
])

/** 模型选择的单一步骤；身份和文件路径由 Host 填充。 */
export const bidCapabilityStepSchema = z.object({
  scope: bidCapabilityStepScopeSchema,
  call: bidCapabilityInputSchema,
}).strict()

/** 模型只选择有序能力及业务范围；段落范围仅能执行匹配原选区的单步修订。 */
export const bidCapabilityTaskSchema = z.object({
  goal: instruction,
  scope: bidCapabilityScopeSchema,
  allow_pending_content: z.boolean().optional().describe('仅用户明确要求只改目录或暂缓正文时设为 true；执行中的临时迁移延后不属于此授权。'),
  steps: z.array(bidCapabilityStepSchema).min(1),
}).strict().refine((task) => {
  if (task.scope.kind !== 'paragraphs') return true
  if (task.steps.length !== 1) return false
  const step = task.steps[0]
  if (step?.scope.source !== 'task' || step.call.capability !== 'chapter.revise') return false
  const actual = step.call.input.reference
  const expected = task.scope.reference
  return actual.scope === 'paragraphs' && actual.section_id === expected.section_id
    && actual.content_sha256 === expected.content_sha256 && actual.start === expected.start
    && actual.end === expected.end && actual.text === expected.text
}, 'BID_CAPABILITY_PARAGRAPH_PLAN_INVALID')

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
  /** 保存用户原话与能力授权的 Interaction Session。 */
  readonly sourceSession?: WritingMessageSession
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
  /** 相同步骤及输入摘要的候选已存在，可继续其业务检查点。 */
  readonly resumeCandidate?: boolean
}

/** 已注册适配器接受的能力标识。 */
export type BidCapabilityId = z.infer<typeof bidCapabilityInputSchema>['capability']
/** 用户任务允许修改的项目或章节范围。 */
export type BidCapabilityScope = z.infer<typeof bidCapabilityScopeSchema>
/** 步骤从任务范围或前一步结果解析出的实际范围。 */
export type BidCapabilityStepScope = z.infer<typeof bidCapabilityStepScopeSchema>
/** 单次能力调用的标识与输入。 */
export type BidCapabilityCall = z.infer<typeof bidCapabilityInputSchema>
/** 适配器完成后的结构化结果。 */
export type BidCapabilityResult = z.infer<typeof bidCapabilityResultSchema>
/** 同一 Work 内有序执行的用户能力计划。 */
export type BidCapabilityTask = z.infer<typeof bidCapabilityTaskSchema>

/**
 * 接纳新任务或修改后续计划时拒绝缺少正文迁移及复核的计划；读取历史请求不调用。
 * @param task 已解析的任务。
 * @param hasExistingContent 授权范围内已有正文；研究深化可能需要迁移时由 Host 判定。
 * @throws 未明确暂缓正文且目录步骤缺少后续迁移和复核时拒绝。
 */
export function validateCapabilityTaskContentFollowup(task: BidCapabilityTask, hasExistingContent = false): void {
  if (task.allow_pending_content === true) return
  for (const [index, step] of task.steps.entries()) {
    const needsFollowup = step.call.capability === 'outline.update' && step.call.input.defer_content_migration
      || hasExistingContent && (step.call.capability === 'outline.refine'
        || step.call.capability === 'evidence.research' && step.call.input.allow_outline_refinement)
    if (!needsFollowup) continue
    const following = task.steps.slice(index + 1)
    const migration = following.findIndex(item => item.call.capability === 'chapter.reorganize')
    if (migration >= 0 && following.slice(migration + 1).some(item =>
      item.call.capability === 'chapter.write' || item.call.capability === 'chapter.review')) continue
    throw new Error('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED: 暂缓迁移只是中间步骤；请在同一任务补齐 chapter.reorganize 和 chapter.write 或 chapter.review。只有用户明确只改目录或暂缓正文时才可设置 allow_pending_content=true。')
  }
}

/** 计划中的一项能力调用与范围。 */
export type BidCapabilityStep = z.infer<typeof bidCapabilityStepSchema>
