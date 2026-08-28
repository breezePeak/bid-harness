/**
 * Workspace-local import, parsing, manifest, and DOCX-export primitives for
 * the bid profile.  The caller supplies the selected workspace and session;
 * this module never stores an ambient current workspace or emits file bytes to
 * a model request.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Document, Footer, Header, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, AlignmentType } from 'docx'
import mammoth from 'mammoth'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'mdast-util-gfm'
import * as XLSX from 'xlsx'

export type ParseStatus = 'pending' | 'success' | 'failed' | 'unsupported'
export type BidFileId = string & { readonly __bidFileId: unique symbol }

/** Deployment-owned import limits. */
export interface BidConfig {
  allowedExtensions: readonly string[]
  maxFileBytes: number
  maxFiles: number
  maxTotalBytes: number
  sessionDirectory: string
  outputDirectory: string
  enableDocxExport: boolean
  font: string
  bodySize: number
  headingSize: number
}

/** Conservative defaults matching the documented MVP limits. */
export const DEFAULT_BID_CONFIG: BidConfig = {
  allowedExtensions: ['.pdf', '.docx', '.xlsx', '.xls', '.txt', '.md'],
  maxFileBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  maxTotalBytes: 200 * 1024 * 1024,
  sessionDirectory: '.bid-harness/sessions',
  outputDirectory: 'output',
  enableDocxExport: true,
  font: 'Microsoft YaHei',
  bodySize: 22,
  headingSize: 32,
}

export interface ManifestFile {
  id: BidFileId
  originalName: string
  inputPath: string
  parsedPath: string | null
  mediaType: string
  size: number
  sha256: string
  parseStatus: ParseStatus
  parseError: string | null
}

export interface BidManifest { version: 1; files: ManifestFile[] }
export interface IncomingFile { name: string; type?: string; bytes: Uint8Array }
export interface ImportedFile extends ManifestFile { absoluteInputPath: string; absoluteParsedPath: string | null }

const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain', '.md': 'text/markdown',
}

