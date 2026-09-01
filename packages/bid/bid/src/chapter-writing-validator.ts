import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { BidManifest, BidWorkspace } from './index.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseChapterExecutionLog, parseChapterExecutionPlan, validateChapterExecutionPlan } from './chapter-writing-plan-artifacts.ts'
import { buildChapterWorklist } from './chapter-writing-executor.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type EvidenceMaterial, type ExternalEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseConfirmedOutlineArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { normalizeWebEvidenceUrl } from './web-evidence-source-artifacts.ts'

const MANIFEST = 'chapters/manifest.json'
const PLAN = 'chapters/execution-plan.json'
const LOG = 'chapters/execution-log.json'

function reject(issues: StageValidationIssue[], code: string, message: string, artifact?: string): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }) })
}

async function readJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[]): Promise<unknown> {
  try {
    const target = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, target)
    if (!(await lstat(target)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(target, 'utf8'))
  } catch {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_INVALID', 'A required chapter-writing Artifact is missing or invalid.', path)
    return undefined
  }
}

async function validateMaterial(
  workspace: BidWorkspace, manifest: BidManifest, material: EvidenceMaterial, issues: StageValidationIssue[],
): Promise<void> {
  const file = manifest.files.find(item => item.id === material.file_id && item.role !== 'tender')
  if (file === undefined || file.parseStatus !== 'success' || file.chunksPath === null || file.chunkIndexPath === null) {
    reject(issues, 'CHAPTER_WRITING_EVIDENCE_FILE_INVALID', 'A chapter Evidence reference must name a parsed reference file.', material.chunk)
    return
  }
  try {
    const chunksPath = file.chunksPath
    const indexPath = within(workspace.sessionRoot, file.chunkIndexPath)
    await assertNoLinkedPath(workspace.root, indexPath)
    const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    if (!index.chunks.some(chunk => posix.join(chunksPath, chunk.path) === material.chunk)) throw new Error('unknown-chunk')
    const chunkPath = within(workspace.sessionRoot, material.chunk)
    await assertNoLinkedPath(workspace.root, chunkPath)
    if (material.line_end > (await readFile(chunkPath, 'utf8')).split('\n').length) throw new Error('line-range')
  } catch {
    reject(issues, 'CHAPTER_WRITING_EVIDENCE_INVALID', 'A chapter Evidence reference does not name an indexed local line range.', material.chunk)
  }
}

function localIdentity(material: EvidenceMaterial): string {
  return JSON.stringify(material)
}

function externalIdentity(material: ExternalEvidenceMaterial): string {
  return JSON.stringify({ ...material, url: normalizeWebEvidenceUrl(material.url) })
}

