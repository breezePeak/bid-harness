/** 项目独立保存 Word 模板 Registry，以及每份模板自己的格式解析与确认状态。 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BidWorkspace } from './index.ts'
import type {
  DocxFormatCoreView,
  DocxFormatRequest,
  DocxFormatState,
  DocxFormatSuggestion,
  DocxFormatView,
  DocxTemplateId,
  DocxTemplateLibraryView,
  DocxTemplateRegistry,
  FormatValue,
} from './docx-format-contract.ts'
import { DOCX_TEMPLATE_PARSER_VERSION, DOCX_TEMPLATE_REGISTRY_VERSION } from './docx-format-contract.ts'
import { defaultDocxFormatState, formatFields, FORMAT_ROLES, resolveFormat, validateFormatValues, viewResolvedFormat } from './docx-format.ts'
import { parseDocxTemplate } from './docx-template.ts'
import { parseTenderRequirementsArtifact, parseTenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within, atomicBytes } from './workspace-path.ts'
import type { BidCommitScope } from './run-coordinator.ts'

const valueSchema = z.union([z.string().max(200), z.number(), z.boolean()])
const valuesSchema = z.record(z.string().max(100), valueSchema)
const roleSchema = z.enum(FORMAT_ROLES as [typeof FORMAT_ROLES[number], ...typeof FORMAT_ROLES[number][]])
const evidenceSourceSchema = z.enum(['system_default', 'doc_defaults', 'theme', 'named_style', 'direct_format',
  'template_instruction', 'user_requirement', 'user_confirmed'])
const evidenceSchema = z.strictObject({ key: z.string().max(100),
  source: evidenceSourceSchema,
  value: valueSchema,
  text: z.string().max(1000).optional(),
  candidateId: z.string().max(200).optional() })
const candidateSchema = z.strictObject({ id: z.string().max(200),
  name: z.string().max(200),
  values: valuesSchema,
  roles: z.array(roleSchema).max(FORMAT_ROLES.length),
  samples: z.array(z.string().max(160)).max(8),
  evidence: z.array(evidenceSchema).max(500) })
const extractionSchema = z.strictObject({ values: valuesSchema,
  candidates: z.array(candidateSchema),
  paragraphs: z.array(z.string().max(1000)).max(2000),
  evidence: z.array(evidenceSchema).max(500),
  warnings: z.array(z.string().max(1000)).max(100) })
const interpretationSchema = z.strictObject({ values: valuesSchema,
  mapping: z.record(z.string(), z.string().max(200)).refine(mapping => Object.keys(mapping).every(
    key => FORMAT_ROLES.includes(key as typeof FORMAT_ROLES[number]),
  )),
  evidence: z.array(evidenceSchema).max(500) })
const conflictSchema = z.strictObject({ key: z.string().max(100),
  resolvedValue: valueSchema,
  status: z.enum(['conflict', 'confirmed']),
  evidence: z.array(evidenceSchema).min(2).max(500) })
const hashSchema = z.string().regex(/^[a-f\d]{64}$/u)
const templateIdSchema = hashSchema as unknown as z.ZodType<DocxTemplateId>
const templateSchema = z.strictObject({ parserVersion: z.number().int().nonnegative(),
  hash: templateIdSchema,
  name: z.string().max(200) })
const stateSchema = z.strictObject({ version: z.literal(2),
  revision: z.number().int().nonnegative(),
  opened: z.boolean(),
  template: templateSchema.optional(),
  extracted: extractionSchema,
  modelInterpreted: interpretationSchema,
  conflicts: z.array(conflictSchema).max(1000),
  resolved: valuesSchema,
  userConfirmed: valuesSchema,
  lastExport: z.strictObject({ path: z.string().max(500), fingerprint: hashSchema }).optional() })
const templateRecordSchema = z.strictObject({
  id: templateIdSchema,
  hash: templateIdSchema,
  name: z.string().min(1).max(200),
  parserVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
}).refine(value => value.id === value.hash, { message: '模板 ID 与摘要不一致。' })
const registrySchema = z.strictObject({
  version: z.literal(DOCX_TEMPLATE_REGISTRY_VERSION),
  revision: z.number().int().nonnegative(),
  estimateTemplateId: templateIdSchema.nullable(),
  templates: z.array(templateRecordSchema).max(1000),
}).superRefine((value, context) => {
  if (new Set(value.templates.map(template => template.id)).size !== value.templates.length)
    context.addIssue({ code: 'custom', message: '模板 Registry 包含重复 ID。' })
  if (value.estimateTemplateId !== null && !value.templates.some(template => template.id === value.estimateTemplateId))
    context.addIssue({ code: 'custom', message: '页数基准模板不存在。' })
})
const requestSchema = z.strictObject({ revision: z.number().int().nonnegative(), userConfirmed: valuesSchema })
const templateUploadSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  name: z.string().max(200).regex(/\.docx$/iu),
  bytes: z.instanceof(Uint8Array) })
const parsedTemplateSchema = z.strictObject({ parserVersion: z.literal(DOCX_TEMPLATE_PARSER_VERSION),
  hash: templateIdSchema, name: z.string().max(200), extracted: extractionSchema })

const emptyRegistry = (): DocxTemplateRegistry => ({
  version: DOCX_TEMPLATE_REGISTRY_VERSION,
  revision: 0,
  estimateTemplateId: null,
  templates: [],
})
const registryPath = (workspace: BidWorkspace): string => within(workspace.projectRoot, 'word-export/templates.json')
const legacyFormatPath = (workspace: BidWorkspace): string => within(workspace.projectRoot, 'word-export/config.json')
const formatPath = (workspace: BidWorkspace, templateId: DocxTemplateId | null): string => templateId === null
  ? within(workspace.projectRoot, 'word-export/default.config.json')
  : within(workspace.projectRoot, `word-export/templates/${templateIdSchema.parse(templateId)}.config.json`)

async function parseStateFile(path: string): Promise<DocxFormatState | undefined> {
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('保存的 Word 格式配置不是有效 JSON，请恢复配置文件。') }
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) throw new Error('保存的 Word 格式配置版本过旧或已损坏，请重新上传模板。')
  return parsed.data
}

async function writeRegistry(workspace: BidWorkspace, registry: DocxTemplateRegistry): Promise<void> {
  const path = registryPath(workspace)
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, `${JSON.stringify(registrySchema.parse(registry))}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** 读取模板 Registry，并把旧单模板配置一次迁移到独立模板配置。 */
export async function readDocxTemplateRegistry(workspace: BidWorkspace): Promise<DocxTemplateRegistry> {
  const path = registryPath(workspace)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const legacyPath = legacyFormatPath(workspace)
    await assertNoLinkedPath(workspace.root, legacyPath)
    const legacy = await parseStateFile(legacyPath)
    if (legacy === undefined) return emptyRegistry()
    const registry = emptyRegistry()
    if (legacy.template === undefined) {
      await writeDocxFormat(workspace, null, legacy)
    } else {
      const id = legacy.template.hash
      await writeDocxFormat(workspace, id, legacy)
      const info = await stat(legacyPath)
      registry.templates.push({ id, hash: id, name: legacy.template.name,
        parserVersion: legacy.template.parserVersion, createdAt: info.mtime.toISOString() })
      registry.estimateTemplateId = id
    }
    registry.revision = 1
    await writeRegistry(workspace, registry)
    return registry
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('保存的 Word 模板 Registry 不是有效 JSON，请恢复配置文件。') }
  const parsed = registrySchema.safeParse(value)
  if (!parsed.success) throw new Error('保存的 Word 模板 Registry 版本过旧或已损坏，请恢复配置文件。')
  return parsed.data
}

