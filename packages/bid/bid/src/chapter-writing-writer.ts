/** Writer 的叶节正文校验与资料位置选择；持久化身份全部由 Host 绑定。 */
import { readFile } from 'node:fs/promises'
import { ToolArgsError, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidManifest, BidWorkspace } from './index.ts'
import type { ChapterContext } from './chapter-writing-executor.ts'
import { parseChapterCandidate, type AcceptedChapterCandidate, type BoundChapterCandidate } from './chapter-writing-artifacts.ts'
import { canonicalWebChunkRefs, localEvidenceMaterialSchema, transientWebEvidenceMaterialSchema, type LocalEvidenceMaterial, type WebEvidenceMaterial, webMaterialIdentity } from './evidence-mapping-artifacts.ts'
import { resolveEvidenceChunk } from './evidence-chunk.ts'
import { chapterToolArgs } from './chapter-writing-protocol.ts'
import { validateChapterHeadings } from './chapter-headings.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { normalizeWebEvidenceUrl, parseWebEvidenceSourcesArtifact, webEvidenceContentSha256, type WebEvidenceSource } from './web-evidence-source-artifacts.ts'
import type { WebEvidenceSnapshot } from './web-evidence-snapshot.ts'
import { buildWebEvidenceChunkIndex } from './web-evidence-chunks.ts'
import { bindFlowchartModelAnchors, bindFlowchartModelInputs, flowchartModelDraftSchema, normalizeFlowchartInputs, projectFlowchartModelAnchors, type FlowchartSpec } from './flowchart.ts'
import { indexChapterContentBlocks } from './chapter-content-reuse.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'

const text = z.string().trim().min(1)
const position = z.number().int().nonnegative()
const strings = z.array(text).optional()
const localSemantics = { usage: z.enum(['reference', 'background', 'reuse', 'adapt']), summary: text }
const webSemantics = { usage: z.enum(['reference', 'background']), summary: text, supports: text }
const handoffFields = {
  decisions: strings, terminology: strings, numbers_and_parameters: strings, interfaces: strings,
  deployment_constraints: strings, cross_reference_targets: strings, unresolved_topics: strings,
}
const writerInput = z.object({
  markdown: text,
  metadata: z.object({
    local_materials_used: z.array(z.union([
      z.object({ material_position: position, ...localSemantics }).strict(),
      z.object({ file_position: position, chunk_position: position, ...localSemantics }).strict(),
    ])).optional(),
    web_materials_used: z.array(z.object({ web_position: position, ...webSemantics }).strict()).optional(),
    additional_web_materials: z.array(transientWebEvidenceMaterialSchema).optional(),
    unresolved_topics: strings,
    handoff: z.object(handoffFields).strict().optional(),
    flowcharts: z.array(flowchartModelDraftSchema).max(100).optional(),
  }).strict(),
}).strict()

const stringParameter = { type: 'string' as const }
const positionParameter = { type: 'integer' as const }
const stringArray = { type: 'array' as const, items: stringParameter }
const localProperties = { usage: { type: 'string' as const, enum: ['reference', 'background', 'reuse', 'adapt'] }, summary: stringParameter }
const webProperties = { usage: { type: 'string' as const, enum: ['reference', 'background'] }, summary: stringParameter, supports: stringParameter }

