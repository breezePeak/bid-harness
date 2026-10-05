/** S5 Main Agent 对已完成章节的有界只读访问。 */
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { chapterToolArgs, type ChapterProtocol } from './chapter-writing-protocol.ts'

/** 可由整书审核按需读取的当前章节正文。 */
export interface CompletedChapterBody {
  readonly markdown: string
  readonly content_sha256: string
}

/** 当前协议生成的正文引用。 */
export interface CompletedChapterQuote {
  readonly section_id: string
  readonly quote: string
}

/**
 * 注册按字符窗口读取当前章节的私有工具。
 * @param runtime 当前整书审核协议。
 * @param chapterBodies 当前已完成章节及正文身份。
 * @param sectionIds 模型输入的章节位置顺序；省略时使用正文 Map 的顺序。
 * @param quotePositionOffset 当前审核已有依据的数量；新正文引用的位置接在其后。
 * @returns 本轮读取生成的引用；协议提交时据此绑定原文。
 */
export function registerCompletedChapterReader<T>(
  runtime: ChapterProtocol<T>,
  chapterBodies: ReadonlyMap<string, CompletedChapterBody>,
  sectionIds: readonly string[] = [...chapterBodies.keys()],
  quotePositionOffset = 0,
): ReadonlyMap<string, CompletedChapterQuote> {
  const quoteRefs = new Map<string, CompletedChapterQuote>()
  runtime.register({
    name: 'read_completed_chapter',
    description: '按 section_position 读取当前已完成章节的有界正文片段；只读，不修改 Artifact。',
    parameters: {
      type: 'object', properties: {
        section_position: { type: 'integer' }, start: { type: 'integer' }, length: { type: 'integer' },
      }, required: ['section_position', 'start', 'length'], additionalProperties: false,
    },
    execute(args) {
      const input = chapterToolArgs(z.object({
        section_position: z.number().int().nonnegative(), start: z.number().int().nonnegative(),
        length: z.number().int().min(1).max(12_000),
      }).strict(), args)
      const sectionId = sectionIds[input.section_position]
      const chapter = sectionId === undefined ? undefined : chapterBodies.get(sectionId)
      if (chapter === undefined || sectionId === undefined) throw new ToolArgsError([`section_position: 未知或未完成章节位置 ${input.section_position}。`])
      const quote = chapter.markdown.slice(input.start, input.start + input.length)
      if (quote.length === 0) throw new ToolArgsError(['start: 超出当前章节正文。'])
      const ref = `DQ${quoteRefs.size + 1}`
      quoteRefs.set(ref, { section_id: sectionId, quote })
      return Promise.resolve({
        quote_position: quotePositionOffset + quoteRefs.size - 1, section_position: input.section_position,
        start: input.start, end: input.start + quote.length, markdown: quote,
        truncated: input.start + quote.length < chapter.markdown.length,
      })
    },
  })
  return quoteRefs
}
