import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { BidManifest, BidWorkspace } from './index.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { buildChapterWorklist } from './chapter-writing-executor.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type EvidenceMaterial, type ExternalEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseConfirmedOutlineArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { normalizeWebEvidenceUrl } from './web-evidence-source-artifacts.ts'

const MANIFEST = 'chapters/manifest.json'

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
  const file = manifest.files.find(item => item.id === material.file_id && item.role === 'reference')
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
  const artifact = artifacts.length === 1 ? artifacts[0] : undefined
  if (artifact === undefined || artifact.stage !== 'chapter_writing' || artifact.type !== 'chapter_manifest' || artifact.path !== MANIFEST) {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_SET_INVALID', 'The executor must return chapters/manifest.json exactly once.', MANIFEST)
  }
  const [manifestRaw, outlineRaw, evidenceRaw] = await Promise.all([
    readJson(workspace, MANIFEST, issues), readJson(workspace, 'outline/confirmed-outline.json', issues),
    readJson(workspace, 'analysis/evidence-map.json', issues),
  ])
  if (manifestRaw === undefined || outlineRaw === undefined || evidenceRaw === undefined) return { ok: false, issues }
  let chapters
  let outline
  let evidence
  try {
    chapters = parseChapterWritingManifest(manifestRaw)
    outline = parseConfirmedOutlineArtifact(outlineRaw)
    evidence = parseEvidenceMapArtifact(evidenceRaw)
  } catch {
    reject(issues, 'CHAPTER_WRITING_ARTIFACT_INVALID', 'The chapter manifest, confirmed outline, or evidence map has invalid fields.', MANIFEST)
    return { ok: false, issues }
  }
  if (chapters.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) reject(issues, 'CHAPTER_WRITING_OUTLINE_HASH_INVALID', 'The chapter manifest does not match the confirmed outline.', MANIFEST)
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
    for (const answer of chapter.covered_must_answer) if (!section.must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_UNKNOWN', 'A chapter records a must-answer outside its confirmed section.', MANIFEST)
    for (const answer of section.must_answer) if (!chapter.covered_must_answer.includes(answer)) reject(issues, 'CHAPTER_WRITING_MUST_ANSWER_MISSING', 'A chapter omits a required must-answer from its metadata.', MANIFEST)
    const requirementIds = new Set(section.requirement_ids)
    const scoringIds = new Set(section.scoring_ids)
    const mappings = [
      ...evidence.requirement_mappings.filter(mapping => requirementIds.has(mapping.requirement_id)),
      ...evidence.scoring_mappings.filter(mapping => scoringIds.has(mapping.scoring_id)),
    ]
    const mappedLocal = new Set(mappings.flatMap(mapping => mapping.materials).map(localIdentity))
    for (const material of chapter.evidence_used) {
      if (!mappedLocal.has(localIdentity(material))) reject(issues, 'CHAPTER_WRITING_EVIDENCE_NOT_MAPPED', 'S3 local Evidence used by a chapter must belong to its related mappings.', MANIFEST)
    }
    const mappedExternal = new Set(mappings.flatMap(mapping => mapping.external_materials).map(externalIdentity))
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
  let bidManifest: BidManifest
  try { bidManifest = await workspace.readManifest() } catch { reject(issues, 'CHAPTER_WRITING_INPUT_INVALID', 'The Bid manifest cannot be read.', 'manifest.json'); return { ok: false, issues } }
  await Promise.all(chapters.chapters.flatMap(chapter =>
    [...chapter.evidence_used, ...chapter.additional_materials]
      .map(material => validateMaterial(workspace, bidManifest, material, issues))))
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
