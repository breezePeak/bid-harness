import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { fillBidCover } from '../src/docx-cover.ts'
import { inspectDocxTemplateStructure } from '../src/docx-compose.ts'
import { readBuiltInDocxTemplateBytes } from '../src/docx-format-store.ts'

describe('内置技术标 DOCX 模板', () => {
  it('保留封面、真实目录字段、技术偏离表锚点和纵横纵分节', async () => {
    const bytes = await readBuiltInDocxTemplateBytes()
    const zip = await JSZip.loadAsync(bytes)
    const [document, settings] = await Promise.all([
      zip.file('word/document.xml')!.async('string'),
      zip.file('word/settings.xml')!.async('string'),
    ])
    for (const tag of [
      'dsh-cover-project-name', 'dsh-cover-project-code', 'dsh-cover-bidder-name', 'dsh-cover-date',
      'dsh-toc', 'dsh-technical-deviation-table', 'dsh-fill-index', 'dsh-fill-subject',
      'dsh-fill-requirement', 'dsh-fill-response', 'dsh-fill-deviation', 'dsh-fill-remark', 'dsh-body',
    ]) expect(document).toContain(`w:val="${tag}"`)
    expect(document).toContain('TOC \\o "1-6" \\h \\z \\u')
    expect(settings).toMatch(/<w:updateFields w:val="true"\s*\/>/u)
    expect(document.match(/w:orient="landscape"/gu)).toHaveLength(1)
    expect(await inspectDocxTemplateStructure(bytes)).toMatchObject({ bodyAnchor: 'content-control' })
  })

  it('只按稳定 tag 填充封面字段并保留 TOC', async () => {
    const filled = await fillBidCover(await readBuiltInDocxTemplateBytes(), {
      projectName: '智慧平台项目', projectCode: 'P-001', bidderName: '示例投标人', date: '2026年09月20日',
    })
    const document = await (await JSZip.loadAsync(filled)).file('word/document.xml')!.async('string')
    for (const value of ['智慧平台项目', '项目编号：P-001', '投标人：示例投标人', '日期：2026年09月20日']) {
      expect(document).toContain(value)
    }
    expect(document).toContain('TOC \\o "1-6" \\h \\z \\u')
  })
})
