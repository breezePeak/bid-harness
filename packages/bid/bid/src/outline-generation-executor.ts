import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { zodJsonSchema } from './zod-json-schema.ts'
import { applyOutlineEdits, outlineBusinessBindingSchema,
  type OutlineBusinessBinding, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { outlineArtifactSha256, parseOutlineDraft, type OutlineDraftView } from './outline-confirmation-artifacts.ts'
import { buildWritableSectionWorklist, outlineSectionScope } from './section-evidence-context.ts'
import { outlineRegenerationChanges, parseOutlineRegenerationChangeSet } from './outline-regeneration-artifacts.ts'
import type { BidWorkspace } from './index.ts'
import { BidStageExecutionError, type BidStageTask, type StageArtifact, type StageValidationIssue } from './control-plane-contract.ts'
import {
  type ModelStageExecutionOptions,
  renderStageRepairIssues,
  waitForModelStageIdle,
} from './model-stage-repair.ts'
import { renderBidRecoveryContext } from './bid-recovery.ts'
import {
  type OutlineArtifact,
  type OutlineQualityIssue,
  outlineModelCandidateSchema,
  outlineQualityIssueSchema,
  parseOutlineArtifact,
  parseOutlineQualityReport,
  OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
} from './outline-generation-artifacts.ts'
import { loadOutlineFrameworkStructures, loadReferenceBidStructures, validateOutlineFrameworkRefs, type OutlineFrameworkStructure } from './outline-framework.ts'
import {
  catalogMatchesScoring,
  parseScoringResponsePointCatalog,
  type ScoringResponsePointCatalog,
  createScoringResponsePointCatalog,
  parseScoringResponsePointCandidate,
  scoringResponsePointModelCandidateSchema,
  bindScoringResponsePointModelCandidate,
  type ScoringResponsePointCandidate,
} from './scoring-response-point-artifacts.ts'
import { parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderComplianceArtifact, parseTenderScoringArtifact, type TenderProjectArtifact, type TenderScoringArtifact, type TenderRequirementsArtifact, type TenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { applyOutlineModelRepair, outlineAssociationRepairOperationSchema } from './outline-generation-repair.ts'
import { deriveOutlineModelTree } from './outline-model-tree.ts'
import { inspectOutlineCandidate, applyOutlineCandidateRepair } from './outline-candidate-repair.ts'
import { ensureTechnicalDeviationSection } from './outline-generation-normalization.ts'
import { missingOutlineResponsePoints, validateOutlineSharedCoverage, validateOutlineSharedStructure } from './outline-shared-validator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { customerFacingOutlineText, findBidInternalIdentifiers } from './customer-facing-prose.ts'
import { bindSectionResponsePoints } from './scoring-response-point-bindings.ts'
import { validateOutlineGeneration } from './outline-generation-validator.ts'
import { bindOutlineModelCandidate, bindOutlineModelRepairOperations, bindOutlineModelCandidateRepairs,
  outlineModelInputView, outlineModelView, outlineModelFieldName, outlineModelRepairOperationSchema,
  outlineModelResponsePointRepairOperationSchema, outlineModelCandidateRepairSchema, outlineModelStructuralOperationSchema,
  bindOutlineModelStructuralOperations, type OutlineModelBindingInputs } from './outline-model-bindings.ts'

const OUTLINE_ARTIFACT = 'outline/outline.json'
const QUALITY_REPORT_ARTIFACT = 'outline/quality-report.json'
const RESPONSE_POINT_CANDIDATE = 'analysis/scoring-response-points.candidate.json'
const RESPONSE_POINT_CATALOG = 'analysis/scoring-response-points.json'
const REPAIR_RECEIPT = 'outline/repair-operations.json'
const REGENERATION_CHANGE_SET = 'outline/regeneration/change-set.json'
const outlineQualityReviewResultSchema = z.object({
  operations: z.array(outlineModelRepairOperationSchema),
  issues: z.array(outlineQualityIssueSchema.pick({ message: true })),
}).strict()

// 子代理结构化输出仅接受结构约束；Host 的 Zod 解析保留全部标量约束。
function removeUnsupportedSubagentSchemaConstraints(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) removeUnsupportedSubagentSchemaConstraints(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  const schema = value as Record<string, unknown>
  delete schema.$schema
  delete schema.minLength
  delete schema.maxLength
  delete schema.minItems
  delete schema.maxItems
  delete schema.pattern
  delete schema.minimum
  delete schema.exclusiveMinimum
  delete schema.maximum
  delete schema.exclusiveMaximum
  delete schema.multipleOf
  delete schema.format
  if (Array.isArray(schema.anyOf)) {
    schema.oneOf = schema.anyOf
    delete schema.anyOf
  }
  for (const child of Object.values(schema)) removeUnsupportedSubagentSchemaConstraints(child)
}

function subagentOutputSchema(schema: z.ZodType): ObjectJsonSchema {
  const json = zodJsonSchema(schema, { unrepresentable: 'any' })
  removeUnsupportedSubagentSchemaConstraints(json)
  return { ...json, type: 'object' }
}

const rawScoringResponsePointCandidateOutputSchema = zodJsonSchema(scoringResponsePointModelCandidateSchema)
removeUnsupportedSubagentSchemaConstraints(rawScoringResponsePointCandidateOutputSchema)
const scoringResponsePointCandidateOutputSchema: ObjectJsonSchema = {
  ...rawScoringResponsePointCandidateOutputSchema,
  type: 'object',
}
const rawOutlineCandidateOutputSchema = zodJsonSchema(outlineModelCandidateSchema, { unrepresentable: 'any' })
const rawOutlineNodeOutputSchema = zodJsonSchema(outlineModelCandidateSchema.shape.sections.element, { unrepresentable: 'any' })
const outlineNodeProperties = rawOutlineNodeOutputSchema.properties as Record<string, unknown>
// 工具 Schema 子集不支持递归引用；每层完整规则由 Host 的递归候选 Schema 在绑定前校验。
outlineNodeProperties.children = { type: 'array', items: { type: 'object',
  description: '与根章节完全相同的节点结构，包含全部必填语义字段和 children 数组；叶节点 children: []。不得提交 parent_position、ID、order、level 或 writable。' } }
delete rawOutlineNodeOutputSchema.definitions
const outlineCandidateProperties = rawOutlineCandidateOutputSchema.properties as Record<string, unknown>
outlineCandidateProperties.sections = {
  type: 'array', items: rawOutlineNodeOutputSchema,
}
delete rawOutlineCandidateOutputSchema.definitions
removeUnsupportedSubagentSchemaConstraints(rawOutlineCandidateOutputSchema)
const outlineCandidateOutputSchema: ObjectJsonSchema = {
  ...rawOutlineCandidateOutputSchema,
  type: 'object',
}
const rawOutlineQualityReviewOutputSchema = zodJsonSchema(outlineQualityReviewResultSchema)
removeUnsupportedSubagentSchemaConstraints(rawOutlineQualityReviewOutputSchema)
const outlineQualityReviewOutputSchema: ObjectJsonSchema = {
  ...rawOutlineQualityReviewOutputSchema,
  type: 'object',
}

function renderOutlineRevisionFeedback(feedback: string): string {
  return `以当前持久化 Draft 为基线，保留未涉及章节、全部招标要求和评分覆盖。按以下用户反馈重构目录，不得只在 writing_notes 中转述：\n<outline-revision-feedback>\n${feedback}\n</outline-revision-feedback>`
}

/**
 * 使用独立、无文件写权限的 Child 生成局部编辑操作，与整本重生成共用反馈规则和目录 Validator。
 * @param agent 当前 Main Agent，不等待其工具调用结束。
 * @param draft 最近一次读取的 CAS 基线。
 * @param sectionIds 选中章节或分支。
 * @param feedback 用户反馈。
 * @param signal 当前 Host 操作取消信号。
 * @param recovery Host 接受的当前局部目录修复指令。
 * @returns 只修改选中子树的编辑操作；调用方经 mutateOutlineDraft 校验后提交。
 */
export async function generateScopedOutlineOperations(
  agent: Agent, draft: OutlineDraftView, sectionIds: readonly string[], feedback: string, signal: AbortSignal,
  recovery?: ModelStageExecutionOptions['recovery'],
): Promise<OutlineEditOperation[]> {
  const selected = outlineSectionScope(draft.outline, sectionIds)
  const subagents = agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) throw new Error('局部目录重生成需要独立上下文的 spawn provider。')
  const run = await subagents.start('spawn', {
    parent: agent, signal, label: '局部目录重生成', maxDepth: 1, toolFilter: { allow: [] },
    prompt: [{ type: 'text', text: [
      renderOutlineRevisionFeedback(feedback),
      renderBidRecoveryContext(recovery),
      `当前目录：${JSON.stringify(draft.outline.sections.map((section, position) => ({ position,
        title: section.title, purpose: section.purpose, summary: section.summary, writable: section.writable,
        must_answer: section.must_answer, writing_notes: section.writing_notes, sibling_position: section.order - 1,
        parent_position: section.parent_id === null ? null : draft.outline.sections.findIndex(parent => parent.id === section.parent_id) })))}`,
      `只允许修改以下章节位置及其子树：${JSON.stringify(sectionIds.map(id => draft.outline.sections.findIndex(section => section.id === id)))}。保留选中根的父节点和位置；不得修改范围外节点。拆分叶子使用 split_section，合并同级叶子使用 merge_sections。`,
      '不得写文件。最终只返回原始 JSON 编辑操作数组。节点选择使用 section_position、parent_position 或 section_positions，全部身份及新增编号由程序绑定。操作必须符合：',
      JSON.stringify(zodJsonSchema(z.array(outlineModelStructuralOperationSchema))),
    ].join('\n') }],
  })
  try {
    const result = await run.result
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`BID_REGENERATE_FAILED: ${result.stopReason}`)
    const operations = bindOutlineModelStructuralOperations(JSON.parse(result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('')), draft.outline)
    const candidate = deriveOutlineModelTree(applyOutlineEdits(draft.outline, operations))
    const candidateScope = outlineSectionScope(candidate, sectionIds)
    if (sectionIds.some((id) => {
      const before = draft.outline.sections.find(section => section.id === id)
      const after = candidate.sections.find(section => section.id === id)
      return before === undefined || after === undefined || before.parent_id !== after.parent_id || before.order !== after.order
    })) throw new Error('BID_OUTLINE_SCOPE_VIOLATION')
    const changes = outlineRegenerationChanges(draft.outline, candidate)
    if (changes.some(change => change.type === 'add' ? !candidateScope.has(change.section_id) : !selected.has(change.section_id))) throw new Error('BID_OUTLINE_SCOPE_VIOLATION')
    return operations
  } finally { await run.dispose() }
}

