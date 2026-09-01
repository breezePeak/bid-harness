import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { z } from 'zod'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace, ManifestFile } from './index.ts'
import { within } from './index.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { catalogMatchesScoring, parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type {
  BidStage,
  StageArtifact,
  StageValidationIssue,
  StageValidationResult,
} from './control-plane-contract.ts'
import {
  TENDER_ANALYSIS_ARTIFACTS,
  type TenderComplianceArtifact,
  type TenderProjectArtifact,
  type TenderRequirementsArtifact,
  type TenderScoringArtifact,
  type TenderSourceRef,
} from './tender-analysis-artifacts.ts'

type ParsedArtifacts = {
  project: TenderProjectArtifact
  requirements: TenderRequirementsArtifact
  scoring: TenderScoringArtifact
  compliance: TenderComplianceArtifact
}

const SUBSTANTIVE_TENDER_TEXT_MINIMUM_CHARACTERS = 80
const MULTIPLE_TECHNICAL_CONSTRAINT_SIGNALS = 2
const TECHNICAL_CONSTRAINT_SIGNALS: readonly RegExp[] = [
  /技术\s*(?:要求|参数|指标|规范)/u,
  /功能\s*(?:要求|参数|指标|规范)/u,
  /性能\s*(?:要求|参数|指标|规范)/u,
  /接口\s*(?:要求|参数|协议|规范)/u,
  /实施\s*(?:要求|方案|计划|流程)/u,
  /(?:数据|网络|信息)\s*安全\s*(?:要求|规范|措施|保障)/u,
  /(?:测试|验收|培训|运维|售后(?:技术)?服务)\s*(?:要求|方案|计划|标准|保障)/u,
  /(?:系统|平台|软件|硬件|接口|数据|网络)\s*(?:应当|应|须|必须|需(?:要)?|不得|支持|具备|满足)/u,
]
const TECHNICAL_SCORING_SIGNAL = /(?:技术(?:部分)?|技术方案)\s*(?:(?:评分|评审|评价)(?:标准|办法|表)?|分值|得分|满分)/u
const TECHNICAL_SCORING_CONTEXT = /(?:技术(?:部分|方案|要求|参数|指标|规范)?|功能|性能|接口|实施|安全|测试|验收|培训|运维|售后(?:技术)?服务)/u
const GENERIC_SCORING_SIGNAL = /(?:评分|评审|评价)(?:标准|办法|表)?|分值|得分|满分/u
const EXCLUDED_SCORING_GROUP = /(?:资格|商务|价格)(?:评分|部分|得分)?|报价/u

function reject(
  issues: StageValidationIssue[],
  code: string,
  message: string,
  artifact?: string,
  path?: string,
): void {
  issues.push({
    code,
    message,
    ...(artifact === undefined ? {} : { artifact }),
    ...(path === undefined ? {} : { path }),
  })
}

