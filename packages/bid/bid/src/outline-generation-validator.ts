import { lstat, readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import { within } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseOutlineArtifact, parseOutlineQualityReport, type OutlineArtifact, type OutlineQualityReport, type OutlineSection } from './outline-generation-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT = 'outline/quality-report.json'
const MAX_WRITABLE_REQUIREMENTS = 4
const MAX_WRITABLE_SCORING_ITEMS = 3

function reject(issues: StageValidationIssue[], code: string, message: string, artifact = ARTIFACT): void {
  issues.push({ code, message, artifact })
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown | undefined> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch { reject(issues, 'OUTLINE_GENERATION_INPUT_INVALID', 'A required outline Artifact is missing or invalid.', path) }
}

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length }

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function repeatsTitleMechanically(mustAnswer: string, title: string): boolean {
  const normalizedTitle = normalizedText(title)
  const normalizedAnswer = normalizedText(mustAnswer)
    .replace(/^(?:说明|阐述|介绍|描述|有关|关于|针对|对|提供|编写|落实|响应)+/u, '')
    .replace(/(?:说明|阐述|介绍|描述)$/u, '')
  return normalizedTitle.length > 0 && normalizedAnswer === normalizedTitle
}

/** Validate the shared flat outline-tree invariants for generated and confirmed outlines. */
export function validateOutlineTree(sections: readonly OutlineSection[], issues: StageValidationIssue[]): void {
  const byId = new Map<string, OutlineSection>()
  const parentsWithChildren = new Set(sections.flatMap(section => section.parent_id === null ? [] : [section.parent_id]))
  for (const section of sections) {
    if (byId.has(section.id)) reject(issues, 'OUTLINE_GENERATION_SECTION_ID_DUPLICATE', 'Section ids must be unique.')
    byId.set(section.id, section)
  }
  const orders = new Set<string>()
  const titles = new Set<string>()
  for (const section of sections) {
    if (section.parent_id === section.id) reject(issues, 'OUTLINE_GENERATION_SECTION_SELF_PARENT', 'A section cannot parent itself.')
    const parent = section.parent_id === null ? undefined : byId.get(section.parent_id)
    if (section.parent_id !== null && parent === undefined) reject(issues, 'OUTLINE_GENERATION_SECTION_PARENT_UNKNOWN', 'A section parent must exist.')
    if (parent !== undefined && section.level !== parent.level + 1) reject(issues, 'OUTLINE_GENERATION_SECTION_LEVEL_INVALID', 'A child level must be one deeper than its parent.')
    if (section.parent_id === null && section.level !== 1) reject(issues, 'OUTLINE_GENERATION_SECTION_LEVEL_INVALID', 'A root section must have level one.')
    const orderKey = `${section.parent_id ?? '<root>'}\u0000${section.order}`
    if (orders.has(orderKey)) reject(issues, 'OUTLINE_GENERATION_SECTION_ORDER_DUPLICATE', 'Sibling orders must be unique.')
    orders.add(orderKey)
    const titleKey = `${section.parent_id ?? '<root>'}\u0000${normalizedText(section.title)}`
    if (titles.has(titleKey)) reject(issues, 'OUTLINE_GENERATION_SECTION_TITLE_DUPLICATE', 'Sibling titles must be unique.')
    titles.add(titleKey)
    if (!unique(section.must_answer.map(normalizedText))) {
      reject(issues, 'OUTLINE_GENERATION_MUST_ANSWER_DUPLICATE', 'A section cannot repeat a must-answer item.')
    }
    if (section.writable && section.must_answer.some(item => repeatsTitleMechanically(item, section.title))) {
      reject(issues, 'OUTLINE_GENERATION_MUST_ANSWER_TITLE_RESTATEMENT', 'A writable section needs must-answer guidance beyond a mechanical title restatement.')
    }
    if (section.writable && section.requirement_ids.length > MAX_WRITABLE_REQUIREMENTS) {
      reject(issues, 'OUTLINE_GENERATION_WRITABLE_REQUIREMENTS_TOO_BROAD', `A writable section can reference at most ${String(MAX_WRITABLE_REQUIREMENTS)} requirements; split independent workflows or control points into separate leaves.`)
    }
    if (section.writable && section.scoring_ids.length > MAX_WRITABLE_SCORING_ITEMS) {
      reject(issues, 'OUTLINE_GENERATION_WRITABLE_SCORING_TOO_BROAD', `A writable section can reference at most ${String(MAX_WRITABLE_SCORING_ITEMS)} scoring items; split independent scoring responses into separate leaves.`)
    }
    for (const ids of [section.requirement_ids, section.scoring_ids, section.compliance_ids]) if (!unique(ids)) {
      reject(issues, 'OUTLINE_GENERATION_SECTION_REFERENCE_DUPLICATE', 'A section cannot repeat a referenced id.')
    }
  }
  for (const section of sections) {
    const seen = new Set<string>()
    let current: OutlineSection | undefined = section
    while (current?.parent_id !== null && current !== undefined) {
      if (seen.has(current.id)) { reject(issues, 'OUTLINE_GENERATION_SECTION_CYCLE', 'Section parents cannot form a cycle.'); break }
      seen.add(current.id)
      current = byId.get(current.parent_id)
    }
    const hasChildren = parentsWithChildren.has(section.id)
    if (section.writable && hasChildren) {
      reject(issues, 'OUTLINE_GENERATION_WRITABLE_NOT_LEAF', 'A writable section cannot have child sections.')
    }
    if (!section.writable && !hasChildren) {
      reject(issues, 'OUTLINE_GENERATION_CONTAINER_EMPTY', 'A structural section requires a child section.')
    }
  }
}

