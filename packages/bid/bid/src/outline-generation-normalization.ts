/** S3 候选的确定性字段生成，不决定章节归属。 */
import { z } from 'zod'
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
  const issues: z.core.$ZodIssue[] = []
  const sections = candidate.sections.map((section, sectionIndex) => {
    const reject = (field: string, message: string): void => {
      issues.push({ code: 'custom', path: ['sections', sectionIndex, field], message: '章节 ' + section.id + '：' + message })
    }
    for (const id of section.scoring_ids) if (!scoringIds.has(id)) reject('scoring_ids', '引用了未知评分编号 ' + id + '。')
    for (const point of section.scoring_response_points ?? []) {
      if (!scoringIds.has(point.scoring_id)) reject('scoring_response_point_ids', '快照引用了未知评分编号 ' + point.scoring_id + '，请明确重新选择合法 RP；快照由 Host 重建。')
    }
    const ids = [...new Set(section.scoring_response_point_ids ?? [])]
    const selected = ids.flatMap((id) => {
      const point = points.get(id)
      if (point === undefined) { reject('scoring_response_point_ids', '引用了未知响应点 ' + id + '。'); return [] }
      return [point]
    })
    if (ids.length === 0 && (section.scoring_response_points?.length ?? 0) > 0) reject('scoring_response_point_ids', '有响应点快照但没有 RP 编号。')
    if (section.writable && section.must_answer.length === 0) reject('must_answer', '可写章节必须包含具体 must_answer。')
    if (!section.writable && section.must_answer.length !== 0) reject('must_answer', '结构章节的 must_answer 必须为空。')
    return { ...section,
      ...(section.scoring_response_point_ids === undefined ? {} : { scoring_response_point_ids: ids }),
      scoring_ids: [...new Set([...section.scoring_ids, ...selected.map(point => point.scoring_id)])],
      scoring_response_points: selected.map(point => ({ scoring_id: point.scoring_id, response_point: point.text })),
    }
  })
  if (issues.length > 0) throw new z.ZodError(issues)
  return parseOutlineArtifact({ ...candidate, sections })
}
