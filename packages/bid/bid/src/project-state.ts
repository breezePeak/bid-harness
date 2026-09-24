/** Workspace 级 Bid 任务状态持久化；Host 项目锁串行化所有写入。 */

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { BidTaskState } from './control-plane-contract.ts'
import {
  bidTaskStateSchema,
  legacyBidControlStateSchema,
  legacyBidRuntimeSchema,
  normalizeLegacyBidControlState,
} from './runtime-state.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { publishBidBatch, reconcileBidPublications, type BidPublicationLease } from './publication-batch.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'

const projectMetadataSchema = z.object({
  schema_version: recordOnlySchemaVersion(4),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.number().int().nonnegative(),
}).passthrough()

const legacyProjectStateSchema = z.object({
  schema_version: recordOnlySchemaVersion(3),
  workflow: legacyBidControlStateSchema.shape.workflow,
  run: legacyBidControlStateSchema.shape.run,
  last_run: legacyBidControlStateSchema.shape.lastRun,
  runtime: legacyBidRuntimeSchema.optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.number().int().nonnegative(),
}).strict()

/** 持久化元数据与唯一任务状态；读取旧 v3 后也只向调用方暴露此结构。 */
export type BidProjectState = BidTaskState & {
  readonly schema_version: number
  readonly revision: number
  readonly updated_at: number
}

type ProjectWorkspace = { readonly root: string; readonly projectStatePath: string }

/**
 * Return the authoritative task portion of a persisted project record.
 * @param state 项目持久化状态。
 * @returns 项目中的能力任务状态。
 */
export function bidProjectTaskState(state: BidProjectState): BidTaskState {
  const { schema_version: _schemaVersion, revision: _revision, updated_at: _updatedAt, ...task } = state
  return bidTaskStateSchema.parse(task)
}

/**
 * Parse the current single-state format, then normalize the legacy v3 structure.
 * @param value 待解析的磁盘数据。
 * @returns 已校验的项目状态。
 */
export function parseBidProjectState(value: unknown): BidProjectState {
  const metadata = projectMetadataSchema.safeParse(value)
  if (metadata.success) {
    const { schema_version, revision, updated_at, ...candidate } = metadata.data
    const task = bidTaskStateSchema.safeParse(candidate)
    if (task.success) return { schema_version, revision, updated_at, ...task.data }
  }

  const legacy = legacyProjectStateSchema.parse(value)
  return {
    schema_version: 4,
    revision: legacy.revision,
    updated_at: legacy.updated_at,
    ...normalizeLegacyBidControlState({
      workflow: legacy.workflow,
      run: legacy.run,
      lastRun: legacy.last_run,
    }),
  }
}

/**
 * 读取项目状态；未创建时返回 undefined，格式无效时拒绝读取。
 * Host 在项目锁内把没有对应 live operation 的 `running` 转换为 `suspended`。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @returns 规范化后的项目任务状态和修订号。
 */
export async function readBidProjectState(workspace: ProjectWorkspace): Promise<BidProjectState | undefined> {
  await reconcileBidPublications(workspace.root, dirname(workspace.projectStatePath))
  await assertNoLinkedPath(workspace.root, workspace.projectStatePath)
  let raw: string
  try {
    raw = await readFile(workspace.projectStatePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return parseBidProjectState(JSON.parse(raw))
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
  const task = bidProjectTaskState(state)
  const validated: BidProjectState = {
    schema_version: 4,
    revision: state.revision,
    updated_at: state.updated_at,
    ...task,
  }
  await writeFileAtomic(workspace.projectStatePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 在 Host 已持有的项目锁内保存任务状态，成功写入后修订号递增一次。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @param task 当前操作结束或启动恢复后的唯一任务状态。
 * @returns 已提交的项目状态，首次修订号为 1。
 */
export async function checkpointBidProjectState(
  workspace: ProjectWorkspace,
  task: BidTaskState,
): Promise<BidProjectState> {
  const previous = await readBidProjectState(workspace)
  const normalized = bidTaskStateSchema.parse(task)
  if (previous !== undefined && JSON.stringify(bidProjectTaskState(previous)) === JSON.stringify(normalized)) return previous
  const state: BidProjectState = {
    schema_version: 4,
    revision: (previous?.revision ?? 0) + 1,
    updated_at: Date.now(),
    ...normalized,
  }
  await writeBidProjectState(workspace, state)
  return state
}

/**
 * 将短时 canonical mutation 与项目修订号作为一个 publication 提交。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @param expectedRevision 调用方读取并持有锁时观察到的修订号。
 * @param task mutation 完成后的唯一任务状态。
 * @param mutate 在同一 publication 内写入 canonical artifact 的回调。
 * @returns 已提交且修订号递增一次的项目状态。
 */
export async function commitBidProjectMutation(
  workspace: ProjectWorkspace,
  expectedRevision: number,
  task: BidTaskState,
  mutate: (lease: BidPublicationLease) => Promise<void>,
): Promise<BidProjectState> {
  const previous = await readBidProjectState(workspace)
  if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('BID_PROJECT_REVISION_CONFLICT')
  const state: BidProjectState = {
    schema_version: 4,
    revision: expectedRevision + 1,
    updated_at: Date.now(),
    ...bidTaskStateSchema.parse(task),
  }
  await publishBidBatch(workspace.root, dirname(workspace.projectStatePath), async (lease) => {
    await mutate(lease)
    await lease.writeJson(workspace.projectStatePath, state)
  })
  return state
}