/**
 * Validate complete S6 output against the confirmed outline, S3 mappings, and local corpus.
 * @param workspace - Session-scoped Bid workspace.
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
  const [manifestRaw, planRaw, logRaw, outlineRaw, evidenceRaw] = await Promise.all([
    readJson(workspace, MANIFEST, issues), readJson(workspace, PLAN, issues),
    readJson(workspace, LOG, issues), readJson(workspace, 'outline/confirmed-outline.json', issues),
    readJson(workspace, 'analysis/evidence-map.json', issues),
  ])
  if (
    manifestRaw === undefined || planRaw === undefined || logRaw === undefined
    || outlineRaw === undefined || evidenceRaw === undefined
  ) return { ok: false, issues }
  let chapters
  let plan
  let executionLog
  let outline
  let evidence
  try {
    chapters = parseChapterWritingManifest(manifestRaw)
    plan = parseChapterExecutionPlan(planRaw)
    executionLog = parseChapterExecutionLog(logRaw)
    outline = parseConfirmedOutlineArtifact(outlineRaw)
    evidence = parseEvidenceMapArtifact(evidenceRaw)
  } catch {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_INVALID', 'The chapter manifest, confirmed outline, or evidence map has invalid fields.', MANIFEST)
    return { ok: false, issues }
  }
  const outlineHash = outlineArtifactSha256(outline)
  if (chapters.confirmed_outline_sha256 !== outlineHash) reject(issues, 'CHAPTER_WRITING_OUTLINE_HASH_INVALID', 'The chapter manifest does not match the confirmed outline.', MANIFEST)
  issues.push(...validateChapterExecutionPlan(plan, outline, outlineHash))
  if (executionLog.confirmed_outline_sha256 !== outlineHash) reject(issues, 'CHAPTER_WRITING_LOG_OUTLINE_HASH_INVALID', 'The execution log does not match the confirmed outline.', LOG)
  const plannedDependencies = new Map(plan.sections.map(section => [section.section_id, section.depends_on.map(item => item.section_id)]))
  const loggedSections = new Set<string>()
  for (const section of executionLog.sections) {
    if (loggedSections.has(section.section_id)) reject(issues, 'CHAPTER_WRITING_LOG_SECTION_DUPLICATE', 'The execution log contains a duplicate section.', LOG)
    loggedSections.add(section.section_id)
    if (section.status !== 'completed' || section.attempts.length === 0 || section.final_child_session_id === null) {
      reject(issues, 'CHAPTER_WRITING_LOG_SECTION_INCOMPLETE', 'Every chapter must have a completed Child Session attempt.', LOG)
    }
    if (JSON.stringify(section.depends_on) !== JSON.stringify(plannedDependencies.get(section.section_id))) {
      reject(issues, 'CHAPTER_WRITING_LOG_DEPENDENCY_INVALID', 'The execution log dependencies must match the validated plan.', LOG)
    }
    const accepted = section.attempts.filter(attempt => attempt.accepted)
    if (accepted.length !== 1 || accepted[0]?.child_session_id !== section.final_child_session_id) {
      reject(issues, 'CHAPTER_WRITING_LOG_FINAL_CHILD_INVALID', 'Each chapter must identify exactly one accepted final Child Session.', LOG)
    }
    if (accepted.some(attempt => attempt.issues.length > 0)) {
      reject(issues, 'CHAPTER_WRITING_LOG_ACCEPTED_ISSUES_INVALID', 'An accepted Child Session attempt cannot retain validation issues.', LOG)
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
      || JSON.stringify(chapter.scoring_ids) !== JSON.stringify(section.scoring_ids)) {
      reject(issues, 'CHAPTER_WRITING_SECTION_MAPPING_INVALID', 'A chapter mapping must match its confirmed section.', MANIFEST)
    }
    if (JSON.stringify(chapter.covered_scoring_response_points) !== JSON.stringify(section.scoring_response_points)
      || JSON.stringify(chapter.source_mapping_ids_used) !== JSON.stringify(section.source_mapping_ids)) {
      reject(issues, 'CHAPTER_WRITING_INHERITED_MAPPING_INVALID', 'A chapter must retain its confirmed source mappings and scoring response points.', MANIFEST)
    }
    for (const answer of chapter.covered_must_answer) if (!section.must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_UNKNOWN', 'A chapter records a must-answer outside its confirmed section.', MANIFEST)
    for (const answer of section.must_answer) if (!chapter.covered_must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_MISSING', 'A chapter omits a required must-answer from its metadata.', MANIFEST)
    const requirementIds = new Set(section.requirement_ids)
    const scoringIds = new Set(section.scoring_ids)
    const mappings = [
      ...evidence.requirement_mappings.filter(mapping => requirementIds.has(mapping.requirement_id)),
      ...evidence.scoring_mappings.filter(mapping => scoringIds.has(mapping.scoring_id)),
    ]
    const researchTopics = evidence.research_topics.filter(topic => topic.related_requirement_ids.some(id => requirementIds.has(id))
      || topic.related_scoring_points.some(point => scoringIds.has(point.scoring_id)))
    const mappedLocal = new Set([...mappings, ...researchTopics].flatMap(mapping => mapping.materials).map(localIdentity))
    for (const material of chapter.evidence_used) {
      if (!mappedLocal.has(localIdentity(material))) reject(issues, 'CHAPTER_WRITING_EVIDENCE_NOT_MAPPED', 'S3 local Evidence used by a chapter must belong to its related mappings.', MANIFEST)
    }
    const mappedExternal = new Set([...mappings, ...researchTopics].flatMap(mapping => mapping.external_materials).map(externalIdentity))
    for (const material of chapter.external_evidence_used) {
      if (!mappedExternal.has(externalIdentity(material))) reject(issues, 'CHAPTER_WRITING_EXTERNAL_EVIDENCE_NOT_MAPPED', 'S3 external Evidence used by a chapter must belong to its related mappings.', MANIFEST)
    }
    if (expectedPath !== undefined) {
      const metadataRaw = await readJson(workspace, expectedPath.metadata, issues)
      if (metadataRaw !== undefined) {
        try {
          const metadata = parseChapterMetadata(metadataRaw)
          const fromManifest = {
            section_id: chapter.section_id,
            covered_must_answer: chapter.covered_must_answer,
            covered_scoring_response_points: chapter.covered_scoring_response_points,
            source_mapping_ids_used: chapter.source_mapping_ids_used,
            evidence_used: chapter.evidence_used,
            additional_materials: chapter.additional_materials,
            external_evidence_used: chapter.external_evidence_used,
            additional_external_materials: chapter.additional_external_materials,
            unresolved_topics: chapter.unresolved_topics,
          }
          if (JSON.stringify(metadata) !== JSON.stringify(fromManifest)) throw new Error('metadata-mismatch')
        } catch {
          reject(issues, 'CHAPTER_WRITING_METADATA_INVALID', 'Chapter metadata must match its manifest entry.', expectedPath.metadata)
        }
      }
    }
    try {
      const body = within(workspace.sessionRoot, chapter.content_path)
      await assertNoLinkedPath(workspace.root, body)
      if (!(await lstat(body)).isFile() || (await readFile(body, 'utf8')).trim().length === 0) throw new Error('empty')
    } catch { reject(issues, 'CHAPTER_WRITING_CONTENT_INVALID', 'A chapter body is missing, linked, outside the session, or empty.', chapter.content_path) }
  }
  for (const id of writable.keys()) if (!actual.has(id)) reject(issues, 'CHAPTER_WRITING_SECTION_MISSING', 'The manifest omits a writable confirmed section.', MANIFEST)
  for (const id of writable.keys()) if (!loggedSections.has(id)) reject(issues, 'CHAPTER_WRITING_LOG_SECTION_MISSING', 'The execution log omits a writable confirmed section.', LOG)
  let bidManifest: BidManifest
  try { bidManifest = await workspace.readManifest() } catch { reject(issues, 'CHAPTER_WRITING_INPUT_INVALID', 'The Bid manifest cannot be read.', 'manifest.json'); return { ok: false, issues } }
  await Promise.all(chapters.chapters.flatMap(chapter =>
    [...chapter.evidence_used, ...chapter.additional_materials]
      .map(material => validateMaterial(workspace, bidManifest, material, issues))))
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
