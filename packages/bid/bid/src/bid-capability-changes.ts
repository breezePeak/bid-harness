/** 能力任务以精确文件集合发布，并在同一事务保存可验证的完成凭据。 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { bidCapabilityResultSchema } from './bid-capability-contract.ts'
import type { BidRunContext } from './run-coordinator.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const fileSchema = z.object({ path: z.string().min(1), sha256: hashSchema }).strict()
const stepReceiptSchema = z.object({
  step_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  input_sha256: hashSchema,
  result: bidCapabilityResultSchema,
  files: z.array(fileSchema),
  removed_paths: z.array(z.string().min(1)),
}).strict()
/** 已合并到 Work 候选的单步结果及输入、文件身份。 */
export type CapabilityStepReceipt = z.infer<typeof stepReceiptSchema>

/** 与正式业务文件在同一 PublicationBatch 中提交的结果身份。 */
export const capabilityPublicationReceiptSchema = z.object({
  schema_version: recordOnlySchemaVersion(1),
  work_id: z.string().min(1),
  request_sha256: hashSchema,
  files: z.array(fileSchema),
  removed_paths: z.array(z.string().min(1)),
}).strict()

/** 正式文件发布后可以独立核验的 Work 完成凭据。 */
export type CapabilityPublicationReceipt = z.infer<typeof capabilityPublicationReceiptSchema>

function resultPath(workId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId)) throw new Error('BID_CAPABILITY_WORK_ID_INVALID')
  return `requests/${workId}/result.json`
}

function stepReceiptPath(stepId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(stepId)) throw new Error('BID_CAPABILITY_STEP_ID_INVALID')
  return `capability-steps/${stepId}.json`
}

function exactFilePath(workspace: BidWorkspace, path: string): string {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`BID_CAPABILITY_PUBLICATION_PATH_INVALID: ${path}`)
  }
  return within(workspace.projectRoot, path)
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/**
 * 核对正式结果凭据及它声称发布的当前文件身份。
 * @param workspace 正式项目。
 * @param workId 待核对的 Work。
 * @param requestSha256 不可变请求摘要。
 * @returns 完整匹配的凭据；尚未发布时为 null。
 */
