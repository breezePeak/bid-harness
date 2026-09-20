import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export type RevisionDiffKind = 'equal' | 'insert' | 'delete' | 'modify'

/** 一行左右严格对应的 Markdown 顶层块。 */
export interface RevisionDiffRow {
  readonly id: string
  readonly kind: RevisionDiffKind
  readonly after: string | null
  readonly before: string | null
}

function markdownBlocks(source: string): string[] {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const children = tree.children[0]?.type === 'heading' && tree.children[0].depth === 1
    ? tree.children.slice(1)
    : tree.children
  return children.flatMap((node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    return start === undefined || end === undefined ? [] : [source.slice(start, end)]
  })
}

function signature(block: string): string {
  return block.replaceAll('\r\n', '\n').trim()
}

/**
 * 将前后 Markdown 拆为共享行；after 固定在左，before 固定在右。
 * @param beforeMarkdown 本次修订前的完整章节正文。
 * @param afterMarkdown 本次修订后的完整章节正文。
 * @returns 由相同块锚定、差异 gap 顺序配对的行。
 */
export function buildRevisionDiffRows(beforeMarkdown: string, afterMarkdown: string): RevisionDiffRow[] {
  const before = markdownBlocks(beforeMarkdown)
  const after = markdownBlocks(afterMarkdown)
  const beforeSignatures = before.map(signature)
  const afterSignatures = after.map(signature)
  // ponytail: O(n²) is bounded by top-level chapter blocks; replace only if real chapters make this measurable.
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      lengths[left]![right] = beforeSignatures[left] === afterSignatures[right]
        ? 1 + lengths[left + 1]![right + 1]!
        : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!)
    }
  }
  const anchors: Array<readonly [number, number]> = []
  let left = 0
  let right = 0
  while (left < before.length && right < after.length) {
    if (beforeSignatures[left] === afterSignatures[right]) {
      anchors.push([left++, right++])
    } else if (lengths[left + 1]![right]! >= lengths[left]![right + 1]!) left++
    else right++
  }

  const rows: RevisionDiffRow[] = []
  let beforeCursor = 0
  let afterCursor = 0
  const appendGap = (beforeEnd: number, afterEnd: number): void => {
    const beforeSize = beforeEnd - beforeCursor
    const afterSize = afterEnd - afterCursor
    const size = Math.max(beforeSize, afterSize)
    for (let index = 0; index < size; index++) {
      const beforeBlock = index < beforeSize ? before[beforeCursor + index]! : null
      const afterBlock = index < afterSize ? after[afterCursor + index]! : null
      rows.push({
        id: `row-${String(rows.length)}`,
        kind: beforeBlock === null ? 'insert' : afterBlock === null ? 'delete' : 'modify',
        after: afterBlock,
        before: beforeBlock,
      })
    }
    beforeCursor = beforeEnd
    afterCursor = afterEnd
  }
  for (const [beforeIndex, afterIndex] of anchors) {
    appendGap(beforeIndex, afterIndex)
    rows.push({ id: `row-${String(rows.length)}`, kind: 'equal', after: after[afterIndex]!, before: before[beforeIndex]! })
    beforeCursor = beforeIndex + 1
    afterCursor = afterIndex + 1
  }
  appendGap(before.length, after.length)
  return rows
}
