/**
 * Deterministic Markdown chunking for normalized bid-document corpora.
 * Chunk files preserve source text and expose stable source, page, heading,
 * and adjacency metadata for the existing grep and read tools.
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { z } from 'zod'

/** Character-based limits applied after structural Markdown boundaries. */
export interface DocumentChunkConfig {
  minChars: number
  targetChars: number
  maxChars: number
}

/** Default structural chunk sizes; `maxChars` yields to indivisible blocks. */
export const DEFAULT_DOCUMENT_CHUNK_CONFIG: DocumentChunkConfig = {
  minChars: 600,
  targetChars: 3000,
  maxChars: 6000,
}

/** Source corpus paths and optional chunk-size overrides. */
export interface ChunkDocumentInput {
  documentPath: string
  structurePath?: string | null
  metadataPath?: string | null
  outputDir: string
  config?: Partial<DocumentChunkConfig>
}

/** One entry in the deterministic chunk manifest. */
export interface DocumentChunkEntry {
  id: string
  path: string
  order: number
  heading_path: string[]
  page_start: number | null
  page_end: number | null
  source_line_start: number
  source_line_end: number
  char_count: number
  prev_chunk: string | null
  next_chunk: string | null
  oversized: boolean
}

/** Stable manifest written beside the generated Markdown chunks. */
export interface DocumentChunkIndex {
  schema_version: 1
  source_document: string
  chunk_count: number
  chunk_config: DocumentChunkConfig
  chunks: DocumentChunkEntry[]
}

const documentChunkConfigSchema = z.object({
  minChars: z.number().int().positive(),
  targetChars: z.number().int().positive(),
  maxChars: z.number().int().positive(),
}).strict().refine(
  config => config.minChars <= config.targetChars && config.targetChars <= config.maxChars,
  { message: 'chunk limits must be ordered' },
)

const nullablePageSchema = z.number().int().positive().nullable()

const documentChunkEntrySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  order: z.number().int().positive(),
  heading_path: z.array(z.string()),
  page_start: nullablePageSchema,
  page_end: nullablePageSchema,
  source_line_start: z.number().int().positive(),
  source_line_end: z.number().int().positive(),
  char_count: z.number().int().nonnegative(),
  prev_chunk: z.string().min(1).nullable(),
  next_chunk: z.string().min(1).nullable(),
  oversized: z.boolean(),
}).strict().refine(
  entry => entry.source_line_start <= entry.source_line_end
    && (entry.page_start === null || entry.page_end === null || entry.page_start <= entry.page_end),
  { message: 'chunk ranges must be ordered' },
)

const documentChunkIndexSchema = z.object({
  schema_version: z.literal(1),
  source_document: z.string().min(1),
  chunk_count: z.number().int().nonnegative(),
  chunk_config: documentChunkConfigSchema,
  chunks: z.array(documentChunkEntrySchema),
}).strict().refine(
  index => index.chunk_count === index.chunks.length
    && index.chunks.every((entry, offset) => entry.order === offset + 1),
  { message: 'chunk count and order must match the entries' },
)

/**
 * Parse one durable chunk index through the canonical runtime validation.
 * @param value - untrusted JSON-compatible value read from `index.json`.
 * @returns a validated chunk index.
 * @throws `document-chunk-invalid-index` when any required field or invariant is invalid.
 */
export function parseDocumentChunkIndex(value: unknown): DocumentChunkIndex {
  const parsed = documentChunkIndexSchema.safeParse(value)
  if (!parsed.success) throw new Error('document-chunk-invalid-index')
  return parsed.data
}

/** Paths and manifest returned after atomically replacing a chunk directory. */
export interface ChunkDocumentResult {
  outputDir: string
  indexPath: string
  chunkCount: number
  index: DocumentChunkIndex
}

interface Position { start: { line: number; offset?: number }; end: { line: number; offset?: number } }
interface MarkdownNode { type: string; depth?: number; value?: string; children?: MarkdownNode[]; position?: Position }
interface PositionedMarkdownNode extends MarkdownNode { position: Position }
interface StructureSection { level: number; title: string; heading_path: string[]; page_start: number | null; page_end: number | null }
interface SourceBlock {
  type: string
  raw: string
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  headingDepth: number | null
  headingTitle: string | null
  headingPath: string[] | null
  pageStart: number | null
  pageEnd: number | null
}
interface PendingChunk { blocks: SourceBlock[]; headingPath: string[] }

