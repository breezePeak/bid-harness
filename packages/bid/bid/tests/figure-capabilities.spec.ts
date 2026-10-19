/** 真实能力候选、图渲染、附件和发布路径；模型判断由注册的适配器提供。 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { BidWorkspace } from '../src/index.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { executeTestCapabilityTask } from './fixtures/task-verifier.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { readBidFigure, bidFigurePaths } from '../src/figure-assets.ts'
import { collectBidTaskEvidence } from '../src/bid-task-verification.ts'
import { bidImageConnectionSpecSchema, type BidImageProvider } from '../src/bid-image-provider.ts'
import { chapterImageFixturePng } from './fixtures/chapter-image-png.ts'
import { collectBidModelTaskCatalog, bindBidModelTask } from '../src/bid-model-task.ts'
import { readPublishedBidFigure } from '../src/published-figures.ts'

class FigureReviewer extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly pass: boolean, private readonly visual: boolean) { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model,
      inputModalities: this.visual ? ['text', 'image'] as const : ['text'] as const })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({
      status: this.pass ? 'pass' : 'reject', reason: this.pass ? '流程、分支和文字均可辨识。' : '分支含义不明确。',
    }) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each([{ pass: true, visual: true }, { pass: false, visual: true }, { pass: true, visual: false }])(
  '无招标目录的流程图 Work 只发布通过真实图片检查的源和图 $pass/$visual', async ({ pass, visual }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-figure-work-'))
    const workspace = new BidWorkspace(root)
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(AttachmentLocal, { dshHome: root })
      const adapter = new FigureReviewer(pass, visual)
      ctx.effect(() => ctx.llm.registerAdapter(['figure-test'], adapter))
      const session = ctx.sessions.create()
      session.append('request/header', { header: { config: { provider: 'figure-test', model: 'visual' } }, reason: 'initial' })
      const message = createUserMessage({ content: [{ type: 'text', text: '画收货、检查、合格入库和不合格退货流程图。' }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const task = bidCapabilityTaskSchema.parse({ goal: '生成收货检查流程图', scope: { kind: 'project' }, steps: [{
        description: '绘制收货检查流程', scope: { source: 'task' }, call: { capability: 'flowchart.create', input: {
          title: '收货检查', purpose: '明确合格与退货分支', nodes: [
            { type: 'start', text: '收货' }, { type: 'decision', text: '检查合格？' },
            { type: 'process', text: '入库' }, { type: 'process', text: '退货' }, { type: 'end', text: '完成' },
          ], edges: [{ from_position: 0, to_position: 1 }, { from_position: 1, to_position: 2, label: '合格' },
            { from_position: 1, to_position: 3, label: '不合格' },
            { from_position: 2, to_position: 4 }, { from_position: 3, to_position: 4 }],
        } },
      }] })
      const work = await persistCapabilityTaskRequest(workspace, session, task,
        { session_id: String(session.id), message_id: String(message.id) }, [])
      const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
        evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
      const agent = { ctx, session } as unknown as Agent
      const execute = () => executeTestCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
      if (!pass || !visual) {
        await expect(execute()).rejects.toThrow(visual ? 'BID_FIGURE_CONTENT_REVIEW_REQUIRED' : 'DOCX_VISUAL_REVIEW_IMAGE_INPUT_REQUIRED')
        await expect(readFile(join(workspace.projectRoot, 'assets/figures'))).rejects.toMatchObject({ code: 'ENOENT' })
        return
      }
      const outcome = await execute()
      expect(outcome.status).toBe('completed')
      if (outcome.status !== 'completed') throw new Error('未完成图任务')
      const ref = outcome.results[0]?.outputs?.[0]
      expect(ref?.kind).toBe('figure')
      if (ref?.kind !== 'figure') throw new Error('缺少图引用')
      const { record, png } = await readBidFigure(workspace, ref)
      expect(record.work_id).toBe(work.workId)
      expect(outcome.results[0]?.target_section_ids).toEqual([])
      expect(outcome.receipt.files.map(file => file.path).sort()).toEqual([
        ...Object.entries(bidFigurePaths(record.step_id)).filter(([key]) => key !== 'id').map(([, path]) => path),
      ].sort())
      const image = adapter.calls[0]!.messages.flatMap(message => message.content).find(block => block.type === 'image')
      if (image?.type !== 'image') throw new Error('视觉请求缺少真实图像')
      const read = await ctx.attachments.readImage(image.attachment, new AbortController().signal)
      expect(createHash('sha256').update(read.data).digest('hex')).toBe(ref.version)
      const evidence = await collectBidTaskEvidence(workspace, task, outcome.receipt.files.map(file => file.path))
      expect(evidence.find(file => file.path.endsWith('.png'))?.text).toContain('"kind":"binary"')
      expect(evidence.find(file => file.path.endsWith('.png'))?.text).not.toContain(png.toString('utf8'))
      expect((await execute()).status).toBe('completed')
      expect(adapter.calls).toHaveLength(1)
      await expect(readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(workspace.projectRoot, bidFigurePaths(record.step_id).png), Buffer.from('changed'))
      await expect(readBidFigure(workspace, ref)).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000,
)

it.each(['success', 'gif', 'unknown', 'no_visual'] as const)('项目图使用消息中的实际内容参考并按请求事实恢复：%s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-image-'))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AttachmentLocal, { dshHome: root })
    const adapter = new FigureReviewer(true, mode !== 'no_visual')
    ctx.effect(() => ctx.llm.registerAdapter(['figure-test'], adapter))
    const session = ctx.sessions.create()
    session.append('request/header', { header: { config: { provider: 'figure-test', model: 'visual' } }, reason: 'initial' })
    const png = await chapterImageFixturePng()
    const reference = mode === 'gif' ? await sharp(png).gif().toBuffer() : png
    const attachment = await ctx.attachments.saveImage({ data: reference,
      mediaType: mode === 'gif' ? 'image/gif' : 'image/png', name: mode === 'gif' ? '现场参考.gif' : '现场参考.png' })
    const message = createUserMessage({ content: [{ type: 'text', text: '依据这张现场参考图绘制设备部署示意图，保留设备与通道位置。' },
      { type: 'image', attachment }], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', message, { surfaceOp: 'append' })
    const task = bidCapabilityTaskSchema.parse({ goal: '绘制设备部署示意图', scope: { kind: 'project' }, steps: [{
      description: '依据现场图绘制部署示意', scope: { source: 'task' }, call: { capability: 'project_image.create', input: {
        title: '部署示意', purpose: '解释部署方案', prompt: '保留设备与通道位置，呈现设备部署后的关系',
        style: '清楚的工程方案示意，少量文字', size: '1536x1024',
        image_ref: { message_id: String(message.id), block_position: 1, attachment },
      } },
    }] })
    const connection = bidImageConnectionSpecSchema.parse({ baseURL: 'https://image.example/v1', model: 'configured-image',
      apiKeyEnv: 'TEST_IMAGE_KEY', timeoutMs: 1000, maxImageBytes: 1024 * 1024 })
    const generate = vi.fn<BidImageProvider['generate']>(async (request) => {
      if (mode === 'gif' && generate.mock.calls.length === 1) {
        expect((await sharp(request.reference).metadata()).format).toBe('png')
        expect(await sharp(request.reference).ensureAlpha().raw().toBuffer())
          .toEqual(await sharp(reference, { page: 0, pages: 1 }).ensureAlpha().raw().toBuffer())
      } else expect(request.reference).toEqual(png)
      await request.beforeRequest?.(connection)
      if (mode === 'unknown') throw new Error('远端连接中断，结果未知')
      return { png, width: 24, height: 16, model: connection.model }
    })
    const provider: BidImageProvider = { resolve: () => connection, generate,
      view: async () => ({ ...connection, effectiveBaseURL: connection.baseURL, enabled: true, credentialConfigured: true }),
      discoverModels: async () => [connection.model] }
    const work = await persistCapabilityTaskRequest(workspace, session, task,
      { session_id: String(session.id), message_id: String(message.id) }, [])
    const agent = { ctx, session } as unknown as Agent
    const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
      chapterWritingMaxConcurrency: 1, webSearchEnabled: false }, undefined, provider)
    const execute = () => executeTestCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
    if (mode === 'no_visual') {
      await expect(execute()).rejects.toThrow('DOCX_VISUAL_REVIEW_IMAGE_INPUT_REQUIRED')
      expect(generate).not.toHaveBeenCalled()
      return
    }
    if (mode === 'unknown') {
      await expect(execute()).rejects.toThrow('远端连接中断')
      await expect(execute()).rejects.toThrow('不会自动再次生成计费')
      expect(generate).toHaveBeenCalledOnce()
      return
    }
    const outcome = await execute()
    if (outcome.status !== 'completed') throw new Error('项目图未完成')
    const ref = outcome.results[0]?.outputs?.[0]
    if (ref?.kind !== 'figure') throw new Error('缺少项目图')
    const { record } = await readBidFigure(workspace, ref)
    expect(record.kind).toBe('project_image')
    const requestEvent = session.events.find(event => event.type === 'bid.image.requested')
    const sentReference = generate.mock.calls[0]?.[0].reference
    if (sentReference === undefined) throw new Error('项目图请求没有真实参考图')
    expect(requestEvent?.data).toMatchObject({ owner: { kind: 'task', work_id: work.workId },
      reference: { kind: 'content', attachment, content_sha256: createHash('sha256').update(sentReference).digest('hex'),
        ...attachment.mediaType === 'image/gif' ? { conversion: 'gif-first-frame-png' } : {} } })
    expect(adapter.calls[0]?.messages.flatMap(message => message.content).filter(block => block.type === 'image')).toHaveLength(2)
    expect((await execute()).status).toBe('completed')
    expect(generate).toHaveBeenCalledOnce()
    expect(adapter.calls).toHaveLength(1)
    if (ref.kind !== 'figure') throw new Error('输出不是图资产')
    await expect(readPublishedBidFigure(workspace, ctx.sessions.create(), ref)).rejects.toThrow('BID_FIGURE_SESSION_MISMATCH')
    expect((await collectBidModelTaskCatalog(workspace, ctx.sessions.create())).objects.figures).toEqual([])
    const followup = createUserMessage({ content: [{ type: 'text', text: '使用刚交付的部署图作参考，增加维护通道标识。' }], source: { kind: 'user' } })
    session.append('turn/start', { turn: 2 }); session.append('user/message', followup, { surfaceOp: 'append' })
    const selected = bindBidModelTask({ goal: '给部署图增加维护通道标识', scope: { kind: 'figures', figure_positions: [0] }, steps: [{
      description: '调整部署示意图', scope: { source: 'task' }, call: { capability: 'project_image.create', input: {
        title: '部署示意补充', purpose: '说明维护通道', prompt: '保留原设备位置并添加维护通道标识',
        style: '清楚的工程方案示意', size: '1536x1024', figure_position: 0,
      } },
    }] }, await collectBidModelTaskCatalog(workspace, session))
    const next = await persistCapabilityTaskRequest(workspace, session, selected,
      { session_id: String(session.id), message_id: String(followup.id) }, [])
    expect((await executeTestCapabilityTask(workspace, createTestBidRunContext({ work: next }), dispatcher, agent, session)).status).toBe('completed')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(session.events.findLast(event => event.type === 'bid.image.requested')?.data).toMatchObject({ reference: { figure_ref: ref } })
    await expect(readFile(join(workspace.projectRoot, 'outline/outline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 20_000)
