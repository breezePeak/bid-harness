/** 同一 Work 的有序能力步骤、候选产物检查点和结果发布。 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { hasBidTaskAuthorization, resolveBidToolAuthorization } from './bid-tool-authorization.ts'
import { bidRunRecoveryEligibility } from './bid-recovery.ts'
import { pendingCapabilityWorkIds, readPendingCapabilityRequests } from './bid-capability-queue.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { BidWorkspace } from './index.ts'
import {
  bidCapabilityResultSchema, bidCapabilityStepSchema, bidCapabilityTaskSchema,
  validateCapabilityTaskContentFollowup,
  type BidCapabilityCall, type BidCapabilityExecutionContext, type BidCapabilityResult,
  type BidCapabilityStep, type BidCapabilityTask,
} from './bid-capability-contract.ts'
import { BID_CAPABILITIES, resolveCapabilityStepScope, validateCapabilityResult,
  verifyCapabilityTaskScope } from './bid-capability-registry.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact, parseOutlineDraft } from './outline-confirmation-artifacts.ts'
import { parseChapterExecutionPlan, parseOrMigrateChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseWritingPlan } from './writing-requirements.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { capabilityPublicationReceiptSchema, readCapabilityPublicationReceipt, readCapabilityPublicationRecord,
  readCapabilityStepReceipt, publishCapabilityChanges, publishCapabilityStepChanges,
  type CapabilityPublicationReceipt } from './bid-capability-changes.ts'
import type { BidRunContext } from './run-coordinator.ts'
import { bidInputFingerprint, bidWorkDescriptorSchema, bidWorkRoot, persistBidWorkRequest, readBidWorkRequest } from './work-descriptor.ts'
import { BID_STAGES, type BidStage, type BidWorkDescriptor } from './control-plane-contract.ts'
import { bidTaskStateSchema } from './runtime-state.ts'
import { prepareBidWorkingTree } from './working-tree.ts'
import { reconcileBidPublications } from './publication-batch.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { bidTaskSourceSnapshotSchema, bindBidTaskSourceContext, freezeBidTaskSource, type BidTaskSourceSnapshot } from './bid-task-source.ts'
import { bidTaskVerificationSchema, collectBidTaskEvidence, collectBidTaskScopeEvidence, collectBidTaskPreservationEvidence,
  modelBidTaskVerifier, validateBidTaskVerification,
  type BidTaskVerifier, type BidTaskVerification, type BidTaskVerificationInput } from './bid-task-verification.ts'
import { readPendingChapterReorganization } from './outline-capability-update.ts'
import { resolveBidTaskSections } from './bid-task-sections.ts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const messageReferenceSchema = z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict()
const outputFileSchema = z.object({ path: z.string().min(1), sha256: sha256Schema }).strict()
// 摘要长度约束新计划提交；持久请求的展示文字不能撤销已冻结的授权和输入身份。
const storedStepSchema = bidCapabilityStepSchema.extend({
  description: bidCapabilityTaskSchema.shape.goal.default('继续执行已接纳的任务步骤'),
})
const storedTaskScopeSchema = bidCapabilityTaskSchema.safeExtend({
  steps: z.array(storedStepSchema.extend({ description: bidCapabilityTaskSchema.shape.goal })).min(1),
})
const storedTaskSchema = z.object({
  ...bidCapabilityTaskSchema.shape, steps: z.array(storedStepSchema).min(1),
})
  .strict().superRefine((task, ctx) => {
    const result = storedTaskScopeSchema.safeParse(task)
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue })
  })
const writingResumeSeedSchema = z.object({
  input_sha256: sha256Schema,
  source_step_id: z.string().min(1).optional(),
  section_ids: z.array(z.string().min(1)).nullable(),
  files: z.array(outputFileSchema),
  removed_paths: z.array(z.string().min(1)),
}).strict()

/** 不可变 Work 请求，用户消息身份用于精确去重和授权。 */
export const capabilityTaskRequestSchema = z.object({
  task: storedTaskSchema,
  source_snapshot: bidTaskSourceSnapshotSchema.optional(),
  complete_task: storedTaskSchema.optional(),
  authorization: messageReferenceSchema,
  input_sources: z.array(outputFileSchema),
  return_state: bidTaskStateSchema.refine(state =>
    state.status === 'ready' || state.status === 'waiting_user' || state.status === 'completed'),
}).strict()
/** Work 接纳时冻结的计划、授权、输入和任务前状态。 */
export type CapabilityTaskRequest = z.infer<typeof capabilityTaskRequestSchema>

const pendingStepSchema = z.object({
  step_id: z.string().min(1), step: storedStepSchema, status: z.literal('pending'),
  authorization: messageReferenceSchema,
  answer_question_id: z.string().min(1).optional(),
  writing_resume_seed: writingResumeSeedSchema.optional(),
}).strict()
const completedStepSchema = pendingStepSchema.omit({ status: true }).extend({
  status: z.literal('completed'), input_sha256: sha256Schema,
  result: bidCapabilityResultSchema, files: z.array(outputFileSchema), removed_paths: z.array(z.string().min(1)),
}).strict()
const runningStepSchema = pendingStepSchema.omit({ status: true }).extend({
  status: z.literal('running'), input_sha256: sha256Schema,
}).strict()
const awaitingStepSchema = pendingStepSchema.omit({ status: true }).extend({
  status: z.literal('awaiting_input'), input_sha256: sha256Schema,
  result: bidCapabilityResultSchema, question_id: z.string().min(1),
  candidate_files: z.array(outputFileSchema).optional(),
  removed_paths: z.array(z.string().min(1)).optional(),
}).strict()
const stepRecordSchema = z.discriminatedUnion('status', [pendingStepSchema, runningStepSchema,
  completedStepSchema, awaitingStepSchema])
const planPatchSchema = z.object({
  from_index: z.number().int().nonnegative(), authorization: messageReferenceSchema,
  steps: z.array(storedStepSchema),
  writing_resume_seed: writingResumeSeedSchema.optional(),
  restart_pending: z.literal(true).optional(),
}).strict()

/** 同一 Work 的步骤记录；项目总状态仍只由 BidTaskState 表达。 */
export const capabilityTaskCheckpointSchema = z.object({
  schema_version: recordOnlySchemaVersion(1),
  work_id: z.string().min(1),
  request_sha256: sha256Schema,
  steps: z.array(stepRecordSchema).min(1),
  plan_patches: z.array(planPatchSchema),
  verifications: z.array(bidTaskVerificationSchema).optional(),
  original_section_ids: z.array(z.string().min(1)).optional(),
  publications: z.array(z.object({ completed_step_count: z.number().int().positive(),
    receipt: capabilityPublicationReceiptSchema }).strict()).optional(),
}).strict()
/** 同一 Work 的步骤执行记录及后续授权补丁。 */
export type CapabilityTaskCheckpoint = z.infer<typeof capabilityTaskCheckpointSchema>

/** 能力适配器只能在 Host 授权的候选文件中写入。 */
export interface CapabilityTaskDispatcher {
  /** 测试可显式替换语义核验；Host 的身份与产物检查始终执行。 */
  readonly verifyTask?: BidTaskVerifier
  /** 返回当前能力可写的精确项目相对路径。 */
  allowedWrites(call: BidCapabilityCall, sectionIds: ReadonlySet<string> | null, working: BidWorkspace,
    stepId: string): Promise<ReadonlySet<string>>
  /** 对执行中生成的受账本约束文件补充精确路径；恢复时也从当前候选重算。 */
  allowedWritesAfter?(call: BidCapabilityCall, working: BidWorkspace): Promise<ReadonlySet<string>>
  /** 在候选项目执行一个业务能力；返回真实变更结果和精确删除文件。 */
  execute(call: BidCapabilityCall, context: BidCapabilityExecutionContext): Promise<{
    readonly result: BidCapabilityResult
    readonly removedPaths?: readonly string[]
  }>
  /** 在当前步骤候选项目中校验业务结果；拒绝时不合并到 Work 候选。 */
  validate(call: BidCapabilityCall, context: BidCapabilityExecutionContext, result: BidCapabilityResult): Promise<void>
}

/** 同一 Run 的阶段结算由调用者管理。 */
export type CapabilityTaskOutcome =
  | { readonly status: 'completed'; readonly receipt: CapabilityPublicationReceipt; readonly results: readonly BidCapabilityResult[] }
  | { readonly status: 'awaiting_input'; readonly stepId: string; readonly questionId: string; readonly result: BidCapabilityResult }

/**
 * 读取等待输入的持久化步骤，供 Host 重启后重新显示同一个原生问题。
 * @param workspace 正式项目。
 * @param workId 原能力 Work。
 * @param requestSha256 原请求摘要。
 * @returns 当前待回答步骤；没有待回答步骤时为 null。
 */
export async function readCapabilityAwaitingInput(
  workspace: BidWorkspace, workId: string, requestSha256: string,
): Promise<Extract<CapabilityTaskOutcome, { status: 'awaiting_input' }> | null> {
  const path = checkpointPath(workspace, workId)
  await assertNoLinkedPath(workspace.root, path)
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (checkpoint.work_id !== workId || checkpoint.request_sha256 !== requestSha256) {
    throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
  }
  const step = checkpoint.steps.find(record => record.status === 'awaiting_input')
  return step?.status === 'awaiting_input'
    ? { status: 'awaiting_input', stepId: step.step_id, questionId: step.question_id, result: step.result }
    : null
}

/**
 * 在公开主会话保存并重放同一个原生问题；只有真实自由文本回答才继续步骤。
 * @param session 原 Work 所属公开会话。
 * @param workId 原能力 Work。
 * @param outcome 已持久化的等待输入结果。
 * @param ask 原生用户提问入口。
 * @param flush Session 事件落盘入口。
 * @returns 回答已保存或曾保存时为 true；选择稍后补充时为 false。
 */
