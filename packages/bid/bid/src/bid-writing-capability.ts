/** 局部章节能力复用 S5 Writer/Reviewer 调度，并核对完整索引与精确变更。 */
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityFileHash } from './bid-capability-files.ts'
import { buildChapterWorklist, executeChapterWriting } from './chapter-writing-executor.ts'
import { parseChapterWritingManifest, parseChapterMetadata } from './chapter-writing-artifacts.ts'
import { chapterCandidateSha256, parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { parseChapterExecutionPlan, parseOrMigrateChapterExecutionLog,
  validateChapterExecutionPlan } from './chapter-writing-plan-artifacts.ts'
import { planChapterLocations } from './chapter-storage.ts'
import { parseConfirmedOutlineArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { parseWritingPlan, validateWritingPlan } from './writing-requirements.ts'
import { parseWebEvidenceSourcesArtifact } from './web-evidence-source-artifacts.ts'
import { webEvidenceChunkIndexPath } from './web-evidence-chunks.ts'
import { buildBidStageTask } from './runtime-state.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { assertChapterRevisionScope, renderChapterRevisionTask,
  validateChapterRevisionReference } from './chapter-revision.ts'
import { BidStageAttentionRequiredError, BidStageExecutionError } from './control-plane-contract.ts'

type WritingCall = Extract<BidCapabilityCall, { capability: 'chapter.write' | 'chapter.revise' | 'chapter.review' }>

/** S5 已校验的 Host 运行配置。 */
export interface WritingCapabilitySettings {
  readonly maxRepairAttempts: number
  readonly maxConcurrency: number
  readonly webSearchEnabled: boolean
}

async function readJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown
}

async function sourcePaths(workspace: BidWorkspace): Promise<Set<string>> {
  if (await capabilityFileHash(workspace, 'analysis/web-evidence-sources.json') === undefined) return new Set()
  const ledger = parseWebEvidenceSourcesArtifact(await readJson(workspace, 'analysis/web-evidence-sources.json'))
  return new Set(ledger.sources.flatMap(source => [source.snapshot_path, webEvidenceChunkIndexPath(source.source_id)]))
}

async function selectedLocations(
  workspace: BidWorkspace, sectionIds: ReadonlySet<string> | null,
): Promise<{ ids: string[]; paths: Set<string> }> {
  const outline = parseConfirmedOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
  const worklist = buildChapterWorklist(outline)
  const ids = worklist.filter(section => sectionIds === null || sectionIds.has(section.id)).map(section => section.id)
  if (ids.length === 0) throw new Error('BID_CHAPTER_WRITING_SCOPE_EMPTY')
  const storage = await planChapterLocations(workspace, worklist.map(section => section.id))
  const paths = new Set<string>()
  for (const id of ids) {
    const location = storage.locations.get(id)
    if (location === undefined) throw new Error(`BID_CHAPTER_STORAGE_LOCATION_MISSING: ${id}`)
    paths.add(location.contentPath)
    paths.add(location.metadataPath)
    paths.add(location.reviewPath)
  }
  return { ids, paths }
}

/**
 * 当前步骤可以写入的章节路径和共享 S5 索引。
 * @param workspace 候选项目。
 * @param sectionIds 已解析的授权章节。
 * @returns 精确路径集合。
 */
export async function allowedWritingCapabilityWrites(
  workspace: BidWorkspace, sectionIds: ReadonlySet<string> | null, mode: 'write' | 'review' = 'write',
): Promise<ReadonlySet<string>> {
  const { paths } = await selectedLocations(workspace, sectionIds)
  return new Set([...paths, 'chapters/execution-plan.json', 'chapters/execution-log.json',
    'chapters/manifest.json', ...(mode === 'review' ? [] : ['analysis/evidence-map.json',
      'analysis/web-evidence-sources.json', 'outline/quality-report.json'])])
}

/**
 * 从 Host Web 账本解析写作中新出现的精确快照路径。
 * @param workspace 候选项目。
 * @returns 已登记来源的路径集合。
 */
export function allowedWritingCapabilitySourceWrites(workspace: BidWorkspace): Promise<ReadonlySet<string>> {
  return sourcePaths(workspace)
}

