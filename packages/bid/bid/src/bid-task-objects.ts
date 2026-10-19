/** 非章节任务的原件、Word 节点和图资产授权复验。 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidWorkspace } from './index.ts'
import { isBidChapterScope, type BidCapabilityScope } from './bid-capability-contract.ts'
import { resolveBidFile } from './file-assets.ts'
import { indexDocxDocument } from './docx-document-index.ts'
import { readPublishedBidFigure } from './published-figures.ts'

/**
 * 按对象类型复验完整身份，不读取专业目录，也不赋予只读参考资料额外写权限。
 * @param workspace 正式项目。
 * @param session 原任务授权会话。
 * @param scope Host 从对象选择表绑定的范围。
 */
export async function verifyBidTaskObjects(workspace: BidWorkspace, session: Session, scope: BidCapabilityScope): Promise<void> {
  if (isBidChapterScope(scope)) return
  if (scope.kind === 'figures') {
    for (const ref of scope.figure_refs) await readPublishedBidFigure(workspace, session, ref)
    return
  }
  const files = scope.kind === 'files' ? scope.file_refs : scope.block_refs.map(block => block.file_ref)
  const indexed = new Map<string, Awaited<ReturnType<typeof indexDocxDocument>>>()
  for (const ref of files) {
    const key = JSON.stringify(ref)
    const file = await resolveBidFile(workspace, session, ref)
    if (scope.kind !== 'document_blocks' || indexed.has(key)) continue
    if (!file.ref.name.toLowerCase().endsWith('.docx')) throw new Error('BID_DOCX_REQUIRED')
    indexed.set(key, await indexDocxDocument(file.bytes, ref))
  }
  if (scope.kind === 'document_blocks') for (const ref of scope.block_refs) {
    if (!indexed.get(JSON.stringify(ref.file_ref))?.blocks.some(block => JSON.stringify(block.ref) === JSON.stringify(ref))) {
      throw new Error('BID_DOCX_BLOCK_CHANGED')
    }
  }
}
