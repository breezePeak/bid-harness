/** 原稿补丁能力复用 Work 候选、精确发布许可和步骤回执。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult, BidCapabilityScope, BidCapabilityTask } from './bid-capability-contract.ts'
import type { PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { readBidFileRecord } from './file-assets.ts'
import { readBidFigure } from './figure-assets.ts'
import { readPublishedBidFigure } from './published-figures.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bidDocumentPaths, bidDocumentRecordSchema, readBidDocument, documentIndexFileRef, type BidDocumentRecord } from './document-assets.ts'
import { resolveBidStepOutput } from './bid-step-outputs.ts'
import { patchDocxDocument, type DocumentPatchOperation } from './document-patch.ts'
import type { DocxBlockRef } from './docx-document-index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import type { BidWorkspace } from './index.ts'

type PatchCall = Extract<BidCapabilityCall, { capability: 'document.patch' }>
type DocumentCall = Extract<BidCapabilityCall, { capability: 'document.patch' | 'document.layout_review' }>
const sameFile = (a: PromptFileRef, b: PromptFileRef) => a.attachmentId === b.attachmentId && a.version === b.version

/**
 * 核对原件与块属于根修改范围；只读来源不会因出现在任务中变为可写。
 * @param scope 原用户授权目标。
 * @param file 文档来源原件。
 * @param block 可选的具体原稿节点。
 */
export function assertDocumentTarget(scope: BidCapabilityScope | undefined, file: PromptFileRef, block?: DocxBlockRef): void {
  if (scope?.kind === 'files' && scope.file_refs.some(ref => sameFile(ref, file))) return
  if (scope?.kind === 'document_blocks' && scope.block_refs.some(ref => sameFile(ref.file_ref, file)
    && (block === undefined || ref.part === block.part && ref.node_path.length <= block.node_path.length
      && ref.node_path.every((position, index) => position === block.node_path[index])))) return
  throw new Error('BID_DOCUMENT_TARGET_OUTSIDE_SCOPE')
}

/**
 * 在任务接纳及计划修订时检查具体目标范围，派生对象在执行时再核对真实来源。
 * @param task 用户授权范围和完整计划。
 */
export function validateDocumentTaskTargets(task: BidCapabilityTask): void {
  for (const { call } of task.steps) {
    if (call.capability !== 'document.patch' && call.capability !== 'document.layout_review') continue
    if (call.input.document.source === 'file') assertDocumentTarget(task.scope, call.input.document.file_ref)
    if (call.capability === 'document.patch') for (const operation of call.input.operations) {
      const anchor = operation.block_ref ?? operation.candidate_block_ref?.source_ref
      if (anchor === undefined) throw new Error('BID_DOCUMENT_ANCHOR_REQUIRED')
      assertDocumentTarget(task.scope, anchor.file_ref, anchor)
    }
  }
}

/**
 * 从原件或同 Work 已验证输出读取待处理版本。
 * @param call 当前文档能力。
 * @param context 原目标权限和稳定前序回执。
 * @returns 文档字节、当前索引身份及原稿来源。
 */
export async function resolveCapabilityDocument(call: DocumentCall, context: BidCapabilityExecutionContext): Promise<{
  bytes: Buffer
  indexRef: PromptFileRef
  rootFile: PromptFileRef
  parent: BidDocumentRecord['parent']
  record: BidDocumentRecord | undefined
}> {
  if (call.input.document.source === 'file') {
    const ref = call.input.document.file_ref
    assertDocumentTarget(context.taskScope, ref)
    const file = await readBidFileRecord(context.working, ref)
    if (!file.ref.name.toLowerCase().endsWith('.docx')) throw new Error('BID_DOCX_REQUIRED')
    return { bytes: file.bytes, indexRef: ref, rootFile: ref,
      parent: { kind: 'file' as const, file_ref: ref }, record: undefined }
  }
  const ref = resolveBidStepOutput(call.input.document, 'document', context)
  const { bytes, record } = await readBidDocument(context.working, ref)
  if (record.work_id !== context.rootWorkId) throw new Error('BID_DOCUMENT_SOURCE_WORK_MISMATCH')
  assertDocumentTarget(context.taskScope, record.root_file)
  return { bytes, indexRef: documentIndexFileRef(ref), rootFile: record.root_file, parent: ref, record }
}

