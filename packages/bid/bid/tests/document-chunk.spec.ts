import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chunkDocument } from '../src/document-chunk.ts'

function bodyOf(chunk: string): string {
  const separator = chunk.indexOf('\n\n')
  return separator < 0 ? '' : chunk.slice(separator + 2)
}

describe('chunkDocument', () => {
  it('preserves headings, pages, lists, tables, source coverage, and deterministic adjacency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const structurePath = join(root, 'structure.json')
    const metadataPath = join(root, 'metadata.json')
    const outputDir = join(root, 'chunks')
    const tableRows = Array.from({ length: 10 }, (_, index) => `| 项目实施方案 ${index} | 10 | 保持完整评分标准 ${'甲'.repeat(12)} |`).join('\n')
    const markdown = `<!-- source: 招标文件.pdf -->\n<!-- page: 1 -->\n\n# 第五章 技术要求\n\n## 5.1 项目实施要求\n\n项目背景信息。${'背景。'.repeat(15)}\n\n1. 编制方案\n2. 完成验收\n\n<!-- page: 2 -->\n\n### 5.1.1 项目组织管理\n\n关键词项目实施管理位于此处。${'执行。'.repeat(15)}\n\n| 评分项 | 分值 | 评分标准 |\n| --- | --- | --- |\n${tableRows}\n`
    await writeFile(documentPath, markdown)
    await writeFile(structurePath, JSON.stringify({ sections: [
      { level: 1, title: '第五章 技术要求', heading_path: ['第五章 技术要求'], page_start: 1, page_end: 2 },
      { level: 2, title: '5.1 项目实施要求', heading_path: ['第五章 技术要求', '5.1 项目实施要求'], page_start: 1, page_end: 2 },
      { level: 3, title: '5.1.1 项目组织管理', heading_path: ['第五章 技术要求', '5.1 项目实施要求', '5.1.1 项目组织管理'], page_start: 2, page_end: 2 },
    ] }))
    await writeFile(metadataPath, JSON.stringify({ source_file: '招标文件.pdf' }))
    const config = { minChars: 60, targetChars: 150, maxChars: 240 }

    const first = await chunkDocument({ documentPath, structurePath, metadataPath, outputDir, config })
    const firstIndex = await readFile(first.indexPath, 'utf8')
    const firstFiles = await Promise.all(first.index.chunks.map(entry => readFile(join(outputDir, entry.path), 'utf8')))
    const second = await chunkDocument({ documentPath, structurePath, metadataPath, outputDir, config })
    const secondFiles = await Promise.all(second.index.chunks.map(entry => readFile(join(outputDir, entry.path), 'utf8')))

    expect(second.index).toEqual(first.index)
    expect(await readFile(second.indexPath, 'utf8')).toBe(firstIndex)
    expect(secondFiles).toEqual(firstFiles)
    expect(firstFiles.map(bodyOf).join('')).toBe(markdown)
    expect(first.index.chunks.map(entry => entry.id)).toEqual(first.index.chunks.map((_, index) => `chunk_${String(index + 1).padStart(4, '0')}`))
    for (const [index, entry] of first.index.chunks.entries()) {
      expect(entry.prev_chunk).toBe(index === 0 ? null : first.index.chunks[index - 1]!.path)
      expect(entry.next_chunk).toBe(index === first.index.chunks.length - 1 ? null : first.index.chunks[index + 1]!.path)
      if (index > 0) expect(entry.source_line_start).toBeGreaterThanOrEqual(first.index.chunks[index - 1]!.source_line_end)
    }
    const headingChunk = first.index.chunks.find(entry => firstFiles[entry.order - 1]!.includes('项目组织管理'))
    expect(headingChunk?.heading_path).toEqual(['第五章 技术要求', '5.1 项目实施要求', '5.1.1 项目组织管理'])
    expect(headingChunk?.page_start).toBe(2)
    const tableChunkIndex = firstFiles.findIndex(value => value.includes('| 评分项 | 分值 | 评分标准 |'))
    expect(tableChunkIndex).toBeGreaterThanOrEqual(0)
    expect(firstFiles[tableChunkIndex]).toContain(tableRows)
    expect(first.index.chunks[tableChunkIndex]!.oversized).toBe(true)
  })

  it('splits long paragraphs without loss and removes stale chunks on replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const outputDir = join(root, 'chunks')
    const long = Array.from({ length: 80 }, (_, index) => `第${index}句项目实施管理。`).join('')
    await writeFile(documentPath, long)
    const first = await chunkDocument({ documentPath, outputDir, config: { minChars: 20, targetChars: 60, maxChars: 80 } })
    expect(first.chunkCount).toBeGreaterThan(10)
    const reconstructed = (await Promise.all(first.index.chunks.map(entry => readFile(join(outputDir, entry.path), 'utf8')))).map(bodyOf).join('')
    expect(reconstructed).toBe(long)

    await writeFile(documentPath, '缩短后的正文。')
    const second = await chunkDocument({ documentPath, outputDir, config: { minChars: 20, targetChars: 60, maxChars: 80 } })
    expect(second.chunkCount).toBe(1)
    expect((await readdir(outputDir)).sort()).toEqual(['chunk_0001.md', 'index.json'])
  })

  it('uses source lines before punctuation and a final character boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const multiline = `${'甲'.repeat(50)}\n${'乙'.repeat(50)}`
    await writeFile(documentPath, multiline)
    const lineResult = await chunkDocument({ documentPath, outputDir: join(root, 'line-chunks'), config: { minChars: 10, targetChars: 40, maxChars: 60 } })
    expect(lineResult.chunkCount).toBe(2)
    expect((await Promise.all(lineResult.index.chunks.map(entry => readFile(join(root, 'line-chunks', entry.path), 'utf8')))).map(bodyOf).join('')).toBe(multiline)

    const unbroken = '无'.repeat(170)
    await writeFile(documentPath, unbroken)
    const hardResult = await chunkDocument({ documentPath, outputDir: join(root, 'hard-chunks'), config: { minChars: 10, targetChars: 40, maxChars: 60 } })
    expect(hardResult.chunkCount).toBe(3)
    expect((await Promise.all(hardResult.index.chunks.map(entry => readFile(join(root, 'hard-chunks', entry.path), 'utf8')))).map(bodyOf).join('')).toBe(unbroken)
  })

  it('chunks a 300-page heading-free corpus and accepts missing optional files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const markdown = Array.from({ length: 300 }, (_, page) => `<!-- page: ${page + 1} -->\n\n第${page + 1}页项目实施管理。${'内容。'.repeat(30)}`).join('\n\n')
    await writeFile(documentPath, markdown)
    const result = await chunkDocument({ documentPath, structurePath: join(root, 'missing-structure.json'), metadataPath: join(root, 'missing-metadata.json'), outputDir: join(root, 'chunks'), config: { minChars: 100, targetChars: 300, maxChars: 500 } })
    expect(result.chunkCount).toBeGreaterThan(1)
    expect(result.index.chunks[0]).toMatchObject({ heading_path: [], page_start: 1 })
    expect(result.index.chunks.at(-1)?.page_end).toBe(300)
  })

  it('uses structure heading paths and rejects invalid durable inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const structurePath = join(root, 'structure.json')
    await writeFile(documentPath, '## 子标题\n\n正文')
    await writeFile(structurePath, JSON.stringify({ sections: [{ level: 2, title: '子标题', heading_path: ['恢复的父标题', '子标题'], page_start: null, page_end: null }] }))
    const result = await chunkDocument({ documentPath, structurePath, outputDir: join(root, 'chunks') })
    expect(result.index.chunks[0]?.heading_path).toEqual(['恢复的父标题', '子标题'])
    await expect(chunkDocument({ documentPath, outputDir: join(root, 'invalid'), config: { minChars: 10, targetChars: 5 } })).rejects.toThrow('document-chunk-invalid-config')
    await writeFile(structurePath, '{}')
    await expect(chunkDocument({ documentPath, structurePath, outputDir: join(root, 'invalid-structure') })).rejects.toThrow('document-chunk-invalid-structure')
    await writeFile(structurePath, JSON.stringify({ sections: [null] }))
    await expect(chunkDocument({ documentPath, structurePath, outputDir: join(root, 'invalid-section') })).rejects.toThrow('document-chunk-invalid-structure')
    const metadataPath = join(root, 'metadata.json')
    await writeFile(metadataPath, '{}')
    await expect(chunkDocument({ documentPath, metadataPath, outputDir: join(root, 'invalid-metadata') })).rejects.toThrow('document-chunk-invalid-metadata')
    await expect(chunkDocument({ documentPath, outputDir: root })).rejects.toThrow('document-chunk-output-conflict')
  })

  it('writes only a deterministic empty manifest for blank input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-document-chunk-'))
    const documentPath = join(root, 'document.md')
    const outputDir = join(root, 'chunks')
    await writeFile(documentPath, ' \n\n')
    const result = await chunkDocument({ documentPath, outputDir })
    expect(result.index).toMatchObject({ chunk_count: 0, chunks: [] })
    expect(await readdir(outputDir)).toEqual(['index.json'])
  })
})
