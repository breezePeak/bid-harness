import type { Session } from '@deepseek-ai/dsh-session'
import type { PromptContentPart } from './api/sessions.ts'

/** Host request presented before a browser prompt creates or queues a user message. */
export interface SessionPromptAdmissionRequest {
  session: Session
  mode: 'queue' | 'steer'
  content: readonly PromptContentPart[]
}

/** Domain-owned refusal returned before prompt content becomes durable. */
export interface SessionPromptAdmissionRejection {
  reason: string
  message: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Host prompt admission. The first rejection prevents message creation and Agent dispatch.
     * @mode serial
     * @param request - addressed session and unpersisted browser input.
     */
    'session/prompt-admission'(
      request: SessionPromptAdmissionRequest,
    ): SessionPromptAdmissionRejection | void | Promise<SessionPromptAdmissionRejection | void>
  }
}
