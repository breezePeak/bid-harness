import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { Document, Packer, Paragraph } from 'docx'
import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, DEFAULT_BID_CONFIG, parseBidDocument, safeFileName, within } from '../src/index.ts'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const signal = new AbortController().signal

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('BidWorkspace', () => {
  it('keeps deterministic imports isolated and only exposes relative inventory paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'session_1')
    const file = (await bid.import([{ name: '公司资料.txt', type: 'text/plain', bytes: new TextEncoder().encode('企业资料') }]))[0]!
    expect(file.parseStatus).toBe('success')
    expect(await readFile(file.absoluteDocumentPath!, 'utf8')).toBe('企业资料')
    expect(file.chunksPath).toBe('corpus/公司资料.txt/chunks')
    expect(JSON.parse(await readFile(file.absoluteChunkIndexPath!, 'utf8'))).toMatchObject({ schema_version: 1, chunk_count: 1 })
    const inventory = await bid.messageInventory('编写技术标')
    expect(inventory).toContain('.bid-harness/sessions/session_1/input/公司资料.txt')
    expect(inventory).toContain('.bid-harness/sessions/session_1/corpus/公司资料.txt/document.md')
    expect(inventory).not.toContain(root)
  })

  it('imports DOC and DOCX through corpus manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'session_docs')
    const docx = new Document({ sections: [{ children: [new Paragraph({ text: '技术要求', heading: 'Heading1' }), new Paragraph('项目实施管理')] }] })
    const imported = await bid.import([
      { name: '历史投标书.doc', type: 'application/msword', bytes: await readFile(fixture('bid-document.doc')) },
      { name: '招标文件.docx', bytes: await Packer.toBuffer(docx) },
    ])

    expect(imported.map(file => file.parseStatus)).toEqual(['success', 'success'])
    for (const file of imported) {
      expect(file.documentPath).toBe(`corpus/${file.originalName}/document.md`)
      expect(file.structurePath).toBe(`corpus/${file.originalName}/structure.json`)
      expect(file.metadataPath).toBe(`corpus/${file.originalName}/metadata.json`)
      expect(file.chunksPath).toBe(`corpus/${file.originalName}/chunks`)
      expect(file.chunkIndexPath).toBe(`corpus/${file.originalName}/chunks/index.json`)
      await expect(readFile(file.absoluteDocumentPath!, 'utf8')).resolves.toContain('项目实施管理')
      await expect(readFile(file.absoluteStructurePath!, 'utf8')).resolves.toContain('sections')
      await expect(readFile(file.absoluteMetadataPath!, 'utf8')).resolves.toContain('parse_status')
    }
    const manifest = await bid.readManifest()
    expect(manifest.version).toBe(3)
    expect(manifest.files).toMatchObject([
      { originalName: '历史投标书.doc', mediaType: 'application/msword', documentPath: 'corpus/历史投标书.doc/document.md' },
      { originalName: '招标文件.docx', documentPath: 'corpus/招标文件.docx/document.md' },
    ])
  })

  it('makes imported PDF corpus searchable and readable through the DSH tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'session_search')
    const imported = (await bid.import([{ name: '招标文件.pdf', bytes: await readFile(fixture('bid-document.pdf')) }]))[0]!
    expect(imported.parseStatus).toBe('success')
    const modelChunksPath = `.bid-harness/sessions/session_search/${imported.chunksPath}`
    const chunkIndex = JSON.parse(await readFile(imported.absoluteChunkIndexPath!, 'utf8')) as { chunks: { path: string; prev_chunk: string | null }[] }
    const chunkContents = await Promise.all(chunkIndex.chunks.map(entry => readFile(join(imported.absoluteChunksPath!, entry.path), 'utf8')))
    const matchingIndex = chunkContents.findIndex((value, index) => value.includes('项目实施管理') && chunkIndex.chunks[index]!.prev_chunk !== null)
    expect(matchingIndex).toBeGreaterThanOrEqual(0)
    const modelChunkPath = `${modelChunksPath}/${chunkIndex.chunks[matchingIndex]!.path}`

    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      fibers.push(await ctx.plugin(LocalSubprocessRuntime))
      fibers.push(await ctx.plugin(LocalFileSystem, { cwd: root }))
      fibers.push(await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true }))
      fibers.push(await ctx.plugin(ToolFs))
      const agent = { session: { header: { id: 'session_search', cwd: root } } } as never
      const grep = await ctx.tools.execute({ signal, callId: CallId('bid-grep'), name: 'grep', arguments: { pattern: '项目实施管理', path: modelChunksPath }, agent })
      if (grep.isError) throw new Error(JSON.stringify({ error: grep.error, text: text(grep) }))
      expect(text(grep)).toContain(chunkIndex.chunks[matchingIndex]!.path)
      expect(text(grep)).toContain('项目实施管理')

      const read = await ctx.tools.execute({ signal, callId: CallId('bid-read'), name: 'read', arguments: { file_path: modelChunkPath }, agent })
      expect(read.isError).toBe(false)
      expect(text(read)).toContain('项目实施管理')
      expect(text(read)).toContain('<!-- pages: 2 -->')

      const previous = chunkIndex.chunks[matchingIndex]!.prev_chunk
      expect(previous).not.toBeNull()
      const previousRead = await ctx.tools.execute({ signal, callId: CallId('bid-read-previous'), name: 'read', arguments: { file_path: `${modelChunksPath}/${previous}` }, agent })
      expect(previousRead.isError).toBe(false)
      expect(text(previousRead)).toContain('<!-- next_chunk:')
      expect(text(previousRead)).toContain('本项目采用分阶段交付')
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('rejects traversal, reserved names, unsupported files, and empty files', async () => {
    expect(safeFileName('  e\u0301.txt  ')).toBe('é.txt')
    for (const name of ['', '.', '..', 'a/b.txt', 'a\\b.txt', 'a:b.txt']) expect(() => safeFileName(name)).toThrow('bid-invalid-file-name')
    expect(() => safeFileName('../x.pdf')).toThrow('bid-invalid-file-name')
    expect(() => safeFileName('CON.txt')).toThrow('bid-reserved-file-name')
    expect(() => within('C:\\workspace', 'C:\\secret')).toThrow('bid-absolute-path')
    expect(() => within('C:\\workspace', '\\\\server\\secret')).toThrow('bid-absolute-path')
    expect(() => within('C:\\workspace', '.')).toThrow('bid-path-traversal')
    expect(() => within('C:\\workspace', '../secret')).toThrow('bid-path-traversal')
    const bid = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-bid-')), 'session_2')
    await expect(bid.import([{ name: 'x.exe', bytes: new Uint8Array([1]) }])).rejects.toThrow('bid-unsupported-file-type')
    await expect(bid.import([{ name: 'x.txt', bytes: new Uint8Array() }])).rejects.toThrow('bid-empty-file')
  })

  it('validates workspace configuration and every import limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    expect(() => new BidWorkspace(root, 'bad session')).toThrow('bid-invalid-session-id')
    for (const patch of [
      { sessionDirectory: '' }, { outputDirectory: '' }, { maxFileBytes: 0 }, { maxFiles: 0 }, { maxTotalBytes: 0 },
      { documentChunk: { minChars: 10, targetChars: 5, maxChars: 20 } },
    ]) expect(() => new BidWorkspace(root, 'session', { ...DEFAULT_BID_CONFIG, ...patch })).toThrow('bid-invalid-config')

    const limited = new BidWorkspace(root, 'limited', { ...DEFAULT_BID_CONFIG, maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 })
    await expect(limited.import([])).rejects.toThrow('bid-file-count-limit')
    await expect(limited.import([
      { name: 'a.txt', bytes: new Uint8Array([1]) },
      { name: 'b.txt', bytes: new Uint8Array([1]) },
    ])).rejects.toThrow('bid-file-count-limit')
    await expect(limited.import([{ name: 'a.txt', bytes: new Uint8Array([1, 2]) }])).rejects.toThrow('bid-total-size-limit')
    const fileLimited = new BidWorkspace(root, 'file-limited', { ...DEFAULT_BID_CONFIG, maxFileBytes: 1 })
    await expect(fileLimited.import([{ name: 'a.txt', bytes: new Uint8Array([1, 2]) }])).rejects.toThrow('bid-file-size-limit')
  })

  it('imports text, Markdown, duplicate names, and workbook tables deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'deterministic')
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['项目|名称', '说明'], ['实施', '第一行\n第二行'], ['', ''],
    ]), '评分表')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), '空表')
    const workbook = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const imported = await bid.import([
      { name: '说明.txt', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('内容')]) },
      { name: '说明.txt', bytes: new TextEncoder().encode('第二份') },
      { name: '笔记.md', bytes: new TextEncoder().encode('# 标题') },
      { name: '评分.xlsx', bytes: workbook },
      { name: '旧表.xls', bytes: workbook },
    ])
    expect(imported.map(file => file.inputPath)).toEqual([
      'input/说明.txt', 'input/说明 (2).txt', 'input/笔记.md', 'input/评分.xlsx', 'input/旧表.xls',
    ])
    const repeated = await bid.import([{ name: '说明.txt', bytes: new TextEncoder().encode('第三份') }])
    expect(repeated[0]!.inputPath).toBe('input/说明 (3).txt')
    await expect(readFile(imported[0]!.absoluteDocumentPath!, 'utf8')).resolves.toBe('内容')
    const table = await readFile(imported[3]!.absoluteDocumentPath!, 'utf8')
    expect(table).toContain('## 工作表：评分表')
    expect(table).toContain('项目\\|名称')
    expect(table).toContain('第一行<br>第二行')
    expect(table).toContain('## 工作表：空表')
  })

  it('records deterministic and document parse failures without aborting the batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const config = { ...DEFAULT_BID_CONFIG, allowedExtensions: [...DEFAULT_BID_CONFIG.allowedExtensions, '.foo'] }
    const bid = new BidWorkspace(root, 'failures', config)
    const imported = await bid.import([
      { name: 'bad.txt', bytes: new Uint8Array([0xff]), type: 'text/custom' },
      { name: 'bad.pdf', bytes: new TextEncoder().encode('not pdf') },
      { name: 'unknown.foo', bytes: new Uint8Array([1]), type: 'application/custom' },
      { name: 'fallback.foo', bytes: new Uint8Array([1]) },
    ])
    expect(imported.map(file => file.parseStatus)).toEqual(['failed', 'failed', 'failed', 'failed'])
    expect(imported[0]).toMatchObject({ mediaType: 'text/plain', corpusPath: 'corpus/bad.txt', documentPath: null })
    expect(imported[1]!.parseError).toContain('PDF_PARSE_FAILED')
    expect(imported[2]).toMatchObject({ mediaType: 'application/custom', parseError: 'bid-unsupported-file-type' })
    expect(imported[3]).toMatchObject({ mediaType: 'application/octet-stream' })
    const inventory = await bid.messageInventory('继续')
    expect(inventory).toContain('完整正文：无')
    expect(inventory).toContain('搜索语料：无')
    expect(inventory).toContain('文档结构：无')
    expect(inventory).toContain('失败：')
  })

  it('does not chunk a corpus that needs OCR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'needs_ocr')
    const imported = (await bid.import([{ name: '扫描件.pdf', bytes: await readFile(fixture('scanned-document.pdf')) }]))[0]!
    expect(imported).toMatchObject({ parseStatus: 'needs_ocr', chunksPath: null, chunkIndexPath: null })
    expect(imported.absoluteChunksPath).toBeNull()
    expect(await bid.messageInventory('识别')).toContain('搜索语料：无')
  })

  it('rejects invalid manifests and renders needs-OCR inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'manifest')
    await mkdir(bid.sessionRoot, { recursive: true })
    await writeFile(bid.manifestPath, '{')
    await expect(bid.readManifest()).rejects.toThrow()
    await writeFile(bid.manifestPath, JSON.stringify({ version: 1, files: [] }))
    await expect(bid.readManifest()).rejects.toThrow('bid-unsupported-manifest-version')
    await writeFile(bid.manifestPath, JSON.stringify({ version: 3, files: [{
      id: 'id', originalName: 'scan.pdf', inputPath: 'input/scan.pdf', corpusPath: 'corpus/scan.pdf',
      documentPath: 'corpus/scan.pdf/document.md', structurePath: 'corpus/scan.pdf/structure.json', metadataPath: 'corpus/scan.pdf/metadata.json',
      chunksPath: null, chunkIndexPath: null,
      mediaType: 'application/pdf', size: 1, sha256: 'hash', parseStatus: 'needs_ocr', parseError: null,
    }, {
      id: 'failed', originalName: 'failed.pdf', inputPath: 'input/failed.pdf', corpusPath: null,
      documentPath: null, structurePath: null, metadataPath: null, mediaType: 'application/pdf', size: 1,
      chunksPath: null, chunkIndexPath: null,
      sha256: 'failed', parseStatus: 'failed', parseError: null,
    }] }))
    await expect(bid.messageInventory('识别')).resolves.toContain('需要 OCR')
    await expect(bid.messageInventory('识别')).resolves.toContain('失败：未知错误')
  })

  it('delegates document parsing and exports supported Markdown blocks to DOCX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const delegated = await parseBidDocument({ sourcePath: fixture('bid-document.pdf'), outputDir: join(root, 'delegated') })
    expect(delegated.parseStatus).toBe('success')

    const bid = new BidWorkspace(root, 'export')
    await mkdir(join(bid.sessionRoot, 'drafts'), { recursive: true })
    await writeFile(join(bid.sessionRoot, 'drafts', '技术标.md'), '# 一级\n\n## 二级\n\n### 三级\n\n正文\n\n1. 有序\n\n- 无序\n\n| 项目 | 要求 |\n| --- | --- |\n| 实施 | 完整 |\n\n---\n')
    const destination = await bid.exportDocx('drafts/技术标.md')
    expect(destination).toBe('.bid-harness/sessions/export/output/技术标.docx')
    expect((await readFile(join(bid.sessionRoot, 'output', '技术标.docx'))).byteLength).toBeGreaterThan(0)

    await writeFile(join(bid.sessionRoot, 'drafts', 'empty.md'), '')
    await expect(bid.exportDocx('drafts/empty.md', 'output/empty.docx')).resolves.toBe('.bid-harness/sessions/export/output/empty.docx')
    await mkdir(join(bid.sessionRoot, 'output', 'conflict.docx'))
    await expect(bid.exportDocx('drafts/empty.md', 'output/conflict.docx')).rejects.toThrow()
    await expect(bid.exportDocx('drafts/技术标.txt')).rejects.toThrow('bid-source-must-be-markdown')
    await expect(bid.exportDocx('drafts/技术标.md', 'elsewhere/out.docx')).rejects.toThrow('bid-output-path-required')

    const disabled = new BidWorkspace(root, 'disabled', { ...DEFAULT_BID_CONFIG, enableDocxExport: false })
    await expect(disabled.exportDocx('draft.md')).rejects.toThrow('bid-docx-export-disabled')
  })
})
