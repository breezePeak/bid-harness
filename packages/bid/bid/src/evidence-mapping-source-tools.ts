/** S4 本地资料读取、字面搜索与分页；模型不接收可自行构造的文件路径。 */
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { MappingCorpusLocation } from './evidence-mapping-corpus.ts'
import type { WebEvidenceSnapshot } from './web-evidence-snapshot.ts'

/** @param fileIndex 当前资料目录中的文件序号。 @param chunkId 该文件的真实分块 ID。 @returns 运行内材料引用。 */
export function mappingMaterialRef(fileIndex: number, chunkId: string): string {
  return `M${fileIndex + 1}:${chunkId}`
}

/** @param locations 已授权的资料目录。 @returns 完整结构目录、确定的正文范围引用与全文件搜索范围。 */
export function mappingSourceCatalog(locations: readonly MappingCorpusLocation[]) {
  return locations.map((location, fileIndex) => ({
    name: location.name, file_ref: `F${fileIndex + 1}`, source_ref: `F${fileIndex + 1}`, scope_ref: `F${fileIndex + 1}`,
    directory: location.source.directory.map(({ heading_index, ...heading }) => ({ ...heading,
      ...(heading_index === null ? {} : { source_ref: `F${fileIndex + 1}:H${heading_index + 1}:direct`, scope_ref: `F${fileIndex + 1}:H${heading_index + 1}:full` }),
    })),
    body_headings: location.source.headings.map((heading, index) => ({
      heading_path: heading.heading_path, heading_line: heading.start,
      direct_body: { start: heading.body_start, end: heading.end, source_ref: `F${fileIndex + 1}:H${index + 1}:direct` },
      full_section: { start: heading.start, end: heading.full_end, source_ref: `F${fileIndex + 1}:H${index + 1}:full` },
    })),
  }))
}

const readSchema = z.object({ source_ref: z.string().min(1) }).strict()
const searchSchema = z.object({ scope_ref: z.string().min(1), keywords: z.array(z.string().min(1)).min(1) }).strict()

type TextSource = { fileIndex: number; location: MappingCorpusLocation; start: number; end: number; chunk?: MappingCorpusLocation['chunks'][number] }
type SearchHit = { source_ref: string; file_id: string; name: string; line: number; excerpt: string; heading_paths: string[][] }
type Page = { kind: 'text'; source: TextSource; offset: number } | { kind: 'search'; hits: SearchHit[]; offset: number }

/**
 * 创建当前 Child 的受控读取工具；后续引用由程序分配，读取不要求先搜索。
 * @param locations 已预检且属于当前项目的本地资料。
 * @param snapshots 当前授权的联网快照，包含本 Child 新抓取的正文。
 * @returns 工具定义；所有接受入口直接拒绝未知引用及额外路径、来源字段。
 */