function validateQualityReviewIds(
  kind: 'REQUIREMENT' | 'SCORING' | 'SECTION',
  expected: readonly string[],
  actual: readonly string[],
  issues: StageValidationIssue[],
): void {
  if (!unique(actual)) reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_DUPLICATE`, `Quality review cannot repeat ${kind.toLowerCase()} ids.`, QUALITY_REPORT)
  const known = new Set(expected)
  for (const id of actual) if (!known.has(id)) {
    reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_UNKNOWN`, `Quality review references unknown ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, QUALITY_REPORT)
  }
  for (const id of expected) if (!actual.includes(id)) {
    reject(issues, `OUTLINE_GENERATION_QUALITY_${kind}_MISSING`, `Quality review omits ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, QUALITY_REPORT)
  }
}

function validateQualityReview(
  report: OutlineQualityReport,
  outline: OutlineArtifact,
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>,
  scoring: ReturnType<typeof parseTenderScoringArtifact>,
  issues: StageValidationIssue[],
): void {
  if (report.issues.length !== 0) {
    reject(issues, 'OUTLINE_GENERATION_QUALITY_ISSUES_UNRESOLVED', 'Quality review must resolve every reported issue before S4 completes.', QUALITY_REPORT)
  }
  validateQualityReviewIds('REQUIREMENT', requirements.requirements.map(item => item.id), report.checked_requirement_ids, issues)
  validateQualityReviewIds('SCORING', scoring.scoring_items.map(item => item.id), report.checked_scoring_ids, issues)
  validateQualityReviewIds('SECTION', outline.sections.map(item => item.id), report.reviewed_section_ids, issues)
}

