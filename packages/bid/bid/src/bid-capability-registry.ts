/** 静态能力目录与范围核对；前提描述供主 Agent 选路，Host 检查真实产物。 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import type { BidWorkspace } from './index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BidStage, BidStageTask, StageArtifact, StageValidationResult } from './control-plane-contract.ts'
import type { BidRunContext } from './run-coordinator.ts'
import type { ModelStageExecutionOptions } from './model-stage-repair.ts'
import type { ChapterWritingControl } from './chapter-writing-executor.ts'
import { executeTenderAnalysis } from './tender-analysis-executor.ts'
import { executeOutlineGeneration } from './outline-generation-executor.ts'
import { executeEvidenceMapping } from './evidence-mapping-executor.ts'
import { executeChapterWriting } from './chapter-writing-executor.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { validateChapterWriting } from './chapter-writing-validator.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { validateChapterParagraphReference } from './chapter-revision.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { bidCapabilityResultSchema, type BidCapabilityId, type BidCapabilityResult,
  type BidCapabilityScope, type BidCapabilityStepScope, type BidCapabilityExecutionContext } from './bid-capability-contract.ts'

/** 静态前提只描述实际需要的项目对象，不推导隐藏的能力调用。 */
export const BID_CAPABILITIES: Readonly<Record<BidCapabilityId, {
  readonly requires: readonly string[]
  readonly result: 'artifacts' | 'review' | 'export'
}>> = {
  'tender.analyze': { requires: ['manifest'], result: 'artifacts' },
  'tender.update': { requires: ['analysis/project.json', 'analysis/requirements.json', 'analysis/scoring-origin.json'], result: 'artifacts' },
  'outline.generate': { requires: ['analysis/requirements.json', 'analysis/scoring.json'], result: 'artifacts' },
  'outline.update': { requires: ['outline/confirmed-outline.json'], result: 'artifacts' },
  'outline.refine': { requires: ['outline/confirmed-outline.json', 'analysis/evidence-map.json'], result: 'artifacts' },
  'chapter.reorganize': { requires: ['outline/confirmed-outline.json', 'chapters/execution-log.json'], result: 'artifacts' },
  'evidence.research': { requires: ['outline/confirmed-outline.json'], result: 'artifacts' },
  'writing.plan': { requires: ['outline/confirmed-outline.json'], result: 'artifacts' },
  'chapter.write': { requires: ['outline/confirmed-outline.json', 'chapters/writing-plan.json'], result: 'artifacts' },
  'chapter.revise': { requires: ['outline/confirmed-outline.json', 'chapters/writing-plan.json'], result: 'artifacts' },
  'chapter.review': { requires: ['chapters/execution-log.json'], result: 'review' },
  'document.review': { requires: ['chapters/execution-log.json'], result: 'review' },
  'docx.export': { requires: ['outline/confirmed-outline.json'], result: 'export' },
}

/** 默认路线只选择已有能力；阶段门禁和后继阶段仍由 Orchestrator 管理。 */
export const DEFAULT_BID_STAGE_CAPABILITIES = {
  tender_analysis: 'tender.analyze',
  outline_generation: 'outline.generate',
  evidence_mapping: 'evidence.research',
  chapter_writing: 'chapter.write',
} as const satisfies Partial<Record<BidStage, BidCapabilityId>>

export type DefaultBidCapabilityId = typeof DEFAULT_BID_STAGE_CAPABILITIES[keyof typeof DEFAULT_BID_STAGE_CAPABILITIES]

/** 默认执行所需的 Host 配置和已授权运行身份。 */
export interface DefaultBidCapabilityContext {
  readonly agent: Agent
  readonly workspace: BidWorkspace
  readonly run: BidRunContext
  readonly maxRepairAttempts: number
  readonly evidenceMappingMaxConcurrency: number
  readonly chapterWritingMaxConcurrency: number
  readonly chapterWritingCompletionRepairRounds: number
  readonly webSearchEnabled: boolean
  readonly writingControl: ChapterWritingControl
  readonly recovery?: ModelStageExecutionOptions['recovery']
}

