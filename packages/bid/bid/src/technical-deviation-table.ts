/** 固定技术偏离表章节的 Markdown 解析与 S2 行级校验。 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { TenderRequirementsArtifact } from './tender-analysis-artifacts.ts'

type Node = { type: string; value?: string; children?: Node[] }
type Requirement = TenderRequirementsArtifact['requirements'][number]

/** 固定技术偏离表的客户可见标准列。 */
export const TECHNICAL_DEVIATION_HEADERS = [
  '序号',
  '标的名称',
  '招标技术要求',
  '投标响应内容',
  '偏离程度',
  '备注',
] as const

/** 一条归一化后的六列技术偏离记录。 */
export interface TechnicalDeviationRow {
  readonly index: string
  readonly subject: string
  readonly requirement: string
  readonly response: string
  readonly deviation: string
  readonly remark: string
}

/** 唯一技术偏离表中的已解析数据行。 */
export interface TechnicalDeviationTable {
  readonly rows: TechnicalDeviationRow[]
}

/** 技术偏离表缺失或结构无效。 */
export class TechnicalDeviationTableError extends Error {
  constructor(public readonly code: 'TECHNICAL_DEVIATION_TABLE_MISSING' | 'TECHNICAL_DEVIATION_HEADERS_INVALID') {
    super(code === 'TECHNICAL_DEVIATION_TABLE_MISSING' ? '正文缺少技术偏离表。' : '技术偏离表必须且只能包含一张具有六个必要列的表格。')
  }
}

const aliases: Record<keyof TechnicalDeviationRow, readonly string[]> = {
  index: ['序号', '编号'],
  subject: ['标的名称', '项目名称', '标的'],
  requirement: ['招标技术要求', '技术要求', '招标要求', '技术条款'],
  response: ['投标响应内容', '响应内容', '响应情况', '投标响应'],
  deviation: ['偏离程度', '偏离说明'],
  remark: ['备注', '说明'],
}

const semanticKeys = Object.keys(aliases) as Array<keyof TechnicalDeviationRow>
const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join('')
const normalized = (value: string): string => value.normalize('NFKC').replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '').toLowerCase()

function headerKey(value: string): keyof TechnicalDeviationRow | undefined {
  const header = normalized(value)
  return semanticKeys.find(key => aliases[key].some(alias => normalized(alias) === header))
}

/**
 * 解析唯一的六列技术偏离 Markdown 表格。
 * @param markdown S5 Writer 提交的章节正文。
 * @returns 按标准语义列归一化的数据行。
 * @throws {TechnicalDeviationTableError} 表格缺失、重复或缺少必要列。
 */
export function parseTechnicalDeviationTable(markdown: string): TechnicalDeviationTable {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node
  const tables = (root.children ?? []).filter(node => node.type === 'table')
  if (tables.length === 0) throw new TechnicalDeviationTableError('TECHNICAL_DEVIATION_TABLE_MISSING')
  const matches = tables.flatMap((table) => {
    const rows = table.children ?? []
    const headerCells = rows[0]?.children ?? []
    const keys = headerCells.map(cell => headerKey(text(cell)))
    return headerCells.length === TECHNICAL_DEVIATION_HEADERS.length
      && keys.every((key): key is keyof TechnicalDeviationRow => key !== undefined)
      && new Set(keys).size === TECHNICAL_DEVIATION_HEADERS.length
      ? [{ rows, keys }] : []
  })
  if (tables.length !== 1 || matches.length !== 1) throw new TechnicalDeviationTableError('TECHNICAL_DEVIATION_HEADERS_INVALID')
  const match = matches[0]!
  return {
    rows: match.rows.slice(1).map((row) => {
      const values = Object.fromEntries(match.keys.map((key, index) => [key, text(row.children?.[index] ?? { type: 'text' }).trim()]))
      return values as unknown as TechnicalDeviationRow
    }),
  }
}

function requirementMatches(value: string, requirement: Requirement): boolean {
  const actual = normalized(value)
  return [requirement.raw_text, requirement.normalized_requirement].some((candidate) => {
    const expected = normalized(candidate)
    return actual === expected || (Math.min(actual.length, expected.length) >= 4
      && (actual.includes(expected) || expected.includes(actual)))
  })
}

/**
 * 按 S2 Requirement 顺序及客户可见必要内容校验表格。
 * @param table 已解析的技术偏离表。
 * @param requirements 按权威顺序排列的完整 S2 Requirements。
 * @returns 具体行级问题；空数组表示允许持久化。
 */
export function validateTechnicalDeviationTable(
  table: TechnicalDeviationTable,
  requirements: readonly Requirement[],
): string[] {
  const issues: string[] = []
  if (table.rows.length !== requirements.length) issues.push(`期望 ${requirements.length} 行，实际 ${table.rows.length} 行。`)
  for (const [index, row] of table.rows.entries()) {
    const number = index + 1
    if (row.index.trim() === '') issues.push(`第 ${number} 行“序号”为空。`)
    if (row.subject.trim() === '') issues.push(`第 ${number} 行“标的名称”为空。`)
    else if (/^(?:xxx|待填写|待补充|项目名称)$/iu.test(row.subject.trim())) issues.push(`第 ${number} 行“标的名称”是占位内容。`)
    if (row.requirement.trim() === '') issues.push(`第 ${number} 行“招标技术要求”为空。`)
    else if (requirements[index] !== undefined && !requirementMatches(row.requirement, requirements[index])) {
      issues.push(`第 ${number} 行“招标技术要求”未按 S2 Requirement 原顺序对应。`)
    }
    const response = row.response.trim()
    if (response === '') issues.push(`第 ${number} 行“投标响应内容”为空。`)
    else if (normalized(response).length < 12 || /^(?:满足|响应|符合|完全满足|完全响应|无偏离|符合招标要求)$/u.test(normalized(response))) {
      issues.push(`第 ${number} 行“投标响应内容”缺少具体响应。`)
    }
    if (row.deviation.trim() === '') issues.push(`第 ${number} 行“偏离程度”为空。`)
    if (Object.values(row).some(value => /\b(?:REQ|SC|RP|SEC)-[A-Za-z0-9_-]+\b/iu.test(value))) {
      issues.push(`第 ${number} 行包含系统内部编号。`)
    }
  }
  return issues
}
