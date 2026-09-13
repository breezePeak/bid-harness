/** Workspace 级 Bid 控制状态的持久化；Host 项目锁串行化所有写入。 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { BidControlState, BidRuntimeState } from './control-plane-contract.ts'
import { bidControlStateSchema, bidRuntimeSchema, bidRuntimeView, controlStateFromLegacyRuntime } from './runtime-state.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const projectStateV1Schema = z.object({
  schema_version: z.literal(1),
  runtime: bidRuntimeSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.number().int().nonnegative(),
}).strict()

const projectStateSchema = z.object({
  schema_version: z.literal(2),
  workflow: bidControlStateSchema.shape.workflow,
  run: bidControlStateSchema.shape.run,
  last_run: bidControlStateSchema.shape.lastRun,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.number().int().nonnegative(),
}).strict()

/** 仅保存项目控制状态，不携带 Session 身份或聊天上下文。 */
export type BidProjectState = z.infer<typeof projectStateSchema> & { readonly runtime: BidRuntimeState }

type ProjectWorkspace = { readonly root: string; readonly projectStatePath: string }

function exposeRuntime(state: z.infer<typeof projectStateSchema>): BidProjectState {
  return Object.defineProperty(state, 'runtime', {
    enumerable: false,
    value: bidRuntimeView({ workflow: state.workflow, run: state.run, lastRun: state.last_run }),
  }) as BidProjectState
}

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
    const value: unknown = JSON.parse(raw)
    const current = projectStateSchema.safeParse(value)
    if (current.success) return exposeRuntime(current.data)
    const legacy = projectStateV1Schema.parse(value)
    const control = controlStateFromLegacyRuntime(legacy.runtime, legacy.revision)
    return exposeRuntime({
      schema_version: 2,
      workflow: control.workflow,
      run: control.run,
      last_run: control.lastRun,
      revision: legacy.revision,
      updated_at: legacy.updated_at,
    })
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
  const validated = projectStateSchema.parse({
    schema_version: state.schema_version,
    workflow: state.workflow,
    run: state.run,
    last_run: state.last_run,
    revision: state.revision,
    updated_at: state.updated_at,
  })
  await writeFileAtomic(workspace.projectStatePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 在 Host 已持有的项目锁内保存 runtime，成功写入后修订号递增一次。
 * @param workspace 项目所在的 Workspace 和状态文件路径。
 * @param runtime 当前操作结束或启动恢复后的项目控制状态。
 * @returns 已提交的项目状态，首次修订号为 1。
 */
export async function checkpointBidProjectState(
  workspace: ProjectWorkspace,
  control: BidControlState | BidRuntimeState,
): Promise<BidProjectState> {
  const previous = await readBidProjectState(workspace)
  const normalized = 'workflow' in control ? control : controlStateFromLegacyRuntime(control, previous?.revision ?? 0)
  const state = exposeRuntime({
    schema_version: 2,
    workflow: normalized.workflow,
    run: normalized.run,
    last_run: normalized.lastRun,
    revision: (previous?.revision ?? 0) + 1,
    updated_at: Date.now(),
  })
  await writeBidProjectState(workspace, state)
  return state
}