function zodPath(path: readonly PropertyKey[]): string | undefined {
  let result = ''
  for (const part of path) {
    if (typeof part === 'number') result += `[${String(part)}]`
    else if (typeof part === 'string') result += result === '' ? part : `.${part}`
  }
  return result === '' ? undefined : result
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (typeof part !== 'string' || current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function zodMessage(issue: z.core.$ZodIssue, path: string | undefined, input: unknown): string {
  const field = path?.split(/[.[]/u).at(-1)
  if (issue.code === 'unrecognized_keys') return '存在 Schema 未定义的字段。'
  if (issue.code === 'invalid_type') {
    if (input === undefined) return '缺少必需字段。'
    if (field === 'score') return '必须为数字或 null。'
    return '字段类型不符合 Schema。'
  }
  if (issue.code === 'invalid_value' && field === 'severity') return '只能使用 fatal、mandatory 或 warning。'
  if (issue.code === 'too_small') {
    if (field === 'response_points') return '至少需要一项技术响应重点。'
    if (field !== undefined && ['project_name', 'tender_name', 'purchaser', 'owner'].includes(field)) {
      return '未知值应使用 null，不能使用空字符串。'
    }
    return '至少需要一个非空值。'
  }
  if (issue.code === 'custom') return '字段值不符合 Schema 约束。'
  return '字段值不符合 Schema。'
}

function appendSchemaIssues(
  issues: StageValidationIssue[],
  artifact: keyof typeof TENDER_ANALYSIS_ARTIFACTS,
  zodIssues: readonly z.core.$ZodIssue[],
  value: unknown,
): void {
  for (const issue of zodIssues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const parent = zodPath(issue.path)
        reject(
          issues,
          'TENDER_ANALYSIS_SCHEMA_INVALID',
          zodMessage(issue, key, undefined),
          artifact,
          parent === undefined ? key : `${parent}.${key}`,
        )
      }
      continue
    }
    const path = zodPath(issue.path)
    reject(issues, 'TENDER_ANALYSIS_SCHEMA_INVALID', zodMessage(issue, path, valueAtPath(value, issue.path)), artifact, path)
  }
}

function jsonSyntaxMessage(error: unknown): string {
  const text = error instanceof SyntaxError ? error.message : ''
  const position = /position\s+(\d+)/iu.exec(text)?.[1]
  if (position !== undefined) return `JSON 语法无效（位置 ${position}）。`
  const lineColumn = /line\s+(\d+)\s+column\s+(\d+)/iu.exec(text)
  return lineColumn === null
    ? 'JSON 语法无效。'
    : `JSON 语法无效（第 ${lineColumn[1]} 行，第 ${lineColumn[2]} 列）。`
}

async function parseArtifact(
  workspace: BidWorkspace,
  path: keyof typeof TENDER_ANALYSIS_ARTIFACTS,
  issues: StageValidationIssue[],
): Promise<unknown> {
  let absolute: string
  try {
    absolute = within(workspace.sessionRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error('not a regular file')
  } catch {
    reject(issues, 'TENDER_ANALYSIS_ARTIFACT_MISSING', '缺少必需的招标分析文件。', path)
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error: unknown) {
    reject(issues, 'TENDER_ANALYSIS_JSON_INVALID', jsonSyntaxMessage(error), path)
    return undefined
  }
  const parsed = TENDER_ANALYSIS_ARTIFACTS[path].safeParse(value)
  if (!parsed.success) {
    appendSchemaIssues(issues, path, parsed.error.issues, value)
    return undefined
  }
  return parsed.data
}

function duplicateIds(values: readonly { id: string }[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id)
    seen.add(value.id)
  }
  return [...duplicates]
}

function tenderRecords(manifest: BidManifest): ManifestFile[] {
  return manifest.files.filter(file => file.role === 'tender' && file.parseStatus === 'success')
}

async function readTenderCorpusText(workspace: BidWorkspace, manifest: BidManifest): Promise<string> {
  const texts = await Promise.all(tenderRecords(manifest).map(async (record) => {
    if (record.chunksPath === null || record.chunkIndexPath === null) return ''
    const chunksPath = record.chunksPath
    const indexPath = within(workspace.sessionRoot, record.chunkIndexPath)
    await assertNoLinkedPath(workspace.root, indexPath)
    const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    const chunks = await Promise.all(index.chunks.map(async (entry) => {
      const chunkPath = within(workspace.sessionRoot, posix.join(chunksPath, entry.path))
      await assertNoLinkedPath(workspace.root, chunkPath)
      return readFile(chunkPath, 'utf8')
    }))
    return chunks.join('\n')
  }))
  return texts.join('\n')
}

function stripTenderChunkMetadata(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, ' ')
}

function normalizeTenderCorpusText(value: string): string {
  return stripTenderChunkMetadata(value).replace(/\s+/gu, ' ').trim()
}