/** Writer 只返回完整正文和语义 metadata；空语义数组可省略。 */
export const chapterWriterOutputSchema: ObjectJsonSchema = {
  type: 'object', properties: {
    markdown: stringParameter,
    metadata: {
      type: 'object', properties: {
        local_materials_used: { type: 'array', items: { oneOf: [
          { type: 'object', properties: { material_position: positionParameter, ...localProperties }, required: ['material_position', 'usage', 'summary'], additionalProperties: false },
          { type: 'object', properties: { file_position: positionParameter, chunk_position: positionParameter, ...localProperties }, required: ['file_position', 'chunk_position', 'usage', 'summary'], additionalProperties: false },
        ] } },
        web_materials_used: { type: 'array', items: { type: 'object', properties: { web_position: positionParameter, ...webProperties }, required: ['web_position', 'usage', 'summary', 'supports'], additionalProperties: false } },
        additional_web_materials: { type: 'array', items: { type: 'object', properties: { url: stringParameter, ...webProperties }, required: ['url', 'usage', 'summary', 'supports'], additionalProperties: false } },
        unresolved_topics: stringArray,
        handoff: { type: 'object', properties: Object.fromEntries(Object.keys(handoffFields).map(key => [key, stringArray])), additionalProperties: false },
        flowcharts: { type: 'array', items: { type: 'object', properties: {
          title: stringParameter, purpose: stringParameter,
          nodes: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string', enum: ['start', 'end', 'process', 'decision', 'document', 'subprocess'] }, text: stringParameter,
          }, required: ['type', 'text'], additionalProperties: false } },
          edges: { type: 'array', items: { type: 'object', properties: {
            from_position: positionParameter, to_position: positionParameter, label: stringParameter,
          }, required: ['from_position', 'to_position'], additionalProperties: false } },
        }, required: ['title', 'nodes', 'edges'], additionalProperties: false } },
      }, additionalProperties: false,
    },
  }, required: ['markdown', 'metadata'], additionalProperties: false,
}

/** 同一章节各次 Writer 尝试共享位置；已发网页材料位置保留，不可重用。 */
export interface ChapterWriterReferences {
  readonly sectionId: string
  readonly materials: ReadonlyMap<string, LocalEvidenceMaterial>
  readonly files: ReadonlyMap<string, ChapterContext['availableLocalCorpus'][number]>
  readonly web: Map<string, WebEvidenceSource & { read_path: string; chunks: ReturnType<typeof buildWebEvidenceChunkIndex>['chunks'] }>
  /** 每个位置唯一绑定来源和精确片段集合；后续材料只追加。 */
  readonly webMaterials: Map<string, Pick<WebEvidenceMaterial, 'source_id' | 'snapshot_path' | 'chunk_refs'>
    & Partial<Pick<WebEvidenceMaterial, 'summary' | 'supports'>>>
  /** source_id 对应的当前不可用原因；包含尚未获发 W 的坏来源。 */
  readonly unavailable: Map<string, string>
  readonly chunks: Map<string, readonly { id: string; path: string; heading_path: string[] }[]>
  readonly dependencyFlowcharts: readonly { readonly chart: FlowchartSpec; readonly chapterTitle: string }[]
}

/**
 * 为当前章节分配稳定的已映射材料和补搜文件编号。
 * @param context 当前章节输入。
 * @param dependencyFlowcharts 已完成强依赖章节的可引用图表，按冻结顺序排列。
 * @returns 章节内文件、分块与精确网页材料位置表，不包含框架 Evidence。
 */
export function createChapterWriterReferences(context: ChapterContext,
  dependencyFlowcharts: ChapterWriterReferences['dependencyFlowcharts'] = []): ChapterWriterReferences {
  return {
    sectionId: context.section.id,
    materials: new Map([...context.relatedMaterials, ...context.referenceBidMaterials].map((value, index) => [`M${index + 1}`, value])),
    files: new Map(context.availableLocalCorpus.filter(file => file.role !== 'outline_framework').map((value, index) => [`F${index + 1}`, value])),
    web: new Map(),
    webMaterials: new Map(context.webMaterials.map(material => [webMaterialIdentity(material), material])),
    unavailable: new Map(),
    chunks: new Map(),
    dependencyFlowcharts,
  }
}

/**
 * 在模型请求前冻结可补充引用的文件块顺序。
 * @param workspace 当前资料工作区。
 * @param refs 当前章节文件和块的位置表。
 */
export async function loadChapterWriterChunkReferences(workspace: BidWorkspace, refs: ChapterWriterReferences): Promise<void> {
  for (const [ref, file] of refs.files) {
    await assertNoLinkedPath(workspace.root, file.chunk_index_path)
    const index = parseDocumentChunkIndex(JSON.parse(await readFile(file.chunk_index_path, 'utf8')))
    refs.chunks.set(ref, index.chunks.map(chunk => ({ id: chunk.id,
      path: file.chunks_path + '/' + chunk.path, heading_path: chunk.heading_path })))
  }
}

