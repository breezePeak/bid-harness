/** 能力适配器读取候选项目文件时共用的链接路径检查。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { readChapterLocation } from './chapter-storage.ts'
import { indexChapterContentBlocks } from './chapter-content-reuse.ts'

/**
 * 读取已授权源章在正式项目中的完整原文块，供迁移识别候选里的重复副本。
 * @param workspace 正式项目。
 * @param sectionIds 已核对授权范围的源章身份。
 * @param originalSectionIds 原请求接纳前已有的目录身份。
 * @returns 非标题原文块及正式源文件中的份数；只存在于候选的新章不补造正式来源。
 */
export async function originalCapabilityBlockCounts(
  workspace: BidWorkspace, sectionIds: ReadonlySet<string>, originalSectionIds?: ReadonlySet<string>,
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>()
  for (const id of sectionIds) {
    if (originalSectionIds !== undefined && !originalSectionIds.has(id)) continue
    const location = await readChapterLocation(workspace, id)
    if (location === null) continue
    const path = within(workspace.projectRoot, location.contentPath)
    await assertNoLinkedPath(workspace.root, path)
    const markdown = await readFile(path, 'utf8')
    for (const block of indexChapterContentBlocks(id, markdown)) if (block.type !== 'heading') {
      const text = block.markdown.trim()
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * 读取项目 JSON 文件。
 * @param workspace 候选项目。
 * @param path 项目相对路径。
 * @returns 未解析业务 schema 的 JSON 数据。
 */
export async function readCapabilityJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown
}

/**
 * 读取现有项目文件的摘要；缺失文件返回 undefined。
 * @param workspace 候选项目。
 * @param path 项目相对路径。
 * @returns SHA-256 或缺失标记。
 */
export async function capabilityFileHash(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return createHash('sha256').update(await readFile(absolute)).digest('hex') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
