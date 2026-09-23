/** 招标理解的后期修改保留原始来源，并记录需要复核的下游章节。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { applyTenderAnalysisEdits, createConfirmedTenderScoring, createTenderScoringSelection,
  parseTenderAnalysisEditOperations, parseTenderScoringSelection,
  type TenderAnalysisConfirmationView } from './tender-analysis-confirmation.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact,
  parseTenderScoringArtifact, type TenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { catalogMatchesScoring, parseScoringResponsePointCandidate, parseScoringResponsePointCatalog,
  reconcileScoringResponsePointCatalog, type ScoringResponsePointCandidate,
  type ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type TenderUpdateCall = Extract<BidCapabilityCall, { capability: 'tender.update' }>
const PATHS = [
  'analysis/project.json', 'analysis/requirements.json', 'analysis/scoring-origin.json',
  'analysis/scoring.json', 'analysis/compliance.json', 'analysis/tender-analysis-selection.json',
  'analysis/scoring-response-points.json', 'analysis/tender-update-impact.json',
] as const

async function optionalJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function fileHash(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return createHash('sha256').update(await readFile(absolute)).digest('hex') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function changedIds<T extends { id: string }>(before: readonly T[], after: readonly T[]): Set<string> {
  const prior = new Map(before.map(item => [item.id, JSON.stringify(item)]))
  const current = new Map(after.map(item => [item.id, JSON.stringify(item)]))
  return new Set([...prior.keys(), ...current.keys()].filter(id => prior.get(id) !== current.get(id)))
}

/**
 * 招标理解修改可触及的精确候选文件。
 * @returns 文件路径集合。
 */
export function allowedTenderUpdateCapabilityWrites(): ReadonlySet<string> { return new Set(PATHS) }

/**
 * 仅为变化的评分项生成语义响应点，保持 S3 的独立 Child 职责。
 * @param context 当前能力步骤。
 * @param scoring 变化评分项组成的临时评分视图。
 * @returns 经 Host 校验的局部候选。
 */
export async function analyzeChangedScoringResponsePoints(
  context: BidCapabilityExecutionContext, scoring: TenderScoringArtifact,
): Promise<ScoringResponsePointCandidate> {
  const subagents = context.agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
    throw new Error('BID_TENDER_UPDATE_INDEPENDENT_CHILD_REQUIRED')
  }
  await context.run.scheduler.waitUntilRunnable(context.run.signal)
  const child = await subagents.start('spawn', {
    parent: context.agent, signal: context.run.signal, label: '局部评分响应点分析',
    prompt: [{ type: 'text', text: [
      '只分析以下评分项，逐项按评分语义形成最小合理业务响应点。不得按标点或分值机械切分，不得补造原文没有的主题。',
      `评分项：${JSON.stringify(scoring)}`,
      '返回 {"schema_version":1,"points":[{"scoring_id":"原 ID","order":1,"text":"响应内容"}]}。',
      '每个评分项至少一个响应点；同项 order 从 1 连续递增；不得返回其他评分项。',
    ].join('\n') }],
    outputSchema: { type: 'object', properties: {
      schema_version: { type: 'integer' }, points: { type: 'array', items: { type: 'object',
        properties: { scoring_id: { type: 'string' }, order: { type: 'integer' }, text: { type: 'string' } },
        required: ['scoring_id', 'order', 'text'], additionalProperties: false } },
    }, required: ['schema_version', 'points'], additionalProperties: false },
    toolFilter: { allow: [] }, maxDepth: 1,
    persona: '你是评分响应点分析 Child。只分析 Host 提供的评分事实，不调用工具。',
  })
  try {
    const result = await child.result
    if (result.stopReason !== 'completed' || result.structured === undefined) {
      throw new Error('BID_TENDER_UPDATE_RESPONSE_POINT_CHILD_FAILED')
    }
    return parseScoringResponsePointCandidate(result.structured)
  } finally { await child.dispose() }
}

/**
 * 在独立候选中应用规范化编辑、评分选择和局部 RP 协调。
 * @param call 已验证的能力输入。
 * @param context 步骤授权与候选项目。
 * @param analyze 测试可替换的局部语义分析职责。
 * @returns 实际文件变化及受影响章节。
 */
