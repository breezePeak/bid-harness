import { z } from 'zod'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'

/** S5 整体写作要求与执行计划的当前磁盘格式。 */
export const WRITING_PLAN_SCHEMA_VERSION = 1 as const

const pageBudgetSchema = z.object({
  min_pages: z.number().int().positive().nullable(),
  max_pages: z.number().int().positive().nullable(),
}).strict().refine(value => value.min_pages !== null || value.max_pages !== null, 'page budget needs at least one bound')
  .refine(value => value.min_pages === null || value.max_pages === null || value.min_pages <= value.max_pages,
    'min_pages must not exceed max_pages')

const writingPlanRevisionInputSchema = z.object({
  summary: z.string().trim().min(1),
  affected_section_ids: z.array(z.string().min(1)),
}).strict()

/** Main Agent 提交的语义计划；目录标识与版本由 Host 补充。 */
export const writingPlanInputSchema = z.object({
  user_requirements: z.array(z.string().trim().min(1)).min(1),
  overall_goal: z.string().trim().min(1),
  style_rules: z.array(z.string().trim().min(1)),
  global_rules: z.array(z.string().trim().min(1)),
  priorities: z.array(z.object({
    section_ids: z.array(z.string().min(1)).min(1),
    instruction: z.string().trim().min(1),
  }).strict()),
  page_target: z.object({
    kind: z.enum(['approximate', 'minimum', 'maximum', 'range']),
    min_pages: z.number().int().positive().nullable(),
    max_pages: z.number().int().positive().nullable(),
    estimate_basis: z.string().trim().min(1),
  }).strict().refine(value => value.kind === 'minimum'
    ? value.min_pages !== null && value.max_pages === null
    : value.kind === 'maximum'
      ? value.min_pages === null && value.max_pages !== null
      : value.min_pages !== null && value.max_pages !== null && value.min_pages <= value.max_pages,
  'page target bounds must match kind').nullable(),
  sections: z.array(z.object({
    section_id: z.string().min(1),
    emphasis: z.enum(['concise', 'standard', 'detailed']),
    page_budget: pageBudgetSchema.nullable(),
    instructions: z.array(z.string().trim().min(1)),
  }).strict()),
  revision: writingPlanRevisionInputSchema.nullable(),
}).strict()

/** 已确认且可供 S5 子任务消费的项目写作计划。 */
export const writingPlanSchema = writingPlanInputSchema.omit({ revision: true }).extend({
  schema_version: z.literal(WRITING_PLAN_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  plan_version: z.number().int().positive(),
  confirmed: z.literal(true),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
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

export type WritingPlanInput = z.infer<typeof writingPlanInputSchema>
export type WritingPlan = z.infer<typeof writingPlanSchema>

/** 校验模型计划只覆盖可写叶节，且文档目标等于叶节预算汇总。 */
export function validateWritingPlan(input: WritingPlanInput, outline: OutlineArtifact): string[] {
  const issues: string[] = []
  const parentIds = new Set(outline.sections.map(section => section.parent_id).filter((id): id is string => id !== null))
  const writableLeaves = outline.sections.filter(section => section.writable && !parentIds.has(section.id))
  const leafIds = new Set(writableLeaves.map(section => section.id))
  const seen = new Set<string>()
  for (const [index, section] of input.sections.entries()) {
    if (!leafIds.has(section.section_id)) issues.push(`sections.${index}.section_id 不是已确认目录中的可写叶节：${section.section_id}`)
    if (seen.has(section.section_id)) issues.push(`sections.${index}.section_id 重复：${section.section_id}`)
    seen.add(section.section_id)
  }
  for (const id of leafIds) if (!seen.has(id)) issues.push(`sections 缺少可写叶节：${id}`)
  for (const [index, priority] of input.priorities.entries()) {
    for (const id of priority.section_ids) if (!leafIds.has(id)) issues.push(`priorities.${index}.section_ids 引用了非可写叶节：${id}`)
  }
  if (input.revision !== null) {
    const affected = new Set<string>()
    for (const id of input.revision.affected_section_ids) {
      if (!leafIds.has(id)) issues.push(`revision.affected_section_ids 引用了非可写叶节：${id}`)
      if (affected.has(id)) issues.push(`revision.affected_section_ids 重复：${id}`)
      affected.add(id)
    }
  }
  const budgets = input.sections.map(section => section.page_budget)
  if (input.page_target === null) {
    if (budgets.some(budget => budget !== null)) issues.push('未设置整书页数目标时不得把章节页数标记为用户硬性预算')
  } else if (budgets.some(budget => budget === null)) {
    issues.push('设置整书页数目标时，每个可写叶节都必须有页数预算')
  } else {
    const values = budgets as Array<NonNullable<typeof budgets[number]>>
    const minValues = values.map(budget => budget.min_pages)
    const maxValues = values.map(budget => budget.max_pages)
    if ((input.page_target.min_pages === null) !== minValues.every(value => value === null)
      || input.page_target.min_pages !== null && minValues.some(value => value === null)) {
      issues.push('叶节最小页数预算必须与整书最小目标使用相同口径')
    } else if (input.page_target.min_pages !== null) {
      const min = (minValues as number[]).reduce((sum, value) => sum + value, 0)
      if (min !== input.page_target.min_pages) issues.push(`叶节最小页数预算汇总 ${min} 与整书目标 ${input.page_target.min_pages} 不一致`)
    }
    if ((input.page_target.max_pages === null) !== maxValues.every(value => value === null)
      || input.page_target.max_pages !== null && maxValues.some(value => value === null)) {
      issues.push('叶节最大页数预算必须与整书最大目标使用相同口径')
    } else if (input.page_target.max_pages !== null) {
      const max = (maxValues as number[]).reduce((sum, value) => sum + value, 0)
      if (max !== input.page_target.max_pages) issues.push(`叶节最大页数预算汇总 ${max} 与整书目标 ${input.page_target.max_pages} 不一致`)
    }
  }
  return issues
}

/** 读取并校验持久化写作计划。 */
export function parseWritingPlan(value: unknown): WritingPlan {
  return writingPlanSchema.parse(value)
}
