/** 将已写正文按完整 Markdown 块分配给调整后的章节。 */
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { z } from 'zod'
import { parseChapterMetadata, type ChapterMetadata } from './chapter-writing-artifacts.ts'
import type { OutlineSection } from './outline-generation-artifacts.ts'
import { normalizeFlowchartInputs, validateFlowchartAnchors } from './flowchart.ts'
import { webMaterialIdentity } from './evidence-mapping-artifacts.ts'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 可追溯到源章节及原文偏移的完整顶层 Markdown 块。 */
export interface ChapterContentBlock {
  readonly block_id: string
  readonly source_section_id: string
  readonly source_sha256: string
  readonly start: number
  readonly end: number
  readonly type: string
  readonly sha256: string
  readonly markdown: string
}

/** 模型或用户只提交块身份和目标；原文由 Host 从源快照读取。 */
export const chapterBlockAssignmentSchema = z.object({
  block_id: z.string().min(1),
  source_section_id: z.string().min(1),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  block_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  target_section_ids: z.array(z.string().min(1)),
  disposition: z.enum(['move', 'share', 'delete']),
}).strict()

/** 一块原文的目标及显式共享或删减决定。 */
export type ChapterBlockAssignment = z.infer<typeof chapterBlockAssignmentSchema>

/** 从旧正文产生的待写草稿，不属于外部 Evidence 或已审核 Manifest。 */
export const chapterReuseSeedsSchema = z.object({
  schema_version: z.literal(1),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  seeds: z.array(z.object({
    section_id: z.string().min(1), source_section_ids: z.array(z.string().min(1)).min(1),
    content_path: z.string().regex(/^chapters\/sections\/\d{4}\.md$/u),
    metadata_path: z.string().regex(/^chapters\/meta\/\d{4}\.json$/u),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()),
}).strict()

/**
 * 从源正文建立不可截断的块清单，块范围连续覆盖全部原文。
 * @param sectionId 原章节身份。
 * @param markdown 原正文。
 * @returns 保留原偏移和字节内容的顶层块。
 */
export function indexChapterContentBlocks(sectionId: string, markdown: string): ChapterContentBlock[] {
  const sourceHash = sha256(markdown)
  const nodes = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children
  if (nodes.length === 0 && markdown.length > 0) throw new Error('BID_CHAPTER_REUSE_UNPARSEABLE_SOURCE')
  let start = 0
  return nodes.map((node, index) => {
    const end = index === nodes.length - 1 ? markdown.length : node.position?.end.offset
    if (end === undefined || end <= start || end > markdown.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_RANGE_INVALID')
    const text = markdown.slice(start, end)
    const block = { block_id: `${sectionId}:${String(index + 1).padStart(4, '0')}`,
      source_section_id: sectionId, source_sha256: sourceHash, start, end, type: node.type,
      sha256: sha256(text), markdown: text }
    start = end
    return block
  })
}

/**
 * 核对每个源块的唯一决定，并只从原文块拼装目标草稿。
 * @param blocks 原章节快照的完整块清单。
 * @param assignments 每块的分配，删减和共享须显式声明。
 * @param targetIds 当前候选目录内可写目标章节。
 * @param allowDeletion 用户是否明确允许删减原文。
 * @returns 目标章节草稿及实际删除的原文块身份。
 */
export function assignChapterContentBlocks(
  blocks: readonly ChapterContentBlock[], assignments: readonly ChapterBlockAssignment[],
  targetIds: ReadonlySet<string>, allowDeletion: boolean,
): { readonly markdownBySectionId: ReadonlyMap<string, string>; readonly deletedBlockIds: readonly string[] } {
  const byId = new Map(blocks.map(block => [block.block_id, block]))
  if (byId.size !== blocks.length || assignments.length !== blocks.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
  const allocated = new Set<string>()
  const output = new Map<string, string[]>()
  const deleted: string[] = []
  for (const raw of assignments) {
    const assignment = chapterBlockAssignmentSchema.parse(raw)
    const block = byId.get(assignment.block_id)
    if (block === undefined || allocated.has(assignment.block_id)
      || block.source_section_id !== assignment.source_section_id
      || block.source_sha256 !== assignment.source_sha256 || block.sha256 !== assignment.block_sha256) {
      throw new Error(`BID_CHAPTER_REUSE_BLOCK_IDENTITY_INVALID: ${assignment.block_id}`)
    }
    allocated.add(assignment.block_id)
    const targets = assignment.target_section_ids
    if (new Set(targets).size !== targets.length || targets.some(id => !targetIds.has(id))) {
      throw new Error(`BID_CHAPTER_REUSE_TARGET_INVALID: ${assignment.block_id}`)
    }
    if (assignment.disposition === 'delete') {
      if (!allowDeletion || targets.length !== 0) throw new Error('BID_CHAPTER_REUSE_DELETION_UNAUTHORIZED')
      deleted.push(block.block_id)
      continue
    }
    if (targets.length === 0 || assignment.disposition === 'move' && targets.length !== 1
      || assignment.disposition === 'share' && targets.length < 2) {
      throw new Error(`BID_CHAPTER_REUSE_ALLOCATION_INVALID: ${assignment.block_id}`)
    }
    for (const id of targets) output.set(id, [...output.get(id) ?? [], block.markdown])
  }
  if (allocated.size !== blocks.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
  return { markdownBySectionId: new Map([...output].map(([id, parts]) => [id, parts.join('')])),
    deletedBlockIds: deleted }
}

/**
 * 为迁移草稿保留真实资料和流程图规范，不替新章节声称审核或覆盖完成。
 * @param target 当前候选目录的可写目标章节。
 * @param markdown 从真实源块拼成的草稿。
 * @param sources 为此目标提供块的旧章节 metadata。
 * @returns 仍标记待复核的草稿 metadata。
 */
export function reuseChapterMetadata(
  target: OutlineSection, markdown: string, sources: readonly ChapterMetadata[],
): ChapterMetadata {
  if (!target.writable || sources.length === 0) throw new Error('BID_CHAPTER_REUSE_METADATA_SOURCE_INVALID')
  const unique = <T>(values: readonly T[], key: (value: T) => string): T[] =>
    [...new Map(values.map(value => [key(value), value])).values()]
  const handoffs = sources.map(source => source.handoff)
  const keys = new Set([...markdown.matchAll(/\{\{flowchart:([A-Za-z0-9_-]{1,64})\}\}/gu)].map(match => match[1]))
  const flowcharts = unique(sources.flatMap(source => source.flowcharts.filter(flowchart => keys.has(flowchart.key ?? flowchart.id))),
    flowchart => flowchart.key ?? flowchart.id)
  const issues = validateFlowchartAnchors(markdown, flowcharts)
  const references = [...markdown.matchAll(/\{\{flow_ref:([A-Za-z0-9_-]{1,64})\}\}/gu)].map(match => match[1])
  if (references.some(key => !keys.has(key))) issues.push('流程图引用与图锚点分处不同章节。')
  if (issues.length > 0) throw new Error(`BID_CHAPTER_REUSE_FLOWCHART_INVALID: ${issues.join('；')}`)
  const coveredIds = new Set(target.scoring_response_point_ids ?? [])
  const metadata = {
    section_id: target.id,
    covered_must_answer: unique(sources.flatMap(source => source.covered_must_answer)
      .filter(value => target.must_answer.includes(value)), value => value),
    covered_scoring_response_point_ids: unique(sources.flatMap(source => source.covered_scoring_response_point_ids)
      .filter(id => coveredIds.has(id)), id => id),
    covered_scoring_response_points: unique(sources.flatMap(source => source.covered_scoring_response_points)
      .filter(point => target.scoring_response_points.some(item => item.scoring_id === point.scoring_id
        && item.response_point === point.response_point)), point => `${point.scoring_id}\0${point.response_point}`),
    local_materials_used: unique(sources.flatMap(source => source.local_materials_used),
      material => `${material.source_kind}\0${material.file_id}\0${material.chunk}`),
    web_materials_used: unique(sources.flatMap(source => source.web_materials_used), webMaterialIdentity),
    unresolved_topics: unique([...sources.flatMap(source => source.unresolved_topics), '迁移草稿需按新章节任务复核'], value => value),
    handoff: {
      section_id: target.id,
      decisions: unique(handoffs.flatMap(value => value.decisions), value => value),
      terminology: unique(handoffs.flatMap(value => value.terminology), value => value),
      numbers_and_parameters: unique(handoffs.flatMap(value => value.numbers_and_parameters), value => value),
      interfaces: unique(handoffs.flatMap(value => value.interfaces), value => value),
      deployment_constraints: unique(handoffs.flatMap(value => value.deployment_constraints), value => value),
      cross_reference_targets: unique(handoffs.flatMap(value => value.cross_reference_targets)
        .filter(id => id !== target.id), value => value),
      unresolved_topics: unique([...handoffs.flatMap(value => value.unresolved_topics), '迁移草稿需按新章节任务复核'], value => value),
    },
    flowcharts: normalizeFlowchartInputs(target.id, flowcharts),
  }
  return parseChapterMetadata(metadata)
}
