/** 首次整本生成的阶段顺序与原生确认点。 */
import type { BidStage, BidStagePolicy } from './control-plane-contract.ts'

/** 文件接入之后的默认业务路线；局部能力任务可选用其中任意片段。 */
export const DEFAULT_BID_ROUTE: readonly BidStage[] = [
  'file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing',
]

/**
 * 默认路线下一阶段；能力任务不自动推进该路线。
 * @param stage 当前阶段。
 * @returns 下一阶段或结束。
 */
export function defaultBidNextStage(stage: BidStage): BidStage | null {
  const index = DEFAULT_BID_ROUTE.indexOf(stage)
  return index < 0 ? null : DEFAULT_BID_ROUTE[index + 1] ?? null
}

/**
 * 首次默认生成使用的用户确认点。
 * @param stage 当前阶段。
 * @returns 阶段确认位置。
 */
export function defaultBidUserGate(stage: BidStage): BidStagePolicy['userGate'] {
  if (stage === 'tender_analysis' || stage === 'outline_generation' || stage === 'evidence_mapping') {
    return 'after_validation'
  }
  return 'none'
}
