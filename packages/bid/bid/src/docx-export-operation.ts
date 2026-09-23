/** 独立 Word 导出任务的持久事件数据和纯投影。 */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { DocxTemplateId } from './docx-format-contract.ts'

/** Browser-safe, replayable state of the latest independent Word export. */
export const BID_DOCX_EXPORT_PROJECTION_KEY = 'bid.docx_export'

const base = z.object({
  operationId: z.string().min(1).max(64),
  templateId: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => value as DocxTemplateId).nullable(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['collecting', 'exporting', 'finalizing']),
  message: z.string().min(1).max(500),
})

/** 拒绝缺少结果的完成态及缺少原因的失败态。 */
export const docxExportOperationSchema = z.discriminatedUnion('status', [
  base.extend({ status: z.literal('running') }).strict(),
  base.extend({ status: z.literal('completed'), path: z.string().min(1).max(500), warnings: z.array(z.object({ code: z.string().max(100), message: z.string().max(500) }).strict()).max(20) }).strict(),
  base.extend({ status: z.literal('failed'), error: z.string().min(1).max(500) }).strict(),
])

/** 最近一次 Word 导出的唯一状态、步骤和终态结果。 */
export type DocxExportOperation = z.infer<typeof docxExportOperationSchema>

/**
 * 从 Session 事件还原最近一次独立导出，不改变 Bid 主任务。
 * @param state 上一条导出任务，空日志为 null。
 * @param event 当前 Session 事件。
 * @returns 应用事件后的最近一次导出任务。
 */
export function reduceDocxExportOperation(state: DocxExportOperation | null, event: SessionEvent): DocxExportOperation | null {
  return event.type === 'bid.docx_export.changed' ? event.data.operation : state
}
