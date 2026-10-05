/** 只读任务核验：语义来自原始来源，目录、文件和章节身份由 Host 核对。 */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import { bidCapabilityInputSchema, type BidCapabilityTask } from './bid-capability-contract.ts'
import type { BidTaskSourceSnapshot } from './bid-task-source.ts'
import { bidInputFingerprint } from './work-descriptor.ts'
import { capabilityFileHash } from './bid-capability-files.ts'
import { readFile } from 'node:fs/promises'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import { readChapterLocations } from './chapter-storage.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { validateWritingCapability } from './bid-writing-capability.ts'
import { parseChapterReviewArtifact } from './chapter-writing-review-artifacts.ts'
import { zodJsonSchema } from './zod-json-schema.ts'
import { indexChapterContentBlocks } from './chapter-content-reuse.ts'
import { parseChapterMetadata } from './chapter-writing-artifacts.ts'
import { normalizeFlowchartInputs } from './flowchart.ts'
import { resolveBidTaskSections } from './bid-task-sections.ts'
import { attachBidTaskEvidenceReader } from './bid-task-evidence-reader.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const evidenceSchema = z.object({ path: z.string().min(1), sha256: hash }).strict()
const evidenceReferenceSchema = evidenceSchema.extend({ sha256: hash.optional() })
const requirementSchema = z.object({
  source_id: z.string().min(1),
  source_quote: z.string().trim().min(1).optional(),
  description: z.string().min(1),
  object: z.enum(['outline', 'content', 'evidence', 'writing_plan', 'review', 'export']),
  section_ids: z.array(z.string().min(1)),
  new_children: z.boolean(),
  completed_content: z.boolean(),
  repair: z.boolean(),
  preserve_migrated_content: z.boolean().default(false),
}).strict()
const capabilityIdSchema = z.enum(bidCapabilityInputSchema.options.map(option => option.shape.capability.value))
const scopeConstraintSchema = z.object({ source_id: z.string().min(1), quote: z.string().trim().min(1),
  forbidden_capabilities: z.array(capabilityIdSchema).min(1) }).strict()
const decisionSchema = z.object({
  scope_authorized: z.boolean(),
  relevant_issue_ids: z.array(z.string().min(1)),
  requirements: z.array(requirementSchema).min(1),
  scope_constraints: z.array(scopeConstraintSchema).default([]),
  checks: z.array(z.object({ requirement_index: z.number().int().nonnegative(),
    met: z.boolean(), reason: z.string().min(1), evidence: z.array(evidenceReferenceSchema) }).strict()),
}).strict()
const semanticCheckSchema = z.object({ met: z.boolean(), reason: z.string().min(1),
  evidence_positions: z.array(z.number().int().nonnegative()) }).strict()
const semanticRequirementSchema = requirementSchema.omit({ source_id: true, section_ids: true, description: true })
  .extend({ source_quote: z.string().trim().min(1), check: semanticCheckSchema }).strict()
const modelPlanSchema = z.object({ scope_authorized: z.boolean(), scope_constraints: z.array(scopeConstraintSchema
  .omit({ source_id: true }).extend({ source_position: z.number().int().nonnegative() }).strict()), sources: z.array(z.object({
  relevant: z.boolean(), requirements: z.array(semanticRequirementSchema),
}).strict()).min(1) }).strict()
const modelResultSchema = z.object({ checks: z.array(semanticCheckSchema) }).strict()

function verificationSources(input: BidTaskVerificationInput) {
  const selected = new Set(input.source.issues.map(issue => issue.issue_id))
  const issues = new Map([...input.source.observed_issues, ...input.source.issues].map(issue => [issue.issue_id, issue]))
  return [{ id: input.source.message.message_id, sectionIds: null,
    content: { kind: 'message' as const, text: input.source.message.text,
      context_messages: input.source.context_messages?.map(message => message.text) ?? [], selected: true } },
  ...[...issues.values()].map(issue => ({ id: issue.issue_id, sectionIds: [issue.section_id],
    content: { kind: 'issue' as const, text: issue.instruction, suggestion: issue.suggestion,
      scope: issue.scope, selected: selected.has(issue.issue_id), section_title: issue.section_title,
      selected_text: issue.reference.scope === 'paragraphs' ? issue.reference.text : null } }))]
}

function taskRequirementSections(input: BidTaskVerificationInput): string[] {
  if (input.task.scope.kind === 'sections') return [...input.task.scope.section_ids]
  if (input.task.scope.kind === 'paragraphs') return [input.task.scope.reference.section_id]
  return [...new Set(input.task.steps.flatMap(step => step.call.capability !== 'outline.update' ? []
    : step.call.input.operations.flatMap(operation => operation.type === 'split_section' ? [operation.section_id]
      : operation.type === 'add_section' && operation.parent_id !== null ? [operation.parent_id] : [])))]
}

function validateScopeConstraints(input: BidTaskVerificationInput,
  constraints: readonly z.infer<typeof scopeConstraintSchema>[]): string[] {
  const sources = verificationSources(input)
  const unmet: string[] = []
  for (const constraint of constraints) {
    const source = sources.find(item => item.id === constraint.source_id)
    const texts = source === undefined ? [] : source.content.kind === 'message'
      ? [source.content.text, ...source.content.context_messages] : [source.content.text, source.content.suggestion ?? '']
    if (!texts.some(text => text.includes(constraint.quote))) throw new Error('BID_TASK_VERIFICATION_CONSTRAINT_SOURCE_INVALID')
    if (input.task.steps.some(step => constraint.forbidden_capabilities.includes(step.call.capability))) {
      unmet.push('计划包含用户原话禁止的能力：' + constraint.quote)
    }
  }
  return unmet
}

