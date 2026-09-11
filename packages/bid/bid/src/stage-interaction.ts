/** Main Agent 全阶段对话工具、可回放提示与当前阶段资料读取。 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { buildOutlineView, outlineEditOperationSchema } from './outline-confirmation-edits.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { getOrCreateOutlineDraft } from './outline-draft-store.ts'
import { parseEvidenceMapArtifact, parseEvidenceMappingPlan } from './evidence-mapping-artifacts.ts'
import { readEvidenceMappingLog, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseTenderScoringSelection } from './tender-analysis-confirmation.ts'
import { BID_INITIAL_RUNTIME_STATE, reduceBidRuntimeState } from './runtime-state.ts'
import {
  initialWritingPlanInputSchema,
  parseWritingPlan,
  writingPlanPatchInputSchema,
} from './writing-requirements.ts'
import { evaluateHostAcceptanceCriteria } from './acceptance-criteria.ts'
import { parseChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { estimateChapterWritingPages } from './page-estimate.ts'
import { chapterRevisionReferenceSchema, chapterRevisionRequestSchema, validateChapterRevisionReference } from './chapter-revision.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const identity = { expected_revision: z.number().int().positive(), expected_draft_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }
const scope = z.array(z.string().min(1)).min(1)

/** 在工具执行入口重新验证阶段操作参数，CAS 必须来自最近一次 inspect。 */
export const stageInteractionSchema = z.union([
  z.object({
    action: z.literal('bid_stage_inspect'),
    view: z.enum(['summary', 'task_contract_context']).optional(),
    reference: chapterRevisionReferenceSchema.optional(),
  }).strict(),
  z.object({ action: z.literal('bid_pause_stage') }).strict(),
  z.object({ action: z.literal('bid_resume_stage') }).strict(),
  z.object({ action: z.literal('bid_stop_stage') }).strict(),
  z.object({ action: z.literal('bid_outline_apply_operations'), ...identity, operations: z.array(outlineEditOperationSchema).min(1) }).strict(),
  z.object({ action: z.literal('bid_outline_regenerate_scope'), ...identity, section_ids: scope, feedback: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('bid_evidence_remap'), ...identity, section_ids: scope, reason: z.string().optional(), mode: z.enum(['replace', 'supplement']).default('replace') }).strict(),
  initialWritingPlanInputSchema.extend({ action: z.literal('bid_confirm_writing_plan') }).strict(),
  writingPlanPatchInputSchema.extend({ action: z.literal('bid_confirm_writing_plan') }).strict(),
  chapterRevisionRequestSchema.extend({ action: z.literal('bid_revise_chapter') }).strict(),
])

const names = [
  'bid_stage_inspect',
  'bid_outline_apply_operations',
  'bid_outline_regenerate_scope',
  'bid_evidence_remap',
  'bid_confirm_writing_plan',
  'bid_revise_chapter',
  'bid_pause_stage',
  'bid_resume_stage',
  'bid_stop_stage',
] as const
const MAX_INSPECT_CHAPTER_CHARS = 12_000
const MAX_INSPECT_SECTIONS = 100
const MAX_PUBLIC_EVENTS = 6
const MAX_PUBLIC_EVENT_CHARS = 500

/**
 * 判断会话是否拥有 Bid 阶段交互。
 * @param session 当前会话。
 * @returns 仅 Bid Main Agent 可进入阶段交互。
 */
export function isBidMainSession(session: Session): boolean {
  return session.header.origin !== 'subagent' && resolveSessionPreset(session) === 'bid' && session.header.cwd !== undefined
}

/**
 * 从 Bid 项目内的非链接文件读取 JSON。
 * @param workspace 会话工作区。
 * @param path 会话内相对路径。
 * @returns 已拒绝链接路径的 JSON 数据。
 */
export async function readStageJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8'))
}

async function readOptionalStageJson<T>(
  workspace: BidWorkspace,
  path: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    return parse(await readStageJson(workspace, path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function latestPublicEvents(session: Session): Array<{
  seq: number
  role: 'user' | 'assistant'
  text: string
  truncated: boolean
}> {
  const recent = session.events.slice(-400)
  const publicTurns = new Set<number>()
  let currentTurn: number | undefined
  for (const event of recent) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === currentTurn) currentTurn = undefined
    else if (event.type === 'user/message' && event.data.source.kind === 'user' && currentTurn !== undefined) {
      publicTurns.add(currentTurn)
    }
  }
  return recent.flatMap<{
    seq: number
    role: 'user' | 'assistant'
    text: string
    truncated: boolean
  }>((event) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      return [{ seq: event.seq, role: 'user' as const, text: text.slice(0, MAX_PUBLIC_EVENT_CHARS), truncated: text.length > MAX_PUBLIC_EVENT_CHARS }]
    }
    if (event.type === 'assistant/message' && publicTurns.has(event.data.turn)) {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.length === 0) return []
      return [{ seq: event.seq, role: 'assistant' as const, text: text.slice(0, MAX_PUBLIC_EVENT_CHARS), truncated: text.length > MAX_PUBLIC_EVENT_CHARS }]
    }
    return []
  }).slice(-MAX_PUBLIC_EVENTS)
}

