/** Writer 的语义输入与章节内资料短引用；持久化身份全部由 Host 解析。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolArgsError, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidManifest, BidWorkspace } from './index.ts'
import type { ChapterContext } from './chapter-writing-executor.ts'
import { parseChapterCandidate, type ChapterCandidate, type AcceptedChapterCandidate } from './chapter-writing-artifacts.ts'
import { localEvidenceMaterialSchema, transientWebEvidenceMaterialSchema, type LocalEvidenceMaterial, type WebEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { resolveEvidenceChunk } from './evidence-chunk.ts'
import { chapterToolArgs } from './chapter-writing-protocol.ts'
import { assertNoLinkedPath } from './workspace-path.ts'
import { normalizeWebEvidenceUrl, webEvidenceContentSha256, type WebEvidenceSource } from './web-evidence-source-artifacts.ts'
import type { WebEvidenceSnapshot } from './web-evidence-snapshot.ts'

const text = z.string().trim().min(1)
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
      z.object({ material_ref: text, ...localSemantics }).strict(),
      z.object({ file_ref: text, chunk: text, ...localSemantics }).strict(),
    ])).optional(),
    web_materials_used: z.array(z.object({ web_ref: text, ...webSemantics }).strict()).optional(),
    additional_web_materials: z.array(transientWebEvidenceMaterialSchema).optional(),
    unresolved_topics: strings,
    handoff: z.object(handoffFields).strict().optional(),
  }).strict(),
}).strict()

const stringParameter = { type: 'string' as const }
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
          { type: 'object', properties: { material_ref: stringParameter, ...localProperties }, required: ['material_ref', 'usage', 'summary'], additionalProperties: false },
          { type: 'object', properties: { file_ref: stringParameter, chunk: stringParameter, ...localProperties }, required: ['file_ref', 'chunk', 'usage', 'summary'], additionalProperties: false },
        ] } },
        web_materials_used: { type: 'array', items: { type: 'object', properties: { web_ref: stringParameter, ...webProperties }, required: ['web_ref', 'usage', 'summary', 'supports'], additionalProperties: false } },
        additional_web_materials: { type: 'array', items: { type: 'object', properties: { url: stringParameter, ...webProperties }, required: ['url', 'usage', 'summary', 'supports'], additionalProperties: false } },
        unresolved_topics: stringArray,
        handoff: { type: 'object', properties: Object.fromEntries(Object.keys(handoffFields).map(key => [key, stringArray])), additionalProperties: false },
      }, additionalProperties: false,
    },
  }, required: ['markdown', 'metadata'], additionalProperties: false,
}

/** 同一章节各次 Writer 尝试共享稳定编号；仅追加已经验证的 Web Snapshot。 */
export interface ChapterWriterReferences {
  readonly materials: ReadonlyMap<string, LocalEvidenceMaterial>
  readonly files: ReadonlyMap<string, ChapterContext['availableLocalCorpus'][number]>
  readonly web: Map<string, WebEvidenceSource & { read_path: string }>
}

/**
 * 为当前章节分配稳定的已映射材料和补搜文件编号。
 * @param context 当前章节输入。
 * @returns 章节内 M/F 引用表，不包含框架 Evidence。
 */
export function createChapterWriterReferences(context: ChapterContext): ChapterWriterReferences {
  return {
    materials: new Map([...context.relatedMaterials, ...context.referenceBidMaterials].map((value, index) => [`M${index + 1}`, value])),
    files: new Map(context.availableLocalCorpus.filter(file => file.role !== 'outline_framework').map((value, index) => [`F${index + 1}`, value])),
    web: new Map(),
  }
}

/**
 * 读取已登记 Web 正文并拒绝内容 Hash 不匹配的快照。
 * @param workspace 资料工作区。
 * @param source 已登记来源。
 * @returns Hash 验证通过的实际 Web 正文。
 */
export async function readChapterWebSource(workspace: BidWorkspace, source: WebEvidenceSource): Promise<string> {
  const path = join(workspace.projectRoot, source.snapshot_path)
  await assertNoLinkedPath(workspace.root, path)
  const content = await readFile(path, 'utf8')
  if (content.trim().length === 0 || webEvidenceContentSha256(content) !== source.content_sha256) {
    throw new ToolArgsError([`web_ref: Snapshot Hash 或正文无效：${source.snapshot_path}`])
  }
  return content
}

/**
 * 验证新增来源并追加 W 编号，保留已发放的引用。
 * @param workspace 当前工作区。
 * @param refs 当前章节稳定引用表。
 * @param sources 当前允许暴露的账本来源。
 */
export async function appendChapterWebReferences(
  workspace: BidWorkspace, refs: ChapterWriterReferences, sources: readonly WebEvidenceSource[],
): Promise<void> {
  for (const source of sources) {
    if ([...refs.web.values()].some(value => value.source_id === source.source_id)) continue
    await readChapterWebSource(workspace, source)
    refs.web.set(`W${refs.web.size + 1}`, { ...source, read_path: join(workspace.projectRoot, source.snapshot_path).replaceAll('\\', '/') })
  }
}

/**
 * 向 Writer 提供资料语义、允许用法和可执行读取位置。
 * @param context 当前章节输入及可执行读取位置。
 * @param refs 本章 M/F/W 表。
 * @returns 不把短引用当作文件路径的模型输入。
 */
