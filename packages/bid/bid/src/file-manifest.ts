/** 专业路线只保存原件用途和解析引用，元数据与语料状态读取唯一记录。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import type { BidWorkspace, BidManifest, ManifestFile, BidFileId } from './index.ts'
import { readBidFileRecord, bidFileParseReceiptSchema } from './file-assets.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** 当前用途绑定格式；拒绝复制原件信息的旧清单。 */
export const BID_MANIFEST_VERSION = 5 as const

const bindingSchema = z.object({ ref: promptFileRefSchema,
  role: z.enum(['tender', 'outline_framework', 'reference_bid', 'reference']),
  parse_key: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
const manifestSchema = z.object({ version: z.literal(BID_MANIFEST_VERSION), files: z.array(bindingSchema) }).strict()

/** 主 Agent 从已提交附件中选择专业用途，身份由文件位置绑定。 */
export const bidWorkflowFilesSchema = z.object({ files: z.array(z.object({
  file_ref: promptFileRefSchema, role: bindingSchema.shape.role,
}).strict()).min(1).max(20) }).strict()

/**
 * 解析专业用途绑定，不把原件元数据另存为业务清单权威。
 * @param value 磁盘清单 JSON。
 * @returns 严格校验后的原件、用途和语料引用。
 */
export function parseBidManifest(value: unknown): z.infer<typeof manifestSchema> {
  const version = z.object({ version: z.unknown() }).safeParse(value)
  if (!version.success || version.data.version !== BID_MANIFEST_VERSION) throw new Error('bid-unsupported-manifest-version')
  const result = manifestSchema.safeParse(value)
  if (!result.success) throw new Error('bid-invalid-manifest')
  return result.data
}

/**
 * 只读取用途绑定；缺少清单表示该路线尚未选择资料。
 * @param workspace 当前项目。
 * @returns 未复制原件和解析状态的用途清单。
 */
export async function readBidManifestBindings(workspace: BidWorkspace): Promise<z.infer<typeof manifestSchema>> {
  await assertNoLinkedPath(workspace.root, workspace.manifestPath)
  let raw: string
  try { raw = await readFile(workspace.manifestPath, 'utf8') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: BID_MANIFEST_VERSION, files: [] }
    throw error
  }
  return parseBidManifest(JSON.parse(raw))
}

/**
 * 将专业用途与权威原件、语料记录连接，供既有专业消费者使用。
 * @param workspace 当前项目。
 * @returns 只在读取时生成的资料投影；缺失引用或版本冲突拒绝。
 */
export async function readBidManifest(workspace: BidWorkspace): Promise<BidManifest> {
  const bindings = await readBidManifestBindings(workspace)
  const files = await Promise.all(bindings.files.map(async (binding): Promise<ManifestFile> => {
    const file = await readBidFileRecord(workspace, binding.ref)
    const corpusPath = `assets/parsed/${binding.parse_key}`
    const path = within(workspace.projectRoot, `${corpusPath}/receipt.json`)
    await assertNoLinkedPath(workspace.root, path)
    const parsed = bidFileParseReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (parsed.input.content !== file.ref.sha256 || parsed.input.name !== file.ref.name
      || createHash('sha256').update(JSON.stringify(parsed.input)).digest('hex') !== binding.parse_key) throw new Error('BID_FILE_PARSE_IDENTITY_MISMATCH')
    return { id: String(file.ref.attachmentId) as BidFileId, role: binding.role, originalName: file.ref.name,
      inputPath: file.path, mediaType: file.ref.mediaType, size: file.ref.bytes, sha256: file.ref.sha256,
      corpusPath, documentPath: parsed.document ? `${corpusPath}/document.md` : null,
      structurePath: parsed.structure ? `${corpusPath}/structure.json` : null,
      metadataPath: parsed.structure ? `${corpusPath}/metadata.json` : null,
      chunksPath: parsed.chunks ? `${corpusPath}/chunks` : null,
      chunkIndexPath: parsed.chunks ? `${corpusPath}/chunks/index.json` : null,
      parseStatus: parsed.parseStatus, parseError: parsed.parseError }
  }))
  return { version: BID_MANIFEST_VERSION, files }
}