/**
 * 结构操作完成后，让独立子会话按章节顺序选择业务位置，由 Host 绑定身份。
 * @param agent 当前执行 Agent。
 * @param candidate 已分配新 ID 的候选目录。
 * @param sectionIds 本次可修改的章节范围。
 * @param before 修改前的目录，父章原归属须由范围内可写叶节承接。
 * @param facts 当前招标事实和响应点的有界摘要。
 * @param feedback 用户本次局部深化目标。
 * @param signal 当前 Run 的取消信号。
 * @returns 供 Host 校验的章节业务归属候选。
 */
export async function generateScopedOutlineBusinessBindings(
  agent: Agent, candidate: OutlineArtifact, sectionIds: readonly string[], before: OutlineArtifact, facts: {
    requirements: readonly { id: string; text: string }[]
    scoring: readonly { id: string; text: string }[]
    compliance: readonly { id: string; text: string }[]
    response_points: readonly { id: string; scoring_id: string; text: string }[]
  },
  feedback: string, signal: AbortSignal,
): Promise<OutlineBusinessBinding[]> {
  const selected = outlineSectionScope(candidate, sectionIds)
  const targets = buildWritableSectionWorklist(candidate).filter(section => selected.has(section.id))
  const choices = z.array(z.number().int().nonnegative())
  const outputSchema = z.array(z.object({ requirement_positions: choices, scoring_positions: choices,
    response_point_positions: choices, compliance_positions: choices }).strict()).length(targets.length)
  const pick = (items: readonly { id: string }[], positions: readonly number[]): string[] => positions.map((position) => {
    const item = items[position]
    if (item === undefined) throw new Error('BID_OUTLINE_BINDING_OBJECT_UNKNOWN')
    return item.id
  })
  const positions = (items: readonly { id: string }[], ids: readonly string[]): number[] => ids.map((id) => {
    const position = items.findIndex(item => item.id === id)
    if (position < 0) throw new Error('BID_OUTLINE_BINDING_OBJECT_UNKNOWN')
    return position
  })
  const sectionView = (section: OutlineArtifact['sections'][number]) => ({ title: section.title,
    purpose: section.purpose, must_answer: section.must_answer,
    requirement_positions: positions(facts.requirements, section.requirement_ids),
    scoring_positions: positions(facts.scoring, section.scoring_ids),
    response_point_positions: positions(facts.response_points, section.scoring_response_point_ids ?? []),
    compliance_positions: positions(facts.compliance, section.compliance_ids) })
  const subagents = agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
    throw new Error('局部目录业务归属需要独立上下文的 spawn provider。')
  }
  const run = await subagents.start('spawn', {
    parent: agent, signal, label: '局部目录业务归属', maxDepth: 1, toolFilter: { allow: [] },
    prompt: [{ type: 'text', text: [
      `用户目标：${feedback}`,
      `当前候选目录：${JSON.stringify(candidate.sections.map((section, position) => ({ ...sectionView(section), position,
        writable: section.writable, parent_position: section.parent_id === null ? null
          : candidate.sections.findIndex(parent => parent.id === section.parent_id) })))}`,
      `修改前的范围内业务归属：${JSON.stringify(before.sections.filter(section => selected.has(section.id)).map(sectionView))}`,
      `本次可修改章节：${JSON.stringify(targets.map(sectionView))}`,
      `真实招标要求、评分、合规与响应点：${JSON.stringify({
        requirements: facts.requirements.map(({ text }, position) => ({ position, text })),
        scoring: facts.scoring.map(({ text }, position) => ({ position, text })),
        compliance: facts.compliance.map(({ text }, position) => ({ position, text })),
        response_points: facts.response_points.map(({ scoring_id, text }, position) => ({ position, text,
          scoring_position: positions(facts.scoring, [scoring_id])[0] })),
      })}`,
      '按本次可修改章节的输入顺序逐项返回完整业务选择；输出条数必须相同。只选择位置，真实章节和业务 ID 由 Host 绑定。',
      '拆分时按章节职责分配父章要求；不得给每个子章机械复制全部父章关联。',
      '修改前的范围内业务归属列出父章原要求、评分及响应点。每项原归属都必须至少分配到一个职责相符的新可写叶节，不得因候选父节点不再可写、响应点已清空或更换标题而漏掉。',
      '父章变为不可写目录节点后，其业务要求必须按职责分配到实际承接的可写叶节；不能仅因子章节采用不同标题或这些要求较概括而丢弃父章覆盖。若一项要求由多个阶段共同回答，可分别绑定对应阶段。其他分支已有归属保持不变。',
      '不得写文件。最终只返回原始 JSON 数组，格式为：',
      JSON.stringify(zodJsonSchema(outputSchema)),
    ].join('\n') }],
  })
  try {
    const result = await run.result
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`BID_OUTLINE_BINDING_FAILED: ${result.stopReason}`)
    const output = outputSchema.parse(JSON.parse(
      result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    ) as unknown)
    if (output.length !== targets.length) throw new Error('BID_OUTLINE_BINDING_TARGET_COUNT_INVALID')
    const bindings = output.map((binding, index) => {
      if (Object.values(binding).some(values => new Set(values).size !== values.length)) {
        throw new Error('BID_OUTLINE_BINDING_REFERENCE_INVALID')
      }
      const responsePointIds = pick(facts.response_points, binding.response_point_positions)
      return outlineBusinessBindingSchema.parse({ section_id: targets[index]?.id,
        requirement_ids: pick(facts.requirements, binding.requirement_positions),
        scoring_ids: bindSectionResponsePoints(pick(facts.scoring, binding.scoring_positions), responsePointIds,
          { points: facts.response_points }).scoring_ids,
        scoring_response_point_ids: responsePointIds,
        compliance_ids: pick(facts.compliance, binding.compliance_positions) })
    })
    for (const key of ['requirement_ids', 'scoring_ids', 'scoring_response_point_ids', 'compliance_ids'] as const) {
      const assigned = new Set(bindings.flatMap(binding => binding[key]))
      if (before.sections.filter(section => selected.has(section.id))
        .some(section => (section[key] ?? []).some(id => !assigned.has(id)))) {
        throw new Error('BID_OUTLINE_BINDING_COVERAGE_MISSING: ' + key)
      }
    }
    return [...bindings, ...candidate.sections.filter(section => selected.has(section.id) && !section.writable)
      .map(section => ({ section_id: section.id, requirement_ids: [], scoring_ids: [],
        scoring_response_point_ids: [], compliance_ids: [] }))]
  } finally { await run.dispose() }
}