/** 读取模板列表及每份模板自己的格式版本和冲突数量。 */
export async function readDocxTemplateLibrary(workspace: BidWorkspace): Promise<DocxTemplateLibraryView> {
  const registry = await readDocxTemplateRegistry(workspace)
  const templates = await Promise.all(registry.templates.map(async (template) => {
    const path = formatPath(workspace, template.id)
    await assertNoLinkedPath(workspace.root, path)
    const state = await parseStateFile(path)
    if (state === undefined || state.template?.hash !== template.hash
      || state.template.name !== template.name || state.template.parserVersion !== template.parserVersion)
      throw new Error(`模板 ${template.name} 缺少独立格式配置，请恢复配置文件。`)
    return { ...template,
      formatRevision: state.revision,
      conflictCount: state.conflicts.filter(conflict => conflict.status === 'conflict').length }
  }))
  return { ...registry, templateMaxBytes: workspace.config.docxTemplateMaxBytes, templates }
}

async function withTenderWarnings(workspace: BidWorkspace, view: DocxFormatCoreView): Promise<DocxFormatCoreView> {
  const warnings = [...view.warnings]
  for (const artifact of ['analysis/requirements.json', 'analysis/compliance.json']) {
    const path = within(workspace.projectRoot, artifact)
    await assertNoLinkedPath(workspace.root, path)
    let raw: string
    try { raw = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`无法读取 ${artifact}，请手动核对招标格式要求。`)
      continue
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { warnings.push(`无法解析 ${artifact}，请手动核对招标格式要求。`); continue }
    let clauses: { raw_text: string }[]
    try {
      clauses = artifact.endsWith('requirements.json')
        ? parseTenderRequirementsArtifact(parsed).requirements
        : parseTenderComplianceArtifact(parsed).compliance_items
    } catch { warnings.push(`格式要求文件 ${artifact} 结构无效，请手动核对。`); continue }
    for (const clause of clauses) {
      if (!/字体|字号|行距|页边距|页眉|页脚|排版|磅|宋体|黑体/u.test(clause.raw_text)) continue
      warnings.push(`招标格式要求（请核对）：${clause.raw_text}`)
      const size = /(?:^|[。；;，,\n])\s*正文(?:字号)?(?:采用|使用|为|：|:)?\s*(\d+(?:\.\d+)?)\s*磅(?:[。；;，,\s]|$)/u.exec(clause.raw_text)
      const font = /(?:^|[。；;，,\n])\s*正文(?:字体)?(?:采用|使用|为|：|:)\s*(宋体|仿宋|黑体|楷体)(?:[。；;，,\s]|$)/u.exec(clause.raw_text)
      if (size && Number(size[1]) !== view.values['body.size']) warnings.push(`格式冲突：招标要求正文字号 ${size[1]} 磅，当前为 ${String(view.values['body.size'])} 磅。`)
      if (font && font[1] !== view.values['body.font']) warnings.push(`格式冲突：招标要求正文字体 ${font[1]}，当前为 ${String(view.values['body.font'])}。`)
    }
  }
  return { ...view, warnings }
}

