/** 任务中由 Host 从消息对象位置绑定的不可变引用。 */
import { z } from 'zod'
import { imageAttachmentRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'

/** 消息中的实际图片块；消息与块位置由程序绑定，不接受模型抄写。 */
export const bidTaskImageRefSchema = z.object({ message_id: z.string().min(1),
  block_position: z.number().int().nonnegative(), attachment: imageAttachmentRefSchema }).strict()
/** 用户消息图片的完整身份。 */
export type BidTaskImageRef = z.infer<typeof bidTaskImageRefSchema>