function bindSemanticDecision(input: BidTaskVerificationInput, value: unknown,
  reads: ReadonlyMap<number, readonly { start: number; end: number }[]>): z.infer<typeof decisionSchema> {
  const bindCheck = ({ evidence_positions, ...check }: z.infer<typeof semanticCheckSchema>,
    requirement: BidTaskRequirement | z.infer<typeof semanticRequirementSchema>) => {
    if (new Set(evidence_positions).size !== evidence_positions.length) throw new Error('BID_TASK_VERIFICATION_EVIDENCE_INVALID')
    const evidence = evidence_positions.map((position) => {
      const file = input.evidence[position]
      if (file === undefined) throw new Error('BID_TASK_VERIFICATION_EVIDENCE_INVALID')
      let end = 0
      const ranges = reads.get(position)
      if (ranges === undefined) throw new Error(`BID_TASK_VERIFICATION_EVIDENCE_UNREAD: evidence_position=${position} 尚未读取；请从 start=0 读取完整文件。`)
      for (const range of ranges) {
        if (range.start > end) break
        end = Math.max(end, range.end)
      }
      if (end < file.text.length) throw new Error(`BID_TASK_VERIFICATION_EVIDENCE_UNREAD: evidence_position=${position} 仍有未读区间；请从 start=${end} 继续读取至 total_characters=${file.text.length}。`)
      return { path: file.path, sha256: file.sha256 }
    })
    if (input.phase === 'result' && check.met && (requirement.completed_content
      || requirement.preserve_migrated_content || requirement.object === 'content')) {
      const cited = new Set(evidence.map(file => file.path))
      const missing = input.evidence.flatMap((file, position) =>
        /^chapters\/(?:sections|meta|reviews)\//u.test(file.path) && !cited.has(file.path)
          ? [{ evidence_position: position, path: file.path }] : [])
      if (missing.length > 0) {
        throw new Error('BID_TASK_VERIFICATION_EVIDENCE_UNREAD: 本项完成结论未引用全部范围内正文、元数据和审核；'
          + '请完整读取并在本项 evidence_positions 中引用这些缺失索引：' + JSON.stringify(missing))
      }
    }
    return { ...check, evidence }
  }
  if (input.requirements !== undefined) {
    const result = modelResultSchema.parse(value)
    if (result.checks.length !== input.requirements.length) throw new Error('BID_TASK_VERIFICATION_CHECKS_INVALID')
    const checks: z.infer<typeof decisionSchema>['checks'] = []
    for (const [requirement_index, requirement] of input.requirements.entries()) {
      const check = result.checks[requirement_index]
      if (check === undefined) throw new Error('BID_TASK_VERIFICATION_CHECKS_INVALID')
      checks.push({ ...bindCheck(check, requirement), requirement_index })
    }
    return decisionSchema.parse({ scope_authorized: true,
      relevant_issue_ids: [...new Set(input.requirements.map(item => item.source_id)
        .filter(id => id !== input.source.message.message_id))], requirements: input.requirements,
      scope_constraints: input.scope_constraints ?? [], checks })
  }
  const result = modelPlanSchema.parse(value)
  const sources = verificationSources(input)
  const constraints = result.scope_constraints.map(({ source_position, ...constraint }) => {
    const source = sources[source_position]
    if (source === undefined) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
    return { ...constraint, source_id: source.id }
  })
  const prohibited = validateScopeConstraints(input, constraints)
  if (prohibited.length > 0 && result.scope_authorized
    && result.sources.every(source => source.requirements.every(requirement => requirement.check.met))) {
    throw new Error('BID_TASK_VERIFICATION_PLAN_CONSTRAINT_CONFLICT: ' + prohibited.join('；'))
  }
  if (result.sources.length !== sources.length) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
  const requirements: BidTaskRequirement[] = []
  const checks: z.infer<typeof decisionSchema>['checks'] = []
  const relevant: string[] = []
  for (const [index, source] of sources.entries()) {
    const decision = result.sources[index]
    if (decision === undefined) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
    if (!decision.relevant) {
      if (decision.requirements.length !== 0) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
      continue
    }
    if (decision.requirements.length === 0) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
    if (index > 0) relevant.push(source.id)
    for (const { check, ...requirement } of decision.requirements) {
      const texts = source.content.kind === 'message' ? [source.content.text, ...source.content.context_messages]
        : [source.content.text, source.content.suggestion ?? '']
      if (!texts.some(text => text.includes(requirement.source_quote))) throw new Error('BID_TASK_VERIFICATION_REQUIREMENT_SOURCE_INVALID')
      checks.push({ ...bindCheck(check, { ...requirement, check }), requirement_index: requirements.length })
      requirements.push({ ...requirement, description: requirement.source_quote, source_id: source.id,
        section_ids: source.sectionIds ?? taskRequirementSections(input) })
    }
  }
  return decisionSchema.parse({ scope_authorized: result.scope_authorized,
    relevant_issue_ids: relevant, requirements, scope_constraints: constraints, checks })
}

/** 持久核验包含输入身份、逐项结论和 Host 事实检查后的状态。 */
export const bidTaskVerificationSchema = decisionSchema.extend({
  checks: z.array(decisionSchema.shape.checks.element.extend({ evidence: z.array(evidenceSchema) })),
  phase: z.enum(['plan', 'result']),
  input_sha256: hash,
  plan_sha256: hash,
  source_sha256: hash.optional(),
  goal_met: z.boolean(),
  unmet: z.array(z.string()),
  deferred_export: z.boolean(),
}).strict()