/**
 * Split one normalized `document.md` and atomically replace its chunk directory.
 * Missing optional structure and metadata files are ignored; malformed files reject.
 * @param input - Corpus input paths, output directory, and optional size overrides.
 * @returns Stable chunk paths and the written manifest.
 */
export async function chunkDocument(input: ChunkDocumentInput): Promise<ChunkDocumentResult> {
  const documentPath = resolve(input.documentPath)
  const outputDir = resolve(input.outputDir)
  const outputRelativeDocument = relative(outputDir, documentPath)
  if (outputRelativeDocument === '' || (!outputRelativeDocument.startsWith(`..${sep}`)
    && outputRelativeDocument !== '..' && !isAbsolute(outputRelativeDocument))) {
    throw new Error('document-chunk-output-conflict')
  }
  const config = resolveConfig(input.config)
  const markdown = await readFile(documentPath, 'utf8')
  const sections = await readOptionalStructure(input.structurePath)
  const sourceFile = await readOptionalSourceFile(input.metadataPath) ?? basename(dirname(documentPath))
  const blocks = sourceBlocks(markdown, sections)
  const pending = groupBlocks(blocks, config)
  const sourceDocument = outputRelativeDocument.replaceAll('\\', '/')
  const entries = pending.map((chunk, index): DocumentChunkEntry => {
    const id = `chunk_${String(index + 1).padStart(4, '0')}`
    const previous = index === 0 ? null : `chunk_${String(index).padStart(4, '0')}.md`
    const next = index === pending.length - 1 ? null : `chunk_${String(index + 2).padStart(4, '0')}.md`
    const first = chunk.blocks[0]
    const last = chunk.blocks.at(-1)
    /* v8 ignore next -- groupBlocks never emits an empty chunk. */
    if (first === undefined || last === undefined) throw new Error('document-chunk-empty-group')
    const charCount = chunk.blocks.reduce((sum, block) => sum + block.raw.length, 0)
    const pages = chunk.blocks.flatMap(block => [block.pageStart, block.pageEnd]).filter((page): page is number => page !== null)
    return {
      id, path: `${id}.md`, order: index + 1, heading_path: chunk.headingPath,
      page_start: pages[0] ?? null, page_end: pages.at(-1) ?? null,
      source_line_start: first.startLine, source_line_end: last.endLine,
      char_count: charCount, prev_chunk: previous, next_chunk: next,
      oversized: charCount > config.maxChars,
    }
  })
  const index: DocumentChunkIndex = {
    schema_version: 1, source_document: sourceDocument, chunk_count: entries.length,
    chunk_config: config, chunks: entries,
  }
  await publishChunks(outputDir, pending, entries, index, sourceFile)
  return { outputDir, indexPath: resolve(outputDir, 'index.json'), chunkCount: entries.length, index }
}

function resolveConfig(patch: Partial<DocumentChunkConfig> | undefined): DocumentChunkConfig {
  const config = { ...DEFAULT_DOCUMENT_CHUNK_CONFIG, ...patch }
  if (!Number.isInteger(config.minChars) || !Number.isInteger(config.targetChars) || !Number.isInteger(config.maxChars)
    || config.minChars <= 0 || config.minChars > config.targetChars || config.targetChars > config.maxChars) {
    throw new Error('document-chunk-invalid-config')
  }
  return config
}

