/** 从正式响应点清单派生章节所属评分项和文字快照；不改变业务选择。 */
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ScoringResponsePoint } from './scoring-response-point-artifacts.ts'

/** 章节所选响应点对应的确定性评分关联与快照。 */
interface SectionResponsePointBindings {
  readonly scoring_ids: string[]
  readonly scoring_response_points: Array<{ scoring_id: string; response_point: string }>
}

/**
 * 保留显式评分关联，并补齐所选响应点唯一确定的所属评分项。
 * @param scoringIds 章节显式选择的评分项。
 * @param responsePointIds 章节选择的正式响应点。
 * @param catalog 当前正式响应点清单。
 * @returns 去重评分关联及按响应点顺序生成的快照；未知响应点拒绝处理。
 */
export function bindSectionResponsePoints(
  scoringIds: readonly string[], responsePointIds: readonly string[],
  catalog: { readonly points: readonly Pick<ScoringResponsePoint, 'id' | 'scoring_id' | 'text'>[] },
): SectionResponsePointBindings {
  const byId = new Map(catalog.points.map(point => [point.id, point]))
  const points = responsePointIds.map((id) => {
    const point = byId.get(id)
    if (point === undefined) throw new ToolArgsError([`scoring_response_point_ids: 未知评分响应点 ${id}，请选择当前正式清单中的响应点。`])
    return point
  })
  return {
    scoring_ids: [...new Set([...scoringIds, ...points.map(point => point.scoring_id)])],
    scoring_response_points: points.map(point => ({ scoring_id: point.scoring_id, response_point: point.text })),
  }
}