async function decorateView(workspace: BidWorkspace, templateId: DocxTemplateId | null, view: DocxFormatCoreView): Promise<DocxFormatView> {
  return { ...await withTenderWarnings(workspace, view), templateId, library: await readDocxTemplateLibrary(workspace) }
}

/** 读取明确模板；省略模板 ID 时读取 S5 页数基准，null 明确读取系统默认格式。 */
export async function readDocxFormat(workspace: BidWorkspace, templateId?: DocxTemplateId | null): Promise<DocxFormatView> {
  const registry = await readDocxTemplateRegistry(workspace)
  const selected = templateId === undefined ? registry.estimateTemplateId : templateId
  const template = selected === null ? undefined : registry.templates.find(item => item.id === selected)
  if (selected !== null && template === undefined) throw new Error('选择的 Word 模板不存在。')
  const path = formatPath(workspace, selected)
  await assertNoLinkedPath(workspace.root, path)
  const fields = formatFields(workspace.config)
  const state = await parseStateFile(path) ?? defaultDocxFormatState(fields)
  if (template !== undefined && (state.template?.hash !== template.hash
    || state.template.name !== template.name || state.template.parserVersion !== template.parserVersion)) {
    throw new Error('模板格式配置与模板身份不一致。')
  }
  return decorateView(workspace, selected, viewResolvedFormat(state, fields, workspace.config.docxTemplateMaxBytes))
}

/** 在调用方 Word 操作锁内原子保存一份模板或系统默认格式配置。 */
export async function writeDocxFormat(
  workspace: BidWorkspace,
  templateId: DocxTemplateId | null,
  state: DocxFormatState,
  commits?: Pick<BidCommitScope, 'writeJson'>,
): Promise<void> {
  const path = formatPath(workspace, templateId)
  await assertNoLinkedPath(workspace.root, path)
  if (templateId === null ? state.template !== undefined : state.template?.hash !== templateId)
    throw new Error('Word 格式配置与模板 ID 不一致。')
  const value = stateSchema.parse(state)
  if (commits === undefined) await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
  else await commits.writeJson(path, value)
}

async function resolveAndWrite(
  workspace: BidWorkspace,
  templateId: DocxTemplateId | null,
  state: DocxFormatState,
): Promise<DocxFormatView> {
  const view = resolveFormat(state, formatFields(workspace.config), workspace.config.docxTemplateMaxBytes)
  await writeDocxFormat(workspace, templateId, view.state)
  return decorateView(workspace, templateId, view)
}

/** 保存一份模板自己的完整冲突确认集合。 */
export async function saveDocxFormat(
  workspace: BidWorkspace,
  templateId: DocxTemplateId | null,
  request: DocxFormatRequest,
): Promise<DocxFormatView> {
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) throw new Error('Word 格式确认请求无效。')
  const current = await readDocxFormat(workspace, templateId)
  if (parsed.data.revision !== current.state.revision) throw new Error('配置已在其他页面修改，请重新加载后再确认。')
  const confirmed = validateFormatValues(parsed.data.userConfirmed, current.fields)
  for (const [key, value] of Object.entries(confirmed)) {
    const conflict = current.state.conflicts.find(item => item.key === key)
    if (!conflict || !conflict.evidence.some(item => sameValue(item.value, value)))
      throw new Error('冲突确认值不属于模板提供的候选。')
  }
  return resolveAndWrite(workspace, templateId, { ...current.state,
    revision: current.state.revision + 1, opened: true, userConfirmed: confirmed })
}

