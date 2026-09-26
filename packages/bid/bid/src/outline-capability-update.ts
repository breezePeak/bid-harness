/** 局部目录任务在一个候选项目中协调结构、业务归属和已有正文。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidCapabilityCall, BidCapabilityExecutionContext } from './bid-capability-contract.ts'
import { outlineArtifactSha256, parseOutlineDraft } from './outline-confirmation-artifacts.ts'
import { applyOutlineBusinessBindings, applyOutlineEdits, parseOutlineEditOperations } from './outline-confirmation-edits.ts'
import { readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import { parseOutlineArtifact, type OutlineArtifact } from './outline-generation-artifacts.ts'
import { validateOutlineDraftForConfirmation } from './outline-confirmation-validator.ts'
import { generateScopedOutlineBusinessBindings } from './outline-generation-executor.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseEvidenceMapArtifact, sectionEvidenceMappingSchema } from './evidence-mapping-artifacts.ts'
import { changedWritableSectionIds, reconcileSectionEvidence, buildWritableSectionWorklist } from './section-evidence-context.ts'
import { nextCriterionId, parseWritingPlan, writingPlanSchema, type WritingPlan } from './writing-requirements.ts'
import { parseChapterExecutionPlan, parseOrMigrateChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { chapterWritingManifestSchema, parseChapterWritingManifest, parseChapterMetadata } from './chapter-writing-artifacts.ts'
import { planChapterLocations, readChapterLocation } from './chapter-storage.ts'
import { assignChapterContentBlocks, chapterReuseSeedsSchema, indexChapterContentBlocks, reuseChapterMetadata,
  type ChapterContentBlock } from './chapter-content-reuse.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { z } from 'zod'

type OutlineUpdate = Extract<BidCapabilityCall, { capability: 'outline.update' }>['input']
type ChapterReorganize = Extract<BidCapabilityCall, { capability: 'chapter.reorganize' }>['input']
type OutlineCapabilityCall = Extract<BidCapabilityCall, { capability: 'outline.update' | 'chapter.reorganize' }>
const pendingReorganizationSchema = z.object({
  schema_version: z.literal(1), pending_source_section_ids: z.array(z.string().min(1)),
}).strict()

/**
 * 读取尚未分配的旧章节正文身份。
 * @param workspace 正式项目或任务候选。
 * @returns 没有迁移记录时返回空集合。
 */
export async function readPendingChapterReorganization(workspace: BidWorkspace): Promise<readonly string[]> {
  const raw = await optionalJson(workspace, 'chapters/pending-reorganization.json')
  return raw === undefined ? [] : pendingReorganizationSchema.parse(raw).pending_source_section_ids
}

/** 保留退役章节的计划、资料和审核归属，供后续业务重新分配。 */
export const outlineReassignmentSchema = z.object({
  schema_version: z.literal(1),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  retired_sections: z.array(z.object({
    source_section_id: z.string().min(1),
    target_section_ids: z.array(z.string().min(1)),
    writing_task: writingPlanSchema.shape.sections.element.optional(),
    evidence_mapping: sectionEvidenceMappingSchema.optional(),
    manifest_entry: chapterWritingManifestSchema.shape.chapters.element.optional(),
  }).strict()),
}).strict()

async function optionalJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function requiredJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const value = await optionalJson(workspace, path)
  if (value === undefined) throw new Error(`BID_OUTLINE_CAPABILITY_INPUT_MISSING: ${path}`)
  return value
}

