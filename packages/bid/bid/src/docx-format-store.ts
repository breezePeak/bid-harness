/** 项目独立保存 Word 模板与配置；不进入资料导入或章节记录。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BidWorkspace } from './index.ts'
import type { DocxFormatRequest, DocxFormatState, DocxFormatView } from './docx-format-contract.ts'
import { formatFields, FORMAT_ROLES, resolveFormat, validateFormatValues } from './docx-format.ts'
import { parseDocxTemplate } from './docx-template.ts'
import { parseTenderRequirementsArtifact, parseTenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath, within, atomicBytes } from './workspace-path.ts'
const valuesSchema = z.record(z.string().max(100), z.union([z.string().max(200), z.number(), z.boolean()]))
const requestSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  source: z.enum(['default',
    'template']),
  overrides: valuesSchema,
  mapping: z.record(z.string(),
    z.string().max(200)).refine(mapping => Object.keys(mapping).every(key => FORMAT_ROLES.includes(key as typeof FORMAT_ROLES[number]))),
  description: z.string().max(4000) })
const templateUploadSchema = z.strictObject({ revision: z.number().int().nonnegative(),
  name: z.string().max(200).regex(/\.docx$/iu),
  bytes: z.instanceof(Uint8Array) })
const templateSchema = z.strictObject({ hash: z.string().regex(/^[a-f\d]{64}$/u),
  name: z.string().max(200),
  values: valuesSchema,
  warnings: z.array(z.string().max(1000)).max(100),
  candidates: z.array(z.strictObject({ id: z.string().max(200),
    name: z.string().max(200),
    sample: z.string().max(160),
    values: valuesSchema,
    role: z.string().optional() })).max(200) })
const stateSchema = requestSchema.extend({ version: z.literal(1),
  opened: z.boolean(),
  template: templateSchema.optional(),
  previous: z.strictObject({ name: z.string(),
    values: valuesSchema }).optional(),
  lastExport: z.strictObject({ path: z.string().max(500),
    fingerprint: z.string().regex(/^[a-f\d]{64}$/u) }).optional() })
/**
 * 读取项目格式；首次读取只返回默认值，不触发解析或生成。
 * @param workspace 项目工作区。
 * @returns 已校验的格式视图。
 */
export async function readDocxFormat(workspace: BidWorkspace): Promise<DocxFormatView> {
  const path = within(workspace.projectRoot, 'word-export/config.json')
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
    return withTenderWarnings(workspace, resolveFormat({ version: 1,
      revision: 0,
      opened: false,
      source: 'default',
      overrides: {},
      mapping: {},
      description: '' },
    formatFields(workspace.config),
    workspace.config.docxTemplateMaxBytes))
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('保存的 Word 格式配置不是有效 JSON，请恢复配置文件。') }
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('保存的 Word 格式配置损坏，请恢复配置文件。')
  return withTenderWarnings(workspace, resolveFormat(parsed.data, formatFields(workspace.config), workspace.config.docxTemplateMaxBytes))
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
      // 仅比较明确的肯定句式，其他自然语言条款保留原文供用户核对。
      const size = /(?:^|[。；;，,\n])\s*正文(?:字号)?(?:采用|使用|为|：|:)?\s*(\d+(?:\.\d+)?)\s*磅(?:[。；;，,\s]|$)/u.exec(clause.raw_text)
      const font = /(?:^|[。；;，,\n])\s*正文(?:字体)?(?:采用|使用|为|：|:)\s*(宋体|仿宋|黑体|楷体)(?:[。；;，,\s]|$)/u.exec(clause.raw_text)
      if (size && Number(size[1]) !== view.values['body.size']) warnings.push(`格式冲突：招标要求正文字号 ${size[1]} 磅，当前为 ${String(view.values['body.size'])} 磅。`)
      if (font && font[1] !== view.values['body.font']) warnings.push(`格式冲突：招标要求正文字体 ${font[1]}，当前为 ${String(view.values['body.font'])}。`)
    }
  }
  return { ...view, warnings }
}
/**
 * 在调用方项目锁内原子保存配置。
 * @param workspace 项目工作区。
 * @param state 已确认的完整配置。
 */
export async function writeDocxFormat(workspace: BidWorkspace, state: DocxFormatState): Promise<void> {
  const path = within(workspace.projectRoot, 'word-export/config.json')
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, dirMode: 0o700 })
}
/**
 * 校验编辑版本并保存模板、映射和覆盖；同一模板复用已解析结果。
 * @param workspace 已持项目锁的工作区。
 * @param request 浏览器的完整编辑值。
 * @returns 保存后的配置和生效值。
 */