export async function askCapabilityTaskInput(
  session: Session, workId: string, outcome: Extract<CapabilityTaskOutcome, { status: 'awaiting_input' }>,
  ask: (question: AskUserQuestionItem) => Promise<AskUserQuestionAnswerItem>,
  flush: () => Promise<void>,
): Promise<boolean> {
  if (capabilityTaskAnswer(session, workId, outcome.stepId, outcome.questionId) !== undefined) return true
  const persisted = session.events.findLast(event => event.type === 'bid.capability.input.required'
    && event.data.workId === workId && event.data.stepId === outcome.stepId
    && event.data.questionId === outcome.questionId)
  const question: AskUserQuestionItem = persisted?.type === 'bid.capability.input.required'
    ? persisted.data.question : {
      id: outcome.questionId,
      header: '补充任务输入',
      question: '当前能力步骤需要补充信息。请填写所需内容，或选择稍后补充。',
      detail: outcome.result.missing_topics.slice(0, 8).map(topic => topic.slice(0, 240)).join('\n').slice(0, 2000),
      options: [{ label: '稍后补充' }],
    }
  if (persisted === undefined) {
    session.append('bid.capability.input.required', {
      workId, stepId: outcome.stepId, questionId: outcome.questionId, question,
    })
    await flush()
  }
  const answer = await ask(question)
  if (answer.id !== outcome.questionId || answer.selected.some(label => label !== '稍后补充')) {
    throw new Error('BID_CAPABILITY_INPUT_ANSWER_INVALID')
  }
  const custom = answer.custom?.trim()
  if (custom === undefined || custom.length === 0) return false
  if (custom.length > 4000) throw new Error('BID_CAPABILITY_INPUT_ANSWER_TOO_LONG')
  session.append('bid.capability.input.received', { workId, stepId: outcome.stepId,
    questionId: outcome.questionId, answer: { id: answer.id, selected: [], custom } })
  await flush()
  return true
}

function checkpointPath(workspace: BidWorkspace, workId: string): string {
  return within(workspace.projectRoot, `runs/${workId}/task-checkpoint.json`)
}

/**
 * 核对已授权的不可变 Work 是否仅因模型重判授权而终止。
 * @param canonical 拥有请求和检查点的正式项目。
 * @param work 失败 Run 的原 Work 身份。
 * @param session 原授权 Main 会话。
 * @returns 原来源有效、原授权已通过且最新业务检查全部通过时为 true。
 */
export async function isCapabilityAuthorizationRecheckFailure(
  canonical: BidWorkspace, work: BidWorkDescriptor, session: Session,
): Promise<boolean> {
  if (work.kind !== 'capability_task') return false
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(canonical, work))
  if (request.authorization.session_id !== String(session.id)) return false
  bindBidTaskSourceContext(session, request.source_snapshot
    ?? await freezeBidTaskSource(canonical, session, request.task, request.authorization))
  const path = checkpointPath(canonical, work.workId)
  await assertNoLinkedPath(canonical.root, path)
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (checkpoint.work_id !== work.workId || checkpoint.request_sha256 !== work.requestSha256) {
    throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
  }
  const authorized = checkpoint.verifications?.find(record => record.phase === 'plan'
    && record.scope_authorized && record.unmet.length === 0 && record.goal_met)
  const latest = checkpoint.verifications?.at(-1)
  return authorized !== undefined && latest !== undefined && !latest.scope_authorized
    && latest.unmet.length === 0 && latest.checks.length === latest.requirements.length
    && latest.checks.every(check => check.met)
    && bidInputFingerprint(latest.requirements) === bidInputFingerprint(authorized.requirements)
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

const EVIDENCE_RECOVERY_PATHS = [
  'analysis/evidence-mapping-plan.json', 'analysis/evidence-mapping-log.json',
  'analysis/evidence-mapping-checkpoint.json', 'analysis/evidence-map.candidate.json',
  'analysis/evidence-mapping-quality.candidate.json', 'outline/refined-outline.candidate.json',
] as const
const WRITING_RECOVERY_PATHS = [
  ...EVIDENCE_RECOVERY_PATHS,
  'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json',
  'chapters/completion-review.json', 'chapters/global-compliance-review.json',
] as const

function stepCandidateWorkspace(working: BidWorkspace, parent: BidWorkDescriptor,
  stepId: string, inputSha256: string): { workspace: BidWorkspace; descriptor: BidWorkDescriptor } {
  const stepWorkId = `${stepId}-${inputSha256.slice(0, 12)}`
  const descriptor = { ...parent, workId: stepWorkId, inputFingerprint: inputSha256,
    requestRef: `requests/${stepWorkId}.json` }
  const root = bidWorkRoot(working, descriptor)
  return { descriptor, workspace: new BidWorkspace(root, working.config) }
}

/**
 * 读取同一 Work 当前或最近完成的研究步骤工作区；不复用项目根目录的旧日志。
 * @param canonical 项目正式工作区。
 * @param work 当前能力 Work。
 * @returns 同 Work 的研究步骤私有工作区；未执行研究时返回 null。
 */
