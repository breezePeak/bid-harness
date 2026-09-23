/** 项目级只读视图；按真实对象和章节 ID 分页，不依赖当前阶段。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { readChapterLocations } from './chapter-storage.ts'
import { parseOrMigrateChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { parseEvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import { parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { parseOutlineArtifact } from './outline-generation-artifacts.ts'
import { parseBidProjectState } from './project-state.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact,
  parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseTenderScoringSelection } from './tender-analysis-confirmation.ts'
import { parseWritingPlan } from './writing-requirements.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const page = { page: z.number().int().nonnegative().default(0), page_size: z.number().int().min(1).max(50).default(20) }
const source = { source: z.enum(['committed', 'candidate']).default('committed') }
const sectionIds = z.array(z.string().min(1)).min(1)

/** 面向主 Agent 的明确读取请求。 */
export const bidProjectInspectSchema = z.discriminatedUnion('object', [
  z.object({ object: z.literal('tender'), part: z.enum(['project', 'requirements', 'scoring', 'scoring_origin',
    'selection', 'compliance', 'impact']), ...page, ...source }).strict(),
  z.object({ object: z.literal('outline'), ...page, ...source }).strict(),
  z.object({ object: z.literal('evidence'), section_ids: sectionIds.optional(), ...page, ...source }).strict(),
  z.object({ object: z.literal('writing_plan'), section_ids: sectionIds.optional(), ...page, ...source }).strict(),
  z.object({ object: z.literal('chapters'), section_ids: sectionIds, offset: z.number().int().nonnegative().default(0),
    max_chars: z.number().int().min(1).max(12_000).default(6_000), ...page, ...source }).strict(),
  z.object({ object: z.literal('execution'), section_ids: sectionIds.optional(), ...page, ...source }).strict(),
  z.object({ object: z.literal('task'), ...source }).strict(),
  z.object({ object: z.literal('recovery'), ...source }).strict(),
])

export type BidProjectInspectRequest = z.input<typeof bidProjectInspectSchema>

/** 缺失对象返回显式状态；页码和截断状态不冒充完整资料。 */
export interface BidProjectInspectResult {
  readonly object: z.output<typeof bidProjectInspectSchema>['object']
  readonly source: 'committed' | 'candidate'
  readonly available: boolean
  readonly artifact: string
  readonly missing?: string
  readonly page?: number
  readonly page_size?: number
  readonly total?: number
  readonly has_more?: boolean
  readonly data?: unknown
}

