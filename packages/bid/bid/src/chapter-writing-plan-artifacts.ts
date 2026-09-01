import { z } from 'zod'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import type { StageValidationIssue } from './control-plane-contract.ts'

/** Durable S6 relation-plan and execution-log format version. */
export const CHAPTER_EXECUTION_SCHEMA_VERSION = 2 as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

const sectionReferenceSchema = z.object({
  section_id: z.string().min(1),
  reason: z.string().trim().min(1),
}).strict()

/** Main-Agent-authored dependency and consistency plan for S6. */
export const chapterExecutionPlanSchema = z.object({
  schema_version: z.literal(CHAPTER_EXECUTION_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  confirmed_outline_sha256: sha256Schema,
  global_consistency_notes: z.array(z.string().trim().min(1)).min(1),
  sections: z.array(z.object({
    section_id: z.string().min(1),
    depends_on: z.array(sectionReferenceSchema),
    related_sections: z.array(sectionReferenceSchema.extend({ strength: z.literal('weak') }).strict()),
    planning_notes: z.array(z.string().trim().min(1)),
  }).strict()),
}).strict()

const executionAttemptSchema = z.object({
  role: z.enum(['writer', 'reviewer']),
  attempt: z.number().int().positive(),
  child_session_id: z.string().min(1),
  label: z.string().min(1),
  started_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }),
  stop_reason: z.string().min(1),
  accepted: z.boolean(),
  issues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
}).strict()

/** Host-owned record of the Child Sessions that produced each chapter. */
export const chapterExecutionLogSchema = z.object({
  schema_version: z.literal(CHAPTER_EXECUTION_SCHEMA_VERSION),
  scope: z.literal('technical_bid'),
  confirmed_outline_sha256: sha256Schema,
  max_concurrency: z.number().int().min(1).max(8),
  observed_max_concurrency: z.number().int().min(0).max(8),
  sections: z.array(z.object({
    section_id: z.string().min(1),
    depends_on: z.array(z.string().min(1)),
    related_sections: z.array(z.string().min(1)),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    attempts: z.array(executionAttemptSchema),
    final_writer_child_session_id: z.string().min(1).nullable(),
    final_reviewer_child_session_id: z.string().min(1).nullable(),
  }).strict()),
}).strict()

/** Parsed S6 relation plan. */
export type ChapterExecutionPlan = z.infer<typeof chapterExecutionPlanSchema>
/** Parsed S6 execution log. */
export type ChapterExecutionLog = z.infer<typeof chapterExecutionLogSchema>
/** One recorded Chapter Subagent attempt. */
export type ChapterExecutionAttempt = z.infer<typeof executionAttemptSchema>

/**
 * Parse a strict S6 relation plan.
 * @param value - decoded execution-plan value.
 * @returns strict current-version relation plan.
 */
export function parseChapterExecutionPlan(value: unknown): ChapterExecutionPlan {
  return chapterExecutionPlanSchema.parse(value)
}

/**
 * Parse a strict Host-owned S6 execution log.
 * @param value - decoded execution-log value.
 * @returns strict current-version execution log.
 */
export function parseChapterExecutionLog(value: unknown): ChapterExecutionLog {
  return chapterExecutionLogSchema.parse(value)
}

function issue(code: string, message: string, path?: string): StageValidationIssue {
  return { code, message, artifact: 'chapters/execution-plan.json', ...(path === undefined ? {} : { path }) }
}

/**
 * Validate relation-plan coverage and references against the current confirmed outline.
 * @param plan - schema-valid relation plan.
 * @param outline - current confirmed outline.
 * @param outlineHash - SHA-256 of the confirmed outline.
 * @returns all deterministic plan issues; an empty result authorizes Child creation.
 */
export function validateChapterExecutionPlan(
  plan: ChapterExecutionPlan,
  outline: OutlineArtifact,
  outlineHash: string,
): StageValidationIssue[] {
  const issues: StageValidationIssue[] = []
  if (plan.confirmed_outline_sha256 !== outlineHash) {
    issues.push(issue('CHAPTER_PLAN_OUTLINE_HASH_INVALID', '执行计划与当前确认目录不匹配。', 'confirmed_outline_sha256'))
  }
  const writable = new Set(outline.sections.filter(section => section.writable).map(section => section.id))
  const seen = new Set<string>()
  for (const [index, section] of plan.sections.entries()) {
    const base = `sections[${index}]`
    if (seen.has(section.section_id)) issues.push(issue('CHAPTER_PLAN_SECTION_DUPLICATE', '每个 writable section 必须恰好出现一次。', `${base}.section_id`))
    seen.add(section.section_id)
    if (!writable.has(section.section_id)) issues.push(issue('CHAPTER_PLAN_SECTION_UNKNOWN', '执行计划不得包含未知或不可写章节。', `${base}.section_id`))
    const dependencies = new Set<string>()
    for (const [dependencyIndex, dependency] of section.depends_on.entries()) {
      const path = `${base}.depends_on[${dependencyIndex}].section_id`
      if (!writable.has(dependency.section_id)) issues.push(issue('CHAPTER_PLAN_DEPENDENCY_UNKNOWN', '强依赖必须引用 writable section。', path))
      if (dependency.section_id === section.section_id) issues.push(issue('CHAPTER_PLAN_DEPENDENCY_SELF', '章节不得依赖自身。', path))
      if (dependencies.has(dependency.section_id)) issues.push(issue('CHAPTER_PLAN_DEPENDENCY_DUPLICATE', '同一强依赖不得重复。', path))
      dependencies.add(dependency.section_id)
    }
    const related = new Set<string>()
    for (const [relatedIndex, relation] of section.related_sections.entries()) {
      const path = `${base}.related_sections[${relatedIndex}].section_id`
      if (!writable.has(relation.section_id)) issues.push(issue('CHAPTER_PLAN_RELATED_UNKNOWN', '弱关联必须引用 writable section。', path))
      if (relation.section_id === section.section_id) issues.push(issue('CHAPTER_PLAN_RELATED_SELF', '章节不得关联自身。', path))
      if (related.has(relation.section_id)) issues.push(issue('CHAPTER_PLAN_RELATED_DUPLICATE', '同一弱关联不得重复。', path))
      if (dependencies.has(relation.section_id)) issues.push(issue('CHAPTER_PLAN_RELATION_CONFLICT', '同一章节不能同时是强依赖和弱关联。', path))
      related.add(relation.section_id)
    }
  }
  for (const sectionId of writable) {
    if (!seen.has(sectionId)) issues.push(issue('CHAPTER_PLAN_SECTION_MISSING', `执行计划遗漏 writable section：${sectionId}。`, 'sections'))
  }

  const dependencies = new Map(plan.sections.map(section => [section.section_id, section.depends_on.map(item => item.section_id)]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (sectionId: string): boolean => {
    if (visiting.has(sectionId)) return true
    if (visited.has(sectionId)) return false
    visiting.add(sectionId)
    for (const dependency of dependencies.get(sectionId) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true
    }
    visiting.delete(sectionId)
    visited.add(sectionId)
    return false
  }
  if ([...dependencies.keys()].some(visit)) issues.push(issue('CHAPTER_PLAN_DEPENDENCY_CYCLE', '章节强依赖不得形成环。', 'sections'))
  return issues
}