function hasSubstantiveTenderText(value: string): boolean {
  return (value.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= SUBSTANTIVE_TENDER_TEXT_MINIMUM_CHARACTERS
}

function hasTechnicalScoringSignal(value: string): boolean {
  if (TECHNICAL_SCORING_SIGNAL.test(value)) return true
  return value.split(/\r?\n\s*\r?\n/gu).some(block => (
    GENERIC_SCORING_SIGNAL.test(block) && TECHNICAL_SCORING_CONTEXT.test(block)
  ))
}

function validateCompleteness(
  artifacts: ParsedArtifacts,
  tenderCorpus: string,
  issues: StageValidationIssue[],
): void {
  const corpus = stripTenderChunkMetadata(tenderCorpus)
  const normalizedCorpus = normalizeTenderCorpusText(tenderCorpus)
  const requirementsEmpty = artifacts.requirements.requirements.length === 0
  const scoringEmpty = artifacts.scoring.scoring_items.length === 0
  const complianceEmpty = artifacts.compliance.compliance_items.length === 0
  if (requirementsEmpty && scoringEmpty && complianceEmpty && hasSubstantiveTenderText(normalizedCorpus)) {
    reject(
      issues,
      'TENDER_ANALYSIS_CATASTROPHICALLY_EMPTY',
      'Substantive parsed tender text produced no requirements, scoring items, or compliance items.',
      'analysis',
    )
  }
  if (scoringEmpty && hasTechnicalScoringSignal(corpus)) {
    reject(
      issues,
      'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY',
      'Tender text contains technical-scoring signals but scoring_items is empty.',
      'analysis/scoring.json',
    )
  }
  const technicalConstraintSignals = TECHNICAL_CONSTRAINT_SIGNALS.filter(signal => signal.test(corpus)).length
  if (requirementsEmpty && technicalConstraintSignals >= MULTIPLE_TECHNICAL_CONSTRAINT_SIGNALS) {
    reject(
      issues,
      'TENDER_ANALYSIS_REQUIREMENTS_SUSPICIOUSLY_EMPTY',
      'Tender text contains multiple technical-constraint signals but requirements is empty.',
      'analysis/requirements.json',
    )
  }
}

function validateTechnicalScoring(scoring: TenderScoringArtifact, issues: StageValidationIssue[]): void {
  for (const item of scoring.scoring_items) {
    const classification = `${item.group ?? ''} ${item.title}`
    if (EXCLUDED_SCORING_GROUP.test(classification) && !TECHNICAL_SCORING_CONTEXT.test(classification)) {
      reject(
        issues,
        'TENDER_ANALYSIS_NON_TECHNICAL_SCORING',
        `Scoring item ${JSON.stringify(item.id)} is classified as non-technical scoring.`,
        'analysis/scoring.json',
      )
    }
  }
}

async function validateSourceRef(
  workspace: BidWorkspace,
  manifest: BidManifest,
  ref: TenderSourceRef,
  issues: StageValidationIssue[],
): Promise<void> {
  const candidates = manifest.files.filter(file => file.id === ref.file_id)
  if (candidates.length === 0) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_FILE_UNKNOWN', 'A source reference names no manifest file.', ref.chunk)
    return
  }
  if (candidates.every(file => file.role !== 'tender')) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_ROLE_INVALID', 'A reference file cannot authorize tender requirements.', ref.chunk)
    return
  }
  if (candidates.every(file => file.parseStatus !== 'success')) {
    reject(issues, 'TENDER_ANALYSIS_SOURCE_FILE_INVALID', 'A source reference names an unparsed tender file.', ref.chunk)
    return
  }
  for (const record of candidates) {
    if (record.role !== 'tender' || record.parseStatus !== 'success'
      || record.chunksPath === null || record.chunkIndexPath === null) continue
    const chunksPath = record.chunksPath
    let index: ReturnType<typeof parseDocumentChunkIndex>
    try {
      const indexPath = within(workspace.sessionRoot, record.chunkIndexPath)
      await assertNoLinkedPath(workspace.root, indexPath)
      index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    } catch {
      continue
    }
    const entry = index.chunks.find(chunk => posix.join(chunksPath, chunk.path) === ref.chunk)
    if (entry === undefined) continue
    try {
      const chunkPath = within(workspace.sessionRoot, ref.chunk)
      await assertNoLinkedPath(workspace.root, chunkPath)
      const chunk = await readFile(chunkPath, 'utf8')
      const lines = chunk.split('\n')
      const lineCount = lines.length
      if (ref.line_start > lineCount || ref.line_end > lineCount) {
        reject(issues, 'TENDER_ANALYSIS_SOURCE_LINE_INVALID', 'A source line range leaves its chunk.', ref.chunk)
      }
      return
    } catch {
      break
    }
  }
  reject(issues, 'TENDER_ANALYSIS_SOURCE_CHUNK_INVALID', 'A source reference does not name a real chunk owned by its tender file.', ref.chunk)
}

function validateCoverage(
  project: TenderProjectArtifact,
  manifest: BidManifest,
  issues: StageValidationIssue[],
): void {
  const expected = new Set(tenderRecords(manifest).map(file => file.id))
  const actual = new Set(project.analyzed_tender_files)
  if (project.analyzed_tender_files.length !== actual.size
    || expected.size !== actual.size
    || [...expected].some(id => !actual.has(id))) {
    reject(
      issues,
      'TENDER_ANALYSIS_COVERAGE_INCOMPLETE',
      'analyzed_tender_files must cover every successfully parsed tender file exactly once.',
      'analysis/project.json',
    )
  }
}

/**
 * Validate all S2 Artifacts and their citations against the current Bid Session workspace.
 * @param workspace Session-scoped Bid workspace.
 * @param stage Orchestrator stage that declares the expected Artifact paths.
 * @param artifacts Artifact references returned by the executor.
 * @returns Validation success or all detected schema and citation issues.
 */
