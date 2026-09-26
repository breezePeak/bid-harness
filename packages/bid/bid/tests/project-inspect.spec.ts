import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState } from '../src/index.ts'
import { inspectBidProject } from '../src/bid-project-inspect.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function project(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-project-inspect-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'partial')
  return workspace
}

async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await visit(root)
  return result
}

describe('项目级只读检查', () => {
  it('不同阶段标记下读取同一业务内容，且不改动任何项目文件', async () => {
    const workspace = await project()
    const outline = await inspectBidProject(workspace, { object: 'outline', page: 0, page_size: 2 })
    const chapter = await inspectBidProject(workspace, { object: 'chapters', section_ids: ['SEC-1', 'SEC-3'] })
    expect(outline).toMatchObject({ available: true, total: 7, has_more: true })
    expect(chapter).toMatchObject({ available: true, total: 2, data: [
      { section_id: 'SEC-1', available: true }, { section_id: 'SEC-3', available: false },
    ] })
    for (const stage of ['outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export'] as const) {
      await checkpointBidProjectState(workspace, { stage, status: 'completed', run: null })
      const before = await hashes(workspace.projectRoot)
      expect(await inspectBidProject(workspace, { object: 'outline', page: 0, page_size: 2 })).toEqual(outline)
      expect(await inspectBidProject(workspace, { object: 'chapters', section_ids: ['SEC-1', 'SEC-3'] })).toEqual(chapter)
      expect(await hashes(workspace.projectRoot)).toEqual(before)
    }
  })

  it('正文按字符偏移分页，未完整读取时明确标记且保留真实身份', async () => {
    const workspace = await project()
    const path = join(workspace.projectRoot, 'chapters/sections/0001.md')
    const body = `# 章节1\n\n${'甲'.repeat(25_000)}`
    await writeFile(path, body)
    const first = await inspectBidProject(workspace, { object: 'chapters', section_ids: ['SEC-1'], max_chars: 4_000 })
    const item = (first.data as Array<{ section_id: string; complete: boolean; next_offset: number; total_chars: number }>)[0]
    expect(item).toMatchObject({ section_id: 'SEC-1', complete: false, next_offset: 4_000, total_chars: body.length })
    const later = await inspectBidProject(workspace, { object: 'chapters', section_ids: ['SEC-1'], offset: 4_000, max_chars: 4_000 })
    expect((later.data as Array<{ next_offset: number }>)[0]?.next_offset).toBe(8_000)
  })

  it('未知章节与空范围明确拒绝，缺失对象返回 available=false', async () => {
    const workspace = await project()
    await expect(inspectBidProject(workspace, { object: 'chapters', section_ids: [] })).rejects.toThrow()
    await expect(inspectBidProject(workspace, { object: 'chapters', section_ids: ['UNKNOWN'] }))
      .rejects.toThrow('BID_PROJECT_INSPECT_SECTION_UNKNOWN')
    expect(await inspectBidProject(workspace, { object: 'task' })).toMatchObject({ available: false })
    expect(await inspectBidProject(workspace, { object: 'outline', source: 'candidate' }))
      .toMatchObject({ available: false, missing: 'BID_CANDIDATE_WORKSPACE_UNAVAILABLE' })
  })

  it('来源和正文列表分页时保留真实引用 ID，不把一页当成全部', async () => {
    const workspace = await project()
    const requirements = await inspectBidProject(workspace, { object: 'tender', part: 'requirements', page_size: 2 })
    expect(requirements).toMatchObject({ available: true, total: 5, has_more: true })
    expect((requirements.data as Array<{ id: string; source_refs: unknown[] }>)[0]).toMatchObject({ id: 'REQ-1' })
    expect((requirements.data as Array<{ source_refs: unknown[] }>)[0]?.source_refs).toHaveLength(1)
    const next = await inspectBidProject(workspace, { object: 'tender', part: 'requirements', page: 1, page_size: 2 })
    expect((next.data as Array<{ id: string }>)[0]?.id).toBe('REQ-3')
  })
})
