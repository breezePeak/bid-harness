import { lstat, readFile } from 'node:fs/promises'
import type { BidManifest, BidWorkspace } from './index.ts'
import { resolveEvidenceChunk } from './evidence-chunk.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { chapterCandidateSha256, parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { parseChapterExecutionLog, parseChapterExecutionPlan, validateChapterExecutionPlan } from './chapter-writing-plan-artifacts.ts'
import { buildChapterWorklist } from './chapter-writing-executor.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import type { LocalEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseConfirmedOutlineArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { catalogMatchesScoring, parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import {
  parseWebEvidenceSourcesArtifact,
  webEvidenceContentSha256,
  type WebEvidenceSource,
} from './web-evidence-source-artifacts.ts'

const MANIFEST = 'chapters/manifest.json'
const PLAN = 'chapters/execution-plan.json'
const LOG = 'chapters/execution-log.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function readJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const target = within(workspace.projectRoot, path)
    await assertNoLinkedPath(workspace.root, target)
    if (!(await lstat(target)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(target, 'utf8'))
  } catch {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_INVALID', 'A required chapter-writing Artifact is missing or invalid.', path)
    return undefined
  }
}

async function validateMaterial(
  workspace: BidWorkspace, manifest: BidManifest, material: LocalEvidenceMaterial, issues: StageValidationIssue[],
): Promise<void> {
  try {
    const resolved = await resolveEvidenceChunk(workspace, manifest, material)
    if (!(await lstat(resolved.path)).isFile()) throw new Error('not-file')
  } catch {
    reject(issues, 'CHAPTER_WRITING_LOCAL_MATERIAL_INVALID', 'A chapter local material must name an indexed reference/reference_bid chunk.', material.chunk)
  }
}

async function webSourceSnapshotValid(workspace: BidWorkspace, source: WebEvidenceSource): Promise<boolean> {
  try {
    const path = within(workspace.projectRoot, source.snapshot_path)
    await assertNoLinkedPath(workspace.root, path)
    if (!(await lstat(path)).isFile()) return false
    return webEvidenceContentSha256(await readFile(path, 'utf8')) === source.content_sha256
  } catch {
    return false
  }
}

async function validateWebMaterials(
  workspace: BidWorkspace,
  chapters: ReturnType<typeof parseChapterWritingManifest>,
  issues: StageValidationIssue[],
): Promise<void> {
  if (chapters.chapters.every(chapter => chapter.web_materials_used.length === 0)) return
  const raw = await readJson(workspace, 'analysis/web-evidence-sources.json', issues)
  if (raw === undefined) return
  let sources: ReturnType<typeof parseWebEvidenceSourcesArtifact>['sources']
  try {
    sources = parseWebEvidenceSourcesArtifact(raw).sources
  } catch {
    reject(issues, 'CHAPTER_WRITING_WEB_SOURCE_LEDGER_INVALID', 'The Host Web source ledger has invalid fields.', 'analysis/web-evidence-sources.json')
    return
  }
  for (const chapter of chapters.chapters) {
    for (const material of chapter.web_materials_used) {
      const source = sources.find(candidate => candidate.source_id === material.source_id)
      if (source === undefined || source.snapshot_path !== material.snapshot_path
        || !(await webSourceSnapshotValid(workspace, source))) {
        reject(issues, 'CHAPTER_WRITING_WEB_SOURCE_UNVERIFIED', 'A chapter Web material must match a durable ledger Snapshot and its content hash.', 'analysis/web-evidence-sources.json')
      }
    }
  }
}

/**
 * Validate complete S6 output against the confirmed outline and durable material sources.
 * @param workspace - Workspace 级 Bid 项目.
 * @param stage - stage that produced the declared Artifact.
 * @param artifacts - Executor-declared Artifact set.
 * @returns validation success or all deterministic S6 issues.
 */