async function readOptionalStructure(path: string | null | undefined): Promise<StructureSection[]> {
  if (path === null || path === undefined) return []
  try {
    const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as { sections?: unknown }
    if (!Array.isArray(parsed.sections)) throw new Error('document-chunk-invalid-structure')
    return parsed.sections.map((section) => {
      if (typeof section !== 'object' || section === null) throw new Error('document-chunk-invalid-structure')
      const value = section as Partial<StructureSection>
      if (typeof value.level !== 'number' || !Number.isInteger(value.level)
        || typeof value.title !== 'string' || !Array.isArray(value.heading_path)
        || !value.heading_path.every(item => typeof item === 'string')) throw new Error('document-chunk-invalid-structure')
      return { level: value.level, title: value.title, heading_path: value.heading_path,
        page_start: typeof value.page_start === 'number' ? value.page_start : null,
        page_end: typeof value.page_end === 'number' ? value.page_end : null }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readOptionalSourceFile(path: string | null | undefined): Promise<string | null> {
  if (path === null || path === undefined) return null
  try {
    const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as { source_file?: unknown }
    if (typeof parsed.source_file !== 'string') throw new Error('document-chunk-invalid-metadata')
    return parsed.source_file
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sourceBlocks(markdown: string, sections: readonly StructureSection[]): SourceBlock[] {
  if (markdown.trim().length === 0) return []
  const lineStarts = markdownLineStarts(markdown)
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode
  const nodes = (root.children ?? []) as PositionedMarkdownNode[]
  const blocks: SourceBlock[] = []
  let cursor = 0
  let page: number | null = null
  let sectionIndex = 0
  for (const node of nodes) {
    const endOffset = node.position.end.offset
    /* v8 ignore next -- fromMarkdown supplies offsets for every parsed source node. */
    if (endOffset === undefined) throw new Error('document-chunk-missing-position')
    const raw = markdown.slice(cursor, endOffset)
    const pageMatch = node.type === 'html' ? /^<!--\s*page:\s*(\d+)\s*-->$/u.exec(node.value?.trim() ?? '') : null
    if (pageMatch?.[1] !== undefined) page = Number(pageMatch[1])
    const title = node.type === 'heading' ? textOf(node).trim() : null
    const depth = node.type === 'heading' && node.depth !== undefined ? node.depth : null
    const section = title === null || depth === null ? null : matchingSection(sections, sectionIndex, depth, title)
    if (section !== null) sectionIndex = section.index + 1
    blocks.push({ type: pageMatch === null ? node.type : 'page', raw, startOffset: cursor, endOffset,
      startLine: lineAt(lineStarts, cursor), endLine: lineAt(lineStarts, Math.max(cursor, endOffset - 1)),
      headingDepth: depth, headingTitle: title, headingPath: section?.section.heading_path ?? null,
      pageStart: section?.section.page_start ?? page, pageEnd: section?.section.page_start ?? page })
    cursor = endOffset
  }
  if (cursor < markdown.length) {
    const last = blocks.at(-1)
    /* v8 ignore next -- nodes.length is positive, so blocks contains an entry. */
    if (last === undefined) throw new Error('document-chunk-missing-final-block')
    last.raw += markdown.slice(cursor)
    last.endOffset = markdown.length
    last.endLine = lineAt(lineStarts, markdown.length)
  }
  return blocks
}

function matchingSection(
  sections: readonly StructureSection[], start: number, level: number, title: string,
): { section: StructureSection; index: number } | null {
  for (let index = start; index < sections.length; index++) {
    const section = sections[index]
    if (section?.level === level && section.title === title) return { section, index }
  }
  return null
}

function groupBlocks(blocks: readonly SourceBlock[], config: DocumentChunkConfig): PendingChunk[] {
  const chunks: PendingChunk[] = []
  const headingStack: { depth: number; title: string }[] = []
  let current: SourceBlock[] = []
  let currentPath: string[] = []
  let activeHeadingPath: string[] = []
  const length = (): number => current.reduce((sum, block) => sum + block.raw.length, 0)
  const hasBody = (): boolean => current.some(block => block.type !== 'heading' && block.type !== 'page' && block.type !== 'html' && block.raw.trim().length > 0)
  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ blocks: current, headingPath: currentPath })
    current = []
  }
  for (const original of blocks) {
    if (original.headingDepth !== null && original.headingTitle !== null) {
      if (hasBody()) flush()
      while ((headingStack.at(-1)?.depth ?? 0) >= original.headingDepth) headingStack.pop()
      headingStack.push({ depth: original.headingDepth, title: original.headingTitle })
      activeHeadingPath = original.headingPath ?? headingStack.map(item => item.title)
      currentPath = activeHeadingPath
      current.push(original)
      continue
    }
    const fragments = original.type === 'paragraph' && original.raw.length > config.maxChars
      ? splitParagraph(original, config.maxChars)
      : [original]
    for (const block of fragments) {
      const proposed = length() + block.raw.length
      const structuralTarget = current.length > 0 && length() >= config.minChars && proposed > config.targetChars
      const hardLimit = current.length > 0 && hasBody() && proposed > config.maxChars
      if (structuralTarget || hardLimit) flush()
      if (current.length === 0) currentPath = activeHeadingPath
      current.push(block)
    }
  }
  flush()
  if (chunks.length >= 2 && chunks.at(-1)?.blocks.every(block => block.type === 'heading' || block.type === 'page')) {
    const trailing = chunks.pop()
    const previous = chunks.at(-1)
    /* v8 ignore next -- length guard and pop guarantee both groups. */
    if (trailing === undefined || previous === undefined) throw new Error('document-chunk-invalid-tail')
    previous.blocks.push(...trailing.blocks)
  }
  return chunks
}

function splitParagraph(block: SourceBlock, maxChars: number): SourceBlock[] {
  const fragments: SourceBlock[] = []
  let cursor = 0
  while (block.raw.length - cursor > maxChars) {
    const limit = cursor + maxChars
    let end = block.raw.lastIndexOf('\n', limit)
    if (end <= cursor) end = lastSentenceBoundary(block.raw, cursor, limit)
    if (end <= cursor) end = limit
    else end += 1
    fragments.push(fragment(block, cursor, end))
    cursor = end
  }
  if (cursor < block.raw.length) fragments.push(fragment(block, cursor, block.raw.length))
  return fragments
}

function lastSentenceBoundary(value: string, start: number, limit: number): number {
  for (let index = limit - 1; index > start; index--) if (/[。！？；.!?;]/u.test(value[index] ?? '')) return index
  return -1
}

function fragment(block: SourceBlock, start: number, end: number): SourceBlock {
  const prefix = block.raw.slice(0, start)
  const raw = block.raw.slice(start, end)
  const startLine = block.startLine + countNewlines(prefix)
  return { ...block, raw, startOffset: block.startOffset + start, endOffset: block.startOffset + end,
    startLine, endLine: startLine + countNewlines(raw) }
}

function countNewlines(value: string): number { return value.split('\n').length - 1 }

function markdownLineStarts(markdown: string): number[] {
  const starts = [0]
  for (let index = 0; index < markdown.length; index++) if (markdown.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((starts[middle] ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  return Math.max(1, low)
}

function textOf(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textOf).join('')
}

async function publishChunks(
  outputDir: string, chunks: readonly PendingChunk[], entries: readonly DocumentChunkEntry[],
  index: DocumentChunkIndex, sourceFile: string,
): Promise<void> {
  const parent = dirname(outputDir)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const suffix = randomBytes(6).toString('hex')
  const staging = `${outputDir}.${suffix}.tmp`
  const backup = `${outputDir}.${suffix}.old`
  await mkdir(staging, { mode: 0o700 })
  try {
    await Promise.all(entries.map(async (entry, indexValue) => {
      const pending = chunks[indexValue]
      /* v8 ignore next -- entries and pending chunks are created from the same array. */
      if (pending === undefined) throw new Error('document-chunk-missing-content')
      const pages = entry.page_start === null ? 'none' : entry.page_start === entry.page_end ? String(entry.page_start) : `${entry.page_start}-${entry.page_end}`
      const heading = entry.heading_path.length === 0 ? 'none' : entry.heading_path.join(' > ')
      const body = pending.blocks.map(block => block.raw).join('')
      const metadata = `<!-- chunk_id: ${entry.id} -->\n<!-- source_file: ${sourceFile} -->\n<!-- source_document: ${index.source_document} -->\n<!-- pages: ${pages} -->\n<!-- heading_path: ${heading} -->\n<!-- prev_chunk: ${entry.prev_chunk ?? 'none'} -->\n<!-- next_chunk: ${entry.next_chunk ?? 'none'} -->`
      await writeFileAtomic(resolve(staging, entry.path), `${metadata}\n\n${body}`, { mode: 0o600, dirMode: 0o700 })
    }))
    await writeFileAtomic(resolve(staging, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    const exists = await pathExists(outputDir)
    if (exists) await rename(outputDir, backup)
    try {
      await rename(staging, outputDir)
    } catch (error) {
      if (exists) await rename(backup, outputDir)
      throw error
    }
    if (exists) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