export async function executeTenderUpdateCapability(
  call: TenderUpdateCall, context: BidCapabilityExecutionContext,
  analyze = analyzeChangedScoringResponsePoints,
): Promise<{ readonly result: BidCapabilityResult }> {
  const workspace = context.working
  if (context.sectionIds !== null) throw new Error('BID_TENDER_UPDATE_PROJECT_SCOPE_REQUIRED')
  const [projectRaw, requirementsRaw, originRaw, selectionRaw, complianceRaw, catalogRaw] = await Promise.all([
    optionalJson(workspace, 'analysis/project.json'), optionalJson(workspace, 'analysis/requirements.json'),
    optionalJson(workspace, 'analysis/scoring-origin.json'), optionalJson(workspace, 'analysis/tender-analysis-selection.json'),
    optionalJson(workspace, 'analysis/compliance.json'), optionalJson(workspace, 'analysis/scoring-response-points.json'),
  ])
  const origin = parseTenderScoringArtifact(originRaw)
  const selection = selectionRaw === undefined ? createTenderScoringSelection(origin)
    : parseTenderScoringSelection(selectionRaw, origin)
  const before: TenderAnalysisConfirmationView = {
    project: parseTenderProjectArtifact(projectRaw), requirements: parseTenderRequirementsArtifact(requirementsRaw),
    scoring: origin, selected_scoring_ids: selection.selected_scoring_ids,
    compliance: parseTenderComplianceArtifact(complianceRaw),
  }
  const previousScoring = createConfirmedTenderScoring(before)
  const previousCatalog = catalogRaw === undefined ? undefined : parseScoringResponsePointCatalog(catalogRaw)
  if (previousCatalog !== undefined && !catalogMatchesScoring(previousCatalog, previousScoring)) {
    throw new Error('BID_TENDER_UPDATE_SCORING_CATALOG_MISMATCH')
  }
  const edited = applyTenderAnalysisEdits(before, parseTenderAnalysisEditOperations(call.input.operations))
  const selected = call.input.selected_scoring_ids === undefined
    ? edited.selected_scoring_ids : parseTenderScoringSelection({
      schema_version: 1, selected_scoring_ids: call.input.selected_scoring_ids,
    }, edited.scoring).selected_scoring_ids
  const after = { ...edited, selected_scoring_ids: selected }
  const scoring = createConfirmedTenderScoring(after)
  const requirementIds = changedIds(before.requirements.requirements, after.requirements.requirements)
  const scoringIds = changedIds(previousScoring.scoring_items, scoring.scoring_items)
  const complianceIds = changedIds(before.compliance.compliance_items, after.compliance.compliance_items)
  const priorSelected = new Set(before.selected_scoring_ids)
  const semanticIds = new Set(scoring.scoring_items.filter(item => !priorSelected.has(item.id)
    || before.scoring.scoring_items.find(prior => prior.id === item.id)?.criterion !== item.criterion
    || before.scoring.scoring_items.find(prior => prior.id === item.id)?.title !== item.title
    || before.scoring.scoring_items.find(prior => prior.id === item.id)?.must_answer !== item.must_answer)
    .map(item => item.id))
  let catalog: ScoringResponsePointCatalog | undefined
  if (previousCatalog !== undefined) {
    const candidate = semanticIds.size === 0 ? { schema_version: 1 as const, points: [] }
      : await analyze(context, { ...scoring, scoring_items: scoring.scoring_items.filter(item => semanticIds.has(item.id)) })
    catalog = reconcileScoringResponsePointCatalog(previousCatalog, scoring, semanticIds, candidate)
  }
  const outlineRaw = await optionalJson(workspace, 'outline/confirmed-outline.json')
    ?? await optionalJson(workspace, 'outline/outline.json')
  const outline = outlineRaw === undefined ? undefined : parseOutlineArtifact(outlineRaw)
  const projectChanged = JSON.stringify(before.project) !== JSON.stringify(after.project)
  const globalComplianceChanged = outline !== undefined
    && outline.global_compliance_ids.some(id => complianceIds.has(id))
  const affected = outline?.sections.filter(section => section.writable && (
    projectChanged || globalComplianceChanged
    || section.requirement_ids.some(id => requirementIds.has(id))
    || section.scoring_ids.some(id => scoringIds.has(id))
    || section.compliance_ids.some(id => complianceIds.has(id))
  )).map(section => section.id) ?? []
  const impact = {
    schema_version: 1, changed_requirement_ids: [...requirementIds], changed_scoring_ids: [...scoringIds],
    changed_compliance_ids: [...complianceIds], project_changed: projectChanged,
    affected_section_ids: affected, stale_artifacts: affected.length === 0 ? []
      : ['outline/outline.json', 'outline/confirmed-outline.json', 'analysis/evidence-map.json',
        'chapters/writing-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json'],
  }
  const priorHashes = new Map(await Promise.all(PATHS.map(async path => [path, await fileHash(workspace, path)] as const)))
  await context.run.commits.publish(async (lease) => {
    await lease.writeJson(within(workspace.projectRoot, 'analysis/project.json'), after.project)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/requirements.json'), after.requirements)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/scoring-origin.json'), after.scoring)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/scoring.json'), scoring)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/compliance.json'), after.compliance)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/tender-analysis-selection.json'), {
      schema_version: 1, selected_scoring_ids: selected,
    })
    if (catalog !== undefined) await lease.writeJson(within(workspace.projectRoot, 'analysis/scoring-response-points.json'), catalog)
    await lease.writeJson(within(workspace.projectRoot, 'analysis/tender-update-impact.json'), impact)
  })
  const changed: string[] = []
  for (const path of PATHS) if (priorHashes.get(path) !== await fileHash(workspace, path)) changed.push(path)
  return { result: { target_section_ids: affected, changed_artifacts: changed,
    change_summary: `招标理解已更新；${String(affected.length)} 个章节需要复核`, warnings: affected.length > 0
      ? ['受影响章节的目录、资料、写作与验收需要后续能力复核；现有正文已保留。'] : [],
    missing_topics: [], needs_input: false } }
}