export async function activeCapabilityMappingWorkspace(
  canonical: BidWorkspace, work: BidWorkDescriptor,
): Promise<BidWorkspace | null> {
  if (work.kind !== 'capability_task') return null
  const path = checkpointPath(canonical, work.workId)
  await assertNoLinkedPath(canonical.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(raw))
  if (checkpoint.work_id !== work.workId || checkpoint.request_sha256 !== work.requestSha256) {
    throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
  }
  const mappingStep = (record: z.infer<typeof stepRecordSchema>) =>
    record.step.call.capability === 'outline.refine' || record.step.call.capability === 'evidence.research'
  const step = checkpoint.steps.find(record =>
    (record.status === 'running' || record.status === 'awaiting_input')
    && mappingStep(record)) ?? checkpoint.steps.findLast(record => record.status === 'completed' && mappingStep(record))
  if (step === undefined || step.status === 'pending') return null
  try {
    const working = new BidWorkspace(bidWorkRoot(canonical, work), canonical.config)
    return stepCandidateWorkspace(working, work, step.step_id, step.input_sha256).workspace
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function verifyAwaitingCandidate(working: BidWorkspace, parent: BidWorkDescriptor,
  step: z.infer<typeof awaitingStepSchema>): Promise<BidWorkspace | null> {
  if (step.candidate_files === undefined || step.removed_paths === undefined) return null
  const recoveryPaths: readonly string[] = step.step.call.capability === 'outline.refine'
    || step.step.call.capability === 'evidence.research' ? EVIDENCE_RECOVERY_PATHS
    : step.step.call.capability === 'chapter.write' || step.step.call.capability === 'chapter.revise'
      ? WRITING_RECOVERY_PATHS : []
  const permitted = new Set([...step.result.changed_artifacts, ...recoveryPaths])
  if (new Set(step.candidate_files.map(file => file.path)).size !== step.candidate_files.length
    || step.candidate_files.some(file => !permitted.has(file.path))
    || step.result.changed_artifacts.some(path => !step.candidate_files?.some(file => file.path === path))) {
    throw new Error('BID_CAPABILITY_AWAITING_CANDIDATE_PATH_INVALID')
  }
  const candidate = stepCandidateWorkspace(working, parent, step.step_id, step.input_sha256)
  const marker = within(candidate.workspace.root, 'work-identity.json')
  await assertNoLinkedPath(working.root, marker)
  if (JSON.stringify(JSON.parse(await readFile(marker, 'utf8'))) !== JSON.stringify(candidate.descriptor)) {
    throw new Error('BID_CAPABILITY_AWAITING_CANDIDATE_IDENTITY_MISMATCH')
  }
  for (const file of step.candidate_files) if (await fileHash(candidate.workspace, file.path) !== file.sha256) {
    throw new Error(`BID_CAPABILITY_AWAITING_CANDIDATE_FILE_MISMATCH: ${file.path}`)
  }
  for (const path of step.removed_paths) if (await fileHash(candidate.workspace, path) !== undefined) {
    throw new Error(`BID_CAPABILITY_AWAITING_CANDIDATE_REMOVAL_MISMATCH: ${path}`)
  }
  return candidate.workspace
}

function stepId(workId: string, index: number): string {
  return `step-${hash(Buffer.from(workId)).slice(0, 24)}-${String(index + 1).padStart(4, '0')}`
}

async function verifyWritingResumeSeed(working: BidWorkspace, parent: BidWorkDescriptor,
  stepId: string, seed: z.infer<typeof writingResumeSeedSchema>): Promise<BidWorkspace> {
  const candidate = stepCandidateWorkspace(working, parent, seed.source_step_id ?? stepId, seed.input_sha256)
  const marker = within(candidate.workspace.root, 'work-identity.json')
  await assertNoLinkedPath(working.root, marker)
  if (JSON.stringify(JSON.parse(await readFile(marker, 'utf8'))) !== JSON.stringify(candidate.descriptor)) {
    throw new Error('BID_CAPABILITY_WRITING_RESUME_IDENTITY_MISMATCH')
  }
  if (new Set(seed.files.map(file => file.path)).size !== seed.files.length
    || new Set(seed.removed_paths).size !== seed.removed_paths.length) {
    throw new Error('BID_CAPABILITY_WRITING_RESUME_PATH_DUPLICATE')
  }
  for (const file of seed.files) if (await fileHash(candidate.workspace, file.path) !== file.sha256) {
    throw new Error(`BID_CAPABILITY_WRITING_RESUME_FILE_MISMATCH: ${file.path}`)
  }
  for (const path of seed.removed_paths) if (await fileHash(candidate.workspace, path) !== undefined) {
    throw new Error(`BID_CAPABILITY_WRITING_RESUME_REMOVAL_MISMATCH: ${path}`)
  }
  return candidate.workspace
}

async function patchStepSectionIds(canonical: BidWorkspace, working: BidWorkspace,
  task: BidCapabilityTask, step: BidCapabilityStep, previous?: BidCapabilityResult): Promise<ReadonlySet<string> | null> {
  const outline = await readOutline(working)
  if (outline === undefined) throw new Error('BID_CAPABILITY_OUTLINE_REQUIRED')
  const taskScope = task.scope.kind !== 'sections' ? task.scope
    : { kind: 'sections' as const, section_ids: [...await resolveBidTaskSections(canonical, working, task, task.scope.section_ids)] }
  const stepScope = step.scope.source !== 'section_ids' ? step.scope
    : { source: 'section_ids' as const, section_ids: [...await resolveBidTaskSections(canonical, working, task, step.scope.section_ids)] }
  return resolveCapabilityStepScope(taskScope, stepScope, outline,
    previous === undefined ? undefined : { status: 'completed', result: previous }).sectionIds
}

/** 业务绑定改变后保留章节级检查点；结构及职责文字必须仍与原候选一致。 */
async function writingResumeIndexHeaders(source: BidWorkspace, destination: BidWorkspace) {
  const before = await readOutline(source)
  const after = await readOutline(destination)
  if (before === undefined || after === undefined) throw new Error('BID_CAPABILITY_WRITING_RESUME_OUTLINE_REQUIRED')
  const structural = (outline: typeof before) => ({ ...outline, sections: outline.sections.map(({
    requirement_ids: _requirements, scoring_ids: _scoring, scoring_response_point_ids: _points,
    scoring_response_points: _pointText, compliance_ids: _compliance, ...section
  }) => section) })
  if (JSON.stringify(structural(before)) !== JSON.stringify(structural(after))) {
    throw new Error('BID_CAPABILITY_WRITING_RESUME_STRUCTURE_CHANGED')
  }
  const path = within(destination.projectRoot, 'chapters/writing-plan.json')
  await assertNoLinkedPath(destination.root, path)
  const plan = parseWritingPlan(JSON.parse(await readFile(path, 'utf8')))
  const outlineHash = outlineArtifactSha256(after)
  if (plan.confirmed_outline_sha256 !== outlineHash) throw new Error('BID_CAPABILITY_WRITING_RESUME_PLAN_MISMATCH')
  return { confirmed_outline_sha256: outlineHash, writing_plan_version: plan.plan_version }
}

function capabilityTaskAnswer(
  session: Session, workId: string, currentStepId: string, questionId: string,
): AskUserQuestionAnswerItem | undefined {
  const event = session.events.findLast(candidate => candidate.type === 'bid.capability.input.received'
    && candidate.data.workId === workId && candidate.data.stepId === currentStepId
    && candidate.data.questionId === questionId)
  return event?.type === 'bid.capability.input.received' ? event.data.answer : undefined
}

async function fileHash(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return hash(await readFile(absolute)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 入库不可变任务及当时读取的正式输入摘要。
 * @param workspace 正式项目。
 * @param session 拥有真实授权消息的公开会话。
 * @param stage 任务接纳时的项目阶段。
 * @param task 用户目标、根范围及有序步骤。
 * @param authorization 真实用户消息身份。
 * @param inputPaths 本任务读取的正式文件路径。
 * @param returnState 完成后恢复的任务前状态。
 * @param agent 工具调用的 live Agent；延迟队列须已有匹配的持久请求。
 * @param completeTask 保留独立导出尾步骤的完整用户计划。
 * @returns 可由 Run 恢复的 Work 描述符。
 */
export async function persistCapabilityTaskRequest(
  workspace: BidWorkspace, session: Session, stage: BidStage, task: BidCapabilityTask,
  authorization: CapabilityTaskRequest['authorization'], inputPaths: readonly string[],
  returnState: CapabilityTaskRequest['return_state'], agent?: Agent, completeTask?: BidCapabilityTask,
): Promise<BidWorkDescriptor> {
  bidCapabilityTaskSchema.parse(task)
  const current = resolveBidToolAuthorization(agent ?? session) ?? resolveBidToolAuthorization(session)
  const matches = current?.session_id === authorization.session_id && current.message_id === authorization.message_id
  let queued = false
  let queuedSource: CapabilityTaskRequest['source_snapshot']
  let queuedCompleteTask: BidCapabilityTask | undefined
  if (!matches) {
    for (const workId of await pendingCapabilityWorkIds(workspace)) {
      queued ||= (await readPendingCapabilityRequests(workspace, workId)).some(({ request }) =>
        request.authorization.session_id === authorization.session_id
        && request.authorization.message_id === authorization.message_id
        && JSON.stringify({ ...request.task, steps: request.task.steps.filter(step => step.call.capability !== 'docx.export') }) === JSON.stringify(task)
        && (queuedSource = request.source_snapshot, queuedCompleteTask = request.task, true))
    }
  }
  if (!hasBidTaskAuthorization(session, authorization) || (!matches && !queued)) {
    throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
  }
  if (task.scope.kind !== 'project') {
    const outline = await readOutline(workspace)
    if (outline === undefined) throw new Error('BID_CAPABILITY_OUTLINE_REQUIRED')
    await verifyCapabilityTaskScope(workspace, task.scope, outline)
  }
  const existing = await findCapabilityTaskRequest(workspace, authorization)
  completeTask ??= queuedCompleteTask
  if (existing !== null) {
    const saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, existing))
    if (JSON.stringify(saved.task) !== JSON.stringify(bidCapabilityTaskSchema.parse(task))
      || JSON.stringify(saved.complete_task ?? saved.task) !== JSON.stringify(completeTask ?? task)) {
      throw new Error('BID_CAPABILITY_USER_MESSAGE_TASK_CONFLICT')
    }
    return existing
  }
  validateCapabilityTaskContentFollowup(task, await hasScopedChapterContent(workspace, task))
  const inputSources = await Promise.all([...new Set(inputPaths)].sort().map(async (path) => {
    const digest = await fileHash(workspace, path)
    if (digest === undefined) throw new Error(`BID_CAPABILITY_REQUIRED_INPUT_MISSING: ${path}`)
    return { path, sha256: digest }
  }))
  if (returnState.stage !== stage) throw new Error('BID_CAPABILITY_RETURN_STATE_INVALID')
  const sourceSnapshot = queuedSource ?? await freezeBidTaskSource(workspace, session, task, authorization)
  const request = capabilityTaskRequestSchema.parse({ task, authorization, input_sources: inputSources,
    source_snapshot: sourceSnapshot, ...(completeTask === undefined ? {} : { complete_task: completeTask }),
    return_state: returnState })
  return persistBidWorkRequest(workspace, 'capability_task', stage, request, inputSources)
}

/**
 * 相同真实用户消息只能取得原 Work；文本相同的不同消息仍是不同任务。
 * @param workspace 正式项目。
 * @param authorization 原用户消息身份。
 * @returns 匹配的 Work；未接纳时为 null。
 */
export async function findCapabilityTaskRequest(
  workspace: BidWorkspace, authorization: CapabilityTaskRequest['authorization'],
): Promise<BidWorkDescriptor | null> {
  const directory = within(workspace.projectRoot, 'requests')
  await assertNoLinkedPath(workspace.root, directory)
  let entries: string[]
  try { entries = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let match: BidWorkDescriptor | null = null
  for (const entry of entries.filter(name => name.endsWith('.json'))) {
    const path = within(directory, entry)
    await assertNoLinkedPath(workspace.root, path)
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed) || parsed.kind !== 'capability_task') continue
    const record = z.object({ kind: z.literal('capability_task'), work_id: z.string().min(1),
      stage: z.enum(BID_STAGES),
      input_fingerprint: sha256Schema, payload: capabilityTaskRequestSchema }).loose().parse(parsed)
    if (record.payload.authorization.session_id !== authorization.session_id
      || record.payload.authorization.message_id !== authorization.message_id) continue
    if (match !== null) throw new Error('BID_CAPABILITY_DUPLICATE_USER_MESSAGE_WORK')
    const descriptor: BidWorkDescriptor = { kind: 'capability_task', workId: record.work_id,
      stage: record.stage, requestRef: `requests/${record.work_id}.json`, requestSha256: hash(Buffer.from(raw)),
      inputFingerprint: record.input_fingerprint }
    await readBidWorkRequest(workspace, descriptor)
    match = descriptor
  }
  return match
}

async function verifyRequestInputs(workspace: BidWorkspace, run: BidRunContext, request: CapabilityTaskRequest,
  published?: CapabilityPublicationReceipt): Promise<void> {
  if (bidInputFingerprint(request.input_sources) !== run.work.inputFingerprint) {
    throw new Error('BID_CAPABILITY_INPUT_FINGERPRINT_MISMATCH')
  }
  for (const source of request.input_sources) {
    if (await fileHash(workspace, source.path) !== (published?.files.find(file => file.path === source.path)?.sha256 ?? source.sha256)) {
      throw new Error(`BID_CAPABILITY_INPUT_CHANGED: ${source.path}`)
    }
  }
}

/**
 * 核对已发布 Work 是否存在后续纠正步骤，防止旧凭据结算新 Run。
 * @param workspace 正式项目。
 * @param work 原请求身份。
 * @returns 原凭据仍是当前发布结果且已有追加步骤时为 true，包括待最终验收的步骤。
 */
export async function hasPendingCapabilityCorrection(workspace: BidWorkspace, work: BidWorkDescriptor): Promise<boolean> {
  const path = checkpointPath(workspace, work.workId)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(raw))
  if (checkpoint.work_id !== work.workId || checkpoint.request_sha256 !== work.requestSha256) {
    throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
  }
  const publication = checkpoint.publications?.at(-1)
  if (publication === undefined || checkpoint.steps.length <= publication.completed_step_count) return false
  const current = await readCapabilityPublicationRecord(workspace, work.workId, work.requestSha256)
  return current !== null && bidInputFingerprint(current) === bidInputFingerprint(publication.receipt)
}

