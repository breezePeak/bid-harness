/** 模型选择对象位置，Host 绑定任务中的真实身份和正文引用。 */
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import { bidCapabilityTaskSchema, type BidCapabilityTask, type BidCapabilityStep } from './bid-capability-contract.ts'
import { getOrCreateOutlineDraft, readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import { readChapterLocations } from './chapter-storage.ts'
import { indexChapterContentBlocks } from './chapter-content-reuse.ts'
import { chapterContentSha256 } from './chapter-revision.ts'
import { chapterRevisionReferenceSchema } from './chapter-revision.ts'
import { readRevisionQueue } from './chapter-revision-queue.ts'
import { parseTenderRequirementsArtifact, parseTenderScoringArtifact,
  parseTenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { readDocxTemplateLibrary } from './docx-format-store.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { parseWritingPlan, writingPlanInputSchema, writingRequestSchema } from './writing-requirements.ts'
import { bidProjectInspectSchema } from './bid-project-inspect.ts'
import { readBidWorkDescriptor, readBidWorkRequest } from './work-descriptor.ts'
import { readBidProjectState } from './project-state.ts'

const position = z.number().int().nonnegative()
const revisionTaskId = (sectionId: string): string => 'revision-' + createHash('sha256').update(sectionId).digest('hex').slice(0, 16)
const fields = {
  section_id: ['section_position', 'sections'], section_ids: ['section_positions', 'sections'],
  parent_id: ['parent_position', 'sections'], source_section_ids: ['source_section_positions', 'sections'],
  related_sections: ['related_section_positions', 'sections'],
  requirement_id: ['requirement_position', 'requirements'], requirement_ids: ['requirement_positions', 'requirements'],
  scoring_id: ['scoring_position', 'scoring'], scoring_ids: ['scoring_positions', 'scoring'],
  selected_scoring_ids: ['selected_scoring_positions', 'scoring'],
  scoring_response_point_ids: ['response_point_positions', 'response_points'],
  compliance_ids: ['compliance_positions', 'compliance'],
  compliance_id: ['compliance_position', 'compliance'],
  issue_ids: ['issue_positions', 'issues'], template_id: ['template_position', 'templates'],
  affected_section_ids: ['affected_section_positions', 'sections'],
  user_message_refs: ['user_message_positions', 'messages'], add_user_message_refs: ['add_user_message_positions', 'messages'],
  criterion_id: ['criterion_position', 'criteria'], delete: ['delete_criterion_positions', 'criteria'],
  work_id: ['work_position', 'works'],
} as const
type CatalogKind = typeof fields[keyof typeof fields][1]
const fieldMap: ReadonlyMap<string, readonly [string, CatalogKind]> = new Map(Object.entries(fields))
const taskProgramFields = new Set(['task_id', 'content_assignments', 'assignments', 'business_bindings',
  'writing_request_id', 'attempt_id', 'base_plan_version', 'defer_content_migration'])
type CatalogEntry = { readonly id: string
  readonly label: string
  readonly issue?: { readonly issue_id: string; readonly status: string; readonly reference: object } }

/** 一次已记录 inspect 提供的对象表；模型不可提供或修改其中的身份。 */
export interface BidModelTaskCatalog {
  readonly objects: Readonly<Record<CatalogKind, readonly CatalogEntry[]>>
  readonly paragraphs: ReadonlyMap<string, readonly { start: number; end: number; text: string }[]>
  readonly bodies: ReadonlyMap<string, string>
  readonly issueReferences: ReadonlyMap<string, z.infer<typeof chapterRevisionReferenceSchema>>
  readonly writingPlanVersion: number | undefined
  readonly writingEntry: { requestId: string; attemptId: string } | undefined
  readonly outlineDraft: { revision: number; sha256: string; sections: readonly CatalogEntry[] } | undefined
}

async function optionalText(workspace: BidWorkspace, path: string): Promise<string | undefined> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 从正式对象生成模型选择表，正文选区由程序计算偏移。
 * @param workspace 当前正式项目。
 * @param session 提供真实用户消息及当前原生写作请求的 Main 会话。
 * @returns 可冻结在工具结果中的对象及选区身份。
 */
export async function collectBidModelTaskCatalog(workspace: BidWorkspace, session?: Session): Promise<BidModelTaskCatalog> {
  const hasOutline = (await Promise.all(['outline/confirmed-outline.json', 'outline/draft.json', 'outline/outline.json']
    .map(path => optionalText(workspace, path)))).some(text => text !== undefined)
  const baseline = hasOutline ? await readCapabilityOutlineBaseline(workspace) : undefined
  const sections = baseline?.outline.sections ?? []
  const outlineSource = await optionalText(workspace, 'outline/outline.json')
  const state = await readBidProjectState(workspace)
  const nativeDraft = state?.status === 'waiting_user' && ['outline_generation', 'evidence_mapping'].includes(state.stage)
  const draft = nativeDraft && outlineSource !== undefined ? await getOrCreateOutlineDraft(workspace) : baseline
  const requirements = await optionalText(workspace, 'analysis/requirements.json')
  const scoring = await optionalText(workspace, 'analysis/scoring.json')
  const compliance = await optionalText(workspace, 'analysis/compliance.json')
  const points = await optionalText(workspace, 'analysis/scoring-response-points.json')
  const queue = await readRevisionQueue(workspace)
  const templates = await readDocxTemplateLibrary(workspace)
  const requestDirectory = within(workspace.projectRoot, 'requests')
  await assertNoLinkedPath(workspace.root, requestDirectory)
  let requests: string[]
  try { requests = await readdir(requestDirectory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    requests = []
  }
  const works: CatalogEntry[] = []
  for (const name of requests.filter(name => name.endsWith('.json')).sort()) {
    const work = await readBidWorkDescriptor(workspace, name.slice(0, -5))
    if (work === null) continue
    const request = await readBidWorkRequest(workspace, work)
    const goal = z.object({ task: z.object({ goal: z.string() }) }).safeParse(request)
    works.push({ id: work.workId, label: goal.success ? goal.data.task.goal : work.stage + ' / ' + work.kind })
  }
  const writingPlanText = await optionalText(workspace, 'chapters/writing-plan.json')
  const writingPlan = writingPlanText === undefined ? undefined : parseWritingPlan(JSON.parse(writingPlanText))
  const writingRequestText = writingPlan === undefined ? await optionalText(workspace, 'chapters/writing-request.json') : undefined
  const writingRequest = writingRequestText === undefined ? undefined : writingRequestSchema.parse(JSON.parse(writingRequestText))
  const bodies = new Map<string, string>()
  const paragraphs = new Map<string, Array<{ start: number; end: number; text: string }>>()
  for (const [id, location] of await readChapterLocations(workspace)) {
    const body = await optionalText(workspace, location.contentPath)
    if (body === undefined) continue
    bodies.set(id, body)
    paragraphs.set(id, indexChapterContentBlocks(id, body).map((block) => {
      const text = block.markdown.trim()
      const start = block.start + block.markdown.indexOf(text)
      return { start, end: start + text.length, text }
    }))
  }
  return { bodies, paragraphs, writingPlanVersion: writingPlan?.plan_version,
    outlineDraft: draft === undefined ? undefined : { revision: draft.revision, sha256: draft.draft_outline_sha256,
      sections: draft.outline.sections.map(section => ({ id: section.id, label: section.title })) },
    writingEntry: writingRequest?.state !== 'answered' || writingRequest.owner_session_id !== String(session?.id)
      ? undefined : { requestId: writingRequest.request_id, attemptId: writingRequest.attempt_id },
    issueReferences: new Map(queue.issues.map((issue) => {
      const { base_content_sha256, ...reference } = issue.reference
      return [issue.issue_id, { ...reference, section_id: issue.section_id, content_sha256: base_content_sha256 }] as const
    })), objects: {
      sections: sections.map(section => ({ id: section.id, label: section.title })),
      requirements: requirements === undefined ? [] : parseTenderRequirementsArtifact(JSON.parse(requirements)).requirements
        .map(item => ({ id: item.id, label: item.normalized_requirement })),
      scoring: scoring === undefined ? [] : parseTenderScoringArtifact(JSON.parse(scoring)).scoring_items
        .map(item => ({ id: item.id, label: item.criterion })),
      compliance: compliance === undefined ? [] : parseTenderComplianceArtifact(JSON.parse(compliance)).compliance_items
        .map(item => ({ id: item.id, label: item.normalized_rule })),
      response_points: points === undefined ? [] : parseScoringResponsePointCatalog(JSON.parse(points)).points
        .map(item => ({ id: item.id, label: item.text })),
      issues: queue.issues.map(issue => ({ id: issue.issue_id,
        label: issue.section_title + '：' + issue.instruction,
        issue: { issue_id: issue.issue_id, status: issue.status,
          reference: { section_id: issue.section_id, ...issue.reference } } })),
      templates: templates.templates.map(template => ({ id: template.id, label: template.name })),
      messages: session?.events.flatMap(event => event.type !== 'user/message'
      || !['user', 'goal'].includes(event.data.source.kind) ? [] : [{
          id: JSON.stringify({ session_id: String(session.id), message_id: String(event.data.id), seq: event.seq }),
          label: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        }]) ?? [],
      criteria: writingPlan === undefined ? [] : [...writingPlan.document_acceptance,
        ...writingPlan.sections.flatMap(section => section.acceptance_criteria)].map(criterion => ({ id: criterion.id,
        label: criterion.description })),
      works,
    } }
}

/**
 * 将 Host 对象表投影为位置选择；审批意见附带历史状态与原始引用供追溯。
 * @param catalog 已冻结的对象及正文选区。
 * @param bodySections 此次正文 inspect 实际读取的章节；其他章节不投影正文。
 * @param window 对象页和正文窗口；位置始终是完整对象表中的位置。
 * @returns 可记录在 inspect 工具结果中的选择表。
 */
export function presentBidModelTaskCatalog(catalog: BidModelTaskCatalog, bodySections: readonly string[] = [],
  window: { page?: number; pageSize?: number; offset?: number; maxChars?: number } = {}): object {
  const page = window.page ?? 0
  const pageSize = window.pageSize ?? 20
  const offset = window.offset ?? 0
  const maxChars = window.maxChars ?? 6_000
  const view = (entry: CatalogEntry, position: number) => ({ position, label: entry.label.slice(0, 1_500),
    label_total_chars: entry.label.length, label_truncated: entry.label.length > 1_500,
    ...entry.issue === undefined ? {} : entry.issue })
  const namespaces = { ...catalog.objects, draft_sections: catalog.outlineDraft?.sections ?? [] }
  const latestMessage = catalog.objects.messages.at(-1)
  const pages = Object.fromEntries(Object.entries(namespaces).map(([kind, entries]) => [kind,
    { page, page_size: pageSize, total: entries.length, has_more: (page + 1) * pageSize < entries.length }]))
  return { ...Object.fromEntries(Object.entries(namespaces).map(([kind, entries]) => [kind,
    entries.slice(page * pageSize, (page + 1) * pageSize).map((entry, index) => view(entry, page * pageSize + index))])),
  pages, current_message: latestMessage === undefined ? null : view(latestMessage, catalog.objects.messages.length - 1),
  selected_sections: catalog.objects.sections.flatMap((entry, position) => {
    if (!bodySections.includes(entry.id)) return []
    const paragraphs = catalog.paragraphs.get(entry.id) ?? []
    const visible = paragraphs.flatMap((paragraph, paragraph_position) => paragraph.start >= offset && paragraph.end <= offset + maxChars
      ? [{ paragraph_position, text: paragraph.text }] : [])
    return [{ ...view(entry, position), paragraphs: visible, paragraph_window: { offset, max_chars: maxChars,
      total: paragraphs.length, visible: visible.length, omitted: paragraphs.length - visible.length } }]
  }) }
}

const modelReferenceSchema = z.object({ scope: z.enum(['chapter', 'paragraphs']), section_position: position,
  start_paragraph: position.optional(), end_paragraph: position.optional() }).strict()
const issueReferenceSchema = z.object({ issue_position: position }).strict()

/**
 * 将持久任务契约投影为对象选择协议，确定性身份不进入模型输出。
 * @param schema 原任务工具的 JSON Schema。
 * @returns 使用对象位置和程序绑定引用的模型 Schema。
 */
export function bidModelTaskJsonSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (node === null || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        output[key] = Object.fromEntries(Object.entries(value).flatMap(([name, child]) => {
          if (taskProgramFields.has(name)) return []
          if (name === 'reference') return [[name, { oneOf: [{ type: 'object', properties: {
            scope: { type: 'string', enum: ['chapter', 'paragraphs'] }, section_position: { type: 'integer', minimum: 0 },
            start_paragraph: { type: 'integer', minimum: 0 }, end_paragraph: { type: 'integer', minimum: 0 },
          }, required: ['scope', 'section_position'], additionalProperties: false }, {
            type: 'object', properties: { issue_position: { type: 'integer', minimum: 0 } },
            required: ['issue_position'], additionalProperties: false,
          }] }]]
          if (name === 'depends_on') return [[name, { type: 'array', items: { type: 'integer', minimum: 0 },
            description: '真正依赖的任务所处理章节在对象表中的位置；任务身份由 Host 生成。' }]]
          const field = fieldMap.get(name)
          if (field === undefined) return [[name, visit(child)]]
          const item = { type: 'integer', minimum: 0, description: `选择 objects.${field[1]} 中的 position，Host 绑定真实身份。` }
          const minimum = child !== null && typeof child === 'object' ? (child as Record<string, unknown>).minItems : undefined
          return [[field[0], field[0].endsWith('_positions') ? { type: 'array', items: item, ...minimum === undefined ? {} : { minItems: minimum } }
            : name === 'parent_id' || name === 'template_id' ? { anyOf: [item, { type: 'null' }] } : item]]
        }))
      } else if (key === 'required' && Array.isArray(value)) {
        output[key] = z.array(z.string()).parse(value)
          .filter(name => !taskProgramFields.has(name))
          .map(name => fieldMap.get(name)?.[0] ?? name)
      } else output[key] = visit(value)
    }
    return output
  }
  return visit(schema) as JsonSchemaNode
}