/**
 * 读取工作区内无链接的 Web 正文；单来源路径、读取或 Hash 错误以 ToolArgsError 拒绝，其他错误传播。
 * @param workspace 资料工作区。
 * @param source 已登记来源。
 * @returns Hash 验证通过的实际 Web 正文。
 */
export async function readChapterWebSource(workspace: BidWorkspace, source: WebEvidenceSource): Promise<string> {
  let content: string
  try {
    content = await readWebSnapshot(workspace, source.snapshot_path)
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : undefined
    const reason = error instanceof Error ? error.message : ''
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(code ?? '')
      || ['bid-absolute-path', 'bid-path-traversal', 'bid-workspace-path-outside-root', 'bid-workspace-symbolic-link'].includes(reason)) {
      throw new ChapterWebSourceUnavailable([`web_ref: 网页快照不可用：${source.snapshot_path}（${code ?? reason}）`])
    }
    throw error
  }
  if (content.trim().length === 0 || webEvidenceContentSha256(content) !== source.content_sha256) {
    throw new ChapterWebSourceUnavailable([`web_ref: Snapshot Hash 或正文无效：${source.snapshot_path}`])
  }
  return content
}

class ChapterWebSourceUnavailable extends ToolArgsError {}

async function readWebSnapshot(workspace: BidWorkspace, snapshotPath: string): Promise<string> {
  const path = within(workspace.projectRoot, snapshotPath)
  await assertNoLinkedPath(workspace.root, path)
  return readFile(path, 'utf8')
}

/**
 * 复验来源并追加本章核验快照的完整片段材料；来源移除或损坏时保留已发位置，恢复后沿用。
 * @param workspace 当前工作区。
 * @param refs 当前章节稳定引用表。
 * @param sources 当前允许暴露的完整账本来源，不能只传新增来源。
 */
export async function appendChapterWebReferences(
  workspace: BidWorkspace, refs: ChapterWriterReferences, sources: readonly WebEvidenceSource[],
): Promise<void> {
  const currentIds = new Set(sources.map(source => source.source_id))
  refs.unavailable.clear()
  for (const source of refs.web.values()) {
    if (!currentIds.has(source.source_id)) refs.unavailable.set(source.source_id, '来源已从当前账本移除。')
  }
  for (const source of sources) {
    let content: string
    try {
      content = await readChapterWebSource(workspace, source)
    } catch (error: unknown) {
      if (!(error instanceof ChapterWebSourceUnavailable)) throw error
      refs.unavailable.set(source.source_id, error.message)
      continue
    }
    const existing = [...refs.web].find(([, value]) => value.source_id === source.source_id)
    if (existing !== undefined) {
      if (!sameWebIdentity(existing[1], source)) {
        refs.unavailable.set(source.source_id, '当前账本与已发 W 的来源身份不匹配。')
        continue
      }
    } else {
      refs.web.set(`W${refs.web.size + 1}`, { ...source, read_path: within(workspace.projectRoot, source.snapshot_path).replaceAll('\\', '/'),
        chunks: buildWebEvidenceChunkIndex(source, content).chunks })
    }
    if (source.chapter_context?.section_id === refs.sectionId) {
      const material = { source_id: source.source_id, snapshot_path: source.snapshot_path,
        chunk_refs: buildWebEvidenceChunkIndex(source, content).chunks.map(chunk => chunk.chunk_ref) }
      const key = webMaterialIdentity(material)
      if (!refs.webMaterials.has(key)) refs.webMaterials.set(key, material)
    }
  }
}

function sameWebIdentity(left: WebEvidenceSource, right: WebEvidenceSource): boolean {
  return left.source_id === right.source_id && left.snapshot_path === right.snapshot_path
    && left.content_sha256 === right.content_sha256 && left.final_url === right.final_url
}

/**
 * 向 Writer 提供资料语义、允许用法和可执行读取位置。
 * @param context 当前章节输入及可执行读取位置。
 * @param refs 本章 M/F/W 表。
 * @returns 不把短引用当作文件路径的模型输入。
 */