async function optionalMarkdown(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function capabilitySectionAllocator(stepId: string, existing: readonly string[]): () => string {
  const base = createHash('sha256').update(stepId).digest('hex').slice(0, 12)
  const used = new Set(existing)
  let next = 0
  return () => {
    let id: string
    do { id = `SEC-${base}-${String(++next)}` } while (used.has(id))
    used.add(id)
    return id
  }
}

/**
 * 使用正式执行时的同一 Host ID 分配方式预览结构候选。
 * @param workspace 当前 Work 候选。
 * @param operations 已解析的结构操作。
 * @param stepId Host 步骤身份。
 * @returns 仅在内存中构造的目录。
 */
export async function previewCapabilityOutline(
  workspace: BidWorkspace, operations: unknown, stepId: string,
): Promise<OutlineArtifact> {
  const base = await readCapabilityOutlineBaseline(workspace)
  return applyOutlineEdits(base.outline, parseOutlineEditOperations(operations),
    capabilitySectionAllocator(stepId, base.outline.sections.map(section => section.id)))
}

function synchronizeWritingPlan(plan: WritingPlan, outline: OutlineArtifact, hash: string,
  affected: ReadonlySet<string>): WritingPlan {
  const old = new Map(plan.sections.map(section => [section.section_id, section]))
  const nextId = nextCriterionId(plan)
  return parseWritingPlan({ ...plan, plan_version: plan.plan_version + 1,
    confirmed_outline_sha256: hash,
    sections: buildWritableSectionWorklist(outline).map(section => old.get(section.id) ?? {
      section_id: section.id, task: section.purpose, user_message_refs: [], user_requirements: [],
      writing_instructions: section.writing_notes,
      acceptance_criteria: [{ id: nextId(), scope: { kind: 'section', section_id: section.id },
        description: `完成“${section.title}”的章节任务：${section.purpose}`,
        priority: 'required', evaluator: { kind: 'semantic' } }],
    }),
    revision: { summary: '目录变更后的章节任务对齐', affected_section_ids: [...affected],
      base_plan_version: plan.plan_version },
  })
}

/**
 * 局部目录修改和原文迁移只写当前步骤候选；Work 完成后才正式发布。
 * @param context 当前步骤的 Host 身份和候选项目。
 * @param input 结构操作、业务归属和源块分配。
 * @returns 本步真实文件集合、新章节身份与后续待完成事项。
 */
export async function executeCapabilityOutlineUpdate(
  context: BidCapabilityExecutionContext, input: OutlineUpdate,
): Promise<{
  readonly changedPaths: readonly string[]
  readonly targetSectionIds: readonly string[]
  readonly newSectionIds: ReadonlySet<string>
  readonly missingTopics: readonly string[]
  readonly deletedBlockIds: readonly string[]
}> {
  const workspace = context.working
  const base = await readCapabilityOutlineBaseline(workspace)
  const old = base.outline
  const analysis = await Promise.all([
    requiredJson(workspace, 'analysis/requirements.json'), requiredJson(workspace, 'analysis/scoring.json'),
    requiredJson(workspace, 'analysis/compliance.json'), requiredJson(workspace, 'analysis/scoring-response-points.json'),
  ])
  const requirements = parseTenderRequirementsArtifact(analysis[0])
  const scoring = parseTenderScoringArtifact(analysis[1])
  const compliance = parseTenderComplianceArtifact(analysis[2])
  const catalog = parseScoringResponsePointCatalog(analysis[3])
  const oldIds = new Set(old.sections.map(section => section.id))
  if (context.sectionIds !== null) {
    for (const operation of input.operations) {
      const sourceIds = operation.type === 'merge_sections' ? operation.section_ids
        : operation.type === 'add_section' ? operation.parent_id === null ? [] : [operation.parent_id]
          : [operation.section_id]
      if (sourceIds.length === 0 || sourceIds.some(id => !context.sectionIds?.has(id))
        || operation.type === 'move_section' && operation.parent_id !== null
          && !context.sectionIds.has(operation.parent_id)) {
        throw new Error('BID_OUTLINE_CAPABILITY_SCOPE_INVALID')
      }
    }
  }
  const allocator = capabilitySectionAllocator(context.stepId, [...oldIds])
  const structural = applyOutlineEdits(old, parseOutlineEditOperations(input.operations), allocator)
  const bindings = input.business_bindings.length === 0
    && input.operations.some(operation => ['split_section', 'add_section'].includes(operation.type))
    ? await generateScopedOutlineBusinessBindings(context.agent, structural,
      context.sectionIds === null ? structural.sections.filter(section => section.parent_id === null).map(section => section.id)
        : [...context.sectionIds], {
        requirements: requirements.requirements.map(item => ({ id: item.id, text: item.normalized_requirement })),
        scoring: scoring.scoring_items.map(item => ({ id: item.id, text: item.criterion })),
        compliance: compliance.compliance_items.map(item => ({ id: item.id, text: item.normalized_rule })),
        response_points: catalog.points.map(item => ({ id: item.id, scoring_id: item.scoring_id, text: item.text })),
      }, JSON.stringify(input.operations), context.run.signal)
    : input.business_bindings
  const outline = parseOutlineArtifact(applyOutlineBusinessBindings(structural, bindings,
    requirements, scoring, compliance, catalog))
  const validation = validateOutlineDraftForConfirmation(outline, requirements, scoring, compliance, catalog)
  if (!validation.ok) throw new Error(`BID_OUTLINE_CAPABILITY_INVALID: ${validation.issues.map(issue => issue.code).join(',')}`)
  return coordinateCapabilityOutline(context, old, outline, { ...input, business_bindings: bindings }, new Set())
}

/**
 * 资料研究更新章节写作说明后，沿用目录任务的确认哈希和章节索引协调。
 * @param context 当前步骤候选与真实用户任务身份。
 * @param outline 研究完成并已通过资料校验的目录候选。
 * @param researchedIds 本轮已完成资料研究的叶节。
 * @returns 精确协调文件及仍待完成的正文任务。
 */
export async function adoptCapabilityResearchedOutline(
  context: BidCapabilityExecutionContext, outline: OutlineArtifact, researchedIds: ReadonlySet<string>,
): ReturnType<typeof executeCapabilityOutlineUpdate> {
  const workspace = context.working
  const old = (await readCapabilityOutlineBaseline(workspace)).outline
  const facts = await Promise.all([
    requiredJson(workspace, 'analysis/requirements.json'), requiredJson(workspace, 'analysis/scoring.json'),
    requiredJson(workspace, 'analysis/compliance.json'), requiredJson(workspace, 'analysis/scoring-response-points.json'),
  ])
  const validation = validateOutlineDraftForConfirmation(outline,
    parseTenderRequirementsArtifact(facts[0]), parseTenderScoringArtifact(facts[1]),
    parseTenderComplianceArtifact(facts[2]), parseScoringResponsePointCatalog(facts[3]))
  if (!validation.ok) throw new Error(`BID_OUTLINE_CAPABILITY_INVALID: ${validation.issues.map(issue => issue.code).join(',')}`)
  const before = new Map(old.sections.map(section => [section.id, section]))
  const changed = outline.sections.filter(section => JSON.stringify(before.get(section.id)) !== JSON.stringify(section))
  if (JSON.stringify({ ...old, sections: [] }) !== JSON.stringify({ ...outline, sections: [] })
    || outline.sections.length !== old.sections.length
    || changed.some((section) => {
      const previous = before.get(section.id)
      return previous === undefined || previous.parent_id !== section.parent_id || previous.order !== section.order
        || previous.title !== section.title || previous.writable !== section.writable
        || context.sectionIds !== null && !context.sectionIds.has(section.id)
    }) || [...researchedIds].some(id => !outline.sections.some(section => section.id === id && section.writable))) {
    throw new Error('BID_EVIDENCE_RESEARCH_OUTLINE_SCOPE_INVALID')
  }
  return coordinateCapabilityOutline(context, old, outline, {
    operations: [], business_bindings: [], content_assignments: [], allow_content_deletion: false,
    defer_content_migration: false,
  }, researchedIds)
}

async function coordinateCapabilityOutline(
  context: BidCapabilityExecutionContext, old: OutlineArtifact, outline: OutlineArtifact,
  input: OutlineUpdate, researchedIds: ReadonlySet<string>,
): ReturnType<typeof executeCapabilityOutlineUpdate> {
  const workspace = context.working
  const base = await readCapabilityOutlineBaseline(workspace)
  const oldIds = new Set(old.sections.map(section => section.id))
  const newIds = new Set(outline.sections.filter(section => !oldIds.has(section.id)).map(section => section.id))
  if (context.sectionIds !== null && input.business_bindings.some(binding => !context.sectionIds?.has(binding.section_id)
    && !newIds.has(binding.section_id))) throw new Error('BID_OUTLINE_CAPABILITY_SCOPE_INVALID')
  const hash = outlineArtifactSha256(outline)
  const outlineChanged = hash !== outlineArtifactSha256(old)
  const newLeaves = buildWritableSectionWorklist(outline)
  const newLeafIds = new Set(newLeaves.map(section => section.id))
  const oldLeaves = buildWritableSectionWorklist(old)
  const migrated = new Map<string, {
    markdown: string
    metadata: ReturnType<typeof parseChapterMetadata>
    sources: string[]
  }>()
  let deletedBlockIds: readonly string[] = []
  if (input.content_assignments.length > 0) {
    if (context.sectionIds !== null && input.content_assignments.some(item => !context.sectionIds?.has(item.source_section_id))) {
      throw new Error('BID_CHAPTER_REUSE_SOURCE_SCOPE_INVALID')
    }
    if (context.sectionIds !== null && input.content_assignments.some(item => item.target_section_ids.some(
      id => !context.sectionIds?.has(id) && !newIds.has(id),
    ))) throw new Error('BID_CHAPTER_REUSE_TARGET_SCOPE_INVALID')
    const sourceIds = new Set(input.content_assignments.map(item => item.source_section_id))
    const sourceBlocks: ChapterContentBlock[] = []
    const sourceMetadata = new Map<string, ReturnType<typeof parseChapterMetadata>>()
    for (const sourceId of sourceIds) {
      if (!oldIds.has(sourceId)) throw new Error(`BID_CHAPTER_REUSE_SOURCE_INVALID: ${sourceId}`)
      const location = await readChapterLocation(workspace, sourceId)
      if (location === null) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${sourceId}`)
      const markdown = await readFile(within(workspace.projectRoot, location.contentPath), 'utf8')
      sourceBlocks.push(...indexChapterContentBlocks(sourceId, markdown))
      sourceMetadata.set(sourceId, parseChapterMetadata(await requiredJson(workspace, location.metadataPath)))
    }
    const distribution = assignChapterContentBlocks(sourceBlocks, input.content_assignments,
      newLeafIds, input.allow_content_deletion)
    deletedBlockIds = distribution.deletedBlockIds
    for (const sourceId of sourceIds) {
      if (newLeafIds.has(sourceId) && !distribution.markdownBySectionId.has(sourceId)) {
        throw new Error(`BID_CHAPTER_REUSE_EMPTY_SOURCE_REQUIRES_OUTLINE_CHANGE: ${sourceId}`)
      }
    }
    for (const [id, markdown] of distribution.markdownBySectionId) {
      const target = newLeaves.find(section => section.id === id)
      if (target === undefined) throw new Error(`BID_CHAPTER_REUSE_TARGET_INVALID: ${id}`)
      const sources = [...new Set(input.content_assignments.filter(item => item.target_section_ids.includes(id))
        .map(item => item.source_section_id))]
      if (!sourceIds.has(id) && oldIds.has(id)) {
        const existing = await readChapterLocation(workspace, id)
        if (existing !== null && await optionalMarkdown(workspace, existing.contentPath) !== undefined) {
          throw new Error(`BID_CHAPTER_REUSE_TARGET_BODY_NOT_ALLOCATED: ${id}`)
        }
      }
      const metadata = reuseChapterMetadata(target, markdown, sources.map((source) => {
        const value = sourceMetadata.get(source)
        if (value === undefined) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${source}`)
        return value
      }))
      migrated.set(id, { markdown, metadata, sources })
    }
  }
  const pendingSources: string[] = []
  for (const section of oldLeaves) {
    if (newLeafIds.has(section.id)) continue
    const location = await readChapterLocation(workspace, section.id)
    if (location !== null && await optionalMarkdown(workspace, location.contentPath) !== undefined
      && !input.content_assignments.some(item => item.source_section_id === section.id)) {
      if (!input.defer_content_migration) throw new Error(`BID_CHAPTER_REUSE_UNALLOCATED_SOURCE: ${section.id}`)
      pendingSources.push(section.id)
    }
  }
  const previousPendingRaw = await optionalJson(workspace, 'chapters/pending-reorganization.json')
  const previousPending = previousPendingRaw === undefined ? []
    : pendingReorganizationSchema.parse(previousPendingRaw).pending_source_section_ids
  const assignedSources = new Set(input.content_assignments.map(item => item.source_section_id))
  const unresolvedSources = [...new Set([...previousPending.filter(id => !assignedSources.has(id)), ...pendingSources])]
  const affected = new Set(changedWritableSectionIds(old, outline))
  for (const id of migrated.keys()) affected.add(id)
  const reassignedSourceIds = new Set(input.content_assignments.map(item => item.source_section_id))
  for (const id of reassignedSourceIds) if (newLeafIds.has(id)) affected.add(id)
  const oldLeafById = new Map(oldLeaves.map(section => [section.id, section]))
  const staleReview = new Set(newLeaves.filter((section) => {
    const previous = oldLeafById.get(section.id)
    return previous === undefined || migrated.has(section.id) || reassignedSourceIds.has(section.id) || JSON.stringify({
      title: previous.title, purpose: previous.purpose, must_answer: previous.must_answer,
      requirement_ids: previous.requirement_ids, scoring_ids: previous.scoring_ids,
      scoring_response_point_ids: previous.scoring_response_point_ids,
      compliance_ids: previous.compliance_ids, writing_notes: previous.writing_notes,
    }) !== JSON.stringify({
      title: section.title, purpose: section.purpose, must_answer: section.must_answer,
      requirement_ids: section.requirement_ids, scoring_ids: section.scoring_ids,
      scoring_response_point_ids: section.scoring_response_point_ids,
      compliance_ids: section.compliance_ids, writing_notes: section.writing_notes,
    })
  }).map(section => section.id))
  const storage = await planChapterLocations(workspace, newLeaves.map(section => section.id))
  const changed = new Set<string>()
  const writingRaw = await optionalJson(workspace, 'chapters/writing-plan.json')
  const writing = writingRaw === undefined || !outlineChanged ? undefined
    : synchronizeWritingPlan(parseWritingPlan(writingRaw), outline, hash, staleReview)
  const executionRaw = await optionalJson(workspace, 'chapters/execution-log.json')
  const execution = executionRaw === undefined ? undefined : parseOrMigrateChapterExecutionLog(executionRaw)
  const planRaw = await optionalJson(workspace, 'chapters/execution-plan.json')
  const manifestRaw = await optionalJson(workspace, 'chapters/manifest.json')
  const evidenceRaw = await optionalJson(workspace, 'analysis/evidence-map.json')
  const oldLogSections = new Map(execution?.sections.map(section => [section.section_id, section]) ?? [])
  const nextLog = execution === undefined ? undefined : {
    ...execution, confirmed_outline_sha256: hash,
    writing_plan_version: writing?.plan_version ?? execution.writing_plan_version,
    next_storage_serial: storage.nextStorageSerial,
    sections: newLeaves.map((section) => {
      const previous = oldLogSections.get(section.id)
      const location = storage.locations.get(section.id)
      if (location === undefined) throw new Error(`BID_CHAPTER_STORAGE_MISSING: ${section.id}`)
      if (previous !== undefined && !staleReview.has(section.id)) return { ...previous, storage_serial: location.storageSerial }
      return { section_id: section.id, storage_serial: location.storageSerial,
        depends_on: (previous?.depends_on ?? []).filter(id => newLeafIds.has(id)),
        related_sections: (previous?.related_sections ?? []).filter(id => newLeafIds.has(id)),
        epoch: (previous?.epoch ?? -1) + 1, status: 'pending' as const, phase: 'queued' as const,
        failure_phase: null, attempts: [], final_writer_child_session_id: null,
        final_reviewer_child_session_id: null }
    }),
  }
  const oldPlan = planRaw === undefined ? undefined : parseChapterExecutionPlan(planRaw)
  const nextPlan = oldPlan === undefined || !outlineChanged ? undefined : {
    ...oldPlan, confirmed_outline_sha256: hash,
    writing_plan_version: writing?.plan_version ?? oldPlan.writing_plan_version,
    sections: newLeaves.map(section => oldPlan.sections.find(item => item.section_id === section.id) ?? {
      section_id: section.id, depends_on: [], related_sections: [], planning_notes: [],
    }).map(item => ({ ...item, depends_on: item.depends_on.filter(ref => newLeafIds.has(ref.section_id)),
      related_sections: item.related_sections.filter(ref => newLeafIds.has(ref.section_id)) })),
  }
  const manifest = manifestRaw === undefined ? undefined : parseChapterWritingManifest(manifestRaw)
  const nextManifest = manifest === undefined ? undefined : { ...manifest, confirmed_outline_sha256: hash,
    chapters: manifest.chapters.filter(entry => newLeafIds.has(entry.section_id) && !staleReview.has(entry.section_id)) }
  const evidence = evidenceRaw === undefined || !outlineChanged ? undefined : {
    section_mappings: (researchedIds.size > 0 ? parseEvidenceMapArtifact(evidenceRaw).section_mappings
      : reconcileSectionEvidence(outline, parseEvidenceMapArtifact(evidenceRaw)).section_mappings)
      .map(mapping => affected.has(mapping.section_id) && !researchedIds.has(mapping.section_id) ? { ...mapping,
        missing_topics: [...new Set([...mapping.missing_topics, '目录调整后需复核资料适用性'])] } : mapping),
  }
  const draft = parseOutlineDraft({ ...base, source_outline_sha256: hash,
    draft_outline_sha256: hash, outline })
  const priorReassignmentRaw = await optionalJson(workspace, 'outline/reassignment.json')
  const priorReassignment = priorReassignmentRaw === undefined ? []
    : outlineReassignmentSchema.parse(priorReassignmentRaw).retired_sections
  const oldWriting = writingRaw === undefined ? undefined : parseWritingPlan(writingRaw)
  const oldEvidence = evidenceRaw === undefined ? undefined : parseEvidenceMapArtifact(evidenceRaw)
  const retired = oldLeaves.filter(section => !newLeafIds.has(section.id)).map(section => ({
    source_section_id: section.id,
    target_section_ids: [...new Set([
      ...input.content_assignments.filter(item => item.source_section_id === section.id)
        .flatMap(item => item.target_section_ids),
      ...outline.sections.filter(item => item.parent_id === section.id && item.writable).map(item => item.id),
    ])],
    ...(oldWriting?.sections.find(item => item.section_id === section.id) === undefined ? {} : {
      writing_task: oldWriting.sections.find(item => item.section_id === section.id),
    }),
    ...(oldEvidence?.section_mappings.find(item => item.section_id === section.id) === undefined ? {} : {
      evidence_mapping: oldEvidence.section_mappings.find(item => item.section_id === section.id),
    }),
    ...(manifest?.chapters.find(item => item.section_id === section.id) === undefined ? {} : {
      manifest_entry: manifest.chapters.find(item => item.section_id === section.id),
    }),
  }))
  const priorSeedsRaw = await optionalJson(workspace, 'chapters/reuse-seeds.json')
  const priorSeeds = priorSeedsRaw === undefined ? [] : chapterReuseSeedsSchema.parse(priorSeedsRaw).seeds
    .filter(seed => newLeafIds.has(seed.section_id) && !staleReview.has(seed.section_id))
  await context.run.commits.publish(async (lease) => {
    const write = async (path: string, value: unknown): Promise<void> => {
      if (JSON.stringify(await optionalJson(workspace, path)) === JSON.stringify(value)) return
      await lease.writeJson(within(workspace.projectRoot, path), value)
      changed.add(path)
    }
    if (outlineChanged) {
      await write('outline/outline.json', outline)
      await write('outline/draft.json', draft)
      if (await optionalJson(workspace, 'outline/confirmed-outline.json') !== undefined) {
        await write('outline/confirmed-outline.json', outline)
        await write('outline/confirmation.json', {
          schema_version: 2, scope: 'technical_bid', decision: 'confirmed',
          source_outline_sha256: hash, confirmed_outline_sha256: hash,
          confirmed_draft_revision: draft.revision, confirmed_draft_sha256: hash,
          authorization: { source: 'user_task', work_id: context.rootWorkId,
            session_id: context.authorization.session_id, message_id: context.authorization.message_id },
        })
      }
    }
    if (evidence !== undefined) await write('analysis/evidence-map.json', evidence)
    if (retired.length > 0 || priorReassignmentRaw !== undefined) {
      const byId = new Map(priorReassignment.map(item => [item.source_section_id, item]))
      for (const item of retired) byId.set(item.source_section_id, item)
      await write('outline/reassignment.json', outlineReassignmentSchema.parse({
        schema_version: 1, confirmed_outline_sha256: hash, retired_sections: [...byId.values()],
      }))
    }
    if (writing !== undefined) await write('chapters/writing-plan.json', writing)
    if (nextPlan !== undefined) await write('chapters/execution-plan.json', nextPlan)
    if (nextLog !== undefined) await write('chapters/execution-log.json', nextLog)
    if (nextManifest !== undefined) await write('chapters/manifest.json', nextManifest)
    if (unresolvedSources.length > 0 || previousPendingRaw !== undefined) {
      await write('chapters/pending-reorganization.json', pendingReorganizationSchema.parse({
        schema_version: 1, pending_source_section_ids: unresolvedSources,
      }))
    }
    for (const [id, value] of migrated) {
      const location = storage.locations.get(id)
      if (location === undefined) throw new Error(`BID_CHAPTER_STORAGE_MISSING: ${id}`)
      const existing = await readFile(within(workspace.projectRoot, location.contentPath), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (existing !== value.markdown) {
        await lease.writeText(within(workspace.projectRoot, location.contentPath), value.markdown)
        changed.add(location.contentPath)
      }
      await write(location.metadataPath, value.metadata)
    }
    if (migrated.size > 0 || outlineChanged && priorSeedsRaw !== undefined) {
      await write('chapters/reuse-seeds.json', chapterReuseSeedsSchema.parse({
        schema_version: 1, confirmed_outline_sha256: hash,
        seeds: [...priorSeeds, ...[...migrated].map(([id, value]) => {
          const location = storage.locations.get(id)
          if (location === undefined) throw new Error(`BID_CHAPTER_STORAGE_MISSING: ${id}`)
          return { section_id: id, source_section_ids: value.sources,
            content_path: location.contentPath, metadata_path: location.metadataPath,
            content_sha256: createHash('sha256').update(value.markdown).digest('hex') }
        })],
      }))
    }
  })
  const targets = [...new Set([
    ...newIds, ...migrated.keys(), ...staleReview,
    ...input.operations.flatMap(operation => operation.type === 'merge_sections' ? operation.section_ids
      : operation.type === 'add_section' ? operation.parent_id === null ? [] : [operation.parent_id]
        : [operation.section_id]),
  ])].filter(id => outline.sections.some(section => section.id === id))
  return { changedPaths: [...changed], targetSectionIds: targets, newSectionIds: newIds,
    missingTopics: [...staleReview].filter(id => !migrated.has(id)).map(id => `章节 ${id} 的资料与正文任务需复核`)
      .concat(unresolvedSources.map(id => `旧章节 ${id} 的正文尚待分配`)),
    deletedBlockIds }
}

