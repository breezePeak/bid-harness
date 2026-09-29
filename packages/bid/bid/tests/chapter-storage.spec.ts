import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace, parseOrMigrateChapterExecutionLog, type OutlineArtifact } from '@deepseek-ai/dsh-bid'
import { ensureChapterLocations, planChapterLocations, readChapterLocation } from '../src/chapter-storage.ts'
import { collectDocxMarkdown } from '../src/docx-export.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function project(variant: 'complete' | 'partial'): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-chapter-storage-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, variant)
  return workspace
}

describe('章节固定存储身份', () => {
  it('目录移动后按 section_id 读取旧正文，纯读取不迁移磁盘', async () => {
    const workspace = await project('complete')
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const beforeLog = await readFile(logPath, 'utf8')
    const beforeBodies = await Promise.all([1, 2, 3, 4, 5].map(index => readFile(
      join(workspace.projectRoot, `chapters/sections/${String(index).padStart(4, '0')}.md`), 'utf8',
    )))
    const outlinePath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
    const outline = JSON.parse(await readFile(outlinePath, 'utf8')) as OutlineArtifact
    const moved = { ...outline, sections: outline.sections.map(section => section.id === 'SEC-3'
      ? { ...section, order: 0 } : section) }
    await writeFile(outlinePath, `${JSON.stringify(moved)}\n`)
    const locations = await Promise.all(['SEC-3', 'SEC-1', 'SEC-2'].map(id => readChapterLocation(workspace, id)))
    expect(locations.map(item => item?.contentPath)).toEqual([
      'chapters/sections/0003.md', 'chapters/sections/0001.md', 'chapters/sections/0002.md',
    ])
    expect(await readFile(logPath, 'utf8')).toBe(beforeLog)
    expect(await Promise.all([1, 2, 3, 4, 5].map(index => readFile(
      join(workspace.projectRoot, `chapters/sections/${String(index).padStart(4, '0')}.md`), 'utf8',
    )))).toEqual(beforeBodies)
  })

  it('部分完成项目给新叶节分配新号且迁移只写一次', async () => {
    const workspace = await project('partial')
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    expect(await readChapterLocation(workspace, 'SEC-3')).toBeNull()
    const plan = await planChapterLocations(workspace, log.sections.map(section => section.section_id))
    expect([...plan.locations.values()].map(item => item.storageSerial)).toEqual([1, 2, 3, 4, 5])
    const writeJson = vi.fn(async (path: string, value: unknown) => {
      await writeFile(path, `${JSON.stringify(value)}\n`)
    })
    await ensureChapterLocations(workspace, log, plan, { writeJson })
    expect(writeJson).toHaveBeenCalledTimes(1)
    expect((await readChapterLocation(workspace, 'SEC-3'))?.contentPath).toBe('chapters/sections/0003.md')
    await ensureChapterLocations(workspace, log, plan, { writeJson })
    expect(writeJson).toHaveBeenCalledTimes(1)
  })

  it('metadata 与 Manifest 冲突时拒绝迁移', async () => {
    const workspace = await project('complete')
    const path = join(workspace.projectRoot, 'chapters/meta/0002.json')
    const value = JSON.parse(await readFile(path, 'utf8')) as { section_id: string }
    await writeFile(path, `${JSON.stringify({ ...value, section_id: 'SEC-3' })}\n`)
    await expect(planChapterLocations(workspace, ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-4', 'SEC-5']))
      .rejects.toThrow('BID_CHAPTER_STORAGE_CONFLICT')
  })

  it('章节移动改变导出顺序但不改变正文和审核归属', async () => {
    const workspace = await project('complete')
    const outlinePath = join(workspace.projectRoot, 'outline/confirmed-outline.json')
    const outline = JSON.parse(await readFile(outlinePath, 'utf8')) as OutlineArtifact
    const original = await collectDocxMarkdown(workspace)
    expect(original.indexOf('流程一：收集输入。')).toBeLessThan(original.indexOf('回答主题3。'))
    const movedOrders = new Map([['SEC-3', 1], ['SEC-1', 2], ['SEC-2', 3]])
    await writeFile(outlinePath, JSON.stringify({ ...outline, sections: outline.sections.map(section => ({
      ...section, order: movedOrders.get(section.id) ?? section.order,
    })) }))
    const moved = await collectDocxMarkdown(workspace)
    expect(moved.indexOf('回答主题3。')).toBeLessThan(moved.indexOf('流程一：收集输入。'))
    expect((await readChapterLocation(workspace, 'SEC-3'))?.reviewPath).toBe('chapters/reviews/0003.json')
    expect((await readChapterLocation(workspace, 'SEC-1'))?.reviewPath).toBe('chapters/reviews/0001.json')
  })

  it('插入新可写章节时保留旧号并跳过历史序号', async () => {
    const workspace = await project('complete')
    const log = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(
      join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8',
    )))
    const plan = await planChapterLocations(workspace, ['NEW', 'SEC-3', 'SEC-1', 'SEC-2', 'SEC-4', 'SEC-5'])
    expect(plan.locations.get('NEW')?.storageSerial).toBe(6)
    expect(plan.locations.get('SEC-3')?.storageSerial).toBe(3)
    expect(plan.nextStorageSerial).toBe(7)
    const removed = await planChapterLocations(workspace, ['SEC-1', 'SEC-2', 'SEC-4', 'SEC-5'])
    expect(removed.nextStorageSerial).toBe(6)
    expect(removed.locations.has('SEC-3')).toBe(false)
    expect((await readChapterLocation(workspace, 'SEC-3'))?.storageSerial).toBe(3)
    expect(log.sections[2]?.final_writer_child_session_id).toBe('writer-SEC-3')
  })

  it('四位存储号耗尽时返回容量诊断', async () => {
    const workspace = await project('partial')
    const path = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...log, next_storage_serial: 10_000 }))
    await expect(planChapterLocations(workspace, ['SEC-1', 'NEW']))
      .rejects.toThrow('BID_CHAPTER_STORAGE_CAPACITY: NEW')
  })
})
