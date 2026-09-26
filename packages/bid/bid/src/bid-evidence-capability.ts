/** 局部资料能力复用 S4 remap，并只发布真实改变的资料与章节索引。 */
import type { BidWorkspace } from './index.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityFileHash, readCapabilityJson } from './bid-capability-files.ts'
import { executeEvidenceMapping } from './evidence-mapping-executor.ts'
import { validateEvidenceMapping } from './evidence-mapping-validator.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { parseOutlineQualityReport } from './outline-generation-artifacts.ts'
import { parseWebEvidenceSourcesArtifact } from './web-evidence-source-artifacts.ts'
import { webEvidenceChunkIndexPath } from './web-evidence-chunks.ts'
import { buildWritableSectionWorklist, outlineSectionScope, validateSectionEvidenceCoverage } from './section-evidence-context.ts'
import { adoptCapabilityResearchedOutline, OUTLINE_CAPABILITY_INDEX_PATHS } from './outline-capability-update.ts'
import { buildBidStageTask } from './runtime-state.ts'
import { BidStageExecutionError } from './control-plane-contract.ts'

type EvidenceCall = Extract<BidCapabilityCall, { capability: 'evidence.research' }>

/** S4 已验证的 Host 配置值，由调用方显式传入。 */
export interface EvidenceCapabilitySettings {
  readonly maxRepairAttempts: number
  readonly maxConcurrency: number
  readonly webSearchEnabled: boolean
}

const fixedPaths = new Set<string>([
  ...OUTLINE_CAPABILITY_INDEX_PATHS,
  'outline/quality-report.json', 'analysis/web-evidence-sources.json',
])

async function sourcePaths(workspace: BidWorkspace): Promise<Set<string>> {
  if (await capabilityFileHash(workspace, 'analysis/web-evidence-sources.json') === undefined) return new Set()
  const ledger = parseWebEvidenceSourcesArtifact(await readCapabilityJson(workspace, 'analysis/web-evidence-sources.json'))
  return new Set(ledger.sources.flatMap(source => [source.snapshot_path, webEvidenceChunkIndexPath(source.source_id)]))
}

/**
 * 已存在的索引可在运行前授权；新 Web 文件在运行后从严格账本取得精确路径。
 * @returns 当前资料能力的固定文件许可。
 */
export function allowedEvidenceCapabilityWrites(): ReadonlySet<string> {
  return new Set(fixedPaths)
}

/**
 * 恢复和执行后均从 Host 账本解析 Web 文件路径，不能授权整目录。
 * @param workspace Work 或步骤候选项目。
 * @returns 账本引用的精确快照及分块索引路径。
 */
export function allowedEvidenceCapabilitySourceWrites(workspace: BidWorkspace): Promise<ReadonlySet<string>> {
  return sourcePaths(workspace)
}

/**
 * 在独立步骤候选中研究授权叶节，保持范围外映射及既有来源顺序。
 * @param call 模型选择的补充或替换研究。
 * @param context Host 步骤身份与候选项目。
 * @param settings 当前 Host 配置。
 * @returns 精确改变的文件与可供后续写作使用的章节。
 */