async function optionalText(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function paginated<T>(items: readonly T[], pageNumber: number, pageSize: number): {
  data: T[]
  total: number
  has_more: boolean
} {
  const start = pageNumber * pageSize
  return { data: items.slice(start, start + pageSize), total: items.length, has_more: start + pageSize < items.length }
}

/**
 * 读取已保存的 Bid 业务对象；候选读取必须显式提供候选工作区。
 * @param canonical 正式项目。
 * @param input 对象、实际章节 ID 和分页请求。
 * @param candidate 当前任务的候选项目，若存在。
 * @returns 带可用性、来源与分页信息的只读结果。
 */
export async function inspectBidProject(
  canonical: BidWorkspace, input: BidProjectInspectRequest, candidate?: BidWorkspace,
): Promise<BidProjectInspectResult> {
  const request = bidProjectInspectSchema.parse(input)
  const workspace = request.source === 'candidate' ? candidate : canonical
  const tenderArtifact = request.object === 'tender' ? `analysis/${request.part === 'scoring_origin' ? 'scoring-origin'
    : request.part === 'selection' ? 'tender-analysis-selection'
      : request.part === 'impact' ? 'tender-update-impact' : request.part}.json` : undefined
  const artifactFor = (object: typeof request.object): string => object === 'outline' ? 'outline/confirmed-outline.json'
    : object === 'evidence' ? 'analysis/evidence-map.json'
      : object === 'writing_plan' ? 'chapters/writing-plan.json'
        : object === 'execution' ? 'chapters/execution-log.json'
          : object === 'chapters' ? 'chapters/sections'
            : object === 'tender' ? tenderArtifact ?? 'analysis/project.json'
              : 'project-state.json'
  const artifact = artifactFor(request.object)
  const base = { object: request.object, source: request.source, artifact }
  if (workspace === undefined) return { ...base, available: false, missing: 'BID_CANDIDATE_WORKSPACE_UNAVAILABLE' }
  if (request.object === 'task' || request.object === 'recovery') {
    const statePath = workspace.projectStatePath
    await assertNoLinkedPath(workspace.root, statePath)
    let raw: string | undefined
    try { raw = await readFile(statePath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw === undefined) return { ...base, available: false, missing: 'project-state.json' }
    const state = parseBidProjectState(JSON.parse(raw))
    return { ...base, available: true, data: request.object === 'task'
      ? { stage: state.stage, status: state.status, run: state.run, revision: state.revision }
      : { status: state.status, run: state.run,
        failure: state.status === 'failed' ? state.failure
          : state.status === 'suspended' ? state.run.error ?? null : null } }
  }
  if (request.object === 'chapters') {
    const outlineRaw = await optionalText(workspace, 'outline/confirmed-outline.json')
    if (outlineRaw === undefined) return { ...base, available: false, missing: 'outline/confirmed-outline.json' }
    const outline = parseConfirmedOutlineArtifact(JSON.parse(outlineRaw))
    const known = new Set(outline.sections.filter(item => item.writable).map(item => item.id))
    if (request.section_ids.some(id => !known.has(id))) throw new Error('BID_PROJECT_INSPECT_SECTION_UNKNOWN')
    const selected = paginated(request.section_ids, request.page, request.page_size)
    const locations = await readChapterLocations(workspace)
    const data = await Promise.all(selected.data.map(async (section_id) => {
      const location = locations.get(section_id)
      if (location === undefined) return { section_id, available: false, missing: 'BID_CHAPTER_STORAGE_LOCATION_MISSING' }
      const body = await optionalText(workspace, location.contentPath)
      if (body === undefined) return { section_id, available: false, artifact: location.contentPath,
        missing: location.contentPath }
      const snippet = body.slice(request.offset, request.offset + request.max_chars)
      return { section_id, available: true, artifact: location.contentPath,
        content_sha256: createHash('sha256').update(body).digest('hex'),
        total_chars: body.length, offset: request.offset, markdown: snippet,
        complete: request.offset === 0 && snippet.length === body.length,
        next_offset: request.offset + snippet.length < body.length ? request.offset + snippet.length : null }
    }))
    return { ...base, available: true, page: request.page, page_size: request.page_size,
      total: selected.total, has_more: selected.has_more, data }
  }
  const raw = await optionalText(workspace, artifact)
  if (raw === undefined) return { ...base, available: false, missing: artifact }
  const value: unknown = JSON.parse(raw)
  let items: unknown[] = []
  let header: unknown = undefined
  if (request.object === 'tender') {
    if (request.part === 'project') header = parseTenderProjectArtifact(value)
    else if (request.part === 'requirements') items = parseTenderRequirementsArtifact(value).requirements
    else if (request.part === 'scoring' || request.part === 'scoring_origin') {
      items = parseTenderScoringArtifact(value).scoring_items
    } else if (request.part === 'selection') {
      const originRaw = await optionalText(workspace, 'analysis/scoring-origin.json')
      if (originRaw === undefined) return { ...base, available: false, missing: 'analysis/scoring-origin.json' }
      header = parseTenderScoringSelection(value, parseTenderScoringArtifact(JSON.parse(originRaw)))
    } else if (request.part === 'impact') {
      header = z.object({ schema_version: z.literal(1), changed_requirement_ids: z.array(z.string()),
        changed_scoring_ids: z.array(z.string()), changed_compliance_ids: z.array(z.string()),
        project_changed: z.boolean(), affected_section_ids: z.array(z.string()),
        stale_artifacts: z.array(z.string()) }).strict().parse(value)
    } else items = parseTenderComplianceArtifact(value).compliance_items
  } else if (request.object === 'outline') items = parseOutlineArtifact(value).sections
  else if (request.object === 'evidence') items = parseEvidenceMapArtifact(value).section_mappings
  else if (request.object === 'writing_plan') {
    const plan = parseWritingPlan(value)
    header = { plan_version: plan.plan_version, confirmed: plan.confirmed,
      global_instructions: plan.global_instructions, document_acceptance: plan.document_acceptance }
    items = plan.sections
  } else items = parseOrMigrateChapterExecutionLog(value).sections
  if (header !== undefined && request.object === 'tender') return { ...base, available: true, data: header }
  if (request.object === 'evidence' || request.object === 'writing_plan' || request.object === 'execution') {
    const outlineRaw = await optionalText(workspace, 'outline/confirmed-outline.json')
    if (request.section_ids !== undefined) {
      if (outlineRaw === undefined) return { ...base, available: false, missing: 'outline/confirmed-outline.json' }
      const outline = parseConfirmedOutlineArtifact(JSON.parse(outlineRaw))
      const selected = outlineSectionScope(outline, request.section_ids)
      items = items.filter(item => selected.has((item as { section_id: string }).section_id))
    }
  }
  const listed = paginated(items, request.page, request.page_size)
  const data = header === undefined ? listed.data : { ...header as object, sections: listed.data }
  return { ...base, available: true, page: request.page, page_size: request.page_size,
    total: listed.total, has_more: listed.has_more, data }
}
