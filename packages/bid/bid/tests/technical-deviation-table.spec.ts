import { describe, expect, it } from 'vitest'
import { parseTechnicalDeviationTable, validateTechnicalDeviationTable } from '../src/technical-deviation-table.ts'
import type { TenderRequirementsArtifact } from '../src/tender-analysis-artifacts.ts'

const requirements: TenderRequirementsArtifact['requirements'] = [
  { id: 'REQ-1', category: '技术', raw_text: '系统应支持统一身份认证。', normalized_requirement: '支持统一身份认证', mandatory: true,
    source_refs: [{ file_id: 'F-1', chunk: 'C-1', line_start: 1, line_end: 1 }] },
  { id: 'REQ-2', category: '技术', raw_text: '系统应提供完整审计日志。', normalized_requirement: '提供完整审计日志', mandatory: true,
    source_refs: [{ file_id: 'F-1', chunk: 'C-1', line_start: 2, line_end: 2 }] },
]

const markdown = (firstResponse = '我方将配置统一身份认证并完成联调验证及结果记录。') => `表 技术偏离表

| 编号 | 项目名称 | 技术要求 | 响应情况 | 偏离说明 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 智慧平台 | 系统应支持统一身份认证。 | ${firstResponse} | 满足、响应 | |
| 2 | 智慧平台 | 提供完整审计日志 | 我方将启用完整审计日志并执行留存、检索与核验。 | 无偏离 | |
`

describe('技术偏离表确定性校验', () => {
  it('按语义别名解析六列并按 S2 顺序通过具体响应', () => {
    const table = parseTechnicalDeviationTable(markdown())
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]).toMatchObject({ index: '1', subject: '智慧平台', requirement: '系统应支持统一身份认证。' })
    expect(validateTechnicalDeviationTable(table, requirements)).toEqual([])
  })

  it('拒绝空单元格、行数不符和空泛响应', () => {
    const empty = parseTechnicalDeviationTable(`| 序号 | 标的名称 | 招标技术要求 | 投标响应内容 | 偏离程度 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | | | 满足 | 满足、响应 | |`)
    expect(validateTechnicalDeviationTable(empty, requirements)).toEqual(expect.arrayContaining([
      '期望 2 行，实际 1 行。',
      '第 1 行“标的名称”为空。',
      '第 1 行“招标技术要求”为空。',
      '第 1 行“投标响应内容”缺少具体响应。',
    ]))
  })

  it('拒绝缺列和多表正文', () => {
    expect(() => parseTechnicalDeviationTable('| 技术要求 | 响应内容 |\n| --- | --- |\n| 要求 | 响应 |')).toThrow('六个必要列')
    expect(() => parseTechnicalDeviationTable(`${markdown()}\n${markdown()}`)).toThrow('必须且只能包含一张')
  })
})
