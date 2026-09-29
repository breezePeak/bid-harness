/** 能力适配器读取候选项目文件时共用的链接路径检查。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

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
