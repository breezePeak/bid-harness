import type { StageValidationIssue } from './control-plane-contract.ts'
import type { OutlineConfirmationIssueCode } from './outline-confirmation-issues.ts'
import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
import { catalogMatchesScoring, type ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderComplianceArtifact, TenderRequirementsArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'

function reject(issues: StageValidationIssue[], code: OutlineConfirmationIssueCode, message: string): void {
  issues.push({ code, message, artifact: 'outline/outline.json' })
}

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length }
function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '') }

/** @param sections Outline tree nodes. @param issues Mutable issue sink. @returns Nothing. */
export function validateOutlineSharedStructure(sections: readonly OutlineSection[], issues: StageValidationIssue[]): void {
  const byId = new Map<string, OutlineSection>()
  for (const section of sections) {
    if (byId.has(section.id)) reject(issues, 'OUTLINE_SHARED_SECTION_ID_DUPLICATE', 'Section ids must be unique.')
    byId.set(section.id, section)
  }
  const parents = new Set(sections.flatMap(section => section.parent_id === null ? [] : [section.parent_id]))
  const orders = new Set<string>()
  const titles = new Set<string>()
  for (const section of sections) {
    if (section.parent_id === section.id) reject(issues, 'OUTLINE_SHARED_SECTION_SELF_PARENT', 'A section cannot parent itself.')
    const parent = section.parent_id === null ? undefined : byId.get(section.parent_id)
    if (section.parent_id !== null && parent === undefined) reject(issues, 'OUTLINE_SHARED_SECTION_PARENT_UNKNOWN', 'A section parent must exist.')
    if (section.level !== (parent?.level ?? 0) + 1) reject(issues, 'OUTLINE_SHARED_SECTION_LEVEL_INVALID', 'Section level must match its parent.')
    const order = `${section.parent_id ?? '<root>'}\u0000${section.order}`
    if (orders.has(order)) reject(issues, 'OUTLINE_SHARED_SECTION_ORDER_DUPLICATE', 'Sibling orders must be unique.')
    orders.add(order)
    const title = `${section.parent_id ?? '<root>'}\u0000${normalized(section.title)}`
    if (titles.has(title)) reject(issues, 'OUTLINE_SHARED_SECTION_TITLE_DUPLICATE', 'Sibling titles must be unique.')
    titles.add(title)
    if (section.writable && parents.has(section.id)) reject(issues, 'OUTLINE_SHARED_WRITABLE_NOT_LEAF', 'A writable section must be a leaf.')
    if (!section.writable && !parents.has(section.id)) reject(issues, 'OUTLINE_SHARED_CONTAINER_EMPTY', 'A structural section requires children.')
    if (section.writable && section.must_answer.length === 0) reject(issues, 'OUTLINE_SHARED_MUST_ANSWER_MISSING', 'A writable section requires must-answer guidance.')
    if (!section.writable && section.must_answer.length !== 0) reject(issues, 'OUTLINE_SHARED_CONTAINER_MUST_ANSWER_INVALID', 'A structural section cannot have must-answer guidance.')
    for (const values of [section.must_answer.map(normalized), section.requirement_ids, section.scoring_ids,
      section.compliance_ids, section.scoring_response_point_ids ?? []]) {
      if (!unique(values)) reject(issues, 'OUTLINE_SHARED_SECTION_REFERENCE_DUPLICATE', 'Section reference arrays cannot contain duplicates.')
    }
  }
  for (const section of sections) {
    const seen = new Set<string>()
    let current: OutlineSection | undefined = section
    while (current !== undefined && current.parent_id !== null) {
      if (seen.has(current.id)) { reject(issues, 'OUTLINE_SHARED_SECTION_CYCLE', 'Section parents cannot form a cycle.'); break }
      seen.add(current.id)
      current = byId.get(current.parent_id)
    }
  }
}

function validateCompleteIds(
  kind: 'REQUIREMENT' | 'SCORING' | 'COMPLIANCE' | 'RESPONSE_POINT',
  expected: readonly string[],
  actual: readonly string[],
  issues: StageValidationIssue[],
): void {
  const known = new Set(expected)
  for (const id of actual) if (!known.has(id)) reject(issues, `OUTLINE_SHARED_${kind}_UNKNOWN`, `Outline references unknown ${kind.toLowerCase()} id ${JSON.stringify(id)}.`)
  for (const id of expected) if (!actual.includes(id)) reject(issues, `OUTLINE_SHARED_${kind}_MISSING`, `Outline omits ${kind.toLowerCase()} id ${JSON.stringify(id)}.`)
}

