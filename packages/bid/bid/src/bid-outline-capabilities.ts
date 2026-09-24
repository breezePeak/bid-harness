/** 目录与原文迁移能力使用同一候选协调器和精确文件准入。 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { bidCapabilityInputSchema, type BidCapabilityCall,
  type BidCapabilityExecutionContext, type BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityOutlineAllowedWrites, executeCapabilityChapterReorganize,
  executeCapabilityOutlineUpdate, OUTLINE_CAPABILITY_INDEX_PATHS,
  previewCapabilityOutline, outlineReassignmentSchema } from './outline-capability-update.ts'
import { readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import { generateScopedOutlineBusinessBindings, generateScopedOutlineOperations } from './outline-generation-executor.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { zodJsonSchema } from './zod-json-schema.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { chapterBlockAssignmentSchema, indexChapterContentBlocks } from './chapter-content-reuse.ts'
import { outlineArtifactSha256, parseOutlineConfirmationArtifact, parseOutlineDraft } from './outline-confirmation-artifacts.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseChapterExecutionPlan, parseOrMigrateChapterExecutionLog,
  validateChapterExecutionPlan } from './chapter-writing-plan-artifacts.ts'
import { parseWritingPlan, validateWritingPlan } from './writing-requirements.ts'
import { chapterReuseSeedsSchema } from './chapter-content-reuse.ts'
import { validateFlowchartAnchors } from './flowchart.ts'
import { buildWritableSectionWorklist, validateSectionEvidenceCoverage } from './section-evidence-context.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type OutlineCall = Extract<BidCapabilityCall, { capability: 'outline.update' | 'outline.refine' | 'chapter.reorganize' }>

async function optionalJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 计算目录能力可以写入的真实文件路径。
 * @param call 已解析的能力参数。
 * @param workspace 当前 Work 候选。
 * @param stepId Host 分配的步骤身份。
 * @returns 精确允许文件集合。
 * @param sectionIds - 已授权的章节身份集合；null 表示未指定章节。
 */
export function allowedOutlineCapabilityWrites(
  call: OutlineCall, workspace: BidWorkspace, stepId: string,
  sectionIds: ReadonlySet<string> | null,
): Promise<ReadonlySet<string>> {
  if (call.capability === 'outline.refine') return Promise.resolve(new Set(OUTLINE_CAPABILITY_INDEX_PATHS))
  return capabilityOutlineAllowedWrites(call, workspace, stepId, sectionIds)
}

