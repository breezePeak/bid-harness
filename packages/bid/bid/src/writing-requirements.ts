import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'

/** S5 通用写作任务契约的当前磁盘格式。 */
export const WRITING_PLAN_SCHEMA_VERSION = 3 as const

/** S5 初始原生询问的业务记录格式。 */
export const WRITING_REQUEST_SCHEMA_VERSION = 1 as const

/** 初始原生询问的唯一选项；自定义输入由 user-questions 组件提供。 */
export const WRITING_REQUIREMENT_NONE_OPTION = '没有，开始编写' as const

/** 一条由 Main Agent 选择、由 Host 回查原文的用户消息身份。 */
export const writingRequirementMessageRefSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
}).strict()

const writingPlanRevisionSchema = z.object({
  summary: z.string().trim().min(1),
  affected_section_ids: z.array(z.string().min(1)),
  base_plan_version: z.number().int().positive(),
}).strict()

const boundedMetricSchema = z.object({
  kind: z.literal('deterministic'),
  metric: z.enum(['estimated_pages', 'character_count']),
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
}).strict().refine(value => value.min !== null || value.max !== null, 'bounded metric needs at least one bound')
  .refine(value => value.min === null || value.max === null || value.min <= value.max, 'metric min must not exceed max')

/** Main Agent 对动态验收条件的语义定义；不包含 Host 可确定的身份与作用域。 */
export const acceptanceCriterionInputSchema = z.object({
  description: z.string().trim().min(1),
  priority: z.enum(['required', 'preferred']),
  evaluator: z.union([
    z.object({ kind: z.literal('semantic') }).strict(),
    boundedMetricSchema,
  ]),
}).strict()

const acceptanceCriterionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document') }).strict(),
  z.object({ kind: z.literal('section'), section_id: z.string().min(1) }).strict(),
])

/** Host 持久化的动态验收条件。 */
export const acceptanceCriterionSchema = acceptanceCriterionInputSchema.extend({
  id: z.string().regex(/^AC-\d{6}$/u),
  scope: acceptanceCriterionScopeSchema,
}).strict()

const sectionTaskInputSchema = z.object({
  section_id: z.string().min(1),
  task: z.string().trim().min(1),
  user_message_refs: z.array(writingRequirementMessageRefSchema),
  writing_instructions: z.array(z.string().trim().min(1)),
  acceptance_criteria: z.array(acceptanceCriterionInputSchema),
}).strict()

const sectionTaskSchema = sectionTaskInputSchema.omit({ acceptance_criteria: true }).extend({
  user_requirements: z.array(z.string().trim().min(1)),
  acceptance_criteria: z.array(acceptanceCriterionSchema),
}).strict()

const criterionUpdateSchema = z.object({
  criterion_id: z.string().regex(/^AC-\d{6}$/u),
  description: z.string().trim().min(1).optional(),
  priority: z.enum(['required', 'preferred']).optional(),
  evaluator: acceptanceCriterionInputSchema.shape.evaluator.optional(),
}).strict().refine(value => value.description !== undefined || value.priority !== undefined || value.evaluator !== undefined,
  'criterion update must change at least one field')

const criterionDeltaSchema = z.object({
  add: z.array(acceptanceCriterionInputSchema),
  update: z.array(criterionUpdateSchema),
  delete: z.array(z.string().regex(/^AC-\d{6}$/u)),
}).strict()

const sectionTaskPatchSchema = z.object({
  section_id: z.string().min(1),
  task: z.string().trim().min(1).optional(),
  add_user_message_refs: z.array(writingRequirementMessageRefSchema).optional(),
  writing_instructions: z.array(z.string().trim().min(1)).optional(),
  acceptance_criteria: criterionDeltaSchema.optional(),
}).strict().refine(value => value.task !== undefined || value.add_user_message_refs !== undefined
  || value.writing_instructions !== undefined || value.acceptance_criteria !== undefined,
'section patch must change at least one field')

