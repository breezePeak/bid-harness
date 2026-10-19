import type { Session } from '@deepseek-ai/dsh-session'
import type { PromptContentPart } from './api/sessions.ts'
import type { MessageFileRef, PromptFileRef } from './api/files.ts'

/** Host request presented before a browser prompt creates or queues a user message. */
export interface SessionPromptAdmissionRequest {
  session: Session
  mode: 'queue' | 'steer'
  content: readonly PromptContentPart[]
  fileRefs?: readonly PromptFileRef[]
}

/** Domain-owned refusal returned before prompt content becomes durable. */
export interface SessionPromptAdmissionRejection {
  reason: string
  message: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 文件所属实现按当前会话日志和工作区解析不可变引用。
     * @mode serial
     * @param request 当前会话与客户端回传的有序引用。
     */
    'session/prompt-files'(request: { session: Session; refs: readonly PromptFileRef[] }):
      MessageFileRef[] | undefined | Promise<MessageFileRef[] | undefined>
    /**
     * Host-wide prompt admission. The first rejection prevents message creation and Agent dispatch.
     * @mode serial
     * @param request - addressed session and unpersisted browser input.
     */
    'session/prompt-admission'(
      request: SessionPromptAdmissionRequest,
    ): SessionPromptAdmissionRejection | void | Promise<SessionPromptAdmissionRejection | void>
  }
}