async function readOutline(workspace: BidWorkspace) {
  for (const relative of ['outline/confirmed-outline.json', 'outline/draft.json', 'outline/outline.json']) {
    const path = within(workspace.projectRoot, relative)
    await assertNoLinkedPath(workspace.root, path)
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      return relative === 'outline/draft.json' ? parseOutlineDraft(raw).outline : parseConfirmedOutlineArtifact(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return undefined
}

/** 仅从原请求摘要匹配的文件重建原章节，不把后续发布的目录当作原输入。 */
async function originalSectionIds(canonical: BidWorkspace, working: BidWorkspace, work: BidWorkDescriptor,
  request: CapabilityTaskRequest, checkpoint: CapabilityTaskCheckpoint): Promise<string[]> {
  const source = request.input_sources.find(file => ['outline/confirmed-outline.json', 'outline/outline.json', 'outline/draft.json']
    .includes(file.path))
  if (source === undefined) throw new Error('BID_CAPABILITY_ORIGINAL_OUTLINE_UNAVAILABLE')
  const readMatching = async (workspace: BidWorkspace) => {
    if (await fileHash(workspace, source.path) !== source.sha256) return undefined
    const path = within(workspace.projectRoot, source.path)
    await assertNoLinkedPath(workspace.root, path)
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    const outline = source.path === 'outline/draft.json' ? parseOutlineDraft(raw).outline : parseConfirmedOutlineArtifact(raw)
    return outline.sections.map(section => section.id)
  }
  for (const workspace of [canonical, working]) {
    const ids = await readMatching(workspace)
    if (ids !== undefined) return ids
  }
  const first = checkpoint.steps[0]
  if (first !== undefined) {
    const directory = within(working.projectRoot, 'runs')
    await assertNoLinkedPath(working.root, directory)
    let entries: string[]
    try { entries = await readdir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    const prefix = `${first.step_id}-`
    for (const entry of entries.sort()) {
      if (!entry.startsWith(prefix) || !/^[a-f0-9]{12}$/u.test(entry.slice(prefix.length))) continue
      const markerPath = within(working.projectRoot, `runs/${entry}/work/work-identity.json`)
      await assertNoLinkedPath(working.root, markerPath)
      let text: string
      try { text = await readFile(markerPath, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const marker = bidWorkDescriptorSchema.parse(JSON.parse(text))
      const candidate = stepCandidateWorkspace(working, work, first.step_id, marker.inputFingerprint)
      if (marker.workId !== entry || bidInputFingerprint(marker) !== bidInputFingerprint(candidate.descriptor)) {
        throw new Error('BID_WORKING_TREE_IDENTITY_MISMATCH')
      }
      const ids = await readMatching(candidate.workspace)
      if (ids !== undefined) return ids
    }
  }
  throw new Error('BID_CAPABILITY_ORIGINAL_OUTLINE_UNAVAILABLE: 原请求摘要匹配的目录来源缺失，不能重建原文保留范围。')
}

async function hasScopedChapterContent(workspace: BidWorkspace, task: BidCapabilityTask,
  canonical: BidWorkspace = workspace): Promise<boolean> {
  const outline = await readOutline(workspace)
  if (outline === undefined) return false
  const selected = task.scope.kind === 'project' ? null
    : await resolveBidTaskSections(canonical, workspace, task, task.scope.kind === 'sections'
      ? task.scope.section_ids : [task.scope.reference.section_id])
  for (const section of outline.sections) {
    if (!section.writable || selected !== null && !selected.has(section.id)) continue
    const location = await readChapterLocation(workspace, section.id)
    if (location !== null && await fileHash(workspace, location.contentPath) !== undefined) return true
  }
  return false
}

/**
 * 核对检查点属于不可变请求，且已完成候选仍是当时验证的字节。
 * @param canonical 正式项目。
 * @param working Work 候选项目。
 * @param run 当前 Run 身份。
 * @param request 不可变请求。
 * @param session 保存后续计划授权的公开会话。
 * @returns 验证后的检查点；首次执行时为 null。
 */
export async function readCapabilityTaskCheckpoint(
  canonical: BidWorkspace, working: BidWorkspace, run: Pick<BidRunContext, 'work'>,
  request: CapabilityTaskRequest, session: Session,
): Promise<CapabilityTaskCheckpoint | null> {
  const path = checkpointPath(canonical, run.work.workId)
  await assertNoLinkedPath(canonical.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(raw))
  if (checkpoint.work_id !== run.work.workId || checkpoint.request_sha256 !== run.work.requestSha256) {
    throw new Error('BID_CAPABILITY_CHECKPOINT_IDENTITY_MISMATCH')
  }
  let expected = (request.complete_task ?? request.task).steps.map(step => ({ step, authorization: request.authorization,
    writing_resume_seed: undefined as z.infer<typeof writingResumeSeedSchema> | undefined }))
  for (const patch of checkpoint.plan_patches) {
    if (patch.from_index > expected.length || patch.authorization.session_id !== session.id
      || !hasBidTaskAuthorization(session, patch.authorization)) {
      throw new Error('BID_CAPABILITY_CHECKPOINT_PATCH_INVALID')
    }
    expected = [...expected.slice(0, patch.from_index),
      ...patch.steps.map((step, index) => ({ step, authorization: patch.authorization,
        writing_resume_seed: index === patch.steps.findIndex(item => item.call.capability === 'chapter.write')
          ? patch.writing_resume_seed : undefined }))]
  }
  storedTaskSchema.parse({ ...request.task, steps: expected.map(item => item.step) })
  if (checkpoint.steps.length !== expected.length) throw new Error('BID_CAPABILITY_CHECKPOINT_PLAN_MISMATCH')
  for (const [index, { step, authorization, writing_resume_seed }] of expected.entries()) {
    const saved = checkpoint.steps[index]
    if (saved === undefined || JSON.stringify(saved.step) !== JSON.stringify(step)
      || JSON.stringify(saved.authorization) !== JSON.stringify(authorization)
      || JSON.stringify(saved.writing_resume_seed) !== JSON.stringify(writing_resume_seed)
      || saved.step_id !== stepId(run.work.workId, index)) {
      throw new Error('BID_CAPABILITY_CHECKPOINT_PLAN_MISMATCH')
    }
  }
  const latest = new Map<string, string | null>()
  for (const saved of checkpoint.steps) {
    const receipt = saved.status === 'pending' || saved.status === 'running'
      ? await readCapabilityStepReceipt(working, saved.step_id) : null
    const files = saved.status === 'completed' ? saved.files : receipt?.files ?? []
    const removals = saved.status === 'completed' ? saved.removed_paths : receipt?.removed_paths ?? []
    for (const file of files) latest.set(file.path, file.sha256)
    for (const path of removals) latest.set(path, null)
  }
  for (const [path, expected] of latest) {
    if (await fileHash(working, path) !== (expected ?? undefined)) {
      throw new Error(`BID_CAPABILITY_CHECKPOINT_FILE_MISMATCH: ${path}`)
    }
  }
  for (const step of checkpoint.steps) if (step.status === 'awaiting_input') {
    await verifyAwaitingCandidate(working, run.work, step)
  }
  for (const step of checkpoint.steps) if (step.writing_resume_seed !== undefined
    && (step.status === 'pending' || step.status === 'running')) {
    await verifyWritingResumeSeed(working, run.work, step.step_id, step.writing_resume_seed)
  }
  return checkpoint
}

function initialCheckpoint(run: BidRunContext, request: CapabilityTaskRequest): CapabilityTaskCheckpoint {
  return capabilityTaskCheckpointSchema.parse({
    schema_version: 1,
    work_id: run.work.workId,
    request_sha256: run.work.requestSha256,
    plan_patches: [],
    steps: (request.complete_task ?? request.task).steps.map((step, index) => ({
      step_id: stepId(run.work.workId, index),
      step, status: 'pending', authorization: request.authorization,
    })),
  })
}

async function saveCheckpoint(
  run: { readonly work: BidRunContext['work']; readonly commits: Pick<BidRunContext['commits'], 'writeJson'> },
  canonical: BidWorkspace, checkpoint: CapabilityTaskCheckpoint,
): Promise<void> {
  await run.commits.writeJson(checkpointPath(canonical, run.work.workId), checkpoint)
}

/**
 * 核对同一用户授权的相同补丁，包括追加后工具重新计算的末尾索引。
 * @param checkpoint 原 Work 的当前步骤记录。
 * @param authorization 本次用户授权。
 * @param fromIndex 工具绑定的后缀起点。
 * @param steps 本次语义步骤。
 * @param restartPending 是否重新迁移未发布候选。
 * @returns 当前最后补丁是否已接纳相同请求。
 */
export function capabilityPlanPatchRepeated(checkpoint: CapabilityTaskCheckpoint,
  authorization: CapabilityTaskRequest['authorization'], fromIndex: number,
  steps: readonly BidCapabilityStep[], restartPending?: true): boolean {
  const existing = checkpoint.plan_patches.at(-1)
  return existing !== undefined && existing.authorization.session_id === authorization.session_id
    && existing.authorization.message_id === authorization.message_id
    && existing.restart_pending === restartPending
    && (existing.from_index === fromIndex || fromIndex === checkpoint.steps.length
      && existing.from_index + existing.steps.length === checkpoint.steps.length)
    && JSON.stringify(existing.steps.map(step => storedStepSchema.parse(step)))
      === JSON.stringify(steps.map(step => storedStepSchema.parse(step)))
}

/**
 * 替换未完成步骤后缀或追加已发布结果的纠正；保留已完成步骤及不可变请求。
 * @param run 当前 Run 的检查点写入权限。
 * @param canonical 正式项目。
 * @param working Work 候选项目。
 * @param request 不可变请求。
 * @param session 保存用户授权和当前失败状态的公开会话。
 * @param authorization 本次补丁的用户消息身份。
 * @param fromIndex 待替换后缀的首个步骤索引。
 * @param steps 新的后续步骤，可为空以删除未开始后缀；失败步骤必须有替代步骤。
 * @param agent 当前工具调用者，用于验证本轮授权。
 * @param dispatcher 当前能力的文件许可；重新规划已开始写作时必须提供。
 * @param published 已核对全部当前文件的原发布凭据；只允许追加纠正步骤。
 * @param restartPending 新用户授权从已接纳结果重新迁移，旧未提交写作候选保留为历史。
 * @returns 写入后的步骤检查点。
 */
export async function patchCapabilityTaskSteps(
  run: Pick<BidRunContext, 'work'> & { readonly commits: Pick<BidRunContext['commits'], 'writeJson'> },
  canonical: BidWorkspace, working: BidWorkspace,
  request: CapabilityTaskRequest, session: Session, authorization: CapabilityTaskRequest['authorization'],
  fromIndex: number, steps: readonly BidCapabilityStep[], agent?: Agent, dispatcher?: CapabilityTaskDispatcher,
  published?: CapabilityPublicationReceipt,
  restartPending?: true,
): Promise<CapabilityTaskCheckpoint> {
  const recovery = bidRunRecoveryEligibility(session)
  const recoverable = recovery.eligible && recovery.target?.workId === run.work.workId
  const originalAuthorization = authorization.message_id === request.authorization.message_id
  const automaticRecovery = recoverable && originalAuthorization && agent?.session === session
    && session.header.origin !== 'subagent' && agent.ctx.get('agents')?.get(session.id) === agent
  if (authorization.session_id !== request.authorization.session_id || authorization.session_id !== session.id
    || !hasBidTaskAuthorization(session, authorization)
    || (!automaticRecovery
      && (resolveBidToolAuthorization(agent ?? session) ?? resolveBidToolAuthorization(session))?.message_id
        !== authorization.message_id)) {
    throw new Error('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
  }
  const restartAuthorized = restartPending === true && !originalAuthorization && !automaticRecovery
    && session.events.some(event => event.type === 'user/message' && event.data.id === authorization.message_id
      && event.data.source.kind === 'user')
  if (restartPending && !restartAuthorized) throw new Error('BID_CAPABILITY_CANDIDATE_RESTART_UNAUTHORIZED')
  const checkpoint = await readCapabilityTaskCheckpoint(canonical, working, run, request, session)
  if (checkpoint !== null && capabilityPlanPatchRepeated(checkpoint, authorization, fromIndex, steps, restartPending)) {
    return checkpoint
  }
  if (published !== undefined && (checkpoint === null || fromIndex !== checkpoint.steps.length || steps.length === 0
    || checkpoint.steps.some(step => step.status !== 'completed') || published.work_id !== run.work.workId
    || published.request_sha256 !== run.work.requestSha256 || published.goal_met !== true)) {
    throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
  }
  if (checkpoint === null || checkpoint.steps.some((step, index) => step.status === 'awaiting_input'
    || step.status === 'running' && (!(recoverable || restartAuthorized) || index < fromIndex))) {
    throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
  }
  if (!Number.isSafeInteger(fromIndex) || fromIndex < 0 || fromIndex > checkpoint.steps.length
    || checkpoint.steps.slice(fromIndex).some(step => step.status !== 'pending' && !((recoverable || restartAuthorized) && step.status === 'running')
      || step.answer_question_id !== undefined)
    || steps.length === 0 && checkpoint.steps.slice(fromIndex).some(step => step.status === 'running')
    || fromIndex + steps.length === 0) throw new Error('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP')
  for (const step of checkpoint.steps.slice(fromIndex)) {
    if (await readCapabilityStepReceipt(working, step.step_id) !== null) {
      throw new Error('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP: 步骤已有提交凭据，请先恢复并核对结果。')
    }
  }
  let writingSeed: z.infer<typeof writingResumeSeedSchema> | undefined
  const startedIndex = checkpoint.steps.findIndex((record, index) => index >= fromIndex
    && record.step.call.capability === 'chapter.write'
    && (record.status === 'running' || record.status === 'pending' && record.writing_resume_seed !== undefined))
  const started = checkpoint.steps[startedIndex]
  const resumeIndex = steps.findIndex(step => step.call.capability === 'chapter.write')
  if (restartPending && (started === undefined || startedIndex !== fromIndex
    || authorization.message_id === started.authorization.message_id)) {
    throw new Error('BID_CAPABILITY_CANDIDATE_RESTART_NOT_READY')
  }
  if (started !== undefined) {
    const next = steps[resumeIndex]
    const bindingPrefix = steps.slice(0, resumeIndex)
    if (next?.call.capability !== 'chapter.write' || dispatcher === undefined
      || !restartPending && bindingPrefix.some(step => step.call.capability !== 'outline.update'
        || step.call.input.operations.length > 0 || step.call.input.business_bindings.length === 0
        || step.call.input.content_assignments.length > 0 || step.call.input.allow_content_deletion
        || step.call.input.defer_content_migration)) {
      throw new Error('BID_CAPABILITY_WRITING_RESUME_REQUIRED: 已开始写作的候选须保留；写作前仅允许修正业务绑定，随后继续完整章节范围的 chapter.write。')
    }
    const task = { ...request.task, steps: checkpoint.steps.map(record => record.step) }
    const previous = checkpoint.steps[startedIndex - 1]
    const previousResult = previous?.status === 'completed' ? previous.result : undefined
    const beforeIds = await patchStepSectionIds(canonical, working, task, started.step, previousResult)
    const afterIds = await patchStepSectionIds(canonical, working, task, next, previousResult)
    if (afterIds !== null && (beforeIds === null || [...beforeIds].some(id => !afterIds.has(id)))) {
      throw new Error('BID_CAPABILITY_WRITING_RESUME_SCOPE_NARROWED: 恢复不能遗漏原写作章节；保留完整目标，执行器会复用已完成正文与审核。previous_targets 只表示前一步结果，不表示全部新子章。')
    }
    if (restartPending) {
      const migration = bindingPrefix[0]
      const migrationCall = migration?.call
      const migrationIds = migration === undefined ? null
        : await patchStepSectionIds(canonical, working, task, migration, previousResult)
      if (bindingPrefix.length !== 1 || migrationCall?.capability !== 'chapter.reorganize'
        || migrationCall.input.allow_content_deletion || beforeIds === null || migrationIds === null
        || [...beforeIds].some(id => !migrationIds.has(id) || !migrationCall.input.source_section_ids.includes(id))) {
        throw new Error('BID_CAPABILITY_CANDIDATE_RESTART_SCOPE_REQUIRED: 重新迁移必须覆盖全部原写作章节，保留原文，再恢复完整写作范围。')
      }
    } else {
      const sourceInput = started.status === 'running' ? started.input_sha256 : started.writing_resume_seed?.input_sha256
      if (sourceInput === undefined) throw new Error('BID_CAPABILITY_WRITING_RESUME_REQUIRED')
      const sourceStepId = started.status === 'running' ? started.step_id
        : started.writing_resume_seed?.source_step_id ?? started.step_id
      const candidate = started.status === 'pending' && started.writing_resume_seed !== undefined
        ? await verifyWritingResumeSeed(working, run.work, started.step_id, started.writing_resume_seed)
        : stepCandidateWorkspace(working, run.work, sourceStepId, sourceInput).workspace
      const paths = new Set([...await dispatcher.allowedWrites(started.step.call, beforeIds, candidate, sourceStepId),
        ...await dispatcher.allowedWritesAfter?.(started.step.call, candidate) ?? [], ...WRITING_RECOVERY_PATHS])
      const files: z.infer<typeof outputFileSchema>[] = []
      const removedPaths: string[] = []
      for (const path of paths) {
        const digest = await fileHash(candidate, path)
        if (digest !== undefined) files.push({ path, sha256: digest })
        else if (await fileHash(working, path) !== undefined) removedPaths.push(path)
      }
      writingSeed = writingResumeSeedSchema.parse({ input_sha256: sourceInput,
        ...(sourceStepId === stepId(run.work.workId, fromIndex + resumeIndex) ? {} : { source_step_id: sourceStepId }),
        section_ids: beforeIds === null ? null : [...beforeIds], files, removed_paths: removedPaths })
      await verifyWritingResumeSeed(working, run.work, started.step_id, writingSeed)
    }
  }
  const replacement = steps.map((step, index) => ({
    step_id: stepId(run.work.workId, fromIndex + index),
    step: bidCapabilityStepSchema.parse(step), status: 'pending' as const, authorization,
    ...(index === resumeIndex && writingSeed !== undefined ? { writing_resume_seed: writingSeed } : {}),
  }))
  const patch = planPatchSchema.parse({ from_index: fromIndex, authorization, steps,
    ...restartPending ? { restart_pending: true } : {},
    ...(writingSeed === undefined ? {} : { writing_resume_seed: writingSeed }) })
  let originalIds = checkpoint.original_section_ids
  if (published !== undefined && originalIds === undefined) {
    originalIds = await originalSectionIds(canonical, working, run.work, request, checkpoint)
  }
  const updated = capabilityTaskCheckpointSchema.parse({ ...checkpoint,
    steps: [...checkpoint.steps.slice(0, fromIndex), ...replacement],
    plan_patches: [...checkpoint.plan_patches, patch],
    ...originalIds === undefined ? {} : { original_section_ids: originalIds },
    ...published === undefined ? {} : { publications: [...checkpoint.publications ?? [],
      { completed_step_count: checkpoint.steps.length, receipt: published }] } })
  const updatedTask = storedTaskSchema.parse({ ...request.task,
    steps: updated.steps.map(record => record.step) })
  const unfinishedIndex = updated.steps.findIndex(record => record.status !== 'completed')
  validateCapabilityTaskContentFollowup(updatedTask, await hasScopedChapterContent(working, updatedTask, canonical),
    unfinishedIndex < 0 ? updated.steps.length : unfinishedIndex)
  await saveCheckpoint(run, canonical, updated)
  return updated
}

/**
 * 从同一检查点和真实候选重建计划或产物核验输入。
 * @param canonical 正式基线。
 * @param working 当前 Work 候选。
 * @param source 冻结的真实任务来源。
 * @param request 原始请求与根范围。
 * @param checkpoint 当前步骤及核验历史。
 * @param phase 要重新核对的核验阶段。
 * @returns 恢复准入和执行核验共同使用的完整事实。
 */
export async function collectCapabilityTaskVerificationInput(
  canonical: BidWorkspace, working: BidWorkspace, source: BidTaskSourceSnapshot,
  request: CapabilityTaskRequest, checkpoint: CapabilityTaskCheckpoint, phase: 'plan' | 'result',
): Promise<BidTaskVerificationInput> {
  const changed = new Set<string>()
  if (phase === 'result') {
    for (const record of checkpoint.steps) {
      if (record.status !== 'completed') continue
      for (const path of record.result.changed_artifacts) changed.add(path)
      for (const path of record.removed_paths) changed.delete(path)
    }
  }
  const task = { ...request.task, steps: checkpoint.steps.map(record => record.step) }
  const preserveOriginal = task.steps.some(step => step.call.capability === 'chapter.reorganize'
    && !step.call.input.allow_content_deletion)
  const authorized = checkpoint.verifications?.find(record => record.scope_authorized && record.unmet.length === 0
    && record.source_sha256 === bidInputFingerprint(source)
    && record.requirements.every(requirement => requirement.source_quote !== undefined))
  const requirements = authorized?.requirements
  const acceptedPlan = checkpoint.verifications?.findLast(record => record.phase === 'plan' && record.scope_authorized
    && record.unmet.length === 0 && record.source_sha256 === bidInputFingerprint(source)
    && record.requirements.every(requirement => requirement.source_quote !== undefined)
    && record.plan_sha256 === bidInputFingerprint(task))
  return { phase, source, task,
    ...(phase !== 'result' ? {} : { written_section_ids: [...new Set(checkpoint.steps.flatMap(record =>
      record.status === 'completed' && (record.step.call.capability === 'chapter.write'
        || record.step.call.capability === 'chapter.revise') ? record.result.target_section_ids : []))] }),
    ...checkpoint.original_section_ids === undefined ? {} : { original_section_ids: checkpoint.original_section_ids },
    execution_history: {
      prior_plan_rejections: (checkpoint.verifications ?? []).filter(record => record.phase === 'plan' && record.unmet.length > 0
        && record.source_sha256 === bidInputFingerprint(source)
        && record.requirements.every(requirement => requirement.source_quote !== undefined))
        .map(record => ({ scope_authorized: record.scope_authorized, unmet: record.unmet })),
      plan_patch_count: checkpoint.plan_patches.length,
      completed_steps: checkpoint.steps.filter(record => record.status === 'completed')
        .map(record => ({ description: record.step.description, capability: record.step.call.capability })),
    },
    ...(requirements === undefined ? {} : { requirements, scope_constraints: authorized?.scope_constraints ?? [] }),
    ...(acceptedPlan === undefined ? {} : { accepted_plan_sha256: acceptedPlan.plan_sha256 }),
    ...(phase === 'result' && (preserveOriginal || requirements?.some(requirement => requirement.preserve_migrated_content) === true)
      ? { preservation_evidence: await collectBidTaskPreservationEvidence(canonical, working, task,
        checkpoint.original_section_ids) } : {}),
    evidence: await collectBidTaskEvidence(working, task, [...changed], canonical),
    scope_evidence: await collectBidTaskScopeEvidence(canonical, working, task) }
}

/**
 * 恢复完成凭据或按检查点依次执行步骤，最后一次发布正式文件。
 * @param canonical 正式项目。
 * @param run 唯一根 Run。
 * @param dispatcher 已注册的业务能力适配器。
 * @param agent 执行模型工作的 Agent。
 * @param session 保存授权和原生问题的公开会话。
 * @param recovery 当前 Work 的主 Agent 恢复指令，不参与步骤输入摘要。
 * @returns 已发布凭据或等待用户输入的步骤身份。
 */
export async function executeCapabilityTask(
  canonical: BidWorkspace, run: BidRunContext, dispatcher: CapabilityTaskDispatcher,
  agent: BidCapabilityExecutionContext['agent'], session: Session,
  recovery?: BidCapabilityExecutionContext['recovery'],
): Promise<CapabilityTaskOutcome> {
  if (run.work.kind !== 'capability_task') throw new Error('BID_CAPABILITY_WORK_REQUIRED')
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(canonical, run.work))
  await reconcileBidPublications(canonical.root, canonical.projectRoot)
  const committed = await readCapabilityPublicationReceipt(canonical, run.work.workId, run.work.requestSha256)
  if (committed !== null && !await hasPendingCapabilityCorrection(canonical, run.work)) return { status: 'completed', receipt: committed, results: [] }
  const workingPaths = await prepareBidWorkingTree(canonical, run.work)
  const working = new BidWorkspace(workingPaths.root, canonical.config)
  let checkpoint = await readCapabilityTaskCheckpoint(canonical, working, run, request, session)
    ?? initialCheckpoint(run, request)
  const publication = checkpoint.publications?.at(-1)
  if (publication !== undefined && (committed === null
    || bidInputFingerprint(publication.receipt) !== bidInputFingerprint(committed))) {
    throw new Error('BID_CAPABILITY_CORRECTION_BASE_CHANGED')
  }
  await verifyRequestInputs(canonical, run, request, publication?.receipt)
  if (checkpoint.original_section_ids === undefined) checkpoint = { ...checkpoint,
    original_section_ids: (await readOutline(canonical))?.sections.map(section => section.id) ?? [] }
  await saveCheckpoint(run, canonical, checkpoint)
  const changed = new Set<string>()
  const removed = new Set<string>()
  const source = bindBidTaskSourceContext(session, request.source_snapshot
    ?? await freezeBidTaskSource(canonical, session, request.task, request.authorization))
  const verify = async (phase: 'plan' | 'result'): Promise<BidTaskVerification> => {
    const input = await collectCapabilityTaskVerificationInput(canonical, working, source, request, checkpoint, phase)
    const identity = bidInputFingerprint(input)
    let verification = checkpoint.verifications?.find(record => record.phase === phase && record.input_sha256 === identity
      && record.source_sha256 === bidInputFingerprint(source)
      && record.requirements.every(requirement => requirement.source_quote !== undefined)
      && (record.scope_authorized || input.requirements === undefined))
    if (verification === undefined) {
      const decision = await (dispatcher.verifyTask ?? modelBidTaskVerifier)(input, agent, run.signal)
      verification = await validateBidTaskVerification(input, decision, canonical, working)
      checkpoint = { ...checkpoint, verifications: [...checkpoint.verifications ?? [], verification] }
      await saveCheckpoint(run, canonical, checkpoint)
    }
    if (!verification.scope_authorized) {
      if (input.requirements !== undefined && verification.unmet.length === 0
        && verification.checks.length === input.requirements.length && verification.checks.every(check => check.met)
        && bidInputFingerprint(verification.requirements) === bidInputFingerprint(input.requirements)) {
        throw Object.assign(new Error('BID_TASK_AUTHORIZATION_RECHECK_CONFLICT: 原授权已通过，重复核验结论冲突；保留原 Work 重新核验剩余成果。'),
          { code: 'BID_TASK_AUTHORIZATION_RECHECK_CONFLICT' })
      }
      throw Object.assign(new Error('BID_TASK_SCOPE_AUTHORIZATION_REQUIRED: 原始要求与保存范围冲突或未授权执行；请澄清真实目录子章还是选区内分项。'),
        { code: 'BID_TASK_SCOPE_AUTHORIZATION_REQUIRED' })
    }
    if (verification.unmet.length > 0) {
      const code = phase === 'plan' ? 'BID_TASK_PLAN_MISMATCH' : 'BID_TASK_RESULT_UNMET'
      throw Object.assign(new Error(code + ': ' + verification.unmet.join('；')), { code })
    }
    return verification
  }
  await verify('plan')
  let previous: { status: 'completed' | 'pending' | 'failed'; result?: BidCapabilityResult } | undefined
  for (const [index, record] of checkpoint.steps.entries()) {
    run.signal.throwIfAborted()
    // 导出尾步骤由正式发布后的独立导出器消费，始终保留在有效计划中。
    if (record.step.call.capability === 'docx.export') continue
    let saved = record
    if (saved.status === 'completed') {
      for (const file of saved.result.changed_artifacts) { removed.delete(file); changed.add(file) }
      for (const path of saved.removed_paths) { changed.delete(path); removed.add(path) }
      previous = { status: 'completed', result: saved.result }
      continue
    }
    let awaitingSeed: { workspace: BidWorkspace; step: z.infer<typeof awaitingStepSchema> } | undefined
    if (saved.status === 'awaiting_input') {
      const answer = capabilityTaskAnswer(session, run.work.workId, saved.step_id, saved.question_id)
      if (answer === undefined) return {
        status: 'awaiting_input', stepId: saved.step_id, questionId: saved.question_id, result: saved.result,
      }
      const candidate = await verifyAwaitingCandidate(working, run.work, saved)
      if (candidate !== null) awaitingSeed = { workspace: candidate, step: saved }
      const resumed = pendingStepSchema.parse({ step_id: saved.step_id, step: saved.step,
        status: 'pending', authorization: saved.authorization, answer_question_id: saved.question_id })
      checkpoint = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
        position === index ? resumed : step) })
      await saveCheckpoint(run, canonical, checkpoint)
      saved = resumed
    }
    const inputAnswer = saved.answer_question_id === undefined ? undefined
      : capabilityTaskAnswer(session, run.work.workId, saved.step_id, saved.answer_question_id)
    if (saved.answer_question_id !== undefined && inputAnswer === undefined) {
      throw new Error('BID_CAPABILITY_INPUT_ANSWER_MISSING')
    }
    const outline = await readOutline(working)
    if (outline === undefined && (request.task.scope.kind !== 'project' || saved.step.scope.source !== 'task')) {
      throw new Error('BID_CAPABILITY_OUTLINE_REQUIRED')
    }
    const effectiveTask = { ...request.task, steps: checkpoint.steps.map(step => step.step) }
    const effectiveScope = request.task.scope.kind !== 'sections' ? request.task.scope
      : { kind: 'sections' as const, section_ids: [...await resolveBidTaskSections(canonical, working,
        effectiveTask, request.task.scope.section_ids)] }
    const effectiveStepScope = saved.step.scope.source !== 'section_ids' ? saved.step.scope
      : { source: 'section_ids' as const, section_ids: [...await resolveBidTaskSections(canonical, working,
        effectiveTask, saved.step.scope.section_ids)] }
    let scope = outline === undefined ? { sectionIds: null, paragraphs: null }
      : resolveCapabilityStepScope(effectiveScope, effectiveStepScope, outline, previous)
    if (saved.step.call.capability === 'chapter.reorganize' && scope.sectionIds !== null) {
      const sourceIds = new Set(scope.sectionIds)
      for (const id of saved.step.call.input.source_section_ids) {
        await resolveBidTaskSections(canonical, working, effectiveTask, [id])
        sourceIds.add(id)
      }
      scope = { ...scope, sectionIds: sourceIds }
    }
    const sectionScopeRoots = outline === undefined || scope.sectionIds === null ? undefined
      : outline.sections.filter(section => scope.sectionIds?.has(section.id)
        && (section.parent_id === null || !scope.sectionIds.has(section.parent_id))).map(section => section.id)
    const writes = await dispatcher.allowedWrites(saved.step.call, scope.sectionIds, working, saved.step_id)
    const baseline = new Map<string, string>()
    for (const path of writes) {
      const digest = await fileHash(working, path)
      if (digest !== undefined) baseline.set(path, digest)
    }
    const inputSources = new Map<string, string>()
    for (const required of BID_CAPABILITIES[saved.step.call.capability].requires) {
      const digest = await fileHash(working, required)
      if (digest === undefined) throw new Error(`BID_CAPABILITY_REQUIRED_INPUT_MISSING: ${required}`)
      inputSources.set(required, digest)
    }
    for (const path of BID_CAPABILITIES[saved.step.call.capability].optionalInputs ?? []) {
      inputSources.set(path, await fileHash(working, path) ?? 'missing')
    }
    if (saved.step.call.capability === 'outline.update' || saved.step.call.capability === 'outline.refine') {
      for (const path of ['outline/confirmed-outline.json', 'outline/draft.json']) {
        const digest = await fileHash(working, path)
        if (digest !== undefined) inputSources.set(path, digest)
      }
    }
    if (saved.step.call.capability === 'chapter.reorganize') {
      for (const id of saved.step.call.input.source_section_ids) {
        const location = await readChapterLocation(working, id)
        if (location === null) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${id}`)
        for (const path of [location.contentPath, location.metadataPath]) {
          const digest = await fileHash(working, path)
          if (digest === undefined) throw new Error(`BID_CHAPTER_REUSE_SOURCE_MISSING: ${path}`)
          inputSources.set(path, digest)
        }
      }
    }
    if (saved.step.call.capability === 'evidence.research') {
      for (const path of ['outline/reassignment.json', 'outline/draft.json']) {
        const digest = await fileHash(working, path)
        if (digest !== undefined) inputSources.set(path, digest)
      }
      if (outline !== undefined) {
        const selected = scope.sectionIds ?? new Set(outline.sections.map(section => section.id))
        for (const section of outline.sections.filter(section => section.writable && selected.has(section.id))) {
          const location = await readChapterLocation(working, section.id)
          if (location === null) continue
          const digest = await fileHash(working, location.contentPath)
          if (digest !== undefined) inputSources.set(location.contentPath, digest)
        }
      }
    }
    const stepInputSha256 = bidInputFingerprint({ call: saved.step.call, scope: saved.step.scope,
      previous: previous?.result ?? null, sources: [...inputSources], answer: inputAnswer ?? null })
    if (saved.status === 'running' && saved.input_sha256 !== stepInputSha256) {
      throw new Error('BID_CAPABILITY_RUNNING_STEP_INPUT_CHANGED')
    }
    const recovered = await readCapabilityStepReceipt(working, saved.step_id, stepInputSha256)
    if (recovered !== null) {
      const restoredWrites = new Set([...writes, ...(await dispatcher.allowedWritesAfter?.(saved.step.call, working) ?? [])])
      if (recovered.files.some(file => !restoredWrites.has(file.path))
        || recovered.removed_paths.some(path => !restoredWrites.has(path))) {
        throw new Error('BID_CAPABILITY_STEP_RECEIPT_SCOPE_INVALID')
      }
      const next = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
        position === index ? { ...saved, status: 'completed', input_sha256: stepInputSha256,
          result: recovered.result, files: recovered.files, removed_paths: recovered.removed_paths } : step) })
      await saveCheckpoint(run, canonical, next)
      checkpoint = next
      for (const file of recovered.result.changed_artifacts) { removed.delete(file); changed.add(file) }
      for (const path of recovered.removed_paths) { changed.delete(path); removed.add(path) }
      previous = { status: 'completed', result: recovered.result }
      continue
    }
    const wasRunning = saved.status === 'running'
    if (saved.status === 'pending') {
      const running = runningStepSchema.parse({ ...saved, status: 'running', input_sha256: stepInputSha256 })
      checkpoint = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
        position === index ? running : step) })
      await saveCheckpoint(run, canonical, checkpoint)
      saved = running
    }
    const stepWorkId = `${saved.step_id}-${stepInputSha256.slice(0, 12)}`
    const stepWork = { ...run.work, workId: stepWorkId, inputFingerprint: stepInputSha256,
      requestRef: `requests/${stepWorkId}.json` }
    let resumeCandidate = wasRunning || saved.writing_resume_seed?.input_sha256 === stepInputSha256
      && (saved.writing_resume_seed.source_step_id === undefined || saved.writing_resume_seed.source_step_id === saved.step_id)
    if (resumeCandidate) {
      const marker = within(bidWorkRoot(working, stepWork), 'work-identity.json')
      await assertNoLinkedPath(working.root, marker)
      try {
        if (JSON.stringify(JSON.parse(await readFile(marker, 'utf8'))) !== JSON.stringify(stepWork)) {
          throw new Error('BID_CAPABILITY_STEP_CANDIDATE_IDENTITY_MISMATCH')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        resumeCandidate = false
      }
    }
    const stepPaths = await prepareBidWorkingTree(working, stepWork, { reset: !resumeCandidate })
    const reusedCandidate = resumeCandidate || awaitingSeed !== undefined || saved.writing_resume_seed !== undefined
    const stepWorking = new BidWorkspace(stepPaths.root, canonical.config)
    const candidateRun = { ...run, work: stepWork, commits: run.commits.forPublication({
      workspaceRoot: stepWorking.root, projectRoot: stepWorking.projectRoot,
    }) }
    if (!resumeCandidate && saved.writing_resume_seed !== undefined) {
      const seed = saved.writing_resume_seed
      if (saved.step.call.capability !== 'chapter.write'
        || scope.sectionIds !== null && (seed.section_ids === null
          || seed.section_ids.some(id => !scope.sectionIds?.has(id)))) {
        throw new Error('BID_CAPABILITY_WRITING_RESUME_SCOPE_INVALID')
      }
      const source = await verifyWritingResumeSeed(working, run.work, saved.step_id, seed)
      const permitted = new Set([...writes, ...await dispatcher.allowedWritesAfter?.(saved.step.call, source) ?? [],
        ...WRITING_RECOVERY_PATHS])
      if (seed.files.some(file => !permitted.has(file.path))
        || seed.removed_paths.some(path => !permitted.has(path))) {
        throw new Error('BID_CAPABILITY_WRITING_RESUME_PATH_INVALID')
      }
      const headers = seed.source_step_id === undefined ? undefined : await writingResumeIndexHeaders(source, stepWorking)
      await candidateRun.commits.publish(async (lease) => {
        for (const file of seed.files) {
          const absolute = within(source.projectRoot, file.path)
          await assertNoLinkedPath(source.root, absolute)
          const bytes = await readFile(absolute)
          if (hash(bytes) !== file.sha256) throw new Error(`BID_CAPABILITY_WRITING_RESUME_FILE_MISMATCH: ${file.path}`)
          const index = headers === undefined ? undefined
            : file.path === 'chapters/execution-plan.json' ? parseChapterExecutionPlan(JSON.parse(bytes.toString('utf8')))
              : file.path === 'chapters/execution-log.json' ? parseOrMigrateChapterExecutionLog(JSON.parse(bytes.toString('utf8')))
                : file.path === 'chapters/manifest.json' ? parseChapterWritingManifest(JSON.parse(bytes.toString('utf8'))) : undefined
          if (index === undefined || headers === undefined) await lease.writeBytes(within(stepWorking.projectRoot, file.path), bytes)
          else await lease.writeJson(within(stepWorking.projectRoot, file.path), {
            ...index, confirmed_outline_sha256: headers.confirmed_outline_sha256,
            ...file.path === 'chapters/manifest.json' ? {} : { writing_plan_version: headers.writing_plan_version },
          })
        }
        for (const path of seed.removed_paths) await lease.remove(within(stepWorking.projectRoot, path))
      })
    }
    if (awaitingSeed !== undefined) {
      const seedWrites = new Set([...writes,
        ...await dispatcher.allowedWritesAfter?.(saved.step.call, awaitingSeed.workspace) ?? []])
      if (awaitingSeed.step.result.changed_artifacts.some(path => !seedWrites.has(path))
        || awaitingSeed.step.removed_paths?.some(path => !seedWrites.has(path))) {
        throw new Error('BID_CAPABILITY_AWAITING_CANDIDATE_SCOPE_INVALID')
      }
      await candidateRun.commits.publish(async (lease) => {
        for (const file of awaitingSeed.step.candidate_files ?? []) {
          const source = within(awaitingSeed.workspace.projectRoot, file.path)
          await assertNoLinkedPath(awaitingSeed.workspace.root, source)
          await lease.writeBytes(within(stepWorking.projectRoot, file.path), await readFile(source))
        }
        for (const path of awaitingSeed.step.removed_paths ?? []) {
          await lease.remove(within(stepWorking.projectRoot, path))
        }
      })
    }
    const authorizedNewDescendants = new Set<string>()
    const context: BidCapabilityExecutionContext = {
      canonical, working: stepWorking, checkpointWorkspace: working, agent, sourceSession: session, sourceSnapshot: source,
      originalSectionIds: new Set(checkpoint.original_section_ids),
      originalTaskRequirements: checkpoint.verifications?.find(record => record.scope_authorized && record.unmet.length === 0
        && record.source_sha256 === bidInputFingerprint(source)
        && record.requirements.every(requirement => requirement.source_quote !== undefined))
        ?.requirements.map(requirement => requirement.description) ?? [],
      ...(effectiveTask.steps.some(step => step.call.capability === 'chapter.reorganize' && !step.call.input.allow_content_deletion)
        || checkpoint.verifications?.find(record => record.scope_authorized && record.unmet.length === 0
        && record.source_sha256 === bidInputFingerprint(source)
        && record.requirements.every(requirement => requirement.source_quote !== undefined))
          ?.requirements.some(requirement => requirement.preserve_migrated_content) === true ? { preserveMigratedContent: true } : {}),
      run: candidateRun, sectionIds: scope.sectionIds,
      ...(recovery === undefined ? {} : { recovery }),
      ...(sectionScopeRoots === undefined ? {} : { sectionScopeRoots }),
      authorizedNewDescendants,
      stepDirectory: stepPaths.root, inputSources, baselineHashes: baseline, allowedWrites: writes,
      stepId: saved.step_id, inputSha256: stepInputSha256,
      rootWorkId: run.work.workId, authorization: saved.authorization,
      ...(inputAnswer === undefined ? {} : { inputAnswer }),
      ...(reusedCandidate ? { resumeCandidate: true } : {}),
    }
    const execution = await dispatcher.execute(saved.step.call, context)
    const postWrites = await dispatcher.allowedWritesAfter?.(saved.step.call, stepWorking) ?? new Set<string>()
    const validatedContext = { ...context, allowedWrites: new Set([...writes, ...postWrites]) }
    const currentOutline = await readOutline(stepWorking)
    const knownIds = new Set(currentOutline?.sections.map(section => section.id) ?? [])
    if (scope.sectionIds !== null && currentOutline !== undefined) {
      const beforeIds = new Set(outline?.sections.map(section => section.id) ?? [])
      const byId = new Map(currentOutline.sections.map(section => [section.id, section]))
      for (const section of currentOutline.sections.filter(item => !beforeIds.has(item.id))) {
        let parentId = section.parent_id
        const visited = new Set<string>()
        while (parentId !== null && !scope.sectionIds.has(parentId)) {
          if (visited.has(parentId)) throw new Error('BID_CAPABILITY_NEW_SECTION_CYCLE')
          visited.add(parentId)
          parentId = byId.get(parentId)?.parent_id ?? null
        }
        if (parentId === null) throw new Error(`BID_CAPABILITY_NEW_SECTION_SCOPE_INVALID: ${section.id}`)
        authorizedNewDescendants.add(section.id)
      }
    }
    const resumedChanges = reusedCandidate ? await Promise.all([...validatedContext.allowedWrites].map(async (path) => {
      const before = await fileHash(working, path)
      const after = await fileHash(stepWorking, path)
      return before === after ? null : { path, removed: after === undefined }
    })) : []
    const result = await validateCapabilityResult(validatedContext, {
      ...execution.result,
      changed_artifacts: [...new Set([...execution.result.changed_artifacts,
        ...resumedChanges.flatMap(item => item !== null && !item.removed ? [item.path] : [])])],
    }, knownIds)
    await dispatcher.validate(saved.step.call, validatedContext, result)
    const files = await Promise.all(result.changed_artifacts.map(async (path) => {
      const digest = await fileHash(stepWorking, path)
      if (digest === undefined) throw new Error(`BID_CAPABILITY_RESULT_FILE_MISSING: ${path}`)
      return { path, sha256: digest }
    }))
    const removedPaths = [...new Set([...(execution.removedPaths ?? []),
      ...resumedChanges.flatMap(item => item?.removed ? [item.path] : [])])]
    for (const path of removedPaths) {
      if (!validatedContext.allowedWrites.has(path) || result.changed_artifacts.includes(path)
        || await fileHash(stepWorking, path) !== undefined) {
        throw new Error(`BID_CAPABILITY_RESULT_REMOVAL_INVALID: ${path}`)
      }
    }
    if (result.needs_input) {
      const recoveryPaths: readonly string[] = saved.step.call.capability === 'outline.refine'
        || saved.step.call.capability === 'evidence.research' ? EVIDENCE_RECOVERY_PATHS
        : saved.step.call.capability === 'chapter.write' || saved.step.call.capability === 'chapter.revise'
          ? WRITING_RECOVERY_PATHS : []
      const candidateFiles = (await Promise.all([...new Set([...result.changed_artifacts, ...recoveryPaths])]
        .map(async (path) => {
          const digest = await fileHash(stepWorking, path)
          return digest === undefined ? null : { path, sha256: digest }
        }))).filter(file => file !== null)
      const questionId = `capability:${run.work.workId}:${saved.step_id}:${stepInputSha256.slice(0, 12)}`
      const next = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
        position === index ? { ...saved, status: 'awaiting_input', input_sha256: stepInputSha256,
          result, question_id: questionId, candidate_files: candidateFiles, removed_paths: removedPaths } : step) })
      await saveCheckpoint(run, canonical, next)
      return { status: 'awaiting_input', stepId: saved.step_id, questionId, result }
    }
    await publishCapabilityStepChanges(run, working, stepWorking, {
      step_id: saved.step_id, input_sha256: stepInputSha256, result, files, removed_paths: removedPaths,
    })
    const next = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
      position === index ? { ...saved, status: 'completed', input_sha256: stepInputSha256, result, files,
        removed_paths: removedPaths } : step) })
    await saveCheckpoint(run, canonical, next)
    checkpoint = next
    for (const file of result.changed_artifacts) { removed.delete(file); changed.add(file) }
    for (const path of removedPaths) { changed.delete(path); removed.add(path) }
    previous = { status: 'completed', result }
    run.reportProgress({ phase: 'executing', summary: `已完成能力步骤 ${String(index + 1)}/${String(checkpoint.steps.length)}`,
      completed: index + 1, total: checkpoint.steps.length })
  }
  if (request.task.allow_pending_content !== true) {
    const existing = new Set(await readPendingChapterReorganization(canonical))
    const pending = (await readPendingChapterReorganization(working)).filter(id => !existing.has(id))
    if (pending.length > 0) {
      throw new Error(`BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED: ${pending.join(', ')} 的正文尚未迁移，请补齐同一任务的迁移和复核步骤。`)
    }
  }
  const verification = await verify('result')
  const boundSource = { ...source, issues: verification.relevant_issue_ids.map((id) => {
    const issue = [...source.issues, ...source.observed_issues].find(item => item.issue_id === id)
    if (issue === undefined) throw new Error('BID_TASK_VERIFICATION_SOURCE_INVALID')
    return issue
  }) }
  const receipt = await publishCapabilityChanges(run, canonical, working, [...changed], [...removed],
    { verification, source: boundSource, task: { ...request.task, steps: checkpoint.steps.map(record => record.step) } })
  return { status: 'completed', receipt,
    results: checkpoint.steps.flatMap(step => step.status === 'completed' ? [step.result] : []) }
}
