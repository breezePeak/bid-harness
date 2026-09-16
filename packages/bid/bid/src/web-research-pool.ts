/** Live S4 Web research assets shared by concurrent Mapping Children. */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolArgsError, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ZodError } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidCommitScope } from './run-coordinator.ts'
import {
  buildWebEvidenceChunkIndex,
  parseWebEvidenceChunkIndex,
  webEvidenceChunkIndexMatches,
  webEvidenceChunkIndexPath,
  webEvidenceChunkSourceId,
  type WebEvidenceChunkIndex,
} from './web-evidence-chunks.ts'
import { webEvidenceSnapshotFromFetch, type WebEvidenceSnapshot } from './web-evidence-snapshot.ts'
import {
  normalizeWebEvidenceUrl,
  parseWebEvidenceSourcesArtifact,
  webEvidenceContentSha256,
  uniqueWebEvidenceSources,
  type WebEvidenceSource,
} from './web-evidence-source-artifacts.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** S4 Web Research Pool 的确定性验收统计。 */
export interface WebResearchPoolStats {
  web_sources_fetched: number
  web_sources_reused: number
  duplicate_fetch_avoided: number
  web_chunks_read: number
}

interface WebResearchAsset {
  snapshot: WebEvidenceSnapshot
  index: WebEvidenceChunkIndex
}

type RawFetch = (url: string, exec: ToolRunContext) => Promise<ToolExecutionResult>

/** Host-owned pool that publishes a fetched snapshot before its Child task finishes. */
export class S4WebResearchPool {
  private readonly assets = new Map<string, WebResearchAsset>()
  private readonly sourceIdsByUrl = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<{ asset: WebResearchAsset; reused: boolean }>>()
  private readonly readByChild = new Map<string, Set<string>>()
  private commitQueue = Promise.resolve()
  private readonly counters: WebResearchPoolStats = {
    web_sources_fetched: 0,
    web_sources_reused: 0,
    duplicate_fetch_avoided: 0,
    web_chunks_read: 0,
  }

  constructor(
    private readonly workspace: BidWorkspace,
    private readonly commits: BidCommitScope,
    private readonly rawFetch: RawFetch,
  ) {}

