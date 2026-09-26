/** S3 候选的确定性字段生成，不决定章节归属。 */
import { z } from 'zod'
import { catalogMatchesScoring, type ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { outlineCandidateSchema, parseOutlineArtifact, TECHNICAL_DEVIATION_SECTION_ID, type OutlineArtifact, type OutlineSection } from './outline-generation-artifacts.ts'

const deviationTitle = (value: string): boolean => value.normalize('NFKC').replace(/\s+/gu, '') === '技术偏离表'

/**
 * 保留现有章节身份，并确保技术偏离表使用固定位置。
 * @returns 保留原章节身份并把技术偏离表规范为固定第一章的目录。
 * @param sections 当前目录章节。
 */
export function ensureTechnicalDeviationSection(sections: OutlineSection[]): OutlineSection[] {
  if (sections.some(section => section.title.normalize('NFKC').replace(/\s+/gu, '') === '目录')) {
    throw new Error('S3 不得创建目录章节；目录由 Word 导出程序生成。')
  }
  const matches = sections.filter(section => section.id === TECHNICAL_DEVIATION_SECTION_ID || deviationTitle(section.title))
  if (matches.length > 1) throw new Error('目录只能包含一个技术偏离表章节。')
  const existing = matches[0]
  const fixed: OutlineSection = existing === undefined ? {
    id: TECHNICAL_DEVIATION_SECTION_ID,
    parent_id: null,
    order: 1,
    level: 1,
    title: '技术偏离表',
    purpose: '逐项汇总招标技术要求、投标响应内容及偏离情况。',
    writable: true,
    must_answer: ['逐项填写招标技术要求、投标响应内容、偏离程度和备注。'],
    requirement_ids: [],
    scoring_ids: [],
    compliance_ids: [],
    origin: 'generated',
    framework_refs: [],
    scoring_response_point_ids: [],
    scoring_response_points: [],
    suggested_tables: ['技术偏离表'],
    suggested_figures: [],
    writing_notes: ['只生成用于填充默认模板技术偏离表的数据，不编写封面或目录。'],
  } : {
    ...existing,
    id: TECHNICAL_DEVIATION_SECTION_ID,
    parent_id: null,
    order: 1,
    level: 1,
    title: '技术偏离表',
    writable: true,
    must_answer: existing.must_answer.length > 0 ? existing.must_answer : ['逐项填写招标技术要求、投标响应内容、偏离程度和备注。'],
  }
  const previousId = existing?.id
  const remaining = sections
    .filter(section => section !== existing)
    .map(section => previousId === undefined || section.parent_id !== previousId
      ? section
      : { ...section, parent_id: TECHNICAL_DEVIATION_SECTION_ID })
  const roots = remaining.filter(section => section.parent_id === null)
    .sort((left, right) => left.order - right.order)
  const rootOrder = new Map(roots.map((section, index) => [section.id, index + 2]))
  return [fixed, ...remaining.map(section => section.parent_id === null
    ? { ...section, order: rootOrder.get(section.id) ?? section.order }
    : section)]
}

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
  const byId = new Map(sections.map(section => [section.id, section]))
  const level = (id: string, visited: Set<string>): number | undefined => {
    if (visited.has(id)) return undefined
    const section = byId.get(id)
    if (section === undefined) return undefined
    if (section.parent_id === null) return 1
    visited.add(id)
    const parentLevel = level(section.parent_id, visited)
    return parentLevel === undefined ? undefined : parentLevel + 1
  }
  return parseOutlineArtifact({ ...candidate, sections: byId.size !== sections.length ? sections : sections.map(section => ({
    ...section, level: level(section.id, new Set()) ?? section.level,
  })) })
}