export async function validateChapterWriting(
  workspace: BidWorkspace, stage: BidStage, artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'chapter_writing') reject(issues, 'CHAPTER_WRITING_STAGE_INVALID', 'The chapter-writing validator only accepts chapter_writing.')
  const expectedArtifacts = new Map([
    [PLAN, 'chapter_execution_plan'],
    [LOG, 'chapter_execution_log'],
    [MANIFEST, 'chapter_manifest'],
  ])
  if (artifacts.length !== expectedArtifacts.size || artifacts.some(artifact =>
    artifact.stage !== 'chapter_writing' || expectedArtifacts.get(artifact.path) !== artifact.type)
    || new Set(artifacts.map(artifact => artifact.path)).size !== expectedArtifacts.size) {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_SET_INVALID', 'The executor must return the execution plan, execution log, and chapter manifest exactly once.', MANIFEST)
  }
  const [manifestRaw, planRaw, logRaw, outlineRaw, scoringRaw, catalogRaw] = await Promise.all([
    readJson(workspace, MANIFEST, issues), readJson(workspace, PLAN, issues),
    readJson(workspace, LOG, issues), readJson(workspace, 'outline/confirmed-outline.json', issues),
    readJson(workspace, 'analysis/scoring.json', issues),
    readJson(workspace, 'analysis/scoring-response-points.json', issues),
  ])
  if (
    manifestRaw === undefined || planRaw === undefined || logRaw === undefined
    || outlineRaw === undefined || scoringRaw === undefined || catalogRaw === undefined
  ) return { ok: false, issues }
  let chapters
  let plan
  let executionLog
  let outline
  let scoring
  let catalog
  try {
    chapters = parseChapterWritingManifest(manifestRaw)
    plan = parseChapterExecutionPlan(planRaw)
    executionLog = parseChapterExecutionLog(logRaw)
    outline = parseConfirmedOutlineArtifact(outlineRaw)
    scoring = parseTenderScoringArtifact(scoringRaw)
    catalog = parseScoringResponsePointCatalog(catalogRaw)
  } catch {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_INVALID', 'The chapter manifest, confirmed outline, or scoring inputs have invalid fields.', MANIFEST)
    return { ok: false, issues }
  }
  const outlineHash = outlineArtifactSha256(outline)
  if (!catalogMatchesScoring(catalog, scoring)) reject(issues, 'CHAPTER_WRITING_RESPONSE_POINT_CATALOG_MISMATCH', 'The scoring response-point catalog does not match scoring.json.', 'analysis/scoring-response-points.json')
  if (chapters.confirmed_outline_sha256 !== outlineHash) reject(issues, 'CHAPTER_WRITING_OUTLINE_HASH_INVALID', 'The chapter manifest does not match the confirmed outline.', MANIFEST)
  issues.push(...validateChapterExecutionPlan(plan, outline, outlineHash))
  if (executionLog.confirmed_outline_sha256 !== outlineHash) reject(issues, 'CHAPTER_WRITING_LOG_OUTLINE_HASH_INVALID', 'The execution log does not match the confirmed outline.', LOG)
  const plannedDependencies = new Map(plan.sections.map(section => [section.section_id, section.depends_on.map(item => item.section_id)]))
  const loggedSections = new Set<string>()
  for (const section of executionLog.sections) {
    if (loggedSections.has(section.section_id)) reject(issues, 'CHAPTER_WRITING_LOG_SECTION_DUPLICATE', 'The execution log contains a duplicate section.', LOG)
    loggedSections.add(section.section_id)
    if (section.status !== 'completed' || section.attempts.length === 0 || section.final_writer_child_session_id === null || section.final_reviewer_child_session_id === null) {
      reject(issues, 'CHAPTER_WRITING_LOG_SECTION_INCOMPLETE', 'Every chapter must have accepted Writer and Reviewer Child attempts.', LOG)
    }
    if (JSON.stringify(section.depends_on) !== JSON.stringify(plannedDependencies.get(section.section_id))) {
      reject(issues, 'CHAPTER_WRITING_LOG_DEPENDENCY_INVALID', 'The execution log dependencies must match the validated plan.', LOG)
    }
    const acceptedWriters = section.attempts.filter(attempt => attempt.role === 'writer' && attempt.accepted)
    const acceptedReviewers = section.attempts.filter(attempt => attempt.role === 'reviewer' && attempt.accepted)
    if (acceptedWriters.at(-1)?.child_session_id !== section.final_writer_child_session_id
      || acceptedReviewers.at(-1)?.child_session_id !== section.final_reviewer_child_session_id) {
      reject(issues, 'CHAPTER_WRITING_LOG_FINAL_CHILD_INVALID', 'Each chapter must identify its final Writer and Reviewer Child Session.', LOG)
    }
  }
  const writable = new Map(outline.sections.filter(section => section.writable).map(section => [section.id, section]))
  const expectedPaths = new Map(buildChapterWorklist(outline).map((section, index) => {
    const serial = String(index + 1).padStart(4, '0')
    return [section.id, { content: `chapters/sections/${serial}.md`, metadata: `chapters/meta/${serial}.json` }] as const
  }))
  const actual = new Set<string>()
  for (const chapter of chapters.chapters) {
    if (actual.has(chapter.section_id)) reject(issues, 'CHAPTER_WRITING_SECTION_DUPLICATE', 'Each writable section may have one chapter only.', MANIFEST)
    actual.add(chapter.section_id)
    const section = writable.get(chapter.section_id)
    if (section === undefined) { reject(issues, 'CHAPTER_WRITING_SECTION_UNKNOWN', 'A chapter references an unknown or structural section.', MANIFEST); continue }
    const expectedPath = expectedPaths.get(chapter.section_id)
    if (expectedPath === undefined || chapter.content_path !== expectedPath.content) {
      reject(issues, 'CHAPTER_WRITING_CONTENT_PATH_INVALID', 'A chapter body path must match its confirmed traversal position.', chapter.content_path)
    }
    if (JSON.stringify(chapter.requirement_ids) !== JSON.stringify(section.requirement_ids)
      || JSON.stringify(chapter.scoring_ids) !== JSON.stringify(section.scoring_ids)
      || JSON.stringify(chapter.compliance_ids) !== JSON.stringify([...section.compliance_ids, ...outline.global_compliance_ids])) {
      reject(issues, 'CHAPTER_WRITING_SECTION_MAPPING_INVALID', 'A chapter mapping must match its confirmed section.', MANIFEST)
    }
    if (JSON.stringify(chapter.covered_scoring_response_points) !== JSON.stringify(section.scoring_response_points)
      || JSON.stringify(chapter.covered_scoring_response_point_ids) !== JSON.stringify(section.scoring_response_point_ids ?? [])) {
      reject(issues, 'CHAPTER_WRITING_INHERITED_RESPONSE_POINT_INVALID', 'A chapter must retain confirmed response-point identities.', MANIFEST)
    }
    for (const answer of chapter.covered_must_answer) if (!section.must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_UNKNOWN', 'A chapter records a must-answer outside its confirmed section.', MANIFEST)
    for (const answer of section.must_answer) if (!chapter.covered_must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_MISSING', 'A chapter omits a required must-answer from its metadata.', MANIFEST)
    if (expectedPath !== undefined) {
      const metadataRaw = await readJson(workspace, expectedPath.metadata, issues)
      if (metadataRaw !== undefined) {
        try {
          const metadata = parseChapterMetadata(metadataRaw)
          const fromManifest = {
            section_id: chapter.section_id,
            covered_must_answer: chapter.covered_must_answer,
            covered_scoring_response_point_ids: chapter.covered_scoring_response_point_ids,
            covered_scoring_response_points: chapter.covered_scoring_response_points,
            local_materials_used: chapter.local_materials_used,
            web_materials_used: chapter.web_materials_used,
            unresolved_topics: chapter.unresolved_topics,
            handoff: chapter.handoff,
          }
          if (JSON.stringify(metadata) !== JSON.stringify(fromManifest)) throw new Error('metadata-mismatch')
        } catch {
          reject(issues, 'CHAPTER_WRITING_METADATA_INVALID', 'Chapter metadata must match its manifest entry.', expectedPath.metadata)
        }
      }
    }
    try {
      const body = within(workspace.projectRoot, chapter.content_path)
      await assertNoLinkedPath(workspace.root, body)
      const markdown = await readFile(body, 'utf8')
      if (!(await lstat(body)).isFile() || markdown.trim().length < 20 || /(?:待补充|TODO|正文)$/mu.test(markdown.trim())) throw new Error('empty')
      const reviewRaw = await readJson(workspace, chapter.review_path, issues)
      if (reviewRaw === undefined) throw new Error('review-missing')
      const review = parseChapterReviewArtifact(reviewRaw)
      if (review.section_id !== chapter.section_id || review.candidate_sha256 !== chapter.review_sha256
        || review.candidate_sha256 !== chapterCandidateSha256(markdown)) throw new Error('review-invalid')
      const coverage = [
        ...review.must_answer_coverage,
        ...review.requirement_coverage,
        ...review.response_point_coverage,
        ...review.compliance_coverage,
      ]
      for (const item of coverage) {
        if (item.evidence_quotes.some(quote => !markdown.includes(quote))) throw new Error('review-quote-invalid')
      }
    } catch { reject(issues, 'CHAPTER_WRITING_CONTENT_INVALID', 'A chapter body is missing, linked, outside the project, or empty.', chapter.content_path) }
  }
  for (const id of writable.keys()) if (!actual.has(id)) reject(issues, 'CHAPTER_WRITING_SECTION_MISSING', 'The manifest omits a writable confirmed section.', MANIFEST)
  for (const id of writable.keys()) if (!loggedSections.has(id)) reject(issues, 'CHAPTER_WRITING_LOG_SECTION_MISSING', 'The execution log omits a writable confirmed section.', LOG)
  let bidManifest: BidManifest
  try { bidManifest = await workspace.readManifest() } catch { reject(issues, 'CHAPTER_WRITING_INPUT_INVALID', 'The Bid manifest cannot be read.', 'manifest.json'); return { ok: false, issues } }
  await Promise.all(chapters.chapters.flatMap(chapter => chapter.local_materials_used
    .map(material => validateMaterial(workspace, bidManifest, material, issues))))
  await validateWebMaterials(workspace, chapters, issues)
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
