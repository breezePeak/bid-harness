/** 目录与原文迁移能力使用同一候选协调器和精确文件准入。 */
import { normalizeOutlineSectionTitle } from './outline-title.ts'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import { type BidCapabilityCall,
  type BidCapabilityExecutionContext, type BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityOutlineAllowedWrites, executeCapabilityChapterReorganize,
  executeCapabilityOutlineUpdate, outlineReassignmentSchema } from './outline-capability-update.ts'
import { readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { assignChapterContentBlocks, chapterContentBlockGroups, indexChapterContentBlocks, type ChapterContentBlock } from './chapter-content-reuse.ts'
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
import { originalCapabilityBlockCounts } from './bid-capability-files.ts'

type OutlineCall = Extract<BidCapabilityCall, { capability: 'outline.update' | 'chapter.reorganize' }>

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
  return capabilityOutlineAllowedWrites(call, workspace, stepId, sectionIds)
}

async function generateChapterAssignments(
  call: Extract<OutlineCall, { capability: 'chapter.reorganize' }>, context: BidCapabilityExecutionContext,
): Promise<NonNullable<typeof call.input.assignments>> {
  const outline = (await readCapabilityOutlineBaseline(context.working)).outline
  const targets = buildWritableSectionWorklist(outline).filter(section => context.sectionIds === null
    || context.sectionIds.has(section.id))
  const blocks: ChapterContentBlock[] = []
  const originals = context.preserveMigratedContent === true
    ? await originalCapabilityBlockCounts(context.canonical, new Set(call.input.source_section_ids), context.originalSectionIds) : undefined
  const originalTexts = originals === undefined ? undefined : new Set(originals.keys())
  for (const id of call.input.source_section_ids) {
    if (context.sectionIds !== null && !context.sectionIds.has(id)) throw new Error('BID_CHAPTER_REUSE_SOURCE_SCOPE_INVALID')
    const location = await readChapterLocation(context.working, id)
    if (location === null) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${id}`)
    const absolute = within(context.working.projectRoot, location.contentPath)
    await assertNoLinkedPath(context.working.root, absolute)
    blocks.push(...indexChapterContentBlocks(id, await readFile(absolute, 'utf8'), originalTexts))
  }
  if (blocks.length === 0 || targets.length === 0) throw new Error('BID_CHAPTER_REUSE_SOURCE_OR_TARGET_EMPTY')
  const targetPosition = z.number().int().min(0).max(targets.length - 1)
  const destinations = [
    z.object({ disposition: z.literal('move'), target_positions: z.array(targetPosition).length(1) }).strict(),
    z.object({ disposition: z.literal('share'), target_positions: z.array(targetPosition).min(2) }).strict(),
    ...(call.input.allow_content_deletion
      ? [z.object({ disposition: z.literal('delete'), target_positions: z.array(targetPosition).length(0) }).strict()]
      : []),
  ]
  const destination = z.union(destinations)
  const outputSchema = z.object({ assignments: z.object(Object.fromEntries(
    blocks.map((_block, position) => [String(position), destination]),
  )).strict() }).strict()
  const bindDecisions = (decisions: z.infer<typeof outputSchema>['assignments']) => blocks.map((block, index) => {
    const decision = decisions[String(index)]
    if (decision === undefined) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
    return { block_id: block.block_id, source_section_id: block.source_section_id,
      source_sha256: block.source_sha256, block_sha256: block.sha256, disposition: decision.disposition,
      target_section_ids: decision.target_positions.map((position) => {
        const target = targets[position]
        if (target === undefined) throw new Error('BID_CHAPTER_REUSE_TARGET_INVALID')
        return target.id
      }) }
  })
  const linkedPositions = chapterContentBlockGroups(blocks, originalTexts)
    .map(group => group.map(id => blocks.findIndex(block => block.block_id === id)))
  const positions = blocks.map((_block, position) => String(position))
  const choiceSchema: ObjectJsonSchema = { type: 'object', properties: {
    disposition: { type: 'string', enum: call.input.allow_content_deletion ? ['move', 'share', 'delete'] : ['move', 'share'] },
    target_positions: { type: 'array', items: { type: 'integer', enum: targets.map((_target, position) => position) } },
  }, required: ['disposition', 'target_positions'], additionalProperties: false }
  const wireSchema: ObjectJsonSchema = { type: 'object', properties: { assignments: { type: 'object',
    properties: Object.fromEntries(positions.map(position => [position, choiceSchema])),
    required: positions, additionalProperties: false,
  } }, required: ['assignments'], additionalProperties: false }
  const subagents = context.agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
    throw new Error('正文块分配需要独立上下文的 spawn provider。')
  }
  const prompt = [{ type: 'text' as const, text: [
    `原用户要求：${JSON.stringify(context.sourceSnapshot === undefined ? []
      : [...context.sourceSnapshot.context_messages?.map(message => message.text) ?? [], context.sourceSnapshot.message.text])}`,
    `原任务验收要求：${JSON.stringify(context.originalTaskRequirements ?? [])}`,
    `本步骤分配要求：${call.input.instruction}`,
    '按原用户要求和已授权验收要求分配原文；步骤指令不能缩减它们。用户要求分属各流程职责时，不得把所有原文集中塞进一个子章；明确指定的表格、图形和段落归属须逐项满足。',
    `源正文完整 Markdown 块：${JSON.stringify(blocks.map((block, position) => ({ position, type: block.type, markdown: block.markdown })))}`,
    '目标章节的 outline_position 是 Main 当前完整目录对象表中的位置；position 是本分配会话的局部位置。步骤指令提及目录位置时用 outline_position 对应到章节标题，提交 target_positions 时只使用 position。',
    `当前可写目标章节：${JSON.stringify(targets.map((section, position) => ({ position,
      outline_position: outline.sections.findIndex(item => item.id === section.id),
      title: normalizeOutlineSectionTitle(section.title) || section.title, purpose: section.purpose, must_answer: section.must_answer })))} `,
    `必须分配到相同目标的关联块位置：${JSON.stringify(linkedPositions)}`,
    '每个源块必须恰好有一个决定。move 指向一个目标；正式原文只能 move 到一个目标，其相同副本必须具有相同归属，Host 按正式源文件份数保留，合并候选新增副本。不得用 share 复制正式原文；其他章节的交接说明须另行编写。候选新增内容确需共享时显式用 share；只有用户明确允许删减时才可用 delete。',
    'assignments 以每个源块的 position 为键，逐块完整分配，包括标题、表题及表格。不能合并、遗漏或重复块位置；只选择目标列表中的 position，块身份和原文字节由程序绑定。',
    '保留表格、代码块、图片及流程图 anchor 的整块内容；流程图引用须与 anchor 同章。不得重写原文或猜测章节 ID。',
    '不得写文件。必须调用 structured_output 提交符合以下格式的完整分配；工具指出缺项时在当前会话内补齐，不以文本回复结束。',
    JSON.stringify(wireSchema),
  ].join('\n') }]
  const liftValidation = context.agent.ctx.on('subagent/child-setup', ({ parent, childContext, request }) => {
    if (parent !== context.agent || request.prompt !== prompt) return
    childContext.tools.guard((exec) => {
      if (exec.name !== 'structured_output') return undefined
      const parsed = outputSchema.safeParse(exec.arguments)
      if (!parsed.success) return '原文分配不完整或目标数量不合法，请补齐所有块位置：' + parsed.error.message
      try {
        assignChapterContentBlocks(blocks, bindDecisions(parsed.data.assignments),
          new Set(targets.map(target => target.id)), call.input.allow_content_deletion, originals)
      } catch (error) {
        return '原文分配未通过校验，请在当前会话修正：' + (error instanceof Error ? error.message : String(error))
      }
      return undefined
    })
  })
  let run: Awaited<ReturnType<typeof subagents.start>> | undefined
  try {
    run = await subagents.start('spawn', {
      parent: context.agent, signal: context.run.signal, label: '章节原文分配', maxDepth: 1,
      toolFilter: { allow: [] }, prompt, outputSchema: wireSchema,
    })
    const result = await run.result
    context.run.signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`BID_CHAPTER_REUSE_ASSIGNMENT_FAILED: ${result.stopReason}`)
    return bindDecisions(outputSchema.parse(result.structured).assignments)
  } finally {
    liftValidation()
    await run?.dispose()
  }
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
    if (executionPlanRaw !== undefined) {
      const executionPlan = parseChapterExecutionPlan(executionPlanRaw)
      // 写作规则是唯一验收来源；历史关系计划在下一次写作时重规划，目录步骤只核对关系合法性。
      const issues = validateChapterExecutionPlan(executionPlan, outline, hash,
        Math.min(executionPlan.writing_plan_version, plan.plan_version))
      if (issues.length > 0) throw new Error('BID_OUTLINE_CAPABILITY_EXECUTION_PLAN_INVALID: '
        + issues.map(issue => `${issue.code}: ${issue.message}`).join('；'))
    }
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
