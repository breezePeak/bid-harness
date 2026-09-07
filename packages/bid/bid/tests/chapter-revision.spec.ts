import { describe, expect, it } from 'vitest'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { assertChapterRevisionScope, chapterContentSha256, chapterRevisionRequestSchema, validateChapterRevisionReference } from '../src/chapter-revision.ts'
import type { BidChapterRevisionRequest } from '../src/control-plane-contract.ts'

const markdown = '# 1 章节\n\n保留首段。\n\n重复段落。\n\n重复段落。\n\n保留末段。\n'

function selection(text = '重复段落。\n\n重复段落。'): BidChapterRevisionRequest {
  const start = markdown.indexOf(text)
  return { instruction: '最小修改选中内容', reference: {
    scope: 'paragraphs', section_id: 'SEC-1', content_sha256: chapterContentSha256(markdown),
    start, end: start + text.length, text,
  } }
}

describe('章节修订引用', () => {
  it('接受精确连续段落并通过位置区分重复正文', () => {
    const request = selection()
    expect(() => validateChapterRevisionReference(request, markdown)).not.toThrow()
    expect(() => assertChapterRevisionScope(request, markdown, markdown.replace('重复段落。\n\n重复段落。', '修订第一段。\n\n修订第二段。'))).not.toThrow()
    const second = markdown.lastIndexOf('重复段落。')
    const single = { ...request, reference: { ...request.reference, scope: 'paragraphs' as const, start: second, end: second + '重复段落。'.length, text: '重复段落。' } }
    expect(() => validateChapterRevisionReference(single, markdown)).not.toThrow()
    expect(() => assertChapterRevisionScope(single, markdown, markdown.replace('重复段落。', '错误位置。'))).toThrow(ToolArgsError)
  })

  it('拒绝旧版本、部分段落、跨标题或跨表格的选区', () => {
    expect(() => validateChapterRevisionReference(selection(), `${markdown}\n`)).toThrow('BID_CHAPTER_REVISION_CONFLICT')
    expect(() => validateChapterRevisionReference(selection('重复段'), markdown)).toThrow('BID_CHAPTER_REVISION_SELECTION_INVALID')
    for (const separator of ['## 子标题', '| 项目 | 值 |\n| --- | --- |\n| A | B |']) {
      const body = `# 标题\n\n首段。\n\n${separator}\n\n尾段。\n`
      const text = body.slice(body.indexOf('首段。'), body.indexOf('尾段。') + 3)
      expect(() => validateChapterRevisionReference({ instruction: '修改', reference: {
        scope: 'paragraphs', section_id: 'SEC-1', content_sha256: chapterContentSha256(body),
        start: body.indexOf('首段。'), end: body.indexOf('尾段。') + 3, text,
      } }, body)).toThrow('BID_CHAPTER_REVISION_SELECTION_INVALID')
    }
  })

  it('在接受路径拒绝任何选区外变动，包括标题及尾随空白', () => {
    for (const body of [markdown.replace('章节', '新标题'), markdown.replace('保留末段。', '改了末段。'), markdown.trim()]) {
      expect(() => assertChapterRevisionScope(selection(), markdown, body)).toThrow(ToolArgsError)
    }
    const chapter: BidChapterRevisionRequest = { instruction: '全量重写', reference: {
      scope: 'chapter', section_id: 'SEC-1', content_sha256: chapterContentSha256(markdown),
    } }
    expect(() => assertChapterRevisionScope(chapter, markdown, '# 1 章节\n\n全量重写的正文。\n')).not.toThrow()
  })

  it('网络输入必须携带范围、原文版本及非空意见', () => {
    expect(chapterRevisionRequestSchema.safeParse(selection()).success).toBe(true)
    expect(chapterRevisionRequestSchema.safeParse({ ...selection(), instruction: ' ' }).success).toBe(false)
    expect(chapterRevisionRequestSchema.safeParse({ ...selection(), reference: { section_id: 'SEC-1' } }).success).toBe(false)
  })
})