/** Main Agent 首次建立完整 Writing Plan 时使用的输入协议。 */
export const initialWritingPlanInputSchema = z.object({
  update_kind: z.literal('initial'),
  /** 从 task_contract_context 原样带回的 Host 询问身份。 */
  writing_request_id: z.string().min(1),
  attempt_id: z.string().min(1),
  user_message_refs: z.array(writingRequirementMessageRefSchema),
  global_instructions: z.array(z.string().trim().min(1)).min(1),
  document_acceptance: z.array(acceptanceCriterionInputSchema),
  sections: z.array(sectionTaskInputSchema),
}).strict()

/** Main Agent 基于当前版本更新 Writing Plan 时使用的真实 patch 协议。 */
export const writingPlanPatchInputSchema = z.object({
  update_kind: z.literal('patch'),
  base_plan_version: z.number().int().positive(),
  user_message_refs: z.array(writingRequirementMessageRefSchema).min(1),
  summary: z.string().trim().min(1),
  affected_section_ids: z.array(z.string().min(1)),
  global_instructions: z.array(z.string().trim().min(1)).min(1).optional(),
  document_acceptance: criterionDeltaSchema.optional(),
  sections: z.array(sectionTaskPatchSchema),
}).strict()

/** Main Agent 首次提交完整计划，后续只提交对当前版本的真实 patch。 */
export const writingPlanInputSchema = z.discriminatedUnion('update_kind', [
  initialWritingPlanInputSchema,
  writingPlanPatchInputSchema,
])

/** 已确认且可供 S5 子任务消费的 Host 任务契约。 */
export const writingPlanSchema = z.object({
  schema_version: recordOnlySchemaVersion(WRITING_PLAN_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  plan_version: z.number().int().positive(),
  confirmed: z.literal(true),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  user_message_refs: z.array(writingRequirementMessageRefSchema),
  user_requirements: z.array(z.string().trim().min(1)),
  global_instructions: z.array(z.string().trim().min(1)).min(1),
  document_acceptance: z.array(acceptanceCriterionSchema),
  sections: z.array(sectionTaskSchema),
  revision: writingPlanRevisionSchema.nullable(),
}).strict()

const writingRequestAnswerSchema = z.object({
  question_id: z.string().min(1),
  kind: z.enum(['no_additional_requirements', 'custom']),
  selected: z.array(z.string()),
  custom: z.string().optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'custom' && (value.custom === undefined || value.custom.trim().length === 0)) {
    context.addIssue({ code: 'custom', message: 'custom writing requirement must not be blank' })
  }
})

/**
 * 写作计划处理进度的磁盘结构。
 */
export const writingPlanProcessingSchema = z.object({
  message_id: z.string().min(1),
  state: z.enum(['queued', 'running', 'failed']),
  turn: z.number().int().nonnegative().nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === 'running' && value.turn === null) {
    context.addIssue({ code: 'custom', message: 'running processing requires turn' })
  }
})

/**
 * 已校验的写作计划处理进度。
 */
export type WritingPlanProcessing = z.infer<typeof writingPlanProcessingSchema>

/** 已发出 S5 原生询问的项目记录；在线 Promise 不写入此文件。 */
export const writingRequestSchema = z.object({
  schema_version: recordOnlySchemaVersion(WRITING_REQUEST_SCHEMA_VERSION),
  request_id: z.string().min(1),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  owner_session_id: z.string().min(1),
  attempt_id: z.string().min(1),
  state: z.enum(['awaiting_answer', 'answered', 'consumed', 'dismissed']),
  continuation: z.enum(['allowed', 'paused']).default('allowed'),
  answer: writingRequestAnswerSchema.optional(),
  applied_plan_version: z.number().int().positive().optional(),
  processing_message_id: z.string().min(1).optional(),
  processing: writingPlanProcessingSchema.optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.state === 'answered' || value.state === 'consumed') && value.answer === undefined) {
    context.addIssue({ code: 'custom', message: 'answered writing request requires an answer' })
  }
  if (value.state === 'consumed' && value.applied_plan_version === undefined) {
    context.addIssue({ code: 'custom', message: 'consumed writing request requires applied_plan_version' })
  }
  if (value.answer?.question_id !== undefined && value.answer.question_id !== value.request_id) {
    context.addIssue({ code: 'custom', message: 'writing request answer must match request_id' })
  }
  if (value.answer?.kind === 'custom' && (value.answer.custom === undefined || value.answer.custom.trim().length === 0)) {
    context.addIssue({ code: 'custom', message: 'custom writing requirement must not be blank' })
  }
})

