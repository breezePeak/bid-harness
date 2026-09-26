/** 章节研究、写作与审核共用的必答任务及依据计划。 */
import { z } from 'zod'

const text = z.string().trim().min(1)

/** Host 绑定的业务目标；must_answer 的位置与原文同时保存以识别职责变化。 */
export const answerTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('must_answer'), position: z.number().int().nonnegative(), text }).strict(),
  z.object({ kind: z.enum(['requirement', 'response_point', 'compliance']), id: text }).strict(),
])

/** 依据的来源身份，不把章节职责或模型结论当作现实事实证明。 */
export const answerBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('s2'), artifact: z.enum(['project', 'requirement', 'scoring', 'response_point', 'compliance']), record_id: text.optional() }).strict(),
  z.object({ kind: z.literal('local'), file_id: text, chunk: z.string().regex(/^chunk_\d{4}$/u) }).strict(),
  z.object({ kind: z.literal('web'), source_id: z.string().regex(/^WEB-[a-f0-9]{16}$/u), chunk_refs: z.array(z.string().regex(/^W:WEB-[a-f0-9]{16}:C\d{4}$/u)).min(1) }).strict(),
  z.object({ kind: z.literal('section_responsibility'), section_id: text }).strict(),
])

export const sectionAnswerPlanItemSchema = z.object({
  targets: z.array(answerTargetSchema).min(1),
  mode: z.enum(['supported', 'proposal', 'gap']),
  content: text,
  basis: z.array(answerBasisSchema),
  boundary: text,
  required_input: text.optional(),
}).strict().superRefine((item, ctx) => {
  if (item.mode === 'gap' && item.required_input === undefined) {
    ctx.addIssue({ code: 'custom', path: ['required_input'], message: '真实缺口必须说明需要哪项输入。' })
  }
  if (item.mode === 'supported' && !item.basis.some(basis => basis.kind !== 'section_responsibility')) {
    ctx.addIssue({ code: 'custom', path: ['basis'], message: '章节职责不能单独证明事实。' })
  }
  if (item.mode !== 'gap' && item.basis.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['basis'], message: '具体回应必须说明依据或设计目标。' })
  }
})

/** 缺失表示历史章节尚未完成依据准备；空数组也不表示任务已覆盖。 */
export const sectionAnswerPlanSchema = z.array(sectionAnswerPlanItemSchema)
export type SectionAnswerPlan = z.infer<typeof sectionAnswerPlanSchema>
export type AnswerTarget = z.infer<typeof answerTargetSchema>

/** Child 使用短引用，来源身份和目标身份均由 Host 在接受时绑定。 */
export const sectionAnswerPlanInputSchema = z.array(z.object({
  target_refs: z.array(z.string().regex(/^R\d+$/u)).min(1),
  mode: z.enum(['supported', 'proposal', 'gap']),
  content: text,
  basis: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('s2'), artifact: z.enum(['project', 'requirement', 'scoring', 'response_point', 'compliance']), record_id: text.optional() }).strict(),
    z.object({ kind: z.literal('local'), material_ref: z.string().regex(/^M\d+:chunk_\d{4}$/u) }).strict(),
    z.object({ kind: z.literal('web'), chunk_refs: z.array(z.string().regex(/^W:WEB-[a-f0-9]{16}:C\d{4}$/u)).min(1) }).strict(),
    z.object({ kind: z.literal('section_responsibility') }).strict(),
  ])),
  boundary: text,
  required_input: text.optional(),
}).strict())
export type SectionAnswerPlanInput = z.infer<typeof sectionAnswerPlanInputSchema>

export interface AnswerChecklistItem {
  readonly item_ref: string
  readonly kind: AnswerTarget['kind']
  readonly id: string | null
  readonly text: string
  readonly target: AnswerTarget
}

/**
 * 建立章节的规范任务顺序，供研究中的短引用和审核中的 R 引用共用。
 * @param context 当前叶节及已确认的适用 S2 记录。
 * @returns R1…Rn 与 Host 可绑定的业务目标。
 */
export function buildSectionAnswerChecklist(context: {
  section: { must_answer: readonly string[] }
  requirements: readonly { id: string; normalized_requirement: string }[]
  responsePoints: readonly { id: string; text: string }[]
  compliance: readonly { id: string; normalized_rule: string }[]
}): AnswerChecklistItem[] {
  const items = [
    ...context.section.must_answer.map((value, position) => ({ kind: 'must_answer' as const,
      id: null, text: value, target: { kind: 'must_answer' as const, position, text: value } })),
    ...context.requirements.map(value => ({ kind: 'requirement' as const, id: value.id,
      text: value.normalized_requirement, target: { kind: 'requirement' as const, id: value.id } })),
    ...context.responsePoints.map(value => ({ kind: 'response_point' as const, id: value.id,
      text: value.text, target: { kind: 'response_point' as const, id: value.id } })),
    ...context.compliance.map(value => ({ kind: 'compliance' as const, id: value.id,
      text: value.normalized_rule, target: { kind: 'compliance' as const, id: value.id } })),
  ]
  return items.map((item, index) => ({ item_ref: `R${index + 1}`, ...item }))
}

