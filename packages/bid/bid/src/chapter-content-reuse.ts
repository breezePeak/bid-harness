/** 将已写正文按完整 Markdown 块分配给调整后的章节。 */
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { z } from 'zod'
import { parseChapterMetadata, type ChapterMetadata } from './chapter-writing-artifacts.ts'
import type { OutlineSection } from './outline-generation-artifacts.ts'
import { normalizeFlowchartInputs, validateFlowchartAnchors, type FlowchartSpec } from './flowchart.ts'
import { webMaterialIdentity } from './evidence-mapping-artifacts.ts'
import { missingTableCaptionLines } from './docx-numbering.ts'

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
 * @param originalTexts 正式原文块；候选中粘连的原块按其完整文字恢复边界。
 * @returns 保留原偏移和字节内容的顶层块。
 */
export function indexChapterContentBlocks(sectionId: string, markdown: string,
  originalTexts?: ReadonlySet<string>,
): ChapterContentBlock[] {
  const sourceHash = sha256(markdown)
  const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children
  const ranges: { end: number; type: string }[] = []
  const append = (text: string, offset: number) => {
    for (const node of parse(text)) {
      const end = node.position?.end.offset
      if (end === undefined) throw new Error('BID_CHAPTER_REUSE_BLOCK_RANGE_INVALID')
      ranges.push({ end: offset + end, type: node.type })
    }
  }
  let offset = 0
  while (offset < markdown.length) {
    const match = [...originalTexts ?? []].map(text => ({ text, start: markdown.indexOf(text, offset) }))
      .filter(item => item.text.length > 0 && item.start >= 0)
      .sort((left, right) => left.start - right.start || right.text.length - left.text.length)[0]
    if (match === undefined) {
      append(markdown.slice(offset), offset)
      break
    }
    append(markdown.slice(offset, match.start), offset)
    append(match.text, match.start)
    offset = match.start + match.text.length
  }
  if (ranges.length === 0 && markdown.length > 0) throw new Error('BID_CHAPTER_REUSE_UNPARSEABLE_SOURCE')
  let start = 0
  return ranges.map((range, index) => {
    const end = index === ranges.length - 1 ? markdown.length : range.end
    if (end <= start || end > markdown.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_RANGE_INVALID')
    const text = markdown.slice(start, end)
    const block = { block_id: `${sectionId}:${String(index + 1).padStart(4, '0')}`,
      source_section_id: sectionId, source_sha256: sourceHash, start, end, type: range.type,
      sha256: sha256(text), markdown: text }
    start = end
    return block
  })
}

/**
 * 找出必须迁入同一组目标章节的表格引导、表题、表格及流程图引用。
 * @param blocks 按源正文顺序排列的完整块。
 * @param originalTexts 正式原文块；相同副本须具有相同归属。
 * @returns 相互关联的源块身份组。
 */
export function chapterContentBlockGroups(
  blocks: readonly ChapterContentBlock[], originalTexts?: ReadonlySet<string>,
): readonly (readonly string[])[] {
  const groups: string[][] = []
  for (const [index, block] of blocks.entries()) {
    const previous = blocks[index - 1]
    if (block.type === 'table' && previous?.type === 'paragraph'
      && previous.source_section_id === block.source_section_id
      && missingTableCaptionLines(previous.markdown + block.markdown).length === 0) {
      const introduction = blocks[index - 2]
      groups.push([...(introduction?.type === 'paragraph' && introduction.source_section_id === block.source_section_id
        ? [introduction.block_id] : []), previous.block_id, block.block_id])
    }
    for (const match of block.markdown.matchAll(/\{\{flow_ref:([A-Za-z0-9_-]{1,64})\}\}/gu)) {
      const anchor = blocks.find(item => item.source_section_id === block.source_section_id
        && item.markdown.includes(`{{flowchart:${match[1]}}}`))
      if (anchor !== undefined && anchor.block_id !== block.block_id) groups.push([anchor.block_id, block.block_id])
    }
  }
  for (const text of originalTexts ?? []) {
    const copies = blocks.filter(block => block.markdown.trim() === text)
    if (copies.length > 1) groups.push(copies.map(block => block.block_id))
  }
  return groups
}

/**
 * 从候选草稿中选出原正式正文的保留块及图形，候选新增内容仍可整改。
 * @param markdown 当前分配草稿。
 * @param flowcharts 草稿当前图形定义。
 * @param originals 原授权范围内的正式正文及图形。
 * @returns 需要逐字保留的正文与完整图形定义。
 */
export function selectOriginalChapterContent(markdown: string, flowcharts: readonly FlowchartSpec[],
  originals: readonly { readonly markdown: string; readonly flowcharts: readonly FlowchartSpec[] }[],
): { readonly markdown: string; readonly flowcharts: readonly FlowchartSpec[] } {
  const originalBlocks = new Map<string, number>()
  for (const original of originals) for (const block of indexChapterContentBlocks('original', original.markdown)) {
    if (block.type === 'heading') continue
    const text = block.markdown.trim()
    originalBlocks.set(text, (originalBlocks.get(text) ?? 0) + 1)
  }
  const chartHash = (chart: FlowchartSpec): string =>
    sha256(JSON.stringify(normalizeFlowchartInputs('preserved', [chart])))
  const retained: { text: string; start: number }[] = []
  for (const [text, count] of originalBlocks) {
    let offset = 0
    for (let copy = 0; copy < count; copy++) {
      const start = markdown.indexOf(text, offset)
      if (start < 0) break
      retained.push({ text, start })
      offset = start + text.length
    }
  }
  const preservedMarkdown = retained.sort((left, right) => left.start - right.start).map(block => block.text).join('\n\n')
  const chartsByKey = new Map<string, Map<string, FlowchartSpec>>()
  for (const original of originals) for (const chart of original.flowcharts) {
    const key = chart.key?.trim() || chart.id
    if (!preservedMarkdown.includes(`{{flowchart:${key}}}`)) continue
    const definitions = chartsByKey.get(key) ?? new Map<string, FlowchartSpec>()
    definitions.set(chartHash(chart), chart)
    chartsByKey.set(key, definitions)
  }
  const preservedCharts: FlowchartSpec[] = []
  for (const [key, definitions] of chartsByKey) {
    const matching = flowcharts.filter(chart => (chart.key?.trim() || chart.id) === key && definitions.has(chartHash(chart)))
    const identities = new Set(matching.map(chartHash))
    const identity = identities.size === 1 ? identities.values().next().value : undefined
    const chart = definitions.size === 1 ? definitions.values().next().value
      : identity === undefined ? undefined : definitions.get(identity)
    if (chart === undefined) throw new Error(`BID_CHAPTER_REUSE_ORIGINAL_FLOWCHART_AMBIGUOUS: ${key}`)
    preservedCharts.push(chart)
  }
  return { markdown: preservedMarkdown, flowcharts: preservedCharts }
}

/**
 * 核对每个源块的唯一决定，并只从原文块拼装目标草稿。
 * @param blocks 原章节快照的完整块清单。
 * @param assignments 每块的分配，删减和共享须显式声明。
 * @param targetIds 当前候选目录内可写目标章节。
 * @param allowDeletion 用户是否明确允许删减原文。
 * @param originalCounts 只迁入一个目标的正式原文及原有份数；候选新增副本合并，原有重复保留。
 * @returns 目标章节草稿及实际删除的原文块身份。
 */
export function assignChapterContentBlocks(
  blocks: readonly ChapterContentBlock[], assignments: readonly ChapterBlockAssignment[],
  targetIds: ReadonlySet<string>, allowDeletion: boolean, originalCounts?: ReadonlyMap<string, number>,
): { readonly markdownBySectionId: ReadonlyMap<string, string>; readonly deletedBlockIds: readonly string[] } {
  const byId = new Map(blocks.map(block => [block.block_id, block]))
  if (byId.size !== blocks.length || assignments.length !== blocks.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
  const allocated = new Set<string>()
  const decisions = new Map<string, ChapterBlockAssignment>()
  const output = new Map<string, ChapterContentBlock[]>()
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
    decisions.set(assignment.block_id, assignment)
    const targets = assignment.target_section_ids
    if (new Set(targets).size !== targets.length || targets.some(id => !targetIds.has(id))) {
      throw new Error(`BID_CHAPTER_REUSE_TARGET_INVALID: ${assignment.block_id}`)
    }
    if (originalCounts?.has(block.markdown.trim()) === true && targets.length > 1) {
      throw new Error(`BID_CHAPTER_REUSE_ORIGINAL_TARGET_NOT_UNIQUE: ${assignment.block_id} 的正式原文只能迁入一个目标；其他章节的交接说明须另行编写。`)
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
  }
  if (allocated.size !== blocks.length) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
  for (const group of chapterContentBlockGroups(blocks,
    originalCounts === undefined ? undefined : new Set(originalCounts.keys()))) {
    const destinations = group.map((id) => {
      const assignment = decisions.get(id)
      if (assignment === undefined) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
      return JSON.stringify([assignment.disposition, [...assignment.target_section_ids].sort()])
    })
    if (new Set(destinations).size !== 1) {
      throw new Error(`BID_CHAPTER_REUSE_LINKED_BLOCK_TARGET_MISMATCH: ${group.join('、')} 的表题、表格、流程图引用或相同原文副本须分配到相同目标。`)
    }
  }
  const emittedOriginals = new Map<string, Map<string, number>>()
  for (const block of blocks) {
    const assignment = decisions.get(block.block_id)
    if (assignment === undefined) throw new Error('BID_CHAPTER_REUSE_BLOCK_COVERAGE_INVALID')
    for (const id of assignment.target_section_ids) {
      const text = block.markdown.trim()
      const expected = originalCounts?.get(text)
      const emitted = emittedOriginals.get(id) ?? new Map<string, number>()
      const count = emitted.get(text) ?? 0
      if (expected !== undefined && count >= expected) continue
      if (expected !== undefined) emittedOriginals.set(id, emitted.set(text, count + 1))
      output.set(id, [...output.get(id) ?? [], block])
    }
  }
  return { markdownBySectionId: new Map([...output].map(([id, parts]) => [id, parts.map((block, index) => {
    const previous = parts[index - 1]
    if (previous === undefined) return block.markdown
    const whitespace = (previous.markdown.match(/\s*$/u)?.[0] ?? '') + (block.markdown.match(/^\s*/u)?.[0] ?? '')
    const separator = '\n'.repeat(Math.max(0, 2 - (whitespace.match(/\n/gu)?.length ?? 0)))
    return separator + block.markdown
  }).join('')])),
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
