import { readFile } from 'node:fs/promises'
import { within, assertNoLinkedPath } from './workspace-path.ts'
import type { BidPublicationLease } from './publication-batch.ts'
import {
  WRITING_ENTRY_STOP_PATH,
  writingEntryStopSchema,
  type WritingEntryStop,
} from './writing-entry-contract.ts'
import { parseWritingPlan, type WritingPlan } from './writing-requirements.ts'

/**
 * 写作入口只需读取的工作区路径。
 */
export interface BidWorkspaceLike {
  readonly root: string
  readonly projectRoot: string
}

/**
 * 安全读取 S5 入口停止记录。
 * 文件不存在时返回 undefined；JSON 损坏、格式错误或路径不安全时抛出错误。
 * @param workspace 工作区路径描述。
 * @returns 停止记录或 undefined。
 */
export async function readWritingEntryStop(
  workspace: BidWorkspaceLike,
): Promise<WritingEntryStop | undefined> {
  const path = within(workspace.projectRoot, WRITING_ENTRY_STOP_PATH)
  await assertNoLinkedPath(workspace.root, path)
  try {
    const raw = await readFile(path, 'utf8')
    return writingEntryStopSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 校验并通过 publication lease 写入 S5 入口停止记录。
 * @param workspace 工作区路径描述。
 * @param value 停止记录对象。
 * @param lease 当前操作所持有的发布租约。
 */
export async function writeWritingEntryStop(
  workspace: BidWorkspaceLike,
  value: WritingEntryStop,
  lease: BidPublicationLease,
): Promise<void> {
  const parsed = writingEntryStopSchema.parse(value)
  const path = within(workspace.projectRoot, WRITING_ENTRY_STOP_PATH)
  await assertNoLinkedPath(workspace.root, path)
  await lease.writeJson(path, parsed)
}

/**
 * 通过 publication lease 移除 S5 入口停止记录。
 * @param workspace 工作区路径描述。
 * @param lease 当前操作所持有的发布租约。
 */
export async function removeWritingEntryStop(
  workspace: BidWorkspaceLike,
  lease: BidPublicationLease,
): Promise<void> {
  const path = within(workspace.projectRoot, WRITING_ENTRY_STOP_PATH)
  await assertNoLinkedPath(workspace.root, path)
  await lease.remove(path, false)
}

/**
 * 安全读取当前 Writing Plan 并校验目录哈希。
 * 实现顺序：安全读 chapters/writing-plan.json -> parseWritingPlan -> 比较 confirmed_outline_sha256。
 * 文件不存在返回 undefined；格式错误或目录不匹配返回明确错误，不把损坏计划降成“没有计划”。
 * @param workspace 工作区路径描述。
 * @param confirmedOutlineSha256 当前确认目录的 SHA-256 哈希。
 * @returns 校验通过的 Writing Plan，或 undefined（仅限文件不存在）。
 */
export async function readCurrentWritingPlan(
  workspace: BidWorkspaceLike,
  confirmedOutlineSha256: string,
): Promise<WritingPlan | undefined> {
  const path = within(workspace.projectRoot, 'chapters/writing-plan.json')
  await assertNoLinkedPath(workspace.root, path)
  try {
    const raw = await readFile(path, 'utf8')
    const plan = parseWritingPlan(JSON.parse(raw))
    if (plan.confirmed_outline_sha256 !== confirmedOutlineSha256) {
      throw new Error(
        `BID_WRITING_PLAN_OUTLINE_MISMATCH: plan confirmed_outline_sha256 ${plan.confirmed_outline_sha256} does not match outline ${confirmedOutlineSha256}`,
      )
    }
    return plan
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