/**
 * 在不改目录结构时重新分配已有章节的完整原文块。
 * @param context 当前步骤候选项目。
 * @param input 真实源章节、原文块分配和删减授权。
 * @returns 精确变更文件和待复核章节。
 */
export async function executeCapabilityChapterReorganize(
  context: BidCapabilityExecutionContext, input: ChapterReorganize & { assignments: NonNullable<ChapterReorganize['assignments']> },
): ReturnType<typeof executeCapabilityOutlineUpdate> {
  const sources = new Set(input.assignments.map(item => item.source_section_id))
  if (sources.size !== input.source_section_ids.length
    || input.source_section_ids.some(id => !sources.has(id)
      || context.sectionIds !== null && !context.sectionIds.has(id))) {
    throw new Error('BID_CHAPTER_REUSE_SOURCE_SCOPE_INVALID')
  }
  return executeCapabilityOutlineUpdate(context, {
    operations: [], business_bindings: [], content_assignments: input.assignments,
    allow_content_deletion: input.allow_content_deletion, defer_content_migration: false,
  })
}

/**
 * 从同一结构算法和存储计划确定本步骤可以写入的精确文件路径。
 * @param call 局部目录或原文迁移能力。
 * @param workspace 当前 Work 候选项目。
 * @param stepId Host 固定的步骤身份。
 * @returns 允许的精确项目相对文件集合。
 * @param sectionIds 允许修改的章节身份集合。
 */
