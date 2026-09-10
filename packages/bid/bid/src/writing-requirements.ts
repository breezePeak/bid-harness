import { z } from 'zod'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'

/** S5 通用写作任务契约的当前磁盘格式。 */
export const WRITING_PLAN_SCHEMA_VERSION = 2 as const

const writingPlanRevisionInputSchema = z.object({
  summary: z.string().trim().min(1),
  affected_section_ids: z.array(z.string().min(1)),
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
  user_requirements: z.array(z.string().trim().min(1)),
  writing_instructions: z.array(z.string().trim().min(1)),
  acceptance_criteria: z.array(acceptanceCriterionInputSchema).min(1),
}).strict()

const sectionTaskSchema = sectionTaskInputSchema.omit({ acceptance_criteria: true }).extend({
  acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
}).strict()

/** Main Agent 提交的语义任务契约；身份、版本与验收作用域由 Host 补充。 */
export const writingPlanInputSchema = z.object({
  user_requirements: z.array(z.string().trim().min(1)).min(1),
  global_instructions: z.array(z.string().trim().min(1)).min(1),
  document_acceptance: z.array(acceptanceCriterionInputSchema).min(1),
  sections: z.array(sectionTaskInputSchema),
  revision: writingPlanRevisionInputSchema.nullable(),
}).strict()

/** 已确认且可供 S5 子任务消费的 Host 任务契约。 */
export const writingPlanSchema = z.object({
  schema_version: z.literal(WRITING_PLAN_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  plan_version: z.number().int().positive(),
  confirmed: z.literal(true),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  user_requirements: z.array(z.string().trim().min(1)).min(1),
  global_instructions: z.array(z.string().trim().min(1)).min(1),
  document_acceptance: z.array(acceptanceCriterionSchema).min(1),
  sections: z.array(sectionTaskSchema),
  revision: writingPlanRevisionInputSchema.extend({
    base_plan_version: z.number().int().positive(),
  }).strict().nullable(),
}).strict()

/** 已发出 S5 询问的项目标记。 */
export const writingRequestSchema = z.object({
  schema_version: z.literal(WRITING_PLAN_SCHEMA_VERSION),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  session_id: z.string().min(1),
  request_after_seq: z.number().int().min(-1),
  base_plan_version: z.number().int().positive().nullable(),
}).strict()

/** Main-Agent-authored S5 contract before Host identity binding. */
export type WritingPlanInput = z.infer<typeof writingPlanInputSchema>
/** Confirmed, versioned S5 contract persisted by the Host. */
export type WritingPlan = z.infer<typeof writingPlanSchema>
/** One model-authored criterion without Host identity or scope. */
export type AcceptanceCriterionInput = z.infer<typeof acceptanceCriterionInputSchema>
/** One Host-bound criterion consumed by Writers and Reviewers. */
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>

function criterionKey(criterion: AcceptanceCriterionInput): string {
  return JSON.stringify(criterion)
}

/**
 * 为模型任务契约补充 Host 身份，并在同一作用域的条件未变化时复用身份。
 * @param input 已通过边界解析的 Main Agent 输入。
 * @param previous 当前已保存的上一版本任务契约。
 * @returns 可直接写入新计划的全书与章节条件。
 */
export function materializeAcceptanceCriteria(
  input: WritingPlanInput,
  previous?: WritingPlan,
): Pick<WritingPlan, 'document_acceptance' | 'sections'> {
  const previousCriteria = [
    ...previous?.document_acceptance ?? [],
    ...previous?.sections.flatMap(section => section.acceptance_criteria) ?? [],
  ]
  let nextId = previousCriteria.reduce((maximum, criterion) => Math.max(maximum, Number.parseInt(criterion.id.slice(3), 10)), 0) + 1
  const reusable = new Map<string, string[]>()
  for (const criterion of previousCriteria) {
    const key = JSON.stringify({ scope: criterion.scope, criterion: {
      description: criterion.description, priority: criterion.priority, evaluator: criterion.evaluator,
    } })
    reusable.set(key, [...reusable.get(key) ?? [], criterion.id])
  }
  const accept = (criterion: AcceptanceCriterionInput, scope: AcceptanceCriterion['scope']): AcceptanceCriterion => {
    const key = JSON.stringify({ scope, criterion })
    const ids = reusable.get(key)
    const id = ids?.shift() ?? `AC-${String(nextId++).padStart(6, '0')}`
    return { ...criterion, id, scope }
  }
  return {
    document_acceptance: input.document_acceptance.map(criterion => accept(criterion, { kind: 'document' })),
    sections: input.sections.map(section => ({
      ...section,
      acceptance_criteria: section.acceptance_criteria.map(criterion => accept(criterion, {
        kind: 'section', section_id: section.section_id,
      })),
    })),
  }
}

/**
 * 校验模型任务契约只覆盖可写叶节，且显式影响范围有效。
 * @param input Main Agent 输入或已绑定的持久化计划。
 * @param outline 当前确认目录。
 * @returns 所有确定性结构问题；空数组表示通过。
 */
export function validateWritingPlan(input: WritingPlanInput | WritingPlan, outline: OutlineArtifact): string[] {
  const issues: string[] = []
  const parentIds = new Set(outline.sections.map(section => section.parent_id).filter((id): id is string => id !== null))
  const writableLeaves = outline.sections.filter(section => section.writable && !parentIds.has(section.id))
  const leafIds = new Set(writableLeaves.map(section => section.id))
  const seen = new Set<string>()
  const acceptCriteria = (criteria: readonly AcceptanceCriterionInput[], path: string): void => {
    const unique = new Set<string>()
    for (const [index, criterion] of criteria.entries()) {
      const key = criterionKey(criterion)
      if (unique.has(key)) issues.push(`${path}.${index} 与同一作用域内已有验收条件重复`)
      unique.add(key)
    }
  }
  acceptCriteria(input.document_acceptance, 'document_acceptance')
  for (const [index, section] of input.sections.entries()) {
    if (!leafIds.has(section.section_id)) issues.push(`sections.${index}.section_id 不是已确认目录中的可写叶节：${section.section_id}`)
    if (seen.has(section.section_id)) issues.push(`sections.${index}.section_id 重复：${section.section_id}`)
    seen.add(section.section_id)
    acceptCriteria(section.acceptance_criteria, `sections.${index}.acceptance_criteria`)
  }
  for (const id of leafIds) if (!seen.has(id)) issues.push(`sections 缺少可写叶节：${id}`)
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
 * 读取并校验持久化写作计划。
 * @param value 不可信的磁盘 JSON。
 * @returns 严格的当前版本计划。
 */
export function parseWritingPlan(value: unknown): WritingPlan {
  return writingPlanSchema.parse(value)
}
