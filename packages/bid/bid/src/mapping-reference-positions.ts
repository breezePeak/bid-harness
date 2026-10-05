/** S4 研究依据与 S2 作答依据共用引用位置，由 Host 派生来源类别。 */
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { s2AnswerArtifactSchema } from './section-answer-plan.ts'

/** 本次 Child 可见的统一引用对象；来源类别来自 Host 的权威输入。 */
export interface MappingReferenceObject {
  readonly id: string
  readonly kind: string
}

const researchSelection = z.object({ reference_position: z.number().int().nonnegative() }).strict()
const s2Selection = z.object({ kind: z.literal('s2'), record_position: z.number().int().nonnegative() }).strict()

/** 将模型参数解析失败转换为工具参数诊断。 */
function parseSelection<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ToolArgsError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`))
  return result.data
}

/**
 * 为同一个引用表投影工具 Schema，并在接受参数时绑定来源身份与类别。
 * @param references 本轮 objects.references 的实际顺序。
 * @param researchKinds 正式研究依据 Schema 接受的来源类别；材料读取权限仍由研究 Validator 校验。
 * @returns 拒绝模型原始身份和派生类别的 Schema 投影及参数绑定器。
 */
export function createMappingReferencePositions(references: readonly MappingReferenceObject[], researchKinds: readonly string[]): {
  schema: (value: Record<string, unknown>) => Record<string, unknown>
  bind: (value: unknown) => unknown
} {
  const select = (position: number, field: string): MappingReferenceObject => {
    const selected = references[position]
    if (selected === undefined) throw new ToolArgsError([`${field}: 未知对象位置 ${position}（objects.references）。`])
    return selected
  }
  const bind = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bind)
    if (value === null || typeof value !== 'object') return value
    const input = value as Record<string, unknown>
    if (Object.hasOwn(input, 'ref') || Object.hasOwn(input, 'record_id')) {
      throw new ToolArgsError(['研究依据和 S2 依据只选择 objects.references 位置，实际身份由程序绑定。'])
    }
    if (Object.hasOwn(input, 'reference_position')) {
      const selected = select(parseSelection(researchSelection, input).reference_position, 'reference_position')
      if (!researchKinds.includes(selected.kind)) {
        throw new ToolArgsError([`reference_position: 所选 ${selected.kind} 对象不适用于研究依据。`])
      }
      return { kind: selected.kind, ref: selected.id }
    }
    if (input.kind === 's2' || Object.hasOwn(input, 'record_position')) {
      const selected = select(parseSelection(s2Selection, input).record_position, 'record_position')
      const artifact = s2AnswerArtifactSchema.safeParse(selected.kind)
      if (!artifact.success) throw new ToolArgsError([`record_position: 所选 ${selected.kind} 对象不是 S2 记录。`])
      return { kind: 's2', artifact: artifact.data, ...(artifact.data === 'project' ? {} : { record_id: selected.id }) }
    }
    return Object.fromEntries(Object.entries(input).map(([field, child]) => [field, bind(child)]))
  }
  const schema = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(schema)
    if (value === null || typeof value !== 'object') return value
    const node = value as Record<string, unknown>
    const properties = node.properties as Record<string, unknown> | undefined
    if (properties?.ref !== undefined && properties.kind !== undefined) {
      return { ...node, properties: { reference_position: { type: 'integer',
        description: '选择 objects.references 中适用于研究依据的统一位置；来源类别由程序绑定，不填写 kind 或 ref。' } },
      required: ['reference_position'] }
    }
    if (properties?.record_id !== undefined && properties.artifact !== undefined) {
      return { ...node, properties: { kind: properties.kind, record_position: { type: 'integer',
        description: '选择 objects.references 中的 S2 记录位置；程序派生 artifact 和 record_id，项目事实也从该表选择。' } },
      required: ['kind', 'record_position'] }
    }
    return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, schema(child)]))
  }
  return { bind, schema: value => schema(value) as Record<string, unknown> }
}
