/** 项目独立保存 Word 模板提取、模型解释、冲突确认和 resolved 格式。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BidWorkspace } from './index.ts'
import type { DocxFormatRequest, DocxFormatState, DocxFormatSuggestion, DocxFormatView, FormatValue } from './docx-format-contract.ts'
import { DOCX_TEMPLATE_PARSER_VERSION } from './docx-format-contract.ts'
import { defaultDocxFormatState, formatFields, FORMAT_ROLES, resolveFormat, validateFormatValues, viewResolvedFormat } from './docx-format.ts'
import { parseDocxTemplate } from './docx-template.ts'
import { parseTenderRequirementsArtifact, parseTenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within, atomicBytes } from './workspace-path.ts'

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
const templateSchema = z.strictObject({ parserVersion: z.literal(DOCX_TEMPLATE_PARSER_VERSION),
  hash: z.string().regex(/^[a-f\d]{64}$/u),
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
  lastExport: z.strictObject({ path: z.string().max(500),
    fingerprint: z.string().regex(/^[a-f\d]{64}$/u) }).optional() })
const requestSchema = z.strictObject({ revision: z.number().int().nonnegative(), userConfirmed: valuesSchema })
const templateUploadSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  name: z.string().max(200).regex(/\.docx$/iu),
  bytes: z.instanceof(Uint8Array) })
const parsedTemplateSchema = z.strictObject({ parserVersion: z.literal(DOCX_TEMPLATE_PARSER_VERSION),
  hash: z.string().regex(/^[a-f\d]{64}$/u), name: z.string().max(200), extracted: extractionSchema })

/**
 * 读取项目格式；首次读取返回完整默认 resolved，不触发解析或生成。
 * @param workspace 项目工作区。
 * @returns 已校验且不重新合并模板的格式视图。
 */
export async function readDocxFormat(workspace: BidWorkspace): Promise<DocxFormatView> {
  const path = within(workspace.projectRoot, 'word-export/config.json')
  await assertNoLinkedPath(workspace.root, path)
  const fields = formatFields(workspace.config)
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return withTenderWarnings(workspace, viewResolvedFormat(defaultDocxFormatState(fields), fields, workspace.config.docxTemplateMaxBytes))
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('保存的 Word 格式配置不是有效 JSON，请恢复配置文件。') }
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) throw new Error('保存的 Word 格式配置版本过旧或已损坏，请重新上传模板。')
  return withTenderWarnings(workspace, viewResolvedFormat(parsed.data, fields, workspace.config.docxTemplateMaxBytes))
}

async function withTenderWarnings(workspace: BidWorkspace, view: DocxFormatView): Promise<DocxFormatView> {
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

/**
 * 在调用方 Word 操作锁内原子保存配置。
 * @param workspace 项目工作区。
 * @param state 已确认的完整配置。
 */
export async function writeDocxFormat(workspace: BidWorkspace, state: DocxFormatState): Promise<void> {
  const path = within(workspace.projectRoot, 'word-export/config.json')
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, `${JSON.stringify(stateSchema.parse(state))}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function resolveAndWrite(workspace: BidWorkspace, state: DocxFormatState): Promise<DocxFormatView> {
  const view = resolveFormat(state, formatFields(workspace.config), workspace.config.docxTemplateMaxBytes)
  await writeDocxFormat(workspace, view.state)
  return withTenderWarnings(workspace, view)
}

/**
 * 校验版本和证据选项后保存用户的完整冲突确认集合。
 * @param workspace 已持 Word 操作锁的工作区。
 * @param request 用户确认值及读取版本。
 * @returns 保存后的 resolved 格式。
 */
export async function saveDocxFormat(workspace: BidWorkspace, request: DocxFormatRequest): Promise<DocxFormatView> {
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) throw new Error('Word 格式确认请求无效。')
  const current = await readDocxFormat(workspace)
  if (parsed.data.revision !== current.state.revision) throw new Error('配置已在其他页面修改，请重新加载后再确认。')
  const confirmed = validateFormatValues(parsed.data.userConfirmed, current.fields)
  for (const [key, value] of Object.entries(confirmed)) {
    const conflict = current.state.conflicts.find(item => item.key === key)
    if (!conflict || !conflict.evidence.some(item => sameValue(item.value, value)))
      throw new Error('冲突确认值不属于模板提供的候选。')
  }
  return resolveAndWrite(workspace, { ...current.state,
    revision: current.state.revision + 1,
    opened: true,
    userConfirmed: confirmed })
}

const sameValue = (left: FormatValue, right: FormatValue): boolean => typeof left === typeof right && left === right

/**
 * 保存独立二进制请求中的 DOCX 模板并清空旧模型解释。
 * @param workspace 已持 Word 操作锁的工作区。
 * @param upload 读取版本、显示名称和原始 DOCX 字节。
 * @returns 确定性提取后的 resolved 格式。
 */
export async function saveDocxTemplate(
  workspace: BidWorkspace,
  upload: { revision: number; name: string; bytes: Uint8Array },
): Promise<DocxFormatView> {
  const parsed = templateUploadSchema.safeParse(upload)
  if (!parsed.success) throw new Error('Word 模板请求无效，请检查文件类型、大小和名称。')
  const current = await readDocxFormat(workspace)
  if (parsed.data.revision !== current.state.revision) throw new Error('配置已在其他页面修改，请重新加载后再上传。')
  const hash = createHash('sha256').update(parsed.data.bytes).digest('hex')
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
  return resolveAndWrite(workspace, { ...current.state,
    revision: current.state.revision + 1,
    opened: true,
    template: { parserVersion: result.parserVersion, hash, name: parsed.data.name },
    extracted: result.extracted,
    modelInterpreted: { values: {}, mapping: {}, evidence: [] },
    userConfirmed: {},
    lastExport: undefined })
}

/**
 * 校验并保存一次模型模板解释；正文和提取结果保持不变。
 * @param workspace 已持 Word 操作锁的工作区。
 * @param revision 解释所依据的配置版本。
 * @param suggestion 已通过模型输出校验的解释。
 * @returns 重新合并冲突后的 resolved 格式。
 */
export async function saveDocxFormatInterpretation(
  workspace: BidWorkspace,
  revision: number,
  suggestion: DocxFormatSuggestion,
): Promise<DocxFormatView> {
  const current = await readDocxFormat(workspace)
  if (revision !== current.state.revision) throw new Error('模板已更新，请重新解析格式说明。')
  return resolveAndWrite(workspace, { ...current.state,
    revision: current.state.revision + 1,
    modelInterpreted: interpretationSchema.parse(suggestion) })
}

/**
 * 标识一次内容和 resolved 格式快照，供预览及下载判断过期。
 * @param markdown 已完成的正文。
 * @param view 当前 resolved 格式。
 * @param assetHash 渲染时实际读取的图片摘要。
 * @returns 稳定的内容标识。
 */
export function docxFingerprint(markdown: string, view: DocxFormatView, assetHash: string): string {
  return createHash('sha256').update(markdown).update(assetHash).update(JSON.stringify(Object.entries(view.state.resolved).sort(([a],
    [b]) => a.localeCompare(b)))).digest('hex')
}
