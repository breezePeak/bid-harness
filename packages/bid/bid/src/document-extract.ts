/**
 * Deterministic conversion of one local office document into Markdown and a
 * compact structural index.  This module deliberately does not search,
 * chunk, upload, or interpret bid content.
 */

import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import mammoth from 'mammoth'

const execFileAsync = promisify(execFile)

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

/** Convert a PDF, DOCX, or DOC at `sourcePath` into three UTF-8 corpus files. */
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
  try {
    const parsed = await parseDocument(sourcePath, fileType)
    const status: DocumentParseStatus = parsed.needsOcr ? 'needs_ocr' : 'success'
    const metadata: DocumentMetadata = {
      schema_version: 1, source_file: sourceFile, source_path: sourcePath, file_type: fileType,
      page_count: parsed.pageCount, parse_status: status, needs_ocr: parsed.needsOcr,
      parser: parsed.parser, parser_version: parsed.parserVersion,
    }
    await mkdir(outputDir, { recursive: true })
    const documentPath = resolve(outputDir, 'document.md')
    const structurePath = resolve(outputDir, 'structure.json')
    const metadataPath = resolve(outputDir, 'metadata.json')
    await Promise.all([
      atomicWrite(documentPath, parsed.markdown),
      atomicWrite(structurePath, `${JSON.stringify({ sections: sectionsFromMarkdown(parsed.markdown) }, null, 2)}\n`),
      atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
    ])
    return {
      sourceFile, sourcePath, documentPath, structurePath, metadataPath, fileType,
      pageCount: parsed.pageCount, parseStatus: status, needsOcr: parsed.needsOcr,
    }
  } catch (error) {
    const code = fileType === 'pdf' ? 'PDF_PARSE_FAILED' : fileType === 'docx' ? 'DOCX_PARSE_FAILED' : error instanceof DocumentExtractError ? error.code : 'DOC_PARSE_FAILED'
    return failure(sourceFile, sourcePath, fileType, 'failed', code, error instanceof Error ? error.message : 'The document could not be parsed.')
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
  const pdf = await pdfjs.getDocument({ data: bytes }).promise
  const pages: string[] = []
  let characters = 0
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/gu, ' ').trim()
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
  try {
    await access(sourcePath)
    const result = await execFileAsync('antiword', ['-m', 'UTF-8.txt', sourcePath], { encoding: 'utf8', windowsHide: true })
    return { markdown: `${plainTextToMarkdown(result.stdout).trim()}\n`, pageCount: null, needsOcr: false, parser: 'antiword', parserVersion: null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentExtractError('DOC_CONVERTER_NOT_AVAILABLE', 'DOC extraction requires antiword on PATH.')
    throw error
  }
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
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(row => row.length))
  const render = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
  const [header, ...body] = rows
  return `\n\n${render(header ?? [])}\n| ${Array.from({ length: width }, () => '---').join(' | ')} |${body.map(row => `\n${render(row)}`).join('')}\n\n`
}

function stripHtml(value: string): string {
  return value.replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, '').replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').trim()
}

function plainTextToMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n')
}

function escapeCell(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', '<br>') }

function sectionsFromMarkdown(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  const stack: DocumentSection[] = []
  let page: number | null = null
  for (const line of markdown.split('\n')) {
    const pageMatch = /^<!-- page: (\d+) -->$/u.exec(line.trim())
    if (pageMatch) { page = Number(pageMatch[1]); continue }
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line)
    if (!heading) continue
    const [, markers, title] = heading
    const level = markers?.length ?? 0
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop()
    const parent = stack.at(-1) ?? null
    const sectionTitle = title ?? ''
    const section: DocumentSection = { id: `section_${String(sections.length + 1).padStart(3, '0')}`, parent_id: parent?.id ?? null, level, title: sectionTitle, page_start: page, page_end: page, heading_path: [...stack.map(item => item.title), sectionTitle], order: sections.length + 1 }
    sections.push(section)
    stack.push(section)
  }
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index]
    if (section === undefined) continue
    const descendant = sections.slice(index + 1).find(candidate => candidate.level > section.level && candidate.page_end !== null)
    if (section.page_end === null && descendant) section.page_end = descendant.page_end
  }
  return sections
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
}

function failure(sourceFile: string, sourcePath: string, fileType: ExtractDocumentResult['fileType'], parseStatus: DocumentParseStatus, code: string, message: string): ExtractDocumentResult {
  return { sourceFile, sourcePath, fileType, pageCount: null, parseStatus, needsOcr: false, error: { code, message } }
}

class DocumentExtractError extends Error { constructor(readonly code: string, message: string) { super(message) } }
