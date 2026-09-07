/** S3 候选的确定性字段生成，不决定章节归属。 */
import { catalogMatchesScoring, type ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { outlineCandidateSchema, parseOutlineArtifact, type OutlineArtifact } from './outline-generation-artifacts.ts'

/**
 * 仅从正式清单派生响应点快照及评分关联，保留模型选择与其他章节内容。
 * @param value 模型候选；允许省略快照，也接受已有快照。
 * @param catalog 当前只读正式响应点清单。
 * @param scoring 当前评分项。
 * @returns 通过正式 Schema 的幂等规范化目录；未知编号拒绝处理。
 */
export function normalizeOutlineCandidate(
  value: unknown, catalog: ScoringResponsePointCatalog, scoring: TenderScoringArtifact,
): OutlineArtifact {
  if (!catalogMatchesScoring(catalog, scoring)) throw new Error('正式响应点清单与当前评分项不匹配。')
  const candidate = outlineCandidateSchema.parse(value)
  const points = new Map(catalog.points.map(point => [point.id, point]))
  const scoringIds = new Set(scoring.scoring_items.map(item => item.id))
  return parseOutlineArtifact({ ...candidate, sections: candidate.sections.map((section) => {
    for (const id of [...section.scoring_ids, ...(section.scoring_response_points ?? []).map(point => point.scoring_id)]) {
      if (!scoringIds.has(id)) throw new Error('章节 ' + section.id + ' 引用了未知评分编号 ' + id + '。')
    }
    const ids = [...new Set(section.scoring_response_point_ids ?? [])]
    const selected = ids.map((id) => {
      const point = points.get(id)
      if (point === undefined) throw new Error('章节 ' + section.id + ' 引用了未知响应点 ' + id + '。')
      return point
    })
    if (ids.length === 0 && (section.scoring_response_points?.length ?? 0) > 0) throw new Error('章节 ' + section.id + ' 有响应点快照但没有 RP 编号。')
    return { ...section,
      ...(section.scoring_response_point_ids === undefined ? {} : { scoring_response_point_ids: ids }),
      scoring_ids: [...new Set([...section.scoring_ids, ...selected.map(point => point.scoring_id)])],
      scoring_response_points: selected.map(point => ({ scoring_id: point.scoring_id, response_point: point.text })),
    }
  }) })
}