async function generateChapterAssignments(
  call: Extract<OutlineCall, { capability: 'chapter.reorganize' }>, context: BidCapabilityExecutionContext,
): Promise<NonNullable<typeof call.input.assignments>> {
  const outline = (await readCapabilityOutlineBaseline(context.working)).outline
  const targets = buildWritableSectionWorklist(outline).filter(section => context.sectionIds === null
    || context.sectionIds.has(section.id))
  const blocks = []
  for (const id of call.input.source_section_ids) {
    if (context.sectionIds !== null && !context.sectionIds.has(id)) throw new Error('BID_CHAPTER_REUSE_SOURCE_SCOPE_INVALID')
    const location = await readChapterLocation(context.working, id)
    if (location === null) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${id}`)
    const absolute = within(context.working.projectRoot, location.contentPath)
    await assertNoLinkedPath(context.working.root, absolute)
    blocks.push(...indexChapterContentBlocks(id, await readFile(absolute, 'utf8')))
  }
  const subagents = context.agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
    throw new Error('正文块分配需要独立上下文的 spawn provider。')
  }
  const run = await subagents.start('spawn', {
    parent: context.agent, signal: context.run.signal, label: '章节原文分配', maxDepth: 1,
    toolFilter: { allow: [] }, prompt: [{ type: 'text', text: [
      `用户目标：${call.input.instruction}`,
      `源正文完整 Markdown 块：${JSON.stringify(blocks)}`,
      `当前可写目标章节：${JSON.stringify(targets.map(section => ({ id: section.id,
        title: section.title, purpose: section.purpose, must_answer: section.must_answer })))} `,
      '每个源块必须恰好有一个决定。move 指向一个目标；需要共享时显式用 share；只有用户明确允许删减时才可用 delete。',
      '保留表格、代码块、图片及流程图 anchor 的整块内容；流程图引用须与 anchor 同章。不得重写原文或猜测章节 ID。',
      '不得写文件。最终只返回原始 JSON 数组，格式为：',
      JSON.stringify(zodJsonSchema(z.array(chapterBlockAssignmentSchema))),
    ].join('\n') }],
  })
  try {
    const result = await run.result
    context.run.signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`BID_CHAPTER_REUSE_ASSIGNMENT_FAILED: ${result.stopReason}`)
    return z.array(chapterBlockAssignmentSchema).parse(JSON.parse(
      result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    ) as unknown)
  } finally { await run.dispose() }
}

async function refinedOutlineInput(
  call: Extract<OutlineCall, { capability: 'outline.refine' }>, context: BidCapabilityExecutionContext,
): Promise<Extract<BidCapabilityCall, { capability: 'outline.update' }>['input']> {
  const workspace = context.working
  const baseline = await readCapabilityOutlineBaseline(workspace)
  const sectionIds = context.sectionIds === null
    ? baseline.outline.sections.filter(section => section.parent_id === null).map(section => section.id)
    : [...context.sectionIds]
  const operations = await generateScopedOutlineOperations(
    context.agent, baseline, sectionIds, call.input.feedback, context.run.signal,
  )
  const candidate = await previewCapabilityOutline(workspace, operations, context.stepId)
  let businessBindings: Extract<BidCapabilityCall, { capability: 'outline.update' }>['input']['business_bindings'] = []
  if (operations.some(operation => ['split_section', 'add_section', 'merge_sections'].includes(operation.type))) {
    const [requirements, scoring, compliance, catalog] = await Promise.all([
      optionalJson(workspace, 'analysis/requirements.json'), optionalJson(workspace, 'analysis/scoring.json'),
      optionalJson(workspace, 'analysis/compliance.json'), optionalJson(workspace, 'analysis/scoring-response-points.json'),
    ])
    const facts = {
      requirements: parseTenderRequirementsArtifact(requirements).requirements.map(item => ({
        id: item.id, text: item.normalized_requirement,
      })),
      scoring: parseTenderScoringArtifact(scoring).scoring_items.map(item => ({ id: item.id, text: item.criterion })),
      compliance: parseTenderComplianceArtifact(compliance).compliance_items.map(item => ({
        id: item.id, text: item.normalized_rule,
      })),
      response_points: parseScoringResponsePointCatalog(catalog).points.map(item => ({
        id: item.id, scoring_id: item.scoring_id, text: item.text,
      })),
    }
    businessBindings = await generateScopedOutlineBusinessBindings(
      context.agent, candidate, sectionIds, facts, call.input.feedback, context.run.signal,
    )
  }
  const parsed = bidCapabilityInputSchema.parse({ capability: 'outline.update', input: {
    operations, business_bindings: businessBindings, content_assignments: [],
    allow_content_deletion: false, defer_content_migration: true,
  } })
  if (parsed.capability !== 'outline.update') throw new Error('BID_OUTLINE_REFINEMENT_CALL_INVALID')
  return parsed.input
}

/**
 * 在独立步骤候选中应用目录或原文迁移，并返回可由 Host 核验的实际结果。
 * @param call 已解析的能力参数。
 * @param context Host 执行身份。
 * @returns 本步骤结果。
 */
export async function executeOutlineCapability(
  call: OutlineCall, context: BidCapabilityExecutionContext,
): Promise<{ readonly result: BidCapabilityResult }> {
  const outcome = call.capability === 'outline.update'
    ? await executeCapabilityOutlineUpdate(context, call.input)
    : call.capability === 'outline.refine'
      ? await executeCapabilityOutlineUpdate(context, await refinedOutlineInput(call, context))
      : await executeCapabilityChapterReorganize(context, { ...call.input,
        assignments: call.input.assignments ?? await generateChapterAssignments(call, context) })
  return { result: {
    target_section_ids: [...outcome.targetSectionIds], changed_artifacts: [...outcome.changedPaths],
    change_summary: call.capability === 'chapter.reorganize' ? '已按原文块迁移章节草稿' : '已协调目录与受影响章节产物',
    warnings: outcome.deletedBlockIds.map(id => `用户授权删减原文块 ${id}`),
    missing_topics: [...outcome.missingTopics], needs_input: false,
  } }
}

/**
 * 核对候选目录、确认记录、写作索引和迁移草稿属于同一当前目录。
 * @param context 当前独立步骤候选。
 * @param result 执行器申报的精确文件结果。
 */
export async function validateOutlineCapability(
  context: BidCapabilityExecutionContext, result: BidCapabilityResult,
): Promise<void> {
  const workspace = context.working
  const confirmedRaw = await optionalJson(workspace, 'outline/confirmed-outline.json')
  const draftRaw = await optionalJson(workspace, 'outline/draft.json')
  const outline = confirmedRaw === undefined
    ? parseOutlineDraft(draftRaw).outline : parseOutlineArtifact(confirmedRaw)
  const hash = outlineArtifactSha256(outline)
  const leafIds = new Set(buildWritableSectionWorklist(outline).map(section => section.id))
  if (result.target_section_ids.some(id => !outline.sections.some(section => section.id === id))) {
    throw new Error('BID_OUTLINE_CAPABILITY_RESULT_TARGET_INVALID')
  }
  if (result.changed_artifacts.includes('outline/confirmed-outline.json')) {
    const draft = parseOutlineDraft(draftRaw)
    const confirmation = parseOutlineConfirmationArtifact(await optionalJson(workspace, 'outline/confirmation.json'))
    if (draft.draft_outline_sha256 !== hash || draft.source_outline_sha256 !== hash
      || confirmation.confirmed_outline_sha256 !== hash || confirmation.confirmed_draft_sha256 !== hash
      || confirmation.confirmed_draft_revision !== draft.revision
      || confirmation.authorization?.source !== 'user_task'
      || confirmation.authorization.work_id !== context.rootWorkId
      || confirmation.authorization.message_id !== context.authorization.message_id) {
      throw new Error('BID_OUTLINE_CAPABILITY_CONFIRMATION_MISMATCH')
    }
  }
  const evidenceRaw = await optionalJson(workspace, 'analysis/evidence-map.json')
  if (evidenceRaw !== undefined && validateSectionEvidenceCoverage(outline, parseEvidenceMapArtifact(evidenceRaw)).length > 0) {
    throw new Error('BID_OUTLINE_CAPABILITY_EVIDENCE_INDEX_INVALID')
  }
  const writingRaw = await optionalJson(workspace, 'chapters/writing-plan.json')
  if (writingRaw !== undefined) {
    const plan = parseWritingPlan(writingRaw)
    if (plan.confirmed_outline_sha256 !== hash
      || validateWritingPlan(plan, outline).length > 0) {
      throw new Error('BID_OUTLINE_CAPABILITY_WRITING_PLAN_INVALID')
    }
    const executionPlanRaw = await optionalJson(workspace, 'chapters/execution-plan.json')
    if (executionPlanRaw !== undefined && validateChapterExecutionPlan(
      parseChapterExecutionPlan(executionPlanRaw), outline, hash, plan.plan_version,
    ).length > 0) throw new Error('BID_OUTLINE_CAPABILITY_EXECUTION_PLAN_INVALID')
  }
  const logRaw = await optionalJson(workspace, 'chapters/execution-log.json')
  if (logRaw !== undefined) {
    const log = parseOrMigrateChapterExecutionLog(logRaw)
    if (log.confirmed_outline_sha256 !== hash
      || log.sections.length !== leafIds.size || log.sections.some(section => !leafIds.has(section.section_id))) {
      throw new Error('BID_OUTLINE_CAPABILITY_EXECUTION_LOG_INVALID')
    }
  }
  const manifestRaw = await optionalJson(workspace, 'chapters/manifest.json')
  if (manifestRaw !== undefined) {
    const manifest = parseChapterWritingManifest(manifestRaw)
    const completed = new Set(logRaw === undefined ? [] : parseOrMigrateChapterExecutionLog(logRaw).sections
      .filter(section => section.status === 'completed').map(section => section.section_id))
    if (manifest.confirmed_outline_sha256 !== hash || manifest.chapters.some(entry => !leafIds.has(entry.section_id)
      || !completed.has(entry.section_id))) throw new Error('BID_OUTLINE_CAPABILITY_MANIFEST_INVALID')
  }
  const seedsRaw = await optionalJson(workspace, 'chapters/reuse-seeds.json')
  if (seedsRaw !== undefined) {
    const seeds = chapterReuseSeedsSchema.parse(seedsRaw)
    if (seeds.confirmed_outline_sha256 !== hash || seeds.seeds.some(seed => !leafIds.has(seed.section_id))) {
      throw new Error('BID_OUTLINE_CAPABILITY_SEEDS_INVALID')
    }
    for (const seed of seeds.seeds) {
      const contentPath = within(workspace.projectRoot, seed.content_path)
      const metadataPath = within(workspace.projectRoot, seed.metadata_path)
      await assertNoLinkedPath(workspace.root, contentPath)
      await assertNoLinkedPath(workspace.root, metadataPath)
      const markdown = await readFile(contentPath, 'utf8')
      const metadata = parseChapterMetadata(JSON.parse(await readFile(metadataPath, 'utf8')) as unknown)
      if (metadata.section_id !== seed.section_id
        || createHash('sha256').update(markdown).digest('hex') !== seed.content_sha256
        || validateFlowchartAnchors(markdown, metadata.flowcharts).length > 0) {
        throw new Error(`BID_OUTLINE_CAPABILITY_SEED_MISMATCH: ${seed.section_id}`)
      }
    }
  }
  const reassignmentRaw = await optionalJson(workspace, 'outline/reassignment.json')
  if (reassignmentRaw !== undefined
    && outlineReassignmentSchema.parse(reassignmentRaw).confirmed_outline_sha256 !== hash) {
    throw new Error('BID_OUTLINE_CAPABILITY_REASSIGNMENT_INVALID')
  }
}
