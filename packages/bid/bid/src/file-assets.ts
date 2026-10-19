/** 不可变原件接入与会话日志授权；上传不运行专业路线或解析器。 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import { messageFileRefSchema, promptFileRefSchema, type MessageFileRef, type PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import type { BidWorkspace, IncomingFile } from './index.ts'
import { safeFileName, validateBidFileBatch } from './file-input.ts'
import { assertNoLinkedPath, atomicBytes, within } from './workspace-path.ts'
import { parseBidFileContents } from './file-parse.ts'

const fileRecordSchema = z.object({ schema_version: z.literal(1), owner_session_id: z.string().min(1),
  ref: messageFileRefSchema, path: z.string().min(1) }).strict()

const mediaTypes: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
}

function recordPath(workspace: BidWorkspace, ref: PromptFileRef): string {
  const parsed = promptFileRefSchema.parse({ attachmentId: ref.attachmentId, version: ref.version })
  return within(workspace.projectRoot, `assets/files/${parsed.attachmentId.slice(5)}.json`)
}

/**
 * 原件接入完成即返回可提交引用；同会话同名同字节重试复用身份。
 * @param workspace 文件所属工作区。
 * @param session 当前真实主会话。
 * @param file 已读取的有界上传字节与名称，不赋予业务角色。
 * @returns 由 Host 生成的不可变原件引用。
 */
export async function receiveBidFile(workspace: BidWorkspace, session: Pick<Session, 'id'>, file: IncomingFile): Promise<MessageFileRef> {
  validateBidFileBatch([file], workspace.config)
  const name = safeFileName(file.name)
  const sha256 = createHash('sha256').update(file.bytes).digest('hex')
  if (file.ref !== undefined) {
    const existing = await readBidFileRecord(workspace, file.ref)
    if (existing.ref.name !== name || existing.ref.sha256 !== sha256) throw new Error('BID_FILE_VERSION_MISMATCH')
    return existing.ref
  }
  const identity = createHash('sha256').update(JSON.stringify([String(session.id), name, sha256])).digest('hex')
  const ref = messageFileRefSchema.parse({ attachmentId: `file:${identity}`, version: sha256, sha256, name,
    mediaType: mediaTypes[extname(name).toLowerCase()] ?? 'application/octet-stream', bytes: file.bytes.byteLength })
  const path = `assets/originals/${sha256}/${name}`
  await atomicBytes(workspace.root, within(workspace.projectRoot, path), file.bytes)
  await atomicBytes(workspace.root, recordPath(workspace, ref), Buffer.from(JSON.stringify({
    schema_version: 1, owner_session_id: String(session.id), ref, path,
  }) + '\n'))
  return ref
}

/**
 * 只读取当前分支已保存消息中的附件，分叉点后的父会话文件不在此集合。
 * @param session 当前会话及其 seed 日志。
 * @returns 首次出现顺序的完整原件引用。
 */
export function bidMessageFiles(session: Session): MessageFileRef[] {
  const files = new Map<string, MessageFileRef>()
  for (const event of session.events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user' || !('fileRefs' in event.data.source)) continue
    for (const ref of z.array(messageFileRefSchema).max(20).parse(event.data.source.fileRefs)) {
      files.set(`${ref.attachmentId}:${ref.version}`, ref)
    }
  }
  return [...files.values()]
}

/**
 * 接纳时允许本会话上传的原件；已提交材料根据当前分支日志验证。
 * @param workspace 当前工作区。
 * @param session 当前主会话。
 * @param reference 上传回执或模型位置绑定得到的引用。
 * @param admission 是否处于用户消息接纳；普通读取必须已有消息授权。
 * @returns 校验过的引用、原件路径和原始字节。
 */
export async function resolveBidFile(workspace: BidWorkspace, session: Session,
  reference: PromptFileRef, admission = false): ReturnType<typeof readBidFileRecord> {
  const record = await readBidFileRecord(workspace, reference)
  const logged = bidMessageFiles(session).some(ref => JSON.stringify(ref) === JSON.stringify(record.ref))
  if (!logged && !(admission && record.owner_session_id === String(session.id))) throw new Error('BID_FILE_NOT_REFERENCED')
  return record
}

/**
 * 读取 Host 原件记录并校验字节；业务用途和会话授权由调用入口单独核对。
 * @param workspace 拥有原件的项目。
 * @param reference 已绑定的原件身份与版本。
 * @returns 权威元数据、路径及校验过的原始字节。
 */
export async function readBidFileRecord(workspace: BidWorkspace,
  reference: PromptFileRef): Promise<z.infer<typeof fileRecordSchema> & { absolutePath: string; bytes: Buffer }> {
  const path = recordPath(workspace, reference)
  await assertNoLinkedPath(workspace.root, path)
  const record = fileRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (record.ref.attachmentId !== reference.attachmentId || record.ref.version !== reference.version) throw new Error('BID_FILE_VERSION_MISMATCH')
  const absolutePath = within(workspace.projectRoot, record.path)
  await assertNoLinkedPath(workspace.root, absolutePath)
  const info = await stat(absolutePath)
  if (!info.isFile() || info.size !== record.ref.bytes || info.size > workspace.config.maxFileBytes) throw new Error('BID_FILE_CONTENT_CHANGED')
  const bytes = await readFile(absolutePath)
  if (bytes.byteLength !== record.ref.bytes || createHash('sha256').update(bytes).digest('hex') !== record.ref.sha256) {
    throw new Error('BID_FILE_CONTENT_CHANGED')
  }
  return { ...record, absolutePath, bytes }
}

