import { describe, expect, it } from 'vitest'
import { normalizeChapterHeadings } from '../src/chapter-headings.ts'

describe('按确认目录生成正文编号', () => {
  it('替换模型局部编号，连续编号且重复规范化不改变结果', () => {
    const input = '## 项目背景\n\n### 1. 监管任务\n\n#### 1.1 业务范围\n\n### 4、实施要求\n\n正文。'
    const result = normalizeChapterHeadings(input, '项目背景', 'S021', '2.1')
    expect(result).toBe('# 2.1 项目背景\n\n## 2.1.1 监管任务\n\n### 2.1.1.1 业务范围\n\n## 2.1.2 实施要求\n\n正文。')
    expect(normalizeChapterHeadings(result, '项目背景', 'S021', '2.1')).toBe(result)
  })

  it('不修改列表、代码块、比例尺和标准编号；补充缺失的章节标题', () => {
    const input = '说明。\n\n1. 列表项\n\n```md\n# 1. 原文\n```\n\n### 1:500 地形图\n\n#### GB/T 19001 要求'
    expect(normalizeChapterHeadings(input, '测绘方案', 'S030', '3')).toBe(
      '# 3 测绘方案\n\n说明。\n\n1. 列表项\n\n```md\n# 1. 原文\n```\n\n## 3.1 1:500 地形图\n\n### 3.1.1 GB/T 19001 要求',
    )
  })

  it('正文达到 Markdown 六级上限后重复处理仍保持编号', () => {
    const input = '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F'
    const result = normalizeChapterHeadings(input, '方案', 'S1', '1')
    expect(result).toContain('###### 1.1.1.1.1.2 F')
    expect(normalizeChapterHeadings(result, '方案', 'S1', '1')).toBe(result)
  })
})