/**
 * 核对候选评分投影、选择与稳定响应点的同一版本关系。
 * @param context 当前步骤候选项目。
 */
export async function validateTenderUpdateCapability(
  context: Pick<BidCapabilityExecutionContext, 'working'>,
): Promise<void> {
  const workspace = context.working
  const [projectRaw, requirementsRaw, originRaw, scoringRaw, complianceRaw, selectionRaw, catalogRaw] = await Promise.all([
    optionalJson(workspace, 'analysis/project.json'), optionalJson(workspace, 'analysis/requirements.json'),
    optionalJson(workspace, 'analysis/scoring-origin.json'), optionalJson(workspace, 'analysis/scoring.json'),
    optionalJson(workspace, 'analysis/compliance.json'), optionalJson(workspace, 'analysis/tender-analysis-selection.json'),
    optionalJson(workspace, 'analysis/scoring-response-points.json'),
  ])
  const origin = parseTenderScoringArtifact(originRaw)
  const selection = parseTenderScoringSelection(selectionRaw, origin)
  const view: TenderAnalysisConfirmationView = {
    project: parseTenderProjectArtifact(projectRaw), requirements: parseTenderRequirementsArtifact(requirementsRaw),
    scoring: origin, compliance: parseTenderComplianceArtifact(complianceRaw),
    selected_scoring_ids: selection.selected_scoring_ids,
  }
  if (JSON.stringify(parseTenderScoringArtifact(scoringRaw)) !== JSON.stringify(createConfirmedTenderScoring(view))) {
    throw new Error('BID_TENDER_UPDATE_SCORING_SELECTION_MISMATCH')
  }
  if (catalogRaw !== undefined && !catalogMatchesScoring(parseScoringResponsePointCatalog(catalogRaw),
    parseTenderScoringArtifact(scoringRaw))) throw new Error('BID_TENDER_UPDATE_SCORING_CATALOG_MISMATCH')
}