/** Main Agent 编写的 S5 初始计划或版本化 patch。 */
export type WritingPlanInput = z.infer<typeof writingPlanInputSchema>
/** Host 持久化的已确认版本化 S5 契约。 */
export type WritingPlan = z.infer<typeof writingPlanSchema>
/** 模型编写的、尚未绑定 Host 身份和作用域的验收条件。 */
export type AcceptanceCriterionInput = z.infer<typeof acceptanceCriterionInputSchema>
/** Writer 与 Reviewer 消费的 Host 绑定验收条件。 */
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>
/** Session Log 中一条用户原话的稳定引用。 */
export type WritingRequirementMessageRef = z.infer<typeof writingRequirementMessageRefSchema>

/** 一个 S5 初始原生问题的 Host 持久身份。 */
export type WritingRequest = z.infer<typeof writingRequestSchema>

/** S5 初始问题 wire 回答的业务语义。 */
export type WritingRequirementAnswer =
  | { readonly kind: 'no_additional_requirements'; readonly selected: readonly string[] }
  | { readonly kind: 'custom'; readonly selected: readonly string[]; readonly custom: string }
  | { readonly kind: 'dismissed' }

/** 校验并归类一条原生 S5 回答，不把插件消息或模型摘要当作用户要求。
 * @param requestId 预期的逻辑问题身份。
 * @param answer user-questions 服务返回的 wire 回答。
 * @returns 回答的业务含义。
 * @throws 回答身份或单选结构非法时抛出错误。
 */
export function classifyWritingRequirementAnswer(
  requestId: string,
  answer: AskUserQuestionAnswer,
): WritingRequirementAnswer {
  if (answer.answers.length !== 1 || answer.answers[0]?.id !== requestId) {
    throw new Error('BID_WRITING_QUESTION_ANSWER_ID_MISMATCH')
  }
  const item = answer.answers[0]
  if (item.selected.length > 1) throw new Error('BID_WRITING_QUESTION_MULTIPLE_SELECTIONS')
  if (item.selected.some(value => value !== WRITING_REQUIREMENT_NONE_OPTION)) {
    throw new Error('BID_WRITING_QUESTION_UNKNOWN_OPTION')
  }
  if (item.custom !== undefined) {
    if (item.custom.trim().length === 0) return { kind: 'dismissed' }
    return { kind: 'custom', selected: item.selected, custom: item.custom }
  }
  if (item.selected[0] === WRITING_REQUIREMENT_NONE_OPTION) {
    return { kind: 'no_additional_requirements', selected: item.selected }
  }
  return { kind: 'dismissed' }
}

/** Host 按稳定引用从 Session Log 解析的用户原话。 */
export interface ResolvedWritingRequirementMessage {
  readonly ref: WritingRequirementMessageRef
  readonly text: string
}

/** 只读用户事件数组；能力契约不把 Host Session 类型带入 Client face。 */
export interface WritingMessageSession {
  readonly id: string
  readonly events: readonly unknown[]
}

/**
 * 从授权用户会话日志解析写作要求原文，模型不能替换引用的文字。
 * @param session 当前任务的 Interaction Session。
 * @param refs 模型提交的稳定用户消息引用。
 * @returns 与引用绑定的原始用户文本。
 */