/** Validate S2 identifier coverage for generated and confirmed outlines. */
export function validateOutlineReferences(
  sections: readonly OutlineSection[],
  globalCompliance: readonly string[],
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>,
  scoring: ReturnType<typeof parseTenderScoringArtifact>,
  compliance: ReturnType<typeof parseTenderComplianceArtifact>,
  issues: StageValidationIssue[],
): void {
  const check = (kind: string, expected: readonly { id: string }[], actual: readonly string[]) => {
    const known = new Set(expected.map(value => value.id))
    for (const id of actual) if (!known.has(id)) reject(issues, `OUTLINE_GENERATION_${kind}_UNKNOWN`, `Outline references unknown ${kind.toLowerCase()} id ${JSON.stringify(id)}.`)
    for (const item of expected) if (!actual.includes(item.id)) reject(issues, `OUTLINE_GENERATION_${kind}_MISSING`, `Outline omits ${kind.toLowerCase()} id ${JSON.stringify(item.id)}.`)
  }
  const requirementIds = sections.flatMap(section => section.requirement_ids)
  const writableRequirements = sections.filter(section => section.writable).flatMap(section => section.requirement_ids)
  check('REQUIREMENT', requirements.requirements, requirementIds)
  for (const item of requirements.requirements) if (item.mandatory && !writableRequirements.includes(item.id)) {
    reject(issues, 'OUTLINE_GENERATION_REQUIREMENT_WRITABLE_MISSING', `Mandatory requirement ${JSON.stringify(item.id)} needs a writable section.`)
  }
  const scoringIds = sections.flatMap(section => section.scoring_ids)
  const writableScoring = sections.filter(section => section.writable).flatMap(section => section.scoring_ids)
  const priorityScoring = scoring.scoring_items
    .filter(item => item.must_answer || item.score !== null || item.score_range !== null)
    .map(item => item.id)
    .filter(id => !writableScoring.includes(id))
  check('SCORING', scoring.scoring_items, scoringIds)
  for (const id of priorityScoring) reject(issues, 'OUTLINE_GENERATION_SCORING_WRITABLE_MISSING', `Priority scoring id ${JSON.stringify(id)} needs a writable section.`)
  if (!unique(globalCompliance)) reject(issues, 'OUTLINE_GENERATION_COMPLIANCE_DUPLICATE', 'Global compliance ids cannot repeat.')
  check('COMPLIANCE', compliance.compliance_items, [...globalCompliance, ...sections.flatMap(section => section.compliance_ids)])
}

/** Validate S4 Blueprint structure and its complete S2 identifier coverage. */
export async function validateOutlineGeneration(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'outline_generation') reject(issues, 'OUTLINE_GENERATION_STAGE_INVALID', 'The outline validator only accepts outline_generation.')
  if (
    artifacts.length !== 1
    || artifacts[0]?.stage !== 'outline_generation'
    || artifacts[0]?.path !== ARTIFACT
  ) {
    reject(
      issues,
      'OUTLINE_GENERATION_ARTIFACT_SET_INVALID',
      'The executor must return outline/outline.json exactly once.',
    )
  }
  const [outlineRaw, qualityReportRaw, requirementsRaw, scoringRaw, complianceRaw] = await Promise.all([
    parseJson(workspace, ARTIFACT, issues),
    parseJson(workspace, QUALITY_REPORT, issues),
    parseJson(workspace, 'analysis/requirements.json', issues),
    parseJson(workspace, 'analysis/scoring.json', issues),
    parseJson(workspace, 'analysis/compliance.json', issues),
  ])
  if (
    [outlineRaw, qualityReportRaw, requirementsRaw, scoringRaw, complianceRaw]
      .some(value => value === undefined)
  ) return { ok: false, issues }
  try {
    const outline = parseOutlineArtifact(outlineRaw)
    const qualityReport = parseOutlineQualityReport(qualityReportRaw)
    const requirements = parseTenderRequirementsArtifact(requirementsRaw)
    const scoring = parseTenderScoringArtifact(scoringRaw)
    const compliance = parseTenderComplianceArtifact(complianceRaw)
    validateOutlineTree(outline.sections, issues)
    validateOutlineReferences(outline.sections, outline.global_compliance_ids, requirements, scoring, compliance, issues)
    validateQualityReview(qualityReport, outline, requirements, scoring, issues)
  } catch { reject(issues, 'OUTLINE_GENERATION_ARTIFACT_INVALID', 'The outline Artifact has invalid fields.') }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
