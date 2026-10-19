/** 普通附件和专业资料共用的文本抽取、表格展开与分块程序。 */
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { extractDocument } from './document-extract.ts'
import { chunkDocument, type DocumentChunkConfig } from './document-chunk.ts'
import { atomicBytes, assertNoLinkedPath, within } from './workspace-path.ts'

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.replace(/^\uFEFF/u, '')
}

function parseWorkbook(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellText: true })
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]
    /* v8 ignore next -- SheetNames and Sheets are populated together by XLSX.read. */
    if (sheet === undefined) throw new Error(`bid-workbook-missing-sheet:${name}`)
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, { header: 1, defval: '' })
      .filter(row => row.some(value => String(value).trim().length > 0))
    const table = rows.map(row => `| ${row.map(value => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')).join(' | ')} |`).join('\n')
    const [header] = rows
    const divider = header === undefined ? '' : `\n| ${header.map(() => '---').join(' | ')} |`
    return `## 工作表：${name}\n\n${table.slice(0, table.indexOf('\n') >= 0 ? table.indexOf('\n') : table.length)}${divider}${table.includes('\n') ? table.slice(table.indexOf('\n')) : ''}`
  }).join('\n\n')
}

function parseDeterministic(extension: string, bytes: Uint8Array): string {
  if (extension === '.txt' || extension === '.md') return decodeText(bytes)
  if (extension === '.xlsx' || extension === '.xls') return parseWorkbook(bytes)
  throw new Error('bid-unsupported-file-type')
}


/**
 * 解析已接入原件，在调用者选定的候选或缓存目录中生成语料。
 * @param root 拥有输入和输出的工作区。
 * @param input 原件绝对路径。
 * @param output 语料绝对目录。
 * @param config 经验证的分块配置。
 * @returns 原件保持不变的解析状态与语料路径。
 */
export async function parseBidFileContents(root: string, input: string, output: string, config: DocumentChunkConfig): Promise<{
  parseStatus: 'success' | 'needs_ocr'
  documentPath: string
  structurePath: string | null
  metadataPath: string | null
  chunksPath: string | null
  chunkIndexPath: string | null
}> {
  await assertNoLinkedPath(root, input)
  await assertNoLinkedPath(root, output)
  const extension = extname(input).toLowerCase()
  const documentPath = within(output, 'document.md')
  let structurePath: string | null = null
  let metadataPath: string | null = null
  let parseStatus: 'success' | 'needs_ocr' = 'success'
  if (extension === '.pdf' || extension === '.docx' || extension === '.doc') {
    const result = await extractDocument({ sourcePath: input, outputDir: output })
    if (result.parseStatus === 'failed' || result.parseStatus === 'unsupported_format') {
      throw new Error((result.error?.code ?? 'DOCUMENT_PARSE_FAILED') + ': ' + (result.error?.message ?? '文档解析失败'))
    }
    parseStatus = result.parseStatus
    structurePath = within(output, 'structure.json')
    metadataPath = within(output, 'metadata.json')
  } else await atomicBytes(root, documentPath, Buffer.from(parseDeterministic(extension, await readFile(input))))
  const chunksPath = parseStatus === 'success' ? within(output, 'chunks') : null
  if (chunksPath !== null) await chunkDocument({ documentPath, structurePath, metadataPath, outputDir: chunksPath, config })
  return { parseStatus, documentPath, structurePath, metadataPath, chunksPath,
    chunkIndexPath: chunksPath === null ? null : within(chunksPath, 'index.json') }
}
