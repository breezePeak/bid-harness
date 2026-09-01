import type { StageValidationIssue } from './control-plane-contract.ts'
import type { EvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import type { OutlineArtifact, OutlineQualityReport } from './outline-generation-artifacts.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderRequirementsArtifact, TenderScoringArtifact } from './tender-analysis-artifacts.ts'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact = 'outline/outline.json'): void {
  issues.push({ code, message, artifact })
}
function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '') }
function repeatsTitle(value: string, title: string): boolean {
  return normalized(value).replace(/^(?:说明|阐述|介绍|描述|关于|针对|提供)+/u, '') === normalized(title)
}
function validateExact(kind: string, expected: readonly string[], actual: readonly string[], issues: StageValidationIssue[]): void {
  if (new Set(actual).size !== actual.length) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_DUPLICATE`, `Quality review repeats ${kind.toLowerCase()} ids.`, 'outline/quality-report.json')
  for (const id of actual) if (!expected.includes(id)) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_UNKNOWN`, `Quality review references unknown ${kind.toLowerCase()} id.`, 'outline/quality-report.json')
  for (const id of expected) if (!actual.includes(id)) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_MISSING`, `Quality review omits ${kind.toLowerCase()} id.`, 'outline/quality-report.json')
}

/**
 * @param outline Generated Outline.
 * @param report S4 quality report.
 * @param requirements S2 requirements.
 * @param scoring S2 scoring.
 * @param evidence S3 map.
 * @param catalog Stable response points.
 * @param issues Mutable issue sink.
 * @returns Nothing.
 */
export function validateOutlineGenerationQuality(
  outline: OutlineArtifact,
  report: OutlineQualityReport,
  requirements: TenderRequirementsArtifact,
  scoring: TenderScoringArtifact,
  evidence: EvidenceMapArtifact,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): void {
  const frameworkIds = new Set(evidence.framework_mappings.map(mapping => mapping.mapping_id))
  const referenceIds = new Set(evidence.reference_bid_mappings.map(mapping => mapping.mapping_id))
  for (const section of outline.sections.filter(section => section.writable)) {
    if (section.requirement_ids.length > 4) reject(issues, 'OUTLINE_GENERATION_SECTION_REQUIREMENT_LIMIT', 'A generated writable section can cover at most four requirements.')
    if (section.scoring_ids.length > 3) reject(issues, 'OUTLINE_GENERATION_SECTION_SCORING_LIMIT', 'A generated writable section can cover at most three scoring items.')
    if (section.must_answer.some(item => repeatsTitle(item, section.title))) reject(issues, 'OUTLINE_GENERATION_MUST_ANSWER_TITLE_RESTATEMENT', 'Generated must-answer guidance cannot mechanically restate the title.')
    const title = normalized(section.title)
    if (/^(?:技术响应|技术方案|总体方案|综合方案|项目方案|实施方案)$/u.test(title)
      && section.requirement_ids.length + section.scoring_ids.length > 2) reject(issues, 'OUTLINE_GENERATION_SECTION_TOO_COARSE', 'A generic generated section cannot absorb multiple independently traceable technical topics.')
    if (/(?:响应索引|技术响应表|偏离表|合规清单)$/u.test(title)
      && (section.requirement_ids.length > 0 || section.scoring_ids.length > 0)) reject(issues, 'OUTLINE_GENERATION_INDEX_AS_BODY', 'An index, deviation table, or compliance list cannot be the writable body carrying technical coverage.')
    const hasFramework = section.source_mapping_ids.some(id => frameworkIds.has(id))
    const hasReference = section.source_mapping_ids.some(id => referenceIds.has(id))
    if ((section.origin === 'generated' && section.source_mapping_ids.length > 0)
      || (section.origin === 'framework' && (!hasFramework || hasReference))
      || (section.origin === 'reference_bid' && (!hasReference || hasFramework))) reject(issues, 'OUTLINE_GENERATION_ORIGIN_SOURCE_MISMATCH', 'Generated section origin must match its source mappings.')
    if (section.content_mode === null
      || (section.content_mode === 'preserve_and_complete' && !hasFramework)
      || (section.content_mode === 'adapt_and_rewrite' && !hasReference)) reject(issues, 'OUTLINE_GENERATION_CONTENT_MODE_MISMATCH', 'Generated section content mode must match its sources.')
  }
  if (report.issues.length !== 0) reject(issues, 'OUTLINE_GENERATION_QUALITY_ISSUES_UNRESOLVED', 'Quality report issues must be empty.', 'outline/quality-report.json')
  validateExact('REQUIREMENT', requirements.requirements.map(item => item.id), report.checked_requirement_ids, issues)
  validateExact('SCORING', scoring.scoring_items.map(item => item.id), report.checked_scoring_ids, issues)
  validateExact('SECTION', outline.sections.map(item => item.id), report.reviewed_section_ids, issues)
  validateExact('SOURCE_MAPPING', [...frameworkIds, ...referenceIds], report.checked_source_mapping_ids, issues)
  validateExact('SCORING_RESPONSE_POINT', catalog.points.map(point => point.id), report.checked_scoring_response_point_ids, issues)
}
