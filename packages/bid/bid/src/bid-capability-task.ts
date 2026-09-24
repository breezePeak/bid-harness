/** 同一 Work 的有序能力步骤、候选产物检查点和结果发布。 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { BidWorkspace } from './index.ts'
import {
  bidCapabilityResultSchema, bidCapabilityStepSchema, bidCapabilityTaskSchema,
  type BidCapabilityCall, type BidCapabilityExecutionContext, type BidCapabilityResult,
  type BidCapabilityStep, type BidCapabilityTask,
} from './bid-capability-contract.ts'
import { BID_CAPABILITIES, resolveCapabilityStepScope, validateCapabilityResult,
  verifyCapabilityTaskScope } from './bid-capability-registry.ts'
import { parseConfirmedOutlineArtifact, parseOutlineDraft } from './outline-confirmation-artifacts.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { readCapabilityPublicationReceipt, readCapabilityStepReceipt, publishCapabilityChanges, publishCapabilityStepChanges,
  type CapabilityPublicationReceipt } from './bid-capability-changes.ts'
import type { BidRunContext } from './run-coordinator.ts'
import { bidInputFingerprint, persistBidWorkRequest, readBidWorkRequest } from './work-descriptor.ts'
import { BID_STAGES, type BidStage, type BidWorkDescriptor } from './control-plane-contract.ts'
import { bidTaskStateSchema } from './runtime-state.ts'
import { prepareBidWorkingTree } from './working-tree.ts'
import { reconcileBidPublications } from './publication-batch.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const messageReferenceSchema = z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict()
const outputFileSchema = z.object({ path: z.string().min(1), sha256: sha256Schema }).strict()

/** 不可变 Work 请求，用户消息身份用于精确去重和授权。 */
export const capabilityTaskRequestSchema = z.object({
  task: bidCapabilityTaskSchema,
  authorization: messageReferenceSchema,
  input_sources: z.array(outputFileSchema),
  return_state: bidTaskStateSchema.refine(state =>
    state.status === 'ready' || state.status === 'waiting_user' || state.status === 'completed'),
}).strict()
/** Work 接纳时冻结的计划、授权、输入和任务前状态。 */
export type CapabilityTaskRequest = z.infer<typeof capabilityTaskRequestSchema>

const pendingStepSchema = z.object({
  step_id: z.string().min(1), step: bidCapabilityStepSchema, status: z.literal('pending'),
  authorization: messageReferenceSchema,
  answer_question_id: z.string().min(1).optional(),
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
}).strict()
const stepRecordSchema = z.discriminatedUnion('status', [pendingStepSchema, runningStepSchema,
  completedStepSchema, awaitingStepSchema])
const planPatchSchema = z.object({
  from_index: z.number().int().nonnegative(), authorization: messageReferenceSchema,
  steps: z.array(bidCapabilityStepSchema),
}).strict()

/** 同一 Work 的步骤记录；项目总状态仍只由 BidTaskState 表达。 */
export const capabilityTaskCheckpointSchema = z.object({
  schema_version: recordOnlySchemaVersion(1),
  work_id: z.string().min(1),
  request_sha256: sha256Schema,
  steps: z.array(stepRecordSchema).min(1),
  plan_patches: z.array(planPatchSchema),
}).strict()
/** 同一 Work 的步骤执行记录及后续授权补丁。 */
export type CapabilityTaskCheckpoint = z.infer<typeof capabilityTaskCheckpointSchema>

