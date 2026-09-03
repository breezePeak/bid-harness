/** Workspace 级 Bid 控制状态的持久化；Host 项目锁串行化所有写入。 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { BidRuntimeState } from './control-plane-contract.ts'
import { bidRuntimeSchema } from './runtime-state.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const projectStateSchema = z.object({
  schema_version: z.literal(1),
  runtime: bidRuntimeSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.number().int().nonnegative(),
}).strict()

/** 仅保存项目控制状态，不携带 Session 身份或聊天上下文。 */
export type BidProjectState = z.infer<typeof projectStateSchema>

type ProjectWorkspace = { readonly root: string; readonly projectStatePath: string }

/**
 * 读取项目状态；未创建时返回 undefined，格式无效或版本不符时拒绝读取。
 * 不改写执行状态；Host 在项目锁内判断 running 是否因后端停止而中断。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @returns 文件中的项目状态和修订号。
 */
export async function readBidProjectState(workspace: ProjectWorkspace): Promise<BidProjectState | undefined> {
  await assertNoLinkedPath(workspace.root, workspace.projectStatePath)
  let raw: string
  try {
    raw = await readFile(workspace.projectStatePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return projectStateSchema.parse(JSON.parse(raw))
  } catch (cause: unknown) {
    throw new Error(`bid-invalid-project-state: ${workspace.projectStatePath}`, { cause })
  }
}

/**
 * 在 Host 持有项目锁时原子替换状态文件；调用方负责提供下一修订号。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @param state 要写入的完整项目状态。
 */
export async function writeBidProjectState(workspace: ProjectWorkspace, state: BidProjectState): Promise<void> {
  await assertNoLinkedPath(workspace.root, workspace.projectStatePath)
  const validated = projectStateSchema.parse(state)
  await writeFileAtomic(workspace.projectStatePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 在 Host 已持有的项目锁内保存 runtime，成功写入后修订号递增一次。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @param runtime 当前操作结束或启动恢复后的项目控制状态。
 * @returns 已提交的项目状态，首次修订号为 1。
 */
export async function checkpointBidProjectState(workspace: ProjectWorkspace, runtime: BidRuntimeState): Promise<BidProjectState> {
  const previous = await readBidProjectState(workspace)
  const state: BidProjectState = {
    schema_version: 1,
    runtime,
    revision: (previous?.revision ?? 0) + 1,
    updated_at: Date.now(),
  }
  await writeBidProjectState(workspace, state)
  return state
}