export function createMappingSourceTools(locations: readonly MappingCorpusLocation[], snapshots: () => readonly WebEvidenceSnapshot[]) {
  const sources = new Map<string, TextSource>()
  const pages = new Map<string, Page>()
  const webPages = new Map<string, { snapshot: WebEvidenceSnapshot; offset: number }>()
  for (const [fileIndex, location] of locations.entries()) {
    sources.set(`F${fileIndex + 1}`, { fileIndex, location, start: 1, end: location.source.lines.length })
    for (const [index, heading] of location.source.headings.entries()) {
      sources.set(`F${fileIndex + 1}:H${index + 1}:direct`, { fileIndex, location, start: heading.body_start, end: heading.end })
      sources.set(`F${fileIndex + 1}:H${index + 1}:full`, { fileIndex, location, start: heading.start, end: heading.full_end })
    }
    for (const chunk of location.chunks) {
      const entry = location.source.chunks.find(item => item.id === chunk.id)
      if (entry === undefined) throw new Error(`资料定位缺少分块：${chunk.id}`)
      sources.set(mappingMaterialRef(fileIndex, chunk.id), {
        fileIndex, location, start: entry.source_line_start, end: entry.source_line_end, chunk,
      })
    }
  }
  const nextRef = (page: Page): string => {
    const ref = `P${pages.size + 1}`
    pages.set(ref, page)
    return ref
  }
  const readText = (source: TextSource, offset: number) => {
    const location = source.location
    const text = source.chunk?.body ?? location.source.lines.slice(source.start - 1, source.end).join('\n')
    const body = text.slice(offset, offset + 12_000)
    const start = source.start + text.slice(0, offset).split('\n').length - 1
    const end = start + body.split('\n').length - 1
    const chunks = body.length === 0 ? [] : location.source.chunks.filter(chunk => source.chunk === undefined
      ? chunk.source_line_start <= end && chunk.source_line_end >= start : chunk.id === source.chunk.id)
    return {
      file_id: location.file_id, source_kind: location.role, name: location.name,
      source_location: { start_line: start, end_line: source.start > source.end ? source.end : end, character_offset: offset }, body,
      materials: chunks.map(chunk => ({ material_ref: mappingMaterialRef(source.fileIndex, chunk.id), chunk: chunk.id,
        actual_chunk_coverage: chunk.coverage, source_line_start: chunk.source_line_start, source_line_end: chunk.source_line_end,
      })),
      ...(offset + body.length >= text.length ? {} : { next_ref: nextRef({ kind: 'text', source, offset: offset + body.length }) }),
    }
  }
  const readHits = (hits: SearchHit[], offset: number) => ({
    hits: hits.slice(offset, offset + 20),
    ...(offset + 20 >= hits.length ? {} : { next_ref: nextRef({ kind: 'search', hits, offset: offset + 20 }) }),
  })
  const output = { schema: { type: 'object' as const }, render: (_args: unknown, result: unknown) => [{ type: 'text' as const, text: JSON.stringify(result) }] }
  return [{
    name: 'read_source', description: '读取目录、材料、命中或后续引用。结果保留真实来源及整块实际覆盖范围；可直接读取，不必先搜索。',
    parameters: z.toJSONSchema(readSchema, { target: 'draft-7' }), output,
    async execute(raw: unknown): Promise<unknown> {
      const { source_ref: ref } = await readSchema.parseAsync(raw)
      const page = pages.get(ref)
      if (page !== undefined) return page.kind === 'text' ? readText(page.source, page.offset) : readHits(page.hits, page.offset)
      const source = sources.get(ref)
      if (source !== undefined) return readText(source, 0)
      const web = snapshots().find(snapshot => `W:${snapshot.source.source_id}` === ref)
      if (web !== undefined) {
        // 快照正文使用相同分页引用；本地位置与材料引用只来自本地资料目录。
        return { url: web.source.final_url, source_id: web.source.source_id, body: web.content.slice(0, 12_000),
          ...(web.content.length > 12_000 ? { next_ref: storeWebPage(web, 1) } : {}) }
      }
      const webPage = webPages.get(ref)
      if (webPage !== undefined) return { url: webPage.snapshot.source.final_url, source_id: webPage.snapshot.source.source_id,
        body: webPage.snapshot.content.slice(webPage.offset, webPage.offset + 12_000),
        ...(webPage.offset + 12_000 < webPage.snapshot.content.length
          ? { next_ref: storeWebPage(webPage.snapshot, webPage.offset / 12_000 + 1) } : {}),
      }
      throw new ToolArgsError([`source_ref: 未知或过期引用 ${ref}。请使用资料目录或工具返回的引用。`])
    },
  }, {
    name: 'search_sources', description: '在程序提供的范围中按关键词作字面搜索（任一关键词命中）；ALL 表示全部资料。返回原文位置及可读引用，后续页用 read_source。',
    parameters: z.toJSONSchema(searchSchema, { target: 'draft-7' }), output,
    async execute(raw: unknown): Promise<unknown> {
      const { scope_ref: ref, keywords } = await searchSchema.parseAsync(raw)
      const scope = sources.get(ref)
      if (scope === undefined && ref !== 'ALL') throw new ToolArgsError([`scope_ref: 未知搜索范围 ${ref}。`])
      const scopes: TextSource[] = scope === undefined
        ? locations.map((location, fileIndex) => ({ fileIndex, location, start: 1, end: location.source.lines.length })) : [scope]
      const hits: SearchHit[] = []
      for (const range of scopes) {
        const location = range.location
        const lines = range.chunk?.body.split('\n') ?? location.source.lines.slice(range.start - 1, range.end)
        for (const [index, text] of lines.entries()) {
          const line = range.start + index
          const matches = keywords.map(keyword => text.indexOf(keyword)).filter(index => index >= 0)
          if (matches.length === 0) continue
          const start = Math.max(0, Math.min(...matches) - 100)
          const ref = nextRef({ kind: 'text', source: range.chunk === undefined ? { ...range, start: line, end: line } : range, offset: 0 })
          hits.push({ source_ref: ref, file_id: location.file_id, name: location.name, line,
            excerpt: text.slice(start, start + 400), heading_paths: location.source.chunks.flatMap(chunk => chunk.coverage)
              .filter(coverage => coverage.start <= line && coverage.end >= line).map(coverage => coverage.heading_path),
          })
        }
      }
      return readHits(hits, 0)
    },
  }]

  function storeWebPage(snapshot: WebEvidenceSnapshot, page: number): string {
    const ref = `WP${webPages.size + 1}`
    webPages.set(ref, { snapshot, offset: page * 12_000 })
    return ref
  }
}