/** 能力适配器只能在 Host 授权的候选文件中写入。 */
export interface CapabilityTaskDispatcher {
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

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function stepId(workId: string, index: number): string {
  return `step-${hash(Buffer.from(workId)).slice(0, 24)}-${String(index + 1).padStart(4, '0')}`
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
 * @returns 可由 Run 恢复的 Work 描述符。
 */
export async function persistCapabilityTaskRequest(
  workspace: BidWorkspace, session: Session, stage: BidStage, task: BidCapabilityTask,
  authorization: CapabilityTaskRequest['authorization'], inputPaths: readonly string[],
  returnState: CapabilityTaskRequest['return_state'],
): Promise<BidWorkDescriptor> {
  if (authorization.session_id !== session.id || !session.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'user' && String(event.data.id) === authorization.message_id)) {
    throw new Error('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
  }
  if (task.scope.kind !== 'project') {
    const outline = await readOutline(workspace)
    if (outline === undefined) throw new Error('BID_CAPABILITY_OUTLINE_REQUIRED')
    await verifyCapabilityTaskScope(workspace, task.scope, outline)
  }
  const existing = await findCapabilityTaskRequest(workspace, authorization)
  if (existing !== null) {
    const saved = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, existing))
    if (JSON.stringify(saved.task) !== JSON.stringify(bidCapabilityTaskSchema.parse(task))) {
      throw new Error('BID_CAPABILITY_USER_MESSAGE_TASK_CONFLICT')
    }
    return existing
  }
  const inputSources = await Promise.all([...new Set(inputPaths)].sort().map(async (path) => {
    const digest = await fileHash(workspace, path)
    if (digest === undefined) throw new Error(`BID_CAPABILITY_REQUIRED_INPUT_MISSING: ${path}`)
    return { path, sha256: digest }
  }))
  if (returnState.stage !== stage) throw new Error('BID_CAPABILITY_RETURN_STATE_INVALID')
  const request = capabilityTaskRequestSchema.parse({ task, authorization, input_sources: inputSources,
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

async function verifyRequestInputs(workspace: BidWorkspace, run: BidRunContext, request: CapabilityTaskRequest): Promise<void> {
  if (bidInputFingerprint(request.input_sources) !== run.work.inputFingerprint) {
    throw new Error('BID_CAPABILITY_INPUT_FINGERPRINT_MISMATCH')
  }
  for (const source of request.input_sources) {
    if (await fileHash(workspace, source.path) !== source.sha256) {
      throw new Error(`BID_CAPABILITY_INPUT_CHANGED: ${source.path}`)
    }
  }
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
  let expected = request.task.steps.map(step => ({ step, authorization: request.authorization }))
  for (const patch of checkpoint.plan_patches) {
    if (patch.from_index > expected.length || patch.authorization.session_id !== session.id
      || !session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user' && String(event.data.id) === patch.authorization.message_id)) {
      throw new Error('BID_CAPABILITY_CHECKPOINT_PATCH_INVALID')
    }
    expected = [...expected.slice(0, patch.from_index),
      ...patch.steps.map(step => ({ step, authorization: patch.authorization }))]
  }
  bidCapabilityTaskSchema.parse({ ...request.task, steps: expected.map(item => item.step) })
  if (checkpoint.steps.length !== expected.length) throw new Error('BID_CAPABILITY_CHECKPOINT_PLAN_MISMATCH')
  for (const [index, { step, authorization }] of expected.entries()) {
    const saved = checkpoint.steps[index]
    if (saved === undefined || JSON.stringify(saved.step) !== JSON.stringify(step)
      || JSON.stringify(saved.authorization) !== JSON.stringify(authorization)
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
  return checkpoint
}

function initialCheckpoint(run: BidRunContext, request: CapabilityTaskRequest): CapabilityTaskCheckpoint {
  return capabilityTaskCheckpointSchema.parse({
    schema_version: 1,
    work_id: run.work.workId,
    request_sha256: run.work.requestSha256,
    plan_patches: [],
    steps: request.task.steps.map((step, index) => ({
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
 * 后续用户消息仅可替换尚未开始的步骤后缀，保持原 Work 请求不变。
 * @param run 当前 Run 的检查点写入权限。
 * @param canonical 正式项目。
 * @param working Work 候选项目。
 * @param request 不可变请求。
 * @param session 保存真实后续用户消息的公开会话。
 * @param authorization 本次补丁的用户消息身份。
 * @param fromIndex 待替换后缀的首个步骤索引。
 * @param steps 新的后续步骤，可为空以删除未开始后缀。
 * @returns 写入后的步骤检查点。
 */
export async function patchCapabilityTaskSteps(
  run: Pick<BidRunContext, 'work'> & { readonly commits: Pick<BidRunContext['commits'], 'writeJson'> },
  canonical: BidWorkspace, working: BidWorkspace,
  request: CapabilityTaskRequest, session: Session, authorization: CapabilityTaskRequest['authorization'],
  fromIndex: number, steps: readonly BidCapabilityStep[],
): Promise<CapabilityTaskCheckpoint> {
  if (authorization.session_id !== request.authorization.session_id || authorization.session_id !== session.id
    || authorization.message_id === request.authorization.message_id
    || !session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && String(event.data.id) === authorization.message_id)) {
    throw new Error('BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED')
  }
  const checkpoint = await readCapabilityTaskCheckpoint(canonical, working, run, request, session)
  if (checkpoint === null || checkpoint.steps.some(step => step.status === 'awaiting_input' || step.status === 'running')) {
    throw new Error('BID_CAPABILITY_PLAN_PATCH_NOT_READY')
  }
  const existing = checkpoint.plan_patches.find(patch => patch.authorization.message_id === authorization.message_id)
  if (existing !== undefined) {
    if (existing.from_index !== fromIndex || JSON.stringify(existing.steps) !== JSON.stringify(steps)) {
      throw new Error('BID_CAPABILITY_PLAN_PATCH_CONFLICT')
    }
    return checkpoint
  }
  if (!Number.isSafeInteger(fromIndex) || fromIndex < 0 || fromIndex > checkpoint.steps.length
    || checkpoint.steps.slice(fromIndex).some(step => step.status !== 'pending' || step.answer_question_id !== undefined)
    || fromIndex + steps.length === 0) throw new Error('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP')
  const replacement = steps.map((step, index) => ({
    step_id: stepId(run.work.workId, fromIndex + index),
    step: bidCapabilityStepSchema.parse(step), status: 'pending' as const, authorization,
  }))
  const patch = planPatchSchema.parse({ from_index: fromIndex, authorization, steps })
  const updated = capabilityTaskCheckpointSchema.parse({ ...checkpoint,
    steps: [...checkpoint.steps.slice(0, fromIndex), ...replacement],
    plan_patches: [...checkpoint.plan_patches, patch] })
  bidCapabilityTaskSchema.parse({ ...request.task, steps: updated.steps.map(record => record.step) })
  await saveCheckpoint(run, canonical, updated)
  return updated
}

/**
 * 恢复完成凭据或按检查点依次执行步骤，最后一次发布正式文件。
 * @param canonical 正式项目。
 * @param run 唯一根 Run。
 * @param dispatcher 已注册的业务能力适配器。
 * @param agent 执行模型工作的 Agent。
 * @param session 保存授权和原生问题的公开会话。
 * @returns 已发布凭据或等待用户输入的步骤身份。
 */
export async function executeCapabilityTask(
  canonical: BidWorkspace, run: BidRunContext, dispatcher: CapabilityTaskDispatcher,
  agent: BidCapabilityExecutionContext['agent'], session: Session,
): Promise<CapabilityTaskOutcome> {
  if (run.work.kind !== 'capability_task') throw new Error('BID_CAPABILITY_WORK_REQUIRED')
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(canonical, run.work))
  await reconcileBidPublications(canonical.root, canonical.projectRoot)
  const committed = await readCapabilityPublicationReceipt(canonical, run.work.workId, run.work.requestSha256)
  if (committed !== null) return { status: 'completed', receipt: committed, results: [] }
  await verifyRequestInputs(canonical, run, request)
  const workingPaths = await prepareBidWorkingTree(canonical, run.work)
  const working = new BidWorkspace(workingPaths.root, canonical.config)
  let checkpoint = await readCapabilityTaskCheckpoint(canonical, working, run, request, session)
    ?? initialCheckpoint(run, request)
  await saveCheckpoint(run, canonical, checkpoint)
  const changed = new Set<string>()
  const removed = new Set<string>()
  let previous: { status: 'completed' | 'pending' | 'failed'; result?: BidCapabilityResult } | undefined
  for (const [index, record] of checkpoint.steps.entries()) {
    run.signal.throwIfAborted()
    let saved = record
    if (saved.status === 'completed') {
      for (const file of saved.result.changed_artifacts) { removed.delete(file); changed.add(file) }
      for (const path of saved.removed_paths) { changed.delete(path); removed.add(path) }
      previous = { status: 'completed', result: saved.result }
      continue
    }
    if (saved.status === 'awaiting_input') {
      const answer = capabilityTaskAnswer(session, run.work.workId, saved.step_id, saved.question_id)
      if (answer === undefined) return {
        status: 'awaiting_input', stepId: saved.step_id, questionId: saved.question_id, result: saved.result,
      }
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
    const scope = outline === undefined ? { sectionIds: null, paragraphs: null }
      : resolveCapabilityStepScope(request.task.scope, saved.step.scope, outline, previous)
    const writes = await dispatcher.allowedWrites(saved.step.call, scope.sectionIds, working, saved.step_id)
    const baseline = new Map<string, string>()
    for (const path of writes) {
      const digest = await fileHash(working, path)
      if (digest !== undefined) baseline.set(path, digest)
    }
    const inputSources = new Map<string, string>()
    for (const required of BID_CAPABILITIES[saved.step.call.capability].requires) {
      const path = required === 'manifest' ? 'manifest.json' : required
      const digest = await fileHash(working, path)
      if (digest === undefined) throw new Error(`BID_CAPABILITY_REQUIRED_INPUT_MISSING: ${path}`)
      inputSources.set(path, digest)
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
    const stepPaths = await prepareBidWorkingTree(working, stepWork)
    const stepWorking = new BidWorkspace(stepPaths.root, canonical.config)
    const candidateRun = { ...run, work: stepWork, commits: run.commits.forPublication({
      workspaceRoot: stepWorking.root, projectRoot: stepWorking.projectRoot,
    }) }
    const authorizedNewDescendants = new Set<string>()
    const context: BidCapabilityExecutionContext = {
      canonical, working: stepWorking, agent, sourceSession: session,
      run: candidateRun, sectionIds: scope.sectionIds,
      authorizedNewDescendants,
      stepDirectory: stepPaths.root, inputSources, baselineHashes: baseline, allowedWrites: writes,
      stepId: saved.step_id, inputSha256: stepInputSha256,
      rootWorkId: run.work.workId, authorization: saved.authorization,
      ...(inputAnswer === undefined ? {} : { inputAnswer }),
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
    const result = await validateCapabilityResult(validatedContext, execution.result, knownIds)
    await dispatcher.validate(saved.step.call, validatedContext, result)
    if (result.needs_input) {
      const questionId = `capability:${run.work.workId}:${saved.step_id}`
      const next = capabilityTaskCheckpointSchema.parse({ ...checkpoint, steps: checkpoint.steps.map((step, position) =>
        position === index ? { ...saved, status: 'awaiting_input', input_sha256: stepInputSha256,
          result, question_id: questionId } : step) })
      await saveCheckpoint(run, canonical, next)
      return { status: 'awaiting_input', stepId: saved.step_id, questionId, result }
    }
    const files = await Promise.all(result.changed_artifacts.map(async (path) => {
      const digest = await fileHash(stepWorking, path)
      if (digest === undefined) throw new Error(`BID_CAPABILITY_RESULT_FILE_MISSING: ${path}`)
      return { path, sha256: digest }
    }))
    const removedPaths = [...new Set(execution.removedPaths ?? [])]
    for (const path of removedPaths) {
      if (!validatedContext.allowedWrites.has(path) || result.changed_artifacts.includes(path)
        || await fileHash(stepWorking, path) !== undefined) {
        throw new Error(`BID_CAPABILITY_RESULT_REMOVAL_INVALID: ${path}`)
      }
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
  const receipt = await publishCapabilityChanges(run, canonical, working, [...changed], [...removed])
  return { status: 'completed', receipt,
    results: checkpoint.steps.flatMap(step => step.status === 'completed' ? [step.result] : []) }
}
