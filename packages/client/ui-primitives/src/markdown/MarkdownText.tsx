/**
 * Untrusted assistant-Markdown renderer over the direct mdast pipeline:
 * `parse.ts` grammars, the incremental streaming parser, and `render.tsx`.
 * While a message streams, all but the trailing two blocks freeze as cached
 * React elements and only the source tail behind them re-parses per chunk,
 * so per-chunk work tracks the tail size instead of the whole reply. Frozen
 * blocks keep their source-offset keys when they cross the freeze boundary,
 * so React reconciles instead of remounting. Known deviation while
 * streaming: a reference-style link or footnote whose definition sits on the
 * other side of the freeze boundary renders literally until the settled
 * full parse self-heals it.
 */

import { memo, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseGfm, parseGfmWithMath } from './parse.ts'
import {
  collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection,
  wrapBlockChildren,
} from './render.tsx'
import type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownRenderContext, ReferenceTargets } from './render.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

export type { MarkdownCodeLabels, MarkdownFileMentions } from './render.tsx'

/** One settled full render: parse with math, resolve references, append the footnote section. */
function renderSettled(
  text: string,
  codeLabels: MarkdownCodeLabels | undefined,
  fileMentions: MarkdownFileMentions | undefined,
  paragraphSourceOffset: number | undefined,
  imageRenderer: MarkdownRenderContext['imageRenderer'],
): ReactNode[] {
  const root = parseGfmWithMath(text)
  const targets = createReferenceTargets()
  collectReferenceTargets(root.children, targets)
  const context: MarkdownRenderContext = {
    streaming: false,
    codeLabels,
    fileMentions,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
    paragraphSourceOffset,
    imageRenderer,
  }
  const blocks = wrapBlockChildren(
    renderBlocks(root.children.map((node, index) => ({ node, key: index })), context),
    false,
  )
  const section = renderFootnoteSection(context)
  return section === null ? blocks : [...blocks, '\n', section]
}

/**
 * Streaming render state for one growing message: the incremental parser,
 * the frozen blocks' cached elements, and the reference/footnote state their
 * rendering consumed (footnote numbering assigned to frozen references is
 * final, so the tail continues from a copy of it each frame).
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm)
  private generation = -1
  private frozenCount = 0
  private frozenElements: ReactNode[] = []
  private frozenTargets: ReferenceTargets = createReferenceTargets()
  private frozenFootnoteOrder: string[] = []
  private frozenFootnoteCounts = new Map<string, number>()
  private lastText: string | null = null
  private lastRendered: ReactNode[] = []

  /** @param codeLabels - Fence copy labels baked into cached elements; the owner replaces the renderer when they change. */
  constructor(private readonly codeLabels: MarkdownCodeLabels | undefined) {}

  /**
   * Render the current accumulated text. Idempotent per text value, so React
   * may re-execute the calling render freely.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements, re-rendered tail, and the footnote section.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) return this.lastRendered
    const { frozen, tail, generation } = this.parser.update(text)
    if (generation !== this.generation) {
      this.generation = generation
      this.frozenCount = 0
      this.frozenElements = []
      this.frozenTargets = createReferenceTargets()
      this.frozenFootnoteOrder = []
      this.frozenFootnoteCounts = new Map()
    }
    const newlyFrozen = frozen.slice(this.frozenCount)
    collectReferenceTargets(newlyFrozen.map(block => block.node), this.frozenTargets)
    // Targets visible this frame: everything frozen so far plus the current
    // tail parse — a newly frozen block's references resolved against the
    // same parse tree its definitions came from.
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    }
    collectReferenceTargets(tail.map(block => block.node), frameTargets)
    if (newlyFrozen.length > 0) {
      const frozenContext: MarkdownRenderContext = {
        streaming: true,
        codeLabels: this.codeLabels,
        fileMentions: undefined,
        targets: frameTargets,
        footnoteOrder: this.frozenFootnoteOrder,
        footnoteCounts: this.frozenFootnoteCounts,
      }
      // Separator newlines are cached alongside the elements so the
      // assembled children match the settled pipeline's block wrapping.
      const batch = [...this.frozenElements]
      for (const element of renderBlocks(newlyFrozen, frozenContext)) {
        if (batch.length > 0) batch.push('\n')
        batch.push(element)
      }
      this.frozenElements = batch
      this.frozenCount = frozen.length
    }
    const tailContext: MarkdownRenderContext = {
      streaming: true,
      codeLabels: this.codeLabels,
      fileMentions: undefined,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    }
    const children = [...this.frozenElements]
    for (const element of renderBlocks(tail, tailContext)) {
      if (children.length > 0) children.push('\n')
      children.push(element)
    }
    const section = renderFootnoteSection(tailContext)
    if (section !== null) children.push('\n', section)
    this.lastText = text
    this.lastRendered = children
    return this.lastRendered
  }
}

/**
 * 将不可信 Markdown 渲染为语义 React 元素。
 * @param props 原始 Markdown 及呈现选项。streaming 增量解析并保持代码和 TeX 为文字，完成后应用高亮和 KaTeX。
 * codeLabels 的对象身份须在同一语言版本内稳定，否则会重建流式缓存。fileMentions 与 imageRenderer 只在非流式文档中
 * 呈现调用方确认的文件或图片，避免冻结尚未确定的处理器。paragraphSourceOffset 保留原始正文的段落位置。
 * @returns 支持 GFM 与数学公式的文档；默认禁用原始 HTML、相对链接及不安全协议，未命中的图片只允许绝对 HTTP(S)。
 */
export const MarkdownText = memo(function MarkdownText({
  text, streaming = false, codeLabels, fileMentions, paragraphSourceOffset, imageRenderer,
}: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
  fileMentions?: MarkdownFileMentions | undefined
  /** Annotate settled top-level paragraphs with UTF-16 source offsets, including this omitted source prefix. */
  paragraphSourceOffset?: number | undefined
  /** 非流式文档中已授权图片的呈现；不匹配时保持默认 URL 过滤。 */
  imageRenderer?: MarkdownRenderContext['imageRenderer']
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownCodeLabels | undefined>(codeLabels)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, codeLabels, fileMentions, paragraphSourceOffset, imageRenderer)
    }
    if (streamRef.current === null || streamLabelsRef.current !== codeLabels) {
      streamRef.current = new StreamingRenderer(codeLabels)
      streamLabelsRef.current = codeLabels
    }
    return streamRef.current.render(text)
  }, [text, streaming, codeLabels, fileMentions, paragraphSourceOffset, imageRenderer])
  return <div className={css.markdown}>{children}</div>
})