export function renderChapterWriterReferences(context: ChapterContext, refs: ChapterWriterReferences): string {
  const usage = (role: string) => role === 'reference_bid' ? ['reuse', 'adapt', 'reference', 'background'] : ['reference', 'background']
  const unavailable = new Map(refs.unavailable)
  for (const material of context.webMaterials) {
    const source = [...refs.web.values()].find(value => value.source_id === material.source_id)
    if (unavailable.has(material.source_id)) continue
    if (source === undefined) unavailable.set(material.source_id, '已映射来源不在当前账本中。')
    else if (source.snapshot_path !== material.snapshot_path) unavailable.set(material.source_id, '已映射来源与账本的身份不匹配。')
    else {
      const readable = new Set(context.webReadLocations.filter(location => location.source_id === material.source_id)
        .map(location => location.chunk_ref))
      if (material.chunk_refs.some(ref => !readable.has(ref))) unavailable.set(material.source_id, '已映射 Chunk 索引或引用不可用。')
    }
  }
  return [
    '资料选择使用下列从 0 开始的位置；grep/read 使用表中程序提供的读取路径。实际资料身份与块引用全部由程序绑定。',
    `Dependency Flowcharts：${JSON.stringify(refs.dependencyFlowcharts.map(({ chart, chapterTitle }, reference_position) => ({
      reference_position, title: chart.title, chapter_title: chapterTitle,
    })))}`,
    `Mapped Materials：${JSON.stringify([...refs.materials.values()].map((material, material_position) => ({
      material_position, name: [...refs.files.values()].find(file => file.file_id === material.file_id)?.name,
      role: material.source_kind, allowed_usage: usage(material.source_kind), summary: material.summary,
      read_path: context.localReadLocations.find(value => value.file_id === material.file_id && value.chunk === material.chunk)?.chunk_path,
    })))}`,
    `Available Evidence Files：${JSON.stringify([...refs.files].map(([ref, file], file_position) => ({ file_position, name: file.name, role: file.role,
      allowed_usage: usage(file.role), chunks: (refs.chunks.get(ref) ?? []).map((chunk, chunk_position) => ({
        chunk_position, read_path: chunk.path, heading_path: chunk.heading_path,
      })) })))}`,
    `Verified Web Chunks：${JSON.stringify([...refs.webMaterials.values()].flatMap((material, web_position) => {
      const source = [...refs.web.values()].find(value => value.source_id === material.source_id)
      if (source === undefined || unavailable.has(source.source_id)) return []
      return [{
        web_position, url: source.final_url,
        allowed_usage: ['reference', 'background'], truncated: source.truncated,
        summary: material.summary, supports: material.supports,
        mapped_chunks: source.chunks.filter(chunk => material.chunk_refs.includes(chunk.chunk_ref)).map(chunk => ({
          read_path: source.read_path, offset: chunk.start_line,
          limit: chunk.end_line - chunk.start_line + 1,
        })),
      }]
    }))}`,
    `不可用 Web 来源：${JSON.stringify([...unavailable].map(([source_id, reason]) => ({
      web_positions: [...refs.webMaterials.values()].flatMap((material, position) => material.source_id === source_id ? [position] : []),
      reason,
      mapped_materials: context.webMaterials.filter(material => material.source_id === source_id).map(material => ({
        usage: material.usage, summary: material.summary, supports: material.supports,
      })),
    })))}`,
    '不可用来源不能作为证据引用；对应写作要求仍须回应，请补充有效来源，无法证实时明确记录未解决事项。',
    '本地条目只提交 {material_position, usage, summary} 或 {file_position, chunk_position, usage, summary}，两者不可并用；已登记网页只提交 {web_position, usage, summary, supports}，并仅按 mapped_chunks 给出的行范围读取。新网页提交 {url, usage, summary, supports}，必须有当前 Writer 成功 fetch 的正文。不要抄写任何短引用、文件身份或 chunk 身份。',
  ].join('\n')
}

function uniqueEvidence<T>(values: readonly T[], identity: (value: T) => string, field: string): T[] {
  const found = new Map<string, T>()
  for (const [index, value] of values.entries()) {
    const key = identity(value)
    const previous = found.get(key)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
      throw new ToolArgsError([`${field}.${index}: 相同资料 ${key} 的 usage、summary 或 supports 冲突；请合并为一个明确条目。`])
    }
    found.set(key, value)
  }
  return [...found.values()]
}

