/** 只从本会话已发布回执选择最终图和 Word，浏览器不能提交 Host 路径。 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BidWorkspace } from './index.ts'
import type { BidTaskDeliverablesView } from './control-plane-contract.ts'
import { bidInputFingerprint, readBidWorkDescriptor, readBidWorkRequest } from './work-descriptor.ts'
import { capabilityTaskRequestSchema } from './bid-capability-task.ts'
import { readCapabilityPublicationReceipt } from './bid-capability-changes.ts'
import { readBidFigure, bidFigureRecordSchema } from './figure-assets.ts'
import { readBidDocument, bidDocumentRecordSchema } from './document-assets.ts'
import { readBidFileRecord } from './file-assets.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { hasBidTaskAuthorization } from './bid-tool-authorization.ts'

interface FileChoice { path: string; name: string; mediaType: string; preview?: string }
const mime = (path: string) => ({ '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[extname(path)] ?? 'application/octet-stream'

async function publishedChoices(workspace: BidWorkspace, session: Session, workId: string) {
  const work = await readBidWorkDescriptor(workspace, workId)
  if (work?.kind !== 'capability_task') throw new Error('BID_DELIVERY_WORK_INVALID')
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
  if (request.authorization.session_id !== String(session.id) || !hasBidTaskAuthorization(session, request.authorization)) throw new Error('BID_DELIVERY_SESSION_MISMATCH')
  const receipt = await readCapabilityPublicationReceipt(workspace, workId, work.requestSha256)
  if (receipt?.goal_met !== true) throw new Error('BID_DELIVERY_NOT_PUBLISHED')
  const paths = new Set(receipt.files.map(file => file.path))
  const documents = []
  const figures = []
  for (const file of receipt.files) {
    if (!/^assets\/(?:documents|figures)\/[a-f0-9]{64}\/record\.json$/u.test(file.path)) continue
    const absolute = within(workspace.projectRoot, file.path)
    await assertNoLinkedPath(workspace.root, absolute)
    const raw = JSON.parse(await readFile(absolute, 'utf8')) as unknown
    if (file.path.startsWith('assets/documents/')) {
      const record = bidDocumentRecordSchema.parse(raw)
      if (record.work_id !== workId) throw new Error('BID_DELIVERY_SOURCE_INVALID')
      documents.push((await readBidDocument(workspace, record.ref)).record)
    } else {
      const record = bidFigureRecordSchema.parse(raw)
      if (record.work_id !== workId) throw new Error('BID_DELIVERY_SOURCE_INVALID')
      figures.push((await readBidFigure(workspace, record.ref)).record)
    }
  }
  const choices: FileChoice[] = []
  for (const record of documents) {
    if (documents.some(child => child.parent.kind === 'document' && child.parent.document_id === record.ref.document_id
      && child.parent.version === record.ref.version)) continue
    const original = await readBidFileRecord(workspace, record.root_file)
    const preview = record.page_review === undefined ? undefined : record.path.replace(/document\.docx$/u, 'pages.pdf')
    choices.push({ path: record.path, name: `${basename(original.ref.name, '.docx')}-修改版.docx`, mediaType: mime(record.path),
      ...(preview === undefined ? {} : { preview }) })
  }
  for (const record of figures) {
    choices.push({ path: record.path, name: `${record.title}.png`, mediaType: 'image/png', preview: record.path })
    for (const source of record.sources) choices.push({ path: source.path, name: `${record.title}${extname(source.path)}`, mediaType: mime(source.path) })
  }
  if (documents.length === 0) for (const path of paths) {
    if (!/^assets\/documents\/[a-f0-9]{64}\/page-review\.json$/u.test(path)) continue
    const pdf = path.replace(/page-review\.json$/u, 'pages.pdf')
    choices.push({ path, name: 'Word 排版检查.json', mediaType: 'application/json', preview: pdf })
  }
  for (const choice of choices) if (!paths.has(choice.path) || choice.preview !== undefined && !paths.has(choice.preview)) throw new Error('BID_DELIVERY_FILE_UNPUBLISHED')
  return { choices, receipt: bidInputFingerprint(receipt), hashes: new Map(receipt.files.map(file => [file.path, file.sha256])) }
}

/**
 * 给客户端提供本次真实交付的位置和展示信息，不暴露任意路径选择。
 * @param workspace 会话项目。
 * @param session 当前公开主会话。
 * @param workId 完成通知绑定的 Work。
 * @returns 最终文档、图及来源文件，已被后续版本替代的 DOCX 不作为交付项。
 */
export async function readTaskDeliverables(workspace: BidWorkspace, session: Session, workId: string): Promise<BidTaskDeliverablesView> {
  const { choices, receipt } = await publishedChoices(workspace, session, workId)
  return { receipt, files: await Promise.all(choices.map(async (choice, position) => ({ position, name: choice.name,
    mediaType: choice.mediaType, bytes: (await readFile(within(workspace.projectRoot, choice.path))).length,
    preview: choice.preview !== undefined }))) }
}

/** 浏览器下载只接受本会话、已发布 Work、固定回执和对象位置。 */
export const bidTaskDownloadSchema = z.object({ session: z.string().min(1), work: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  receipt: z.string().regex(/^[a-f0-9]{64}$/u), position: z.coerce.number().int().nonnegative(), mode: z.enum(['download', 'preview']),
}).strict()

/**
 * 从当前发布回执解析浏览器所选对象，拒绝旧回执、越界和未发布候选。
 * @param workspace 会话项目。
 * @param session 当前主会话。
 * @param input 已解析的位置请求。
 * @returns 校验过的文件字节与响应媒体类型。
 */
export async function readTaskDownload(workspace: BidWorkspace, session: Session,
  input: z.infer<typeof bidTaskDownloadSchema>): Promise<{ bytes: Buffer; name: string; mediaType: string }> {
  if (input.session !== String(session.id)) throw new Error('BID_DELIVERY_SESSION_MISMATCH')
  const { choices, receipt, hashes } = await publishedChoices(workspace, session, input.work)
  if (receipt !== input.receipt) throw new Error('BID_DELIVERY_RECEIPT_CHANGED')
  const choice = choices[input.position]
  if (choice === undefined || input.mode === 'preview' && choice.preview === undefined) throw new Error('BID_DELIVERY_POSITION_INVALID')
  const path = input.mode === 'preview' ? choice.preview : choice.path
  if (path === undefined) throw new Error('BID_DELIVERY_POSITION_INVALID')
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  const bytes = await readFile(absolute)
  if (createHash('sha256').update(bytes).digest('hex') !== hashes.get(path)) throw new Error('BID_DELIVERY_CONTENT_CHANGED')
  return { bytes, name: input.mode === 'preview' ? basename(path) : choice.name, mediaType: mime(path) }
}