export async function executeEvidenceCapability(
  call: EvidenceCall, context: BidCapabilityExecutionContext, settings: EvidenceCapabilitySettings,
): Promise<{ readonly result: BidCapabilityResult }> {
  const workspace = context.working
  const outline = parseOutlineArtifact(await readCapabilityJson(workspace, 'outline/outline.json'))
  const selected = context.sectionIds === null
    ? new Set(outline.sections.map(section => section.id))
    : outlineSectionScope(outline, [...context.sectionIds])
  const targetIds = buildWritableSectionWorklist(outline).filter(section => selected.has(section.id)).map(section => section.id)
  if (targetIds.length === 0) throw new Error('BID_EVIDENCE_RESEARCH_SCOPE_EMPTY')
  if (call.input.allow_outline_refinement) {
    const canonical = parseOutlineArtifact(await readCapabilityJson(context.canonical, 'outline/confirmed-outline.json'))
    const current = parseOutlineArtifact(await readCapabilityJson(workspace, 'outline/confirmed-outline.json'))
    if (JSON.stringify(canonical) === JSON.stringify(current)) {
      throw new Error('BID_EVIDENCE_RESEARCH_REQUIRES_OUTLINE_STEP')
    }
  }
  const beforeMap = parseEvidenceMapArtifact(await readCapabilityJson(workspace, 'analysis/evidence-map.json'))
  const originalOutlineText = await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')
  const beforeLedger = parseWebEvidenceSourcesArtifact(await readCapabilityJson(workspace, 'analysis/web-evidence-sources.json'))
  const beforePaths = new Set([...fixedPaths, ...await sourcePaths(workspace)])
  const hashes = new Map(await Promise.all([...beforePaths].map(async path => [path, await capabilityFileHash(workspace, path)] as const)))
  const remap = {
    section_ids: targetIds, mode: call.input.mode, reason: call.input.reason,
    previous_outline: outline,
  }
  const warnings: string[] = []
  try {
    await executeEvidenceMapping(context.agent, workspace, buildBidStageTask('evidence_mapping'), {
      ...settings, run: context.run, remap,
    })
  } catch (error) {
    const unavailable = error instanceof BidStageExecutionError && error.issues.some(issue =>
      issue.code === 'EVIDENCE_MAPPING_WEB_UNAVAILABLE'
      || issue.message.includes('web_search/web_fetch 工具未正确注册'))
    if (!settings.webSearchEnabled || !unavailable) throw error
    warnings.push('联网资料工具不可用；本轮只研究已授权本地资料，未证实的来源保留为资料缺口。')
    await executeEvidenceMapping(context.agent, workspace, buildBidStageTask('evidence_mapping'), {
      ...settings, webSearchEnabled: false, run: context.run, remap,
    })
  }
  const researchedOutline = parseOutlineArtifact(await readCapabilityJson(workspace, 'outline/outline.json'))
  if (!call.input.allow_outline_refinement) {
    const identity = (value: typeof outline) => ({ ...value, sections: value.sections.map(section => ({
      id: section.id, parent_id: section.parent_id, order: section.order, title: section.title,
      writable: section.writable,
    })) })
    if (JSON.stringify(identity(outline)) !== JSON.stringify(identity(researchedOutline))) {
      throw new Error('BID_EVIDENCE_RESEARCH_OUTLINE_SCOPE_INVALID')
    }
    await context.run.commits.writeText(join(workspace.projectRoot, 'outline/outline.json'), originalOutlineText)
  }
  const afterMap = parseEvidenceMapArtifact(await readCapabilityJson(workspace, 'analysis/evidence-map.json'))
  const afterLedger = parseWebEvidenceSourcesArtifact(await readCapabilityJson(workspace, 'analysis/web-evidence-sources.json'))
  const targetSet = new Set(targetIds)
  const oldRows = new Map(beforeMap.section_mappings.map(row => [row.section_id, row]))
  if (afterMap.section_mappings.length !== beforeMap.section_mappings.length
    || afterMap.section_mappings.some(row => !oldRows.has(row.section_id)
      || !targetSet.has(row.section_id) && JSON.stringify(row) !== JSON.stringify(oldRows.get(row.section_id)))) {
    throw new Error('BID_EVIDENCE_RESEARCH_MAPPING_SCOPE_INVALID')
  }
  if (JSON.stringify(afterLedger.sources.slice(0, beforeLedger.sources.length)) !== JSON.stringify(beforeLedger.sources)) {
    throw new Error('BID_EVIDENCE_RESEARCH_WEB_LEDGER_TRUNCATED')
  }
  for (const path of await sourcePaths(workspace)) {
    const old = hashes.get(path)
    if (old !== undefined && old !== await capabilityFileHash(workspace, path)) {
      throw new Error(`BID_EVIDENCE_RESEARCH_SOURCE_CHANGED: ${path}`)
    }
  }
  if (call.input.allow_outline_refinement) {
    await adoptCapabilityResearchedOutline(context, researchedOutline, targetSet)
  }
  const currentOutline = parseOutlineArtifact(await readCapabilityJson(workspace, 'outline/confirmed-outline.json'))
  if (validateSectionEvidenceCoverage(currentOutline, afterMap).length > 0) {
    throw new Error('BID_EVIDENCE_RESEARCH_COVERAGE_INVALID')
  }
  const afterPaths = new Set([...fixedPaths, ...await sourcePaths(workspace)])
  const changed: string[] = []
  for (const path of afterPaths) {
    const digest = await capabilityFileHash(workspace, path)
    if (digest !== undefined && digest !== hashes.get(path)) changed.push(path)
  }
  const missing = afterMap.section_mappings.filter(row => targetSet.has(row.section_id))
    .flatMap(row => row.missing_topics.map(topic => `${row.section_id}: ${topic}`))
  return { result: {
    target_section_ids: targetIds, changed_artifacts: changed,
    change_summary: `已${call.input.mode === 'supplement' ? '补充' : '替换'} ${String(targetIds.length)} 个章节的资料映射`,
    warnings, missing_topics: missing, needs_input: false,
  } }
}

/**
 * 使用 S4 既有来源、写作说明与全局目录校验复核局部候选。
 * @param context 当前步骤候选项目。
 * @param result 执行器返回的目标章节。
 */
export async function validateEvidenceCapability(
  context: BidCapabilityExecutionContext, result: BidCapabilityResult,
): Promise<void> {
  const workspace = context.working
  const validation = await validateEvidenceMapping(workspace, 'evidence_mapping', [
    { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
    { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
    { stage: 'evidence_mapping', type: 'outline', path: 'outline/outline.json' },
    { stage: 'evidence_mapping', type: 'outline_quality_report', path: 'outline/quality-report.json' },
  ], {
    evidence: parseEvidenceMapArtifact(await readCapabilityJson(workspace, 'analysis/evidence-map.json')),
    outline: parseOutlineArtifact(await readCapabilityJson(workspace, 'outline/outline.json')),
    quality: parseOutlineQualityReport(await readCapabilityJson(workspace, 'outline/quality-report.json')),
    draftReviewSectionIds: result.target_section_ids,
  })
  if (!validation.ok) throw new Error(`BID_EVIDENCE_RESEARCH_INVALID: ${validation.issues.map(issue => issue.code).join(',')}`)
}
