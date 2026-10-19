/** 按原会话授权及正式发布回执读取可复用图资产。 */
import { readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { bidFigurePaths, bidFigureRecordSchema, readBidFigure, type BidFigureRef, type BidFigureRecord } from './figure-assets.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { readBidWorkDescriptor, readBidWorkRequest } from './work-descriptor.ts'
import { hasBidTaskAuthorization } from './bid-tool-authorization.ts'
import { readCapabilityPublicationReceipt } from './bid-capability-changes.ts'

async function readableFigureWork(workspace: BidWorkspace, session: Session, workId: string) {
  const work = await readBidWorkDescriptor(workspace, workId)
  if (work?.kind !== 'capability_task') return null
  const request = z.object({ authorization: z.object({ session_id: z.string(), message_id: z.string() }) })
    .parse(await readBidWorkRequest(workspace, work))
  return hasBidTaskAuthorization(session, request.authorization) ? work : null
}

/**
 * 复验本会话授权且正式发布的图资产，不能借同项目目录读取其他会话的图。
 * @param workspace 正式项目。
 * @param session 当前主会话。
 * @param ref 模型位置绑定的精确图版本。
 * @returns 当前发布回执覆盖的真实 PNG 与记录。
 */
export async function readPublishedBidFigure(workspace: BidWorkspace,
  session: Session, ref: BidFigureRef): ReturnType<typeof readBidFigure> {
  const result = await readBidFigure(workspace, ref)
  const work = await readableFigureWork(workspace, session, result.record.work_id)
  if (work === null) throw new Error('BID_FIGURE_SESSION_MISMATCH')
  const receipt = await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)
  if (receipt?.goal_met !== true || !receipt.files.some(file => file.path === result.record.path && file.sha256 === ref.version)
    || !receipt.files.some(file => file.path === bidFigurePaths(result.record.step_id).record)) throw new Error('BID_FIGURE_NOT_PUBLISHED')
  return result
}

/**
 * 从图资产记录收集已通过检查的版本，损坏记录不静默忽略。
 * @param workspace 当前正式或已授权候选项目。
 * @param session 当前会话；没有会话时不展示其他任务的资产。
 * @returns 可供模型按位置选用的真实图资产。
 */
export async function listBidFigures(workspace: BidWorkspace, session?: Session): Promise<BidFigureRecord[]> {
  if (session === undefined) return []
  const root = within(workspace.projectRoot, 'assets/figures')
  await assertNoLinkedPath(workspace.root, root)
  let names: string[]
  try { names = await readdir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const figures: BidFigureRecord[] = []
  for (const name of names.filter(name => /^[a-f0-9]{64}$/u.test(name)).sort()) {
    const path = within(root, `${name}/record.json`)
    await assertNoLinkedPath(workspace.root, path)
    let text: string
    try { text = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const record = bidFigureRecordSchema.parse(JSON.parse(text))
    if (record.ref.asset_id !== name) throw new Error('BID_FIGURE_IDENTITY_INVALID')
    if (record.content_review.status !== 'passed') continue
    if (await readableFigureWork(workspace, session, record.work_id) === null) continue
    figures.push((await readPublishedBidFigure(workspace, session, record.ref)).record)
  }
  return figures
}