/**
 * 按真实 Web 身份合并相同记录，拒绝冲突的语义字段。
 * @param materials 已解析的 Web 引用。
 * @returns 按来源和精确片段集合去重的条目；语义冲突可恢复地拒绝。
 */
export function mergeChapterWebMaterials(materials: readonly WebEvidenceMaterial[]): WebEvidenceMaterial[] {
  const normalized = materials.map(material => ({ ...material, chunk_refs: canonicalWebChunkRefs(material.chunk_refs) }))
  return uniqueEvidence(normalized, webMaterialIdentity, 'metadata.web_materials_used')
}

/**
 * 拒绝正文新增目录，绑定 Writer 资料和图表位置，注入章节身份与 Blueprint 索引；实际网页重读账本和正文，账本读取或解析失败传播，不写文件。
 * @param workspace 资料工作区。
 * @param manifest 当前资料身份。
 * @param context 固定章节输入。
 * @param refs 当前章节引用表。
 * @param value 模型结构化提交参数。
 * @param snapshots 当前 Writer 成功 fetch 的实际正文。
 * @param preservedFlowcharts 须原样复用的迁移流程图，模型不能改写定义。
 * @param preservedMarkdown 须保留的分配原文；原文块占位符由 Host 展开，缺失块拒绝提交。
 * @returns durable candidate parser 可接受的候选，新增 URL 尚待 Host 持久化绑定。
 */
