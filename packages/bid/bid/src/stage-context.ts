/** Bid Main Agent 的阶段上下文替换与权威 Artifact 交接。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { BID_STAGES, type BidStage } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { getBidStagePolicy } from './runtime-state.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/**
 * Read and hash the next stage's policy-owned inputs without changing the current model context.
 * @param session Bid Main Agent Session whose surface changes at commit time.
 * @param workspace Project containing the authoritative stage Artifacts.
 * @param fromStage Stage whose confirmed conversation will be replaced.
 * @param toStage Successor whose policy determines the authoritative input paths.
 * @returns A synchronous commit that replaces the completed stage context with the prepared handoff.
 */
export async function prepareBidStageContextTransition(
  session: Session,
  workspace: BidWorkspace,
  fromStage: BidStage,
  toStage: BidStage,
): Promise<() => void> {
  const authoritativeInputs = await Promise.all(getBidStagePolicy(toStage).requiredInputs.map(async (path) => {
    const absolute = within(workspace.projectRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    return { path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') }
  }))
  const handoff = JSON.stringify({
    from_stage: fromStage,
    to_stage: toStage,
    authoritative_inputs: authoritativeInputs,
  }, null, 2)
  return () => {
    replaceStageContext(
      session,
      fromStage,
      `Bid 阶段交接：\n${handoff}`,
      `已进入 ${toStage}，只使用本阶段指令和权威 Artifact。`,
    )
  }
}

/**
 * Replace one reset stage and every later stage on the model surface while retaining their durable events.
 * @param session Bid Main Agent Session being reset.
 * @param stage First invalidated stage.
 */
export function resetBidStageContext(session: Session, stage: BidStage): void {
  replaceStageContext(
    session,
    stage,
    `阶段 ${stage} 已重置。此前该阶段及后续阶段的上下文已清除；仅依据当前工作区文件和后续阶段指令重新执行。`,
    `已清除 ${stage} 及后续阶段上下文。`,
  )
}

/**
 * Replace an overflowed failed stage context with its Artifact checkpoint and exact user-authored messages.
 * @param session Bid Main Agent Session whose failed attempt remains durable.
 * @param stage Failed stage being retried.
 * @returns Whether the latest failed attempt ended with a context-window error and was replaced.
 */
export function recoverOverflowedBidStageContext(session: Session, stage: BidStage): boolean {
  const started = session.events.findLastIndex(event => (
    event.type === 'bid.stage.started' && event.data.stage === stage
  ))
  const failed = session.events.findLastIndex(event => (
    event.type === 'bid.stage.failed' && event.data.stage === stage
  ))
  if (started < 0 || failed < started || !session.events.slice(started, failed + 1).some(event => (
    event.type === 'turn/end'
    && event.data.reason.kind === 'error'
    && event.data.reason.error.code === CONTEXT_WINDOW_EXCEEDED_CODE
  ))) return false

  const retained = stageSurfaceNodes(session, stage).flatMap((seq) => {
    const event = session.events[seq]
    if (event === undefined) return []
    const message = session.deriveEventMessage(event)
    if (message?.role !== 'user' || message.source.kind !== 'user') return []
    return [{ seq, message: createUserMessage({ content: message.content, source: message.source }) }]
  })
  replaceStageContext(
    session,
    stage,
    `阶段 ${stage} 的模型上下文已从当前 Artifact 检查点恢复；旧私有任务轮次不再进入模型输入，用户原话保留在检查点之后。`,
    `已从 Artifact 检查点恢复 ${stage} 模型上下文。`,
  )
  for (const { seq, message } of retained) {
    session.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [seq] })
  }
  return true
}

function stageSurfaceNodes(session: Session, stage: BidStage): readonly number[] {
  const stageIndex = BID_STAGES.indexOf(stage)
  const predecessor = stageIndex === 0 ? undefined : BID_STAGES[stageIndex - 1]
  const completedPredecessor = predecessor === undefined ? undefined : session.events.findLast(event => (
    event.type === 'bid.stage.completed' && event.data.stage === predecessor
  ))
  const nodes = session.surface.nodes
  const start = nodes.findIndex(seq => seq > (completedPredecessor?.seq ?? -1))
  return start < 0 ? [] : nodes.slice(start)
}

function replaceStageContext(
  session: Session,
  stage: BidStage,
  notice: string,
  summary: string,
): void {
  const shadowed = stageSurfaceNodes(session, stage)
  const message = createUserMessage({
    content: [{ type: 'text', text: notice }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice', summary },
  })
  if (shadowed.length === 0) {
    session.append('user/message', message, { surfaceOp: 'append' })
    return
  }
  const first = shadowed[0]
  const last = shadowed.at(-1)
  if (first === undefined || last === undefined) throw new Error('Bid stage context range is empty')
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: [...shadowed],
  })
}
