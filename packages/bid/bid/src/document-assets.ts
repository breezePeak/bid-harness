/** 原稿派生文档的步骤回执与锚点来源；原件身份和派生版本分别保留。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { promptFileRefSchema, type PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import type { BidWorkspace } from './index.ts'
import { bidDocumentRefSchema, type BidDocumentRef } from './document-contract.ts'
import { docxBlockRefSchema } from './docx-document-index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { readDocxXml } from './docx-template.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
/** 文档实际版本和原授权锚点的精确对应关系。 */
export const bidDocumentRecordSchema = z.object({ schema_version: z.literal(1), ref: bidDocumentRefSchema,
  work_id: z.string().min(1), step_id: z.string().min(1), input_sha256: hash, path: z.string().min(1),
  root_file: promptFileRefSchema,
  parent: z.union([z.object({ kind: z.literal('file'), file_ref: promptFileRefSchema }).strict(), bidDocumentRefSchema]),
  anchors: z.array(z.object({ source: docxBlockRefSchema, node_path: z.array(z.number().int().nonnegative()).min(1),
    node_sha256: hash, kind: z.enum(['retained', 'inserted']) }).strict()),
  changes: z.array(z.object({ operation: z.number().int().nonnegative(), type: z.string().min(1), source: docxBlockRefSchema }).strict()),
  unchanged_parts: z.array(z.object({ path: z.string().min(1), sha256: hash }).strict()),
  structure_checked: z.literal(true),
  page_review: z.object({ report: z.string().min(1), sha256: hash, status: z.enum(['passed', 'issues']) }).strict().optional(),
}).strict()
/** 经版本校验的派生文档记录。 */
export type BidDocumentRecord = z.infer<typeof bidDocumentRecordSchema>

/**
 * 由当前稳定步骤身份生成独立文档路径，不覆盖原件。
 * @param stepId Host 的稳定步骤身份。
 * @returns 文档与唯一记录路径。
 */
export function bidDocumentPaths(stepId: string): Record<'id' | 'root' | 'document' | 'record' | 'review' | 'pdf', string> {
  const id = createHash('sha256').update(stepId).digest('hex')
  const root = `assets/documents/${id}`
  return { id, root, document: `${root}/document.docx`, record: `${root}/record.json`, review: `${root}/page-review.json`, pdf: `${root}/pages.pdf` }
}

/**
 * 读取准确派生版本，检查文档字节、记录身份和真实 OOXML 结构。
 * @param workspace 正式项目或同一 Work 候选。
 * @param ref 已验证回执中的版本。
 * @returns 实际字节及来源记录。
 */
export async function readBidDocument(workspace: BidWorkspace, ref: BidDocumentRef): Promise<{ bytes: Buffer; record: BidDocumentRecord }> {
  bidDocumentRefSchema.parse(ref)
  const recordPath = within(workspace.projectRoot, `assets/documents/${ref.document_id}/record.json`)
  await assertNoLinkedPath(workspace.root, recordPath)
  const record = bidDocumentRecordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8')))
  const paths = bidDocumentPaths(record.step_id)
  if (paths.id !== ref.document_id || record.ref.document_id !== ref.document_id || record.ref.version !== ref.version
    || record.path !== paths.document) throw new Error('BID_DOCUMENT_IDENTITY_INVALID')
  const path = within(workspace.projectRoot, record.path)
  await assertNoLinkedPath(workspace.root, path)
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== ref.version) throw new Error('BID_DOCUMENT_VERSION_CHANGED')
  await readDocxXml(bytes)
  if (record.page_review !== undefined) {
    const reportPath = within(workspace.projectRoot, record.page_review.report)
    await assertNoLinkedPath(workspace.root, reportPath)
    if (createHash('sha256').update(await readFile(reportPath)).digest('hex') !== record.page_review.sha256) throw new Error('BID_DOCUMENT_REVIEW_CHANGED')
  }
  return { bytes, record }
}

/**
 * 为派生版本的索引绑定独立文件身份，不把它注册为原上传附件。
 * @param ref 步骤产物的真实文档引用。
 * @returns 仅用于版本和 XML 锚点校验的内部文件引用。
 */
export function documentIndexFileRef(ref: BidDocumentRef): PromptFileRef {
  return promptFileRefSchema.parse({ attachmentId: `file:${ref.document_id}`, version: ref.version })
}