export async function bindChapterWriterInput(
  workspace: BidWorkspace, manifest: BidManifest, context: ChapterContext, refs: ChapterWriterReferences,
  value: unknown, snapshots: readonly WebEvidenceSnapshot[], preservedFlowcharts: readonly FlowchartSpec[] = [],
  preservedMarkdown?: string,
): Promise<BoundChapterCandidate> {
  const input = chapterToolArgs(writerInput, value)
  const flowcharts = normalizeFlowchartInputs(context.section.id, [
    ...preservedFlowcharts, ...bindFlowchartModelInputs(context.section.id, input.metadata.flowcharts ?? [], preservedFlowcharts.length,
      [...preservedFlowcharts, ...refs.dependencyFlowcharts.map(value => value.chart)].map(chart => chart.key ?? chart.id)),
  ])
  const boundMarkdown = bindFlowchartModelAnchors(input.markdown, flowcharts, refs.dependencyFlowcharts.map(value => value.chart))
  const originalBlocks = preservedMarkdown === undefined ? [] : indexChapterContentBlocks(context.section.id, preservedMarkdown)
    .filter(block => block.type !== 'heading' && block.markdown.trim() !== '')
  const markdown = preservedMarkdown === undefined ? boundMarkdown : boundMarkdown.replace(/\{\{reuse:(\d+)\}\}/gu,
    (_marker, position: string) => {
      const block = originalBlocks[Number(position)]
      if (block === undefined) throw new ToolArgsError(['markdown: 未知原文块位置 ' + position])
      return block.markdown.trim()
    })
  const missingBlocks = originalBlocks.flatMap((block, position) => markdown.includes(block.markdown.trim()) ? []
    : ['markdown: 缺少须原样保留的原文块位置 ' + String(position) + '；使用 {{reuse:' + String(position) + '}} 放置原块，再在其周围补充。'])
  if (missingBlocks.length > 0) throw new ToolArgsError(missingBlocks)
  const headingIssues = validateChapterHeadings(markdown, context.section.title, context.section.id)
  if (headingIssues.length > 0) throw new ToolArgsError(headingIssues.map(issue => `markdown: ${issue}`))
  const local: LocalEvidenceMaterial[] = []
  for (const [index, material] of (input.metadata.local_materials_used ?? []).entries()) {
    const path = `metadata.local_materials_used.${index}`
    let identity: Pick<LocalEvidenceMaterial, 'source_kind' | 'file_id' | 'chunk'>
    if ('material_position' in material) {
      const mapped = [...refs.materials.values()][material.material_position]
      if (mapped === undefined) throw new ToolArgsError([`${path}.material_position: 未知位置 ${material.material_position}。`])
      identity = mapped
    } else {
      const entry = [...refs.files][material.file_position]
      const file = entry?.[1]
      const chunk = entry === undefined ? undefined : refs.chunks.get(entry[0])?.[material.chunk_position]
      if (file === undefined || file.role === 'outline_framework' || chunk === undefined) throw new ToolArgsError([`${path}: 未知文件或资料块位置。`])
      identity = { source_kind: file.role, file_id: file.file_id, chunk: chunk.id }
    }
    try {
      const resolved = await resolveEvidenceChunk(workspace, manifest, identity)
      local.push(chapterToolArgs(localEvidenceMaterialSchema, {
        source_kind: identity.source_kind, file_id: identity.file_id, chunk: resolved.entry.id,
        usage: material.usage, summary: material.summary,
      }))
    } catch (error: unknown) {
      throw new ToolArgsError([`${path}: ${error instanceof ToolArgsError ? error.message : `资料或 chunk 无效：${identity.file_id}/${identity.chunk}`}。`])
    }
  }
  const web: WebEvidenceMaterial[] = []
  const webMaterials = input.metadata.web_materials_used ?? []
  let currentSources: readonly WebEvidenceSource[] = []
  if (webMaterials.length > 0) {
    const ledgerPath = within(workspace.projectRoot, 'analysis/web-evidence-sources.json')
    await assertNoLinkedPath(workspace.root, ledgerPath)
    currentSources = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(ledgerPath, 'utf8'))).sources
  }
  for (const [index, material] of webMaterials.entries()) {
    const mapped = [...refs.webMaterials.values()][material.web_position]
    const source = [...refs.web.values()].find(value => value.source_id === mapped?.source_id)
    if (mapped === undefined || source === undefined) throw new ToolArgsError([`metadata.web_materials_used.${index}.web_position: 未知位置 ${material.web_position}。`])
    const current = currentSources.find(value => value.source_id === source.source_id)
    if (current === undefined || !sameWebIdentity(current, source)) {
      throw new ToolArgsError([`metadata.web_materials_used.${index}.web_position: 位置 ${material.web_position} 的来源已从账本移除或身份不匹配。`])
    }
    const content = await readChapterWebSource(workspace, current)
    const chunks = new Set(buildWebEvidenceChunkIndex(current, content).chunks.map(chunk => chunk.chunk_ref))
    if (mapped.snapshot_path !== source.snapshot_path || mapped.chunk_refs.some(ref => !chunks.has(ref))) {
      throw new ToolArgsError([`metadata.web_materials_used.${index}.web_position: 位置 ${material.web_position} 的快照或片段身份不匹配。`])
    }
    web.push({
      source_id: source.source_id, snapshot_path: source.snapshot_path,
      chunk_refs: mapped.chunk_refs,
      usage: material.usage, summary: material.summary, supports: material.supports })
  }
  const additional = input.metadata.additional_web_materials ?? []
  const additionalBound: WebEvidenceMaterial[] = []
  for (const [index, material] of additional.entries()) {
    const url = normalizeWebEvidenceUrl(material.url)
    const snapshot = snapshots.find(snapshot =>
      normalizeWebEvidenceUrl(snapshot.source.requested_url) === url || normalizeWebEvidenceUrl(snapshot.source.final_url) === url)
    if (snapshot === undefined) {
      throw new ToolArgsError([`metadata.additional_web_materials.${index}.url: ${material.url} 缺少当前 Writer 成功 fetch 的真实正文。`])
    }
    additionalBound.push({
      source_id: snapshot.source.source_id, snapshot_path: snapshot.source.snapshot_path,
      chunk_refs: buildWebEvidenceChunkIndex(snapshot.source, snapshot.content).chunks.map(chunk => chunk.chunk_ref),
      usage: material.usage, summary: material.summary, supports: material.supports })
  }
  mergeChapterWebMaterials([...web, ...additionalBound])
  const parsed = parseChapterCandidate({
    markdown, section_id: context.section.id,
    metadata: {
      section_id: context.section.id, covered_must_answer: context.section.must_answer,
      covered_scoring_response_point_ids: context.section.scoring_response_point_ids ?? [],
      covered_scoring_response_points: context.section.scoring_response_points,
      local_materials_used: uniqueEvidence(local, value => `${value.source_kind}/${value.file_id}/${value.chunk}`, 'metadata.local_materials_used'),
      web_materials_used: mergeChapterWebMaterials(web),
      additional_web_materials: uniqueEvidence(
        additional, value => normalizeWebEvidenceUrl(value.url) ?? value.url, 'metadata.additional_web_materials'),
      unresolved_topics: input.metadata.unresolved_topics ?? [],
      handoff: {
        section_id: context.section.id,
        ...Object.fromEntries(Object.keys(handoffFields).map(key => [
          key, input.metadata.handoff?.[key as keyof typeof handoffFields] ?? [],
        ])),
      },
      flowcharts,
    },
  })
  return { ...parsed, metadata: { ...parsed.metadata, flowcharts } }
}