/** 原始来源和候选字节均相同时可复用的核验记录。 */
export type BidTaskVerification = z.infer<typeof bidTaskVerificationSchema>
/** 不可变验收要求；计划补丁不能删除原要求。 */
export type BidTaskRequirement = z.infer<typeof requirementSchema>
/** Host 提供的完整证据；不存在截断片段。 */
export interface BidTaskVerificationInput {
  readonly phase: 'plan' | 'result'
  readonly source: BidTaskSourceSnapshot
  readonly task: BidCapabilityTask
  /** 同一不可变请求已通过授权核验的验收要求；后续模型只判断计划和产物。 */
  readonly requirements?: readonly BidTaskRequirement[]
  /** 原始用户明确禁止的能力；原话及能力清单在首次接纳后固定。 */
  readonly scope_constraints?: readonly z.infer<typeof scopeConstraintSchema>[]
  /** 已通过来源和授权核验的计划身份；产物核验不重新解释其步骤授权。 */
  readonly accepted_plan_sha256?: string
  /** 原 Work 接纳前已有的目录身份；包括后来退役但仍保留原文的节点。 */
  readonly original_section_ids?: readonly string[]
  /** Host 从已完成写作步骤的结果收集的目标；验收不扩大到未写作的其他叶节。 */
  readonly written_section_ids?: readonly string[]
  readonly execution_history?: {
    readonly prior_plan_rejections: readonly { scope_authorized: boolean; unmet: readonly string[] }[]
    readonly plan_patch_count: number
    readonly completed_steps: readonly { description: string; capability: string }[]
  }
  readonly preservation_evidence?: { readonly retained: boolean; readonly missing: readonly string[] }
  readonly evidence: readonly { path: string; sha256: string; text: string }[]
  readonly scope_evidence?: readonly {
    section_id: string
    object: string
    outside_scope: boolean
    before_section?: OutlineArtifact['sections'][number]
    before_sha256: string | null
    after_sha256: string | null
  }[]
}
/** 可由测试显式注入；生产默认使用隔离模型且仍执行 Host 事实核对。 */
export type BidTaskVerifier = (
  input: BidTaskVerificationInput, agent: Agent, signal: AbortSignal,
) => Promise<z.input<typeof decisionSchema>>

/**
 * 对比既有章节的目录记录、正文、元数据和审核字节，并标识根范围外对象。
 * @param canonical 正式基线。
 * @param working 待发布候选。
 * @param task 不可变根范围及当前业务计划。
 * @returns Host 读取的逐项摘要对照，缺失文件保留 null。
 */
export async function collectBidTaskScopeEvidence(
  canonical: BidWorkspace, working: BidWorkspace, task: BidCapabilityTask,
): Promise<NonNullable<BidTaskVerificationInput['scope_evidence']>> {
  if (task.scope.kind === 'project'
    && await optionalBody(canonical, 'outline/confirmed-outline.json') === undefined
    && await optionalBody(canonical, 'outline/draft.json') === undefined
    && await optionalBody(canonical, 'outline/outline.json') === undefined) return []
  const before = (await readCapabilityOutlineBaseline(canonical)).outline
  const after = (await readCapabilityOutlineBaseline(working)).outline
  const allowed = task.scope.kind === 'project' ? null : outlineSectionScope(before, task.scope.kind === 'sections'
    ? task.scope.section_ids : [task.scope.reference.section_id])
  const locations = await readChapterLocations(canonical)
  const evidence: Array<NonNullable<BidTaskVerificationInput['scope_evidence']>[number]> = []
  // 授权节点退役会压缩相邻编号；范围外节点仍须保留全部属性及彼此的兄弟顺序。
  const outsideIdentity = (outline: typeof before, section: typeof before.sections[number]) => allowed === null ? section
    : { ...section, order: outline.sections.filter(item => item.parent_id === section.parent_id && !allowed.has(item.id))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)).findIndex(item => item.id === section.id) }
  for (const section of before.sections) {
    const outsideScope = allowed !== null && !allowed.has(section.id)
    const current = after.sections.find(item => item.id === section.id)
    evidence.push({ section_id: section.id, object: 'outline', outside_scope: outsideScope,
      ...outsideScope ? {} : { before_section: section },
      before_sha256: bidInputFingerprint(outsideIdentity(before, section)),
      after_sha256: current === undefined ? null : bidInputFingerprint(outsideIdentity(after, current)) })
    if (allowed !== null && !outsideScope) continue
    const location = locations.get(section.id)
    if (location === undefined) continue
    for (const path of [location.contentPath, location.metadataPath, location.reviewPath]) {
      evidence.push({ section_id: section.id, object: path, outside_scope: allowed !== null,
        before_sha256: await capabilityFileHash(canonical, path) ?? null,
        after_sha256: await capabilityFileHash(working, path) ?? null })
    }
  }
  return evidence
}