/** 内容、格式及解析选项共同标识的一份语料回执。 */
export const bidFileParseReceiptSchema = z.object({ schema_version: z.literal(1),
  input: z.object({ content: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string().min(1), parser: z.literal('bid-document-text-1'),
    chunks: z.object({ minChars: z.number().int().positive(), targetChars: z.number().int().positive(),
      maxChars: z.number().int().positive() }).strict() }).strict(),
  parseStatus: z.enum(['success', 'needs_ocr', 'failed']), parseError: z.string().nullable(),
  document: z.boolean(), structure: z.boolean(), chunks: z.boolean(),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict()

/**
 * 按唯一原件记录解析；成功缓存可复用，失败回执允许重试。
 * @param workspace 原件所属项目。
 * @param reference 已经过用途或会话权限校验的文件引用。
 * @param stagingRoot 可选 Run 私有暂存目录；解析发布仍归该 Run。
 * @returns 稳定语料键及真实解析回执。
 */
export async function parseBidFileAsset(workspace: BidWorkspace,
  reference: PromptFileRef, stagingRoot?: string): Promise<{ key: string; receipt: z.infer<typeof bidFileParseReceiptSchema> }> {
  const file = await readBidFileRecord(workspace, reference)
  const input = bidFileParseReceiptSchema.shape.input.parse({ content: file.ref.sha256, name: file.ref.name,
    parser: 'bid-document-text-1', chunks: workspace.config.documentChunk })
  const key = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const cachePath = `assets/parsed/${key}`
  const receiptPath = within(workspace.projectRoot, `${cachePath}/receipt.json`)
  await assertNoLinkedPath(workspace.root, receiptPath)
  let receipt: z.infer<typeof bidFileParseReceiptSchema> | undefined
  try { receipt = bidFileParseReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8'))) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (receipt !== undefined && JSON.stringify(receipt.input) !== JSON.stringify(input)) throw new Error('BID_FILE_PARSE_IDENTITY_MISMATCH')
  if (receipt !== undefined && receipt.parseStatus !== 'failed') return { key, receipt }
  const output = within(stagingRoot ?? workspace.projectRoot, cachePath)
  try {
    const parsed = await parseBidFileContents(workspace.root, file.absolutePath, output, workspace.config.documentChunk)
    receipt = { schema_version: 1, input, parseStatus: parsed.parseStatus, parseError: null,
      document: true, structure: parsed.structurePath !== null, chunks: parsed.chunksPath !== null,
      textSha256: createHash('sha256').update(await readFile(parsed.documentPath)).digest('hex') }
  } catch (error: unknown) {
    receipt = { schema_version: 1, input, parseStatus: 'failed', parseError: error instanceof Error ? error.message : String(error),
      document: false, structure: false, chunks: false, textSha256: null }
  }
  await atomicBytes(workspace.root, within(output, 'receipt.json'), Buffer.from(JSON.stringify(receipt) + '\n'))
  return { key, receipt }
}

/**
 * 读取时才解析已授权原件；失败保留原件，后续同版本读取可以重试。
 * @param workspace 当前锁内工作区。
 * @param session 当前主会话。
 * @param reference 由对象目录绑定的不可变引用。
 * @param offset 文本字符窗口起点。
 * @param maxChars 本次有界读取长度。
 * @returns 可进入工具日志的语料窗口和实际解析状态。
 */
export async function readBidFileText(workspace: BidWorkspace, session: Session, reference: PromptFileRef,
  offset: number, maxChars: number): Promise<{
  ref: MessageFileRef
  parse_status: 'success' | 'needs_ocr'
  offset: number
  total_chars: number
  text: string
  has_more: boolean
}> {
  const file = await resolveBidFile(workspace, session, reference)
  const { key, receipt } = await parseBidFileAsset(workspace, file.ref)
  if (receipt.parseStatus === 'failed') throw new Error(receipt.parseError ?? 'DOCUMENT_PARSE_FAILED')
  const cache = within(workspace.projectRoot, `assets/parsed/${key}`)
  const textPath = within(cache, 'document.md')
  await assertNoLinkedPath(workspace.root, textPath)
  const bytes = await readFile(textPath)
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.textSha256) throw new Error('BID_FILE_PARSE_CACHE_CHANGED')
  const text = bytes.toString('utf8')
  return { ref: file.ref, parse_status: receipt.parseStatus, offset, total_chars: text.length,
    text: text.slice(offset, offset + maxChars), has_more: offset + maxChars < text.length }
}
