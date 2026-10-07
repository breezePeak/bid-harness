/** 原生输入桥接的持久答案、应用状态与跨重启预算；同一 Host 的待处理表串行化写入。 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { BidRunData } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const journalSchema = z.object({
  schema_version: z.literal(1), owner_session_id: z.string().min(1),
  work_id: z.string().min(1), request_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  run_id: z.string().min(1), question_key: z.string().min(1),
  kind: z.enum(['decision', 'capability']),
  phase: z.enum(['pending', 'reading_checkpoint', 'asking', 'answered', 'applying', 'applied', 'failed', 'blocked']),
  attempts: z.number().int().nonnegative(), budget: z.number().int().min(1).max(20),
  decision: z.enum(['continue', 'restart_stage', 'stop']).optional(),
  answer: z.object({ id: z.string().min(1), selected: z.array(z.string()), custom: z.string().max(4000).optional() }).strict().optional(),
  error: z.object({ code: z.string(), message: z.string(), phase: z.string() }).strict().optional(),
}).strict()

/** 一个原 Run 的输入应用记录；答案写入成功之后才发布 received。 */
export type BidInputRecovery = z.infer<typeof journalSchema>

/** 程序从原 Run 绑定记录身份，模型不提供标识或预算。 */
export type BidInputBinding = Pick<BidInputRecovery, 'owner_session_id' | 'work_id' | 'request_sha256' | 'run_id' | 'question_key' | 'kind'>

/**
 * 绑定原 Run 的输入桥接身份。
 * @param ownerSessionId 原授权公开会话。
 * @param run 原挂起 Run。
 * @param kind 输入种类。
 * @param questionKey 原生问题或检查点身份。
 * @returns 只由程序填写的持久化身份。
 */
export function bindBidInputRecovery(ownerSessionId: string, run: BidRunData,
  kind: BidInputBinding['kind'], questionKey: string): BidInputBinding {
  return { owner_session_id: ownerSessionId, work_id: run.work.workId,
    request_sha256: run.work.requestSha256, run_id: run.runId, kind, question_key: questionKey }
}

function journalPath(workspace: BidWorkspace, binding: BidInputBinding): string {
  const key = createHash('sha256').update(JSON.stringify([binding.owner_session_id, binding.work_id,
    binding.request_sha256, binding.run_id, binding.question_key, binding.kind])).digest('hex')
  return within(workspace.projectRoot, `runs/${binding.work_id}/input-${key}.json`)
}

/**
 * 读取原 Run 的答案和应用状态；缺记录时返回零次尝试的初始状态。
 * @param workspace 原项目。
 * @param binding 当前程序绑定的原 Run 身份。
 * @param budget 当前配置的有限应用预算；增配不扩大旧记录预算。
 * @returns 校验过身份的持久记录。
 */
export async function readBidInputRecovery(workspace: BidWorkspace, binding: BidInputBinding, budget: number): Promise<BidInputRecovery> {
  const path = journalPath(workspace, binding)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1, ...binding, phase: 'pending', attempts: 0, budget }
    throw error
  }
  const record = journalSchema.parse(JSON.parse(raw))
  for (const key of Object.keys(binding) as Array<keyof BidInputBinding>) {
    if (record[key] !== binding[key]) throw Object.assign(new Error('输入记录与原 Work、Run 或问题身份不一致。'),
      { code: 'BID_INPUT_IDENTITY_MISMATCH' })
  }
  return { ...record, budget: Math.min(record.budget, budget) }
}

/**
 * 原子保存答案、尝试预算或应用结算；成功后答案可在重启时重放。
 * @param workspace 原项目。
 * @param record 程序已绑定的输入记录。
 */
export async function writeBidInputRecovery(workspace: BidWorkspace, record: BidInputRecovery): Promise<void> {
  const validated = journalSchema.parse(record)
  const path = journalPath(workspace, validated)
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * 只允许资源暂态故障重试；身份、权限、问题内容和未知原因直接阻断。
 * @param error 当前输入应用的失败原因。
 * @returns 此次失败是否允许在剩余持久预算内重试。
 */
export function retryableBidInputFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ['BID_OPERATION_IN_PROGRESS', 'BID_PROJECT_LOCKED',
    'BID_PROJECT_LOCK_BUSY', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO'].includes(code)
}