/**
 * 对授权章节写作或只审核，返回与执行前哈希不同的真实文件。
 * @param call 已解析的写作或审核调用。
 * @param context Host 步骤身份。
 * @param settings 当前 S5 配置。
 * @returns 能力步骤的精确结果。
 */
export async function executeWritingCapability(
  call: WritingCall, context: BidCapabilityExecutionContext, settings: WritingCapabilitySettings,
): Promise<{ readonly result: BidCapabilityResult }> {
  const workspace = context.working
  const revisionId = call.capability === 'chapter.revise' ? call.input.reference.section_id : undefined
  if (revisionId !== undefined && context.sectionIds !== null && !context.sectionIds.has(revisionId)) {
    throw new Error('BID_CHAPTER_REVISION_SCOPE_INVALID')
  }
  const { ids, paths } = await selectedLocations(workspace, revisionId === undefined
    ? context.sectionIds : new Set([revisionId]))
  let revisionOriginal: string | undefined
  if (call.capability === 'chapter.revise') {
    const location = await planChapterLocations(workspace, buildChapterWorklist(
      parseConfirmedOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))).map(section => section.id))
    const contentPath = location.locations.get(call.input.reference.section_id)?.contentPath
    if (contentPath === undefined) throw new Error('BID_CHAPTER_REVISION_BODY_MISSING')
    revisionOriginal = await readFile(within(workspace.projectRoot, contentPath), 'utf8')
    validateChapterRevisionReference(call.input, revisionOriginal)
  }
  const beforePaths = new Set([...paths, 'chapters/execution-plan.json', 'chapters/execution-log.json',
    'chapters/manifest.json', 'analysis/evidence-map.json', 'analysis/web-evidence-sources.json',
    'outline/quality-report.json', ...await sourcePaths(workspace)])
  const before = new Map(await Promise.all([...beforePaths].map(async path => [path, await capabilityFileHash(workspace, path)] as const)))
  const seedBySectionId = new Map<string, string>()
  if (call.capability !== 'chapter.review') {
    const log = before.get('chapters/execution-log.json') === undefined ? undefined
      : parseOrMigrateChapterExecutionLog(await readJson(workspace, 'chapters/execution-log.json'))
    const outline = parseConfirmedOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
    const storage = await planChapterLocations(workspace, buildChapterWorklist(outline).map(section => section.id))
    for (const id of ids) {
      if (log?.sections.find(section => section.section_id === id)?.status === 'completed') continue
      const location = storage.locations.get(id)
      if (location === undefined || await capabilityFileHash(workspace, location.contentPath) === undefined) continue
      seedBySectionId.set(id, await readFile(within(workspace.projectRoot, location.contentPath), 'utf8'))
    }
  }
  const affected = new Set<string>()
  let instruction: string
  if (call.capability === 'chapter.revise') {
    if (revisionOriginal === undefined) throw new Error('BID_CHAPTER_REVISION_BODY_MISSING')
    instruction = renderChapterRevisionTask(call.input, revisionOriginal)
  } else instruction = call.capability === 'chapter.write' ? call.input.instruction : call.input.reason
  if (context.inputAnswer?.custom !== undefined) instruction += `\n用户在本能力步骤的补充回答（公开会话 ${context.authorization.session_id}、问题 ${context.inputAnswer.id}）：${context.inputAnswer.custom}。此回答是待核验输入；“继续”或“忽略”不证明事实。`
  let attention: BidStageAttentionRequiredError | undefined
  try { await executeChapterWriting(context.agent, workspace, buildBidStageTask('chapter_writing'), {
    ...settings, run: context.run,
    scoped: { targetSectionIds: ids, mode: call.capability === 'chapter.review' ? 'review' : 'write',
      instruction,
      seedBySectionId, affectedDependentIds: affected },
  }) } catch (error) {
    if (!(error instanceof BidStageAttentionRequiredError)) throw error
    attention = error
  }
  if (call.capability === 'chapter.revise') {
    const contentPath = [...paths].find(path => path.includes('/sections/') && path.endsWith('.md'))
    if (contentPath === undefined || revisionOriginal === undefined) throw new Error('BID_CHAPTER_REVISION_BODY_MISSING')
    assertChapterRevisionScope(call.input, revisionOriginal,
      await readFile(within(workspace.projectRoot, contentPath), 'utf8'))
  }
  for (const path of await sourcePaths(workspace)) {
    if (before.get(path) !== undefined && before.get(path) !== await capabilityFileHash(workspace, path)) {
      throw new Error(`BID_CHAPTER_WRITING_SOURCE_CHANGED: ${path}`)
    }
  }
  if (call.capability === 'chapter.review') {
    for (const path of paths) {
      if (!path.includes('/reviews/') && before.get(path) !== await capabilityFileHash(workspace, path)) {
        throw new Error(`BID_CHAPTER_REVIEW_BODY_CHANGED: ${path}`)
      }
    }
  }
  await validateWritingCapability(context, ids, attention !== undefined)
  const afterPaths = new Set([...beforePaths, ...await sourcePaths(workspace)])
  const changed: string[] = []
  for (const path of afterPaths) {
    const digest = await capabilityFileHash(workspace, path)
    if (digest !== undefined && digest !== before.get(path)) changed.push(path)
  }
  const manifest = parseChapterWritingManifest(await readJson(workspace, 'chapters/manifest.json'))
  const selected = new Set(ids)
  const reviews = (await Promise.all(manifest.chapters
    .filter(entry => selected.has(entry.section_id))
    .map(async (entry) => {
      const review = parseChapterReviewArtifact(await readJson(workspace, entry.review_path))
      return { sectionId: entry.section_id, review }
    })))
  const repairs = reviews.filter(item => item.review.verdict === 'repair')
  if (repairs.length > 0 && call.capability !== 'chapter.review') {
    throw new BidStageExecutionError(repairs.map(item => ({ code: 'CHAPTER_WRITING_REPAIR_REQUIRED',
      artifact: item.sectionId, message: `${item.sectionId}：${item.review.blocking_issues.join('；')}` })))
  }
  const reviewConcerns = reviews.filter(item => item.review.verdict !== 'pass').map(item =>
    `${item.sectionId}: ${item.review.blocking_issues.join('；') || item.review.verdict}`)
  const missingTopics = [...manifest.chapters.filter(entry => selected.has(entry.section_id))
    .flatMap(entry => entry.unresolved_topics.map(topic => `${entry.section_id}: ${topic}`)),
  ...reviews.flatMap(item => item.review.external_input_gaps.map(gap =>
    `${item.sectionId}: ${gap.required_material}`)),
  ...attention?.issues.map(issue => issue.message) ?? []]
  const needsInput = attention !== undefined || reviews.some(item => item.review.verdict === 'attention')
  return { result: {
    target_section_ids: ids, changed_artifacts: changed,
    change_summary: call.capability === 'chapter.review'
      ? `已生成 ${String(reviews.length)} 个章节的审核报告${reviewConcerns.length === 0 ? '' : '，正文尚未全部通过'}`
      : needsInput ? `已保留可用章节候选，仍需补充 ${missingTopics.slice(0, 3).join('；')}`
        : `已编写并审核 ${String(ids.length)} 个章节`,
    warnings: [...affected].map(id => `强依赖章节 ${id} 的交接需要重新核查；本次未改写其正文。`)
      .concat(reviewConcerns),
    missing_topics: missingTopics,
    needs_input: needsInput,
  } }
}