/** Reject file names and relative paths that could escape a bid session directory. */
export function safeFileName(name: string): string {
  const trimmed = name.normalize('NFC').trim()
  if (trimmed.length === 0 || /[\\/:\x00-\x1f<>"|?*]/u.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('bid-invalid-file-name')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(trimmed)) throw new Error('bid-reserved-file-name')
  return trimmed
}

/** Resolve a user-visible relative path only when it remains inside root. */
export function within(root: string, candidate: string): string {
  if (isAbsolute(candidate) || /^[a-z]:/iu.test(candidate) || /^\\\\/u.test(candidate)) throw new Error('bid-absolute-path')
  const target = resolve(root, candidate)
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('bid-path-traversal')
  return target
}

function validateConfig(config: BidConfig): void {
  if (!config.sessionDirectory || !config.outputDirectory || config.maxFileBytes <= 0
    || config.maxFiles <= 0 || config.maxTotalBytes <= 0) {
    throw new Error('bid-invalid-config')
  }
}

async function atomicBytes(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function uniqueName(name: string, used: Set<string>): string {
  const extension = extname(name)
  const stem = basename(name, extension)
  let candidate = name
  let ordinal = 2
  while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${stem} (${ordinal++})${extension}`
  used.add(candidate.toLocaleLowerCase('en-US'))
  return candidate
}

/** Deterministic extraction for every supported document kind. */
export async function parseBidDocument(name: string, bytes: Uint8Array): Promise<string> {
  const extension = extname(name).toLocaleLowerCase('en-US')
  if (extension === '.txt' || extension === '.md') return decodeText(bytes)
  if (extension === '.docx') return parseDocx(bytes)
  if (extension === '.xlsx' || extension === '.xls') return parseWorkbook(bytes)
  if (extension === '.pdf') return parsePdf(name, bytes)
  throw new Error('bid-unsupported-file-type')
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.replace(/^\uFEFF/u, '')
}

async function parseDocx(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.convertToMarkdown({ buffer: Buffer.from(bytes) })
  return result.value
}

function parseWorkbook(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellText: true })
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, { header: 1, defval: '' })
      .filter(row => row.some(value => String(value).trim().length > 0))
    const table = rows.map(row => `| ${row.map(value => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')).join(' | ')} |`).join('\n')
    const divider = rows.length > 0 ? `\n| ${rows[0].map(() => '---').join(' | ')} |` : ''
    return `## 工作表：${name}\n\n${table.slice(0, table.indexOf('\n') >= 0 ? table.indexOf('\n') : table.length)}${divider}${table.includes('\n') ? table.slice(table.indexOf('\n')) : ''}`
  }).join('\n\n')
}

async function parsePdf(name: string, bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await pdfjs.getDocument({ data: bytes }).promise
  const pages: string[] = []
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index)
    const content = await page.getTextContent()
    const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').trim()
    pages.push(`<!-- source: ${name} page: ${index} -->\n\n${text}`)
  }
  if (pages.every(page => page.replace(/<!--[^]*?-->/u, '').trim().length === 0)) throw new Error('bid-pdf-no-extractable-text-ocr-unsupported')
  return pages.join('\n\n')
}

/** Session-isolated workspace importer. */
export class BidWorkspace {
  readonly root: string
  readonly sessionRoot: string
  readonly inputRoot: string
  readonly parsedRoot: string
  readonly outputRoot: string
  readonly manifestPath: string

  constructor(workspaceRoot: string, sessionId: string, readonly config: BidConfig = DEFAULT_BID_CONFIG) {
    validateConfig(config)
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(sessionId)) throw new Error('bid-invalid-session-id')
    this.root = resolve(workspaceRoot)
    this.sessionRoot = within(this.root, `${config.sessionDirectory}/${sessionId}`)
    this.inputRoot = resolve(this.sessionRoot, 'input')
    this.parsedRoot = resolve(this.sessionRoot, 'parsed')
    this.outputRoot = resolve(this.sessionRoot, config.outputDirectory)
    this.manifestPath = resolve(this.sessionRoot, 'manifest.json')
  }

  /** Import, parse independently, and atomically publish this batch's manifest. */
  async import(files: readonly IncomingFile[]): Promise<ImportedFile[]> {
    if (files.length === 0 || files.length > this.config.maxFiles) throw new Error('bid-file-count-limit')
    const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
    if (total > this.config.maxTotalBytes) throw new Error('bid-total-size-limit')
    const manifest = await this.readManifest()
    const used = new Set(manifest.files.map(file => basename(file.inputPath).toLocaleLowerCase('en-US')))
    const imported: ImportedFile[] = []
    for (const file of files) {
      const originalName = safeFileName(file.name)
      const extension = extname(originalName).toLocaleLowerCase('en-US')
      if (!this.config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
      if (file.bytes.byteLength === 0) throw new Error('bid-empty-file')
      if (file.bytes.byteLength > this.config.maxFileBytes) throw new Error('bid-file-size-limit')
      const storedName = uniqueName(originalName, used)
      const inputPath = `input/${storedName}`
      const input = within(this.sessionRoot, inputPath)
      await atomicBytes(input, file.bytes)
      const hash = createHash('sha256').update(file.bytes).digest('hex')
      const record: ManifestFile = { id: hash as BidFileId, originalName, inputPath, parsedPath: null,
        mediaType: MEDIA_TYPES[extension] ?? file.type ?? 'application/octet-stream', size: file.bytes.byteLength, sha256: hash, parseStatus: 'pending', parseError: null }
      try {
        const parsedPath = `parsed/${storedName.replace(/\.[^.]+$/u, '')}.md`
        await atomicBytes(within(this.sessionRoot, parsedPath), new TextEncoder().encode(await parseBidDocument(storedName, file.bytes)))
        record.parsedPath = parsedPath
        record.parseStatus = 'success'
      } catch (error) {
        record.parseStatus = 'failed'
        record.parseError = error instanceof Error ? error.message : String(error)
      }
      manifest.files.push(record)
      const absoluteParsedPath = record.parsedPath === null ? null : within(this.sessionRoot, record.parsedPath)
      imported.push({ ...record, absoluteInputPath: input, absoluteParsedPath })
    }
    await atomicBytes(this.manifestPath, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`))
    return imported
  }

  /** Read the durable manifest, treating a missing session as empty. */
  async readManifest(): Promise<BidManifest> {
    try { return JSON.parse(await readFile(this.manifestPath, 'utf8')) as BidManifest } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, files: [] }
      throw error
    }
  }

  /** Render the persisted, model-visible file inventory for a user message. */
  async messageInventory(request: string): Promise<string> {
    const manifest = await this.readManifest()
    const files = manifest.files.map((file, index) => {
      const parsed = file.parsedPath === null ? '无' : this.relative(file.parsedPath)
      const status = file.parseStatus === 'success' ? '成功' : `失败：${file.parseError ?? '未知错误'}`
      return `${index + 1}. ${file.originalName}\n   原始文件：${this.relative(file.inputPath)}\n   解析文本：${parsed}\n   解析状态：${status}`
    }).join('\n\n')
    return `用户已上传以下项目文件：\n\n${files}\n\n用户要求：\n${request}`
  }

  /** Export a session-local Markdown file to the output directory only. */
  async exportDocx(source: string, destination = `${this.config.outputDirectory}/技术标.docx`): Promise<string> {
    if (!this.config.enableDocxExport) throw new Error('bid-docx-export-disabled')
    const sourcePath = within(this.sessionRoot, source)
    if (!source.endsWith('.md')) throw new Error('bid-source-must-be-markdown')
    const destinationPath = within(this.sessionRoot, destination)
    if (!destinationPath.startsWith(`${this.outputRoot}${sep}`)) throw new Error('bid-output-path-required')
    const markdown = await readFile(sourcePath, 'utf8')
    const body = markdownToDocx(markdown, this.config)
    const document = new Document({ sections: [{ headers: { default: new Header({ children: [new Paragraph('技术标') ] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')],
      })] }) }, children: body }] })
    await atomicBytes(destinationPath, await Packer.toBuffer(document))
    return this.relative(destination)
  }

  private relative(path: string): string { return `${this.config.sessionDirectory}/${basename(this.sessionRoot)}/${path.replaceAll('\\', '/')}` }
}

function markdownToDocx(markdown: string, config: BidConfig): (Paragraph | Table)[] {
  const root = fromMarkdown(markdown, { extensions: [gfm()] })
  const blocks: (Paragraph | Table)[] = []
  for (const node of root.children) {
    if (node.type === 'heading') blocks.push(new Paragraph({ heading: node.depth === 1 ? 'Heading1' : node.depth === 2 ? 'Heading2' : 'Heading3', children: [new TextRun({ text: textOf(node), font: config.font, size: config.headingSize })] }))
    else if (node.type === 'paragraph') blocks.push(new Paragraph({ spacing: { after: 160, line: 360 }, children: [new TextRun({ text: textOf(node), font: config.font, size: config.bodySize })] }))
    else if (node.type === 'list') for (const item of node.children) blocks.push(new Paragraph({ bullet: node.ordered ? undefined : { level: 0 }, numbering: node.ordered ? { reference: 'default-numbering', level: 0 } : undefined, children: [new TextRun({ text: textOf(item), font: config.font, size: config.bodySize })] }))
    else if (node.type === 'table') blocks.push(new Table({ rows: node.children.map(row => new TableRow({ children: row.children.map(cell => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(cell), font: config.font, size: config.bodySize })] })] })) })) }))
  }
  return blocks.length > 0 ? blocks : [new Paragraph('')]
}

function textOf(node: { children?: unknown[]; value?: string }): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(child => textOf(child as { children?: unknown[]; value?: string })).join('')
}

export default BidWorkspace
