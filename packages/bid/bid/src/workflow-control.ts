/** 完整路线接纳凭据、让出的 Work 引用与当前业务等待点。 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidTaskState, BidWorkflowContext } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { bidWorkDescriptorSchema, readBidWorkRequest } from './work-descriptor.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { getBidStagePolicy } from './runtime-state.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { readCurrentWritingPlan } from './writing-entry-state.ts'
import { validateChapterWriting } from './chapter-writing-validator.ts'

/** 接纳记录绑定真实消息；相同消息重试返回同一凭据。 */
export const bidWorkflowAdmissionSchema = z.object({
  schema_version: z.literal(1),
  source: z.object({ session_id: z.string().min(1), message_id: z.string().min(1),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  accepted: z.literal(true), kind: z.literal('full_bid'),
}).strict()

/** 指向原日志和持久 Work，不保存另一份活跃 Run 状态。 */
export const bidWorkflowContinuationSchema = z.object({
  schema_version: z.literal(1), owner_session_id: z.string().min(1),
  run_id: z.string().min(1), work: bidWorkDescriptorSchema.refine(work => work.kind !== 'capability_task'),
}).strict()

/** 完整路线暂时让出执行权的唯一引用位置。 */
export const BID_WORKFLOW_CONTINUATION_PATH = 'workflow/continuation.json'

/**
 * 读取已发布的完整路线接纳凭据。
 * @param workspace 当前项目。
 * @returns 原接纳凭据；未启动时为 null。
 */
export async function readBidWorkflowAdmission(workspace: BidWorkspace): Promise<z.infer<typeof bidWorkflowAdmissionSchema> | null> {
  const path = within(workspace.projectRoot, 'workflow/admission.json')
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return bidWorkflowAdmissionSchema.parse(JSON.parse(raw))
}

/**
 * 读取并校验路线让出时保存的原 Work 引用。
 * @param workspace 当前项目。
 * @returns 有效引用；尚未让出时为 null，已失效请求拒绝读取。
 */
export async function readBidWorkflowContinuation(workspace: BidWorkspace): Promise<z.infer<typeof bidWorkflowContinuationSchema> | null> {
  const path = within(workspace.projectRoot, BID_WORKFLOW_CONTINUATION_PATH)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const reference = bidWorkflowContinuationSchema.parse(JSON.parse(raw))
  await readBidWorkRequest(workspace, reference.work)
  return reference
}

/**
 * 从引用指向的原会话日志恢复已收敛 Run，拒绝跨会话猜测。
 * @param session 原公开会话。
 * @param reference 持久化的精确引用。
 * @returns 原挂起状态。
 */
export function resolveBidWorkflowContinuation(session: Session, reference: z.infer<typeof bidWorkflowContinuationSchema>): Extract<BidTaskState, { status: 'suspended' }> {
  if (reference.owner_session_id !== String(session.id)) throw new Error('BID_RESUME_OWNER_SESSION_REQUIRED')
  const event = session.events.findLast(item => item.type === 'bid.run.suspended' && item.data.run.runId === reference.run_id
    || (item.type === 'bid.task.changed' || item.type === 'bid.project.resumed')
      && item.data.state.status === 'suspended' && item.data.state.run.runId === reference.run_id)
  const run = event?.type === 'bid.run.suspended' ? event.data.run
    : (event?.type === 'bid.task.changed' || event?.type === 'bid.project.resumed') && event.data.state.status === 'suspended'
      ? event.data.state.run : undefined
  if (run === undefined || run.work.kind === 'capability_task'
    || JSON.stringify(bidWorkDescriptorSchema.parse(run.work)) !== JSON.stringify(reference.work)) throw new Error('BID_WORKFLOW_CONTINUATION_INVALID')
  return { workflow: { kind: 'full_bid', stage: run.work.stage }, status: 'suspended', run }
}

/**
 * 能力任务结算后从当前产物推导等待点，不恢复接纳时的旧 status。
 * @param workspace 已发布的项目。
 * @param workflow 当前唯一任务状态中的路线位置。
 * @param session 保存当前路线确认与完成事实的会话。
 * @returns 无活跃 Run 的权威任务状态；是否继续执行由新的授权决定。
 */
export async function deriveBidIdleTaskState(workspace: BidWorkspace,
  workflow: BidWorkflowContext, session: Session): Promise<BidTaskState> {
  if (workflow === null) return { workflow, status: 'ready', run: null }
  const { stage } = workflow
  if (stage === 'file_intake') return { workflow, status: 'waiting_user', run: null }
  if (stage === 'chapter_writing') {
    const path = within(workspace.projectRoot, 'outline/confirmed-outline.json')
    await assertNoLinkedPath(workspace.root, path)
    let raw: string
    try { raw = await readFile(path, 'utf8') } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workflow, status: 'waiting_user', run: null }
      throw error
    }
    const outline = parseOutlineArtifact(JSON.parse(raw))
    if (await readCurrentWritingPlan(workspace, outlineArtifactSha256(outline)) === undefined) return { workflow, status: 'waiting_user', run: null }
    const completed = session.events.findLast(event => event.type === 'bid.stage.completed' && event.data.stage === stage
      || event.type === 'bid.stage.reset')
    const valid = completed?.type === 'bid.stage.completed'
      && (await validateChapterWriting(workspace, stage, completed.data.artifacts)).ok
    return { workflow, status: valid ? 'completed' : 'ready', run: null }
  }
  if (getBidStagePolicy(stage).userGate === 'after_validation') {
    const gate = session.events.findLast(event =>
      (event.type === 'bid.user_confirmation.required' || event.type === 'bid.user_confirmation.received'
        || event.type === 'bid.stage.attention_required') && event.data.stage === stage
      || (event.type === 'bid.project.resumed' || event.type === 'bid.task.changed')
        && event.data.state.workflow?.stage === stage && event.data.state.run === null
        && (event.data.state.status === 'ready' || event.data.state.status === 'waiting_user' || event.data.state.status === 'completed')
      || event.type === 'bid.stage.reset')
    return { workflow, status: gate?.type === 'bid.user_confirmation.required' || gate?.type === 'bid.stage.attention_required'
      || (gate?.type === 'bid.project.resumed' || gate?.type === 'bid.task.changed') && gate.data.state.status === 'waiting_user'
      ? 'waiting_user' : 'ready', run: null }
  }
  return { workflow, status: 'ready', run: null }
}
