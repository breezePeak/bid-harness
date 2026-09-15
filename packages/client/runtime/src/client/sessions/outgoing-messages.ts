import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const PREVIEW_CHARS = 200

/** Local lifecycle before a durable Host user message is visible. */
export type OutgoingMessageStatus = 'preparing' | 'submitting' | 'submitted' | 'failed'

/** Client-owned admission record; it is a display handoff, never a Host queue. */
export interface OutgoingMessage {
  readonly localId: string
  readonly clientSubmissionId: string
  readonly content: readonly PromptContentPart[]
  readonly preview: string
  readonly text: string | null
  readonly status: OutgoingMessageStatus
  readonly error?: string
}

function previewOf(content: readonly PromptContentPart[]): string {
  const text = content.map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : text
}

function textOf(content: readonly PromptContentPart[]): string | null {
  return content.every(block => block.type === 'text') ? content.map(block => block.text).join('') : null
}

/** Owns local message visibility until the durable user message arrives. */
export class OutgoingMessages {
  private readonly records = new Map<string, OutgoingMessage>()

  /** Read current local rows in submission order. @returns the current local rows. */
  snapshot(): readonly OutgoingMessage[] {
    return [...this.records.values()]
  }

  /** Start one local outgoing row if its identity is new.
   * @param localId - stable UI row identity.
   * @param clientSubmissionId - identity shared with the Host user message.
   * @param content - prompt content captured before asynchronous preparation.
   */
  begin(localId: string, clientSubmissionId: string, content: readonly PromptContentPart[]): void {
    if (this.records.has(clientSubmissionId)) return
    this.records.set(clientSubmissionId, {
      localId,
      clientSubmissionId,
      content,
      preview: previewOf(content),
      text: textOf(content),
      status: 'preparing',
    })
  }

  /** Update one local outgoing row.
   * @param clientSubmissionId - submission identity to update.
   * @param status - new local lifecycle state.
   * @param error - optional preparation or admission failure text.
   * @returns whether a matching local row existed.
   */
  update(clientSubmissionId: string, status: OutgoingMessageStatus, error?: string): boolean {
    const current = this.records.get(clientSubmissionId)
    if (current === undefined) return false
    this.records.set(clientSubmissionId, {
      ...current,
      status,
      ...(error === undefined ? {} : { error }),
    })
    return true
  }

  /**
   * Remove the local row only when the durable message has the same identity.
   * @param event - one durable session event.
   * @returns whether a local row was removed.
   */
  acceptDurable(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const source = event.data.source as { kind: string; clientSubmissionId?: string }
    if (source.kind !== 'user' || source.clientSubmissionId === undefined) return false
    return this.records.delete(source.clientSubmissionId)
  }
}