/**
 * 校验计划仍覆盖当前任务，并且所有来源属于本次已接受的材料。
 * @param plan 已绑定的计划。
 * @param checklist 当前规范任务。
 * @param sourceKeys 已读取并接受的来源身份；S2 和章节职责由调用方从确认输入提供。
 * @returns 可供工具反馈或 Validator 报告的确定性问题。
 */
export function validateSectionAnswerPlan(
  plan: SectionAnswerPlan | undefined,
  checklist: readonly AnswerChecklistItem[],
  sourceKeys: ReadonlySet<string>,
): string[] {
  if (plan === undefined) return ['answer_plan: 当前章节尚未完成任务级依据准备。']
  const targets = new Set(checklist.map(item => JSON.stringify(item.target)))
  const covered = new Set<string>()
  const issues: string[] = []
  for (const [index, item] of plan.entries()) {
    for (const target of item.targets) {
      const key = JSON.stringify(target)
      if (!targets.has(key)) issues.push(`answer_plan.${index}.targets: 目标不属于当前章节任务。`)
      covered.add(key)
    }
    for (const basis of item.basis) {
      const key = basis.kind === 's2' ? `s2:${basis.artifact}:${basis.record_id ?? ''}`
        : basis.kind === 'local' ? `local:${basis.file_id}:${basis.chunk}`
          : basis.kind === 'web' ? `web:${basis.source_id}:${basis.chunk_refs.join(',')}`
            : `section:${basis.section_id}`
      if (!sourceKeys.has(key)) issues.push(`answer_plan.${index}.basis: 未接受的依据 ${key}。`)
    }
  }
  for (const item of checklist) if (!covered.has(JSON.stringify(item.target))) {
    issues.push(`answer_plan: 未回应 ${item.item_ref}。`)
  }
  return issues
}

/**
 * 将当前 Child 的短引用绑定为正式任务和来源身份；预览、搜索命中不属于已读集合。
 * @param input Child 提交的逐项回应。
 * @param checklist 当前章节的规范任务。
 * @param sources 本次 Child 已实际读取且 Host 接受的来源。
 * @returns 可持久化的任务级依据计划。
 */
export function bindSectionAnswerPlan(input: SectionAnswerPlanInput, checklist: readonly AnswerChecklistItem[], sources: {
  readonly s2Keys: ReadonlySet<string>
  readonly local: ReadonlyMap<string, { file_id: string; chunk: string }>
  readonly webChunkRefs: ReadonlySet<string>
  readonly sectionId: string
}): SectionAnswerPlan {
  const byRef = new Map(checklist.map(item => [item.item_ref, item.target]))
  const bound = input.map(item => ({
    targets: item.target_refs.map((ref) => {
      const target = byRef.get(ref)
      if (target === undefined) throw new Error(`ANSWER_PLAN_TARGET_UNKNOWN: ${ref}`)
      return target
    }),
    mode: item.mode,
    content: item.content,
    basis: item.basis.map((basis) => {
      if (basis.kind === 's2') {
        if (!sources.s2Keys.has(`s2:${basis.artifact}:${basis.record_id ?? ''}`)) {
          throw new Error(`ANSWER_PLAN_S2_UNKNOWN: ${basis.artifact}:${basis.record_id ?? ''}`)
        }
        return basis
      }
      if (basis.kind === 'local') {
        const material = sources.local.get(basis.material_ref)
        if (material === undefined) throw new Error(`ANSWER_PLAN_LOCAL_UNREAD: ${basis.material_ref}`)
        return { kind: 'local' as const, ...material }
      }
      if (basis.kind === 'web') {
        if (basis.chunk_refs.some(ref => !sources.webChunkRefs.has(ref))) {
          throw new Error(`ANSWER_PLAN_WEB_UNREAD: ${basis.chunk_refs.join(',')}`)
        }
        const sourceId = basis.chunk_refs[0]?.slice(2, 22)
        if (sourceId === undefined || basis.chunk_refs.some(ref => !ref.startsWith(`W:${sourceId}:`))) {
          throw new Error('ANSWER_PLAN_WEB_MIXED_SOURCE')
        }
        return { kind: 'web' as const, source_id: sourceId, chunk_refs: basis.chunk_refs }
      }
      return { kind: 'section_responsibility' as const, section_id: sources.sectionId }
    }),
    boundary: item.boundary,
    ...(item.required_input === undefined ? {} : { required_input: item.required_input }),
  }))
  const plan = sectionAnswerPlanSchema.parse(bound)
  const sourceKeys = new Set<string>([
    ...sources.s2Keys,
    ...[...sources.local.values()].map(value => `local:${value.file_id}:${value.chunk}`),
    ...plan.flatMap(item => item.basis.filter(basis => basis.kind === 'web')
      .map(basis => `web:${basis.source_id}:${basis.chunk_refs.join(',')}`)),
    `section:${sources.sectionId}`,
  ])
  const issues = validateSectionAnswerPlan(plan, checklist, sourceKeys)
  if (issues.length > 0) throw new Error(issues.join('\n'))
  return plan
}
