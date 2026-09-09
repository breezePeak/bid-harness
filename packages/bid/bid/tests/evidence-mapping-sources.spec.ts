import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { resolveMappingCorpusLocations } from '../src/evidence-mapping-corpus.ts'
import { buildMappingSourceIndex } from '../src/evidence-mapping-sources.ts'
import { createMappingSourceTools, mappingSourceCatalog } from '../src/evidence-mapping-source-tools.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DocumentChunkEntry } from '../src/document-chunk.ts'

function entry(id: string, start: number, end: number): DocumentChunkEntry {
  return { id, path: `${id}.md`, order: 1, heading_path: ['不作为范围依据'], page_start: null, page_end: null,
    source_line_start: start, source_line_end: end, char_count: 10, prev_chunk: null, next_chunk: null, oversized: false }
}

function toolExec(): ToolRunContext {
  return { signal: new AbortController().signal } as ToolRunContext
}

describe('S4 真实资料位置与受控引用', () => {
  it('按实际位置区分重复标题、直接正文、子节和跨标题分块', () => {
    const markdown = ['无标题正文', '# 总体', '总述正文', '## 重复', '第一次正文', '## 重复', '第二次正文', '# 相邻', '相邻正文'].join('\n')
    const outline = [
      { title: '总体', level: 1, order: 1, heading_path: ['总体'] },
      { title: '重复', level: 2, order: 2, heading_path: ['总体', '重复'] },
      { title: '重复', level: 2, order: 3, heading_path: ['总体', '重复'] },
      { title: '相邻', level: 1, order: 4, heading_path: ['相邻'] },
      { title: '无法对应', level: 1, order: 5, heading_path: ['无法对应'] },
    ]
    const source = buildMappingSourceIndex(markdown, [entry('chunk_0001', 1, 4), entry('chunk_0002', 4, 7), entry('chunk_0003', 8, 9)], outline)
    expect(source.headings.map(({ start, body_start, end, full_end }) => [start, body_start, end, full_end])).toEqual([
      [2, 3, 3, 7], [4, 5, 5, 5], [6, 7, 7, 7], [8, 9, 9, 9],
    ])
    expect(source.directory.map(item => item.heading_index)).toEqual([0, 1, 2, 3, null])
    expect(source.directory.at(-1)?.location).toBe('定位未确定')
    expect(source.chunks[0]?.coverage).toEqual([
      { start: 1, end: 1, heading_path: [] }, { start: 2, end: 3, heading_path: ['总体'] }, { start: 4, end: 4, heading_path: ['总体', '重复'] },
    ])
    expect(source.chunks[1]?.coverage.map(item => [item.start, item.end])).toEqual([[4, 5], [6, 7]])
  })

  it('忽略代码中的伪标题，识别 Setext，重复目录无法一一对应时不猜位置', () => {
    const source = buildMappingSourceIndex('````md\n# 代码\n````\n实际标题\n====\n正文\n# 实际标题\n第二处', [], [
      { title: '实际标题', level: 1, order: 1, heading_path: ['实际标题'] },
    ])
    expect(source.headings.map(item => item.start)).toEqual([4, 7])
    expect(source.headings[0]?.body_start).toBe(6)
    expect(source.directory[0]).toMatchObject({ location: '定位未确定', heading_index: null })
    expect(buildMappingSourceIndex('只有正文', [entry('chunk_0001', 1, 1)], []).chunks[0]?.coverage)
      .toEqual([{ start: 1, end: 1, heading_path: [] }])
  })

  it('真实工具允许直接读取、字面范围搜索及扩大范围，同时拒绝伪造引用和额外路径', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s4-sources-')))
    await workspace.import([{ name: '旧标.md', role: 'reference_bid', bytes: new TextEncoder().encode('# 总体\n\n业务范围 a.*\n\n## 实施\n\n步骤细节\n\n# 相邻\n\n相邻正文') }])
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const catalog = mappingSourceCatalog(locations)[0]!
    const [read, search] = createMappingSourceTools(locations, () => [])
    const exec = toolExec()
    const direct = await read!.execute({ source_ref: catalog.body_headings[0]!.direct_body.source_ref }, exec) as {
      body: string
      materials: Array<{ material_ref: string; actual_chunk_coverage: unknown }>
    }
    expect(direct.body).toContain('业务范围 a.*')
    expect(direct.body).not.toContain('步骤细节')
    expect(direct.materials[0]?.actual_chunk_coverage).toBeDefined()
    const full = await read!.execute({ source_ref: catalog.body_headings[0]!.full_section.source_ref }, exec) as { body: string }
    expect(full.body).toContain('步骤细节')
    expect(full.body).not.toContain('相邻正文')
    expect(await search!.execute({ scope_ref: catalog.body_headings[0]!.direct_body.source_ref, keywords: ['步骤'] }, exec)).toEqual({ hits: [] })
    const expanded = await search!.execute({ scope_ref: catalog.scope_ref, keywords: ['步骤'] }, exec) as { hits: Array<{ source_ref: string; line: number }> }
    expect(expanded.hits).toHaveLength(1)
    expect(await read!.execute({ source_ref: expanded.hits[0]!.source_ref }, exec)).toMatchObject({ body: '步骤细节' })
    expect(await search!.execute({ scope_ref: 'ALL', keywords: ['a.+'] }, exec)).toEqual({ hits: [] })
    expect(await search!.execute({ scope_ref: 'ALL', keywords: ['a.*'] }, exec)).toMatchObject({ hits: [{ excerpt: '业务范围 a.*' }] })
    for (const raw of [{ source_ref: 'F999' }, { source_ref: '../../document.md' }, { source_ref: catalog.source_ref, file_path: '/tmp/other' }, { source_ref: catalog.source_ref, file_id: 'forged' }]) {
      await expect(read!.execute(raw, exec)).rejects.toBeDefined()
    }
    await expect(search!.execute({ scope_ref: catalog.scope_ref, keywords: ['业务'], path: 'other' }, exec)).rejects.toBeDefined()
    await expect(search!.execute({ scope_ref: 'unknown', keywords: ['业务'] }, exec)).rejects.toBeDefined()
  })

  it('程序分页不截丢正文，材料读取只返回真实分块，搜索后续引用无需模型计算位置', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s4-pages-')))
    const body = '# 范围\n\n' + '长行内容。'.repeat(3000) + '\n\n' + Array.from({ length: 43 }, (_, index) => `匹配${index}`).join('\n')
    await workspace.import([{ name: '长资料.md', role: 'reference', bytes: new TextEncoder().encode(body) }])
    const locations = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
    const [read, search] = createMappingSourceTools(locations, () => [])
    const exec = toolExec()
    let ref: string | undefined = mappingSourceCatalog(locations)[0]!.source_ref
    let text = ''
    let firstMaterial = ''
    while (ref !== undefined) {
      const page = await read!.execute({ source_ref: ref }, exec) as {
        body: string
        next_ref?: string
        materials: Array<{ material_ref: string }>
      }
      text += page.body
      firstMaterial ||= page.materials[0]!.material_ref
      ref = page.next_ref
    }
    expect(text).toBe(locations[0]!.source.lines.join('\n'))
    expect(await read!.execute({ source_ref: firstMaterial }, exec)).toMatchObject({ body: locations[0]!.chunks[0]!.body })
    let result = await search!.execute({ scope_ref: 'ALL', keywords: ['匹配'] }, exec) as { hits: unknown[]; next_ref?: string }
    const hits = [...result.hits]
    while (result.next_ref !== undefined) {
      result = await read!.execute({ source_ref: result.next_ref }, exec) as typeof result
      hits.push(...result.hits)
    }
    expect(hits).toHaveLength(43)
  })
})