async function saveValidatedDocxFormat(
  workspace: BidWorkspace,
  current: DocxFormatView,
  input: z.infer<typeof requestSchema>,
  template?: { name: string; bytes: Uint8Array },
): Promise<DocxFormatView> {
  if (input.revision !== current.state.revision)
    throw new Error('配置已在其他页面修改，请重新加载后再保存。')
  const state: DocxFormatState = { ...current.state,
    revision: current.state.revision + 1,
    opened: true,
    source: input.source,
    overrides: validateFormatValues(input.overrides,
      current.fields),
    mapping: input.mapping,
    description: input.description }
  if (template) {
    const bytes = template.bytes
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (current.state.template?.hash !== hash) {
      state.previous = { name: current.state.template?.name ?? '默认配置', values: current.values }
      const cache = within(workspace.projectRoot, `word-export/templates/${hash}.json`)
      await assertNoLinkedPath(workspace.root, cache)
      let cached: string | undefined
      try {
        cached = await readFile(cache, 'utf8')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
      state.template = cached === undefined
        ? await parseDocxTemplate(bytes, template.name, workspace.config.docxTemplateMaxBytes)
        : templateSchema.parse(JSON.parse(cached))
      if (state.template.hash !== hash)
        throw new Error('模板解析缓存的文件标识不一致。')
      state.mapping = {}
      for (const role of FORMAT_ROLES) {
        const candidates = state.template.candidates.filter(item => item.role === role)
        if (candidates.length === 1 && candidates[0])
          state.mapping[role] = candidates[0].id
      }
      const path = within(workspace.projectRoot, `word-export/templates/${hash}.docx`)
      await assertNoLinkedPath(workspace.root, path)
      await atomicBytes(workspace.root, path, bytes)
      await writeFileAtomic(cache, `${JSON.stringify(state.template)}\n`, { mode: 0o600, dirMode: 0o700 })
    }
    state.source = 'template'
  }
  if (state.source === 'template' && !state.template)
    throw new Error('请先上传 Word 模板。')
  for (const id of Object.values(state.mapping))
    if (id !== '__default__' && !state.template?.candidates.some(item => item.id === id))
      throw new Error('选择的模板样式不存在，请重新映射。')
  const result = resolveFormat(state, current.fields, workspace.config.docxTemplateMaxBytes)
  await writeDocxFormat(workspace, state)
  return withTenderWarnings(workspace, result)
}

/**
 * 校验编辑版本并保存不含文件字节的格式配置。
 * @param workspace 已持项目锁的工作区。
 * @param request 浏览器的完整编辑值。
 * @returns 保存后的配置和生效值。
 */
export async function saveDocxFormat(workspace: BidWorkspace, request: DocxFormatRequest): Promise<DocxFormatView> {
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success)
    throw new Error('Word 配置请求无效，请检查字段。')
  return saveValidatedDocxFormat(workspace, await readDocxFormat(workspace), parsed.data)
}

/**
 * 保存独立二进制请求中的 DOCX 模板，并保留当前已保存配置。
 * @param workspace 已持项目锁的工作区。
 * @param upload 读取版本、显示名称和原始 DOCX 字节。
 * @returns 保存后的模板配置和生效值。
 */
export async function saveDocxTemplate(
  workspace: BidWorkspace,
  upload: { revision: number; name: string; bytes: Uint8Array },
): Promise<DocxFormatView> {
  const parsed = templateUploadSchema.safeParse(upload)
  if (!parsed.success)
    throw new Error('Word 模板请求无效，请检查文件类型、大小和名称。')
  const current = await readDocxFormat(workspace)
  return saveValidatedDocxFormat(workspace, current, {
    revision: parsed.data.revision,
    source: current.state.source,
    overrides: current.state.overrides,
    mapping: current.state.mapping,
    description: current.state.description,
  }, { name: parsed.data.name, bytes: parsed.data.bytes })
}
/**
 * 标识一次内容和配置快照，供预览及下载判断过期。
 * @param markdown 已完成的正文。
 * @param view 当前生效配置。
 * @param assetHash 渲染时实际读取的图片摘要。
 * @returns 稳定的内容标识。
 */
export function docxFingerprint(markdown: string, view: DocxFormatView, assetHash: string): string {
  return createHash('sha256').update(markdown).update(assetHash).update(JSON.stringify(Object.entries(view.values).sort(([a],
    [b]) => a.localeCompare(b)))).digest('hex')
}