export function resolveWritingRequirementMessages(
  session: WritingMessageSession, refs: readonly WritingRequirementMessageRef[],
): ResolvedWritingRequirementMessage[] {
  return refs.map((ref) => {
    if (ref.session_id !== session.id) throw new Error(`用户消息引用不属于当前 Session：${ref.session_id}/${ref.seq}`)
    const event = z.object({ type: z.literal('user/message'), data: z.object({
      source: z.object({ kind: z.literal('user') }).loose(),
      id: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
    }).loose() }).loose().safeParse(session.events[ref.seq])
    if (!event.success || event.data.data.id !== ref.message_id) {
      throw new Error(`用户消息引用不存在或身份不匹配：${ref.session_id}/${ref.seq}/${ref.message_id}`)
    }
    const text = event.data.data.content.flatMap(block => block.type === 'text' && block.text !== undefined
      ? [block.text] : []).join('\n').trim()
    if (text.length === 0) throw new Error(`用户消息引用没有可持久化的文本：${ref.session_id}/${ref.seq}`)
    return { ref, text }
  })
}

/**
 * 按确认目录构造无用户原话的自动写作计划。
 * @param outline 当前最终确认目录。
 * @param confirmedOutlineSha256 当前确认目录的 SHA-256。
 * @returns 覆盖全部可写叶节的 schema v3 Writing Plan。
 */
export function createAutomaticWritingPlan(
  outline: OutlineArtifact,
  confirmedOutlineSha256: string,
): WritingPlan {
  const parentIds = new Set(outline.sections.map(section => section.parent_id).filter((id): id is string => id !== null))
  return writingPlanSchema.parse({
    schema_version: WRITING_PLAN_SCHEMA_VERSION,
    scope: 'technical_bid',
    plan_version: 1,
    confirmed: true,
    confirmed_outline_sha256: confirmedOutlineSha256,
    user_message_refs: [],
    user_requirements: [],
    global_instructions: ['按最终确认目录、招标要求和现有资料完成技术标正文'],
    document_acceptance: [],
    sections: outline.sections.filter(section => section.writable && !parentIds.has(section.id)).map(section => ({
      section_id: section.id,
      task: section.purpose,
      user_message_refs: [],
      user_requirements: [],
      writing_instructions: [],
      acceptance_criteria: [],
    })),
    revision: null,
  })
}

function refKey(ref: WritingRequirementMessageRef): string {
  return `${ref.session_id}\u0000${ref.seq}\u0000${ref.message_id}`
}

function uniqueRefs(values: readonly WritingRequirementMessageRef[]): WritingRequirementMessageRef[] {
  return [...new Map(values.map(value => [refKey(value), value])).values()]
}

function criterionKey(criterion: AcceptanceCriterionInput): string {
  return JSON.stringify({
    description: criterion.description,
    priority: criterion.priority,
    evaluator: criterion.evaluator,
  })
}

/**
 * 从全部既有条件分配下一组 AC 身份，退役章节身份不会被新章节复用。
 * @param previous 当前 Writing Plan。
 * @returns 每次调用产生一个新的章节或文档条件 ID。
 */
export function nextCriterionId(previous?: WritingPlan): () => string {
  const prior = previous === undefined ? [] : [
    ...previous.document_acceptance,
    ...previous.sections.flatMap(section => section.acceptance_criteria),
  ]
  let next = prior.reduce((maximum, criterion) => Math.max(maximum, Number.parseInt(criterion.id.slice(3), 10)), 0) + 1
  return () => `AC-${String(next++).padStart(6, '0')}`
}