export function renderChapterWriterReferences(context: ChapterContext, refs: ChapterWriterReferences): string {
  const usage = (role: string) => role === 'reference_bid' ? ['reuse', 'adapt', 'reference', 'background'] : ['reference', 'background']
  return [
    '资料提交用下列 M/F/W 短引用；grep/read 必须使用表中真实路径，短引用不是路径。',
    `Mapped Materials：${JSON.stringify([...refs.materials].map(([material_ref, material]) => ({
      material_ref, name: [...refs.files.values()].find(file => file.file_id === material.file_id)?.name,
      role: material.source_kind, allowed_usage: usage(material.source_kind), summary: material.summary,
      ...context.localReadLocations.find(value => value.file_id === material.file_id && value.chunk === material.chunk),
    })))}`,
    `Available Evidence Files：${JSON.stringify([...refs.files].map(([file_ref, file]) => ({ file_ref, name: file.name, role: file.role, chunks_path: file.chunks_path, chunk_index_path: file.chunk_index_path, allowed_usage: usage(file.role) })))}`,
    `Verified Web Snapshots：${JSON.stringify([...refs.web].map(([web_ref, source]) => ({
      web_ref, url: source.final_url, read_path: source.read_path,
      allowed_usage: ['reference', 'background'], truncated: source.truncated,
      summary: context.webMaterials.find(value => value.source_id === source.source_id)?.summary,
    })))}`,
    '本地条目只提交 {material_ref, usage, summary} 或 {file_ref, chunk, usage, summary}，两者不可并用；已登记网页只提交 {web_ref, usage, summary, supports}。新网页提交 {url, usage, summary, supports}，必须有当前 Writer 成功 fetch 的正文。',
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
 * @returns 按真实来源去重的条目；语义冲突可恢复地拒绝。
 */
export function mergeChapterWebMaterials(materials: readonly WebEvidenceMaterial[]): WebEvidenceMaterial[] {
  return uniqueEvidence(materials, value => value.source_id, 'metadata.web_materials_used')
}

/**
 * 校验 Writer 短引用并注入当前章节身份和 Blueprint 索引；不写入文件。
 * @param workspace 资料工作区。
 * @param manifest 当前资料身份。
 * @param context 固定章节输入。
 * @param refs 当前章节引用表。
 * @param value 模型结构化提交参数。
 * @param snapshots 当前 Writer 成功 fetch 的实际正文。
 * @returns durable candidate parser 可接受的候选，新增 URL 尚待 Host 持久化绑定。
 */
export async function bindChapterWriterInput(
  workspace: BidWorkspace, manifest: BidManifest, context: ChapterContext, refs: ChapterWriterReferences,
  value: unknown, snapshots: readonly WebEvidenceSnapshot[],
): Promise<ChapterCandidate> {
  const input = chapterToolArgs(writerInput, value)
  const local: LocalEvidenceMaterial[] = []
  for (const [index, material] of (input.metadata.local_materials_used ?? []).entries()) {
    const path = `metadata.local_materials_used.${index}`
    let identity: Pick<LocalEvidenceMaterial, 'source_kind' | 'file_id' | 'chunk'>
    if ('material_ref' in material) {
      const mapped = refs.materials.get(material.material_ref)
      if (mapped === undefined) throw new ToolArgsError([`${path}.material_ref: 未知 ${material.material_ref}。`])
      identity = mapped
    } else {
      const file = refs.files.get(material.file_ref)
      if (file === undefined || file.role === 'outline_framework') throw new ToolArgsError([`${path}.file_ref: 未知或不可引用 ${material.file_ref}。`])
      identity = { source_kind: file.role, file_id: file.file_id, chunk: material.chunk }
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
  for (const [index, material] of (input.metadata.web_materials_used ?? []).entries()) {
    const source = refs.web.get(material.web_ref)
    if (source === undefined) throw new ToolArgsError([`metadata.web_materials_used.${index}.web_ref: 未知 ${material.web_ref}。`])
    await readChapterWebSource(workspace, source)
    web.push({
      source_id: source.source_id, snapshot_path: source.snapshot_path,
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
      usage: material.usage, summary: material.summary, supports: material.supports })
  }
  mergeChapterWebMaterials([...web, ...additionalBound])
  return parseChapterCandidate({
    markdown: input.markdown, section_id: context.section.id,
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
    },
  })
}

/**
 * 将已审核候选投影为修复 Writer 使用的语义输入。
 * @param candidate 上次完整候选。
 * @param refs 本章稳定短引用。
 * @returns 修复提示中不含内部身份或 Blueprint 索引的候选。
 */
export function projectChapterWriterCandidate(candidate: AcceptedChapterCandidate, refs: ChapterWriterReferences): unknown {
  const { section_id: _sectionId, ...handoff } = candidate.metadata.handoff
  return {
    markdown: candidate.markdown,
    metadata: {
      local_materials_used: candidate.metadata.local_materials_used.map((material) => {
        const mapped = [...refs.materials].find(([, value]) => value.file_id === material.file_id && value.chunk === material.chunk)
        const semantics = { usage: material.usage, summary: material.summary }
        return mapped !== undefined ? { material_ref: mapped[0], ...semantics }
          : { file_ref: [...refs.files].find(([, value]) => value.file_id === material.file_id)?.[0], chunk: material.chunk, ...semantics }
      }),
      web_materials_used: candidate.metadata.web_materials_used.map(material => ({
        web_ref: [...refs.web].find(([, value]) => value.source_id === material.source_id)?.[0],
        usage: material.usage, summary: material.summary, supports: material.supports })),
      unresolved_topics: candidate.metadata.unresolved_topics, handoff,
    },
  }
}
