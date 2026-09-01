import { lstat, readFile } from 'node:fs/promises'
import { ZodError } from 'zod'
import { resolveEvidenceChunk, resolveEvidenceSourceSection } from './evidence-chunk.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import { within } from './index.ts'
import type { BidStage, StageArtifact, StageValidationIssue, StageValidationResult } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type EvidenceMaterial, type EvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { catalogMatchesScoring, parseScoringResponsePointCatalog, type ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import {
  normalizeWebEvidenceUrl,
  parseWebEvidenceSourcesArtifact,
  webEvidenceContentSha256,
  type WebEvidenceSource,
} from './web-evidence-source-artifacts.ts'

const ARTIFACT = 'analysis/evidence-map.json'
const WEB_SOURCES_ARTIFACT = 'analysis/web-evidence-sources.json'
const S2_REQUIREMENTS = 'analysis/requirements.json'
const S2_SCORING = 'analysis/scoring.json'
const RESPONSE_POINTS = 'analysis/scoring-response-points.json'

function reject(
  issues: StageValidationIssue[], code: string, message: string, artifact?: string, path?: string,
): void {
  issues.push({ code, message, ...(artifact === undefined ? {} : { artifact }), ...(path === undefined ? {} : { path }) })
}

function zodPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((result, segment) => typeof segment === 'number'
    ? `${result}[${segment}]`
    : result.length === 0 ? String(segment) : `${result}.${String(segment)}`, '')
}

async function parseJson(workspace: BidWorkspace, path: string, issues: StageValidationIssue[], code: string): Promise<unknown> {
  try {
    const absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not-file')
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    reject(issues, code, 'A required evidence-mapping Artifact is missing or invalid.', path)
    return undefined
  }
}

