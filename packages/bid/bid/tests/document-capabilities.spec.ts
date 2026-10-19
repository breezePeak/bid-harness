/** 无专业目录的作图、原 Word 补丁、实际 LibreOffice 页面检查和 Work 恢复。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { receiveBidFile } from '../src/file-assets.ts'
import { collectBidModelTaskCatalog, bindBidModelTask, bidModelTaskJsonSchema } from '../src/bid-model-task.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { zodJsonSchema } from '../src/zod-json-schema.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { persistCapabilityTaskRequest, capabilityTaskCheckpointSchema, capabilityTaskRequestSchema, patchCapabilityTaskSteps } from '../src/bid-capability-task.ts'
import { executeTestCapabilityTask } from './fixtures/task-verifier.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { readBidDocument } from '../src/document-assets.ts'
import { indexDocxDocument } from '../src/docx-document-index.ts'
import { nativeDocumentFixture } from './fixtures/native-document.ts'
import { bindBidStepOutputs, bidPlanStepIds } from '../src/bid-step-outputs.ts'
import { bidTaskDownloadSchema, readTaskDeliverables, readTaskDownload } from '../src/task-deliverables.ts'
import { inspectCandidateDocument } from '../src/document-candidate.ts'
import { readBidWorkRequest } from '../src/work-descriptor.ts'
import { readExistingBidWorkingTree } from '../src/working-tree.ts'
import * as docxPdf from '../src/docx-pdf.ts'
import { collectBidTaskEvidence } from '../src/bid-task-verification.ts'

class PageReviewer extends LlmAdapter {
  visual = true
  readonly calls: GenerateOptions[] = []
  private adjusted = false
  private invalidReturned = false
  constructor(private readonly repair = false, private readonly invalidPosition: false | 'once' | 'always' | 'schema' = false) { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model,
      inputModalities: this.visual ? ['text', 'image'] as const : ['text'] as const })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const pageReview = options.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('page_position')))
    const adjust = pageReview && this.repair && !this.adjusted
    const invalid = pageReview && this.invalidPosition && (this.invalidPosition === 'always' || !this.invalidReturned)
    if (invalid) this.invalidReturned = true
    if (adjust) this.adjusted = true
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(pageReview
      ? invalid && this.invalidPosition === 'schema'
        ? { status: 'issues', issues: [{ page_position: 0, problem: '图片题注分离。' }],
          fixes: [{ kind: 'keep_with_next', block_position: 0, keep_with_next: true }] }
        : invalid ? { status: 'issues', issues: [{ page_position: 999, problem: '图片题注分离。' }],
          fixes: [{ kind: 'scale_figure', block_position: 999, scale: 0.8 }] }
          : adjust ? { status: 'issues', issues: [{ page_position: 0, problem: '新增图需要缩小以保持页面可读。' }],
            fixes: [{ kind: 'scale_figure', block_position: 1, scale: 0.8 }] }
            : { status: 'pass', issues: [], fixes: [] } : { status: 'pass', reason: '流程文字和箭头可读。' }) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const flow = { description: '绘制处理流程', scope: { source: 'task' }, call: { capability: 'flowchart.create', input: {
  title: '处理流程', purpose: '明确接收与处理', nodes: [{ type: 'start', text: '接收' }, { type: 'process', text: '处理' }, { type: 'end', text: '完成' }],
  edges: [{ from_position: 0, to_position: 1 }, { from_position: 1, to_position: 2 }],
} } }

it.each(['pass', 'repair', 'resume', 'replan', 'invalid_position', 'invalid_position_budget', 'invalid_schema', 'no_visual', 'no_renderer'] as const)('同一计划预先选择图输出，程序插入原稿并检查全部实际页面：%s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-original-document-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(AttachmentLocal, { dshHome: root })
    const reviewer = new PageReviewer(mode === 'repair', mode === 'invalid_position' ? 'once'
      : mode === 'invalid_position_budget' ? 'always' : mode === 'invalid_schema' ? 'schema' : false)
    ctx.effect(() => ctx.llm.registerAdapter(['document-test'], reviewer))
    const session = ctx.sessions.create()
    session.append('request/header', { header: { config: { provider: 'document-test', model: 'visual' } }, reason: 'initial' })
    const fixture = await nativeDocumentFixture()
    const file = await receiveBidFile(workspace, session, { name: '已有成稿.docx', bytes: fixture.bytes })
    const message = createUserMessage({ content: [{ type: 'text', text: '在第二处重复原文后添加处理流程图，保持其他内容并交付检查过页面的 Word。' }],
      source: { kind: 'user', fileRefs: [file] } })
    session.append('turn/start', { turn: 1 }); session.append('user/message', message, { surfaceOp: 'append' })
    const ref = { attachmentId: file.attachmentId, version: file.version }
    const catalog = await collectBidModelTaskCatalog(workspace, session, ref)
    const blocks = (await indexDocxDocument(fixture.bytes, ref)).blocks
    const target = blocks.indexOf(blocks.filter(block => block.kind === 'paragraph' && block.text === '重复原文')[1]!)
    const input = { goal: '为原 Word 配图并完成页面检查', scope: { kind: 'files', file_positions: [0] }, steps: [flow,
      { description: '插入原稿第二处', scope: { source: 'task' }, call: { capability: 'document.patch', input: {
        document: { source: 'file', file_position: 0 }, operations: [{ type: 'insert_figure', block_position: target,
          placement: 'after', figure: { source: 'step_outputs', step_position: 0, output_positions: [0] }, caption: '处理流程' }],
      } } },
      { description: '检查并完成页面', scope: { source: 'task' }, call: { capability: 'document.layout_review', input: {
        document: { source: 'step_outputs', step_position: 1, output_positions: [0] }, mode: 'repair', reason: '检查新增图片、题注及其他页面；保留原稿结构。',
      } } },
    ] }
    const schema = JSON.stringify(bidModelTaskJsonSchema(zodJsonSchema(bidCapabilityTaskSchema)))
    expect(schema).toContain('step_position'); expect(schema).not.toContain('"node_sha256"')
    const task = bindBidModelTask(input, catalog)
    if (mode === 'replan') task.scope = { kind: 'document_blocks', block_refs: [blocks[target]!.ref] }
    const ids = bidPlanStepIds(task.steps, { source: '真实用户消息' })
    expect(bindBidStepOutputs(task.steps, ids)[2]).toEqual([{ step_position: 1, step_id: ids[1] }])
    for (const [step_position, output_positions] of [[1, [0]], [2, [0]], [0, [1]]] as const) {
      const bad = structuredClone(input)
      const operation = (bad.steps[1] as typeof input.steps[1]
        & { call: { input: { operations: Array<{ figure: object }> } } }).call.input.operations[0]!
      operation.figure = { source: 'step_outputs', step_position, output_positions }
      const parsed = bindBidModelTask(bad, catalog)
      expect(() => bindBidStepOutputs(parsed.steps, ids)).toThrow('BID_STEP_OUTPUT_')
    }
    const work = await persistCapabilityTaskRequest(workspace, session, task,
      { session_id: String(session.id), message_id: String(message.id) }, [])
    const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 2, evidenceMappingMaxConcurrency: 1,
      chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
    const agent = { ctx, session } as unknown as Agent
    let interrupted = false
    const execute = () => {
      const run = createTestBidRunContext({ work })
      const writeJson = run.commits.writeJson.bind(run.commits)
      if (mode === 'resume' || mode === 'replan' || mode === 'no_visual' || mode === 'no_renderer') vi.spyOn(run.commits, 'writeJson').mockImplementation(async (path, value) => {
        if (!interrupted && path.endsWith('task-checkpoint.json')) {
          const saved = capabilityTaskCheckpointSchema.safeParse(value)
          if (saved.success && saved.data.steps[1]?.status === 'completed') {
            if (mode === 'no_visual' || mode === 'no_renderer') {
              interrupted = true
              if (mode === 'no_visual') reviewer.visual = false
              else vi.spyOn(docxPdf, 'renderDocxPdfWithInfo').mockRejectedValueOnce(
                Object.assign(new Error('spawn soffice ENOENT'), { code: 'ENOENT' }))
              return writeJson(path, value)
            }
            interrupted = true
            if (mode === 'replan') await writeJson(path, value)
            throw new Error('补丁发布后检查点响应中断')
          }
        }
        return writeJson(path, value)
      })
      return executeTestCapabilityTask(workspace, run, dispatcher, agent, session)
    }
    if (mode === 'no_visual' || mode === 'no_renderer') {
      await expect(execute()).rejects.toThrow(mode === 'no_visual' ? 'DOCX_VISUAL_REVIEW_IMAGE_INPUT_REQUIRED' : 'spawn soffice ENOENT')
      const saved = await inspectCandidateDocument(workspace, session, work.workId,
        { source: 'step_outputs', step_position: 1, output_positions: [0] })
      expect(saved.record.structure_checked).toBe(true)
      expect(saved.record.page_review).toBeUndefined()
      await expect(readTaskDeliverables(workspace, session, work.workId)).rejects.toThrow()
      reviewer.visual = true
      expect((await execute()).status).toBe('completed')
      return
    }
    if (mode === 'invalid_position_budget') {
      await expect(execute()).rejects.toThrow('BID_DOCUMENT_REVIEW_POSITION_INVALID')
      expect(reviewer.calls.filter(call => call.messages.some(message => message.content.some(block =>
        block.type === 'text' && block.text.includes('图片身份表：'))))).toHaveLength(3)
      await expect(readTaskDeliverables(workspace, session, work.workId)).rejects.toThrow()
      return
    }
    if (mode === 'resume' || mode === 'replan') await expect(execute()).rejects.toThrow('补丁发布后检查点响应中断')
    if (mode === 'replan') {
      const selection = { source: 'step_outputs' as const, step_position: 1, output_positions: [0] }
      const candidate = await inspectCandidateDocument(workspace, session, work.workId, selection)
      expect(candidate.blocks.find(({ block }) => block.text === '表格段落')?.block.writable).toBe(false)
      await expect(inspectCandidateDocument(workspace, ctx.sessions.create(), work.workId, selection)).rejects.toThrow('BID_DOCUMENT_SESSION_MISMATCH')
      await expect(inspectCandidateDocument(workspace, session, work.workId, { ...selection, step_position: 2 })).rejects.toThrow('BID_STEP_OUTPUT_NOT_COMPLETED')
      const current = await collectBidModelTaskCatalog(workspace, session, ref, candidate)
      const caption = current.objects.candidate_blocks.findIndex((block) => {
        const label = JSON.parse(block.label) as { text: string; kind: string }
        return label.text.includes('处理流程') && label.kind === 'paragraph'
      })
      expect(caption).toBeGreaterThanOrEqual(0)
      const nextMessage = createUserMessage({ content: [{ type: 'text', text: '在刚插入图的题注后增加“处理流程示意补充说明”，其他原文不变，然后检查页面并交付。' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 2 }); session.append('user/message', nextMessage, { surfaceOp: 'append' })
      const revised = bindBidModelTask({ ...input, steps: [...input.steps.slice(0, 2), {
        description: '补充新增图的说明', scope: { source: 'task' }, call: { capability: 'document.patch', input: { document: selection,
          operations: [{ type: 'insert_paragraph', candidate_block_position: caption, placement: 'after', text: '处理流程示意补充说明' }],
        } },
      }, { description: '检查最终页面', scope: { source: 'task' }, call: { capability: 'document.layout_review', input: {
        document: { ...selection, step_position: 2 }, mode: 'repair', reason: '检查新增图、题注与补充说明。',
      } } }] }, current)
      const paths = await readExistingBidWorkingTree(workspace, work)
      if (paths === null) throw new Error('没有原 Work 候选')
      const checkpoint = await patchCapabilityTaskSteps(createTestBidRunContext({ work }), workspace, new BidWorkspace(paths.root),
        capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work)), session,
        { session_id: String(session.id), message_id: String(nextMessage.id) }, 2, revised.steps.slice(2))
      expect(checkpoint.steps[2]?.output_sources).toEqual([{ step_position: 1, step_id: checkpoint.steps[1]?.step_id }])
    }
    const outcome = await execute()
    if (outcome.status !== 'completed') throw new Error('文档组合任务未完成')
    const final = outcome.results.at(-1)?.outputs?.[0]
    if (final?.kind !== 'document') throw new Error('没有最终文档')
    const actual = await readBidDocument(workspace, final)
    expect(actual.record.page_review?.status).toBe('passed')
    const pagePrompt = reviewer.calls.flatMap(call => call.messages.flatMap(message => message.content))
      .find(block => block.type === 'text' && block.text.includes('图片身份表：'))
    expect(pagePrompt?.type).toBe('text')
    if (pagePrompt?.type !== 'text') throw new Error('页面核验缺少图片来源绑定')
    const imageObjects = JSON.parse(pagePrompt.text.split('\n').find(line => line.startsWith('图片身份表：'))!.slice('图片身份表：'.length)) as
      Array<{ title: string; writable_position: number | null; origin: string }>
    expect(imageObjects.filter(item => item.origin === '原稿保留图片')).toHaveLength(2)
    expect(imageObjects.filter(item => item.origin === '本次新增或替换图片')).toEqual([
      expect.objectContaining({ title: '处理流程', writable_position: 1 }),
    ])
    if (mode === 'invalid_position' || mode === 'invalid_schema') {
      expect(reviewer.calls.some(call => call.messages.some(message => message.content.some(block =>
        block.type === 'text' && block.text.includes(mode === 'invalid_schema'
          ? 'BID_DOCUMENT_REVIEW_OUTPUT_INVALID' : 'BID_DOCUMENT_REVIEW_POSITION_INVALID'))))).toBe(true)
    }
    expect(actual.record.root_file).toEqual({ attachmentId: file.attachmentId, version: file.version })
    const report = JSON.parse(await readFile(join(workspace.projectRoot, actual.record.page_review!.report), 'utf8')) as {
      renderer: string
      pages: Array<{ path: string }>
      reviews: unknown[]
      document_sha256: string
    }
    expect(report.renderer).toContain('LibreOffice')
    expect(report.pages.length).toBeGreaterThan(1); expect(report.reviews).toHaveLength(report.pages.length)
    expect(report.document_sha256).toBe(final.version)
    if (mode === 'repair') expect(final.version).not.toBe(outcome.results[1]?.outputs?.[0]?.version)
    for (const page of report.pages) expect((await readFile(join(workspace.projectRoot, page.path))).subarray(1, 4).toString()).toBe('PNG')
    expect(outcome.receipt.files.some(item => item.path === actual.record.path)).toBe(true)
    const delivered = await readTaskDeliverables(workspace, session, work.workId)
    expect(delivered.files.filter(file => file.name.endsWith('.docx'))).toHaveLength(1)
    if (mode === 'pass') {
      const evidence = await collectBidTaskEvidence(workspace, task, outcome.receipt.files.map(file => file.path))
      const document = JSON.parse(evidence.find(file => file.path === actual.record.path)!.text) as {
        sha256: string
        document_text: Array<{ part: string; paragraphs: string[] }>
      }
      expect(document.sha256).toBe(final.version)
      expect(document.document_text.find(part => part.part === 'word/document.xml')?.paragraphs)
        .toContain('图 2 处理流程')
      expect(document.document_text.find(part => part.part === 'word/header1.xml')?.paragraphs).toContain('原页眉')
    }
    const document = delivered.files.find(file => file.name.endsWith('.docx'))!
    const download = { session: String(session.id), work: work.workId, receipt: delivered.receipt, position: document.position, mode: 'download' as const }
    expect((await readTaskDownload(workspace, session, download)).bytes).toEqual(actual.bytes)
    expect((await readTaskDownload(workspace, session, { ...download, mode: 'preview' })).bytes.subarray(0, 4).toString()).toBe('%PDF')
    expect((await readTaskDeliverables(workspace, session, work.workId)).receipt).toBe(delivered.receipt)
    await expect(readTaskDownload(workspace, session, { ...download, receipt: '0'.repeat(64) })).rejects.toThrow('BID_DELIVERY_RECEIPT_CHANGED')
    await expect(readTaskDownload(workspace, session, { ...download, position: delivered.files.length })).rejects.toThrow('BID_DELIVERY_POSITION_INVALID')
    await expect(readTaskDeliverables(workspace, ctx.sessions.create(), work.workId)).rejects.toThrow('BID_DELIVERY_SESSION_MISMATCH')
    expect(bidTaskDownloadSchema.safeParse({ ...download, path: '../../secret' }).success).toBe(false)
    const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(join(workspace.projectRoot, 'runs', work.workId, 'task-checkpoint.json'), 'utf8')))
    expect(checkpoint.steps[1]?.output_sources[0]?.step_id).toBe(checkpoint.steps[0]?.step_id)
    const requests = reviewer.calls.length
    expect((await execute()).status).toBe('completed'); expect(reviewer.calls).toHaveLength(requests)
    for (const path of ['manifest.json', 'outline/outline.json', 'chapters/writing-plan.json']) await expect(readFile(join(workspace.projectRoot, path))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(workspace.projectRoot, actual.record.path), '被外部改动')
    await expect(readTaskDownload(workspace, session, download)).rejects.toThrow('BID_CAPABILITY_RESULT_FILE_MISMATCH')
  } finally { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 120_000)

it('只检查原稿排版发布真实页面和问题报告，不生成修改版', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-inspect-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(AttachmentLocal, { dshHome: root })
    const reviewer = new PageReviewer()
    ctx.effect(() => ctx.llm.registerAdapter(['document-test'], reviewer))
    const session = ctx.sessions.create()
    session.append('request/header', { header: { config: { provider: 'document-test', model: 'visual' } }, reason: 'initial' })
    const fixture = await nativeDocumentFixture()
    const file = await receiveBidFile(workspace, session, { name: '待检查.docx', bytes: fixture.bytes })
    const message = createUserMessage({ content: [{ type: 'text', text: '只检查这份 Word 排版，列出问题，不修改。' }], source: { kind: 'user', fileRefs: [file] } })
    session.append('turn/start', { turn: 1 }); session.append('user/message', message, { surfaceOp: 'append' })
    const catalog = await collectBidModelTaskCatalog(workspace, session)
    const task = bindBidModelTask({ goal: '只检查原 Word 排版', scope: { kind: 'files', file_positions: [0] }, steps: [{
      description: '检查所有实际页面', scope: { source: 'task' }, call: { capability: 'document.layout_review', input: {
        document: { source: 'file', file_position: 0 }, mode: 'inspect', reason: '只报告可定位问题，不修改原稿。',
      } },
    }] }, catalog)
    const work = await persistCapabilityTaskRequest(workspace, session, task,
      { session_id: String(session.id), message_id: String(message.id) }, [])
    const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
      evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
    const outcome = await executeTestCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher,
      { ctx, session } as unknown as Agent, session)
    if (outcome.status !== 'completed') throw new Error('排版检查未完成')
    expect(outcome.results[0]?.outputs).toEqual([])
    expect(outcome.receipt.files.some(file => file.path.endsWith('.docx') || file.path.endsWith('/record.json'))).toBe(false)
    expect(outcome.receipt.files.some(file => file.path.endsWith('/page-review.json'))).toBe(true)
    const delivered = await readTaskDeliverables(workspace, session, work.workId)
    expect(delivered.files.map(file => file.name)).toEqual(['Word 排版检查.json'])
    const preview = await readTaskDownload(workspace, session, { session: String(session.id), work: work.workId, receipt: delivered.receipt, position: 0, mode: 'preview' })
    expect(preview.bytes.subarray(0, 4).toString()).toBe('%PDF')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 120_000)
