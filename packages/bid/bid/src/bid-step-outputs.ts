/** 计划位置在接纳时绑定稳定步骤，执行时只消费已验证回执。 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BidCapabilityStep, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { bidStepOutputSelectionSchema, type BidStepOutputSelection } from './document-contract.ts'

/** 磁盘中保存的前序步骤绑定；后续计划重排不能重新解释旧位置。 */
export const bidStepOutputBindingSchema = z.object({ step_position: z.number().int().nonnegative(), step_id: z.string().min(1) }).strict()
/** 接纳时绑定的真实步骤身份。 */
export type BidStepOutputBinding = z.infer<typeof bidStepOutputBindingSchema>

function selections(step: BidCapabilityStep): Array<{ selection: BidStepOutputSelection; kind: 'figure' | 'document' }> {
  const call = step.call
  if (call.capability !== 'document.patch' && call.capability !== 'document.layout_review') return []
  return [
    ...call.input.document.source === 'step_outputs' ? [{ selection: call.input.document, kind: 'document' as const }] : [],
    ...call.capability !== 'document.patch' ? [] : call.input.operations.flatMap(operation => 'figure' in operation
      && operation.figure.source === 'step_outputs' ? [{ selection: operation.figure, kind: 'figure' as const }] : []),
  ]
}

/**
 * 生成不可变计划版本中的步骤身份；不同修订不会沿用被替换步骤的候选。
 * @param steps 已解析的计划步骤。
 * @param seed Host 的真实授权与计划修订身份。
 * @returns 与步骤一一对应的稳定身份。
 */
export function bidPlanStepIds(steps: readonly BidCapabilityStep[], seed: unknown): string[] {
  return steps.map(({ scope, call }, index) => `step-${createHash('sha256').update(JSON.stringify({ seed, index, scope, call })).digest('hex').slice(0, 32)}`)
}

/**
 * 核对前序关系、输出类型和位置，不触发任何能力执行。
 * @param steps 当前完整计划，包含不可修改的已完成前缀。
 * @param stepIds Host 已生成的完整步骤身份。
 * @returns 每个消费者的稳定来源绑定。
 */
export function bindBidStepOutputs(steps: readonly BidCapabilityStep[], stepIds: readonly string[]): BidStepOutputBinding[][] {
  if (steps.length !== stepIds.length || new Set(stepIds).size !== stepIds.length) throw new Error('BID_STEP_IDENTITY_INVALID')
  return steps.map((step, index) => {
    const sources = new Map<number, string>()
    for (const { selection, kind } of selections(step)) {
      bidStepOutputSelectionSchema.parse(selection)
      const source = steps[selection.step_position]
      if (source === undefined || selection.step_position >= index) throw new Error('BID_STEP_OUTPUT_FORWARD_REFERENCE')
      const expected = source.call.capability === 'flowchart.create' || source.call.capability === 'project_image.create'
        ? 'figure' : source.call.capability === 'document.patch' || source.call.capability === 'document.layout_review' && source.call.input.mode === 'repair'
          ? 'document' : undefined
      if (expected !== kind || selection.output_positions[0] !== 0) throw new Error('BID_STEP_OUTPUT_TYPE_INVALID')
      const stepId = stepIds[selection.step_position]
      if (stepId === undefined) throw new Error('BID_STEP_IDENTITY_INVALID')
      sources.set(selection.step_position, stepId)
    }
    return [...sources].map(([step_position, step_id]) => ({ step_position, step_id }))
  })
}

/**
 * 读取执行器已绑定的真实前序输出，拒绝缺失、越界和类型混用。
 * @param selection 接纳时的输出选择。
 * @param kind 当前能力需要的产物类型。
 * @param context 当前 Work 的实际步骤回执。
 * @returns 匹配类型的不可变资产引用。
 */
export function resolveBidStepOutput<K extends NonNullable<BidCapabilityResult['outputs']>[number]['kind']>(
  selection: BidStepOutputSelection, kind: K, context: BidCapabilityExecutionContext,
): Extract<NonNullable<BidCapabilityResult['outputs']>[number], { kind: K }> {
  const [output] = selection.output_positions
  const result = output === undefined ? undefined : context.stepOutputs?.get(selection.step_position)?.[output]
  if (result === undefined || result.kind !== kind) throw new Error('BID_STEP_OUTPUT_NOT_COMPLETED')
  return result as Extract<NonNullable<BidCapabilityResult['outputs']>[number], { kind: K }>
}
