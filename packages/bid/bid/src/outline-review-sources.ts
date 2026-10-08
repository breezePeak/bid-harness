/** 从 S2 引用装载目录审核原文，保留采购文件归属并拒绝不完整证据。 */
import { readFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { BidStageExecutionError } from './control-plane-contract.ts'
import { evidenceChunkId, parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidWorkspace } from './index.ts'
import type { OutlineReviewSource } from './outline-review-context.ts'
import type { TenderSourceRef } from './tender-analysis-artifacts.ts'
import { buildTenderLocators } from './tender-analysis-submission.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/**
 * 为同一采购文件的原文 Chunk 生成运行内去重键。
 * @param ref 已持久化的 S2 来源引用。
 * @returns 同时绑定文件身份和 Chunk 路径的键。
 */
export function outlineReviewSourceKey(ref: TenderSourceRef): string {
  return JSON.stringify([ref.file_id, ref.chunk])
}

/**
 * 核对 S2 来源与上传文件 Corpus 后读取完整 Chunk；缺证时不启动语义审核。
 * @param workspace 持有已上传采购文件和 Corpus 的项目。
 * @param refs 本次项目事实及章节覆盖记录实际引用的 S2 来源。
 * @returns 去重且带行号的完整采购原文；文件、路径或行范围无效时抛出补证诊断。
 */
export async function loadOutlineReviewSources(workspace: BidWorkspace, refs: readonly TenderSourceRef[]): Promise<OutlineReviewSource[]> {
  const sources = new Map<string, OutlineReviewSource>()
  const manifest = await workspace.readManifest()
  const fileIds = new Set(refs.map(ref => ref.file_id))
  const files = manifest.files.filter(file => fileIds.has(file.id))
  const load = async (): Promise<void> => {
    for (const fileId of fileIds) {
      const file = files.find(item => item.id === fileId)
      if (file === undefined || file.role !== 'tender' || file.parseStatus !== 'success') throw new Error(`来源文件 ${fileId} 不是已解析的本项目采购文件`)
      if (file.corpusPath === null || file.chunksPath === null || file.chunkIndexPath === null || file.documentPath === null) throw new Error(`来源文件 ${fileId} 缺少 Corpus 路径`)
      const corpus = within(workspace.projectRoot, file.corpusPath)
      if (relative(join(workspace.corpusRoot, basename(file.inputPath)), corpus) !== '') throw new Error(`来源文件 ${fileId} 的 Corpus 不属于该上传文件`)
      const chunks = within(workspace.projectRoot, file.chunksPath)
      const indexPath = within(workspace.projectRoot, file.chunkIndexPath)
      if (relative(join(corpus, 'chunks'), chunks) !== '' || relative(join(chunks, 'index.json'), indexPath) !== '') throw new Error(`来源文件 ${fileId} 的 chunks/index 不属于该 Corpus`)
      await assertNoLinkedPath(workspace.root, indexPath)
      const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
      if (relative(within(workspace.projectRoot, file.documentPath), resolve(chunks, index.source_document)) !== '') throw new Error(`来源文件 ${fileId} 的 index 指向其他文件正文`)
      if (index.chunks.some(entry => !/^chunk_\d{4}$/u.test(entry.id) || entry.path !== `${entry.id}.md`)
        || new Set(index.chunks.map(entry => entry.id)).size !== index.chunks.length) throw new Error(`来源文件 ${fileId} 的 Chunk 身份无效或重复`)
    }
    const locators = await buildTenderLocators(workspace, { ...manifest, files })
    for (const locator of locators) for (const ref of refs.filter(item => item.file_id === locator.file_id)) {
      const key = outlineReviewSourceKey(ref)
      const chunk = [...locator.chunks.values()].find(item => item.artifactPath === ref.chunk)
      if (chunk === undefined) throw new Error(`${ref.file_id} / ${ref.chunk} 不属于引用的采购文件`)
      let source = sources.get(key)
      if (source === undefined) {
        await assertNoLinkedPath(workspace.root, chunk.absolutePath)
        const content = await readFile(chunk.absolutePath, 'utf8')
        if (!content.startsWith(`<!-- chunk_id: ${evidenceChunkId(ref.chunk)} -->`) || !content.includes('\n\n')) throw new Error(`${ref.file_id} / ${ref.chunk} 的 Chunk 元数据错误`)
        const lines = content.split('\n')
        source = { key, file_id: ref.file_id, name: locator.name, chunk: ref.chunk,
          text: lines.map((line, index) => `${String(index + 1)}: ${line}`).join('\n'), line_count: lines.length }
        sources.set(key, source)
      }
      if (ref.line_start < 1 || ref.line_end < ref.line_start || ref.line_end > source.line_count) throw new Error(`${ref.file_id} / ${ref.chunk} 的引用行范围超出原文`)
    }
  }
  try { await load() } catch (error) {
    throw new BidStageExecutionError([{ code: 'OUTLINE_REVIEW_SOURCE_INVALID',
      message: `目录审核采购原文未完整装载：${error instanceof Error ? error.message : String(error)}。请修复已有 Corpus 或 S2 来源关联后复核；缺证不能证明采购事实不存在。` }])
  }
  return [...sources.values()]
}