/**
 * 原稿补丁只有两个固定写入目标。
 * @param stepId Host 的稳定步骤身份。
 * @returns 新文档和精确回执路径。
 */
export function allowedDocumentPatchWrites(stepId: string): ReadonlySet<string> {
  const paths = bidDocumentPaths(stepId)
  return new Set([paths.document, paths.record])
}

/**
 * 修改候选副本并保存原锚点到新版本的对应关系，恢复复用同一步骤的准确产物。
 * @param call Host 已绑定目标节点与资产选择。
 * @param context 当前 Work 的隔离候选和提交权限。
 * @returns 真实 DOCX 版本和结构证据。
 */
export async function executeDocumentPatch(call: PatchCall,
  context: BidCapabilityExecutionContext): Promise<{ result: BidCapabilityResult }> {
  const paths = bidDocumentPaths(context.stepId)
  const result = (version: string): { result: BidCapabilityResult } => ({ result: { target_section_ids: [],
    outputs: [{ kind: 'document', document_id: paths.id, version }], changed_artifacts: [...allowedDocumentPatchWrites(context.stepId)],
    change_summary: `已对原 Word 应用 ${String(call.input.operations.length)} 项局部补丁并核对结构。`,
    warnings: ['页面检查需由 document.layout_review 对此实际版本完成。'], missing_topics: [], needs_input: false,
  } })
  const recordPath = within(context.working.projectRoot, paths.record)
  await assertNoLinkedPath(context.working.root, recordPath)
  let saved: string | undefined
  try { saved = await readFile(recordPath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (saved !== undefined) {
    const record = bidDocumentRecordSchema.parse(JSON.parse(saved))
    await validateDocumentCapability(context, result(record.ref.version).result)
    return result(record.ref.version)
  }
  const source = await resolveCapabilityDocument(call, context)
  const operations: DocumentPatchOperation[] = []
  for (const operation of call.input.operations) {
    const original = operation.block_ref ?? operation.candidate_block_ref?.source_ref
    if (original === undefined) throw new Error('BID_DOCUMENT_ANCHOR_REQUIRED')
    assertDocumentTarget(context.taskScope, source.rootFile, original)
    if (!sameFile(source.rootFile, original.file_ref)) throw new Error('BID_DOCUMENT_ANCHOR_SOURCE_MISMATCH')
    let block = original
    if (operation.candidate_block_ref !== undefined) {
      const selected = operation.candidate_block_ref
      if (source.record === undefined || JSON.stringify(selected.document_ref) !== JSON.stringify(source.record.ref)
        || !sameFile(selected.block_ref.file_ref, source.indexRef)
        || !source.record.anchors.some(anchor => JSON.stringify(anchor.source) === JSON.stringify(selected.source_ref)
          && anchor.node_sha256 === selected.block_ref.node_sha256 && selected.block_ref.part === anchor.source.part
          && JSON.stringify(anchor.node_path) === JSON.stringify(selected.block_ref.node_path))) throw new Error('BID_DOCUMENT_DERIVED_ANCHOR_UNAVAILABLE')
      block = selected.block_ref
    } else if (source.record !== undefined) {
      const match = source.record.anchors.filter(anchor => anchor.kind === 'retained'
        && JSON.stringify(anchor.source) === JSON.stringify(original))
      const [anchor] = match
      if (match.length !== 1 || anchor === undefined) throw new Error('BID_DOCUMENT_DERIVED_ANCHOR_UNAVAILABLE')
      block = { ...original, file_ref: source.indexRef, node_path: [...anchor.node_path], node_sha256: anchor.node_sha256 }
    }
    if ('figure' in operation) {
      const ref = operation.figure.source === 'figure' ? operation.figure.figure_ref : resolveBidStepOutput(operation.figure, 'figure', context)
      const sourceSession = context.agent.ctx.sessions.get(SessionId(context.authorization.session_id))
      if (sourceSession === undefined) throw new Error('BID_DOCUMENT_SESSION_MISMATCH')
      const { record, png } = operation.figure.source === 'figure'
        ? await readPublishedBidFigure(context.canonical, sourceSession, ref) : await readBidFigure(context.working, ref)
      const { figure: _figure, ...semantic } = operation
      operations.push({ ...semantic, block_ref: block, image: png, title: record.title })
    } else operations.push({ ...operation, block_ref: block })
  }
  const patched = await patchDocxDocument(source.bytes, source.indexRef, operations)
  context.run.signal.throwIfAborted()
  const version = createHash('sha256').update(patched.bytes).digest('hex')
  const originalAnchor = (ref: DocxBlockRef) => source.record === undefined ? ref
    : source.record.anchors.find(anchor => anchor.node_sha256 === ref.node_sha256
      && JSON.stringify(anchor.node_path) === JSON.stringify(ref.node_path))?.source
  const record = bidDocumentRecordSchema.parse({ schema_version: 1, ref: { kind: 'document', document_id: paths.id, version },
    work_id: context.rootWorkId, step_id: context.stepId, input_sha256: context.inputSha256, path: paths.document,
    root_file: source.rootFile, parent: source.parent, structure_checked: true,
    changes: patched.changes.map(change => ({ ...change, source: originalAnchor(change.source) ?? change.source })),
    anchors: patched.anchors.flatMap((anchor) => {
      const origin = originalAnchor(anchor.source)
      const prior = source.record?.anchors.find(item => item.node_sha256 === anchor.source.node_sha256
        && JSON.stringify(item.node_path) === JSON.stringify(anchor.source.node_path))
      return origin === undefined ? [] : [{ ...anchor, source: origin,
        kind: prior?.kind === 'inserted' ? 'inserted' : anchor.kind }]
    }), unchanged_parts: patched.unchanged_parts,
  })
  await context.run.commits.publish(async (lease) => {
    await lease.writeBytes(within(context.working.projectRoot, paths.document), patched.bytes)
    await lease.writeJson(recordPath, record)
  })
  return result(version)
}

/**
 * 从真实文件与原件来源复验文档输出，候选和恢复共用。
 * @param context 当前受控候选。
 * @param result 执行器提交的输出。
 */
export async function validateDocumentCapability(context: BidCapabilityExecutionContext, result: BidCapabilityResult): Promise<void> {
  const ref = result.outputs?.[0]
  if (result.outputs?.length !== 1 || ref?.kind !== 'document') throw new Error('BID_DOCUMENT_OUTPUT_REQUIRED')
  const { record } = await readBidDocument(context.working, ref)
  if (record.work_id !== context.rootWorkId || record.step_id !== context.stepId || record.input_sha256 !== context.inputSha256) throw new Error('BID_DOCUMENT_REQUEST_CHANGED')
  assertDocumentTarget(context.taskScope, record.root_file)
}

/**
 * 检查文档产物链的末端版本，含新增或替换图的交付必须有对应实际版本的通过记录。
 * @param workspace 已验证步骤合并后的 Work 候选。
 * @param results 已完成步骤的真实输出。
 */
export async function validateDocumentTaskResult(workspace: BidWorkspace, results: readonly BidCapabilityResult[]): Promise<void> {
  const records = await Promise.all(results.flatMap(result => result.outputs ?? []).flatMap(ref =>
    ref.kind === 'document' ? [readBidDocument(workspace, ref).then(item => item.record)] : []))
  for (const record of records) {
    if (records.some(child => child.parent.kind === 'document' && child.parent.document_id === record.ref.document_id
      && child.parent.version === record.ref.version)) continue
    const chain = [record]
    for (let current = record; current.parent.kind === 'document';) {
      const parent = current.parent
      const source = records.find(item => item.ref.document_id === parent.document_id && item.ref.version === parent.version)
      if (source === undefined || chain.includes(source)) throw new Error('BID_DOCUMENT_LINEAGE_INVALID')
      chain.push(source); current = source
    }
    if (chain.some(item => item.changes.some(change => change.type === 'insert_figure' || change.type === 'replace_figure'))
      && record.page_review?.status !== 'passed') throw new Error('BID_DOCUMENT_FINAL_PAGES_REQUIRED: 含配图的最终 Word 尚未通过实际页面检查。')
  }
}