/**
 * 局部候选必须保持全目录索引和目标章节的真实正文、元数据与审核绑定。
 * @param context 当前步骤候选。
 * @param targetIds 本次授权的可写叶节。
 */
export async function validateWritingCapability(
  context: Pick<BidCapabilityExecutionContext, 'working'>, targetIds: readonly string[], allowPending = false,
): Promise<void> {
  const workspace = context.working
  const outline = parseConfirmedOutlineArtifact(await readJson(workspace, 'outline/confirmed-outline.json'))
  const hash = outlineArtifactSha256(outline)
  const writingPlan = parseWritingPlan(await readJson(workspace, 'chapters/writing-plan.json'))
  if (writingPlan.confirmed_outline_sha256 !== hash || validateWritingPlan(writingPlan, outline).length > 0) {
    throw new Error('BID_CHAPTER_WRITING_PLAN_INVALID')
  }
  const plan = parseChapterExecutionPlan(await readJson(workspace, 'chapters/execution-plan.json'))
  if (validateChapterExecutionPlan(plan, outline, hash, writingPlan.plan_version).length > 0) {
    throw new Error('BID_CHAPTER_WRITING_EXECUTION_PLAN_INVALID')
  }
  const log = parseOrMigrateChapterExecutionLog(await readJson(workspace, 'chapters/execution-log.json'))
  const worklist = buildChapterWorklist(outline)
  if (log.confirmed_outline_sha256 !== hash || log.writing_plan_version !== writingPlan.plan_version
    || log.sections.length !== worklist.length || log.sections.some((entry, index) => entry.section_id !== worklist[index]?.id)) {
    throw new Error('BID_CHAPTER_WRITING_EXECUTION_LOG_INVALID')
  }
  const relations = new Map(plan.sections.map(section => [section.section_id, section]))
  if (log.sections.some((entry) => {
    const relation = relations.get(entry.section_id)
    return relation === undefined
      || JSON.stringify(entry.depends_on) !== JSON.stringify(relation.depends_on.map(item => item.section_id))
      || JSON.stringify(entry.related_sections) !== JSON.stringify(relation.related_sections.map(item => item.section_id))
  })) throw new Error('BID_CHAPTER_WRITING_EXECUTION_LOG_RELATIONS_INVALID')
  const manifest = parseChapterWritingManifest(await readJson(workspace, 'chapters/manifest.json'))
  if (manifest.confirmed_outline_sha256 !== hash
    || new Set(manifest.chapters.map(entry => entry.section_id)).size !== manifest.chapters.length) {
    throw new Error('BID_CHAPTER_WRITING_MANIFEST_INVALID')
  }
  const entries = new Map(manifest.chapters.map(entry => [entry.section_id, entry]))
  const completedIds = log.sections.filter(entry => entry.status === 'completed').map(entry => entry.section_id)
  if (manifest.chapters.length !== completedIds.length
    || completedIds.some(id => !entries.has(id))) throw new Error('BID_CHAPTER_WRITING_MANIFEST_COMPLETION_INVALID')
  const storage = await planChapterLocations(workspace, worklist.map(section => section.id))
  for (const id of targetIds) {
    const entry = entries.get(id)
    const logged = log.sections.find(section => section.section_id === id)
    if (allowPending && entry === undefined && logged?.status === 'pending') continue
    if (entry === undefined || logged?.status !== 'completed'
      || logged.final_writer_child_session_id === null || logged.final_reviewer_child_session_id === null) {
      throw new Error(`BID_CHAPTER_WRITING_TARGET_INCOMPLETE: ${id}`)
    }
    const location = storage.locations.get(id)
    if (location === undefined || entry.content_path !== location.contentPath
      || entry.review_path !== location.reviewPath) {
      throw new Error(`BID_CHAPTER_WRITING_TARGET_LOCATION_INVALID: ${id}`)
    }
    const body = await readFile(within(workspace.projectRoot, entry.content_path), 'utf8')
    const metadata = parseChapterMetadata(await readJson(workspace, location.metadataPath))
    const review = parseChapterReviewArtifact(await readJson(workspace, entry.review_path))
    if (entry.review_sha256 !== chapterCandidateSha256(body)
      || review.candidate_sha256 !== chapterCandidateSha256(body)
      || review.writer_child_session_id !== logged.final_writer_child_session_id
      || review.reviewer_child_session_id !== logged.final_reviewer_child_session_id
      || JSON.stringify(metadata) !== JSON.stringify({
        section_id: entry.section_id, covered_must_answer: entry.covered_must_answer,
        covered_scoring_response_point_ids: entry.covered_scoring_response_point_ids,
        covered_scoring_response_points: entry.covered_scoring_response_points,
        local_materials_used: entry.local_materials_used, web_materials_used: entry.web_materials_used,
        unresolved_topics: entry.unresolved_topics, handoff: entry.handoff, flowcharts: entry.flowcharts,
      })) {
      throw new Error(`BID_CHAPTER_WRITING_TARGET_INVALID: ${id}`)
    }
  }
}