function validateCoverage(
  expected: readonly { id: string }[], actual: readonly string[], kind: string, issues: StageValidationIssue[],
): void {
  const expectedIds = new Set(expected.map(item => item.id))
  const actualIds = new Set(actual)
  if (actual.length !== actualIds.size) reject(issues, `EVIDENCE_MAPPING_${kind}_DUPLICATE`, `Each ${kind.toLowerCase()} mapping must occur once.`, ARTIFACT)
  for (const id of actualIds) if (!expectedIds.has(id)) {
    reject(issues, `EVIDENCE_MAPPING_${kind}_UNKNOWN`, `Evidence mapping references unknown ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, ARTIFACT)
  }
  for (const id of expectedIds) if (!actualIds.has(id)) {
    reject(issues, `EVIDENCE_MAPPING_${kind}_MISSING`, `Evidence mapping omits ${kind.toLowerCase()} id ${JSON.stringify(id)}.`, ARTIFACT)
  }
}

function validateSourceStrategy(map: EvidenceMapArtifact, manifest: BidManifest, issues: StageValidationIssue[]): void {
  const frameworks = manifest.files.filter(file => file.role === 'outline_framework' && file.parseStatus === 'success')
  const referenceBids = manifest.files.filter(file => file.role === 'reference_bid' && file.parseStatus === 'success')
  const expectedMode = frameworks.length > 0
    ? referenceBids.length > 0 ? 'framework_and_reference_bid' : 'framework_only'
    : referenceBids.length > 0 ? 'reference_bid_only' : 'generated_from_scratch'
  if (map.source_strategy.mode !== expectedMode) {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_STRATEGY_INVALID', 'Source strategy mode does not match successfully parsed special assets.', ARTIFACT, 'source_strategy.mode')
  }
  const frameworkIds = new Set(frameworks.map(file => String(file.id)))
  if ((frameworks.length === 0 && map.source_strategy.framework_file_id !== null)
    || (frameworks.length > 0 && !frameworkIds.has(map.source_strategy.framework_file_id ?? ''))) {
    reject(issues, 'EVIDENCE_MAPPING_FRAMEWORK_FILE_INVALID', 'Source strategy must name one successfully parsed framework file, or null.', ARTIFACT, 'source_strategy.framework_file_id')
  }
  validateCoverage(referenceBids, map.source_strategy.reference_bid_file_ids, 'REFERENCE_BID_FILE', issues)
}

function validateResponsePointMappings(
  map: EvidenceMapArtifact,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): void {
  const expected = new Map(catalog.points.map(point => [point.id, point]))
  const actual = new Set<string>()
  for (const [index, mapping] of map.response_point_mappings.entries()) {
    const point = expected.get(mapping.response_point_id)
    if (actual.has(mapping.response_point_id)) reject(issues, 'EVIDENCE_MAPPING_RESPONSE_POINT_DUPLICATE', 'Each scoring response point must occur once.', ARTIFACT, `response_point_mappings[${index}]`)
    actual.add(mapping.response_point_id)
    if (point === undefined || point.scoring_id !== mapping.scoring_id || point.text !== mapping.response_point) reject(issues, 'EVIDENCE_MAPPING_RESPONSE_POINT_UNKNOWN', 'A response-point mapping does not match the S2 response-point catalog.', ARTIFACT, `response_point_mappings[${index}]`)
  }
  for (const id of expected.keys()) if (!actual.has(id)) {
    reject(issues, 'EVIDENCE_MAPPING_RESPONSE_POINT_MISSING', 'A scoring response point has no S3 writing mapping.', ARTIFACT)
  }
}

async function validateSourceMappings(
  map: EvidenceMapArtifact,
  workspace: BidWorkspace,
  manifest: BidManifest,
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): Promise<void> {
  const requirementIds = new Set(requirements.requirements.map(item => item.id))
  const points = new Map(catalog.points.map(point => [point.id, point]))
  const ids = new Set<string>()
  const sourceSections = new Set<string>()
  const validate = async (kind: 'framework' | 'reference_bid', role: 'outline_framework' | 'reference_bid', mappings: readonly EvidenceMapArtifact['framework_mappings'][number][] | readonly EvidenceMapArtifact['reference_bid_mappings'][number][]): Promise<void> => {
    for (const [index, mapping] of mappings.entries()) {
      const path = `${kind}_mappings[${index}]`
      if (ids.has(mapping.mapping_id)) reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_DUPLICATE', 'Each source mapping id must occur once.', ARTIFACT, `${path}.mapping_id`)
      ids.add(mapping.mapping_id)
      const sourceKey = `${mapping.file_id}\u0000${mapping.source_section_id}`
      if (sourceSections.has(sourceKey)) reject(issues, 'EVIDENCE_MAPPING_SOURCE_SECTION_DUPLICATE', 'A source heading may have at most one mapping.', ARTIFACT, path)
      sourceSections.add(sourceKey)
      const file = manifest.files.find(candidate => String(candidate.id) === mapping.file_id)
      if (file === undefined || file.role !== role || file.parseStatus !== 'success') {
        reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_FILE_INVALID', 'A source mapping must reference a successfully parsed file of its own role.', ARTIFACT, `${path}.file_id`)
      }
      for (const requirementId of mapping.related_requirement_ids) if (!requirementIds.has(requirementId)) {
        reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_REQUIREMENT_INVALID', 'A source mapping names an unknown requirement.', ARTIFACT, `${path}.related_requirement_ids`)
      }
      for (const pointId of mapping.related_response_point_ids) {
        if (!points.has(pointId)) reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_RESPONSE_POINT_INVALID', 'A source mapping names an unknown scoring response point.', ARTIFACT, `${path}.related_response_point_ids`)
      }
      for (const material of mapping.content_materials) if (material.file_id !== mapping.file_id) {
        reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_MATERIAL_INVALID', 'Source mapping content must belong to its mapped source file.', ARTIFACT, `${path}.content_materials`)
      }
      if (file !== undefined && file.role === role && file.parseStatus === 'success') {
        try {
          const { section } = await resolveEvidenceSourceSection(workspace, manifest, mapping, role)
          for (const material of mapping.content_materials) {
            const entry = (await resolveEvidenceChunk(workspace, manifest, material)).entry
            if (!section.heading_path.every((title, offset) => entry.heading_path[offset] === title)) {
              reject(issues, 'EVIDENCE_MAPPING_SOURCE_MAPPING_HEADING_INVALID', 'Source content must come from the mapped heading or its descendants.', ARTIFACT, `${path}.content_materials`)
            }
          }
        } catch {
          reject(issues, 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', 'A source mapping cannot be verified against source structure.', ARTIFACT, path)
        }
      }
    }
  }
  await validate('framework', 'outline_framework', map.framework_mappings)
  await validate('reference_bid', 'reference_bid', map.reference_bid_mappings)
}

async function validateMaterial(
  workspace: BidWorkspace, manifest: BidManifest, material: EvidenceMaterial, issues: StageValidationIssue[],
): Promise<void> {
  const matchingFiles = manifest.files.filter(record => String(record.id) === material.file_id)
  if (matchingFiles.length === 0) { reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_UNKNOWN', 'A material references no manifest file.', material.chunk); return }
  const file = matchingFiles[0]
  if (file === undefined) return
  if (file.role === 'tender') {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_NOT_REFERENCE', 'A material must reference a non-tender project material.', material.chunk)
    return
  }
  if (file.parseStatus !== 'success' || file.chunksPath === null || file.chunkIndexPath === null) {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_FILE_INVALID', 'A material references an unparsed file.', material.chunk)
    return
  }
  try {
    await resolveEvidenceChunk(workspace, manifest, material)
  } catch {
    reject(issues, 'EVIDENCE_MAPPING_SOURCE_CHUNK_INVALID', 'A material does not name a real chunk owned by its file.', material.chunk)
  }
}

async function validateWebSource(
  workspace: BidWorkspace,
  source: WebEvidenceSource,
  issues: StageValidationIssue[],
): Promise<boolean> {
  try {
    const snapshot = within(workspace.sessionRoot, source.snapshot_path)
    await assertNoLinkedPath(workspace.root, snapshot)
    if (!(await lstat(snapshot)).isFile()) throw new Error('not-file')
    const content = await readFile(snapshot, 'utf8')
    if (webEvidenceContentSha256(content) !== source.content_sha256) {
      reject(issues, 'EVIDENCE_MAPPING_WEB_SOURCE_HASH_MISMATCH', `Web source ${source.source_id} snapshot hash does not match its ledger record.`, source.snapshot_path)
      return false
    }
    return true
  } catch {
    reject(issues, 'EVIDENCE_MAPPING_WEB_SOURCE_SNAPSHOT_INVALID', `Web source ${source.source_id} snapshot is missing, linked, or outside the Session Workspace.`, source.snapshot_path)
    return false
  }
}

function validateExternalMaterials(
  map: ReturnType<typeof parseEvidenceMapArtifact>,
  sources: readonly WebEvidenceSource[],
  validSourceIds: ReadonlySet<string>,
  issues: StageValidationIssue[],
): void {
  const verifiedUrls = new Map<string, WebEvidenceSource>()
  for (const source of sources) {
    if (!validSourceIds.has(source.source_id)) continue
    const requested = normalizeWebEvidenceUrl(source.requested_url)
    const final = normalizeWebEvidenceUrl(source.final_url)
    if (requested !== undefined) verifiedUrls.set(requested, source)
    if (final !== undefined) verifiedUrls.set(final, source)
  }
  for (const mapping of [...map.requirement_mappings, ...map.scoring_mappings, ...map.response_point_mappings, ...map.research_topics]) {
    for (const material of mapping.external_materials) {
      const normalized = normalizeWebEvidenceUrl(material.url)
      if (normalized === undefined || !verifiedUrls.has(normalized)) {
        reject(
          issues,
          'EVIDENCE_MAPPING_WEB_SOURCE_UNVERIFIED',
          `External material URL ${JSON.stringify(material.url)} has no verified current-attempt web_search to web_fetch source.`,
          ARTIFACT,
        )
      }
    }
  }
}

function validateResearchTopics(
  map: ReturnType<typeof parseEvidenceMapArtifact>,
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>,
  catalog: ScoringResponsePointCatalog,
  issues: StageValidationIssue[],
): void {
  const requirementIds = new Set(requirements.requirements.map(item => item.id))
  const responsePointsById = new Map(catalog.points.map(point => [point.id, point]))
  const topicIds = new Set<string>()
  for (const [topicIndex, topic] of map.research_topics.entries()) {
    if (topicIds.has(topic.topic_id)) reject(issues, 'EVIDENCE_MAPPING_RESEARCH_TOPIC_DUPLICATE', 'Each research topic id must occur once.', ARTIFACT, `research_topics[${topicIndex}].topic_id`)
    topicIds.add(topic.topic_id)
    for (const [idIndex, requirementId] of topic.related_requirement_ids.entries()) {
      if (!requirementIds.has(requirementId)) reject(issues, 'EVIDENCE_MAPPING_RESEARCH_REQUIREMENT_UNKNOWN', `Research topic references unknown requirement id ${JSON.stringify(requirementId)}.`, ARTIFACT, `research_topics[${topicIndex}].related_requirement_ids[${idIndex}]`)
    }
    for (const [pointIndex, point] of topic.related_scoring_points.entries()) {
      const catalogPoint = responsePointsById.get(point.response_point_id)
      const path = `research_topics[${topicIndex}].related_scoring_points[${pointIndex}]`
      if (catalogPoint === undefined) {
        reject(issues, 'EVIDENCE_MAPPING_RESEARCH_RESPONSE_POINT_UNKNOWN', `Research topic references unknown response-point id ${JSON.stringify(point.response_point_id)}.`, ARTIFACT, `${path}.response_point_id`)
      } else if (catalogPoint.scoring_id !== point.scoring_id || catalogPoint.text !== point.response_point) {
        reject(issues, 'EVIDENCE_MAPPING_RESEARCH_RESPONSE_POINT_MISMATCH', 'Research topic scoring id or text does not match the stable response point.', ARTIFACT, path)
      }
    }
  }
}

/** Validate S3 mappings against S2 identifiers and the local session corpus. */
export async function validateEvidenceMapping(
  workspace: BidWorkspace, stage: BidStage, artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'evidence_mapping') reject(issues, 'EVIDENCE_MAPPING_STAGE_INVALID', 'The evidence-mapping validator only accepts evidence_mapping.')
  const expectedArtifacts = new Map([
    [ARTIFACT, 'evidence_map'],
    [WEB_SOURCES_ARTIFACT, 'web_evidence_sources'],
  ])
  const matching = artifacts.filter(artifact => artifact.stage === 'evidence_mapping'
    && expectedArtifacts.get(artifact.path) === artifact.type)
  if (matching.length !== expectedArtifacts.size || artifacts.length !== expectedArtifacts.size
    || new Set(matching.map(artifact => artifact.path)).size !== expectedArtifacts.size) {
    reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_SET_INVALID', 'The executor must return the evidence map and Host Web source ledger exactly once.', ARTIFACT)
  }
  let manifest: BidManifest
  try { manifest = await workspace.readManifest() } catch {
    reject(issues, 'EVIDENCE_MAPPING_MANIFEST_INVALID', 'The current Bid manifest cannot be read.', 'manifest.json')
    return { ok: false, issues }
  }
  const [rawMap, rawWebSources, rawRequirements, rawScoring, rawCatalog] = await Promise.all([
    parseJson(workspace, ARTIFACT, issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID'),
    parseJson(workspace, WEB_SOURCES_ARTIFACT, issues, 'EVIDENCE_MAPPING_WEB_SOURCE_ARTIFACT_INVALID'),
    parseJson(workspace, S2_REQUIREMENTS, issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID'),
    parseJson(workspace, S2_SCORING, issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID'),
    parseJson(workspace, RESPONSE_POINTS, issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID'),
  ])
  if (rawMap === undefined || rawWebSources === undefined
    || rawRequirements === undefined || rawScoring === undefined || rawCatalog === undefined) return { ok: false, issues }
  let map
  let webSources
  let requirements
  let scoring
  let catalog
  try {
    map = parseEvidenceMapArtifact(rawMap)
    webSources = parseWebEvidenceSourcesArtifact(rawWebSources)
    requirements = parseTenderRequirementsArtifact(rawRequirements)
    scoring = parseTenderScoringArtifact(rawScoring)
    catalog = parseScoringResponsePointCatalog(rawCatalog)
  } catch {
    try { parseEvidenceMapArtifact(rawMap) } catch (error) {
      if (error instanceof ZodError) {
        for (const issue of error.issues) reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID', issue.message, ARTIFACT, zodPath(issue.path))
      } else {
        reject(issues, 'EVIDENCE_MAPPING_ARTIFACT_INVALID', 'The evidence-map Artifact has invalid fields.', ARTIFACT)
      }
    }
    try { parseWebEvidenceSourcesArtifact(rawWebSources) } catch {
      reject(issues, 'EVIDENCE_MAPPING_WEB_SOURCE_ARTIFACT_INVALID', 'The Host Web source ledger has invalid fields.', WEB_SOURCES_ARTIFACT)
    }
    if (issues.length === 0) reject(issues, 'EVIDENCE_MAPPING_S2_INPUT_INVALID', 'An S2 evidence-mapping input has invalid fields.')
    return { ok: false, issues }
  }
  validateCoverage(requirements.requirements, map.requirement_mappings.map(item => item.requirement_id), 'REQUIREMENT', issues)
  validateCoverage(scoring.scoring_items, map.scoring_mappings.map(item => item.scoring_id), 'SCORING', issues)
  if (!catalogMatchesScoring(catalog, scoring)) reject(issues, 'EVIDENCE_MAPPING_RESPONSE_POINT_CATALOG_MISMATCH', 'The stable response-point catalog does not match scoring.json.', RESPONSE_POINTS)
  validateSourceStrategy(map, manifest, issues)
  validateResponsePointMappings(map, catalog, issues)
  await validateSourceMappings(map, workspace, manifest, requirements, catalog, issues)
  validateResearchTopics(map, requirements, catalog, issues)
  await Promise.all([
    ...[...map.requirement_mappings, ...map.scoring_mappings, ...map.response_point_mappings, ...map.research_topics]
      .flatMap(mapping => mapping.materials.map(material => validateMaterial(workspace, manifest, material, issues))),
    ...[...map.framework_mappings, ...map.reference_bid_mappings]
      .flatMap(mapping => mapping.content_materials.map(material => validateMaterial(workspace, manifest, material, issues))),
  ])
  const validity = await Promise.all(webSources.sources.map(async source => ({
    source,
    valid: await validateWebSource(workspace, source, issues),
  })))
  const validSourceIds = new Set(validity.filter(item => item.valid).map(item => item.source.source_id))
  validateExternalMaterials(map, webSources.sources, validSourceIds, issues)
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