function applyCriterionDelta(
  current: readonly AcceptanceCriterion[],
  delta: z.infer<typeof criterionDeltaSchema> | undefined,
  scope: AcceptanceCriterion['scope'],
  allocateId: () => string,
): AcceptanceCriterion[] {
  if (delta === undefined) return [...current]
  const deleting = new Set(delta.delete)
  const updates = new Map(delta.update.map(update => [update.criterion_id, update]))
  return [
    ...current.filter(criterion => !deleting.has(criterion.id)).map((criterion) => {
      const update = updates.get(criterion.id)
      return update === undefined ? criterion : acceptanceCriterionSchema.parse({
        ...criterion,
        ...(update.description === undefined ? {} : { description: update.description }),
        ...(update.priority === undefined ? {} : { priority: update.priority }),
        ...(update.evaluator === undefined ? {} : { evaluator: update.evaluator }),
      })
    }),
    ...delta.add.map(criterion => acceptanceCriterionSchema.parse({ ...criterion, id: allocateId(), scope })),
  ]
}

function messageTextByRef(messages: readonly ResolvedWritingRequirementMessage[]): Map<string, string> {
  return new Map(messages.map(message => [refKey(message.ref), message.text]))
}

/**
 * Apply an initial plan or patch without allowing unchanged sections or criterion IDs to drift.
 * @param input Main Agent submission parsed at the tool boundary.
 * @param messages Exact human messages resolved by the Host from submitted references.
 * @param previous Current plan for a patch; absent for an initial plan.
 * @returns Complete next-version plan fields and the actual section invalidation set.
 */
