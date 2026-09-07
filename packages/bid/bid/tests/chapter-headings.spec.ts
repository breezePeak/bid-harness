import { describe, expect, it } from 'vitest'
import { normalizeChapterHeadings, validateChapterHeadings } from '../src/chapter-headings.ts'

describe('按确认目录生成正文编号', () => {
  it('仅补齐确认根标题，旧正文标题保留原文且不再产生子编号', () => {
    const input = '## 项目背景\n\n### 1. 监管任务\n\n#### 1.1 业务范围\n\n### 4、实施要求\n\n正文。'
    const result = normalizeChapterHeadings(input, '项目背景', 'S021', '2.1')
    expect(result).toBe('# 2.1 项目背景\n\n### 1. 监管任务\n\n#### 1.1 业务范围\n\n### 4、实施要求\n\n正文。')
    expect(normalizeChapterHeadings(result, '项目背景', 'S021', '2.1')).toBe(result)
  })

  it('不修改列表、代码块、比例尺和标准编号；补充缺失的章节标题', () => {
    const input = '说明。\n\n1. 列表项\n\n```md\n# 1. 原文\n```\n\n### 1:500 地形图\n\n#### GB/T 19001 要求'
    expect(normalizeChapterHeadings(input, '测绘方案', 'S030', '3')).toBe(
      '# 3 测绘方案\n\n说明。\n\n1. 列表项\n\n```md\n# 1. 原文\n```\n\n### 1:500 地形图\n\n#### GB/T 19001 要求',
    )
  })

  it.each(['# 新章', '## 新章', '### 新章', '#### 新章', '##### 新章', '###### 新章', '新章\n===', '新章\n---', '> ## 新章', '- ### 新章'])('拒绝叶节内额外的标题：%s', (heading) => {
    expect(validateChapterHeadings(`# 项目背景\n\n${heading}`, '项目背景', 'S021')).toEqual([expect.stringContaining('不能新增目录标题“新章”')])
  })

  it.each(['', '# 项目背景\n\n', '## 2.1 项目背景\n\n', '# S021\n\n', '项目背景\n===\n\n'])('允许可省略的当前根标题及普通正文：%s', (heading) => {
    const markdown = `${heading}背景说明。\n\n1. 需求说明\n\n- 工作目标\n\n\`\`\`md\n## 标题示例原文\n\`\`\`\n\n| 要求 | 说明 |\n| --- | --- |\n| 范围 | 项目范围 |`
    expect(validateChapterHeadings(markdown, '项目背景', 'S021')).toEqual([])
  })

  it('当前章标题不能出现在正文后或重复出现，也不能替换为其他章名', () => {
    for (const markdown of ['说明。\n\n# 项目背景', '# 项目背景\n\n# 项目背景', '# 内业判定\n\n作业步骤。']) {
      expect(validateChapterHeadings(markdown, '项目背景', 'S021')).toHaveLength(1)
    }
  })
})