/** 从默认阶段查找业务能力，不把内部 StageTask 当作公共能力授权。 */
export function defaultBidCapabilityForStage(stage: BidStage): DefaultBidCapabilityId | undefined {
  return DEFAULT_BID_STAGE_CAPABILITIES[stage as keyof typeof DEFAULT_BID_STAGE_CAPABILITIES]
}

/** 用现有执行器运行默认能力；S5 的章节审核仍由原执行器统一调度。 */
export function executeDefaultBidCapability(
  capability: DefaultBidCapabilityId,
  task: BidStageTask,
  context: DefaultBidCapabilityContext,
): Promise<StageArtifact[]> {
  const { agent, workspace, run } = context
  const repair = {
    maxRepairAttempts: context.maxRepairAttempts,
    run,
    ...context.recovery === undefined ? {} : { recovery: context.recovery },
  }
  switch (capability) {
    case 'tender.analyze': return executeTenderAnalysis(agent, workspace, task, repair)
    case 'outline.generate': return executeOutlineGeneration(agent, workspace, task, repair)
    case 'evidence.research': return executeEvidenceMapping(agent, workspace, task, {
      ...repair,
      maxConcurrency: context.evidenceMappingMaxConcurrency,
      webSearchEnabled: context.webSearchEnabled,
    })
    case 'chapter.write': return executeChapterWriting(agent, workspace, task, {
      ...repair,
      maxConcurrency: context.chapterWritingMaxConcurrency,
      maxCompletionRepairRounds: context.chapterWritingCompletionRepairRounds,
      webSearchEnabled: context.webSearchEnabled,
      control: context.writingControl,
    })
  }
}

/** 使用能力对应的现有整阶段 Validator 核对默认路线的完整产物。 */
export function validateDefaultBidCapability(
  capability: DefaultBidCapabilityId, workspace: BidWorkspace, stage: BidStage, artifacts: StageArtifact[],
): Promise<StageValidationResult> {
  switch (capability) {
    case 'tender.analyze': return validateTenderAnalysis(workspace, stage, artifacts)
    case 'outline.generate': return validateOutlineGeneration(workspace, stage, artifacts)
    case 'evidence.research': return validateEvidenceMapping(workspace, stage, artifacts)
    case 'chapter.write': return validateChapterWriting(workspace, stage, artifacts)
  }
}

/** 解析后的范围由真实 ID 构成；null 表示用户授权项目级范围。 */
export interface ResolvedCapabilityScope {
  readonly sectionIds: ReadonlySet<string> | null
  readonly paragraphs: Extract<BidCapabilityScope, { kind: 'paragraphs' }>['reference'] | null
}

/**
 * 段落范围在接纳时核对当前正文 Hash 与原文，其他范围核对真实章节 ID。
 * @param workspace 当前项目。
 * @param scope 用户任务根范围。
 * @param outline 当前确认目录。
 */
export async function verifyCapabilityTaskScope(
  workspace: BidWorkspace, scope: BidCapabilityScope, outline: OutlineArtifact,
): Promise<void> {
  if (scope.kind === 'project') return
  if (scope.kind === 'sections') { outlineSectionScope(outline, scope.section_ids); return }
  if (!outline.sections.some(section => section.id === scope.reference.section_id && section.writable)) {
    throw new Error('BID_SECTION_SCOPE_INVALID')
  }
  const location = await readChapterLocation(workspace, scope.reference.section_id)
  if (location === null) throw new Error('BID_CAPABILITY_PARAGRAPH_BODY_MISSING')
  const absolute = within(workspace.projectRoot, location.contentPath)
  await assertNoLinkedPath(workspace.root, absolute)
  const markdown = await readFile(absolute, 'utf8')
  validateChapterParagraphReference(scope.reference, markdown)
}