export async function capabilityOutlineAllowedWrites(
  call: OutlineCapabilityCall, workspace: BidWorkspace, stepId: string,
  sectionIds: ReadonlySet<string> | null,
): Promise<ReadonlySet<string>> {
  const outline = call.capability === 'outline.update'
    ? await previewCapabilityOutline(workspace, call.input.operations, stepId)
    : (await readCapabilityOutlineBaseline(workspace)).outline
  const locations = await planChapterLocations(workspace, buildWritableSectionWorklist(outline).map(section => section.id))
  const targets = call.capability === 'outline.update' ? call.input.content_assignments
    : call.input.assignments ?? []
  const paths = new Set<string>(OUTLINE_CAPABILITY_INDEX_PATHS)
  for (const id of new Set(targets.flatMap(item => item.target_section_ids))) {
    const location = locations.locations.get(id)
    if (location === undefined) throw new Error(`BID_CHAPTER_REUSE_TARGET_INVALID: ${id}`)
    paths.add(location.contentPath)
    paths.add(location.metadataPath)
  }
  if (call.capability === 'chapter.reorganize' && call.input.assignments === undefined) {
    for (const section of buildWritableSectionWorklist(outline)) {
      if (sectionIds !== null && !sectionIds.has(section.id)) continue
      const location = locations.locations.get(section.id)
      if (location === undefined) throw new Error(`BID_CHAPTER_STORAGE_MISSING: ${section.id}`)
      paths.add(location.contentPath)
      paths.add(location.metadataPath)
    }
  }
  return paths
}

/** 固定的目录及关联索引候选文件，不包含任何整目录授权。 */
export const OUTLINE_CAPABILITY_INDEX_PATHS = [
  'outline/outline.json', 'outline/draft.json', 'outline/confirmed-outline.json',
  'outline/confirmation.json', 'outline/reassignment.json', 'analysis/evidence-map.json',
  'chapters/writing-plan.json', 'chapters/execution-plan.json', 'chapters/execution-log.json',
  'chapters/manifest.json', 'chapters/reuse-seeds.json', 'chapters/pending-reorganization.json',
] as const