const sameValue = (left: FormatValue, right: FormatValue): boolean => typeof left === typeof right && left === right

/** 保存 DOCX 原文件并为新模板创建独立格式状态；相同摘要复用已有模板。 */
export async function saveDocxTemplate(
  workspace: BidWorkspace,
  upload: { revision: number; name: string; bytes: Uint8Array },
): Promise<DocxFormatView> {
  const parsed = templateUploadSchema.safeParse(upload)
  if (!parsed.success) throw new Error('Word 模板请求无效，请检查文件类型、大小和名称。')
  const registry = await readDocxTemplateRegistry(workspace)
  if (parsed.data.revision !== registry.revision) throw new Error('模板库已在其他页面修改，请重新加载后再上传。')
  const hash = templateIdSchema.parse(createHash('sha256').update(parsed.data.bytes).digest('hex'))
  const existing = registry.templates.find(template => template.hash === hash)
  if (existing !== undefined) return readDocxFormat(workspace, existing.id)
  const cache = within(workspace.projectRoot, `word-export/templates/${hash}.format-${DOCX_TEMPLATE_PARSER_VERSION}.json`)
  await assertNoLinkedPath(workspace.root, cache)
  let cached: string | undefined
  try { cached = await readFile(cache, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const result = cached === undefined
    ? await parseDocxTemplate(parsed.data.bytes, parsed.data.name, workspace.config.docxTemplateMaxBytes)
    : parsedTemplateSchema.parse(JSON.parse(cached))
  if (result.hash !== hash || result.parserVersion !== DOCX_TEMPLATE_PARSER_VERSION)
    throw new Error('模板解析缓存版本或文件标识不一致，请重新上传模板。')
  const templatePath = within(workspace.projectRoot, `word-export/templates/${hash}.docx`)
  await assertNoLinkedPath(workspace.root, templatePath)
  await atomicBytes(workspace.root, templatePath, parsed.data.bytes)
  await writeFileAtomic(cache, `${JSON.stringify(result)}\n`, { mode: 0o600, dirMode: 0o700 })
  const fields = formatFields(workspace.config)
  const state = defaultDocxFormatState(fields)
  const view = resolveFormat({ ...state,
    revision: 1,
    opened: true,
    template: { parserVersion: result.parserVersion, hash, name: parsed.data.name },
    extracted: result.extracted,
  }, fields, workspace.config.docxTemplateMaxBytes)
  await writeDocxFormat(workspace, hash, view.state)
  const next: DocxTemplateRegistry = { ...registry,
    revision: registry.revision + 1,
    estimateTemplateId: registry.templates.length === 0 && registry.estimateTemplateId === null
      ? hash
      : registry.estimateTemplateId,
    templates: [...registry.templates, { id: hash, hash, name: parsed.data.name,
      parserVersion: result.parserVersion, createdAt: new Date().toISOString() }] }
  await writeRegistry(workspace, next)
  return decorateView(workspace, hash, view)
}

/** 保存一份模板自己的模型格式解释。 */
export async function saveDocxFormatInterpretation(
  workspace: BidWorkspace,
  templateId: DocxTemplateId,
  revision: number,
  suggestion: DocxFormatSuggestion,
): Promise<DocxFormatView> {
  const current = await readDocxFormat(workspace, templateId)
  if (revision !== current.state.revision) throw new Error('模板已更新，请重新解析格式说明。')
  return resolveAndWrite(workspace, templateId, { ...current.state,
    revision: current.state.revision + 1,
    modelInterpreted: interpretationSchema.parse(suggestion) })
}

/** 显式选择 S5 页数基准；选择不改变任何模板自己的格式状态。 */
export async function setEstimateDocxTemplate(
  workspace: BidWorkspace,
  templateId: DocxTemplateId | null,
  revision: number,
): Promise<DocxTemplateLibraryView> {
  const registry = await readDocxTemplateRegistry(workspace)
  if (registry.revision !== revision) throw new Error('模板库已在其他页面修改，请重新加载后再选择。')
  if (templateId !== null && !registry.templates.some(template => template.id === templateId))
    throw new Error('选择的 Word 模板不存在。')
  if (registry.estimateTemplateId !== templateId)
    await writeRegistry(workspace, { ...registry, revision: registry.revision + 1, estimateTemplateId: templateId })
  return readDocxTemplateLibrary(workspace)
}

/** 标识正文、图片和 resolved 格式快照。 */
export function docxFingerprint(markdown: string, view: DocxFormatCoreView, assetHash: string): string {
  return createHash('sha256').update(markdown).update(assetHash).update(JSON.stringify(Object.entries(view.state.resolved).sort(([a],
    [b]) => a.localeCompare(b)))).digest('hex')
}