export async function readCapabilityPublicationReceipt(
  workspace: BidWorkspace, workId: string, requestSha256: string,
): Promise<CapabilityPublicationReceipt | null> {
  const path = exactFilePath(workspace, resultPath(workId))
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const receipt = capabilityPublicationReceiptSchema.parse(JSON.parse(raw))
  if (receipt.work_id !== workId || receipt.request_sha256 !== requestSha256) {
    throw new Error('BID_CAPABILITY_RESULT_IDENTITY_MISMATCH')
  }
  for (const file of receipt.files) {
    const absolute = exactFilePath(workspace, file.path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (!(await lstat(absolute)).isFile() || sha256(await readFile(absolute)) !== file.sha256) {
      throw new Error(`BID_CAPABILITY_RESULT_FILE_MISMATCH: ${file.path}`)
    }
  }
  for (const removed of receipt.removed_paths) {
    const absolute = exactFilePath(workspace, removed)
    await assertNoLinkedPath(workspace.root, absolute)
    try { await lstat(absolute) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`BID_CAPABILITY_RESULT_REMOVAL_MISMATCH: ${removed}`)
  }
  return receipt
}

/**
 * 读取候选文件并以同一个 Run 提交权限原子发布精确变更和凭据。
 * @param run 拥有正式发布权限的 Run。
 * @param canonical 正式项目。
 * @param working 已验证的 Work 候选项目。
 * @param paths 实际改变的精确文件路径。
 * @param removedPaths 实际删除的精确文件路径。
 * @returns 与业务文件同批发布的完成凭据。
 */
export async function publishCapabilityChanges(
  run: BidRunContext, canonical: BidWorkspace, working: BidWorkspace,
  paths: readonly string[], removedPaths: readonly string[],
): Promise<CapabilityPublicationReceipt> {
  if (run.work.kind !== 'capability_task') throw new Error('BID_CAPABILITY_WORK_REQUIRED')
  const writes = [...new Set(paths)]
  const removals = [...new Set(removedPaths)]
  if (writes.length !== paths.length || removals.length !== removedPaths.length
    || writes.some(path => removals.includes(path))) throw new Error('BID_CAPABILITY_PUBLICATION_DUPLICATE_PATH')
  const files: Array<{ path: string; sha256: string; bytes: Uint8Array }> = []
  for (const path of writes) {
    const source = exactFilePath(working, path)
    exactFilePath(canonical, path)
    await assertNoLinkedPath(working.root, source)
    if (!(await lstat(source)).isFile()) throw new Error(`BID_CAPABILITY_PUBLICATION_NOT_FILE: ${path}`)
    const bytes = await readFile(source)
    files.push({ path, sha256: sha256(bytes), bytes })
  }
  for (const path of removals) exactFilePath(canonical, path)
  const receipt = capabilityPublicationReceiptSchema.parse({
    schema_version: 1,
    work_id: run.work.workId,
    request_sha256: run.work.requestSha256,
    files: files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    removed_paths: removals,
  })
  await run.commits.publish(async (lease) => {
    for (const file of files) await lease.writeBytes(exactFilePath(canonical, file.path), file.bytes)
    for (const path of removals) await lease.remove(exactFilePath(canonical, path))
    await lease.writeJson(exactFilePath(canonical, resultPath(run.work.workId)), receipt)
  })
  return receipt
}

/**
 * 将一个通过校验的步骤精确合并到同一 Work 的候选项目。
 * @param run 拥有候选写入权限的 Run。
 * @param destination Work 候选项目。
 * @param source 独立步骤候选项目。
 * @param receipt 已验证的步骤结果和输入身份。
 */
export async function publishCapabilityStepChanges(
  run: BidRunContext, destination: BidWorkspace, source: BidWorkspace,
  receipt: CapabilityStepReceipt,
): Promise<void> {
  const { removed_paths: removedPaths } = stepReceiptSchema.parse(receipt)
  const paths = receipt.result.changed_artifacts
  if (new Set(paths).size !== paths.length || new Set(removedPaths).size !== removedPaths.length
    || paths.some(path => removedPaths.includes(path))) throw new Error('BID_CAPABILITY_PUBLICATION_DUPLICATE_PATH')
  const files = await Promise.all(paths.map(async (path) => {
    const absolute = exactFilePath(source, path)
    await assertNoLinkedPath(source.root, absolute)
    if (!(await lstat(absolute)).isFile()) throw new Error(`BID_CAPABILITY_PUBLICATION_NOT_FILE: ${path}`)
    const bytes = await readFile(absolute)
    if (receipt.files.find(file => file.path === path)?.sha256 !== sha256(bytes)) {
      throw new Error(`BID_CAPABILITY_STEP_RECEIPT_FILE_MISMATCH: ${path}`)
    }
    return { path, bytes }
  }))
  if (receipt.files.length !== files.length) throw new Error('BID_CAPABILITY_STEP_RECEIPT_FILES_MISMATCH')
  const commits = run.commits.forPublication({ workspaceRoot: destination.root, projectRoot: destination.projectRoot })
  await commits.publish(async (lease) => {
    for (const file of files) await lease.writeBytes(exactFilePath(destination, file.path), file.bytes)
    for (const path of removedPaths) await lease.remove(exactFilePath(destination, path))
    await lease.writeJson(exactFilePath(destination, stepReceiptPath(receipt.step_id)), receipt)
  })
}

/**
 * 候选项目中的步骤凭据可以补齐事务提交后尚未保存的顶层检查点。
 * @param working Work 候选项目。
 * @param stepId Host 分配的步骤身份。
 * @param inputSha256 当前步骤输入摘要；提供时必须与凭据一致。
 * @returns 完整匹配的步骤凭据；尚未提交时为 null。
 */
export async function readCapabilityStepReceipt(
  working: BidWorkspace, stepId: string, inputSha256?: string,
): Promise<CapabilityStepReceipt | null> {
  const absolute = exactFilePath(working, stepReceiptPath(stepId))
  await assertNoLinkedPath(working.root, absolute)
  let raw: string
  try { raw = await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const receipt = stepReceiptSchema.parse(JSON.parse(raw))
  if (receipt.step_id !== stepId || inputSha256 !== undefined && receipt.input_sha256 !== inputSha256) {
    throw new Error('BID_CAPABILITY_STEP_RECEIPT_IDENTITY_MISMATCH')
  }
  for (const file of receipt.files) {
    const path = exactFilePath(working, file.path)
    await assertNoLinkedPath(working.root, path)
    if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== file.sha256) {
      throw new Error(`BID_CAPABILITY_STEP_RECEIPT_FILE_MISMATCH: ${file.path}`)
    }
  }
  for (const removed of receipt.removed_paths) {
    const path = exactFilePath(working, removed)
    await assertNoLinkedPath(working.root, path)
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`BID_CAPABILITY_STEP_RECEIPT_REMOVAL_MISMATCH: ${removed}`)
  }
  return receipt
}