async function optionalBody(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 核对原范围内的非标题原文块及流程图是否保留在当前可写叶节。
 * @param canonical 正式原始正文及图定义。
 * @param working 当前候选。
 * @param task 原始任务根范围。
 * @param originalSectionIds 原 Work 接纳前已有的目录身份。
 * @returns Host 的逐字和图定义检查结果，保留在旧父节点不算完成迁移。
 */
export async function collectBidTaskPreservationEvidence(canonical: BidWorkspace, working: BidWorkspace,
  task: BidCapabilityTask, originalSectionIds?: readonly string[]): Promise<NonNullable<BidTaskVerificationInput['preservation_evidence']>> {
  const missing: string[] = []
  const before = (await readCapabilityOutlineBaseline(canonical)).outline
  const after = (await readCapabilityOutlineBaseline(working)).outline
  const roots = task.scope.kind === 'project' ? before.sections.map(section => section.id)
    : task.scope.kind === 'sections' ? task.scope.section_ids : [task.scope.reference.section_id]
  const beforeScope = outlineSectionScope(before, roots)
  const afterScope = await resolveBidTaskSections(canonical, working, task, roots)
  const beforeLocations = await readChapterLocations(canonical)
  const afterLocations = await readChapterLocations(working)
  const bodies: string[] = []
  const flowcharts = new Map<string, number>()
  for (const [id, location] of afterLocations) {
    if (!afterScope.has(id) || !after.sections.some(section => section.id === id && section.writable)) continue
    const body = await optionalBody(working, location.contentPath)
    if (body !== undefined) bodies.push(body)
    const metadata = await optionalBody(working, location.metadataPath)
    if (metadata !== undefined) {
      for (const chart of parseChapterMetadata(JSON.parse(metadata)).flowcharts) {
        const identity = bidInputFingerprint(normalizeFlowchartInputs('preserved', [chart]))
        flowcharts.set(identity, (flowcharts.get(identity) ?? 0) + 1)
      }
    }
  }
  const originals: Array<{ id: string; body: string; metadata: ReturnType<typeof parseChapterMetadata> | undefined }> = []
  for (const [id, location] of beforeLocations) {
    if (!beforeScope.has(id) || !(originalSectionIds === undefined
      ? before.sections.some(section => section.id === id && section.writable) : originalSectionIds.includes(id))) continue
    const body = await optionalBody(canonical, location.contentPath)
    if (body === undefined) continue
    const metadata = await optionalBody(canonical, location.metadataPath)
    originals.push({ id, body, metadata: metadata === undefined ? undefined : parseChapterMetadata(JSON.parse(metadata)) })
  }
  for (const { id, body, metadata } of originals) {
    for (const block of indexChapterContentBlocks(id, body)) {
      if (block.type === 'heading' || block.markdown.trim() === '') continue
      const count = bodies.reduce((total, current) => total + current.split(block.markdown.trim()).length - 1, 0)
      const expected = originals.reduce((total, source) => total + source.body.split(block.markdown.trim()).length - 1, 0)
      if (count < expected) {
        missing.push(`迁移原文块未逐字保留：${block.block_id}`)
      } else if (count > expected) {
        missing.push(`迁移原文块重复出现：${block.block_id}，当前可写章节共 ${count} 份。`)
      }
    }
    if (metadata !== undefined) {
      for (const chart of metadata.flowcharts) {
        const identity = bidInputFingerprint(normalizeFlowchartInputs('preserved', [chart]))
        const count = flowcharts.get(identity) ?? 0
        const expected = originals.reduce((total, source) => total + (source.metadata?.flowcharts ?? [])
          .filter(original => bidInputFingerprint(normalizeFlowchartInputs('preserved', [original])) === identity).length, 0)
        if (count < expected) {
          missing.push(`迁移流程图定义未保留：${id}/${chart.id}`)
        } else if (count > expected) {
          missing.push(`迁移流程图定义重复出现：${id}/${chart.id}，当前可写章节共 ${count} 份。`)
        }
      }
    }
  }
  return { retained: missing.length === 0, missing }
}

/**
 * 从原始来源及计划相关对象收集完整文件，不接纳模型指定的路径。
 * @param working 当前候选。
 * @param task 原范围及当前计划。
 * @param changed 已完成步骤的真实变更文件。
 * @param canonical 原授权身份所属正式目录，默认读取当前工作区。
 * @returns 带内容摘要的完整证据。
 */
export async function collectBidTaskEvidence(
  working: BidWorkspace, task: BidCapabilityTask, changed: readonly string[], canonical: BidWorkspace = working,
): Promise<BidTaskVerificationInput['evidence']> {
  const paths = new Set([...changed, 'outline/confirmed-outline.json', 'outline/draft.json',
    'analysis/evidence-map.json', 'chapters/writing-plan.json', 'chapters/execution-plan.json',
    'chapters/execution-log.json', 'chapters/manifest.json', 'outline/reassignment.json',
    'chapters/pending-reorganization.json', 'chapters/reuse-seeds.json'])
  const locations = await readChapterLocations(working)
  let ids: ReadonlySet<string> | null = null
  if (task.scope.kind !== 'project') {
    ids = await resolveBidTaskSections(canonical, working, task, task.scope.kind === 'sections'
      ? task.scope.section_ids : [task.scope.reference.section_id])
  }
  for (const [id, location] of locations) {
    if (ids !== null && !ids.has(id)) continue
    paths.add(location.contentPath)
    paths.add(location.metadataPath)
    paths.add(location.reviewPath)
  }
  const evidence: Array<{ path: string; sha256: string; text: string }> = []
  for (const path of paths) {
    const text = await optionalBody(working, path)
    if (text === undefined) continue
    const sha256 = await capabilityFileHash(working, path)
    if (sha256 === undefined) throw new Error('BID_TASK_VERIFICATION_EVIDENCE_CHANGED')
    evidence.push({ path, sha256, text })
  }
  return evidence
}

/**
 * 使用隔离 Subagent 比较来源、计划及产物；完整证据通过私有只读工具分段读取。
 * @param input Host 收集的完整来源和证据。
 * @param agent 当前执行 Agent。
 * @param signal 原 Run 的取消信号。
 * @returns 严格逐项结论；无效输出或模型错误拒绝完成。
 */
export const modelBidTaskVerifier: BidTaskVerifier = async (input, agent, signal) => {
  const subagents = agent.ctx.get('subagents')
  if (subagents === undefined || subagents.getProvider('spawn')?.inheritsParentContext !== false) {
    throw new Error('BID_TASK_VERIFIER_UNAVAILABLE')
  }
  const outputSchema = zodJsonSchema(input.requirements === undefined
    ? modelPlanSchema.extend({ sources: modelPlanSchema.shape.sources.length(verificationSources(input).length) })
    : modelResultSchema.extend({ checks: modelResultSchema.shape.checks.length(input.requirements.length) }))
  delete outputSchema.$schema
  // 结构化工具接受基础 JSON 类型；数量、非空字段和证据区间由提交守卫核对。
  const wireCheck = semanticCheckSchema.extend({ reason: z.string(), evidence_positions: z.array(z.number()) })
  const wireRequirement = semanticRequirementSchema.extend({ source_quote: z.string(), check: wireCheck })
  const wireConstraint = z.object({ source_position: z.number(), quote: z.string(),
    forbidden_capabilities: z.array(capabilityIdSchema) }).strict()
  const wireSchema = zodJsonSchema(input.requirements === undefined
    ? modelPlanSchema.extend({ scope_constraints: z.array(wireConstraint), sources: z.array(z.object({ relevant: z.boolean(),
      requirements: z.array(wireRequirement) }).strict()) })
    : modelResultSchema.extend({ checks: z.array(wireCheck) }))
  delete wireSchema.$schema
  assertObjectJsonSchema(wireSchema)
  const prompt = [{ type: 'text' as const, text: [
    '你只核验任务，不规划、不写文件、不提问。完成时调用 structured_output 提交符合 schema 的判断；工具拒绝未读证据时，在当前会话按提示补读后重新提交。',
    '输出 schema 描述返回值的结构，不是返回值本身。只返回业务字段，不返回 $schema、type、properties、required 等 schema 描述字段。不要用文本回复代替 structured_output。',
    '目标依据是 source.message 原话和 frozen issues；task.goal、步骤说明及 Writer/Reviewer 自述不能替代它们。',
    '消息来源的 context_messages 是同一会话本次任务接纳前的真实用户原话，按时间顺序提供。当前消息若只补充章节名称或澄清对象，须结合这些原话还原完整要求；不把无关问答或其他任务当成本次要求，不能用模型计划补造授权。',
    'clarification_dialogue 包含相同时间范围的用户和助手公开文本；助手选项只用于解释用户的编号或短回复，不授予权限。回复“3”若选择第三个章名，只确认章名，不能解释为目录模式或新增限制。',
    'requirements 只列来源支持的业务成果和保留义务。用户未提出“仅改目录”“禁止写正文”等限制时，不得从未提及某步骤推造这些限制；本章增加真实子章节可包含保证原文可用的迁移、补全和独立审核。用户明确仅改目录或禁止正文时必须遵守。',
    '每项 requirement 的 source_quote 必须逐字引用本来源真实用户原话或意见；用户只回复编号时引用此前完整业务要求。Host 用这段原话保存要求描述，不接纳模型改写的权限摘要。历史拒绝是先前模型判断，不能作为用户授权或新增限制的来源。scope_constraints=[] 表示没有明确禁止能力，不得因已安排迁移、正文或审核而否定拆章计划。',
    '用户明确禁止的能力单独放入 scope_constraints，每项填写 sources 中的 source_position、逐字 quote 和 forbidden_capabilities。quote 必须来自该来源的用户原话或意见，不能引用助手、task.goal 或模型概括。没有明确禁止时返回 []。计划含禁止能力时不能声称计划通过；不能先接纳计划，再在结果阶段把同一步骤判成未授权。',
    '根据真实语义判断用户是否授权执行及根范围。段落意见不能授权整章目录修改；新用户明确授权扩展本章才可扩大。',
    '按输入 sources 的顺序判断每个来源是否与任务有关；用户要求处理全部意见时纳入全部待处理意见。普通问答不能因有意见就授权执行。',
    'plan 返回同样数量、同样顺序的 sources，每个来源填写 relevant 和其语义 requirements；无关来源 requirements=[]。消息来源和用户选中的意见不得遗漏。',
    '真实目录子章节必须 object=outline、new_children=true；Markdown 标题、表格和分项不是目录节点。章节身份由 Host 从任务根范围或意见来源绑定。',
    '要求写完新章节和审核时 completed_content=true；只审核可交付 repair 报告，要求修好时 repair=true。',
    'preserve_migrated_content 表示拆分或迁移时须完整且唯一保留原文、原表格和原图，用户明确要求保留迁移原文时填写 true；其他要求填写 false。原章标题可由新目录标题替代，原文段落、表题及表格不得改写、删除或跨章复制。',
    '首次核验没有明确结构授权且小章节含义与段落 scope 冲突时 scope_authorized=false，说明需澄清真实目录子章还是选区内分项。',
    'plan 阶段核验步骤能否覆盖要求；指向新拆叶节的 chapter.write 本身交付正文及独立审核。计划已经包含该步骤时，附加 chapter.review 不代表缺少审核，不得因此否决；仅有 chapter.review 而没有 chapter.write 才不能覆盖新叶节写作。',
    'outline.update.defer_content_migration=true 只推迟该目录步骤中的迁移；同一计划后续的 chapter.reorganize 可用原父章 source_section_ids 将完整原文块分配给新叶节。后续 chapter.write 的 previous_targets 由 Host 使用迁移结果解析为真实新叶节，不需要模型预先猜新 ID；这样的目录、迁移、写作序列可以覆盖完整要求。',
    '能力事实：chapter.write 和 chapter.revise 均包含独立 Reviewer 和 Host 的候选核对，完成后交付当前正文及审核；它们可以同时覆盖“写作/修订和审核”，不要求重复添加 chapter.review。paragraphs 根范围仅允许一个引用完全相同选区的 chapter.revise 步骤。chapter.review 只复核已有可恢复正文，不承担修复。',
    'Host 编排事实：本核验已在 bid_run_task 接纳或原 Work 恢复后执行；输入 task 是业务计划，不含入口调用。不得因 task 未写 bid_run_task 而否决。已有运行时由 Host 持久登记队列，结束后自动执行，并按发布收据主动通知 Main；不需要排队或通知能力步骤。requirements 列业务成果及范围约束，编排时序由 Host 的运行记录核对。首次计划故意遗漏步骤的测试仍须据实拒绝缺失的业务成果；同一任务后续修正完整计划可以通过，不要求后续继续遗漏。',
    'plan 的 met 表示拟执行计划能满足要求，不表示产物已完成；不要因为目录尚未拆分或尚未写作而否定包含这些能力的完整计划。result 的 met 才表示实际产物满足要求。',
    'plan 将可独立验收的语义要求分开，每项附带一个 check，填写 met、reason 和 evidence_positions。result 只返回与给定 requirements 同样数量、同样顺序的 checks，不再生成或复制要求。evidence_positions 只引用本次已完整读取且支持该结论的文件位置，计划尚未执行的产物可以不引用文件。',
    '输入已提供 requirements 时，Host 已核对同一不可变请求的授权、明确禁止能力及原要求；无论 phase 是 plan 还是 result，只返回与它们数量和顺序完全对应的 checks，不再返回或重判 scope_authorized，不得合并、删除或重新列出要求。accepted_plan_sha256 标识已接纳计划，result 只核验成果是否满足要求，不因该计划已经接纳的迁移、写作或审核步骤再次否决授权；明确禁止能力及实际越界修改仍由 Host 拒绝。plan 结合已完成步骤的真实证据与未完成步骤核验覆盖。',
    '所有来源 ID、章节 ID、编号、文件路径和摘要由 Host 绑定。证据仅填写 evidence_positions，不抄写路径或摘要，Host 不会替你引用未读文件。',
    'result 的每个正文完成、原文保留或 content 要求若填写 met=true，该项 evidence_positions 必须引用证据索引中 chapters/sections/、chapters/meta/ 和 chapters/reviews/ 下的全部文件；先逐个完整读取。已读文件也必须在每项相关结论中引用，不能只在其他 check 引用；遗漏引用时按拒绝信息补齐本项索引，不把引用遗漏判成业务成果未完成。',
    '导出是 Host 在内容发布后执行的尾效果；这里只将 object=export 保留为未执行项。',
    'result 核验在正式发布之前执行。你核对候选业务成果，Host 在核验通过后才原子写入正式文件、goal_met=true 的发布凭据和完成通知；此时没有正式发布收据是正常时序，不能因此判定业务成果未满足，也不能将本次候选核验声称为已经正式发布。',
    '内容证据不足或无相应文件不得声称 met。保持所有原文约束和真实资料限制。',
    'evidence 只列出本次冻结证据的位置、路径和总字符数。用 read_task_evidence 按位置读取与要求相关的完整目录、正文、审核和执行记录；next_start 非空时须继续读取，未读部分不能当作已核验。证据目录不是正文或审核结论；不要一次读取整本项目，也不要以文件存在代替内容核验。计划核验结合已完成步骤证据与剩余能力判断。result 要判定完成正文或保留迁移原文，须逐个完整读取并引用范围内 chapters/sections、chapters/meta、chapters/reviews 的证据；逐项核对原文在各章的归属，不能只检查总量和存在。',
    'scope_evidence 是 Host 从正式基线与候选读取的既有章节目录、正文、元数据和审核摘要对照；outside_scope 标识根范围外对象。unchanged=true 证明该对象未改变，不需要额外读取正文或创建审查步骤。',
    'scope_evidence.before_section 是任务范围内节点的正式原始目录记录。核对原有需求、评分、响应点和合规覆盖的迁移时，以这些原始绑定为准；不能把其他节点或完整招标清单中的业务项推定为该节点的原有覆盖。候选目录表示本次成果，不能替代原始目录事实。',
    'met 表示要求是否满足。对“不得改其他章节”等否定要求，摘要对照证明没有发生禁止的修改时 met=true；不是因为要求禁止修改就填 false。reason 必须与 met 的实际满足结论一致。',
    'execution_history 是 Host 保存的同一 Work 已发生的拒绝、计划补丁及已完成步骤。prior_plan_rejections 非空证明首次计划确实被拒绝；后续修正计划应核验剩余业务成果，不能要求已发生的故障注入重新执行。编排顺序不作为新的正文、目录或资料要求。',
    'preservation_evidence 是 Host 对正式原始正文及当前可写叶节的逐字、唯一性、表格和流程图定义检查；retained=true 证明原有内容均在叶节完整且唯一保留，允许在原文周围增补。旧父节点保留的历史正文不参与该检查，也不进入交付正文。依据此事实判断内容保留，另行核验迁移归属及新增方案是否满足语义要求。',
    '输出 schema：' + JSON.stringify(outputSchema),
    '核验输入：' + JSON.stringify({ phase: input.phase, task: input.task,
      clarification_dialogue: input.source.clarification_dialogue,
      accepted_plan_sha256: input.accepted_plan_sha256,
      scope_constraints: input.scope_constraints,
      execution_history: input.execution_history,
      preservation_evidence: input.preservation_evidence,
      sources: verificationSources(input).map(source => source.content),
      requirements: input.requirements?.map(({ source_id: _source, section_ids: _sections, ...requirement }) => requirement),
      evidence: input.evidence.map((file, evidence_position) => ({ evidence_position,
        path: file.path, total_characters: file.text.length })),
      scope_evidence: input.scope_evidence?.map(({ before_sha256, after_sha256, ...file }) => ({ ...file,
        unchanged: before_sha256 === after_sha256, exists: after_sha256 !== null })) }),
  ].join('\n') }]
  const reads = new Map<number, Array<{ start: number; end: number }>>()
  const liftReader = agent.ctx.on('subagent/child-setup', ({ parent, childContext, request }) => {
    if (parent !== agent || request.prompt !== prompt) return
    attachBidTaskEvidenceReader(childContext.agent as Agent, input.evidence, (position, start, end) => {
      const ranges = reads.get(position) ?? []
      ranges.push({ start, end })
      ranges.sort((left, right) => left.start - right.start)
      reads.set(position, ranges)
    })
    childContext.tools.guard((exec) => {
      if (exec.name !== 'structured_output') return undefined
      try {
        bindSemanticDecision(input, exec.arguments, reads)
      } catch (error) {
        return '任务核验未通过，请在当前会话修正后重新提交：' + (error instanceof Error ? error.message : String(error))
      }
      return undefined
    })
  })
  let child: Awaited<ReturnType<typeof subagents.start>> | undefined
  try {
    child = await subagents.start('spawn', {
      parent: agent, signal, label: input.phase === 'plan' ? '任务计划核验' : '任务产物核验',
      maxDepth: 1, toolFilter: { allow: [] }, prompt, outputSchema: wireSchema,
    })
    const result = await child.result
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') {
      throw new Error('BID_TASK_VERIFICATION_MODEL_FAILED: ' + result.stopReason
        + (result.diagnostic === undefined ? '' : ' (' + result.diagnostic + ')'))
    }
    return bindSemanticDecision(input, result.structured, reads)
  } finally {
    liftReader()
    await child?.dispose()
  }
}