async function inspectBidStageValue(
  workspace: BidWorkspace,
  session: Session,
  reference?: z.infer<typeof chapterRevisionReferenceSchema>,
  view: 'summary' | 'task_contract_context' = 'summary',
) {
  const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
  const started = session.events.findLast(event => event.type === 'bid.stage.started' && event.data.stage === runtime.stage)
  const base = {
    runtime,
    started_at: started === undefined ? null : new Date(started.time).toISOString(),
    latest_public_events: latestPublicEvents(session),
  }
  if (runtime.stage === 'file_intake') {
    const manifest = await workspace.readManifest()
    const files = manifest.files
    return {
      ...base,
      progress_summary: {
        files: files.length,
        parsed: files.filter(file => file.parseStatus === 'success').length,
        failed: files.filter(file => file.parseStatus === 'failed').length,
      },
      current_artifacts_summary: { manifest: files.length === 0 ? 'pending' as const : 'available' as const },
    }
  }
  const scoringPath = runtime.stage === 'tender_analysis' ? 'analysis/scoring-origin.json' : 'analysis/scoring.json'
  const [project, requirements, scoring, compliance] = await Promise.all([
    readOptionalStageJson(workspace, 'analysis/project.json', parseTenderProjectArtifact),
    readOptionalStageJson(workspace, 'analysis/requirements.json', parseTenderRequirementsArtifact),
    readOptionalStageJson(workspace, scoringPath, parseTenderScoringArtifact),
    readOptionalStageJson(workspace, 'analysis/compliance.json', parseTenderComplianceArtifact),
  ])
  if (runtime.stage === 'tender_analysis') {
    const selection = scoring === null ? null : await readOptionalStageJson(
      workspace, 'analysis/tender-analysis-selection.json', value => parseTenderScoringSelection(value, scoring),
    )
    const summary = {
      project: project === null ? 'pending' as const : 'available' as const,
      requirements: requirements?.requirements.length ?? 0,
      scoring_items: scoring?.scoring_items.length ?? 0,
      compliance_items: compliance?.compliance_items.length ?? 0,
    }
    return view === 'task_contract_context' || runtime.status === 'waiting_user'
      ? { ...base, project, requirements, scoring, selected_scoring_ids: selection?.selected_scoring_ids ?? [], compliance,
        progress_summary: summary, current_artifacts_summary: summary }
      : { ...base, progress_summary: summary, current_artifacts_summary: summary }
  }
  if (runtime.stage === 'chapter_writing' || runtime.stage === 'docx_export') {
    const outline = await readOptionalStageJson(workspace, 'outline/confirmed-outline.json', parseOutlineArtifact)
    if (outline === null) return {
      ...base,
      progress_summary: { completed_tasks: 0, running_tasks: 0, pending_tasks: 0, failed_tasks: 0 },
      current_artifacts_summary: { outline: 'pending' as const, writing_plan: 'pending' as const, execution_log: 'pending' as const },
    }
    const taskContext = view === 'task_contract_context'
      ? {
        requirements,
        scoring,
        compliance,
        blueprint: outline,
        evidence: await readOptionalStageJson(workspace, 'analysis/evidence-map.json', parseEvidenceMapArtifact),
        user_messages: session.events.slice(-200).flatMap(event => event.type === 'user/message'
          && event.data.source.kind === 'user'
          ? [{
            ref: { session_id: String(session.id), message_id: String(event.data.id), seq: event.seq },
            text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
          }]
          : []),
      }
      : undefined
    let writing_plan = null
    try { writing_plan = parseWritingPlan(await readStageJson(workspace, 'chapters/writing-plan.json')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let execution_log: ReturnType<typeof parseChapterExecutionLog> | null = null
    try { execution_log = parseChapterExecutionLog(await readStageJson(workspace, 'chapters/execution-log.json')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const positions = new Map(buildOutlineView(outline.sections).map(item => [item.section.id, item]))
    const writing_progress = {
      sections: outline.sections.filter(section => section.writable).slice(0, MAX_INSPECT_SECTIONS).map((section) => {
        const entry = execution_log?.sections.find(item => item.section_id === section.id)
        return {
          section_id: section.id,
          number: positions.get(section.id)?.number,
          title: section.title,
          status: entry?.status ?? 'pending',
          writer_attempts: entry?.attempts.filter(item => item.role === 'writer').length ?? 0,
          reviewer_attempts: entry?.attempts.filter(item => item.role === 'reviewer').length ?? 0,
          latest_issues: entry?.attempts.at(-1)?.issues.slice(0, 5) ?? [],
        }
      }),
      page_estimate: await estimateChapterWritingPages(workspace, outline).then(estimate => ({
        status: 'available' as const,
        pages: estimate.total,
        format: estimate.format,
        deterministic_acceptance: evaluateHostAcceptanceCriteria(writing_plan?.document_acceptance ?? [], {
          estimatedPages: estimate.total,
        }),
      }), (error: unknown) => ({ status: 'unavailable' as const, reason: error instanceof Error ? error.message : String(error) })),
    }
    const statuses = execution_log?.sections ?? []
    const progress = {
      completed_tasks: statuses.filter(item => item.status === 'completed').length,
      running_tasks: statuses.filter(item => item.status === 'running').length,
      pending_tasks: statuses.filter(item => item.status === 'pending').length,
      failed_tasks: statuses.filter(item => item.status === 'failed').length,
      total_tasks: outline.sections.filter(section => section.writable).length,
    }
    let chapter = null
    if (reference !== undefined) {
      const index = buildWritableSectionWorklist(outline).findIndex(section => section.id === reference.section_id)
      if (index < 0) throw new Error('BID_CHAPTER_REVISION_NOT_WRITABLE')
      const markdown = await readFile(within(workspace.projectRoot, `chapters/sections/${String(index + 1).padStart(4, '0')}.md`), 'utf8')
      validateChapterRevisionReference({ instruction: 'inspect', reference }, markdown)
      const selected = reference.scope === 'paragraphs' ? reference.text : markdown
      chapter = {
        section_id: reference.section_id,
        scope: reference.scope,
        markdown: selected.slice(0, MAX_INSPECT_CHAPTER_CHARS),
        truncated: selected.length > MAX_INSPECT_CHAPTER_CHARS,
      }
    }
    return {
      ...base,
      progress_summary: progress,
      current_artifacts_summary: {
        outline_sections: outline.sections.length,
        writing_plan_version: writing_plan?.plan_version ?? null,
        execution_log: execution_log === null ? 'pending' as const : 'available' as const,
      },
      ...(view === 'task_contract_context' ? { project } : {}),
      outline: outline.sections.slice(0, MAX_INSPECT_SECTIONS).map(section => ({
        id: section.id,
        parent_id: section.parent_id,
        title: section.title,
        writable: section.writable,
      })),
      ...(view === 'task_contract_context' ? { writing_plan } : {}),
      writing_progress,
      chapter,
      ...(taskContext === undefined ? {} : { task_contract_context: taskContext }),
    }
  }
  const draft = await readOptionalStageJson(workspace, 'outline/outline.json', parseOutlineArtifact)
    .then(async outline => outline === null ? null : getOrCreateOutlineDraft(workspace, false))
  const response_points = await readOptionalStageJson(workspace, 'analysis/scoring-response-points.json', parseScoringResponsePointCatalog)
  const evidence = runtime.stage === 'evidence_mapping'
    ? await readOptionalStageJson(workspace, 'analysis/evidence-map.json', parseEvidenceMapArtifact) : null
  const mappings = new Map(evidence?.section_mappings.map(item => [item.section_id, item]))
  const mappingPlan = runtime.stage === 'evidence_mapping'
    ? await readOptionalStageJson(workspace, 'analysis/evidence-mapping-plan.json', parseEvidenceMappingPlan) : null
  const mappingProgress = runtime.stage === 'evidence_mapping' ? await readEvidenceMappingProgress(workspace) : null
  const mappingTasks = runtime.stage === 'evidence_mapping' ? (await readEvidenceMappingLog(workspace))?.tasks ?? [] : []
  const sections = draft?.outline.sections ?? []
  const sectionSummary = buildOutlineView(sections).slice(0, MAX_INSPECT_SECTIONS).map(item => ({ ...item,
    evidence: view === 'task_contract_context' || runtime.status === 'waiting_user' ? mappings.get(item.section.id) ?? null : undefined,
    local_material_count: mappings.get(item.section.id)?.local_materials.length ?? 0,
    web_material_count: mappings.get(item.section.id)?.web_materials.length ?? 0,
  }))
  const progress = mappingProgress === null
    ? { completed_tasks: 0, running_tasks: 0, pending_tasks: sections.length, failed_tasks: 0 }
    : {
      completed_tasks: mappingProgress.completed,
      running_tasks: mappingProgress.running,
      pending_tasks: mappingProgress.not_started,
      failed_tasks: mappingProgress.failed,
    }
  return {
    ...base,
    progress_summary: progress,
    current_artifacts_summary: {
      project: project === null ? 'pending' as const : 'available' as const,
      requirements: requirements?.requirements.length ?? 0,
      scoring_items: scoring?.scoring_items.length ?? 0,
      compliance_items: compliance?.compliance_items.length ?? 0,
      response_points: response_points?.points.length ?? 0,
      outline_sections: sections.length,
      evidence_mappings: evidence?.section_mappings.length ?? 0,
    },
    ...(view === 'task_contract_context' || runtime.status === 'waiting_user'
      ? { project, requirements, scoring, compliance, response_points, draft } : {}),
    sections: sectionSummary,
    writable_section_ids: sections.filter(item => item.writable)
      .slice(0, view === 'task_contract_context' || runtime.status === 'waiting_user' ? sections.length : MAX_INSPECT_SECTIONS)
      .map(item => item.id),
    mapping_plan: view === 'task_contract_context' || runtime.status === 'waiting_user' ? mappingPlan : undefined,
    mapping_progress: mappingProgress,
    mapping_tasks: view === 'task_contract_context' || runtime.status === 'waiting_user' ? mappingTasks.slice(-MAX_INSPECT_SECTIONS) : undefined,
  }
}

/**
 * 从权威产物和会话日志组装当前 Bid 阶段交互快照。
 * @param workspace 会话工作区。
 * @param session 读取状态的会话。
 * @param reference 可选正文引用；只影响 S5 引用上下文。
 * @param view 摘要或显式请求的完整任务契约上下文。
 * @returns 最新目录编号、CAS 与阶段资料，不从聊天历史推测。
 */
export function inspectBidStage(
  workspace: BidWorkspace,
  session: Session,
  reference?: z.infer<typeof chapterRevisionReferenceSchema>,
  view?: 'summary' | 'task_contract_context',
): ReturnType<typeof inspectBidStageValue> {
  return inspectBidStageValue(workspace, session, reference, view)
}

/**
 * 渲染等待用户阶段的模型交互规则。
 * @param stage 当前阶段。
 * @returns 通过 user/message 入日志的交互规则。
 */
export function renderStageInteractionPrompt(stage: string): string {
  if (stage === 'chapter_writing') return [
    '当前 Bid 阶段：chapter_writing；当前状态：waiting_user。',
    '正式写作尚未开始。先调用 bid_stage_inspect(view=task_contract_context)，结合已确认目录、招标要求和资料映射理解用户的自然语言要求。',
    '只追问影响执行的关键歧义或冲突。资料不足、能力限制或招标要求冲突必须指出并提出处理建议；需要改变目录时，引导用户重置并重新确认 S4，不得偷偷改目录。',
    '保留用户原话。没有特殊要求时，仍应按招标要求、目录和现有资料形成默认计划。未提供的指标不得变成用户硬性要求。',
    '有特殊要求时，先用简短中文说明你的理解、重点和篇幅安排并请用户确认；用户已明确说“按这些要求直接开始”或“没有特殊要求，直接开始”时无需再次确认。',
    '把自然语言要求统一拆成 global_instructions、每个可写叶节的 task、相关 user_message_refs、writing_instructions、章节 acceptance_criteria 和 document_acceptance。程序不会按用户措辞选择任务结构；由你根据语义决定作用范围、required/preferred 和验收方式。',
    'semantic 条件交给 Reviewer 根据正文判断；只有要求能直接绑定工具 schema 已列出的 Host metric 时才使用 deterministic，数值由 Host 测量，不自行计算。条件 ID、作用域、计划版本和执行状态由 Host 生成，不得在描述中伪造这些字段。',
    '获得确认或直接开始授权后调用 bid_confirm_writing_plan。只引用 task_contract_context.user_messages 中确实构成写作要求或确认语境的 ref；Host 从 Session Log 回查并持久化准确原文，进度询问等普通消息不得引用。',
    '首次提交 update_kind=initial 的完整计划，sections 覆盖每个可写叶节且只出现一次。没有额外动态验收条件时 document_acceptance 和章节 acceptance_criteria 可以为空，固定 Reviewer 仍会执行。',
    '修改既有计划时提交 update_kind=patch 和当前 base_plan_version，只列真实变化的全局指令、document acceptance、section task/instructions/acceptance 以及明确删除的 criterion ID。affected_section_ids 表示语义影响范围；Host 自动纳入实际修改的章节，未修改章节及其 AC ID 保持不变。',
    '工具成功即完成确认；随后 Host 会在本轮结束后启动既有章节写作与审核链路。不要直接 write Artifact 或调用其他工具启动章节任务。',
  ].join('\n')
  return [
    `当前 Bid 阶段：${stage}；当前状态：waiting_user。`,
    '你正在与用户进行当前阶段的交互修改。先调用 bid_stage_inspect 读取最新目录、评分点、资料和缺口。',
    '按 inspect 返回的 number、标题和父子关系，把“第三章”“3.2”“服务方案下面第二个”解析到实际 section.id；编号不是 Section ID。只有存在歧义时才询问用户，不要求用户提供内部 ID。',
    '只能使用当前可见阶段工具修改目录或资料，不得直接 write Artifact、调用其他工具绕过校验或自动推进阶段。',
    '目录拆分用 split_section，合并同级可写叶子用 merge_sections；局部重生成用 bid_outline_regenerate_scope。修改后重新 inspect 获取新 ID 与 revision。',
    '资料不对、重新匹配用 bid_evidence_remap(mode=replace)；资料不足、再补充用 supplement。传具体章节只处理该章节，传结构分支处理其可写后代。标题微调不强制 remap；用户要求修改并重新找资料时，修改后 remap 新范围。',
    '普通聊天中的“可以”“没问题”“这样可以吗”不是正式确认。修改完成后告知“已更新，请重新确认”，只有用户点击正式确认按钮才能进入下一阶段。',
  ].join('\n')
}

/**
 * 渲染 S5 运行中或完成后的主 Agent 交互规则。
 * @param status 当前 S5 状态。
 * @param stage 投影到提示中的阶段名。
 * @returns 只把已提交工具结果视为状态变化的模型规则。
 */
export function renderChapterWritingInteractionPrompt(status: 'running' | 'attention_required' | 'completed', stage = 'chapter_writing'): string {
  return [
    `当前 Bid 阶段：${stage}；当前状态：${status}。`,
    '先理解用户是在提问、解释已有正文，还是明确要求改变写作计划；不得用关键词、引用或发送方式替代语义判断。',
    '进度、安排原因和正文解释只调用 bid_stage_inspect 读取 Host 快照并回答，不修改计划、不停止写作；运行中的章节任务继续执行。',
    '只有用户明确要求改变写作任务时，才先调用 bid_stage_inspect(view=task_contract_context)，再调用 bid_confirm_writing_plan。提交成功表示新计划已保存并进入既有定向恢复链路，不代表受影响正文已经改完。',
    '引用正文只是上下文；解释时把引用传给 bid_stage_inspect，明确要求修改时才调用 bid_revise_chapter 或调整计划。',
    status === 'running'
      ? '用户明确要求暂停新任务调度或继续时，分别调用 bid_pause_stage 或 bid_resume_stage；已经运行的 Writer/Reviewer 自然收敛。只有用户明确要求停止当前阶段任务时才调用 bid_stop_stage。停止回复由聊天界面单独控制。'
      : '当前阶段没有运行中的任务，不得调用 pause、resume 或 stop 阶段工具。',
  ].join('\n')
}

/**
 * 渲染非写作阶段运行中或完成后的公开用户回合规则。
 * @param stage 当前 Bid 阶段。
 * @param status 当前运行或完成状态。
 * @returns 只允许有界检查和语义回答的模型规则。
 */
export function renderLiveStageInteractionPrompt(stage: string, status: 'running' | 'completed'): string {
  return [
    `当前 Bid 阶段：${stage}；当前状态：${status}。`,
    '你正在处理公开用户消息，后台阶段任务与 Child/Subagent 继续运行。先判断用户是在询问、解释现状，还是明确要求改变任务；不得按关键词、引用或发送方式判断意图。',
    '进度、资料范围和设计原因只调用 bid_stage_inspect 读取有界 Host 快照并回答；不得直接读写 Artifact、停止阶段、重启阶段或创建新的阶段请求。',
    status === 'completed'
      ? '阶段产物保持完成态。普通问答不得重开阶段或修改产物；当前没有受控修改工具时，应说明可用的正式重置或后续阶段入口。'
      : '普通消息不拥有阶段生命周期，也不取消当前模型任务或已启动的 Child。当前没有受控修改工具时，应说明修改需要等待现有阶段到达正式交互边界。用户明确要求暂停新任务调度或继续时，分别调用 bid_pause_stage 或 bid_resume_stage；已运行任务自然收敛。只有用户明确要求停止当前阶段任务时才调用 bid_stop_stage；停止回复由聊天界面单独控制。',
  ].join('\n')
}

/**
 * 按实时阶段安装 scoped tools；全局 guard 拒绝交互期间的其他 Main Agent 工具调用。
 * @param ctx Host 插件上下文，负责全部注册释放。
 * @param execute 共享 Host 操作入口。
 * @param interacting 当前会话是否仍被阶段交互操作占用。
 */
export function installStageInteractionTools(
  ctx: Context,
  execute: (agent: Agent, request: unknown, signal: AbortSignal) => Promise<unknown>,
  interacting: (session: Session) => boolean,
): void {
  ctx.inject(['tools'], (toolCtx) => {
    const mounted = new Map<Agent, { scope: string; dispose: () => void }>()
    const sync = (agent: Agent): void => {
      const runtime = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      const stage = isBidMainSession(agent.session)
        && (runtime.status === 'waiting_user' || runtime.status === 'running'
          || runtime.status === 'completed' || runtime.status === 'attention_required')
        ? runtime.stage : undefined
      const scope = stage === undefined ? undefined : `${stage}:${runtime.status}`
      const existing = mounted.get(agent)
      if (existing?.scope === scope) return
      existing?.dispose()
      mounted.delete(agent)
      if (stage === undefined) return
      const tools = agent.ctx.get('tools')
      if (tools === undefined) throw new Error('Bid stage interaction requires tools')
      const available = runtime.status !== 'waiting_user'
        ? runtime.stage === 'chapter_writing' ? [names[0], names[4], names[5], ...(runtime.status === 'running' ? names.slice(6) : [])]
          : runtime.stage === 'docx_export' && runtime.status === 'completed' ? [names[0], names[5]]
            : runtime.status === 'running' ? [names[0], ...names.slice(6)] : [names[0]]
        : stage === 'tender_analysis' ? names.slice(0, 1)
          : stage === 'outline_generation' ? names.slice(0, 3)
            : stage === 'evidence_mapping' ? names.slice(0, 4) : [names[0], names[4]]
      const disposers: Array<() => void> = []
      const text: JsonSchemaNode = { type: 'string' }
      const strings: JsonSchemaNode = { type: 'array', items: text }
      const cas = { expected_revision: { type: 'integer' as const }, expected_draft_sha256: text }
      try {
        if (runtime.status === 'waiting_user') disposers.push(tools.restrict({ allow: [] }))
        for (const name of available) {
          const properties: Record<string, JsonSchemaNode> = name === 'bid_stage_inspect' || name === 'bid_confirm_writing_plan'
            || name === 'bid_revise_chapter' || name === 'bid_pause_stage' || name === 'bid_resume_stage'
            || name === 'bid_stop_stage' ? {} : { ...cas }
          const required = Object.keys(properties)
          let parameters: JsonSchemaNode | undefined
          const chapterReference: JsonSchemaNode = { oneOf: [{
            type: 'object', properties: { section_id: text, content_sha256: text, scope: { type: 'string', enum: ['chapter'] } },
            required: ['section_id', 'content_sha256', 'scope'], additionalProperties: false,
          }, {
            type: 'object', properties: { section_id: text, content_sha256: text, scope: { type: 'string', enum: ['paragraphs'] },
              start: { type: 'integer' }, end: { type: 'integer' }, text },
            required: ['section_id', 'content_sha256', 'scope', 'start', 'end', 'text'], additionalProperties: false,
          }] }
          if (name === 'bid_stage_inspect') {
            properties.view = { type: 'string', enum: ['summary', 'task_contract_context'] }
            properties.reference = chapterReference
          }
          if (name === 'bid_revise_chapter') {
            properties.instruction = text
            properties.reference = chapterReference
            required.push('instruction', 'reference')
          }
          if (name === 'bid_outline_apply_operations') {
            properties.operations = { type: 'array', items: { type: 'object' }, description: '按 type 提交操作：update_section(section_id,title?,purpose?,must_answer?)；add_section(parent_id,order,writable,title,purpose,must_answer?)；delete_section(section_id)；move_section(section_id,parent_id,order)；split_section(section_id,children:[{title,purpose,must_answer}])；merge_sections(section_ids,title,purpose)。' }
            required.push('operations')
          }
          if (name === 'bid_outline_regenerate_scope' || name === 'bid_evidence_remap') {
            properties.section_ids = strings
            required.push('section_ids')
          }
          if (name === 'bid_outline_regenerate_scope') { properties.feedback = text; required.push('feedback') }
          if (name === 'bid_evidence_remap') { properties.reason = text; properties.mode = { type: 'string', enum: ['replace', 'supplement'] } }
          if (name === 'bid_confirm_writing_plan') {
            const acceptanceEvaluator: JsonSchemaNode = { oneOf: [
              { type: 'object', properties: { kind: { type: 'string', enum: ['semantic'] } }, required: ['kind'], additionalProperties: false },
              { type: 'object', properties: {
                kind: { type: 'string', enum: ['deterministic'] },
                metric: { type: 'string', enum: ['estimated_pages', 'character_count'] },
                min: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                max: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              }, required: ['kind', 'metric', 'min', 'max'], additionalProperties: false },
            ] }
            const acceptanceCriterion: JsonSchemaNode = {
              type: 'object', properties: {
                description: text,
                priority: { type: 'string', enum: ['required', 'preferred'] },
                evaluator: acceptanceEvaluator,
              }, required: ['description', 'priority', 'evaluator'], additionalProperties: false,
            }
            const messageRef: JsonSchemaNode = {
              type: 'object', properties: { session_id: text, message_id: text, seq: { type: 'integer' } },
              required: ['session_id', 'message_id', 'seq'], additionalProperties: false,
            }
            const messageRefs: JsonSchemaNode = { type: 'array', items: messageRef }
            const criterionDelta: JsonSchemaNode = {
              type: 'object', properties: {
                add: { type: 'array', items: acceptanceCriterion },
                update: { type: 'array', items: { type: 'object', properties: {
                  criterion_id: text,
                  description: text,
                  priority: { type: 'string', enum: ['required', 'preferred'] },
                  evaluator: acceptanceEvaluator,
                }, required: ['criterion_id'], additionalProperties: false } },
                delete: strings,
              }, required: ['add', 'update', 'delete'], additionalProperties: false,
            }
            const initialSections: JsonSchemaNode = { type: 'array', items: {
              type: 'object', properties: {
                section_id: text, task: text, user_message_refs: messageRefs,
                acceptance_criteria: { type: 'array', items: acceptanceCriterion },
                writing_instructions: strings,
              }, required: ['section_id', 'task', 'user_message_refs', 'writing_instructions', 'acceptance_criteria'], additionalProperties: false,
            } }
            const patchSections: JsonSchemaNode = { type: 'array', items: {
              type: 'object', properties: {
                section_id: text, task: text, add_user_message_refs: messageRefs,
                acceptance_criteria: criterionDelta, writing_instructions: strings,
              }, required: ['section_id'], additionalProperties: false,
            } }
            parameters = { oneOf: [{
              type: 'object', properties: {
                update_kind: { type: 'string', enum: ['initial'] }, user_message_refs: messageRefs,
                global_instructions: strings, document_acceptance: { type: 'array', items: acceptanceCriterion },
                sections: initialSections,
              }, required: ['update_kind', 'user_message_refs', 'global_instructions', 'document_acceptance', 'sections'], additionalProperties: false,
            }, {
              type: 'object', properties: {
                update_kind: { type: 'string', enum: ['patch'] }, base_plan_version: { type: 'integer' },
                user_message_refs: messageRefs, summary: text, affected_section_ids: strings,
                global_instructions: strings, document_acceptance: criterionDelta, sections: patchSections,
              }, required: ['update_kind', 'base_plan_version', 'user_message_refs', 'summary', 'affected_section_ids', 'sections'], additionalProperties: false,
            }] }
          }
          const definition: ToolDefinition = {
            name,
            description: name === 'bid_stage_inspect' ? '读取当前阶段的有界权威快照；传正文引用时校验原文身份并返回受控正文。'
              : name === 'bid_pause_stage' ? '仅在用户明确要求暂停时阻止后续阶段任务启动；已经运行的任务继续收敛。'
                : name === 'bid_resume_stage' ? '仅在用户明确要求继续时释放当前阶段的新任务调度门。'
                  : name === 'bid_stop_stage' ? '仅在用户明确要求停止当前阶段任务时终止阶段及其后台子任务；不得用于停止当前聊天回复。'
                    : name === 'bid_revise_chapter' ? '仅在用户明确要求修改引用正文时，把意见交给该章原 Writer；普通解释不得调用。'
                      : name === 'bid_confirm_writing_plan' ? '保存已获用户确认或直接开始授权的整体写作计划；成功后 Host 启动既有 S5 写作链路。'
                        : name === 'bid_evidence_remap' ? '只重新研究选中章节或分支。replace 替换旧证据；supplement 保留并补充。完成后等待用户正式确认。'
                          : name === 'bid_outline_regenerate_scope' ? '按反馈局部重生成选中章节，保留范围外目录。完成后等待正式确认。'
                            : '使用最新 Draft CAS 执行结构化目录编辑，不直接写文件；返回更新后的目录，仍需正式确认。',
            parameters: (parameters ?? { type: 'object', properties, required, additionalProperties: false }) as Record<string, unknown>,
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, exec) {
              if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
              return execute(agent, { ...(args as Record<string, unknown>), action: name }, exec.signal)
            },
            presentCall: () => ({ card: 'generic', title: name }),
          }
          disposers.push(tools.register(definition))
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      mounted.set(agent, { scope: `${stage}:${runtime.status}`, dispose: () => { for (const dispose of disposers.reverse()) dispose() } })
    }
    const publicRestrictions = new Map<Agent, () => void>()
    const claimState = new Map<Agent, { boundary: string; hasUser: boolean }>()
    const releasePublic = (agent: Agent): void => {
      publicRestrictions.get(agent)?.()
      publicRestrictions.delete(agent)
    }
    toolCtx.effect(() => toolCtx.tools.guard((exec) => {
      const subject = exec.agent
      const session = subject?.session
      if (subject === undefined || session === undefined || !isBidMainSession(session)) return
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if ((runtime.status === 'waiting_user' || interacting(session) || publicRestrictions.has(subject))
        && !names.includes(exec.name as typeof names[number])) return 'BID_STAGE_TOOL_REQUIRED'
    }))
    toolCtx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!isBidMainSession(agent.session)) return
      const runtime = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (runtime.status !== 'running' && runtime.status !== 'completed' && runtime.status !== 'attention_required') return
      const previous = claimState.get(agent)
      const prior = agent.session.events.findLast(event => event.type === 'step/end' && event.data.turn === turn)
      const priorStep = prior?.type === 'step/end' ? prior.data.step : 0
      const boundary = `${String(turn)}:${String(priorStep)}`
      const state = previous?.boundary === boundary ? previous : { boundary, hasUser: false }
      if (message.source.kind === 'user') {
        state.hasUser = true
        const tools = agent.ctx.get('tools')
        if (tools === undefined) throw new Error('Bid stage interaction requires tools')
        if (!publicRestrictions.has(agent)) publicRestrictions.set(agent, tools.restrict({ allow: [] }))
      } else if (!state.hasUser) releasePublic(agent)
      claimState.set(agent, state)
    }, { global: true })
    toolCtx.on('agent/session-start', ({ agent }) => { sync(agent) }, { global: true })
    toolCtx.on('session/event', (session, event) => {
      if (!event.type.startsWith('bid.')) return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) sync(agent)
    }, { global: true })
    toolCtx.on('agent/status', ({ agent, status }) => { if (status === 'idle') releasePublic(agent) }, { global: true })
    toolCtx.on('agent/disposed', ({ agent }) => {
      releasePublic(agent)
      claimState.delete(agent)
      mounted.get(agent)?.dispose()
      mounted.delete(agent)
    }, { global: true })
    toolCtx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      const runtime = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (decision.kind === 'reject' || !isBidMainSession(agent.session) || !messages.some(message => message.source.kind === 'user')) return decision
      const prompt = runtime.status === 'waiting_user' ? renderStageInteractionPrompt(runtime.stage)
        : (runtime.stage === 'chapter_writing' && (runtime.status === 'running' || runtime.status === 'attention_required' || runtime.status === 'completed')
          || runtime.stage === 'docx_export' && runtime.status === 'completed')
          ? renderChapterWritingInteractionPrompt(runtime.status, runtime.stage)
          : runtime.status === 'running' || runtime.status === 'completed'
            ? renderLiveStageInteractionPrompt(runtime.stage, runtime.status) : undefined
      if (prompt === undefined) return decision
      return { kind: 'enter', messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }), ...decision.messages] }
    }, { global: true })
    for (const agent of ctx.agents.list()) sync(agent)
    toolCtx.effect(() => () => {
      for (const agent of publicRestrictions.keys()) releasePublic(agent)
      claimState.clear()
      for (const value of mounted.values()) value.dispose()
      mounted.clear()
    })
  })
}