  /**
   * 恢复有效 Snapshot，并重建缺失或非法的确定性索引。
   * @param sources 已登记的 Web Source。
   */
  async restore(sources: readonly WebEvidenceSource[]): Promise<void> {
    for (const source of sources) {
      const snapshotPath = join(this.workspace.projectRoot, ...source.snapshot_path.split('/'))
      await assertNoLinkedPath(this.workspace.root, snapshotPath)
      const content = await readFile(snapshotPath, 'utf8')
      if (!(await lstat(snapshotPath)).isFile() || content.trim().length === 0
        || webEvidenceContentSha256(content) !== source.content_sha256) {
        throw new Error(`WEB_EVIDENCE_SNAPSHOT_INVALID:${source.source_id}`)
      }
      const rebuilt = buildWebEvidenceChunkIndex(source, content)
      const indexPath = join(this.workspace.projectRoot, ...webEvidenceChunkIndexPath(source.source_id).split('/'))
      await assertNoLinkedPath(this.workspace.root, indexPath)
      let saved: WebEvidenceChunkIndex | undefined
      try {
        saved = parseWebEvidenceChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof ZodError)) throw error
      }
      const index = saved !== undefined && webEvidenceChunkIndexMatches(saved, source, content) ? saved : rebuilt
      if (index === rebuilt) await this.commits.writeJson(indexPath, rebuilt)
      this.publishMemory({ snapshot: { source, content }, index })
    }
  }

  /**
   * 获取或复用一个 URL，并原子发布 Snapshot、索引和 ledger 条目。
   * @param url 待获取的 HTTP(S) 地址。
   * @param exec 当前工具调用上下文。
   * @returns 有界 Source 目录及是否复用已有结果。
   */
  async fetch(url: string, exec: ToolRunContext): Promise<ReturnType<S4WebResearchPool['sourceCatalog']> & { reused: boolean }> {
    const normalized = normalizeWebEvidenceUrl(url)
    if (normalized === undefined) throw new ToolArgsError(['url: 必须是 HTTP(S) 绝对地址。'])
    const known = this.assetByUrl(normalized)
    if (known !== undefined) {
      this.counters.web_sources_reused++
      return { ...this.sourceCatalog(known), reused: true }
    }
    const pending = this.inflight.get(normalized)
    if (pending !== undefined) {
      this.counters.duplicate_fetch_avoided++
      return { ...this.sourceCatalog((await pending).asset), reused: true }
    }
    const fetching = this.fetchAndRegister(url, exec)
    this.inflight.set(normalized, fetching)
    try {
      const result = await fetching
      return { ...this.sourceCatalog(result.asset), reused: result.reused }
    } finally {
      this.inflight.delete(normalized)
    }
  }

  private async fetchAndRegister(url: string, exec: ToolRunContext): Promise<{ asset: WebResearchAsset; reused: boolean }> {
    const result = await this.rawFetch(url, exec)
    if (result.isError) throw new ToolArgsError([`url: Web 获取失败：${result.error.message}`])
    const snapshot = webEvidenceSnapshotFromFetch(url, result.value)
    if (snapshot === undefined) throw new ToolArgsError(['url: Web 获取未返回 HTTP 2xx 非空正文。'])
    const existing = this.assets.get(snapshot.source.source_id)
    if (existing !== undefined) {
      this.linkSourceUrls(snapshot.source, existing.snapshot.source.source_id)
      this.counters.web_sources_reused++
      return { asset: existing, reused: true }
    }
    const asset = { snapshot, index: buildWebEvidenceChunkIndex(snapshot.source, snapshot.content) }
    let committed: WebResearchAsset | undefined
    await this.enqueueCommit(async () => {
      const existingInCommit = this.assets.get(snapshot.source.source_id)
      if (existingInCommit !== undefined) {
        this.linkSourceUrls(snapshot.source, existingInCommit.snapshot.source.source_id)
        committed = existingInCommit
        this.counters.web_sources_reused++
        return
      }
      const snapshotPath = join(this.workspace.projectRoot, ...snapshot.source.snapshot_path.split('/'))
      const indexPath = join(this.workspace.projectRoot, ...webEvidenceChunkIndexPath(snapshot.source.source_id).split('/'))
      await assertNoLinkedPath(this.workspace.root, snapshotPath)
      await assertNoLinkedPath(this.workspace.root, indexPath)
      const ledger = parseWebEvidenceSourcesArtifact({
        stage: 'evidence_mapping',
        sources: uniqueWebEvidenceSources([...this.assets.values()].map(item => item.snapshot.source).concat(snapshot.source)),
      })
      await this.commits.publish(async (lease) => {
        await lease.writeText(snapshotPath, snapshot.content)
        await lease.writeJson(indexPath, asset.index)
        await lease.writeJson(join(this.workspace.projectRoot, 'analysis/web-evidence-sources.json'), ledger)
      })
      this.publishMemory(asset)
      committed = asset
    })
    if (committed === asset) this.counters.web_sources_fetched++
    return { asset: committed ?? this.assets.get(snapshot.source.source_id) ?? asset, reused: committed !== asset }
  }

  private enqueueCommit(work: () => Promise<void>): Promise<void> {
    const next = this.commitQueue.then(work)
    this.commitQueue = next.catch(() => {})
    return next
  }

  private publishMemory(asset: WebResearchAsset): void {
    this.assets.set(asset.snapshot.source.source_id, asset)
    this.linkSourceUrls(asset.snapshot.source, asset.snapshot.source.source_id)
  }

  private linkSourceUrls(source: WebEvidenceSource, sourceId: string): void {
    for (const url of [source.requested_url, source.final_url]) {
      const normalized = normalizeWebEvidenceUrl(url)
      if (normalized !== undefined) this.sourceIdsByUrl.set(normalized, sourceId)
    }
  }

  private assetByUrl(normalizedUrl: string): WebResearchAsset | undefined {
    const sourceId = this.sourceIdsByUrl.get(normalizedUrl)
    return sourceId === undefined ? undefined : this.assets.get(sourceId)
  }

  /**
   * 分页列出稳定 Source 摘要，并可按字面值过滤。
   * @param offset 起始序号。
   * @param limit 最大返回数。
   * @param filter 可选字面过滤词。
   * @returns Source 摘要页。
   */
  listSources(offset: number, limit: number, filter?: string): { sources: unknown[]; next_offset?: number } {
    const needle = filter?.toLocaleLowerCase()
    const assets = [...this.assets.values()].filter(asset => needle === undefined || [
      asset.index.title,
      asset.snapshot.source.final_url,
      ...asset.index.headings.map(heading => heading.title),
    ].some(value => value.toLocaleLowerCase().includes(needle)))
    const page = assets.slice(offset, offset + limit)
    return {
      sources: page.map(asset => this.sourceSummary(asset)),
      ...(offset + limit < assets.length ? { next_offset: offset + limit } : {}),
    }
  }

  /**
   * 分页列出一个 Source 的 Chunk 目录，不返回正文。
   * @param sourceRef Source 级运行内引用。
   * @param offset 起始序号。
   * @param limit 最大返回数。
   * @param heading 可选标题过滤词。
   * @returns Source 元数据和 Chunk 目录页。
   */
  listChunks(
    sourceRef: string,
    offset: number,
    limit: number,
    heading?: string,
  ): { source: unknown; chunks: unknown[]; next_offset?: number } {
    const asset = this.sourceFromRef(sourceRef)
    const needle = heading?.toLocaleLowerCase()
    const chunks = asset.index.chunks.filter(chunk => needle === undefined
      || chunk.heading_path.some(value => value.toLocaleLowerCase().includes(needle)))
    const page = chunks.slice(offset, offset + limit)
    return {
      source: this.sourceSummary(asset),
      chunks: page.map(
        ({ chunk_ref, heading_path, preview, char_count }) => ({
          chunk_ref,
          heading_path,
          preview,
          char_count,
        }),
      ),
      ...(offset + limit < chunks.length ? { next_offset: offset + limit } : {}),
    }
  }

  /**
   * 读取一个精确 Chunk，并记录发起读取的 Child。
   * @param ref Web Chunk 引用。
   * @param childId 当前 Child 身份。
   * @returns Source 元数据和 Chunk 正文。
   */
  readChunk(ref: string, childId: string): unknown {
    const sourceId = webEvidenceChunkSourceId(ref)
    const asset = sourceId === undefined ? undefined : this.assets.get(sourceId)
    const chunk = asset?.index.chunks.find(item => item.chunk_ref === ref)
    if (asset === undefined || chunk === undefined) throw new ToolArgsError([`source_ref: 未知 Web Chunk ${ref}。`])
    const body = asset.snapshot.content.slice(chunk.start_offset, chunk.end_offset)
    const reads = this.readByChild.get(childId) ?? new Set<string>()
    reads.add(ref)
    this.readByChild.set(childId, reads)
    this.counters.web_chunks_read++
    return {
      source_ref: `W:${sourceId}`,
      chunk_ref: ref,
      url: asset.snapshot.source.final_url,
      heading_path: chunk.heading_path,
      body,
    }
  }

  /**
   * 返回 Source 元数据和有界 Chunk 目录。
   * @param ref Source 级运行内引用。
   * @returns 不含完整正文的 Source 目录。
   */
  readSourceCatalog(ref: string): unknown {
    return this.sourceCatalog(this.sourceFromRef(ref))
  }

  /**
   * 返回一个 Child 在本次运行中实际读取的 Chunk 引用。
   * @param childId Child 身份。
   * @returns 已读 Chunk 引用集合。
   */
  readChunkRefs(childId: string): ReadonlySet<string> {
    return this.readByChild.get(childId) ?? new Set<string>()
  }

  /**
   * 返回当前已提交的全部 Snapshot。
   * @returns 用于映射和裁剪的 Snapshot。
   */
  snapshots(): WebEvidenceSnapshot[] {
    return [...this.assets.values()].map(asset => asset.snapshot)
  }

  /**
   * 返回确定性验收计数。
   * @returns 当前 Pool 统计快照。
   */
  stats(): WebResearchPoolStats {
    return { ...this.counters }
  }

  private sourceFromRef(ref: string): WebResearchAsset {
    const match = /^W:(WEB-[a-f0-9]{16})$/u.exec(ref)
    const asset = match?.[1] === undefined ? undefined : this.assets.get(match[1])
    if (asset === undefined) throw new ToolArgsError([`source_ref: 未知 Web Source ${ref}。`])
    return asset
  }

  private sourceSummary(asset: WebResearchAsset) {
    return {
      source_ref: `W:${asset.snapshot.source.source_id}`,
      title: asset.index.title,
      url: asset.snapshot.source.final_url,
      top_level_headings: asset.index.headings.filter(heading => heading.level === 1).map(heading => heading.title),
      chunk_count: asset.index.chunks.length,
      truncated: asset.snapshot.source.truncated,
    }
  }

  private sourceCatalog(asset: WebResearchAsset) {
    return {
      ...this.sourceSummary(asset),
      headings: asset.index.headings,
      chunks: asset.index.chunks.slice(0, 10).map(({ chunk_ref, heading_path, preview, char_count }) => (
        { chunk_ref, heading_path, preview, char_count }
      )),
      ...(asset.index.chunks.length > 10 ? { next_chunk_offset: 10 } : {}),
    }
  }
}
