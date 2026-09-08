/** S4 的 Corpus 预检、真实正文范围及受控资料工具授权。 */
import { lstat, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { BidStageExecutionError } from './control-plane-contract.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidManifest, BidWorkspace } from './index.ts'
import { readDocumentOutlineHeadings, type DocumentOutlineHeading } from './outline-framework.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { buildMappingSourceIndex, type MappingSourceIndex } from './evidence-mapping-sources.ts'

/** 已预检、可从 Child 任意 cwd 直接调用的绝对路径。 */
export interface MappingCorpusLocation {
  file_id: string
  role: 'reference' | 'reference_bid'
  name: string
  chunks_path: string
  chunk_index_path: string
  chunks: Array<{ id: string; path: string; body: string }>
  /** 当前标准化正文及其实际标题位置，只在 S4 运行中使用。 */
  source: MappingSourceIndex
  /** 参考旧标书的完整目录，由 Host 注入章节研究任务。 */
  outline?: readonly DocumentOutlineHeading[]
}

/**
 * 在启动 Child 前验证所有成功解析的 Evidence Corpus。
 * @param workspace - 拥有 Corpus 的 项目工作区。
 * @param manifest - 当前文件清单。
 * @returns Prompt、Guard 与 Evidence 验证共用的绝对路径。
 * @throws EVIDENCE_MAPPING_CORPUS_INVALID，包含文件身份及具体损坏原因。
 */
export async function resolveMappingCorpusLocations(workspace: BidWorkspace, manifest: BidManifest): Promise<MappingCorpusLocation[]> {
  const locations: MappingCorpusLocation[] = []
  for (const file of manifest.files) {
    if (file.parseStatus !== 'success' || (file.role !== 'reference' && file.role !== 'reference_bid')) continue
    try {
      if (file.chunksPath === null || file.chunkIndexPath === null || file.corpusPath === null) throw new Error('缺少 chunks 或 index 路径')
      const corpus = within(workspace.projectRoot, file.corpusPath)
      within(workspace.corpusRoot, relative(workspace.corpusRoot, corpus))
      if (relative(join(workspace.corpusRoot, basename(file.inputPath)), corpus) !== '') throw new Error('Corpus 不属于该上传文件')
      const chunks = within(workspace.projectRoot, file.chunksPath)
      const indexPath = within(workspace.projectRoot, file.chunkIndexPath)
      if (relative(join(corpus, 'chunks'), chunks) !== '' || relative(join(chunks, 'index.json'), indexPath) !== '') throw new Error('chunks/index 不属于该文件的 Corpus')
      await assertNoLinkedPath(workspace.root, indexPath)
      if (!(await lstat(chunks)).isDirectory() || !(await lstat(indexPath)).isFile()) throw new Error('chunks 或 index 类型错误')
      const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
      if (file.documentPath === null || relative(within(workspace.projectRoot, file.documentPath), resolve(chunks, index.source_document)) !== '') throw new Error('index 指向其他文件正文')
      const ids = new Set<string>()
      const entries: MappingCorpusLocation['chunks'] = []
      for (const entry of index.chunks) {
        if (!/^chunk_\d{4}$/u.test(entry.id) || entry.path !== `${entry.id}.md` || ids.has(entry.id)) throw new Error(`非法或重复的 Chunk：${entry.id} / ${entry.path}`)
        ids.add(entry.id)
        const path = within(chunks, entry.path)
        await assertNoLinkedPath(workspace.root, path)
        if (!(await lstat(path)).isFile()) throw new Error(`Chunk 不是文件：${entry.path}`)
        const content = await readFile(path, 'utf8')
        const metadataEnd = content.indexOf('\n\n')
        if (metadataEnd < 0 || !content.startsWith(`<!-- chunk_id: ${entry.id} -->`)) throw new Error(`Chunk 元数据错误：${entry.id}`)
        entries.push({ id: entry.id, path: path.split(sep).join('/'), body: content.slice(metadataEnd + 2) })
      }
      const documentPath = within(workspace.projectRoot, file.documentPath)
      await assertNoLinkedPath(workspace.root, documentPath)
      const outline = await readDocumentOutlineHeadings(workspace, file)
      locations.push({ file_id: String(file.id), role: file.role, name: file.originalName, chunks_path: chunks.split(sep).join('/'), chunk_index_path: indexPath.split(sep).join('/'), chunks: entries,
        source: buildMappingSourceIndex(await readFile(documentPath, 'utf8'), index.chunks, outline),
        ...(file.role === 'reference_bid' ? { outline } : {}),
      })
    } catch (error) {
      throw new BidStageExecutionError([{ code: 'EVIDENCE_MAPPING_CORPUS_INVALID', message: `${file.id} / ${file.originalName}：${error instanceof Error ? error.message : String(error)}` }])
    }
  }
  return locations
}

/**
 * 对当前父 Session 的 Child 执行工具级文件授权。
 * @param locations - 本次执行已预检的 Corpus。
 * @param parentId - 本次 S4 的父 Session ID。
 * @param exec - 待执行工具及实际 Child cwd。
 * @returns 拒绝原因；undefined 表示允许或不属于本次 Child。
 */
export function mappingCorpusToolGuard(
  _locations: readonly MappingCorpusLocation[], parentId: string, exec: Readonly<ToolExecution>,
): string | undefined {
  const session = exec.agent?.session
  if (session?.header.origin !== 'subagent' || session.header.parentSession !== parentId || (exec.name !== 'read' && exec.name !== 'grep')) return undefined
  return 'S4 本地资料必须使用 read_source 或 search_sources 提供的引用读取，不能通过通用 read/grep 绕过资料定位。'
}