export function applyWritingPlanInput(
  input: WritingPlanInput,
  messages: readonly ResolvedWritingRequirementMessage[],
  previous?: WritingPlan,
): Pick<WritingPlan, 'user_message_refs' | 'user_requirements' | 'global_instructions' | 'document_acceptance' | 'sections'>
  & { readonly affected_section_ids: readonly string[] } {
  const texts = messageTextByRef(messages)
  const textFor = (ref: WritingRequirementMessageRef): string => {
    const text = texts.get(refKey(ref))
    if (text === undefined) throw new Error(`未解析用户消息引用：${ref.session_id}/${ref.seq}/${ref.message_id}`)
    return text
  }
  const allocateId = nextCriterionId(previous)
  if (input.update_kind === 'initial') {
    if (previous !== undefined) throw new Error('已有写作计划只能提交 patch。')
    const userRefs = uniqueRefs(input.user_message_refs)
    return {
      user_message_refs: userRefs,
      user_requirements: userRefs.map(textFor),
      global_instructions: input.global_instructions,
      document_acceptance: input.document_acceptance.map(criterion => acceptanceCriterionSchema.parse({
        ...criterion, id: allocateId(), scope: { kind: 'document' },
      })),
      sections: input.sections.map((section) => {
        const refs = uniqueRefs(section.user_message_refs)
        return {
          ...section,
          user_message_refs: refs,
          user_requirements: refs.map(textFor),
          acceptance_criteria: section.acceptance_criteria.map(criterion => acceptanceCriterionSchema.parse({
            ...criterion, id: allocateId(), scope: { kind: 'section', section_id: section.section_id },
          })),
        }
      }),
      affected_section_ids: input.sections.map(section => section.section_id),
    }
  }
  if (previous === undefined) throw new Error('首次写作计划必须提交 initial。')
  if (input.base_plan_version !== previous.plan_version) throw new Error('写作计划版本已变化，请重新读取后提交 patch。')
  const newRefs = uniqueRefs(input.user_message_refs)
  const sectionRefKeys = new Set(input.sections.flatMap(section => section.add_user_message_refs ?? []).map(refKey))
  const patches = new Map(input.sections.map(section => [section.section_id, section]))
  const sections = previous.sections.map((section) => {
    const patch = patches.get(section.section_id)
    if (patch === undefined) return section
    const addedRefs = uniqueRefs(patch.add_user_message_refs ?? [])
    return {
      ...section,
      ...(patch.task === undefined ? {} : { task: patch.task }),
      user_message_refs: uniqueRefs([...section.user_message_refs, ...addedRefs]),
      user_requirements: [...section.user_requirements, ...addedRefs.map(textFor)],
      ...(patch.writing_instructions === undefined ? {} : { writing_instructions: patch.writing_instructions }),
      acceptance_criteria: applyCriterionDelta(
        section.acceptance_criteria, patch.acceptance_criteria,
        { kind: 'section', section_id: section.section_id }, allocateId,
      ),
    }
  })
  return {
    user_message_refs: uniqueRefs([...previous.user_message_refs, ...newRefs]),
    user_requirements: [...previous.user_requirements,
      ...newRefs.filter(ref => !sectionRefKeys.has(refKey(ref))).map(textFor)],
    global_instructions: input.global_instructions ?? previous.global_instructions,
    document_acceptance: applyCriterionDelta(
      previous.document_acceptance, input.document_acceptance, { kind: 'document' }, allocateId,
    ),
    sections,
    affected_section_ids: [...new Set([...input.affected_section_ids, ...patches.keys()])],
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.filter(value => seen.has(value) || (seen.add(value), false))
}

/**
 * 在应用前校验 Main Agent 输入与当前目录及计划的一致性。
 * @param input 已通过工具边界 Schema 的 initial 或 patch 输入。
 * @param outline 当前确认目录。
 * @param previous 当前 Writing Plan；首次提交时为空。
 * @returns 全部确定性结构问题；空数组表示可应用。
 */
export function validateWritingPlanInput(
  input: WritingPlanInput,
  outline: OutlineArtifact,
  previous?: WritingPlan,
): string[] {
  const issues: string[] = []
  const parentIds = new Set(outline.sections.map(section => section.parent_id).filter((id): id is string => id !== null))
  const leafIds = new Set(outline.sections.filter(section => section.writable && !parentIds.has(section.id)).map(section => section.id))
  const refs = new Set(input.user_message_refs.map(refKey))
  if (duplicates(input.user_message_refs.map(refKey)).length > 0) issues.push('user_message_refs 不得重复')
  if (input.update_kind === 'initial') {
    if (previous !== undefined) issues.push('已有写作计划只能提交 patch')
    const seen = new Set<string>()
    for (const [index, section] of input.sections.entries()) {
      if (!leafIds.has(section.section_id)) issues.push(`sections.${index}.section_id 不是已确认目录中的可写叶节：${section.section_id}`)
      if (seen.has(section.section_id)) issues.push(`sections.${index}.section_id 重复：${section.section_id}`)
      seen.add(section.section_id)
      if (section.user_message_refs.some(ref => !refs.has(refKey(ref)))) issues.push(`sections.${index}.user_message_refs 必须来自顶层 user_message_refs`)
    }
    for (const id of leafIds) if (!seen.has(id)) issues.push(`sections 缺少可写叶节：${id}`)
    return issues
  }
  if (previous === undefined) issues.push('首次写作计划必须提交 initial')
  else if (input.base_plan_version !== previous.plan_version) issues.push('base_plan_version 与当前计划不一致')
  const sectionIds = new Set<string>()
  for (const [index, section] of input.sections.entries()) {
    if (!leafIds.has(section.section_id)) issues.push(`sections.${index}.section_id 不是已确认目录中的可写叶节：${section.section_id}`)
    if (sectionIds.has(section.section_id)) issues.push(`sections.${index}.section_id 重复：${section.section_id}`)
    sectionIds.add(section.section_id)
    if (section.add_user_message_refs?.some(ref => !refs.has(refKey(ref))) === true) issues.push(`sections.${index}.add_user_message_refs 必须来自顶层 user_message_refs`)
    if (previous !== undefined) validateCriterionDelta(section.acceptance_criteria, previous.sections.find(item => item.section_id === section.section_id)?.acceptance_criteria ?? [], `sections.${index}.acceptance_criteria`, issues)
  }
  const affected = new Set<string>()
  for (const id of input.affected_section_ids) {
    if (!leafIds.has(id)) issues.push(`affected_section_ids 引用了非可写叶节：${id}`)
    if (affected.has(id)) issues.push(`affected_section_ids 重复：${id}`)
    affected.add(id)
  }
  if (previous !== undefined) validateCriterionDelta(input.document_acceptance, previous.document_acceptance, 'document_acceptance', issues)
  return issues
}

function validateCriterionDelta(
  delta: z.infer<typeof criterionDeltaSchema> | undefined,
  current: readonly AcceptanceCriterion[],
  path: string,
  issues: string[],
): void {
  if (delta === undefined) return
  const known = new Set(current.map(criterion => criterion.id))
  const touched = [...delta.update.map(item => item.criterion_id), ...delta.delete]
  for (const id of touched) if (!known.has(id)) issues.push(`${path} 引用了不属于该作用域的 criterion：${id}`)
  for (const id of duplicates(touched)) issues.push(`${path} 重复修改或删除 criterion：${id}`)
}

/**
 * 校验完整持久化计划的目录覆盖、criterion scope 和全局 ID。
 * @param input 已绑定 Host 身份的完整 Writing Plan。
 * @param outline 当前确认目录。
 * @returns 全部确定性结构问题；空数组表示有效。
 */
export function validateWritingPlan(input: WritingPlan, outline: OutlineArtifact): string[] {
  const issues: string[] = []
  const parentIds = new Set(outline.sections.map(section => section.parent_id).filter((id): id is string => id !== null))
  const leafIds = new Set(outline.sections.filter(section => section.writable && !parentIds.has(section.id)).map(section => section.id))
  const seenSections = new Set<string>()
  const seenCriteria = new Set<string>()
  const acceptCriteria = (criteria: readonly AcceptanceCriterion[], scope: AcceptanceCriterion['scope'], path: string): void => {
    const semantic = new Set<string>()
    for (const [index, criterion] of criteria.entries()) {
      if (seenCriteria.has(criterion.id)) issues.push(`${path}.${index}.id 全局重复：${criterion.id}`)
      seenCriteria.add(criterion.id)
      if (JSON.stringify(criterion.scope) !== JSON.stringify(scope)) issues.push(`${path}.${index}.scope 与所在容器不一致`)
      const key = criterionKey(criterion)
      if (semantic.has(key)) issues.push(`${path}.${index} 与同一作用域内已有验收条件重复`)
      semantic.add(key)
    }
  }
  acceptCriteria(input.document_acceptance, { kind: 'document' }, 'document_acceptance')
  for (const [index, section] of input.sections.entries()) {
    if (!leafIds.has(section.section_id)) issues.push(`sections.${index}.section_id 不是已确认目录中的可写叶节：${section.section_id}`)
    if (seenSections.has(section.section_id)) issues.push(`sections.${index}.section_id 重复：${section.section_id}`)
    seenSections.add(section.section_id)
    acceptCriteria(section.acceptance_criteria, { kind: 'section', section_id: section.section_id }, `sections.${index}.acceptance_criteria`)
  }
  for (const id of leafIds) if (!seenSections.has(id)) issues.push(`sections 缺少可写叶节：${id}`)
  if (input.revision !== null) {
    const affected = new Set<string>()
    for (const id of input.revision.affected_section_ids) {
      if (!leafIds.has(id)) issues.push(`revision.affected_section_ids 引用了非可写叶节：${id}`)
      if (affected.has(id)) issues.push(`revision.affected_section_ids 重复：${id}`)
      affected.add(id)
    }
  }
  return issues
}

/**
 * 解析持久化的 Writing Plan。
 * @param value 未信任的磁盘数据。
 * @returns 当前严格格式的 Writing Plan。
 */
export function parseWritingPlan(value: unknown): WritingPlan {
  return writingPlanSchema.parse(value)
}