/** Optional user-feedback regeneration identity layered onto bounded, resumable S3 execution. */
export interface OutlineGenerationExecutionOptions extends ModelStageExecutionOptions {
  readonly regeneration?: { readonly feedback: string; readonly revision: number; readonly draftSha256: string }
}

/** Return the latest durable user feedback that requested an outline regeneration. */
function latestOutlineFeedback(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index--) {
    const event = agent.session.events[index]
    if (event?.type === 'bid.user_confirmation.received'
      && (event.data.stage === 'outline_generation' || event.data.stage === 'evidence_mapping')
      && !event.data.confirmed) return event.data.feedback
  }
  return undefined
}

/** Render the S3 semantic scoring analysis assignment. */
function renderResponsePointAnalysisTask(
  agent: Agent,
  task: BidStageTask,
  scoring: TenderScoringArtifact,
): string {
  return [
    `当前阶段：${task.stage} / 评分响应点分析`,
    `Bid Session：${agent.id}`,
    '以下是本次需要分析的评分项 JSON，由 Host 提供：',
    `<scoring-json>\n${JSON.stringify(scoring.scoring_items.map(({ id: _id, parent, ...item }, position) => ({ position, ...item,
      parent_position: parent === null ? null : scoring.scoring_items.findIndex(candidate => candidate.id === parent) })))}\n</scoring-json>`,
    '逐项理解评分语义，将每个评分项拆成一个或多个可独立回答、可独立审查，或在实际评分逻辑中明显独立评价的最小合理业务单元。重点识别原文明列事项、包括或包括但不限于的独立内容、编号或分号列项、逐项得分或扣分，以及虽在同一句但可独立编写审查的技术内容。',
    '不要按顿号、逗号、和、及或分值数量机械切分。完整、合理、可行、准确、符合要求等质量判断词不是独立写作主题，除非原文明确定义为分别响应的评价维度；不得凭常识新增原文没有依据的评分内容。',
    '返回前逐项自检：不得遗漏原文明列事项，不得错误合并独立内容，不得过度拆碎完整单义要求，不得把质量评价词误作主题，也不得新增原文没有的内容。',
    '典型逐项计分原文中的项目目标、预期成果、总体设计对相关政策与现有条件的符合性、软件技术路线、总体设计应分别保留；整体表述“总体方案完整、合理、可行，得5分”应保留为一个合理响应点，不得按分值拆成五项。',
    '每个评分位置至少一个响应点，返回 scoring_position 和 text；同一评分项的响应点按输出顺序排列。评分身份、响应点编号和连续 order 均由程序填写，不返回任何 ID。',
    '直接返回第一轮候选。Host 会持久化该候选，再交给独立语义复核 Child 检查遗漏、误拆和过度拆分。',
  ].join('\n')
}

/** Render the semantic review of one durable response-point candidate. */
function renderResponsePointReviewTask(
  agent: Agent,
  task: BidStageTask,
  scoring: TenderScoringArtifact,
  candidate: ScoringResponsePointCandidate,
): string {
  return [
    `当前阶段：${task.stage} / 评分响应点语义复核`,
    `Bid Session：${agent.id}`,
    'Host 已提供正式评分项和已持久化的第一轮候选；你不需要也不能读取工作区。',
    `<scoring-json>\n${JSON.stringify(scoring.scoring_items.map(({ id: _id, parent, ...item }, position) => ({ position, ...item,
      parent_position: parent === null ? null : scoring.scoring_items.findIndex(candidate => candidate.id === parent) })))}\n</scoring-json>`,
    `<response-point-candidate>\n${JSON.stringify({ points: candidate.points.map(({ scoring_id, text }) => ({
      scoring_position: scoring.scoring_items.findIndex(item => item.id === scoring_id), text })) })}\n</response-point-candidate>`,
    '逐项检查是否遗漏原文明列的独立内容、错误合并、过度拆碎，或把完整、合理、可行等质量判断词误作独立主题。',
    '只返回复核后的完整候选，每项为 scoring_position 和 text；评分身份、响应点编号和连续顺序均由程序绑定，不返回任何 ID。',
  ].join('\n')
}

interface OutlineSemanticInputs {
  readonly project: TenderProjectArtifact
  readonly requirements: TenderRequirementsArtifact
  readonly scoring: TenderScoringArtifact
  readonly compliance: TenderComplianceArtifact
  readonly catalog: ScoringResponsePointCatalog
  readonly frameworks: readonly OutlineFrameworkStructure[]
  readonly referenceBids: readonly OutlineFrameworkStructure[]
}

/** Render the no-tool initial outline assignment with every authoritative input embedded. */
function renderInitialOutlineTask(agent: Agent, task: BidStageTask, input: OutlineSemanticInputs): string {
  return [
    `当前阶段：${task.stage} / 初步目录生成`,
    `Bid Session：${agent.id}`,
    'Host 已提供完整权威输入。你不需要也不能读取工作区，只返回目录候选。',
    `<project-json>\n${JSON.stringify(input.project)}\n</project-json>`,
    `<outline-business-positions>\n${JSON.stringify(outlineModelInputView(input))}\n</outline-business-positions>`,
    `<reference-bid-structures>\n${JSON.stringify(input.referenceBids.map(({ name, headings }) => ({ name, headings })))}\n</reference-bid-structures>`,
    '人工框架决定主要骨架并且只有人工框架标题可以写入 framework_refs；reference_bid 只能参考目录组织，不得复制旧项目专有章节、不得写入 framework_refs，也不得优先于当前 Tender。',
    '根据当前 Project、Requirements、Scoring、Compliance 和稳定评分响应点设计技术标详细写作 Blueprint。每个响应点位置至少由一个合适的可写叶子覆盖，只选择 response_point_positions，正式身份和快照由程序绑定。',
    '评分响应点是章节要回答的要求，不等于目录标题；按技术方案的自然结构组织层级，不要机械地把每个响应点或评分项第一条提升成标题。仅当响应点本身构成独立方案主题时才用作标题。',
    '技术标目录只组织投标人需要展开的技术方案、实施措施和交付成果；只需材料核验的 Compliance 放入 global_compliance_positions。程序按子节点生成 writable 并清空结构节点的 must_answer 和响应点；叶节点必须有具体 must_answer。不得返回 writable。',
    '返回 document_title、global_compliance_positions、sections；sections 只放根章节，子章节嵌套在所属父章节的 children 数组中，叶章节返回 children: []。所有深度的子章节都遵守与根章节完全相同的节点字段和必填规则；Host 会完整递归校验后才接受目录。按语义直接组织这棵树，不计算或返回 parent_position。只选择业务位置和框架标题位置；父引用、节点编号、同级顺序、树层级、版本、scope 和所有业务身份由程序填写。',
    '不要生成“封面”“目录”或“技术偏离表”；Host 会确定性补入固定第一章，返回内容只负责第二章以后的动态技术正文目录。',
    ...task.constraints.map(constraint => `约束：${constraint}`),
  ].join('\n')
}

