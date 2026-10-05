/** Main Agent 全阶段对话工具、可回放提示与当前阶段资料读取。 */
import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { buildOutlineView, outlineBusinessBindingSchema, outlineEditOperationSchema } from './outline-confirmation-edits.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { getOrCreateOutlineDraft } from './outline-draft-store.ts'
import { parseEvidenceMapArtifact, parseEvidenceMappingPlan } from './evidence-mapping-artifacts.ts'
import { readEvidenceMappingLog, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseTenderScoringSelection } from './tender-analysis-confirmation.ts'
import { outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import {
  BID_INITIAL_TASK_STATE,
  reduceBidTaskState,
} from './runtime-state.ts'
import {
  initialWritingPlanInputSchema,
  writingRequestSchema,
  writingPlanPatchInputSchema,
} from './writing-requirements.ts'
import { readCurrentWritingPlan } from './writing-entry-state.ts'
import { evaluateHostAcceptanceCriteria } from './acceptance-criteria.ts'
import { parseOrMigrateChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { bidProjectInspectSchema, resolveBidProjectInspectWorkspace } from './bid-project-inspect.ts'
import { bidCapabilityStepSchema, bidCapabilityTaskSchema } from './bid-capability-contract.ts'
import { zodJsonSchema } from './zod-json-schema.ts'
import { estimateChapterWritingPages } from './page-estimate.ts'
import { chapterRevisionReferenceSchema, chapterRevisionRequestSchema, validateChapterRevisionReference } from './chapter-revision.ts'
import { readRevisionQueue } from './chapter-revision-queue.ts'
import { revisionBatchTaskInputSchema } from './chapter-revision-batch.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import type { BidRunData } from './control-plane-contract.ts'
import { bidCapabilityTakeoverRun, bidCompletedCapabilityRun, bidRecoverableRun, bidRunRecoveryEligibility, bidWritingPlanRecoveryEligibility } from './bid-recovery.ts'
import { resolveBidToolAuthorization } from './bid-tool-authorization.ts'
import { bidModelTaskJsonSchema, bindBidModelTask, bindBidModelSteps, bindBidModelProjectQuery,
  bindBidModelWritingPlan, bindBidModelReference, collectBidModelTaskCatalog,
  presentBidModelTaskCatalog, bindBidModelOutlineEdit, bidModelOutlineEditJsonSchema, type BidModelTaskCatalog } from './bid-model-task.ts'
import { capabilityTaskCheckpointSchema } from './bid-capability-task.ts'
import { readBidProjectState } from './project-state.ts'

const identity = { expected_revision: z.number().int().positive(), expected_draft_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }
const scope = z.array(z.string().min(1)).min(1)
const recoveryInstruction = z.string().trim().min(1).max(4000)
const recoveryTool = 'bid_recover_task'
const projectInspectParams = z.object({ query: bidProjectInspectSchema }).strict()
const modelProjectInspectParams = projectInspectParams.extend({ objects_page: z.number().int().nonnegative().optional() }).strict()
const supersedeSchema = z.object({
  run_id: z.string().min(1), expected_project_revision: z.number().int().nonnegative(),
}).strict()
const runTaskParams = z.object({ task: bidCapabilityTaskSchema, supersede: supersedeSchema.optional() }).strict()
const modelRunTaskParams = z.object({ task: bidCapabilityTaskSchema, supersede: z.boolean().optional() }).strict()
const planTaskParams = z.object({ work_id: z.string().min(1), from_index: z.number().int().nonnegative(),
  steps: z.array(bidCapabilityStepSchema), restart_pending: z.literal(true).optional() }).strict()
const resumeRunParams = z.object({ run_id: z.string().min(1),
  expected_project_revision: z.number().int().nonnegative() }).strict()
const recoverRunParams = z.object({ target: z.literal('run'), run_id: z.string().min(1), instruction: recoveryInstruction }).strict()
const recoverWritingPlanParams = z.object({ target: z.literal('writing_plan'), writing_request_id: z.string().min(1),
  attempt_id: z.string().min(1), instruction: recoveryInstruction }).strict()
const modelRecoverTaskParams = z.object({ target: z.enum(['run', 'writing_plan']), instruction: recoveryInstruction }).strict()
const planEditSchema = z.enum(['replace_pending', 'append', 'restart_pending'])
  .describe('replace_pending 保留已开始的写作候选；append 纠正已发布结果；restart_pending 须有本轮新用户授权，保留已接纳步骤，从其结果重新迁移全部原写作章节，不复用未提交写作候选。')
const modelPlanTaskParams = z.object({ edit: planEditSchema, steps: z.array(bidCapabilityStepSchema) }).strict()
const recoveryArtifactPaths = new Set([
  'analysis/project.json', 'analysis/scoring.json', 'analysis/scoring-origin.json',
  'analysis/tender-analysis-selection.json', 'analysis/scoring-response-points.candidate.json',
  'analysis/evidence-map.candidate.json', 'analysis/evidence-mapping-quality.candidate.json',
  'analysis/evidence-mapping-checkpoint.json', 'outline/outline.json', 'outline/candidate-repair.json',
  'outline/quality-report.json', 'outline/refined-outline.candidate.json',
])

/** 在工具执行入口重新验证阶段操作参数，CAS 必须来自最近一次 inspect。 */
export const stageInteractionSchema = z.union([
  projectInspectParams.extend({ action: z.literal('bid_project_inspect') }),
  runTaskParams.extend({ action: z.literal('bid_run_task') }),
  planTaskParams.extend({ action: z.literal('bid_plan_task') }),
  z.object({
    action: z.literal('bid_stage_inspect'),
    view: z.enum(['summary', 'task_contract_context', 'recovery']).optional(),
    reference: chapterRevisionReferenceSchema.optional(),
  }).strict(),
  recoverRunParams.extend({ action: z.literal('bid_recover_task') }),
  recoverWritingPlanParams.extend({ action: z.literal('bid_recover_task') }),
  resumeRunParams.extend({ action: z.literal('bid_resume_current_run') }),
  z.object({ action: z.literal('bid_pause_stage') }).strict(),
  z.object({ action: z.literal('bid_resume_stage') }).strict(),
  z.object({ action: z.literal('bid_set_flowchart_visual_review'), policy: z.enum(['required', 'skip']) }).strict(),
  z.object({ action: z.literal('bid_outline_apply_operations'), ...identity,
    operations: z.array(outlineEditOperationSchema).min(1),
    business_bindings: z.array(outlineBusinessBindingSchema).optional() }).strict(),
  z.object({ action: z.literal('bid_outline_regenerate_scope'), ...identity, section_ids: scope, feedback: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('bid_evidence_remap'), ...identity, section_ids: scope, reason: z.string().optional(), mode: z.enum(['replace', 'supplement']).default('replace') }).strict(),
  initialWritingPlanInputSchema.extend({ action: z.literal('bid_confirm_writing_plan') }).strict(),
  writingPlanPatchInputSchema.extend({ action: z.literal('bid_confirm_writing_plan') }).strict(),
  chapterRevisionRequestSchema.extend({ action: z.literal('bid_revise_chapter') }).strict(),
  z.object({
    action: z.literal('bid_plan_revision_batch'),
    expected_queue_revision: z.number().int().nonnegative(),
    issue_ids: z.array(z.string().min(1)).min(1),
    tasks: z.array(revisionBatchTaskInputSchema).min(1),
  }).strict(),
  z.object({
    action: z.literal('bid_execute_revision_batch'),
    batch_id: z.string().min(1),
  }).strict(),
])

const BID_INTERACTION_TOOL_NAMES = [
  'bid_stage_inspect',
  'bid_outline_apply_operations',
  'bid_outline_regenerate_scope',
  'bid_evidence_remap',
  'bid_confirm_writing_plan',
  'bid_revise_chapter',
  'bid_plan_revision_batch',
  'bid_execute_revision_batch',
  'bid_pause_stage',
  'bid_resume_stage',
  'bid_set_flowchart_visual_review',
  'bid_project_inspect',
  'bid_run_task',
  'bid_plan_task',
  'bid_resume_current_run',
] as const
const MAX_INSPECT_CHAPTER_CHARS = 12_000
const MAX_INSPECT_SECTIONS = 100
const MAX_PUBLIC_EVENTS = 6
const MAX_PUBLIC_EVENT_CHARS = 500

/**
 * 判断会话是否属于可承载项目控制面的顶层 Bid Host。
 * @param session 当前会话。
 * @returns 非 Subagent 的 Bid Session 返回 true。
 */
export function isBidHostSession(session: Session): boolean {
  return session.header.origin !== 'subagent' && resolveSessionPreset(session) === 'bid'
}

/**
 * 判断会话是否拥有 Bid 项目控制权及工作区。
 * @param session 当前会话。
 * @returns 顶层 Bid Session 同时拥有 cwd 时返回 true。
 */
export function isBidMainSession(
  session: Session,
): session is Session & { readonly header: Session['header'] & { readonly cwd: string } } {
  return isBidHostSession(session) && session.header.cwd !== undefined
}

/**
 * 在取得 Bid 项目锁或 Word 操作权前拒绝非 Main Session。
 * @param session 请求项目控制权的会话。
 * @returns 会话通过检查时收窄为带 cwd 的 Main Session。
 * @throws {Error} 会话不是带 cwd 的顶层 Bid Session。
 */
export function assertBidMainSession(
  session: Session,
): asserts session is Session & { readonly header: Session['header'] & { readonly cwd: string } } {
  if (!isBidMainSession(session)) throw new Error('BID_SESSION_REQUIRED')
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
  workspace: BidWorkspace | undefined,
  session: Session,
  reference?: z.infer<typeof chapterRevisionReferenceSchema>,
  view: 'summary' | 'task_contract_context' | 'recovery' = 'summary',
) {
  const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  if (view === 'recovery') {
    const run = bidRecoverableRun(session, task)
    const runNotice = task.status === 'suspended' ? session.events.findLast(event =>
      event.type === 'bid.run.notice' && event.data.noticeId === `run:${task.run.runId}:resume-failed`) : undefined
    const decision = task.stage === 'chapter_writing' && task.status === 'waiting_user'
      ? bidWritingPlanRecoveryEligibility(session) : bidRunRecoveryEligibility(session)
    let writingPlanDiagnostic: { readable: boolean; matchesTarget: boolean; error?: string } | undefined
    let artifactDiagnostic: { path: string; readable: boolean; reason?: string } | undefined
    const artifact = run?.error?.issues?.map(issue => issue.artifact)
      .find(path => path !== undefined && recoveryArtifactPaths.has(path))
    if (artifact !== undefined && workspace === undefined) {
      artifactDiagnostic = { path: artifact, readable: false, reason: '原 Work 候选不存在。' }
    } else if (artifact !== undefined && workspace !== undefined) {
      try {
        const path = within(workspace.projectRoot, artifact)
        await assertNoLinkedPath(workspace.root, path)
        const size = (await stat(path)).size
        if (size > 80_000) artifactDiagnostic = { path: artifact, readable: false, reason: '候选超过诊断读取上限。' }
        else {
          await readStageJson(workspace, artifact)
          artifactDiagnostic = { path: artifact, readable: true }
        }
      } catch (error: unknown) {
        const code = error instanceof SyntaxError ? 'JSON 格式损坏。'
          : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '候选文件不存在。' : '候选文件不可读取。'
        artifactDiagnostic = { path: artifact, readable: false, reason: code }
      }
    }
    if (task.stage === 'chapter_writing' && task.status === 'waiting_user' && workspace !== undefined) {
      try {
        const request = await readOptionalStageJson(workspace, 'chapters/writing-request.json', value => writingRequestSchema.parse(value))
        writingPlanDiagnostic = { readable: request !== null,
          matchesTarget: decision.target?.kind === 'writing_plan'
            && request?.request_id === decision.target.requestId && request.attempt_id === decision.target.attemptId }
      } catch (error: unknown) {
        writingPlanDiagnostic = { readable: false, matchesTarget: false,
          error: error instanceof Error ? error.message.slice(0, 300) : '写作请求不可读取。' }
      }
    }
    return {
      task,
      eligible: decision.eligible && (writingPlanDiagnostic?.matchesTarget ?? true),
      reason: task.status === 'failed' ? task.failure.message : decision.reason,
      attempts: decision.attempts,
      same_problem_count: decision.sameProblemCount,
      requires_strategy_change: decision.requiresStrategyChange,
      previous_instructions: decision.previousInstructions,
      target: decision.target ?? null,
      progress_fingerprint: decision.fingerprint ?? null,
      writing_plan_diagnostic: writingPlanDiagnostic ?? null,
      artifact_diagnostic: artifactDiagnostic ?? null,
      mapping_progress: task.stage === 'evidence_mapping' && workspace !== undefined
        ? await readEvidenceMappingProgress(workspace) : null,
      latest_run_notice: runNotice?.type === 'bid.run.notice'
        ? { kind: runNotice.data.kind, severity: runNotice.data.severity, message: runNotice.data.message } : null,
      run_id: run?.runId ?? null,
      cause: run?.cause ?? null,
      failure: task.status === 'suspended' ? task.run.error ?? null
        : task.status === 'failed' ? task.failure : null,
      unit: run?.error?.recovery?.unit ?? null,
    }
  }
  if (workspace === undefined) throw new Error('BID_STAGE_INSPECT_WORKSPACE_REQUIRED')
  const started = task.run
  const base = {
    task,
    run_progress: task.run?.progress ?? null,
    started_at: started === null ? null : new Date(started.startedAt).toISOString(),
    latest_public_events: latestPublicEvents(session),
  }
  if (task.stage === 'file_intake') {
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
  const scoringPath = task.stage === 'tender_analysis' ? 'analysis/scoring-origin.json' : 'analysis/scoring.json'
  const [project, requirements, scoring, compliance] = await Promise.all([
    readOptionalStageJson(workspace, 'analysis/project.json', parseTenderProjectArtifact),
    readOptionalStageJson(workspace, 'analysis/requirements.json', parseTenderRequirementsArtifact),
    readOptionalStageJson(workspace, scoringPath, parseTenderScoringArtifact),
    readOptionalStageJson(workspace, 'analysis/compliance.json', parseTenderComplianceArtifact),
  ])
  if (task.stage === 'tender_analysis') {
    const selection = scoring === null ? null : await readOptionalStageJson(
      workspace, 'analysis/tender-analysis-selection.json', value => parseTenderScoringSelection(value, scoring),
    )
    const summary = {
      project: project === null ? 'pending' as const : 'available' as const,
      requirements: requirements?.requirements.length ?? 0,
      scoring_items: scoring?.scoring_items.length ?? 0,
      compliance_items: compliance?.compliance_items.length ?? 0,
    }
    return view === 'task_contract_context' || task.status === 'waiting_user'
      ? { ...base, project, requirements, scoring, selected_scoring_ids: selection?.selected_scoring_ids ?? [], compliance,
        progress_summary: summary, current_artifacts_summary: summary }
      : { ...base, progress_summary: summary, current_artifacts_summary: summary }
  }
  if (task.stage === 'chapter_writing' || task.stage === 'docx_export') {
    const outline = await readOptionalStageJson(workspace, 'outline/confirmed-outline.json', parseOutlineArtifact)
    if (outline === null) return {
      ...base,
      progress_summary: { completed_tasks: 0, running_tasks: 0, pending_tasks: 0, failed_tasks: 0 },
      current_artifacts_summary: { outline: 'pending' as const, writing_plan: 'pending' as const, execution_log: 'pending' as const },
    }
    const confirmedSha256 = outlineArtifactSha256(outline)
    const writing_plan = await readCurrentWritingPlan(workspace, confirmedSha256)
    const writing_request = view === 'task_contract_context' && writing_plan === undefined
      ? await readOptionalStageJson(workspace, 'chapters/writing-request.json',
        value => writingRequestSchema.parse(value))
      : null
    const taskContext = view === 'task_contract_context'
      ? {
        writing_request,
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
    let execution_log: ReturnType<typeof parseOrMigrateChapterExecutionLog> | null = null
    try { execution_log = parseOrMigrateChapterExecutionLog(await readStageJson(workspace, 'chapters/execution-log.json')) } catch (error) {
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
      const assigned = await readChapterLocation(workspace, reference.section_id)
      if (assigned === null) throw new Error(`BID_CHAPTER_STORAGE_LOCATION_MISSING: ${reference.section_id}`)
      const markdown = await readFile(within(workspace.projectRoot, assigned.contentPath), 'utf8')
      validateChapterRevisionReference({ instruction: 'inspect', reference }, markdown)
      const selected = reference.scope === 'paragraphs' ? reference.text : markdown
      chapter = {
        section_id: reference.section_id,
        scope: reference.scope,
        markdown: selected.slice(0, MAX_INSPECT_CHAPTER_CHARS),
        truncated: selected.length > MAX_INSPECT_CHAPTER_CHARS,
      }
    }
    const revisionQueue = await readRevisionQueue(workspace)
    const revision_queue = {
      revision: revisionQueue.revision,
      pending_count: revisionQueue.issues.filter(issue => issue.status === 'pending').length,
      issues: revisionQueue.issues.map(issue => ({
        issue_id: issue.issue_id,
        section_id: issue.section_id,
        section_title: issue.section_title,
        scope: issue.scope,
        instruction: issue.instruction,
        suggestion: issue.suggestion,
        status: issue.status,
        batch_id: issue.batch_id,
        reference_summary: issue.reference.scope === 'chapter'
          ? '整个章节'
          : issue.reference.text.slice(0, 200),
      })),
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
      ...(view === 'task_contract_context' ? { writing_plan: writing_plan ?? null } : {}),
      writing_progress,
      chapter,
      revision_queue,
      ...(taskContext === undefined ? {} : { task_contract_context: taskContext }),
    }
  }
  const workingOutline = await readOptionalStageJson(workspace, 'outline/outline.json', parseOutlineArtifact)
  const initialConfirmedOutline = task.stage === 'evidence_mapping' && workingOutline === null
    ? await readOptionalStageJson(workspace, 'outline/initial-confirmed-outline.json', parseOutlineArtifact)
    : null
  const draft = workingOutline === null ? null : await getOrCreateOutlineDraft(workspace)
  const response_points = await readOptionalStageJson(workspace, 'analysis/scoring-response-points.json', parseScoringResponsePointCatalog)
  const evidence = task.stage === 'evidence_mapping'
    ? await readOptionalStageJson(workspace, 'analysis/evidence-map.json', parseEvidenceMapArtifact) : null
  const mappings = new Map(evidence?.section_mappings.map(item => [item.section_id, item]))
  const mappingPlan = task.stage === 'evidence_mapping'
    ? await readOptionalStageJson(workspace, 'analysis/evidence-mapping-plan.json', parseEvidenceMappingPlan) : null
  const mappingProgress = task.stage === 'evidence_mapping' ? await readEvidenceMappingProgress(workspace) : null
  const mappingTasks = task.stage === 'evidence_mapping' ? (await readEvidenceMappingLog(workspace))?.tasks ?? [] : []
  const sections = draft?.outline.sections ?? initialConfirmedOutline?.sections ?? []
  const includeMappingDetails = view === 'task_contract_context' || task.status === 'waiting_user'
  const sectionSummary = buildOutlineView(sections).slice(0, MAX_INSPECT_SECTIONS).map(item => ({ ...item,
    ...(includeMappingDetails ? { evidence: mappings.get(item.section.id) ?? null } : {}),
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
    ...(includeMappingDetails
      ? { project, requirements, scoring, compliance, response_points, draft } : {}),
    sections: sectionSummary,
    writable_section_ids: sections.filter(item => item.writable)
      .slice(0, includeMappingDetails ? sections.length : MAX_INSPECT_SECTIONS)
      .map(item => item.id),
    ...(includeMappingDetails ? { mapping_plan: mappingPlan, mapping_tasks: mappingTasks.slice(-MAX_INSPECT_SECTIONS) } : {}),
    mapping_progress: mappingProgress,
  }
}

/**
 * 从权威产物和会话日志组装当前 Bid 阶段交互快照。
 * @param workspace 真实执行工作区；恢复候选缺失时仅返回失败状态和不可读诊断。
 * @param session 读取状态的会话。
 * @param reference 可选正文引用；只影响 S5 引用上下文。
 * @param view 摘要或显式请求的完整任务契约上下文。
 * @returns 最新目录编号、CAS 与阶段资料，不从聊天历史推测。
 */
export function inspectBidStage(
  workspace: BidWorkspace | undefined,
  session: Session,
  reference?: z.infer<typeof chapterRevisionReferenceSchema>,
  view?: 'summary' | 'task_contract_context' | 'recovery',
): ReturnType<typeof inspectBidStageValue> {
  return inspectBidStageValue(workspace, session, reference, view)
}

/**
 * 渲染等待用户阶段的模型交互规则。
 * @param stage 当前阶段。
 * @returns 阶段提示及其可持久化的交互规则。
 */
export function renderStageInteractionPrompt(stage: string): string {
  if (stage === 'chapter_writing') return [
    '当前 Bid 阶段：chapter_writing；当前状态：waiting_user。',
    '正式写作尚未开始。先调用 bid_stage_inspect(view=task_contract_context)，结合已确认目录、招标要求和资料映射理解用户的自然语言要求。',
    '只追问影响执行的关键歧义或冲突。资料不足、能力限制或招标要求冲突必须指出并提出处理建议；用户明确要求改变目录时，可调用 bid_run_task 组合目录、资料与写作能力。',
    '保留用户原话。没有特殊要求时，仍应按招标要求、目录和现有资料形成默认计划。未提供的指标不得变成用户硬性要求。',
    '初始整体写作要求由 Host 原生提问；先读取 task_contract_context.writing_request 中已保存的真实回答，不要再次询问这个初始问题。请求身份由程序绑定，Host 会在首次计划提交时把原生自定义回答原文加入 user_requirements。',
    '只追问影响执行的关键歧义或冲突。若原生回答尚未保存，不得提交首次计划，也不得把普通聊天消息当作首次授权。原生回答不是 user/message，不要伪造 user_message_refs；已有真实用户消息仍可按语义引用。',
    '把自然语言要求统一拆成 global_instructions、每个可写叶节的 task、相关 user_message_refs、writing_instructions、章节 acceptance_criteria 和 document_acceptance。程序不会按用户措辞选择任务结构；由你根据语义决定作用范围、required/preferred 和验收方式。',
    'semantic 条件交给 Reviewer 根据正文判断；只有要求能直接绑定工具 schema 已列出的 Host metric 时才使用 deterministic，数值由 Host 测量，不自行计算。条件 ID、作用域、计划版本和执行状态由 Host 生成，不得在描述中伪造这些字段。',
    '获得确认或直接开始授权后调用 bid_confirm_writing_plan。只选择 objects.messages 中确实构成写作要求或确认语境的位置；Host 从 Session Log 回查并持久化准确原文，进度询问等普通消息不得引用。',
    '首次提交 update_kind=initial 的完整计划，sections 覆盖每个可写叶节且只出现一次。没有额外动态验收条件时 document_acceptance 和章节 acceptance_criteria 可以为空，固定 Reviewer 仍会执行。',
    '修改既有计划时提交 update_kind=patch，只列真实变化的全局指令、document acceptance、section task/instructions/acceptance 以及明确删除的 criterion_position。affected_section_positions 表示语义影响范围；Host 绑定当前版本和实际章节。',
    '工具成功即完成确认；随后 Host 会在本轮结束后启动既有章节写作与审核链路。不要直接 write Artifact 或调用其他工具启动章节任务。',
  ].join('\n')
  return [
    `当前 Bid 阶段：${stage}；当前状态：waiting_user。`,
    '你正在与用户进行当前阶段的交互修改。先调用 bid_stage_inspect 读取最新目录、评分点、资料和缺口。',
    '按 inspect 返回的编号、标题和父子关系，把“第三章”“3.2”“服务方案下面第二个”对应到 objects.sections 或 objects.draft_sections 的位置。只有存在歧义时才询问用户；身份与草稿版本由程序绑定。',
    '明确修改可调用 bid_run_task 组合所需能力，不得直接 write Artifact 或绕过 Host 校验；首次整本确认仍由原生确认入口处理。',
    '目录拆分用 split_section，合并同级可写叶子用 merge_sections；局部重生成用 bid_outline_regenerate_scope。修改后重新 inspect 获取最新对象位置表，新增身份、顺序与草稿版本由程序生成。',
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
export function renderChapterWritingInteractionPrompt(status: 'running' | 'completed', stage = 'chapter_writing'): string {
  return [
    `当前 Bid 阶段：${stage}；当前状态：${status}。`,
    '先理解用户是在提问、解释已有正文，还是明确要求改变写作计划；不得用关键词、引用或发送方式替代语义判断。',
    '用户明确要求修改目录、招标理解、资料或正文时，可用 bid_run_task 按真实范围安排能力步骤；只讨论时保持只读。局部任务结果不等于全书重新验收。',
    '进度、安排原因和正文解释只调用 bid_stage_inspect 读取 Host 快照并回答，不修改计划、不停止写作；运行中的章节任务继续执行。',
    '只有用户明确要求改变写作任务时，才先调用 bid_stage_inspect(view=task_contract_context)，再调用 bid_confirm_writing_plan。提交成功表示新计划已保存并进入既有定向恢复链路，不代表受影响正文已经改完。',
    ...(status === 'running' ? ['用户明确说“不要视觉检查”“不用视觉检查”“跳过流程图视觉检查”时，调用 bid_set_flowchart_visual_review(policy="skip")；明确说“恢复视觉检查”“继续检查流程图”时，调用 bid_set_flowchart_visual_review(policy="required")。这是执行策略，不得写入 Writing Plan，不得调用 bid_confirm_writing_plan.patch；工具成功前不得声称策略已生效。'] : []),
    '引用正文只是上下文；解释时传给 bid_stage_inspect，明确修改时用 bid_run_task 的精确 paragraphs 范围和 chapter.revise。',
    '用户明确要求处理审批意见时，读取真实意见，用 bid_run_task 的 issue_positions 选择实际处理集合；程序绑定原始正文选区、授权范围和有关产物。能力由真实目标和产物依赖决定；纯正文可选 chapter.revision_batch，同章聚合、独立章节并行。确认执行后立即执行，不重复询问开始。',
    '段落意见中的小章节若需要真实目录结构而未获范围授权，只澄清真实目录子章还是选区内分项这一个关键问题；不得越权或用分项表格假称已经拆章。',
    '用户若只是讨论、咨询或明确要求暂缓（如"这些意见你怎么看""先总结一下""还有哪些地方值得改""先别动"等），严禁调用批次规划或执行工具。',
    '局部审批意见修订绝不启动 bid_confirm_writing_plan.patch，选区中的"统一""全部"是局部 RevisionIssue 要求；'
      + '只有用户明确给出全书级新约束（如"全文统一改为""所有章节都""整本控制在 N 页""全局统一术语"）才走 bid_confirm_writing_plan.patch。',
    status === 'running'
      ? '用户明确要求暂停新任务调度或继续时，分别调用 bid_pause_stage 或 bid_resume_stage；已经运行的 Writer/Reviewer 自然收敛。停止任务只使用聊天界面的原生停止。'
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
      ? '普通问答不修改产物；用户明确要求变更时可调用 bid_run_task，按实际资料和范围安排步骤，保留默认路线的首次确认。'
      : '普通消息不取消当前模型任务或已启动的 Child。用户明确要求变更时可调用 bid_run_task；若已有操作持有项目，Host 返回占用状态。用户明确要求暂停新任务调度或继续时，分别调用 bid_pause_stage 或 bid_resume_stage；已运行任务自然收敛。停止任务只使用聊天界面的原生停止。',
  ].join('\n')
}

function renderIdleStageInteractionPrompt(
  stage: string,
  status: 'ready' | 'failed',
): string {
  return [
    `当前 Bid 阶段：${stage}；当前状态：${status}。`,
    '先调用 bid_stage_inspect(view=summary) 获取权威状态。普通聊天只负责查询、解释和理解用户意图，不得直接 read/write Artifact。',
    status === 'ready' ? '普通问答不启动写操作；用户明确授权的局部修改可调用 bid_run_task，不能把该任务当作原生阶段确认。'
      : '先读取失败诊断。已终止的能力任务不能沿用原授权重试；用户明确澄清或给出新目标后，用 bid_run_task(supersede=true) 创建新 Work。Host 核对新的直接用户消息并保留旧候选；其他失败使用当前可用的恢复入口。',
    '若用户询问为什么没开始或现在能不能继续，应解释当前 Host 状态和正式入口。',
    status === 'ready'
      ? '阶段已经准备好；Host 将自动驱动，不把普通聊天当作启动命令。'
      : '当前阶段失败且没有可运行任务。读取 Host 失败诊断，说明程序或输入故障；由主会话处理根因，不得将相同模型候选当作恢复执行。',
  ].join('\n')
}

function renderSuspendedRunPrompt(
  stage: string, runId: string, revision: number, workKind: string, cause: string, reason?: string,
): string {
  const interrupted = cause !== 'user_stop' && cause !== 'awaiting_input'
  return [
    `当前 Bid 阶段：${stage}；Run 已挂起；suspended_run_id=${runId}；expected_project_revision=${String(revision)}。`,
    reason === undefined ? undefined : `中断原因：${reason}`,
    '先按用户完整语义判断：继续未完成任务、带新约束继续、修改当前阶段，或只进行问答。不得通过“继续”等关键词硬编码意图。',
    cause === 'awaiting_input'
      ? '等待输入须通过原生用户问题回答；普通聊天消息不能接管或放弃该问题。'
      : workKind === 'capability_task'
        ? cause === 'user_stop'
          ? '原 Work 的继续、重跑或停止仍由原生用户问题处理。用户明确提出新目标时，先用 bid_project_inspect(object=task) 核对旧目标和步骤，再用 bid_run_task(supersede=true) 创建新 Work；Host 绑定旧 Run 和项目版本。'
          : '继续同一目标时先用 bid_project_inspect(object=task) 核对原目标和步骤，必要时 bid_plan_task 重规划，再 bid_recover_task；只继续被打断的原 Work 时用 bid_resume_current_run。用户明确提出新目标时，用 bid_run_task(supersede=true) 创建新 Work；Host 绑定旧 Run 和项目版本。'
        : interrupted
          ? '用户明确要求继续时调用 bid_resume_current_run，传入当前 Run ID 和项目 revision；内部可修复失败由主 Agent inspect 后调用 bid_recover_task，普通询问保持只读。'
          : '挂起 Run 的继续、当前阶段重跑或停止由 Host 通过 DSH 原生用户提问处理；普通消息不视为这些决策的答案。',
    stage === 'chapter_writing' && workKind === 'stage_execution'
      ? interrupted
        ? '用户同时提出执行策略变化（如“继续，不用视觉检查”）时，先调用 bid_set_flowchart_visual_review 保存策略，再调用 bid_resume_current_run。不得只口头回复“已记录”。'
        : '用户在挂起状态下同时提出执行策略变化（如“继续，不用视觉检查”）时，先调用 bid_set_flowchart_visual_review 持久化策略；Run 的 continue/restart/stop 仍由原生 run_recovery 问题处理。不得只口头回复“已记录”。'
      : undefined,
  ].filter(line => line !== undefined).join('\n')
}

function renderCurrentRunProgress(run: BidRunData | null): string | undefined {
  if (run === null) return undefined
  const progress = run.progress
  if (progress === undefined) return '当前后台进度：阶段已启动，尚未产生首个里程碑。'
  return [
    '当前后台进度：',
    `阶段：${run.work.stage}`,
    `当前步骤：${progress.phase}`,
    `摘要：${progress.summary}`,
    ...progress.completed === undefined || progress.total === undefined
      ? [] : [`完成量：${String(progress.completed)} / ${String(progress.total)}`],
    ...progress.details?.map(detail => `补充：${detail}`) ?? [],
    `更新时间：${new Date(progress.updatedAt).toISOString()}`,
  ].join('\n')
}

const CAPABILITY_TASK_GUIDANCE = [
  'bid_project_inspect 返回 objects 对象选择表。bid_run_task 只选择各对象的 position，使用 section_positions、source_section_positions、issue_positions 等参数；不要抄写章节、审批意见、招标条目或模板的 ID。正文引用使用 section_position 与 start_paragraph/end_paragraph，Host 从原文绑定精确偏移及 SHA。任务与原文块身份由程序生成，正文迁移不要手工填写 assignments。',
  '项目阶段只表示默认整本路线的进度。当前状态允许新任务且用户明确修改时，先用 bid_project_inspect 读取事实，再用 bid_run_task 提交目标、根范围和有序能力步骤；普通讨论与解释只读。每个步骤的 description 用一句单行短摘要说明对象、动作和预期结果，最多 20 字；详细要求放在 call.input 中，不列子步骤、背景或验收细则，不只写“优化目录”等能力名称。步骤按真实依赖选择，不为凑步骤重复研究。',
  '根据用户目标、当前成果和能力的实际修改范围选择步骤，不按当前阶段或用户用词固定选路。tender.update 更正招标理解；outline.generate 首次生成目录；outline.update 编辑已有目录的层级、职责及跨分支结构；outline.refine 研究并深化各章节子树，不能调整顶层或跨分支移动；evidence.research 补充或替换资料映射；chapter.reorganize 分配旧正文；writing.plan 更新写作要求；chapter.write/revise/review 处理正文。',
  '规划前确认每项修改都由有权执行的能力承担，再按产物依赖安排后续步骤。已有资料或正文可复用时不重复生成。能力任务完成后读取实际结果，逐项核对用户目标；工具成功、资料覆盖或工作项完成不等于用户要求全部实现。',
  'bid_plan_task 替换未完成步骤时，每个新步骤的 description 同样使用最多 20 字的单行短摘要，与实际能力、业务输入和范围一致，详细要求放在 call.input 中。保留已完成步骤的说明与结果，不用执行状态或承诺完成的空话代替具体计划。',
  '已开始写作的原文迁移结果需要纠正时，新的直接用户消息可授权 bid_plan_task(edit=restart_pending)：保留已接纳前缀和旧候选历史，用 chapter.reorganize 完整覆盖原写作章节，再 chapter.write。该模式从最后已接纳结果执行，不导入未提交写作候选；自动恢复和 replace_pending 仍保留原候选。不得缩小范围、删除原文或重复改目录。',
  '用户要求纠正当前已发布结果时，先 inspect 原任务和当前成果，在原 Work 用 bid_plan_task(edit=append) 追加纠正步骤，再 bid_recover_task 重新核验发布。原完成步骤和发布凭据保留，不通过新 Work 重复执行原目录操作；只有独立的新目标才创建新 Work。',
  '同一用户消息通过 bid_plan_task 修正原 Work 后，Host 取消该消息先前通过 bid_run_task 排队的替代任务；独立的新目标应来自新的用户消息。恢复同一目标时直接修改原计划并恢复，不额外排队重复任务。',
  '子任务报告超出范围或无法完成时，主 Agent 负责调整能力计划。可恢复的失败任务先用 bid_project_inspect(object=task) 读取原目标、范围和实际步骤，再用 bid_plan_task(edit=replace_pending) 替换未提交结果的步骤，并用 bid_recover_task(target=run) 继续；验收失败但步骤已完成时用 edit=append 追加纠正步骤。Host 绑定原 Work、失败 Run 和未完成起点，不抄写身份或步骤索引；保持原目标和授权范围，保留已完成步骤。能力选择错误不需要用户重复授权；用户停止、等待输入或不可恢复故障遵守对应限制。',
  '拆分或合并已有正文的章节时，先 inspect 目录、正文和写作要求，再用 bid_run_task 提交完整有序执行计划：目录调整、原文迁移、结果复核。用户明确只改目录时才可留下待迁移正文；不要把目录步骤完成说成整项任务完成。',
  '用户要求执行修改即授权在真实保存范围内完成所需步骤；审批意见的 paragraph 引用不授予整章结构修改，明确扩展范围的新用户消息才可扩大；在同一回合提交完整任务，不只回复建议、保存计划或再次询问是否开始。计划因缺少后续步骤被拒绝时，补齐步骤并重新提交，不请求重复授权。用户只讨论或明确暂缓时不执行。',
  '目录操作的迁移时序由程序从后续 chapter.reorganize 或已授权的 allow_pending_content 推导，不提交 defer_content_migration。新增叶节之后必须安排 chapter.write 完成基于 seed 的写作及审核；chapter.review 只审核已有可恢复正文；仅用户明确只改目录或暂缓正文时才设置 task.allow_pending_content=true。不得自行把正文留给用户下一次催促。',
  'outline.update 新增或拆分章节的身份由 Host 生成；独立业务分配会话读取修改前的归属和生成后的真实叶节，按职责分配业务位置，程序绑定真实引用。Main 不为尚未生成的章节提交 business_bindings 或猜章节位置。修正已有候选章节的职责冲突时，先 inspect 候选的最新对象表，再用 operations=[] 与完整 business_bindings 修正归属；已开始的写作候选可在这类绑定步骤后恢复完整原范围的 chapter.write，不重复拆章或迁移。拆分后 chapter.reorganize 使用 task 范围并选择原 source_section_positions，后续复核可使用 previous_targets；保留原文不等于重新写作。',
  '目录研究已经完成且资料映射可用时，不要再追加重复的 evidence.research。深化后需继续处理旧正文时，在同一授权任务安排原文迁移及写作或审核。只修改选中的一句仍用段落级 chapter.revise，不扩成目录研究或整章重写。',
  '评分响应点是章节必须回答的要求，不等于目录标题。不得机械地把每个响应点、评分项第一条或 must_answer 文本提升为章节标题；按技术方案结构、用户框架和评分覆盖组织目录，把响应点绑定到合适的可写叶节。只有响应点确实构成独立方案主题时才作为标题。',
  '资料结果区分已核验的招标、本地或 Web 依据，本次拟采用且保留条件的方案设计，以及待补的企业事实或承诺。研究有 gap 时说明“已完成研究并标明缺口”；正文候选未完整通过时说明“候选已保留，仍需补充或修复”。不要把资料条数、计划或 metadata 当成正文已经通过的证明。',
  '任务根范围用 project、对象表的 section_positions 或 paragraphs 选区。步骤可继承根范围，也可使用 previous_targets 引用前一步真实结果。不要从“全部”“流程”等字词机械扩大范围。',
  'paragraphs 任务只包含一个 chapter.revise 步骤且 scope.source=task，根 reference 和修订 reference 选择相同对象。审批选区使用 issue_position 绑定原意见引用；其他连续原文块选择 section_position、start_paragraph/end_paragraph。Host 从原文计算精确偏移、文字和摘要，模型不计算或抄写。修订能力包含当前正文审核，不追加 chapter.review。',
  'paragraphs 引用只接受完整连续普通段落，不能选择表格或跨标题。表格修改须在用户已授权的章节范围内使用 chapter 引用，并在 instruction 中限定实际修改位置及保留内容。',
  '初次整本确认仍由原生确认入口完成；局部任务只凭本次真实用户消息授权。同一 Work 的恢复保留原目标与根范围，新用户目标必须创建新 Work。accepted 只表示 Host 接纳；queued、started、suspended、failed 不表示完成。只有 goal_met=true 且需发布的结果已有正式凭据时，才可向用户说已完成、已修改或已修复。',
].join('\n')

/**
 * 按实时阶段安装 scoped tools；全局 guard 拒绝交互期间的其他 Main Agent 工具调用。
 * @param ctx Host 插件上下文，负责全部注册释放。
 * @param execute 共享 Host 操作入口。
 * @param interacting 当前会话是否仍被阶段交互操作占用。
 * @param workspaceFor 当前会话对应的正式项目。
 */
export function installStageInteractionTools(
  ctx: Context,
  execute: (agent: Agent, request: unknown, signal: AbortSignal) => Promise<unknown>,
  interacting: (session: Session) => boolean,
  workspaceFor: (session: Session) => BidWorkspace,
): void {
  ctx.inject(['tools'], (toolCtx) => {
    const modelCatalogs = new WeakMap<Agent, BidModelTaskCatalog>()
    const mounted = new Map<Agent, { scope: string; dispose: () => void }>()
    const sync = (agent: Agent): void => {
      const task = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      const suspended = task.status === 'suspended' ? task.run : undefined
      const repairable = bidRecoverableRun(agent.session, task)
      const chatResume = suspended !== undefined && suspended.cause !== 'user_stop' && suspended.cause !== 'awaiting_input'
      const stage = isBidMainSession(agent.session) ? task.stage : undefined
      const scope = stage === undefined ? undefined : `${stage}:${suspended === undefined ? task.status : `suspended:${suspended.runId}`}`
      const recoveryAvailable = bidRunRecoveryEligibility(agent.session).eligible
        || bidWritingPlanRecoveryEligibility(agent.session).eligible
      const takeoverAvailable = bidCapabilityTakeoverRun(agent.session, task) !== undefined
      const hasGoal = toolCtx.get('goals')?.get(agent) !== undefined
      const actualScope = `${scope ?? 'none'}:${String(hasGoal)}:${String(recoveryAvailable)}:${String(takeoverAvailable)}`
      const existing = mounted.get(agent)
      if (existing?.scope === actualScope) return
      existing?.dispose()
      mounted.delete(agent)
      if (stage === undefined) return
      const tools = agent.ctx.get('tools')
      if (tools === undefined) throw new Error('Bid stage interaction requires tools')
      const available = task.status === 'ready' || task.status === 'failed'
        ? [BID_INTERACTION_TOOL_NAMES[0]]
        : suspended !== undefined
          ? task.stage === 'chapter_writing' && suspended.work.kind === 'stage_execution'
            ? [BID_INTERACTION_TOOL_NAMES[0], BID_INTERACTION_TOOL_NAMES[4], BID_INTERACTION_TOOL_NAMES[5], BID_INTERACTION_TOOL_NAMES[10]]
            : [BID_INTERACTION_TOOL_NAMES[0]]
          : task.status !== 'waiting_user'
            ? task.stage === 'chapter_writing' ? [BID_INTERACTION_TOOL_NAMES[0], BID_INTERACTION_TOOL_NAMES[4], BID_INTERACTION_TOOL_NAMES[5], BID_INTERACTION_TOOL_NAMES[6], BID_INTERACTION_TOOL_NAMES[7], ...(task.status === 'running' ? [...BID_INTERACTION_TOOL_NAMES.slice(8, 10), BID_INTERACTION_TOOL_NAMES[10]] : [])]
              : task.stage === 'docx_export' && task.status === 'completed' ? [BID_INTERACTION_TOOL_NAMES[0], BID_INTERACTION_TOOL_NAMES[5], BID_INTERACTION_TOOL_NAMES[6], BID_INTERACTION_TOOL_NAMES[7]]
                : task.status === 'running' ? [BID_INTERACTION_TOOL_NAMES[0], ...BID_INTERACTION_TOOL_NAMES.slice(8, 10)] : [BID_INTERACTION_TOOL_NAMES[0]]
            : stage === 'tender_analysis' ? BID_INTERACTION_TOOL_NAMES.slice(0, 1)
              : stage === 'outline_generation' ? BID_INTERACTION_TOOL_NAMES.slice(0, 3)
                : stage === 'evidence_mapping' ? BID_INTERACTION_TOOL_NAMES.slice(0, 4) : [BID_INTERACTION_TOOL_NAMES[0], BID_INTERACTION_TOOL_NAMES[4]]
      const installed = [...new Set([...available, 'bid_project_inspect',
        ...task.status === 'failed' && !takeoverAvailable || task.status === 'suspended'
          && (suspended?.work.kind !== 'capability_task' || suspended.cause === 'awaiting_input')
          ? [] : ['bid_run_task'],
        ...(repairable?.work.kind === 'capability_task'
          && repairable.cause !== 'awaiting_input' || bidCompletedCapabilityRun(agent.session, task) !== undefined) ? ['bid_plan_task'] : [],
        ...task.status === 'failed' || task.status === 'suspended' ? [] : [
          'bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap',
          'bid_confirm_writing_plan', 'bid_revise_chapter',
        ], ...(chatResume ? ['bid_resume_current_run'] : []),
        ...(recoveryAvailable ? [recoveryTool] : [])])].filter(name => name !== 'bid_plan_revision_batch'
        && name !== 'bid_execute_revision_batch' && name !== 'bid_revise_chapter')
      const disposers: Array<() => void> = []
      const text: JsonSchemaNode = { type: 'string' }
      const strings: JsonSchemaNode = { type: 'array', items: text }
      try {
        if (toolCtx.tools.get('create_goal', agent) !== undefined) disposers.push(tools.restrict({ deny: ['create_goal'] }))
        for (const name of installed) {
          const properties: Record<string, JsonSchemaNode> = {}
          const required = Object.keys(properties)
          const inputSchema = { io: 'input' } as const
          let parameters: JsonSchemaNode | undefined = name === 'bid_project_inspect'
            ? bidModelTaskJsonSchema(zodJsonSchema(modelProjectInspectParams, inputSchema))
            : name === 'bid_run_task' ? bidModelTaskJsonSchema(zodJsonSchema(modelRunTaskParams, inputSchema))
              : name === 'bid_plan_task' ? bidModelTaskJsonSchema(zodJsonSchema(modelPlanTaskParams, inputSchema))
                : name === 'bid_resume_current_run' ? zodJsonSchema(z.object({}).strict(), inputSchema)
                  : name === recoveryTool ? zodJsonSchema(modelRecoverTaskParams, inputSchema) : undefined
          const chapterReference: JsonSchemaNode = { oneOf: [{
            type: 'object', properties: { section_id: text, content_sha256: text, scope: { type: 'string', enum: ['chapter'] } },
            required: ['section_id', 'content_sha256', 'scope'], additionalProperties: false,
          }, {
            type: 'object', properties: { section_id: text, content_sha256: text, scope: { type: 'string', enum: ['paragraphs'] },
              start: { type: 'integer' }, end: { type: 'integer' }, text },
            required: ['section_id', 'content_sha256', 'scope', 'start', 'end', 'text'], additionalProperties: false,
          }] }
          if (name === 'bid_stage_inspect') {
            properties.view = { type: 'string', enum: ['summary', 'task_contract_context', 'recovery'] }
            properties.reference = chapterReference
          }
          if (name === 'bid_set_flowchart_visual_review') {
            properties.policy = { type: 'string', enum: ['required', 'skip'] }
            required.push('policy')
          }
          if (name === 'bid_revise_chapter') {
            properties.instruction = text
            properties.reference = chapterReference
            required.push('instruction', 'reference')
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
                update_kind: { type: 'string', enum: ['initial'] }, writing_request_id: text, attempt_id: text, user_message_refs: messageRefs,
                global_instructions: strings, document_acceptance: { type: 'array', items: acceptanceCriterion },
                sections: initialSections,
              }, required: ['update_kind', 'writing_request_id', 'attempt_id', 'user_message_refs', 'global_instructions', 'document_acceptance', 'sections'], additionalProperties: false,
            }, {
              type: 'object', properties: {
                update_kind: { type: 'string', enum: ['patch'] }, base_plan_version: { type: 'integer' },
                user_message_refs: messageRefs, summary: text, affected_section_ids: strings,
                global_instructions: strings, document_acceptance: criterionDelta, sections: patchSections,
              }, required: ['update_kind', 'base_plan_version', 'user_message_refs', 'summary', 'affected_section_ids', 'sections'], additionalProperties: false,
            }] }
          }
          if (name === 'bid_plan_revision_batch') {
            const batchTask: JsonSchemaNode = {
              type: 'object', properties: {
                task_id: text, section_id: text, issue_ids: strings, depends_on: strings, dependency_reason: text,
              }, required: ['task_id', 'section_id', 'issue_ids', 'depends_on'], additionalProperties: false,
            }
            parameters = {
              type: 'object', properties: {
                expected_queue_revision: { type: 'integer' },
                issue_ids: strings,
                tasks: { type: 'array', items: batchTask },
              }, required: ['expected_queue_revision', 'issue_ids', 'tasks'], additionalProperties: false,
            }
          }
          if (name === 'bid_execute_revision_batch') {
            parameters = {
              type: 'object', properties: { batch_id: text },
              required: ['batch_id'], additionalProperties: false,
            }
          }
          if (name === 'bid_confirm_writing_plan' && parameters !== undefined) parameters = bidModelTaskJsonSchema(parameters)
          if (name === 'bid_stage_inspect') parameters = bidModelTaskJsonSchema({
            type: 'object', properties, required, additionalProperties: false,
          })
          if (['bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap'].includes(name)) {
            const native = stageInteractionSchema.options.find(option => option.shape.action.value === name)
            if (native === undefined) throw new Error('BID_MODEL_OUTLINE_SCHEMA_MISSING')
            parameters = bidModelOutlineEditJsonSchema(zodJsonSchema(native, inputSchema))
          }
          const definition: ToolDefinition = {
            name,
            description: name === recoveryTool ? '主 Agent 对 inspect recovery 的当前失败目标提交具体修复办法，Host 校验并执行；相同问题必须改变策略。'
              : name === 'bid_resume_current_run' ? '继续当前已授权的挂起任务，Host 绑定 Run 和项目版本；内部可修复失败使用 bid_recover_task。'
                : name === 'bid_stage_inspect' ? '读取当前阶段的有界权威快照；传正文引用时校验原文身份并返回受控正文。'
                  : name === 'bid_project_inspect' ? '按真实项目对象与章节位置分页读取已保存资料；不依赖当前阶段，也不修改项目。'
                    : name === 'bid_run_task' ? '用当前用户消息或原生 Goal 轮次授权有序业务能力任务；Host 核对项目输入、范围和候选文件，再发布实际结果。提问与讨论不得调用。'
                      : name === 'bid_plan_task' ? '调整挂起能力任务的未完成步骤；用户要求纠正当前已发布结果时可 append 追加到原 Work。保留已完成步骤与历史发布凭据，保存后调用恢复能力继续。'
                        : name === 'bid_set_flowchart_visual_review' ? '设置当前 S5 work 的流程图视觉检查策略。skip 表示后续不再启动新的流程图视觉确认；required 表示恢复正常视觉确认。设置会写入当前 work 的命令日志并在挂起恢复后继续生效。'
                          : name === 'bid_pause_stage' ? '仅在用户明确要求暂停时阻止后续阶段任务启动；已经运行的任务继续收敛。'
                            : name === 'bid_resume_stage' ? '仅在用户明确要求继续时释放当前阶段的新任务调度门。'
                              : name === 'bid_revise_chapter' ? '仅在用户明确要求修改引用正文时，把意见交给该章原 Writer；普通解释不得调用。'
                                : name === 'bid_confirm_writing_plan' ? '保存已获用户确认或直接开始授权的整体写作计划；成功后 Host 启动既有 S5 写作链路。'
                                  : name === 'bid_plan_revision_batch' ? '将待处理审批意见规划成不可变批次快照；同章节强制聚合，Host 校验依赖图与版本后标记 scheduled，不启动 Writer。'
                                    : name === 'bid_execute_revision_batch' ? '启动已规划批次的修订执行；复用现有 S5 调度机制按 task 依赖和并发限制逐 section 修订，不重置已完成的章节。'
                                      : name === 'bid_evidence_remap' ? '只重新研究选中章节或分支。replace 替换旧证据；supplement 保留并补充。完成后等待用户正式确认。'
                                        : name === 'bid_outline_regenerate_scope' ? '按反馈局部重生成选中章节，保留范围外目录。完成后等待正式确认。'
                                          : '选择最近 inspect 的 draft_sections 位置执行结构化目录编辑；Host 绑定草稿对象和版本，更新后仍需正式确认。',
            parameters: (parameters ?? { type: 'object', properties, required, additionalProperties: false }) as Record<string, unknown>,
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, exec) {
              if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
              if (name === 'bid_resume_current_run') {
                z.object({}).strict().parse(args)
                const state = await readBidProjectState(workspaceFor(agent.session))
                if (state?.status !== 'suspended') throw new Error('BID_RUN_RESUME_NOT_READY')
                return execute(agent, { action: name, run_id: state.run.runId,
                  expected_project_revision: state.revision }, exec.signal)
              }
              if (name === recoveryTool) {
                const request = modelRecoverTaskParams.parse(args)
                if (request.target === 'run') {
                  const target = bidRunRecoveryEligibility(agent.session).target
                  if (target === undefined) throw new Error('BID_RECOVERY_TARGET_MISSING')
                  return execute(agent, { action: name, ...request, run_id: target.runId }, exec.signal)
                }
                const target = bidWritingPlanRecoveryEligibility(agent.session).target
                if (target === undefined) throw new Error('BID_RECOVERY_TARGET_MISSING')
                return execute(agent, { action: name, ...request,
                  writing_request_id: target.requestId, attempt_id: target.attemptId }, exec.signal)
              }
              if (name === 'bid_plan_task') {
                const request = z.object({ edit: planEditSchema, steps: z.array(z.unknown()) }).strict().parse(args)
                const state = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
                const catalog = modelCatalogs.get(agent)
                if (catalog === undefined) throw new Error('BID_MODEL_TASK_INSPECT_REQUIRED')
                const run = bidRecoverableRun(agent.session, state) ?? bidCompletedCapabilityRun(agent.session, state)
                if (run === undefined || state.status === 'completed' && request.edit !== 'append') throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
                const workspace = workspaceFor(agent.session)
                const path = within(workspace.projectRoot, `runs/${run.work.workId}/task-checkpoint.json`)
                await assertNoLinkedPath(workspace.root, path)
                const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(path, 'utf8')))
                const from_index = request.edit === 'append' ? checkpoint.steps.length
                  : checkpoint.steps.findIndex(step => step.status !== 'completed')
                if (from_index < 0) throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
                return execute(agent, { action: name, work_id: run.work.workId, from_index,
                  ...request.edit === 'restart_pending' ? { restart_pending: true } : {},
                  steps: bindBidModelSteps(request.steps, catalog) }, exec.signal)
              }
              if (name === 'bid_run_task') {
                const catalog = modelCatalogs.get(agent)
                if (catalog === undefined) throw new Error('BID_MODEL_TASK_INSPECT_REQUIRED')
                const request = z.object({ task: z.unknown(), supersede: z.boolean().optional() }).strict().parse(args)
                let supersede: z.infer<typeof supersedeSchema> | undefined
                if (request.supersede === true) {
                  const state = await readBidProjectState(workspaceFor(agent.session))
                  const run = state === undefined ? undefined : bidCapabilityTakeoverRun(agent.session, state)
                  if (run === undefined || state === undefined) throw new Error('BID_CAPABILITY_SUPERSEDE_NOT_ALLOWED')
                  supersede = { run_id: run.runId, expected_project_revision: state.revision }
                }
                return execute(agent, { action: name, ...supersede === undefined ? {} : { supersede },
                  task: bindBidModelTask(request.task, catalog) }, exec.signal)
              }
              if (name === 'bid_project_inspect') {
                const raw = z.object({ query: z.unknown(), objects_page: z.number().int().nonnegative().optional() }).strict().parse(args)
                const catalog = modelCatalogs.get(agent) ?? await collectBidModelTaskCatalog(workspaceFor(agent.session), agent.session)
                const query = bindBidModelProjectQuery(raw.query, catalog)
                const result = await execute(agent, { query, action: name }, exec.signal)
                const state = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
                const catalogWorkspace = await resolveBidProjectInspectWorkspace(workspaceFor(agent.session), query,
                  undefined, bidRecoverableRun(agent.session, state)?.work)
                if (catalogWorkspace === undefined) {
                  modelCatalogs.delete(agent)
                  return result
                }
                const current = await collectBidModelTaskCatalog(catalogWorkspace, agent.session)
                modelCatalogs.set(agent, current)
                return { ...result as object, objects: presentBidModelTaskCatalog(current,
                  query.object === 'chapters' ? query.section_ids : [], { page: raw.objects_page ?? ('page' in query ? query.page ?? 0 : 0),
                    pageSize: 'page_size' in query ? query.page_size ?? 20 : 20,
                    ...query.object === 'chapters' ? { offset: query.offset ?? 0, maxChars: query.max_chars ?? 6_000 } : {} }) }
              }
              if (name === 'bid_stage_inspect') {
                const request = z.object({ view: z.enum(['summary', 'task_contract_context', 'recovery']).optional(),
                  reference: z.unknown().optional() }).strict().parse(args)
                const catalog = modelCatalogs.get(agent) ?? await collectBidModelTaskCatalog(workspaceFor(agent.session), agent.session)
                const reference = request.reference === undefined ? undefined : bindBidModelReference(request.reference, catalog)
                const result = await execute(agent, { action: name, view: request.view,
                  ...reference === undefined ? {} : { reference } }, exec.signal)
                // 状态与恢复查询沿用最近对象表；正文读取才切换到其正式项目来源。
                const current = reference === undefined ? catalog
                  : await collectBidModelTaskCatalog(workspaceFor(agent.session), agent.session)
                modelCatalogs.set(agent, current)
                return { ...result as object,
                  objects: presentBidModelTaskCatalog(current, reference === undefined ? [] : [reference.section_id]) }
              }
              if (name === 'bid_confirm_writing_plan') {
                const catalog = modelCatalogs.get(agent)
                if (catalog === undefined) throw new Error('BID_MODEL_TASK_INSPECT_REQUIRED')
                return execute(agent, { action: name, ...bindBidModelWritingPlan(args, catalog) }, exec.signal)
              }
              if (['bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap'].includes(name)) {
                const catalog = modelCatalogs.get(agent)
                if (catalog === undefined) throw new Error('BID_MODEL_TASK_INSPECT_REQUIRED')
                return execute(agent, { action: name, ...bindBidModelOutlineEdit(args, catalog) }, exec.signal)
              }
              return execute(agent, { ...(args as Record<string, unknown>), action: name }, exec.signal)
            },
            presentCall: () => ({ card: 'generic', title: name }),
          }
          disposers.push(tools.register(definition))
        }
        if (task.status === 'waiting_user') {
          disposers.push(tools.restrict({ allow: hasGoal
            ? ['get_goal', 'update_goal'].filter(name => toolCtx.tools.get(name, agent) !== undefined) : [] }))
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      mounted.set(agent, { scope: actualScope, dispose: () => { for (const dispose of disposers.reverse()) dispose() } })
    }
    const publicRestrictions = new Map<Agent, () => void>()
    const claimState = new Map<Agent, { turn: number; boundary: string; hasUser: boolean }>()
    const releasePublic = (agent: Agent): void => {
      publicRestrictions.get(agent)?.()
      publicRestrictions.delete(agent)
    }
    toolCtx.effect(() => toolCtx.tools.guard((exec) => {
      const subject = exec.agent
      const session = subject?.session
      if (subject === undefined || session === undefined || !isBidMainSession(session)) return
      const task = session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      if (exec.name === 'create_goal') return 'BID_EXPLICIT_GOAL_COMMAND_REQUIRED'
      if (exec.name === 'bid_resume_current_run' && resolveBidToolAuthorization(subject) === undefined) return 'BID_USER_CONTINUATION_REQUIRED'
      if ((task.status === 'waiting_user' || task.status === 'suspended' || interacting(session) || publicRestrictions.has(subject))
        && !BID_INTERACTION_TOOL_NAMES.includes(exec.name as typeof BID_INTERACTION_TOOL_NAMES[number])
        && exec.name !== recoveryTool && exec.name !== 'get_goal' && exec.name !== 'update_goal') return 'BID_STAGE_TOOL_REQUIRED'
    }))
    toolCtx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!isBidMainSession(agent.session)) return
      const task = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      if (task.status !== 'ready' && task.status !== 'failed' && task.status !== 'running'
        && task.status !== 'completed' && task.status !== 'suspended') return
      const previous = claimState.get(agent)
      const prior = agent.session.events.findLast(event => event.type === 'step/end' && event.data.turn === turn)
      const priorStep = prior?.type === 'step/end' ? prior.data.step : 0
      const boundary = `${String(turn)}:${String(priorStep)}`
      const state = previous?.boundary === boundary ? previous
        : { turn, boundary, hasUser: false }
      if (message.source.kind === 'user') {
        state.hasUser = true
        const tools = agent.ctx.get('tools')
        if (tools === undefined) throw new Error('Bid stage interaction requires tools')
        if (!publicRestrictions.has(agent)) publicRestrictions.set(agent, tools.restrict({
          allow: toolCtx.get('goals')?.get(agent) === undefined ? []
            : ['get_goal', 'update_goal'].filter(name => toolCtx.tools.get(name, agent) !== undefined),
        }))
      } else if (!state.hasUser) releasePublic(agent)
      claimState.set(agent, state)
    }, { global: true })
    toolCtx.on('agent/session-start', ({ agent }) => { sync(agent) }, { global: true })
    toolCtx.on('session/event', (session, event) => {
      if (!event.type.startsWith('bid.')) return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) sync(agent)
    }, { global: true })
    toolCtx.on('goal/changed', ({ agent }) => { sync(agent) }, { global: true })
    toolCtx.on('agent/status', ({ agent, status }) => { if (status === 'idle') { releasePublic(agent); claimState.delete(agent) } }, { global: true })
    toolCtx.on('agent/disposed', ({ agent }) => {
      releasePublic(agent)
      claimState.delete(agent)
      mounted.get(agent)?.dispose()
      mounted.delete(agent)
    }, { global: true })
    toolCtx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      const task = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
      if (decision.kind === 'reject' || !isBidMainSession(agent.session)) return decision
      const goalRound = messages.some(message => message.source.kind === 'goal' && message.source.round > 0)
      const hasUser = messages.some(message => message.source.kind === 'user')
      const failureMessage = messages.some(message => message.source.kind === 'plugin'
        && message.source.plugin === '@deepseek-ai/dsh-bid' && message.source.form === 'notice'
        && message.source.summary === 'Bid 执行失败，交由主 Agent 处理')
      if (!goalRound && !hasUser && !failureMessage) return decision
      const resumed = agent.session.events.findLast(event => event.type === 'bid.project.resumed')
      const suspended = task.status === 'suspended' ? task.run : undefined
      const prompt = failureMessage
        ? '你是当前 Bid Main Agent。Host 已保存真实失败状态。先调用 bid_stage_inspect(view="recovery") 分析 failure、issues、checkpoint 和已完成成果。eligible=true 时判断是执行失败还是能力计划无法完成目标；需要换能力时先用 bid_plan_task 调整未完成步骤，再调用 bid_recover_task；eligible=false 时向用户解释真实阻断及需要的动作，不机械重试。'
        : suspended !== undefined ? renderSuspendedRunPrompt(
          task.stage,
          suspended.runId,
          resumed?.type === 'bid.project.resumed' ? resumed.data.revision : suspended.baseProjectRevision,
          suspended.work.kind,
          suspended.cause,
          suspended.error?.message,
        ) : task.status === 'waiting_user' ? renderStageInteractionPrompt(task.stage)
          : (task.stage === 'chapter_writing' && (task.status === 'running' || task.status === 'completed')
            || task.stage === 'docx_export' && task.status === 'completed')
            ? renderChapterWritingInteractionPrompt(task.status, task.stage)
            : task.status === 'running' || task.status === 'completed'
              ? renderLiveStageInteractionPrompt(task.stage, task.status)
              : task.status === 'ready' || task.status === 'failed'
                ? renderIdleStageInteractionPrompt(task.stage, task.status) : undefined
      if (prompt === undefined) return decision
      const progress = task.status === 'running' ? renderCurrentRunProgress(task.run) : undefined
      const context = `${prompt}\nBid 模式不通过模型创建 Goal。Goal 只能由用户显式 /goal 创建；已有 Goal 可正常读取和更新。后台失败交由你分析并通过当前公开能力处理；Host 只校验和执行。\n${CAPABILITY_TASK_GUIDANCE}${progress === undefined ? '' : `\n${progress}`}`
      return { kind: 'enter', messages: [createUserMessage({ content: [{ type: 'text', text: context }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }), ...decision.messages] }
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