/**
 * @param outline Candidate Outline.
 * @param requirements S2 requirements.
 * @param scoring S2 scoring.
 * @param compliance S2 compliance.
 * @param catalog Stable response points.
 * @param issues Mutable issue sink.
 * @returns Nothing.
 */
export function validateOutlineSharedCoverage(
  outline: OutlineArtifact,
  requirements: TenderRequirementsArtifact,
  scoring: TenderScoringArtifact,
  compliance: TenderComplianceArtifact,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): void {
  const sections = outline.sections
  if (!catalogMatchesScoring(catalog, scoring)) reject(issues, 'OUTLINE_SHARED_RESPONSE_POINT_CATALOG_MISMATCH', 'The stable response-point catalog does not match scoring.json.')
  validateCompleteIds('REQUIREMENT', requirements.requirements.map(item => item.id), sections.flatMap(section => section.requirement_ids), issues)
  const writableRequirements = sections.filter(section => section.writable).flatMap(section => section.requirement_ids)
  for (const item of requirements.requirements) if (item.mandatory && !writableRequirements.includes(item.id)) reject(issues, 'OUTLINE_SHARED_REQUIREMENT_WRITABLE_MISSING', `Mandatory requirement ${JSON.stringify(item.id)} needs a writable section.`)
  validateCompleteIds('SCORING', scoring.scoring_items.map(item => item.id), sections.flatMap(section => section.scoring_ids), issues)
  const writableScoring = sections.filter(section => section.writable).flatMap(section => section.scoring_ids)
  for (const item of scoring.scoring_items) if ((item.must_answer || item.score !== null || item.score_range !== null) && !writableScoring.includes(item.id)) reject(issues, 'OUTLINE_SHARED_SCORING_WRITABLE_MISSING', `Priority scoring id ${JSON.stringify(item.id)} needs a writable section.`)
  if (!unique(outline.global_compliance_ids)) reject(issues, 'OUTLINE_SHARED_COMPLIANCE_DUPLICATE', 'Global compliance ids cannot repeat.')
  validateCompleteIds('COMPLIANCE', compliance.compliance_items.map(item => item.id), [...outline.global_compliance_ids, ...sections.flatMap(section => section.compliance_ids)], issues)

  const pointById = new Map(catalog.points.map(point => [point.id, point]))
  const pointIds = sections.filter(section => section.writable).flatMap(section => section.scoring_response_point_ids ?? [])
  validateCompleteIds('RESPONSE_POINT', catalog.points.map(point => point.id), pointIds, issues)
  for (const section of sections) {
    if (!section.writable && ((section.scoring_response_point_ids?.length ?? 0) > 0
      || section.scoring_response_points.length > 0)) reject(issues, 'OUTLINE_SHARED_CONTAINER_RESPONSE_POINT_INVALID', 'Only writable sections can own scoring response points.')
    const responsePointIds = section.scoring_response_point_ids ?? []
    if (responsePointIds.length !== section.scoring_response_points.length) reject(issues, 'OUTLINE_SHARED_RESPONSE_POINT_TEXT_MISMATCH', 'Response-point ids and text snapshots must have equal length.')
    responsePointIds.forEach((id, index) => {
      const point = pointById.get(id)
      const snapshot = section.scoring_response_points[index]
      if (point === undefined || snapshot === undefined || point.scoring_id !== snapshot.scoring_id || point.text !== snapshot.response_point) reject(issues, 'OUTLINE_SHARED_RESPONSE_POINT_TEXT_MISMATCH', `Response-point snapshot does not match ${JSON.stringify(id)}.`)
      else if (!section.scoring_ids.includes(point.scoring_id)) reject(issues, 'OUTLINE_SHARED_RESPONSE_POINT_SCORING_MISSING', `Section carrying ${JSON.stringify(id)} must include its scoring id.`)
    })
  }
}