/** Render one no-tool semantic review of the exact current canonical outline. */
function renderStructuredQualityReviewTask(
  agent: Agent,
  task: BidStageTask,
  input: OutlineSemanticInputs,
  outline: OutlineArtifact,
  failure?: string,
): string {
  return [
    `当前阶段：${task.stage} / Blueprint Quality Review`,
    `Bid Session：${agent.id}`,
    'Host 已提供当前完整目录和全部权威输入。你不需要也不能读取或写入工作区。',
    `<outline-json>\n${JSON.stringify(outlineModelView(outline, input))}\n</outline-json>`,
    `<project-json>\n${JSON.stringify(input.project)}\n</project-json>`,
    `<outline-business-positions>\n${JSON.stringify(outlineModelInputView(input))}\n</outline-business-positions>`,
    `<reference-bid-structures>\n${JSON.stringify(input.referenceBids.map(({ name, headings }) => ({ name, headings })))}\n</reference-bid-structures>`,
    '逐项检查技术 Requirement、Scoring 和稳定 Response Point 是否在合适的可写叶子中真实覆盖；区分技术响应 Compliance 与全局材料核验，并检查章节颗粒度、must_answer、树结构、人工框架继承和旧项目污染。',
    '检查是否把细粒度评分响应点机械地提升成大标题；评分点应通过可写叶节的绑定与 must_answer 得到回答，目录层级由方案语义决定。',
    '只需材料核验的投标资格、企业证书和行政递交事项由 global_compliance_positions 覆盖，不为此新增可写章节或分配给技术叶子；已有全局 Compliance 不因缺少章节而算遗漏。',
    '程序按父子关系生成 writable，并清空结构父节的 must_answer 和响应点；父节只用 summary 概述。具体 Requirement、Scoring 和 RP 的作答指导放在可写叶节，不给父节补写作要求。',
    '若 update_section 修改 response_point_positions，同一操作必须提交该可写章节完整且具体的 must_answer；响应点只可由可写叶子承担。所有章节与业务引用只选择输入位置，不返回任何 ID。',
    '在本轮完成全部检查，把必须修正的问题一次性放入 operations，并自检应用这些操作后的完整目录；不要返回整本新目录。无需修正时返回 operations: []。措辞润色和可选补充放入 advisory issues，不要作为必须修改的操作。',
    'issues 只返回建议 message，用于仍可交给用户判断的非阻断建议；级别和问题类别由程序填写。阻断问题不能只写入 issues。reference_bid 不能产生 framework_refs。',
    '每条建议只返回 message，用中文说明具体业务问题；不要生成问题代码、编号、scope 或 severity。',
    failure === undefined ? '' : `上一轮结果未能应用：${failure}`,
  ].join('\n')
}

/**
 * Render the dynamic S3 assignment for the live Bid Agent.
 * @param agent Agent executing the outline-generation stage.
 * @param workspace Bid project workspace exposed to that Agent.
 * @param task Deterministic stage assignment.
 * @param regeneration Optional constrained regeneration request.
 * @param frameworks Imported outline frameworks available to the stage.
 * @returns Complete model instruction for the current S3 execution.
 */
export function renderOutlineGenerationTask(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  regeneration?: OutlineGenerationExecutionOptions['regeneration'],
  frameworks: readonly OutlineFrameworkStructure[] = [],
): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  const feedback = regeneration?.feedback ?? latestOutlineFeedback(agent)
  return [
    `当前阶段：${task.stage}`,
    `目标：${task.objective}`,
    `Bid Session：${agent.id}`,
    `Project Workspace：${root}`,
    '程序提供以下结构化 Artifact 的完整输入：',
    ...task.inputs.map(path => `- ${root}/${path}`),
    '本阶段不调用工具；程序提供完整结构化输入、执行目录变更和保存结果。不得重新进行全库资料映射。',
    ...(frameworks.length === 0 ? [
      '目录模式：无人工框架。以评分响应点和评分项为主要拆分依据，自主生成完整技术标目录，再用 mandatory Requirements、其他 Requirements 和 Compliance 补充。语义相近的评分响应点可以合并到同一技术主题；每个评分响应点位置必须至少落入一个合适的可写叶子，同一响应点可以由多个章节共同支撑。',
    ] : [
      '目录模式：存在人工框架。以下结构由 Host 从 manifest 中成功解析的 outline_framework 直接提取。第一个是 primary framework，决定主要层级和顺序；其余仅补充 primary 缺失的合理技术章节，不得打乱主要骨架。当前 Tender、稳定 Response Points、人工框架、reference_bid 结构、自主补充依次决定必须响应内容、语义颗粒度、整体组织、缺口参考和剩余补充。',
      '先按 primary framework 初始化骨架：精确覆盖时直接复用，过粗时保留父标题并增加子章节，缺失 Tender 必须内容时在合适位置新增，旧项目污染或非技术标标题才排除。无直接评分点但合理的技术章节可以保留；不得要求每个框架标题都绑定评分点。Framework 高于 reference_bid，但绝不覆盖当前 Tender。',
      `<outline-framework-structures>\n${JSON.stringify(frameworks)}\n</outline-framework-structures>`,
    ]),
    '根据 Project、Requirements、Scoring、Compliance 和稳定评分响应点目录设计技术标详细写作 Blueprint。此阶段不读取或推断证据映射。',
    '技术标目录只组织投标人需要展开的技术方案、实施措施和交付成果。投标资格、企业资质证书、行政递交或其他只需材料核验的 Compliance 放入 global_compliance_positions，不得为复述或解释这类要求单独创建可写章节；与技术任务混合时，章节只承担可作答的技术部分。',
    '仅返回结构化目录候选；程序保存目录并安排 Blueprint Quality Review，不调用工具或写文件。',
    '候选仅包含 document_title、global_compliance_positions、sections，不返回 schema_version、scope 或任何 ID。',
    'sections 是 parent_position 的扁平树。parent_position 指本轮 sections 下标，null 表示根；同级语义顺序由数组排列表达，order、层级和 writable 由程序派生。每个节点返回 title、purpose、must_answer、requirement_positions、scoring_positions、compliance_positions、origin、framework_refs、response_point_positions、suggested_tables、suggested_figures、writing_notes。origin 取 framework/generated/mixed；framework_refs 只选择 framework_position 与 heading_position。',
    '模型只选择 response_point_positions；程序绑定所有业务身份、合并所属评分关联并重建响应点快照。每个响应点至少由一个合适的可写叶子覆盖，也可由多个章节共同响应。',
    'writable 节点必须有至少一个具体 must_answer。父评分、子评分和通用质量评分可以同时关联。结构节点 writable=false、must_answer=[] 且必须有子节点。章节标题应按技术语义表达组织、阶段、质量、风险、安全、验收等内容，但不要套固定模板。',
    '不要创建“目录”章节。程序固定保留技术偏离表为可写第一章；封面和目录由导出程序生成，第二章以后才组织本项目的动态技术正文。',
    '技术响应索引、偏离表或合规清单只能作为索引或附录，不能集中承担正文覆盖。mandatory Requirement 和重点 Scoring 必须在对应的实质性可写叶子中映射；索引重复引用不能替代正文拆分。',
    '每个 Requirement、Scoring 和 Compliance 位置都必须至少覆盖一次；mandatory Requirement，以及 must_answer=true、带 score 或 score_range 的 Scoring，必须关联至少一个 writable 节点。同一业务位置可出现在多个章节，但同一数组不得重复。Compliance 可以放在 global_compliance_positions 或具体章节。',
    ...(feedback === undefined ? [] : [
      '以程序提供的当前目录位置视图为唯一修改基线；未被反馈涉及的章节必须保持不变。',
      ...(regeneration === undefined ? [] : [
        `当前基线 revision=${String(regeneration.revision)}，draft hash=${regeneration.draftSha256}。`,
        '保留已有节点提交 source_position，新增节点省略该字段。变更类型、实际章节身份、基线版本及哈希由程序计算和保存。',
      ]),
      renderOutlineRevisionFeedback(feedback),
    ]),
    ...task.constraints.map(constraint => `约束：${constraint}`),
    '返回语义候选后停止；程序绑定身份、校验树结构及覆盖，再保存结果。',
  ].join('\n')
}

/**
 * 将目录差集与正式响应点交给模型，只接受现有目录编辑操作。
 * @param agent 当前目录 Agent。
 * @param workspace 项目工作区。
 * @param task S3 任务。
 * @param issues 基础校验问题。
 * @param context 当前目录、正式清单及上一轮操作失败原因。
 * @returns 只写局部操作候选的修复任务。
 */
