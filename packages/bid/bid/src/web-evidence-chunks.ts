/** Deterministic Markdown chunk indexes for Host-owned Web evidence snapshots. */
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { z } from 'zod'
import { webEvidenceContentSha256, type WebEvidenceSource } from './web-evidence-source-artifacts.ts'

/** Version of one Web snapshot's deterministic chunk index. */
export const WEB_EVIDENCE_CHUNK_INDEX_SCHEMA_VERSION = 1 as const
/** Soft size used when grouping complete Markdown blocks. */
export const WEB_EVIDENCE_CHUNK_TARGET_CHARS = 6_000

const chunkRefSchema = z.string().regex(/^W:WEB-[a-f0-9]{16}:C\d{4}$/u)

const chunkSchema = z.object({
  chunk_id: z.string().regex(/^C\d{4}$/u),
  chunk_ref: chunkRefSchema,
  heading_path: z.array(z.string().min(1)),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().positive(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  preview: z.string(),
  char_count: z.number().int().positive(),
}).strict().superRefine((chunk, context) => {
  if (chunk.end_line < chunk.start_line) context.addIssue({ code: 'custom', path: ['end_line'], message: 'Chunk line range is reversed' })
  if (chunk.end_offset <= chunk.start_offset || chunk.char_count !== chunk.end_offset - chunk.start_offset) {
    context.addIssue({ code: 'custom', path: ['end_offset'], message: 'Chunk offsets and length must agree' })
  }
})

const indexSchema = z.object({
  schema_version: z.literal(WEB_EVIDENCE_CHUNK_INDEX_SCHEMA_VERSION),
  source_id: z.string().regex(/^WEB-[a-f0-9]{16}$/u),
  snapshot_path: z.string().regex(/^analysis\/web-sources\/WEB-[a-f0-9]{16}\.md$/u),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().min(1),
  headings: z.array(z.object({
    level: z.number().int().min(1).max(6),
    title: z.string().min(1),
    heading_path: z.array(z.string().min(1)).min(1),
    line: z.number().int().positive(),
  }).strict()),
  chunks: z.array(chunkSchema),
}).strict().superRefine((index, context) => {
  if (index.snapshot_path !== `analysis/web-sources/${index.source_id}.md`) {
    context.addIssue({ code: 'custom', path: ['snapshot_path'], message: 'Snapshot path must be owned by its source id' })
  }
  const refs = new Set<string>()
  for (const [position, chunk] of index.chunks.entries()) {
    const expectedId = `C${String(position + 1).padStart(4, '0')}`
    if (chunk.chunk_id !== expectedId || chunk.chunk_ref !== `W:${index.source_id}:${expectedId}`) {
      context.addIssue({ code: 'custom', path: ['chunks', position, 'chunk_ref'], message: 'Chunk identity must match its stable source order' })
    }
    if (refs.has(chunk.chunk_ref)) context.addIssue({ code: 'custom', path: ['chunks', position, 'chunk_ref'], message: 'Chunk reference must be unique' })
    refs.add(chunk.chunk_ref)
  }
})

/** One complete Web snapshot's deterministic Markdown index. */
export type WebEvidenceChunkIndex = z.infer<typeof indexSchema>
/** One indexed Web Markdown chunk. */
export type WebEvidenceChunk = z.infer<typeof chunkSchema>

type MarkdownNode = ReturnType<typeof fromMarkdown>['children'][number]
type HeadingNode = Extract<MarkdownNode, { type: 'heading' }>

function headingText(node: HeadingNode | HeadingNode['children'][number]): string {
  if ('value' in node) return node.value
  return 'children' in node ? node.children.map(headingText).join('') : ''
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

/**
 * Build stable Web chunks from complete top-level Markdown blocks.
 * @param source durable source identity for the snapshot.
 * @param content exact Markdown snapshot text.
 * @returns an index whose offsets and hashes resolve directly into `content`.
 */
export function buildWebEvidenceChunkIndex(source: WebEvidenceSource, content: string): WebEvidenceChunkIndex {
  if (content.trim().length === 0 || webEvidenceContentSha256(content) !== source.content_sha256) {
    throw new Error(`WEB_EVIDENCE_SNAPSHOT_INVALID:${source.source_id}`)
  }
  const nodes = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children
  const headings: WebEvidenceChunkIndex['headings'] = []
  const stack: Array<{ level: number; title: string }> = []
  const blocks: Array<{ start: number; end: number; heading_path: string[] }> = []
  let cursor = 0
  let activePath: string[] = []
  for (const node of nodes) {
    const position = node.position
    if (position === undefined) throw new Error('WEB_EVIDENCE_CHUNK_POSITION_MISSING')
    const start = position.start.offset
    const end = position.end.offset
    if (start === undefined || end === undefined) throw new Error('WEB_EVIDENCE_CHUNK_POSITION_MISSING')
    if (node.type === 'heading') {
      while ((stack.at(-1)?.level ?? 0) >= node.depth) stack.pop()
      const title = headingText(node).trim()
      stack.push({ level: node.depth, title })
      activePath = stack.map(item => item.title)
      headings.push({ level: node.depth, title, heading_path: [...activePath], line: position.start.line })
    }
    blocks.push({ start: cursor, end, heading_path: [...activePath] })
    cursor = end
  }
  if (blocks.length === 0) blocks.push({ start: 0, end: content.length, heading_path: [] })
  else if (cursor < content.length) blocks[blocks.length - 1]!.end = content.length

  const groups: typeof blocks[] = []
  let group: typeof blocks = []
  for (const block of blocks) {
    const size = group.reduce((total, item) => total + item.end - item.start, 0)
    if (group.length > 0 && (block.heading_path.join('\0') !== group[0]!.heading_path.join('\0')
      || size + block.end - block.start > WEB_EVIDENCE_CHUNK_TARGET_CHARS)) {
      groups.push(group)
      group = []
    }
    group.push(block)
  }
  if (group.length > 0) groups.push(group)

  const chunks = groups.map<WebEvidenceChunk>((items, position) => {
    const start = items[0]!.start
    const end = items.at(-1)!.end
    const body = content.slice(start, end)
    const chunkId = `C${String(position + 1).padStart(4, '0')}`
    return {
      chunk_id: chunkId,
      chunk_ref: `W:${source.source_id}:${chunkId}`,
      heading_path: items[0]!.heading_path,
      start_line: lineAt(content, start),
      end_line: lineAt(content, Math.max(start, end - 1)),
      start_offset: start,
      end_offset: end,
      content_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      preview: body.trim().slice(0, 300),
      char_count: body.length,
    }
  })
  const fallbackTitle = new URL(source.final_url).hostname
  return parseWebEvidenceChunkIndex({
    schema_version: WEB_EVIDENCE_CHUNK_INDEX_SCHEMA_VERSION,
    source_id: source.source_id,
    snapshot_path: source.snapshot_path,
    snapshot_sha256: source.content_sha256,
    title: headings.find(heading => heading.level === 1)?.title ?? headings[0]?.title ?? fallbackTitle,
    headings,
    chunks,
  })
}

/**
 * 按当前严格 schema 解析一个已持久化的 Web Chunk 索引。
 * @param value 待解析值。
 * @returns 已验证的索引。
 */
export function parseWebEvidenceChunkIndex(value: unknown): WebEvidenceChunkIndex {
  return indexSchema.parse(value)
}

/**
 * 返回一个 Web Source 所属的确定性索引路径。
 * @param sourceId Web Source 身份。
 * @returns 相对项目根目录的索引路径。
 */
export function webEvidenceChunkIndexPath(sourceId: string): string {
  return `analysis/web-sources/${sourceId}.chunks.json`
}

/**
 * 从有效 Web Chunk 引用提取所属 Source 身份。
 * @param ref Web Chunk 引用。
 * @returns 所属 Source 身份；格式无效时为 undefined。
 */
export function webEvidenceChunkSourceId(ref: string): string | undefined {
  if (!chunkRefSchema.safeParse(ref).success) return undefined
  return ref.slice(2, ref.lastIndexOf(':'))
}

/**
 * 验证索引是否与 Snapshot 重新生成的确定性结果完全一致。
 * @param index 待验证索引。
 * @param source 已认证的 Web Source 元数据。
 * @param content Snapshot 原文。
 * @returns 一致时为 true。
 */
export function webEvidenceChunkIndexMatches(index: WebEvidenceChunkIndex, source: WebEvidenceSource, content: string): boolean {
  if (index.source_id !== source.source_id || index.snapshot_path !== source.snapshot_path
    || index.snapshot_sha256 !== source.content_sha256 || webEvidenceContentSha256(content) !== source.content_sha256) return false
  return JSON.stringify(index) === JSON.stringify(buildWebEvidenceChunkIndex(source, content))
}
