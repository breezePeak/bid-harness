/** Bid composer references preserve Host content identity and exact Markdown source ranges. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { BidChapterRevisionRequest, BidReviewChapterView } from '@deepseek-ai/dsh-bid/control-plane'

/** The chapter drag payload contains identity only; its current content is read after drop. */
export const CHAPTER_DRAG_TYPE = 'application/vnd.dsh.bid-chapter+json'

/** Display copy stays separate from the submitted source reference and user instruction. */
export interface BidRevisionReference {
  readonly reference: BidChapterRevisionRequest['reference']
  readonly label: string
  readonly preview: string
}

type RevisionState = { reference: BidRevisionReference | null; revision: number }

/**
 * Share one unsent reference between the chapter reader and its session composer.
 * @returns A session-scoped store declaration.
 */
export function createBidRevisionStore(): EngineStoreHandle<RevisionState, {
  setReference: (draft: RevisionState, reference: BidRevisionReference | null) => void
  clearReference: (draft: RevisionState, submitted: BidRevisionReference) => void
}> {
  return defineStore({
    init: (): RevisionState => ({ reference: null, revision: 0 }),
    actions: {
      setReference: (draft, reference: BidRevisionReference | null) => { draft.reference = reference },
      clearReference: (draft, submitted: BidRevisionReference) => {
        if (JSON.stringify(draft.reference) === JSON.stringify(submitted)) draft.reference = null
        draft.revision++
      },
    },
  })
}

/**
 * Resolve a DOM selection to complete adjacent top-level Markdown paragraphs.
 * @param root - The current chapter's rendered body.
 * @param selection - Browser selection captured before opening the context menu.
 * @param chapter - Host chapter snapshot matching the rendered source.
 * @returns The exact source reference, or null for an empty or unsupported selection.
 */
export function selectedParagraphReference(
  root: HTMLElement,
  selection: Selection | null,
  chapter: BidReviewChapterView,
): BidRevisionReference | null {
  if (
    selection === null || selection.isCollapsed || selection.rangeCount !== 1
    || chapter.markdown === null || chapter.content_sha256 === null
  ) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const startParent = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element : range.startContainer.parentElement
  const endParent = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer as Element : range.endContainer.parentElement
  if (startParent?.closest('[data-markdown-paragraph]') == null || endParent?.closest('[data-markdown-paragraph]') == null) return null
  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-paragraph]'))
    .filter((element) => {
      if (!range.intersectsNode(element)) return false
      const contents = document.createRange()
      contents.selectNodeContents(element)
      return range.compareBoundaryPoints(Range.END_TO_START, contents) < 0
        && range.compareBoundaryPoints(Range.START_TO_END, contents) > 0
    })
  const first = paragraphs[0]
  const last = paragraphs.at(-1)
  if (first === undefined || last === undefined) return null
  for (let index = 1; index < paragraphs.length; index++) {
    if (paragraphs[index - 1]?.nextElementSibling !== paragraphs[index]) return null
  }
  const start = Number(first.dataset.sourceStart)
  const end = Number(last.dataset.sourceEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > chapter.markdown.length) return null
  return {
    reference: { scope: 'paragraphs', section_id: chapter.section_id, content_sha256: chapter.content_sha256, start, end, text: chapter.markdown.slice(start, end) },
    label: `${chapter.number} ${chapter.title} · ${paragraphs.length} 段`,
    preview: paragraphs.map(element => element.textContent).join('\n'),
  }
}