export function renderOutlineGenerationRepairTask(
  agent: Agent, workspace: BidWorkspace, task: BidStageTask, issues: readonly StageValidationIssue[],
  context: {
    outline: OutlineArtifact
    catalog: ScoringResponsePointCatalog
    scoring: TenderScoringArtifact
    failure?: string | undefined
    responsePointsOnly?: boolean
    associations?: {
      requirements: TenderRequirementsArtifact
      compliance: TenderComplianceArtifact
      frameworks: readonly OutlineFrameworkStructure[]
    }
  },
): string {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  const root = relative(workspace.root, workspace.projectRoot).replaceAll('\\', '/')
  const inputs: OutlineModelBindingInputs = {
    scoring: context.scoring, catalog: context.catalog,
    requirements: context.associations?.requirements ?? parseTenderRequirementsArtifact({ schema_version: 1, requirements: [] }),
    compliance: context.associations?.compliance ?? parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [] }),
    frameworks: context.associations?.frameworks ?? [],
  }
  const responsePointsOnly = context.responsePointsOnly ?? context.associations === undefined
  const missing = missingOutlineResponsePoints(context.outline, context.catalog).map((point) => {
    const item = context.scoring.scoring_items.find(item => item.id === point.scoring_id)
    if (item === undefined) throw new Error('正式响应点清单引用了未知评分项 ' + point.scoring_id)
    return { position: context.catalog.points.indexOf(point), text: point.text,
      scoring_position: context.scoring.scoring_items.indexOf(item), scoring_raw_text: item.raw_text }
  })
  return [
    '当前阶段：outline_generation / ' + (responsePointsOnly ? '局部响应点修复' : '局部关联与结构修复'),
    'Bid Session：' + agent.id,
    '正式响应点清单（只读，不得修改、删除或重新分配编号）：' + root + '/' + RESPONSE_POINT_CATALOG,
    JSON.stringify(outlineModelInputView(inputs)),
    '当前目录（包含 purpose、must_answer 和已有关联）：' + JSON.stringify(outlineModelView(context.outline, inputs)),
    '未被可写叶子覆盖的响应点及所属评分原文：' + JSON.stringify(missing),
    ...(context.associations === undefined ? [] : [
      '按问题选择 requirement_positions、scoring_positions、compliance_positions、framework_refs、origin 或 global_compliance_positions；新增或拆分章节时明确分配必要关联。已有全局覆盖的材料核验 Compliance 不分配给技术叶子。结构错误使用 move/add/delete/split/merge 或 repair_structure；层级和 writable 由程序根据 parent_position 派生。父节点的 must_answer 和响应点由程序清空，其要求仍须分配给合适的可写叶节。不得返回 writable。重复身份只能提交 regenerate_id=true，由程序分配新编号。',
    ]),
    ...renderStageRepairIssues(issues), context.failure ?? '',
    '判断已有章节能否承担：能则补充关联并完善具体 must_answer；update_section 修改 response_point_positions 时，同一操作必须提交该可写章节完整且具体的 must_answer。确实缺少内容时新增章节或局部拆分。保留未涉及章节的内容和相对顺序。不得默认挂到第一章、结构父节点或集中放入索引附录。只补关联没有实际写作指导不算修复。',
    '只返回局部编辑操作，不调用工具、不写文件。章节引用使用当前目录的 section_position、parent_position，业务引用只选择位置。response_point_positions 是章节最终选定的完整列表，保留已有合理关联。全部正式身份及新增编号由程序绑定，不返回任何 ID。',
    '返回 {"operations":[局部位置操作]}，程序应用并保存结果。',
  ].join('\n')
}

/**
 * Execute S3 through the live Agent and return its expected Artifacts.
 * @param agent - live Bid Agent used for Blueprint generation and repair.
 * @param workspace - Workspace 级 Bid 项目.
 * @param task - Host-issued outline-generation task and Tool policy.
 * @param options - Run authority plus the optional user-feedback regeneration identity.
 * @returns Artifact descriptors for the Orchestrator-owned formal validation boundary.
 */