/**
 * 从模型的对象选择恢复 canonical 参数；越界选择及抄写身份拒绝接纳。
 * @param value 模型输出的任务。
 * @param catalog 最近一次真实 inspect 的对象表。
 * @returns 交给既有 Host 验证和持久化的任务。
 */
function bindModelObjects(value: unknown, catalog: BidModelTaskCatalog): unknown {
  const select = (kind: CatalogKind, choice: unknown): string => {
    const entry = catalog.objects[kind][position.parse(choice)]
    if (entry === undefined) throw new Error('BID_MODEL_TASK_OBJECT_UNKNOWN')
    return entry.id
  }
  const selectValue = (kind: CatalogKind, choice: unknown): unknown => {
    const selected = select(kind, choice)
    return kind === 'messages' ? JSON.parse(selected) as unknown : selected
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (node === null || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const [name, child] of Object.entries(record)) {
      if (name === 'defer_content_migration') throw new Error('BID_MODEL_TASK_PROGRAM_FIELD_FORBIDDEN')
      if (name in fields || taskProgramFields.has(name)) {
        throw new Error('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
      }
      if (name === 'reference') {
        const issueSelection = issueReferenceSchema.safeParse(child)
        if (issueSelection.success) {
          const reference = catalog.issueReferences.get(select('issues', issueSelection.data.issue_position))
          if (reference === undefined) throw new Error('BID_MODEL_TASK_REFERENCE_INVALID')
          output[name] = reference
          continue
        }
        const reference = modelReferenceSchema.parse(child)
        const id = select('sections', reference.section_position)
        const body = catalog.bodies.get(id)
        if (body === undefined) throw new Error('BID_MODEL_TASK_BODY_MISSING')
        const base = { scope: reference.scope, section_id: id, content_sha256: chapterContentSha256(body) }
        if (reference.scope === 'chapter') {
          if (reference.start_paragraph !== undefined || reference.end_paragraph !== undefined) throw new Error('BID_MODEL_TASK_REFERENCE_INVALID')
          output[name] = base
        } else {
          const start = catalog.paragraphs.get(id)?.[position.parse(reference.start_paragraph)]
          const end = catalog.paragraphs.get(id)?.[position.parse(reference.end_paragraph)]
          if (start === undefined || end === undefined || end.end <= start.start) throw new Error('BID_MODEL_TASK_REFERENCE_INVALID')
          output[name] = { ...base, start: start.start, end: end.end, text: body.slice(start.start, end.end) }
        }
        continue
      }
      if (name === 'depends_on') {
        output[name] = z.array(position).parse(child).map(choice => revisionTaskId(select('sections', choice)))
        continue
      }
      const field = Object.entries(fields).find(([, binding]) => binding[0] === name)
      if (field === undefined) output[name] = visit(child)
      else output[field[0]] = child === null ? null : field[1][0].endsWith('_positions')
        ? z.array(position).parse(child).map(choice => selectValue(field[1][1], choice)) : selectValue(field[1][1], child)
    }
    if (Array.isArray(record.issue_positions) && record.section_position !== undefined && Array.isArray(record.depends_on)) {
      output.task_id = revisionTaskId(select('sections', record.section_position))
    }
    if (record.update_kind === 'initial') {
      if (catalog.writingEntry === undefined) throw new Error('BID_MODEL_WRITING_ENTRY_REQUIRED')
      output.writing_request_id = catalog.writingEntry.requestId
      output.attempt_id = catalog.writingEntry.attemptId
    } else if (record.update_kind === 'patch') {
      if (catalog.writingPlanVersion === undefined) throw new Error('BID_MODEL_WRITING_PLAN_REQUIRED')
      output.base_plan_version = catalog.writingPlanVersion
    }
    return output
  }
  return visit(value)
}

/**
 * 编译模型选择的完整业务任务，拒绝身份抄写及不合法的任务组合。
 * @param value 模型任务参数。
 * @param catalog 最近一次真实 inspect 的对象表。
 * @returns 原 Host 执行器接受的 canonical 任务。
 */
export function bindBidModelTask(value: unknown, catalog: BidModelTaskCatalog): BidCapabilityTask {
  let task: BidCapabilityTask
  try { task = bidCapabilityTaskSchema.parse(bindModelObjects(value, catalog)) } catch (error) {
    if (!(error instanceof z.ZodError)) throw error
    throw new z.ZodError(error.issues.map(issue => ({ ...issue, path: issue.path.map(key =>
      typeof key === 'string' ? fieldMap.get(key)?.[0] ?? key : key) })))
  }
  return { ...task, steps: task.steps.map((step, index) => {
    if (step.call.capability !== 'outline.update') return step
    const deferred = task.allow_pending_content === true
      || task.steps.slice(index + 1).some(later => later.call.capability === 'chapter.reorganize')
    return { ...step, call: { ...step.call, input: { ...step.call.input, defer_content_migration: deferred } } }
  }) }
}

/**
 * 将模型读取请求中的对象选择绑定到真实项目身份。
 * @param value 模型读取请求。
 * @param catalog 最近一次真实 inspect 的对象表。
 * @returns 严格解析的 Host 项目读取请求。
 */
export function bindBidModelProjectQuery(value: unknown, catalog: BidModelTaskCatalog): z.input<typeof bidProjectInspectSchema> {
  return bidProjectInspectSchema.parse(bindModelObjects(value, catalog))
}

/**
 * 编译模型的写作语义要求，消息身份、请求身份和版本由 Host 绑定。
 * @param value 模型写作要求。
 * @param catalog 当前真实用户消息、写作请求和已保存计划。
 * @returns 原生写作确认入口接受的输入。
 */
export function bindBidModelWritingPlan(value: unknown, catalog: BidModelTaskCatalog): z.infer<typeof writingPlanInputSchema> {
  return writingPlanInputSchema.parse(bindModelObjects(value, catalog))
}

/**
 * 从对象选择绑定一次只读正文引用。
 * @param value 模型选择的章节、原文块或审批选区。
 * @param catalog inspect 冻结的正文及意见引用。
 * @returns 按原文绑定的章节或段落引用。
 */
export function bindBidModelReference(value: unknown, catalog: BidModelTaskCatalog): z.infer<typeof chapterRevisionReferenceSchema> {
  return z.object({ reference: chapterRevisionReferenceSchema }).strict().parse(bindModelObjects({ reference: value }, catalog)).reference
}

/**
 * 将同一 Work 的后续语义步骤绑定为既有执行器参数。
 * @param value 模型选择的后续步骤。
 * @param catalog 当前 inspect 的真实对象表。
 * @returns 保留 Host 身份的业务步骤；原 Work 范围由补丁入口继续核对。
 */
export function bindBidModelSteps(value: unknown, catalog: BidModelTaskCatalog): BidCapabilityStep[] {
  return bindBidModelTask({ goal: '继续完成原任务', scope: { kind: 'project' }, steps: value }, catalog).steps
}

/**
 * 将原生目录编辑的草稿位置绑定为 inspect 时的对象和 CAS。
 * @param value 模型选择的局部草稿编辑。
 * @param catalog 最近一次 inspect 的正式对象表和草稿身份。
 * @returns 供原生入口继续严格解析的编辑参数；陈旧草稿由原生 CAS 拒绝。
 */
export function bindBidModelOutlineEdit(value: unknown, catalog: BidModelTaskCatalog): Record<string, unknown> {
  const draft = catalog.outlineDraft
  if (draft === undefined) throw new Error('BID_MODEL_OUTLINE_DRAFT_REQUIRED')
  const translate = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(translate)
    if (node === null || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).map(([name, child]) => {
      if (['expected_revision', 'expected_draft_sha256', 'section_position', 'section_positions', 'parent_position'].includes(name)) {
        throw new Error('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
      }
      return [name.startsWith('draft_') ? name.slice(6) : name, translate(child)]
    }))
  }
  const bound = z.record(z.string(), z.unknown()).parse(bindModelObjects(translate(value), {
    ...catalog, objects: { ...catalog.objects, sections: draft.sections },
  }))
  return { ...bound, expected_revision: draft.revision, expected_draft_sha256: draft.sha256 }
}

