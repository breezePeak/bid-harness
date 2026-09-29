/** 初次招标分析与目录生成能力复用默认路线的现有执行器。 */
import { readFile } from 'node:fs/promises'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityFileHash } from './bid-capability-files.ts'
import { executeTenderAnalysis } from './tender-analysis-executor.ts'
import { validateTenderAnalysis } from './tender-analysis-validator.ts'
import { executeOutlineGeneration } from './outline-generation-executor.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { buildBidStageTask } from './runtime-state.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type GenerationCall = Extract<BidCapabilityCall, { capability: 'tender.analyze' | 'outline.generate' }>

const TENDER_WRITES = [
  'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring-origin.json',
  'analysis/tender-analysis-selection.json', 'analysis/compliance.json',
] as const
const OUTLINE_WRITES = [
  'analysis/scoring-response-points.json', 'outline/outline.json', 'outline/quality-report.json',
  'outline/draft.json', 'outline/generation-inputs.json', 'outline/repair-operations.json',
] as const
const TENDER_ARTIFACTS = [
  { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
  { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
  { stage: 'tender_analysis', type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
  { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
] as const
const OUTLINE_ARTIFACTS = [
  { stage: 'outline_generation', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
  { stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' },
  { stage: 'outline_generation', type: 'outline_quality_report', path: 'outline/quality-report.json' },
] as const

/**
 * 首次生成写入整个项目，章节范围不得授权该能力。
 * @param call 初次分析或目录生成能力。
 * @param sectionIds 当前步骤已解析的章节范围。
 * @returns 稳定业务产物的精确可写路径。
 */
export function allowedGenerationWrites(
  call: GenerationCall, sectionIds: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (sectionIds !== null) throw new Error('BID_GENERATION_PROJECT_SCOPE_REQUIRED')
  return new Set(call.capability === 'tender.analyze' ? TENDER_WRITES : OUTLINE_WRITES)
}

/**
 * 在候选项目运行既有 S2/S3 执行器，结果只列实际更新的正式业务文件。
 * @param call 初次生成能力与类型化输入。
 * @param context 当前步骤候选与 Run 身份。
 * @param maxRepairAttempts 现有模型修复次数。
 * @returns 真实目标和文件变更。
 */
export async function executeGenerationCapability(
  call: GenerationCall, context: BidCapabilityExecutionContext, maxRepairAttempts: number,
): Promise<{ readonly result: BidCapabilityResult }> {
  const workspace = context.working
  const writes = allowedGenerationWrites(call, context.sectionIds)
  const before = new Map(await Promise.all([...writes].map(async path => [path, await capabilityFileHash(workspace, path)] as const)))
  const options = { run: context.run, maxRepairAttempts }
  if (call.capability === 'tender.analyze') {
    await executeTenderAnalysis(context.agent, workspace, buildBidStageTask('tender_analysis'), options)
  } else {
    await executeOutlineGeneration(context.agent, workspace, buildBidStageTask('outline_generation'), options)
  }
  await validateGenerationCapability(call, context)
  const changed: string[] = []
  for (const path of writes) if (await capabilityFileHash(workspace, path) !== before.get(path)) changed.push(path)
  const targetIds: string[] = []
  if (call.capability === 'outline.generate') {
    const path = within(workspace.projectRoot, 'outline/outline.json')
    await assertNoLinkedPath(workspace.root, path)
    targetIds.push(...parseOutlineArtifact(JSON.parse(await readFile(path, 'utf8')) as unknown)
      .sections.map(section => section.id))
  }
  return { result: { target_section_ids: targetIds, changed_artifacts: changed,
    change_summary: call.capability === 'tender.analyze' ? '已分析招标文件' : '已生成初步目录',
    warnings: [], missing_topics: [], needs_input: false } }
}

/**
 * 用原阶段 Validator 核对同一组完整业务产物。
 * @param call 初次分析或目录生成能力。
 * @param context 当前候选项目。
 */
export async function validateGenerationCapability(
  call: GenerationCall, context: Pick<BidCapabilityExecutionContext, 'working'>,
): Promise<void> {
  const checked = call.capability === 'tender.analyze'
    ? await validateTenderAnalysis(context.working, 'tender_analysis', TENDER_ARTIFACTS)
    : await validateOutlineGeneration(context.working, 'outline_generation', OUTLINE_ARTIFACTS)
  if (!checked.ok) throw new Error(`BID_GENERATION_INVALID: ${checked.issues.map(issue => issue.code).join(', ')}`)
}
