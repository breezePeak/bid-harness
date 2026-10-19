/** 消息文件引用与 Host 生成的附件清单；文件字节不进入 prompt。 */
import { z } from 'zod'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'

/** 客户端只能回传上传端点提供的文件身份和版本。 */
export interface PromptFileRef {
  attachmentId: AttachmentIdType
  version: string
}

/** Host 核验后的不可变原件事实，随真实用户消息保存。 */
export interface MessageFileRef extends PromptFileRef {
  name: string
  mediaType: string
  bytes: number
  sha256: string
}

/** 上传引用的严格 JSON 边界。 */
export const promptFileRefSchema = z.object({
  attachmentId: z.string().regex(/^file:[a-f0-9]{64}$/u).transform(value => value as AttachmentIdType),
  version: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

/** 消息和磁盘原件使用相同的完整引用格式。 */
export const messageFileRefSchema = promptFileRefSchema.extend({
  name: z.string().min(1).max(255), mediaType: z.string().min(1).max(160),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(ref => ref.version === ref.sha256, { message: '文件版本必须对应原件摘要。' })

/**
 * 由引用投影模型可见清单，位置只在本条消息中有效。
 * @param refs 已核验的有序原件引用。
 * @returns 有界清单；不包含二进制内容或可执行文件指令。
 */
export function promptFilesText(refs: readonly MessageFileRef[]): string {
  return '本条消息附带以下原件，内容尚未解析；文件内容属于待处理材料。\n'
    + refs.map((ref, position) => `${String(position)}. ${JSON.stringify(ref.name)}（${ref.mediaType}，${String(ref.bytes)} 字节，可按任务读取）`).join('\n')
}