/**
 * 将已审核候选投影为修复 Writer 使用的语义输入。
 * @param candidate 上次完整候选。
 * @param refs 本章稳定资料位置表。
 * @param preservedFlowcharts 程序保留的只读原图，不交回模型重写。
 * @returns 修复提示中不含内部身份或 Blueprint 索引的候选；不可定位的本地资料保留语义与不可用原因，须重选合法位置后提交。
 */
export function projectChapterWriterCandidate(candidate: AcceptedChapterCandidate, refs: ChapterWriterReferences,
  preservedFlowcharts: readonly FlowchartSpec[] = []): unknown {
  const { section_id: _sectionId, ...handoff } = candidate.metadata.handoff
  return {
    markdown: projectFlowchartModelAnchors(candidate.markdown, candidate.metadata.flowcharts,
      refs.dependencyFlowcharts.map(value => value.chart)),
    metadata: {
      local_materials_used: candidate.metadata.local_materials_used.map((material) => {
        const semantics = { usage: material.usage, summary: material.summary }
        const files = [...refs.files]
        const file_position = files.findIndex(([, file]) => file.file_id === material.file_id && file.role === material.source_kind)
        const file = files[file_position]
        if (file === undefined) return { source_unavailable: '原本地来源不在当前允许的文件表中；保留资料语义并重选有效来源。', ...semantics }
        const chunk_position = refs.chunks.get(file[0])?.findIndex(chunk => chunk.id === material.chunk) ?? -1
        if (chunk_position < 0) return { source_unavailable: '原本地 Chunk 不在当前文件的资料块表中；保留资料语义并重选有效片段。', ...semantics }
        const material_position = [...refs.materials.values()].findIndex(value => value.source_kind === material.source_kind
          && value.file_id === material.file_id && value.chunk === material.chunk)
        return material_position >= 0 ? { material_position, ...semantics } : { file_position, chunk_position, ...semantics }
      }),
      web_materials_used: candidate.metadata.web_materials_used.map((material) => {
        const web_position = [...refs.webMaterials.keys()].indexOf(webMaterialIdentity(material))
        if (web_position < 0) throw new Error('CHAPTER_WRITER_WEB_MATERIAL_UNREGISTERED')
        return { web_position, usage: material.usage, summary: material.summary, supports: material.supports }
      }),
      unresolved_topics: candidate.metadata.unresolved_topics, handoff,
      flowcharts: candidate.metadata.flowcharts
        .filter(flowchart => !preservedFlowcharts.some(original => original.key === flowchart.key)).map(flowchart => ({
          title: flowchart.title,
          ...(flowchart.purpose === undefined ? {} : { purpose: flowchart.purpose }),
          nodes: flowchart.nodes.map(node => ({ type: node.type, text: node.text })),
          edges: flowchart.edges.map(edge => ({ from_position: flowchart.nodes.findIndex(node => node.id === edge.from),
            to_position: flowchart.nodes.findIndex(node => node.id === edge.to),
            ...(edge.label === undefined ? {} : { label: edge.label }) })),
        })),
    },
  }
}