export async function validateTenderAnalysis(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const issues: StageValidationIssue[] = []
  if (stage !== 'tender_analysis') {
    reject(issues, 'TENDER_ANALYSIS_STAGE_INVALID', 'The tender-analysis validator only accepts tender_analysis.')
  }
  const expectedPaths = [...Object.keys(TENDER_ANALYSIS_ARTIFACTS), 'analysis/scoring-response-points.json']
  for (const path of expectedPaths) {
    const matches = artifacts.filter(artifact => artifact.stage === 'tender_analysis' && artifact.path === path)
    if (matches.length !== 1) {
      reject(issues, 'TENDER_ANALYSIS_ARTIFACT_SET_INVALID', 'Each required tender-analysis Artifact must be returned exactly once.', path)
    }
  }
  for (const artifact of artifacts) {
    if (artifact.stage !== 'tender_analysis' || !expectedPaths.includes(artifact.path)) {
      reject(issues, 'TENDER_ANALYSIS_ARTIFACT_SET_INVALID', 'The executor returned an unexpected tender-analysis Artifact.', artifact.path)
    }
  }

  let manifest: BidManifest
  try {
    manifest = await workspace.readManifest()
  } catch {
    reject(issues, 'TENDER_ANALYSIS_MANIFEST_INVALID', 'The current Bid manifest cannot be read.', 'manifest.json')
    return { ok: false, issues }
  }
  if (tenderRecords(manifest).length === 0) {
    reject(issues, 'TENDER_ANALYSIS_TENDER_MISSING', 'The Bid Session has no successfully parsed tender file.', 'manifest.json')
  }

  const [project, requirements, scoring, compliance] = await Promise.all([
    parseArtifact(workspace, 'analysis/project.json', issues),
    parseArtifact(workspace, 'analysis/requirements.json', issues),
    parseArtifact(workspace, 'analysis/scoring.json', issues),
    parseArtifact(workspace, 'analysis/compliance.json', issues),
  ])
  if (project === undefined || requirements === undefined || scoring === undefined || compliance === undefined) {
    return { ok: false, issues }
  }
  const parsed: ParsedArtifacts = {
    project: project as TenderProjectArtifact,
    requirements: requirements as TenderRequirementsArtifact,
    scoring: scoring as TenderScoringArtifact,
    compliance: compliance as TenderComplianceArtifact,
  }
  validateCoverage(parsed.project, manifest, issues)
  validateCompleteness(parsed, await readTenderCorpusText(workspace, manifest), issues)
  validateTechnicalScoring(parsed.scoring, issues)
  try {
    const catalogPath = within(workspace.sessionRoot, 'analysis/scoring-response-points.json')
    await assertNoLinkedPath(workspace.root, catalogPath)
    const catalog = parseScoringResponsePointCatalog(JSON.parse(await readFile(catalogPath, 'utf8')))
    if (!catalogMatchesScoring(catalog, parsed.scoring)) {
      reject(issues, 'TENDER_ANALYSIS_RESPONSE_POINT_CATALOG_INVALID', 'The response-point catalog must exactly match scoring.json.', 'analysis/scoring-response-points.json')
    }
    for (const item of parsed.scoring.scoring_items) {
      const texts = catalog.points.filter(point => point.scoring_id === item.id).map(point => point.text)
      if (new Set(texts).size !== texts.length) reject(issues, 'TENDER_ANALYSIS_RESPONSE_POINT_TEXT_DUPLICATE', 'Response-point text must be unique within one scoring item.', 'analysis/scoring-response-points.json')
    }
  } catch {
    reject(issues, 'TENDER_ANALYSIS_RESPONSE_POINT_CATALOG_INVALID', 'The response-point catalog is missing or invalid.', 'analysis/scoring-response-points.json')
  }
  for (const [path, values] of [
    ['analysis/requirements.json', parsed.requirements.requirements],
    ['analysis/scoring.json', parsed.scoring.scoring_items],
    ['analysis/compliance.json', parsed.compliance.compliance_items],
  ] as const) {
    for (const id of duplicateIds(values)) {
      reject(issues, 'TENDER_ANALYSIS_DUPLICATE_ID', `Artifact contains duplicate id ${JSON.stringify(id)}.`, path)
    }
  }
  await Promise.all([
    ...parsed.project.source_refs.map(ref => validateSourceRef(workspace, manifest, ref, issues)),
    ...parsed.requirements.requirements.flatMap(item => item.source_refs.map(
      ref => validateSourceRef(workspace, manifest, ref, issues),
    )),
    ...parsed.scoring.scoring_items.flatMap(item => item.source_refs.map(
      ref => validateSourceRef(workspace, manifest, ref, issues),
    )),
    ...parsed.compliance.compliance_items.flatMap(item => item.source_refs.map(
      ref => validateSourceRef(workspace, manifest, ref, issues),
    )),
  ])
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