export async function executeOutlineGeneration(
  agent: Agent,
  workspace: BidWorkspace,
  task: BidStageTask,
  options: OutlineGenerationExecutionOptions,
): Promise<StageArtifact[]> {
  if (task.stage !== 'outline_generation') throw new Error('outline-generation-executor-stage-invalid')
  await waitForModelStageIdle(agent, options.run.signal)
  const [frameworks, referenceBids] = await Promise.all([
    loadOutlineFrameworkStructures(workspace),
    loadReferenceBidStructures(workspace),
  ])
  const path = (artifact: string): string => join(workspace.projectRoot, artifact)
  const scratchRoot = join(workspace.projectRoot, 'runs', options.run.runId, 'scratch', 'outline-generation')
  const scratchPath = (artifact: string): string => join(scratchRoot, artifact)
  const scratchArtifacts = new Set<string>()
  const read = async (artifact: string): Promise<string | undefined> => {
    const candidate = scratchArtifacts.has(artifact) ? scratchPath(artifact) : path(artifact)
    await assertNoLinkedPath(workspace.root, candidate)
    try { return await readFile(candidate, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!scratchArtifacts.has(artifact)) return undefined
      await assertNoLinkedPath(workspace.root, path(artifact))
      try { return await readFile(path(artifact), 'utf8') } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== 'ENOENT') throw fallback
        return undefined
      }
    }
  }
  const write = async (artifact: string, value: unknown): Promise<void> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    await options.run.commits.writeJson(path(artifact), value)
    scratchArtifacts.delete(artifact)
    await rm(scratchPath(artifact), { force: true })
  }
  const remove = async (artifact: string): Promise<void> => {
    await assertNoLinkedPath(workspace.root, path(artifact))
    await options.run.commits.remove(path(artifact))
    const fs = agent.ctx.get('fs')
    if (fs !== undefined) agent.ctx.emit('fs/observed', await fs.resolve(path(artifact)), { kind: 'absent' }, { agent })
  }
  await assertNoLinkedPath(workspace.root, path('outline'))
  await mkdir(path('outline'), { recursive: true, mode: 0o700 })
  if (options.regeneration === undefined && await read('outline/initial-confirmed-outline.json') !== undefined) throw new Error('S3 已有用户确认目录，不能用失败重试覆盖确认结果。')
  const readInput = async <T>(artifact: string, parse: (value: unknown) => T): Promise<T> => {
    const raw = await read(artifact)
    try { return parse(JSON.parse(raw ?? 'null')) } catch (error) {
      throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_INVALID', artifact, message: '正式输入缺失或损坏：' + (error instanceof Error ? error.message : String(error)) }])
    }
  }
  const project = await readInput('analysis/project.json', parseTenderProjectArtifact)
  const scoring = await readInput('analysis/scoring.json', parseTenderScoringArtifact)
  const requirements = await readInput('analysis/requirements.json', parseTenderRequirementsArtifact)
  const compliance = await readInput('analysis/compliance.json', parseTenderComplianceArtifact)
  const validateResponsePointCandidate = (value: unknown): ScoringResponsePointCandidate => {
    try {
      const candidate = parseScoringResponsePointCandidate(typeof value === 'string' ? JSON.parse(value) : value)
      createScoringResponsePointCatalog(scoring, candidate)
      return candidate
    } catch (error) {
      throw new BidStageExecutionError([{
        code: 'OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID',
        artifact: RESPONSE_POINT_CANDIDATE,
        message: error instanceof Error ? error.message : String(error),
      }])
    }
  }
  const runStructuredChild = async <T>(request: {
    readonly label: string
    readonly prompt: string
    readonly outputSchema: ObjectJsonSchema
    readonly persona: string
    readonly parse: (value: unknown) => T
    readonly errorCode: string
    readonly artifact: string
    readonly recoveryUnit?: string
  }): Promise<T> => {
    const subagents = agent.ctx.get('subagents')
    if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
      throw new Error(`S3 ${request.label}需要独立上下文的 spawn provider。`)
    }
    await options.run.scheduler.waitUntilRunnable(options.run.signal)
    const diagnosticPath = `outline/diagnostics/${options.run.work.workId}-${createHash('sha256').update(request.artifact).digest('hex').slice(0, 8)}.json`
    let failedCandidate = ''
    if (options.recovery?.unit === request.artifact) {
      try {
        const raw = await read(diagnosticPath)
        const diagnostic = raw === undefined ? undefined : JSON.parse(raw) as { inputFingerprint?: string; candidate?: unknown }
        if (diagnostic?.inputFingerprint === options.run.work.inputFingerprint && diagnostic.candidate !== undefined) {
          failedCandidate = `\nHost 保存的当前 work 失败候选：${JSON.stringify(diagnostic.candidate)}`
        }
      } catch { /* 损坏诊断不能代替正式候选；原任务仍可重新生成。 */ }
    }
    const child = await subagents.start('spawn', {
      parent: agent,
      signal: options.run.signal,
      label: request.label,
      prompt: [{ type: 'text', text: [request.prompt,
        options.recovery?.workId === options.run.work.workId
          && (options.recovery.unit === request.artifact || options.recovery.unit === options.run.work.workId
            || (request.recoveryUnit ?? request.artifact) === OUTLINE_ARTIFACT && options.recovery.unit.startsWith('outline/'))
          ? renderBidRecoveryContext(options.recovery) : '',
        failedCandidate,
      ].filter(Boolean).join('\n') }],
      outputSchema: request.outputSchema,
      toolFilter: { allow: [] },
      maxDepth: 1,
      persona: request.persona,
    })
    try {
      const result = await child.result
      if (result.stopReason !== 'completed') throw new Error(`${request.label} Subagent 未正常完成：${result.stopReason}。${result.diagnostic ?? ''}`)
      if (result.structured === undefined) throw new BidStageExecutionError([{
        code: request.errorCode, artifact: request.artifact, message: `${request.label} Subagent 未返回结构化结果。`,
      }])
      try {
        return request.parse(result.structured)
      } catch (error: unknown) {
        const encoded = JSON.stringify(result.structured)
        if (encoded.length <= 80_000) {
          await write(diagnosticPath, {
            inputFingerprint: options.run.work.inputFingerprint,
            unit: request.artifact,
            candidate: result.structured,
          })
        } else {
          await write(diagnosticPath, {
            inputFingerprint: options.run.work.inputFingerprint,
            unit: request.artifact,
            candidateSha256: createHash('sha256').update(encoded).digest('hex'),
            candidateBytes: Buffer.byteLength(encoded),
          })
        }
        throw new BidStageExecutionError([{
          code: request.errorCode, artifact: request.artifact,
          message: error instanceof Error ? error.message : String(error),
        }])
      }
    } catch (error) {
      throw error
    } finally {
      await child.dispose()
    }
  }
  const generateResponsePointCandidate = async (
    label: string,
    prompt: string,
  ): Promise<ScoringResponsePointCandidate> => {
    return runStructuredChild({
      label,
      prompt,
      outputSchema: scoringResponsePointCandidateOutputSchema,
      persona: '你是评分响应点分析 Subagent。只分析 Host 注入的评分内容，不调用工具、不派生其他 Agent，并通过结构化输出返回完整候选。',
      parse: value => validateResponsePointCandidate(bindScoringResponsePointModelCandidate(scoring, value)),
      errorCode: 'OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID',
      artifact: RESPONSE_POINT_CANDIDATE,
    })
  }
  const inputVersion = createHash('sha256').update(JSON.stringify(await Promise.all(task.inputs.map(async input => [input, await read(input)])))).digest('hex')
  const previousVersion = await read('outline/generation-inputs.json')
  if (previousVersion !== undefined && await readInput('outline/generation-inputs.json', value => z.string().parse(value)) !== inputVersion) {
    throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_CHANGED', artifact: 'outline/generation-inputs.json', message: 'S3 正式输入版本已变化，不能继续使用当前候选。请按阶段重置流程更新输入；已保留目录与正式 RP 清单。' }])
  }
  await write('outline/generation-inputs.json', inputVersion)
  const catalogRaw = await read(RESPONSE_POINT_CATALOG)
  let catalog = catalogRaw === undefined ? undefined : await readInput(RESPONSE_POINT_CATALOG, parseScoringResponsePointCatalog)
  if (catalog === undefined && await read(OUTLINE_ARTIFACT) !== undefined) throw new BidStageExecutionError([
    { code: 'OUTLINE_GENERATION_INPUT_INVALID', artifact: RESPONSE_POINT_CATALOG, message: '已有目录候选缺少正式 RP 清单，不能通过重新分配编号恢复。' },
  ])
  if (catalog !== undefined && !catalogMatchesScoring(catalog, scoring)) {
    throw new BidStageExecutionError([{ code: 'OUTLINE_GENERATION_INPUT_MISMATCH', artifact: RESPONSE_POINT_CATALOG, message: '正式响应点清单与 S2 评分版本不匹配；不能通过重写正式输入修复候选。' }])
  }

  const artifacts: StageArtifact[] = [
    { stage: 'outline_generation', type: 'scoring_response_points', path: RESPONSE_POINT_CATALOG },
    { stage: 'outline_generation', type: 'outline', path: OUTLINE_ARTIFACT },
    { stage: 'outline_generation', type: 'outline_quality_report', path: QUALITY_REPORT_ARTIFACT },
  ]
  const canonicalOutlineRaw = await read(OUTLINE_ARTIFACT)
  const qualityReportRaw = await read(QUALITY_REPORT_ARTIFACT)
  const draftRaw = await read('outline/draft.json')
  if (options.regeneration === undefined && (qualityReportRaw !== undefined || draftRaw !== undefined)) {
    let complete = false
    if (catalog !== undefined && canonicalOutlineRaw !== undefined && qualityReportRaw !== undefined && draftRaw !== undefined) {
      try {
        const candidate = inspectOutlineCandidate(canonicalOutlineRaw, catalog, scoring)
        if (candidate.kind === 'valid') {
          parseOutlineQualityReport(JSON.parse(qualityReportRaw))
          const draft = parseOutlineDraft(JSON.parse(draftRaw))
          const hash = outlineArtifactSha256(candidate.outline)
          complete = outlineArtifactSha256(parseOutlineArtifact({
            ...candidate.outline, sections: ensureTechnicalDeviationSection(candidate.outline.sections),
          })) === hash
            && draft.source_outline_sha256 === hash
            && draft.draft_outline_sha256 === hash
            && outlineArtifactSha256(draft.outline) === hash
            && (await validateOutlineGeneration(workspace, 'outline_generation', artifacts)).ok
          if (complete) {
            options.run.reportProgress({
              phase: 'finalizing', summary: '已恢复已完成的目录与质量报告',
              completed: candidate.outline.sections.length, total: candidate.outline.sections.length,
            })
            return artifacts
          }
        }
      } catch { /* 不完整或陈旧的 final checkpoint 只使报告失效。 */ }
    }
    if (!complete) await options.run.commits.publish(async (lease) => {
      await lease.remove(path(QUALITY_REPORT_ARTIFACT))
      await lease.remove(path('outline/draft.json'))
    })
  }

  if (catalog === undefined) {
    if (options.regeneration !== undefined) throw new Error('目录重新生成缺少有效的正式响应点清单。')
    const rawCandidate = await read(RESPONSE_POINT_CANDIDATE)
    let candidate: ScoringResponsePointCandidate
    if (rawCandidate === undefined) {
      options.run.reportProgress({
        phase: 'analyzing', summary: '正在拆解评分响应点', total: scoring.scoring_items.length,
        details: [`评分项 ${String(scoring.scoring_items.length)} 项`],
      })
      candidate = await generateResponsePointCandidate('评分响应点分析', renderResponsePointAnalysisTask(agent, task, scoring))
      await write(RESPONSE_POINT_CANDIDATE, candidate)
    } else {
      candidate = validateResponsePointCandidate(rawCandidate)
      options.run.reportProgress({
        phase: 'analyzing', summary: '已恢复评分响应点候选，继续语义复核', total: scoring.scoring_items.length,
      })
    }
    options.run.reportProgress({
      phase: 'analyzing', summary: '正在复核评分响应点', total: candidate.points.length,
    })
    const reviewedCandidate = await generateResponsePointCandidate(
      '评分响应点语义复核', renderResponsePointReviewTask(agent, task, scoring, candidate),
    )
    catalog = createScoringResponsePointCatalog(scoring, reviewedCandidate)
    await write(RESPONSE_POINT_CATALOG, catalog)
    await remove(RESPONSE_POINT_CANDIDATE)
  } else {
    await remove(RESPONSE_POINT_CANDIDATE)
    options.run.reportProgress({ phase: 'analyzing', summary: '已恢复正式评分响应点清单', total: catalog.points.length })
  }
  const formalCatalog = catalog
  const semanticInputs: OutlineSemanticInputs = {
    project, requirements, scoring, compliance, catalog: formalCatalog, frameworks, referenceBids,
  }

  const generated = options.regeneration !== undefined || canonicalOutlineRaw === undefined
  if (generated) {
    await remove(REPAIR_RECEIPT)
    options.run.reportProgress({
      phase: 'generating',
      summary: options.run.resumeOf === undefined || options.regeneration !== undefined
        ? '正在生成初步技术标目录' : '已恢复 S3，评分响应点已完成，继续生成初步目录',
      total: formalCatalog.points.length,
      details: [`评分响应点 ${String(formalCatalog.points.length)} 项`],
    })
    if (options.regeneration === undefined) {
      const initial = await runStructuredChild({
        label: '初步目录生成',
        prompt: renderInitialOutlineTask(agent, task, semanticInputs),
        outputSchema: outlineCandidateOutputSchema,
        persona: '你是技术标初步目录生成 Subagent。只使用 Host 注入的结构化输入，不调用工具、不派生其他 Agent，并通过结构化输出返回目录候选。',
        parse: value => bindOutlineModelCandidate(value, semanticInputs),
        errorCode: 'OUTLINE_GENERATION_CANDIDATE_INVALID',
        artifact: OUTLINE_ARTIFACT,
      })
      await write(OUTLINE_ARTIFACT, initial)
    } else {
      const baseline = await readInput('outline/draft.json', parseOutlineDraft)
      const regenerated = await runStructuredChild({
        label: '目录整本重生成',
        prompt: [renderInitialOutlineTask(agent, task, semanticInputs),
          renderOutlineRevisionFeedback(options.regeneration.feedback),
          `唯一目录基线：${JSON.stringify(outlineModelView(baseline.outline, semanticInputs))}`,
          '保留已有节点时提交 source_position，指向唯一目录基线的节点位置；新增节点省略 source_position。根章节放在 sections，子章节嵌套在父章节的 children，叶章节 children: []，不得计算本轮父位置。未涉及节点保留内容、父子关系及相对顺序。实际变更清单与全部身份由程序生成。',
        ].join('\n'),
        outputSchema: outlineCandidateOutputSchema,
        persona: '你是技术标目录整本重生成 Subagent。只根据完整输入和用户反馈返回位置候选，不调用工具、不返回 ID。',
        parse: value => bindOutlineModelCandidate(value, semanticInputs, baseline.outline),
        errorCode: 'OUTLINE_GENERATION_CANDIDATE_INVALID',
        artifact: OUTLINE_ARTIFACT,
      })
      await write(OUTLINE_ARTIFACT, regenerated)
      await write(REGENERATION_CHANGE_SET, {
        schema_version: 1, base_revision: options.regeneration.revision, base_draft_sha256: options.regeneration.draftSha256,
        changes: outlineRegenerationChanges(baseline.outline, parseOutlineArtifact({ ...regenerated,
          sections: regenerated.sections.map(section => ({ ...section, scoring_response_points: [] })) }))
          .map(change => ({ ...change, reason: options.regeneration?.feedback ?? '' })),
      })
    }
  }
  const validate = async (outline: OutlineArtifact): Promise<StageValidationIssue[]> => {
    const issues: StageValidationIssue[] = []
    const customerTextContext = { outline, requirements, scoring, compliance, responsePoints: formalCatalog }
    for (const field of customerFacingOutlineText(outline)) {
      const leaked = findBidInternalIdentifiers(field.text, customerTextContext)
      if (leaked.length > 0) {
        issues.push({
          code: 'OUTLINE_GENERATION_INTERNAL_ID_VISIBLE',
          message: `${field.path} 包含系统内部编号 ${leaked.join('、')}；请改用招标文件原有编号或自然语言。`,
          path: field.path,
        })
      }
    }
    validateOutlineSharedStructure(outline.sections, issues)
    validateOutlineSharedCoverage(outline, requirements, scoring, compliance, formalCatalog, issues)
    await validateOutlineFrameworkRefs(workspace, outline, issues)
    return issues
  }

  const publishOutline = async (outline: OutlineArtifact, receipt?: unknown): Promise<void> => {
    await options.run.commits.publish(async (lease) => {
      await lease.writeJson(path(OUTLINE_ARTIFACT), outline)
      if (receipt === undefined) await lease.remove(path(REPAIR_RECEIPT))
      else await lease.writeJson(path(REPAIR_RECEIPT), receipt)
      await lease.remove(path(QUALITY_REPORT_ARTIFACT))
    })
    for (const artifact of [OUTLINE_ARTIFACT, REPAIR_RECEIPT]) {
      scratchArtifacts.delete(artifact)
      await rm(scratchPath(artifact), { force: true })
    }
  }
  const raw = (await read(OUTLINE_ARTIFACT)) ?? ''
  const candidate = inspectOutlineCandidate(raw, formalCatalog, scoring)
  if (candidate.kind === 'format') throw new BidStageExecutionError(candidate.issues)

  const savedRepair = await read(REPAIR_RECEIPT) !== undefined
  if (savedRepair) await readInput(REPAIR_RECEIPT, value => z.array(z.unknown()).parse(value))
  let repairUsed = false
  let outline: OutlineArtifact
  if (candidate.kind === 'fields') {
    if (candidate.issues.some(issue => issue.field === null || issue.field === 'sections')) throw new BidStageExecutionError([
      ...candidate.issues, { code: 'OUTLINE_CANDIDATE_UNRECOVERABLE', artifact: OUTLINE_ARTIFACT,
        message: '候选缺少可恢复的目录或章节对象；字段修复不能重生成整章或整本目录，已保留原始候选。' },
    ])
    options.run.reportProgress({ phase: 'repairing', summary: '正在修正目录确定性问题', completed: 0, total: 1,
      details: candidate.issues.slice(0, 5).map(issue => `${issue.code}：${issue.message}`) })
    const output = 'outline/candidate-repair.json'
    await remove(output)
    const fieldRepairSchema = z.object({ operations: outlineModelCandidateRepairSchema }).strict()
    const repairedFields = await runStructuredChild({
      label: '目录候选字段修复',
      prompt: [
        '当前阶段：outline_generation / 候选字段修复',
        '问题位置与原因：' + JSON.stringify(candidate.issues.map(issue => ({ ...issue,
          field: issue.field === null ? null : outlineModelFieldName(issue.field) }))),
        '原始候选（只读）：\n' + raw,
        '只输出已定位字段的局部操作。section_index 指原始数组下标；禁止整章或整本替换。业务引用字段使用 *_positions 及位置值，不能填写原始 ID。未知关联必须根据原文重新明确选择合法位置，不能清空、模糊替换或默认挂到某章。响应点快照由程序派生，修复快照只选择 response_point_positions。删除额外字段用 remove=true。\n' + JSON.stringify(zodJsonSchema(outlineModelCandidateRepairSchema)),
        '权威输入（只读，不得修改）：' + JSON.stringify(outlineModelInputView(semanticInputs)),
        '不调用工具、不写文件，只返回 operations，由程序执行修改并保存。',
      ].join('\n'),
      outputSchema: subagentOutputSchema(fieldRepairSchema),
      persona: '你是目录候选字段语义修复 Subagent，只返回指定字段的位置选择或业务内容，不返回 ID。',
      parse: value => fieldRepairSchema.parse(value),
      errorCode: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: output, recoveryUnit: OUTLINE_ARTIFACT,
    })
    let operations: unknown
    try {
      const sectionIds = z.object({ sections: z.array(z.object({ id: z.string() }).loose()) }).parse(candidate.value).sections
      operations = bindOutlineModelCandidateRepairs(repairedFields.operations, sectionIds, semanticInputs)
      const repaired = applyOutlineCandidateRepair(candidate.value, operations, candidate.issues,
        { catalog: formalCatalog, scoring, requirements, compliance, frameworks })
      const inspected = inspectOutlineCandidate(JSON.stringify(repaired), formalCatalog, scoring)
      if (inspected.kind !== 'valid') throw new BidStageExecutionError(inspected.issues)
      outline = inspected.outline
    } catch (error) {
      if (options.run.signal.aborted || error instanceof BidStageExecutionError) throw error
      throw new BidStageExecutionError([...candidate.issues, {
        code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: output,
        message: error instanceof Error ? error.message : String(error),
      }])
    }
    outline = parseOutlineArtifact({
      ...outline, sections: ensureTechnicalDeviationSection(outline.sections),
    })
    await publishOutline(outline, operations)
    repairUsed = true
  } else {
    outline = candidate.outline
    outline = parseOutlineArtifact({
      ...outline, sections: ensureTechnicalDeviationSection(outline.sections),
    })
    if (generated) await publishOutline(outline)
    else if (canonicalOutlineRaw !== JSON.stringify(outline)) await write(OUTLINE_ARTIFACT, outline)
  }

  options.run.reportProgress({
    phase: 'validating',
    summary: options.run.resumeOf === undefined ? '正在校验目录结构与响应覆盖'
      : repairUsed ? '已恢复 S3，目录修复已保存，继续复核修复结果' : '已恢复 S3，目录候选已保存，继续进行确定性校验',
    completed: outline.sections.length,
    total: outline.sections.length,
    details: [`目录节点 ${String(outline.sections.length)} 个`, `评分响应点 ${String(formalCatalog.points.length)} 项`],
  })
  let issues = await validate(outline)
  if (issues.length > 0) {
    if (repairUsed) throw new BidStageExecutionError([...issues, {
      code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', artifact: REPAIR_RECEIPT,
      message: '当前目录候选已经使用过一次确定性修复，仍未通过校验。',
    }])
    options.run.reportProgress({ phase: 'repairing', summary: '正在修正目录确定性问题', completed: 0, total: 1,
      details: issues.slice(0, 5).map(issue => `${issue.code}：${issue.message}`) })
    const rpOnly = issues.every(issue => issue.code.includes('RESPONSE_POINT'))
    const localRepairSchema = z.object({ operations: z.array(rpOnly
      ? outlineModelResponsePointRepairOperationSchema : outlineModelRepairOperationSchema) }).strict()
    const repair = await runStructuredChild({
      label: '目录局部修复',
      prompt: renderOutlineGenerationRepairTask(agent, workspace, task, issues, {
        outline, catalog: formalCatalog, scoring, responsePointsOnly: rpOnly,
        associations: { requirements, compliance, frameworks },
      }),
      outputSchema: subagentOutputSchema(localRepairSchema),
      persona: '你是目录局部语义修复 Subagent，只返回 operations 的节点和业务位置选择，不调用工具、不返回 ID。',
      parse: value => localRepairSchema.parse(value),
      errorCode: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: REPAIR_RECEIPT, recoveryUnit: OUTLINE_ARTIFACT,
    })
    let operations: unknown
    let repaired: OutlineArtifact
    try {
      operations = bindOutlineModelRepairOperations(repair.operations, outline, semanticInputs, rpOnly)
      await write(REPAIR_RECEIPT, operations)
      repaired = applyOutlineModelRepair(outline, operations, formalCatalog, scoring)
      repaired = parseOutlineArtifact({ ...repaired, sections: ensureTechnicalDeviationSection(repaired.sections) })
    } catch (error) {
      if (options.run.signal.aborted) throw error
      throw new BidStageExecutionError([...issues, {
        code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: REPAIR_RECEIPT,
        message: error instanceof Error ? error.message : String(error),
      }])
    }
    const repairedIssues = await validate(repaired)
    const prior = [...issues]
    const introduced = repairedIssues.filter((issue) => {
      if (issue.code.endsWith('_MISSING')) return false
      const index = prior.findIndex(previous => previous.code === issue.code
          && previous.path === issue.path && previous.message === issue.message)
      if (index < 0) return true
      prior.splice(index, 1)
      return false
    })
    if (introduced.length > 0) throw new BidStageExecutionError([...issues, {
      code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: REPAIR_RECEIPT,
      message: '局部操作引入非法引用或结构，未保存：' + JSON.stringify(introduced),
    }])
    outline = repaired
    issues = repairedIssues
    await publishOutline(outline, operations)
    repairUsed = true
    if (issues.length > 0) throw new BidStageExecutionError([...issues, {
      code: 'OUTLINE_GENERATION_REPAIR_EXHAUSTED', artifact: REPAIR_RECEIPT,
      message: '唯一一次确定性修复后仍有问题，已保留修复后的目录候选。',
    }])
  }

  options.run.reportProgress({
    phase: 'reviewing',
    summary: canonicalOutlineRaw === undefined ? '正在进行目录质量复核' : '已恢复目录候选，继续质量复核',
    completed: outline.sections.length,
    total: outline.sections.length,
  })
  let reviewFailure: string | undefined
  let qualityIssues: Pick<OutlineQualityIssue, 'message'>[] | undefined
  let reviewRounds = 0
  while (qualityIssues === undefined) {
    let review: { operations: z.infer<typeof outlineAssociationRepairOperationSchema>[]; issues: Pick<OutlineQualityIssue, 'message'>[] }
    try {
      review = await runStructuredChild({
        label: '目录质量复核',
        prompt: renderStructuredQualityReviewTask(agent, task, semanticInputs, outline, reviewFailure),
        outputSchema: outlineQualityReviewOutputSchema,
        persona: '你是技术标目录质量复核 Subagent。只使用 Host 注入的结构化输入，不调用工具、不派生其他 Agent，只返回局部 operations 和 advisory issues。',
        parse: (value) => {
          const result = outlineQualityReviewResultSchema.parse(value)
          return { ...result, operations: bindOutlineModelRepairOperations(result.operations, outline, semanticInputs) }
        },
        errorCode: 'OUTLINE_GENERATION_REVIEW_INVALID',
        artifact: OUTLINE_ARTIFACT,
      })
      if (review.operations.length === 0) {
        qualityIssues = review.issues
        break
      }
      let reviewed = applyOutlineModelRepair(outline, review.operations, formalCatalog, scoring)
      reviewed = parseOutlineArtifact({
        ...reviewed, sections: ensureTechnicalDeviationSection(reviewed.sections),
      })
      const reviewedIssues = await validate(reviewed)
      if (reviewedIssues.length > 0) throw new Error(JSON.stringify(reviewedIssues))
      if (outlineArtifactSha256(reviewed) === outlineArtifactSha256(outline)) throw new Error('operations 没有产生实际变化。')
      outline = reviewed
      await publishOutline(outline, review.operations)
      qualityIssues = review.issues
      break
    } catch (error) {
      if (options.run.signal.aborted) throw error
      reviewFailure = error instanceof Error ? error.message : String(error)
    }
    if (reviewRounds >= options.maxRepairAttempts) throw new BidStageExecutionError([{
      code: 'OUTLINE_GENERATION_REVIEW_NOT_CONVERGED', artifact: OUTLINE_ARTIFACT,
      message: `目录质量复核结果无法应用：${reviewFailure}`,
    }])
    reviewRounds += 1
  }
  const reviewed = outline
  const report = {
    schema_version: OUTLINE_QUALITY_REPORT_SCHEMA_VERSION,
    scope: 'technical_bid' as const,
    issues: qualityIssues.map(issue => ({ ...issue, severity: 'advisory' as const, code: 'OUTLINE_QUALITY_ADVISORY' })),
    checked_requirement_ids: requirements.requirements.map(item => item.id),
    checked_scoring_ids: scoring.scoring_items.map(item => item.id),
    checked_scoring_response_point_ids: formalCatalog.points.map(point => point.id),
    reviewed_section_ids: reviewed.sections.map(section => section.id),
  }
  await options.run.commits.publish(async (lease) => {
    await lease.writeJson(path(OUTLINE_ARTIFACT), reviewed)
    await lease.writeJson(path(QUALITY_REPORT_ARTIFACT), report)
    if (options.regeneration === undefined) {
      const hash = outlineArtifactSha256(reviewed)
      await lease.writeJson(path('outline/draft.json'), {
        schema_version: 1,
        scope: 'technical_bid',
        revision: 1,
        source_outline_sha256: hash,
        draft_outline_sha256: hash,
        outline: reviewed,
      } satisfies OutlineDraftView)
    }
  })
  scratchArtifacts.delete(OUTLINE_ARTIFACT)
  await rm(scratchPath(OUTLINE_ARTIFACT), { force: true })

  if (options.regeneration !== undefined) {
    const draft = parseOutlineDraft(JSON.parse((await read('outline/draft.json')) ?? 'null'))
    const changeSet = parseOutlineRegenerationChangeSet(JSON.parse((await read(REGENERATION_CHANGE_SET)) ?? 'null'))
    await write(REGENERATION_CHANGE_SET, { ...changeSet, changes: outlineRegenerationChanges(draft.outline, reviewed).map(change => ({
      ...change, reason: changeSet.changes.find(item => item.section_id === change.section_id && item.type === change.type)?.reason ?? '响应点覆盖修复及目录质量复核',
    })) })
  }
  options.run.reportProgress({
    phase: 'finalizing', summary: '正在执行最终目录校验',
    completed: reviewed.sections.length, total: reviewed.sections.length,
  })
  await waitForModelStageIdle(agent, options.run.signal)
  return artifacts
}
