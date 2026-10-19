/** 只读检查已完成步骤的真实 Word 候选；不提前发布，也不授予新文件写权限。 */
import type { Session } from '@deepseek-ai/dsh-session'
import { BidWorkspace } from './index.ts'
import { capabilityTaskRequestSchema, readCapabilityTaskCheckpoint } from './bid-capability-task.ts'
import { readBidWorkDescriptor, readBidWorkRequest } from './work-descriptor.ts'
import { readExistingBidWorkingTree } from './working-tree.ts'
import { readCapabilityStepReceipt } from './bid-capability-changes.ts'
import { hasBidTaskAuthorization } from './bid-tool-authorization.ts'
import { documentIndexFileRef, readBidDocument, type BidDocumentRecord } from './document-assets.ts'
import { indexDocxDocument, type DocxDocumentBlock, type DocxBlockRef } from './docx-document-index.ts'
import { assertDocumentTarget } from './document-capability.ts'
import type { BidStepOutputSelection, BidDocumentRef } from './document-contract.ts'

/**
 * 从当前会话的固定 Work、完成步骤和回执读取文档及可继承权限的节点。
 * @param canonical 正式项目。
 * @param session 授权消息所属会话。
 * @param workId 模型从已显示 Work 表选择的任务。
 * @param selection 已完成步骤的文档输出位置。
 * @returns 原稿来源、实际版本及独立候选节点表。
 */
export async function inspectCandidateDocument(canonical: BidWorkspace, session: Session, workId: string,
  selection: BidStepOutputSelection): Promise<{
  record: BidDocumentRecord
  blocks: Array<{
    block: DocxDocumentBlock
    target: { document_ref: BidDocumentRef; block_ref: DocxBlockRef; source_ref: DocxBlockRef } | undefined
  }> }> {
  const work = await readBidWorkDescriptor(canonical, workId)
  if (work?.kind !== 'capability_task') throw new Error('BID_DOCUMENT_WORK_INVALID')
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(canonical, work))
  if (!hasBidTaskAuthorization(session, request.authorization)) throw new Error('BID_DOCUMENT_SESSION_MISMATCH')
  const paths = await readExistingBidWorkingTree(canonical, work)
  if (paths === null) throw new Error('BID_DOCUMENT_CANDIDATE_MISSING')
  const working = new BidWorkspace(paths.root, canonical.config)
  const checkpoint = await readCapabilityTaskCheckpoint(canonical, working, { work }, request, session)
  const step = checkpoint?.steps[selection.step_position]
  const [output] = selection.output_positions
  const ref = step?.status === 'completed' && output !== undefined ? step.result.outputs?.[output] : undefined
  if (step?.status !== 'completed' || ref?.kind !== 'document') throw new Error('BID_STEP_OUTPUT_NOT_COMPLETED')
  const receipt = await readCapabilityStepReceipt(working, step.step_id, step.input_sha256)
  if (receipt === null || JSON.stringify(receipt.result.outputs) !== JSON.stringify(step.result.outputs)) throw new Error('BID_STEP_OUTPUT_RECEIPT_MISMATCH')
  const { bytes, record } = await readBidDocument(working, ref)
  if (record.work_id !== workId || record.step_id !== step.step_id) throw new Error('BID_DOCUMENT_SOURCE_WORK_MISMATCH')
  assertDocumentTarget(request.task.scope, record.root_file)
  const index = await indexDocxDocument(bytes, documentIndexFileRef(ref))
  const blocks = index.blocks.map((block) => {
    const inherited = record.anchors.find(anchor => anchor.source.part === block.ref.part
      && anchor.node_sha256 === block.ref.node_sha256 && JSON.stringify(anchor.node_path) === JSON.stringify(block.ref.node_path))
    let writable = block.writable && inherited !== undefined
    if (writable && inherited !== undefined) {
      try { assertDocumentTarget(request.task.scope, record.root_file, inherited.source) } catch (error) {
        if (!(error instanceof Error) || error.message !== 'BID_DOCUMENT_TARGET_OUTSIDE_SCOPE') throw error
        writable = false
      }
    }
    return { block: { ...block, writable }, target: !writable || inherited === undefined ? undefined : {
      document_ref: ref, block_ref: block.ref, source_ref: inherited.source,
    } }
  })
  return { record, blocks }
}
