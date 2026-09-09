/** Bid Main Agent 的阶段上下文替换与权威 Artifact 交接。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

function replaceStageContext(
  session: Session,
  stage: BidStage,
  notice: string,
  summary: string,
): void {
  const stageIndex = BID_STAGES.indexOf(stage)
  const predecessor = stageIndex === 0 ? undefined : BID_STAGES[stageIndex - 1]
  const completedPredecessor = predecessor === undefined ? undefined : session.events.findLast(event => (
    event.type === 'bid.stage.completed' && event.data.stage === predecessor
  ))
  const nodes = session.surface.nodes
  const start = nodes.findIndex(seq => seq > (completedPredecessor?.seq ?? -1))
  const message = createUserMessage({
    content: [{ type: 'text', text: notice }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'notice', summary },
  })
  if (start < 0) {
    session.append('user/message', message, { surfaceOp: 'append' })
    return
  }
  const shadowed = nodes.slice(start)
  const first = shadowed[0]
  const last = shadowed.at(-1)
  if (first === undefined || last === undefined) throw new Error('Bid stage context range is empty')
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: [...shadowed],
  })
}