/**
 * 核对模型引用的真实身份，并按目录和当前审核拒绝错误 satisfied。
 * @param input 完整验收输入。
 * @param decision 只读语义核验结果。
 * @param canonical 正式基线。
 * @param working 候选项目。
 * @returns 可保存的最终核验记录。
 */
export async function validateBidTaskVerification(
  input: BidTaskVerificationInput, decision: Awaited<ReturnType<BidTaskVerifier>>,
  canonical: BidWorkspace, working: BidWorkspace,
): Promise<BidTaskVerification> {
  const parsed = decisionSchema.parse(decision)
  const sources = verificationSources(input)
  for (const requirement of parsed.requirements) {
    const quote = requirement.source_quote
    if (quote === undefined) continue
    const source = sources.find(item => item.id === requirement.source_id)
    const texts = source === undefined ? [] : source.content.kind === 'message'
      ? [source.content.text, ...source.content.context_messages] : [source.content.text, source.content.suggestion ?? '']
    if (requirement.description !== quote || !texts.some(text => text.includes(quote))) {
      throw new Error('BID_TASK_VERIFICATION_REQUIREMENT_SOURCE_INVALID')
    }
  }
  const unmet: string[] = []
  unmet.push(...validateScopeConstraints(input, parsed.scope_constraints))
  if (input.scope_constraints !== undefined
    && JSON.stringify(parsed.scope_constraints) !== JSON.stringify(input.scope_constraints)) {
    throw new Error('BID_TASK_VERIFICATION_CONSTRAINTS_CHANGED')
  }
  if (input.scope_evidence?.some(item => item.outside_scope && item.before_sha256 !== item.after_sha256)) {
    unmet.push('范围外既有章节的目录或文件发生变化。')
  }
  if (input.task.scope.kind === 'paragraphs' && parsed.requirements.some(item => item.new_children)) {
    parsed.scope_authorized = false
  }
  if (input.phase === 'plan') {
    const capabilities = input.task.steps.map(step => step.call.capability)
    if (parsed.requirements.some(item => item.new_children)
      && !capabilities.some(id => id === 'outline.update' || id === 'outline.refine'
        || id === 'evidence.research' && input.task.steps.some(step => step.call.capability === id
          && step.call.input.allow_outline_refinement))) unmet.push('真实目录子章要求缺少目录结构能力。')
    if (parsed.requirements.some(item => item.new_children && item.completed_content)
      && !capabilities.includes('chapter.write')) unmet.push('新增叶节缺少基于迁移草稿的 chapter.write。')
    if (parsed.requirements.some(item => item.repair) && capabilities.every(id => id === 'chapter.review'
      || id === 'document.review')) unmet.push('审核报告不能代替修复任务。')
  }
  const expectedSources = new Set([input.source.message.message_id, ...parsed.relevant_issue_ids])
  const actualSources = new Set(parsed.requirements.map(item => item.source_id))
  if (actualSources.size !== expectedSources.size || [...expectedSources].some(id => !actualSources.has(id))) {
    unmet.push('核验未覆盖完整原始来源。')
  }
  const bound = new Set(input.source.issues.map(issue => issue.issue_id))
  const knownIssues = new Set([...input.source.observed_issues, ...input.source.issues].map(issue => issue.issue_id))
  if (new Set(parsed.relevant_issue_ids).size !== parsed.relevant_issue_ids.length
    || parsed.relevant_issue_ids.some(id => !knownIssues.has(id))) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
  const scheduled = new Set(input.task.steps.flatMap(step => step.call.capability === 'chapter.revision_batch'
    ? step.call.input.issue_ids : []))
  if ([...bound].some(id => !parsed.relevant_issue_ids.includes(id))
    || [...scheduled].some(id => !parsed.relevant_issue_ids.includes(id))) {
    unmet.push('计划遗漏或增加了原始任务要求处理的审批意见。')
  }
  if (input.requirements !== undefined && JSON.stringify(parsed.requirements) !== JSON.stringify(input.requirements)) {
    throw new Error('BID_TASK_VERIFICATION_REQUIREMENTS_CHANGED')
  }
  if (parsed.checks.length !== parsed.requirements.length
    || new Set(parsed.checks.map(item => item.requirement_index)).size !== parsed.requirements.length
    || parsed.checks.some(item => item.requirement_index >= parsed.requirements.length)) {
    throw new Error('BID_TASK_VERIFICATION_CHECKS_INVALID')
  }
  const hashes = new Map(input.evidence.map(file => [file.path, file.sha256]))
  for (const file of input.scope_evidence ?? []) {
    if (file.object !== 'outline' && file.after_sha256 !== null) hashes.set(file.object, file.after_sha256)
  }
  if (input.phase === 'result' && (parsed.requirements.some(item => item.preserve_migrated_content)
    || input.task.steps.some(step => step.call.capability === 'chapter.reorganize' && !step.call.input.allow_content_deletion))) {
    unmet.push(...(await collectBidTaskPreservationEvidence(canonical, working, input.task, input.original_section_ids)).missing)
  }
  const scopedRequirements = parsed.requirements.filter(item => item.section_ids.length > 0)
  if (scopedRequirements.length > 0) {
    const outline = (await readCapabilityOutlineBaseline(canonical)).outline
    const known = new Set(outline.sections.map(section => section.id))
    const allowed = input.task.scope.kind === 'project' ? known : outlineSectionScope(outline,
      input.task.scope.kind === 'sections' ? input.task.scope.section_ids : [input.task.scope.reference.section_id])
    if (scopedRequirements.some(item => item.section_ids.some(id => !known.has(id) || !allowed.has(id)))) {
      throw new Error('BID_TASK_VERIFICATION_SECTION_INVALID')
    }
  }
  if (input.phase === 'result' && input.written_section_ids !== undefined && input.written_section_ids.length > 0) {
    const ids = [...await resolveBidTaskSections(canonical, working, input.task, input.written_section_ids)]
    try { await validateWritingCapability({ working }, ids) } catch (error) {
      unmet.push('计划内写作成果不满足当前写作规则：' + (error instanceof Error ? error.message : String(error)))
    }
    const locations = await readChapterLocations(working)
    for (const id of ids) {
      const location = locations.get(id)
      const body = location === undefined ? undefined : await optionalBody(working, location.reviewPath)
      if (body === undefined || parseChapterReviewArtifact(JSON.parse(body)).verdict !== 'pass') {
        unmet.push('计划内写作成果的当前叶节审核未通过：' + id)
      }
    }
  }
  for (const check of parsed.checks) {
    check.evidence = check.evidence.map((file) => {
      const sha256 = hashes.get(file.path)
      if (sha256 === undefined || file.sha256 !== undefined && sha256 !== file.sha256) {
        throw new Error('BID_TASK_VERIFICATION_EVIDENCE_INVALID')
      }
      return { path: file.path, sha256 }
    })
    const requirement = parsed.requirements[check.requirement_index]
    if (requirement === undefined) throw new Error('BID_TASK_VERIFICATION_REQUIREMENT_INVALID')
    if (requirement.object === 'export') {
      const positions = input.task.steps.flatMap((step, index) => step.call.capability === 'docx.export' ? [index] : [])
      if (positions.length !== 1 || positions[0] !== input.task.steps.length - 1) {
        unmet.push(requirement.description + '：缺少唯一的末尾 docx.export 步骤。')
      } else if (input.phase === 'plan' && !check.met) unmet.push(requirement.description + '：' + check.reason)
      continue
    }
    if (!check.met || input.phase === 'result' && check.evidence.length === 0) unmet.push(requirement.description + '：' + check.reason)
    if (input.phase !== 'result') continue
    if (requirement.new_children) {
      const before = (await readCapabilityOutlineBaseline(canonical)).outline
      const outline = (await readCapabilityOutlineBaseline(working)).outline
      const allowed = input.task.scope.kind === 'project' ? null
        : await resolveBidTaskSections(canonical, working, input.task, input.task.scope.kind === 'sections'
          ? input.task.scope.section_ids : [input.task.scope.reference.section_id])
      if (requirement.section_ids.length === 0 || requirement.section_ids.some((id) => {
        const parent = outline.sections.find(section => section.id === id)
        const newChildren = outline.sections.filter(section => section.parent_id === id
          && !(input.original_section_ids?.includes(section.id) ?? before.sections.some(previous => previous.id === section.id)))
        return parent === undefined || parent.writable || newChildren.length === 0
          || allowed !== null && (!allowed.has(id) || newChildren.some(child => !allowed.has(child.id)))
      })) unmet.push(requirement.description + '：没有授权范围内的真实新增目录子节点。')
    }
    if (requirement.completed_content || requirement.repair && requirement.object === 'content') {
      const outline = (await readCapabilityOutlineBaseline(working)).outline
      const roots = requirement.section_ids.length > 0 ? requirement.section_ids
        : input.task.scope.kind === 'project' ? (await readCapabilityOutlineBaseline(canonical)).outline.sections
          .filter(section => section.parent_id === null).map(section => section.id)
          : input.task.scope.kind === 'sections' ? input.task.scope.section_ids : [input.task.scope.reference.section_id]
      const ids = await resolveBidTaskSections(canonical, working, input.task, roots)
      const targets = outline.sections.filter(section => section.writable && ids.has(section.id)).map(section => section.id)
      if (targets.length === 0) unmet.push(requirement.description + '：没有可写目标叶节。')
      else {
        try { await validateWritingCapability({ working }, targets) } catch (error) {
          unmet.push(requirement.description + '：' + (error instanceof Error ? error.message : String(error)))
        }
        const locations = await readChapterLocations(working)
        for (const id of targets) {
          const location = locations.get(id)
          const body = location === undefined ? undefined : await optionalBody(working, location.reviewPath)
          if (body === undefined || parseChapterReviewArtifact(JSON.parse(body)).verdict !== 'pass') {
            unmet.push(requirement.description + '：当前叶节审核未通过 ' + id)
          }
        }
      }
    }
  }
  const deferredExport = input.task.steps.at(-1)?.call.capability === 'docx.export'
    && input.task.steps.filter(step => step.call.capability === 'docx.export').length === 1
  if (deferredExport && !parsed.requirements.some(item => item.object === 'export')) {
    unmet.push('完整任务中的导出要求未进入验收项目。')
  }
  return bidTaskVerificationSchema.parse({ ...parsed, phase: input.phase,
    source_sha256: bidInputFingerprint(input.source),
    input_sha256: bidInputFingerprint(input), plan_sha256: bidInputFingerprint(input.task), unmet, deferred_export: deferredExport,
    goal_met: parsed.scope_authorized && unmet.length === 0 && !deferredExport })
}