/**
 * 将原生目录 Schema 的身份字段替换为草稿选择位置。
 * @param schema 原生目录编辑参数 Schema。
 * @returns 无 CAS 抄写、显式使用草稿位置的模型参数 Schema。
 */
export function bidModelOutlineEditJsonSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const omit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(omit)
    if (node === null || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).map(([name, child]) => [name,
      name === 'properties' && child !== null && typeof child === 'object'
        ? Object.fromEntries(Object.entries(child as Record<string, unknown>).filter(([key]) => !['action', 'expected_revision', 'expected_draft_sha256'].includes(key)).map(([key, value]) => [key, omit(value)]))
        : name === 'required' && Array.isArray(child) ? child.filter(key => !['action', 'expected_revision', 'expected_draft_sha256'].includes(String(key))) : omit(child)]))
  }
  const rename = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rename)
    if (typeof node === 'string' && ['section_position', 'section_positions', 'parent_position'].includes(node)) return 'draft_' + node
    if (node === null || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).map(([name, child]) => [
      ['section_position', 'section_positions', 'parent_position'].includes(name) ? 'draft_' + name : name, rename(child),
    ]))
  }
  return rename(bidModelTaskJsonSchema(omit(schema) as JsonSchemaNode)) as JsonSchemaNode
}
