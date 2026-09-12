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
 * @returns 本轮读取生成的引用；协议提交时据此绑定原文。
 */
export function registerCompletedChapterReader<T>(
  runtime: ChapterProtocol<T>,
  chapterBodies: ReadonlyMap<string, CompletedChapterBody>,
): ReadonlyMap<string, CompletedChapterQuote> {
  const quoteRefs = new Map<string, CompletedChapterQuote>()
  runtime.register({
    name: 'read_completed_chapter',
    description: '按 section_id 读取当前已完成章节的有界正文片段；只读，不修改 Artifact。',
    parameters: {
      type: 'object', properties: {
        section_id: { type: 'string' }, start: { type: 'integer' }, length: { type: 'integer' },
      }, required: ['section_id', 'start', 'length'], additionalProperties: false,
    },
    execute(args) {
      const input = chapterToolArgs(z.object({
        section_id: z.string().min(1), start: z.number().int().nonnegative(), length: z.number().int().min(1).max(12_000),
      }).strict(), args)
      const chapter = chapterBodies.get(input.section_id)
      if (chapter === undefined) throw new ToolArgsError([`section_id: 未知或未完成章节 ${input.section_id}。`])
      const quote = chapter.markdown.slice(input.start, input.start + input.length)
      if (quote.length === 0) throw new ToolArgsError(['start: 超出当前章节正文。'])
      const ref = `DQ${quoteRefs.size + 1}`
      quoteRefs.set(ref, { section_id: input.section_id, quote })
      return Promise.resolve({
        quote_ref: ref, section_id: input.section_id, content_sha256: chapter.content_sha256,
        start: input.start, end: input.start + quote.length, markdown: quote,
        truncated: input.start + quote.length < chapter.markdown.length,
      })
    },
  })
  return quoteRefs
}