/**
 * 从任务授权、当前目录和前一步真实结果解析章节 ID。
 * @param taskScope 用户授权的任务根范围。
 * @param stepScope 当前步骤选择的范围来源。
 * @param outline 当前项目的真实目录。
 * @param previous 前一步已完成结果；未完成时不能使用 previous_targets。
 * @returns 本步骤可操作的真实章节集合。
 */
export function resolveCapabilityStepScope(
  taskScope: BidCapabilityScope,
  stepScope: BidCapabilityStepScope,
  outline: OutlineArtifact,
  previous?: { readonly status: 'completed' | 'pending' | 'failed'; readonly result?: BidCapabilityResult },
): ResolvedCapabilityScope {
  const known = new Set(outline.sections.map(section => section.id))
  if (taskScope.kind === 'paragraphs' && !known.has(taskScope.reference.section_id)) {
    throw new Error('BID_SECTION_SCOPE_INVALID')
  }
  const rootIds = taskScope.kind === 'project' ? null
    : taskScope.kind === 'sections' ? outlineSectionScope(outline, taskScope.section_ids)
      : new Set([taskScope.reference.section_id])
  let selected: Set<string> | null
  if (stepScope.source === 'task') selected = rootIds
  else if (stepScope.source === 'section_ids') selected = outlineSectionScope(outline, stepScope.section_ids)
  else {
    if (previous?.status !== 'completed' || previous.result === undefined
      || previous.result.target_section_ids.length === 0) {
      throw new Error('BID_CAPABILITY_PREVIOUS_TARGETS_UNAVAILABLE')
    }
    if (previous.result.target_section_ids.some(id => !known.has(id))) {
      throw new Error('BID_CAPABILITY_PREVIOUS_TARGETS_INVALID')
    }
    selected = outlineSectionScope(outline, previous.result.target_section_ids)
  }
  if (selected !== null && rootIds !== null && [...selected].some(id => !rootIds.has(id))) {
    throw new Error('BID_CAPABILITY_SCOPE_ESCALATION')
  }
  return { sectionIds: selected, paragraphs: stepScope.source === 'task' && taskScope.kind === 'paragraphs'
    ? taskScope.reference : null }
}

/**
 * Host 验证候选结果只引用实际存在、允许发布的产物与章节。
 * @param context 当前步骤的 Host 执行上下文。
 * @param candidate 执行器返回的结果。
 * @param knownIds 当前目录中的真实章节 ID。
 * @returns 可以持久化为已完成步骤的结果。
 */
export async function validateCapabilityResult(
  context: BidCapabilityExecutionContext, candidate: unknown, knownIds: ReadonlySet<string>,
): Promise<BidCapabilityResult> {
  const result = bidCapabilityResultSchema.parse(candidate)
  if (new Set(result.target_section_ids).size !== result.target_section_ids.length
    || result.target_section_ids.some(id => !knownIds.has(id)
      || context.sectionIds !== null && !context.sectionIds.has(id)
        && !context.authorizedNewDescendants?.has(id))) {
    throw new Error('BID_CAPABILITY_RESULT_SCOPE_INVALID')
  }
  if (new Set(result.changed_artifacts).size !== result.changed_artifacts.length) {
    throw new Error('BID_CAPABILITY_RESULT_ARTIFACT_DUPLICATE')
  }
  for (const path of result.changed_artifacts) {
    if (!context.allowedWrites.has(path)) throw new Error(`BID_CAPABILITY_RESULT_ARTIFACT_NOT_ALLOWED: ${path}`)
    const absolute = within(context.working.projectRoot, path)
    await assertNoLinkedPath(context.working.root, absolute)
    if (!(await stat(absolute)).isFile()) throw new Error(`BID_CAPABILITY_RESULT_ARTIFACT_NOT_FILE: ${path}`)
    const baseline = context.baselineHashes.get(path)
    if (baseline !== undefined && createHash('sha256').update(await readFile(absolute)).digest('hex') === baseline) {
      throw new Error(`BID_CAPABILITY_RESULT_ARTIFACT_UNCHANGED: ${path}`)
    }
  }
  return result
}
