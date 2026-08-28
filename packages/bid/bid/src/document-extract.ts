/**
 * Deterministic conversion of one local office document into Markdown and a
 * compact structural index.  This module deliberately does not search,
 * chunk, upload, or interpret bid content.
 */

import { lstat, mkdir, readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'

/** Accepted source and destination paths for one extraction. */
export interface ExtractDocumentInput {
  sourcePath: string
  outputDir: string
}

/** Extraction outcome written to `metadata.json` when an output exists. */
export type DocumentParseStatus = 'success' | 'needs_ocr' | 'unsupported_format' | 'failed'

/** A heading recovered from the converted Markdown. */
export interface DocumentSection {
  id: string
  parent_id: string | null
  level: number
  title: string
  page_start: number | null
  page_end: number | null
  heading_path: string[]
  order: number
}

/** Stable metadata describing an extraction result. */
export interface DocumentMetadata {
  schema_version: 1
  source_file: string
  source_path: string
  file_type: 'pdf' | 'docx' | 'doc'
  page_count: number | null
  parse_status: DocumentParseStatus
  needs_ocr: boolean
  parser: string
  parser_version: string | null
}

/** Paths and status returned by {@link extractDocument}. */
export interface ExtractDocumentResult {
  sourceFile: string
  sourcePath: string
  documentPath?: string
  structurePath?: string
  metadataPath?: string
  fileType: 'pdf' | 'docx' | 'doc' | null
  pageCount: number | null
  parseStatus: DocumentParseStatus
  needsOcr: boolean
  error?: { code: string; message: string }
}

interface ParsedDocument {
  markdown: string
  pageCount: number | null
  needsOcr: boolean
  parser: string
  parserVersion: string | null
}

/**
 * Convert a PDF, DOCX, or DOC into three UTF-8 corpus files without modifying the source.
 * @param input - Source file and destination corpus directory.
 * @returns Paths and status; recognized parse failures resolve as `failed` instead of rejecting.
 */
export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
  const sourcePath = resolve(input.sourcePath)
  const outputDir = resolve(input.outputDir)
  const sourceFile = basename(sourcePath)
  const extension = extname(sourceFile).toLowerCase()
  const fileType = extension === '.pdf' || extension === '.docx' || extension === '.doc' ? extension.slice(1) as 'pdf' | 'docx' | 'doc' : null
  if (fileType === null) return failure(sourceFile, sourcePath, null, 'unsupported_format', 'UNSUPPORTED_FORMAT', `Unsupported document format: ${extension || '(none)'}`)
  try {
    const info = await lstat(sourcePath)
    if (!info.isFile()) return failure(sourceFile, sourcePath, fileType, 'failed', 'SOURCE_NOT_FILE', 'The source path is not a regular file.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure(sourceFile, sourcePath, fileType, 'failed', 'FILE_NOT_FOUND', 'The source file does not exist.')
    return failure(sourceFile, sourcePath, fileType, 'failed', 'SOURCE_READ_FAILED', 'The source file could not be inspected.')
  }
  let parsed: ParsedDocument
  try {
    parsed = await parseDocument(sourcePath, fileType)
  } catch {
    const code = fileType === 'pdf' ? 'PDF_PARSE_FAILED' : fileType === 'docx' ? 'DOCX_PARSE_FAILED' : 'DOC_PARSE_FAILED'
    return failure(sourceFile, sourcePath, fileType, 'failed', code, `The ${fileType.toUpperCase()} source could not be parsed.`)
  }
  const status: DocumentParseStatus = parsed.needsOcr ? 'needs_ocr' : 'success'
  const metadata: DocumentMetadata = {
    schema_version: 1, source_file: sourceFile, source_path: sourcePath, file_type: fileType,
    page_count: parsed.pageCount, parse_status: status, needs_ocr: parsed.needsOcr,
    parser: parsed.parser, parser_version: parsed.parserVersion,
  }
  try {
    await mkdir(outputDir, { recursive: true })
    const documentPath = resolve(outputDir, 'document.md')
    const structurePath = resolve(outputDir, 'structure.json')
    const metadataPath = resolve(outputDir, 'metadata.json')
    await Promise.all([
      writeFileAtomic(documentPath, parsed.markdown, { mode: 0o600, dirMode: 0o700 }),
      writeFileAtomic(structurePath, `${JSON.stringify({ sections: sectionsFromMarkdown(parsed.markdown) }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
      writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
    ])
    return {
      sourceFile, sourcePath, documentPath, structurePath, metadataPath, fileType,
      pageCount: parsed.pageCount, parseStatus: status, needsOcr: parsed.needsOcr,
    }
  } catch {
    return failure(sourceFile, sourcePath, fileType, 'failed', 'OUTPUT_WRITE_FAILED', 'The extracted corpus could not be written.')
  }
}

async function parseDocument(sourcePath: string, fileType: 'pdf' | 'docx' | 'doc'): Promise<ParsedDocument> {
  if (fileType === 'pdf') return parsePdf(sourcePath)
  if (fileType === 'docx') return parseDocx(sourcePath)
  return parseDoc(sourcePath)
}

async function parsePdf(sourcePath: string): Promise<ParsedDocument> {
  const bytes = new Uint8Array(await readFile(sourcePath))
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const standardFontDataUrl = new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).href
  const pdf = await pdfjs.getDocument({ data: bytes, standardFontDataUrl }).promise
  const pages: string[] = []
  let characters = 0
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = pdfPageText(content.items)
    characters += text.length
    pages.push(`<!-- source: ${basename(sourcePath)} -->\n<!-- page: ${pageNumber} -->${text ? `\n\n${text}` : ''}`)
  }
  const needsOcr = pdf.numPages > 0 && characters < Math.max(20, pdf.numPages * 10)
  return { markdown: `${pages.join('\n\n')}\n`, pageCount: pdf.numPages, needsOcr, parser: 'pdfjs-dist', parserVersion: null }
}

async function parseDocx(sourcePath: string): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml({ path: sourcePath })
  return { markdown: `${htmlToMarkdown(result.value).trim()}\n`, pageCount: null, needsOcr: false, parser: 'mammoth', parserVersion: null }
}

async function parseDoc(sourcePath: string): Promise<ParsedDocument> {
  const extractor = new WordExtractor()
  const document = await extractor.extract(sourcePath)
  return { markdown: `${plainTextToMarkdown(document.getBody()).trim()}\n`, pageCount: null, needsOcr: false, parser: 'word-extractor', parserVersion: '1.0.4' }
}

interface PdfTextItem {
  str: string
  transform: readonly [number, number, number, number, number, number, ...number[]]
  width: number
  height: number
  hasEOL?: boolean
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as Partial<PdfTextItem>
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform)
    && candidate.transform.length >= 6 && typeof candidate.transform[4] === 'number' && typeof candidate.transform[5] === 'number'
    && typeof candidate.width === 'number' && typeof candidate.height === 'number'
}

/** @internal Convert PDF.js text items into physical lines. */
export function pdfPageText(items: readonly unknown[]): string {
  const lines: string[] = []
  let current = ''
  let baseline: number | null = null
  let endX: number | null = null
  let lineHeight = 0
  const flush = (): void => {
    const line = current.trimEnd()
    if (line.length > 0) lines.push(line)
    current = ''
    baseline = null
    endX = null
    lineHeight = 0
  }
  for (const item of items) {
    if (!isPdfTextItem(item) || item.str.length === 0) continue
    const x = item.transform[4]
    const y = item.transform[5]
    if (baseline !== null && Math.abs(y - baseline) > Math.max(2, lineHeight * 0.5, item.height * 0.5)) flush()
    if (baseline === null) baseline = y
    const gap = endX === null ? 0 : x - endX
    if (current.length > 0 && gap > Math.max(8, item.height)) current += '\t'
    else if (current.length > 0 && gap > Math.max(1, item.height * 0.15)) current += ' '
    current += item.str
    endX = x + item.width
    lineHeight = Math.max(lineHeight, item.height)
    if (item.hasEOL) flush()
  }
  flush()
  return lines.join('\n')
}

function htmlToMarkdown(html: string): string {
  let value = html.replace(/\r\n?/gu, '\n')
  value = value.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu, (_, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${stripHtml(body)}\n\n`)
  value = value.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/giu, (_, list: string) => listToMarkdown(list, true))
  value = value.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/giu, (_, list: string) => listToMarkdown(list, false))
  value = value.replace(/<table[^>]*>([\s\S]*?)<\/table>/giu, (_, table: string) => tableToMarkdown(table))
  value = value.replace(/<\/?(?:table|thead|tbody|tfoot|ul|ol)[^>]*>/giu, '\n')
  value = value.replace(/<p[^>]*>([\s\S]*?)<\/p>/giu, (_, body: string) => `\n\n${stripHtml(body)}\n\n`)
  return stripHtml(value).replace(/\n{3,}/gu, '\n\n')
}

function listToMarkdown(list: string, ordered: boolean): string {
  const items = [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/giu)].map(([, item]) => stripHtml(item ?? ''))
  return items.map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${item}`).join('\n')
}

function tableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)].map(([, row]) =>
    [...(row ?? '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/giu)].map(([, cell]) => escapeCell(stripHtml(cell ?? ''))),
  ).filter(row => row.length > 0)
  /* v8 ignore next -- mammoth emits a table element only when the Word table has at least one row. */
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(row => row.length))
  const render = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
  const [header, ...body] = rows
  /* v8 ignore next -- rows.length is positive here, so destructuring always produces the header. */
  if (header === undefined) return ''
  return `\n\n${render(header)}\n| ${Array.from({ length: width }, () => '---').join(' | ')} |${body.map(row => `\n${render(row)}`).join('')}\n\n`
}

function stripHtml(value: string): string {
  return value.replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, '').replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').trim()
}

function plainTextToMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n')
}

function escapeCell(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', '<br>') }

/** @internal Build the heading index used by the corpus writer. */
export function sectionsFromMarkdown(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  const stack: DocumentSection[] = []
  let page: number | null = null
  for (const line of markdown.split('\n')) {
    const pageMatch = /^<!-- page: (\d+) -->$/u.exec(line.trim())
    if (pageMatch) {
      page = Number(pageMatch[1])
      continue
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line)
    if (!heading) {
      if (page !== null && line.trim().length > 0) for (const open of stack) open.page_end = page
      continue
    }
    const [, markers, title] = heading
    /* v8 ignore next -- both capture groups are mandatory in the heading expression. */
    if (markers === undefined || title === undefined) continue
    const level = markers.length
    while (stack.length > 0) {
      const open = stack.at(-1)
      /* v8 ignore next -- stack.length is positive, so the final entry exists. */
      if (open === undefined || open.level < level) break
      stack.pop()
    }
    if (page !== null) for (const open of stack) open.page_end = page
    const parent = stack.at(-1) ?? null
    const sectionTitle = title
    const section: DocumentSection = { id: `section_${String(sections.length + 1).padStart(3, '0')}`, parent_id: parent?.id ?? null, level, title: sectionTitle, page_start: page, page_end: page, heading_path: [...stack.map(item => item.title), sectionTitle], order: sections.length + 1 }
    sections.push(section)
    stack.push(section)
  }
  return sections
}

function failure(sourceFile: string, sourcePath: string, fileType: ExtractDocumentResult['fileType'], parseStatus: DocumentParseStatus, code: string, message: string): ExtractDocumentResult {
  return { sourceFile, sourcePath, fileType, pageCount: null, parseStatus, needsOcr: false, error: { code, message } }
}
