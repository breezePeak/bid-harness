import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { chapterImageFixturePng } from './fixtures/chapter-image-png.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { attachBidImageStyle, attachChapterImageTools, createBidProjectImageSession,
  readBidImageStyle, readBidImageBytes, readChapterImages, validateChapterImages, chapterImagePaths, type BidChapterImage } from '../src/chapter-images.ts'
import { createChapterProtocol } from '../src/chapter-writing-protocol.ts'
import { bindChapterWriterInput, chapterWriterOutputSchema, createChapterWriterReferences, projectChapterWriterCandidate } from '../src/chapter-writing-writer.ts'
import { bidImageConnectionSpecSchema, type BidImageProvider } from '../src/bid-image-provider.ts'
import { emptyChapterContext, outlineFixture } from './fixtures/chapter-writing-inputs.ts'
import { allowedWritingCapabilitySourceWrites } from '../src/bid-writing-capability.ts'
import { DOCX_MAX_BODY_IMAGE_BYTES } from '../src/docx-image.ts'
import { preserveParagraphRevisionMetadata } from '../src/chapter-writing-executor.ts'
import { indexChapterContentBlocks } from '../src/chapter-content-reuse.ts'

const roots: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of roots.splice(0)) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

const request = { title: '设备布置示意', purpose: '说明方案布置，非现场证据', prompt: '设备与服务区域的鸟瞰效果', size: '1536x1024' }
const connection = bidImageConnectionSpecSchema.parse({ baseURL: 'https://cpa.example/v1', model: 'test-image-model', apiKeyEnv: 'TEST_PP_KEY', timeoutMs: 1000, maxImageBytes: 1024 * 1024 })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-images-'))
  const ctx = new Context()
  roots.push({ ctx, root })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalAttachments, { dshHome: join(root, '.dsh') })
  const workspace = new BidWorkspace(root)
  await workspace.import([{ name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('方案参考资料') }])
  const agent = ctx.agentLoop.create(SessionId('image-writer'), { provider: 'mock', model: 'mock' })
  const run = createTestBidRunContext()
  const commits = run.commits.forPublication({ workspaceRoot: root, projectRoot: workspace.projectRoot })
  const styleRuntime = attachBidImageStyle(agent, workspace, connection, commits, 0)
  let serial = 0
  const call = (name: string, args: unknown, signal = new AbortController().signal) => {
    agent.session.append('step/start', { turn: 1, step: serial + 1 })
    return ctx.tools.execute({ agent, name, arguments: args, callId: CallId(`image-${serial++}`), signal })
  }
  const styleResult = await call('set_image_style', { prompt: '蓝灰配色的写实工业插图，浅色背景，透视与光照统一。' })
  expect(styleResult.isError).toBeFalsy()
  const style = styleRuntime.captured()!
  styleRuntime.dispose()
  const png = await chapterImageFixturePng()
  const currentConnection = { ...connection }
  const resolve: BidImageProvider['resolve'] = (model = currentConnection.model) => model === '' ? undefined : { ...currentConnection, model }
  const beforeRequest = async (request: Parameters<BidImageProvider['generate']>[0]) => {
    const spec = resolve(request.model)
    if (spec === undefined) throw new Error('未启用测试生图模型')
    await request.beforeRequest?.(spec)
  }
  const generate = vi.fn<BidImageProvider['generate']>(async (request) => {
    await beforeRequest(request)
    return { png, width: 24, height: 16, model: request.model ?? currentConnection.model }
  })
  const provider: BidImageProvider = {
    resolve,
    view: async () => ({ ...connection, effectiveBaseURL: connection.baseURL, enabled: true, credentialConfigured: true }),
    discoverModels: async () => [connection.model], generate,
  }
  const project = createBidProjectImageSession(workspace, provider, style, commits)
  const images: BidChapterImage[] = []
  const runtime = createChapterProtocol<unknown>(agent, 'submit_chapter', 0)
  const assertImageInput = vi.fn(async () => {})
  attachChapterImageTools(agent, runtime, workspace, 'SEC-1', images, project, assertImageInput)
  return { ctx, agent, workspace, commits, call, project, images, runtime, provider, generate, png, assertImageInput,
    beforeRequest, currentConnection }
}

describe('S5 真正插图工具与资产', () => {
  it('真实提交工具只改正文图题，恢复和迁入复用原图片身份及参考图', async () => {
    const { workspace, call, images, generate, runtime } = await fixture()
    assertSupportedJsonSchema(chapterWriterOutputSchema)
    await call('generate_bid_image', request)
    await call('review_bid_image', { image_position: 0, decision: 'accept', reason: '画面与方案一致。' })
    const context = emptyChapterContext(outlineFixture().sections.find(section => section.id === 'SEC-1')!)
    const refs = createChapterWriterReferences(context, [], images)
    const manifest = await workspace.readManifest()
    const originalImages = await readChapterImages(workspace, context.section.id)
    const originalStyle = await readBidImageStyle(workspace)
    let candidate: Awaited<ReturnType<typeof bindChapterWriterInput>> | undefined
    runtime.register({
      name: 'submit_chapter', description: '提交当前章节正文。', parameters: { ...chapterWriterOutputSchema },
      async execute(args, exec) {
        candidate = await bindChapterWriterInput(workspace, manifest, context, refs, args, [])
        return runtime.finish(exec, candidate)
      },
    })
    const input = (image: unknown) => ({
      markdown: `# ${context.section.title}\n\n{{image:0}}`, metadata: { images: [image] },
    })
    for (const caption of ['', ' ', '\n方案', '方案\n', '方案\r图', '方案\u2028图', '方案\u2029图', '图'.repeat(201)]) {
      expect((await call('submit_chapter', input({ image_position: 0, caption }))).isError).toBe(true)
    }
    for (const derived of [{ id: images[0]!.id }, { path: images[0]!.path }, { title: '替换资产标题' }]) {
      expect((await call('submit_chapter', input({ image_position: 0, caption: '方案示意图', ...derived }))).isError).toBe(true)
    }
    expect(runtime.captured()).toBeUndefined()
    expect((await call('submit_chapter', input({ image_position: 0, caption: '方案示意图' }))).isError).toBeFalsy()
    expect(runtime.captured()).toEqual(candidate)
    expect(candidate!.markdown).toContain(`![方案示意图](${images[0]!.path})\n\n图 方案示意图`)
    expect(candidate!.metadata.images).toEqual(images)
    const restored = createChapterWriterReferences(context, [], await readChapterImages(workspace, context.section.id))
    const projected = projectChapterWriterCandidate(candidate!, restored)
    expect(projected).toMatchObject({ metadata: { images: [{ image_position: 0, caption: '方案示意图' }] } })
    const rebound = await bindChapterWriterInput(workspace, manifest, context, restored, projected, [])
    expect(rebound).toEqual(candidate)
    const referenced = candidate!.markdown.replace(`![方案示意图](${images[0]!.path})`, '![方案示意图][scene]')
      + `\n\n[scene]: ${images[0]!.path}`
    const referenceProjection = projectChapterWriterCandidate({ ...candidate!, markdown: referenced }, restored)
    const referenceRebound = await bindChapterWriterInput(workspace, manifest, context, restored, referenceProjection, [])
    expect(referenceRebound.markdown).toContain('图 方案示意图')
    expect(referenceRebound.metadata.images).toEqual(images)
    const withParagraph = { ...candidate!, markdown: candidate!.markdown.replace('图 方案示意图', '图 方案示意图 的方案说明') }
    expect(projectChapterWriterCandidate(withParagraph, restored).markdown).toContain('图 方案示意图 的方案说明')
    expect(projectChapterWriterCandidate({ ...candidate!, markdown: candidate!.markdown + '\n方案延续说明。' }, restored).markdown)
      .toContain('图 方案示意图\n方案延续说明。')
    expect(() => projectChapterWriterCandidate({ ...candidate!,
      markdown: candidate!.markdown + `\n\n![另一图题](${images[0]!.path})`,
    }, restored)).toThrow('同一图片的多处展示须使用相同图题')
    const migratedContext = { ...context, section: { ...context.section, id: 'SEC-2', title: '迁入章节' } }
    const migratedRefs = createChapterWriterReferences(migratedContext, [], [])
    const blocks = indexChapterContentBlocks(context.section.id, candidate!.markdown)
      .filter(block => block.type !== 'heading' && block.markdown.trim() !== '')
    const migrated = await bindChapterWriterInput(workspace, manifest, migratedContext, migratedRefs, {
      markdown: '# 迁入章节\n\n' + blocks.map((_block, position) => `{{reuse:${position}}}`).join('\n\n'), metadata: {},
    }, [], [], candidate!.markdown)
    const migratedProjection = projectChapterWriterCandidate(migrated, migratedRefs, [], candidate!.markdown)
    expect(await bindChapterWriterInput(workspace, manifest, migratedContext, migratedRefs,
      migratedProjection, [], [], candidate!.markdown)).toEqual(migrated)
    expect(migrated.metadata.images).toEqual(images)
    expect(migrated.markdown).toContain(`![方案示意图](${images[0]!.path})\n\n图 方案示意图`)
    expect(await readChapterImages(workspace, context.section.id)).toEqual(originalImages)
    expect(await readBidImageStyle(workspace)).toEqual(originalStyle)
    expect(generate).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('正文图题的 Markdown 标点原样展示，修复投影不引入其他图片或字符变化', async () => {
    const { workspace, call, images, generate, runtime } = await fixture()
    await call('generate_bid_image', request)
    await call('review_bid_image', { image_position: 0, decision: 'accept', reason: '图片通过确认。' })
    const context = emptyChapterContext(outlineFixture().sections.find(section => section.id === 'SEC-1')!)
    const refs = createChapterWriterReferences(context, [], images)
    const manifest = await workspace.readManifest()
    const caption = '方案 [维护]\\巡检 ![额外](evil.png) <script> &copy;'
    const candidate = await bindChapterWriterInput(workspace, manifest, context, refs, {
      markdown: `# ${context.section.title}\n\n{{image:0}}`, metadata: { images: [{ image_position: 0, caption }] },
    }, [])
    expect(chapterImagePaths(candidate.markdown)).toEqual([images[0]!.path])
    const projected = projectChapterWriterCandidate(candidate, refs)
    expect(projected).toMatchObject({ metadata: { images: [{ image_position: 0, caption }] } })
    expect(await bindChapterWriterInput(workspace, manifest, context, refs, projected, [])).toEqual(candidate)
    expect(candidate.metadata.images).toEqual(images)
    expect(generate).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('真实工具先发图，再确认并按位置绑定；修复投影和恢复保持同一图片', async () => {
    const { ctx, agent, workspace, call, images, generate, assertImageInput, runtime } = await fixture()
    const result = await call('generate_bid_image', request)
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ image_position: 0, visual_status: 'pending', image: { mediaType: 'image/png' } })
    expect(assertImageInput).toHaveBeenCalledOnce()
    expect((await ctx.tools.execute({ agent, name: 'review_bid_image',
      arguments: { image_position: 0, decision: 'accept', reason: '尚未进入下一次看图请求' }, callId: CallId('same-step-review'),
      signal: new AbortController().signal })).isError).toBe(true)
    const context = emptyChapterContext(outlineFixture().sections[0]!)
    const refs = createChapterWriterReferences(context, [], images)
    const modelInput = { markdown: `# ${context.section.title}\n\n方案布置如下。\n\n{{image:0}}`, metadata: { images: [{ image_position: 0 }] } }
    const manifest = await workspace.readManifest()
    await expect(bindChapterWriterInput(workspace, manifest, context, refs, modelInput, [])).rejects.toThrow('视觉确认')
    expect((await call('review_bid_image', { image_position: 0, decision: 'accept', reason: '真实图中的设备与布局符合方案，配色与项目风格一致。' })).isError).toBeFalsy()
    const candidate = await bindChapterWriterInput(workspace, manifest, context, refs, modelInput, [])
    expect(candidate.markdown).toContain(`](${images[0]!.path})`)
    expect(candidate.markdown).toContain('图 设备布置示意')
    const restored = createChapterWriterReferences(context, [], await readChapterImages(workspace, 'SEC-1'))
    const projected = projectChapterWriterCandidate(candidate, restored)
    const rebound = await bindChapterWriterInput(workspace, manifest, context, restored, projected, [])
    expect(rebound.metadata.images).toEqual(candidate.metadata.images)
    const { images: _images, additional_web_materials: _web, ...originalMetadata } = candidate.metadata
    expect(preserveParagraphRevisionMetadata(candidate, originalMetadata).metadata.images).toEqual(candidate.metadata.images)
    const referenced = `![设备][scene]\n\n[scene]: ${images[0]!.path}`
    const referenceProjection = projectChapterWriterCandidate({ ...candidate, markdown: `# ${context.section.title}\n\n${referenced}` }, restored)
    const referenceRebound = await bindChapterWriterInput(workspace, manifest, context, restored, referenceProjection, [])
    expect(referenceRebound.metadata.images).toEqual(candidate.metadata.images)
    const migratedContext = { ...context, section: { ...context.section, id: 'SEC-2', title: '迁入章节' } }
    const migratedRefs = createChapterWriterReferences(migratedContext, [], [])
    const blocks = indexChapterContentBlocks(context.section.id, candidate.markdown)
      .filter(block => block.type !== 'heading' && block.markdown.trim() !== '')
    const migrated = await bindChapterWriterInput(workspace, manifest, migratedContext, migratedRefs, {
      markdown: '# 迁入章节\n\n' + blocks.map((_block, position) => `{{reuse:${position}}}`).join('\n\n'), metadata: {},
    }, [], [], candidate.markdown)
    expect(migrated.metadata.images).toEqual(candidate.metadata.images)
    const migratedProjection = projectChapterWriterCandidate(migrated, migratedRefs, [], candidate.markdown)
    expect(JSON.stringify(migratedProjection)).not.toContain(images[0]!.path)
    const migratedRebound = await bindChapterWriterInput(workspace, manifest, migratedContext, migratedRefs,
      migratedProjection, [], [], candidate.markdown)
    expect(migratedRebound.metadata.images).toEqual(candidate.metadata.images)
    expect(migratedRebound.markdown).toBe(migrated.markdown)
    expect(await readBidImageBytes(workspace, images[0]!.id)).toEqual(await readFile(join(workspace.projectRoot, images[0]!.path)))
    expect(await validateChapterImages(workspace, candidate.metadata.images!, candidate.markdown)).toEqual([])
    expect(chapterImagePaths(referenced)).toEqual([images[0]!.path])
    expect(chapterImagePaths(referenced.replace('chapters/images/', 'chapters/%69mages/'))).toEqual([images[0]!.path])
    expect(chapterImagePaths(referenced.replace(images[0]!.path, images[0]!.path.toUpperCase()))).toEqual([images[0]!.path])
    expect(await validateChapterImages(workspace, candidate.metadata.images!, referenced)).toEqual([])
    expect(await validateChapterImages(workspace, candidate.metadata.images!,
      referenced.replace('chapters/images/', 'chapters/%69mages/'))).toEqual([])
    expect(await validateChapterImages(workspace, [], referenced)).not.toEqual([])
    expect(chapterImagePaths('```md\n' + referenced + '\n```')).toEqual([])
    await expect(bindChapterWriterInput(workspace, manifest, context, refs,
      { markdown: `# ${context.section.title}\n\n${referenced}`, metadata: modelInput.metadata }, [])).rejects.toThrow('图片文件路径')
    await expect(bindChapterWriterInput(workspace, manifest, context, refs,
      { markdown: `# ${context.section.title}\n\n${referenced.replace('chapters/images/', 'chapters/%69mages/')}`,
        metadata: modelInput.metadata }, [])).rejects.toThrow('图片文件路径')
    await expect(bindChapterWriterInput(workspace, manifest, context, refs,
      { markdown: `# ${context.section.title}\n\n${referenced.replace(images[0]!.path, images[0]!.path.toUpperCase())}`,
        metadata: modelInput.metadata }, [])).rejects.toThrow('图片文件路径')
    expect(await readBidImageStyle(workspace)).toMatchObject({ reference_image: { id: images[0]!.id } })
    const paths = await allowedWritingCapabilitySourceWrites(workspace)
    expect(paths.has(images[0]!.path)).toBe(true)
    expect(paths.has('chapters/image-style.json')).toBe(true)
    await call('generate_bid_image', request)
    expect(generate).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('工具拒绝非法位置、模型身份、未确认图片和不支持看图的路由', async () => {
    const { call, generate, assertImageInput, runtime } = await fixture()
    expect((await call('generate_bid_image', { ...request, id: '自造身份' })).isError).toBe(true)
    for (const supplied of [{ baseURL: 'https://untrusted.example/v1' }, { apiKeyEnv: 'OTHER_KEY' }, { connection }]) {
      expect((await call('generate_bid_image', { ...request, ...supplied })).isError).toBe(true)
    }
    for (const image_position of [-1, 0.5, 99]) {
      expect((await call('review_bid_image', { image_position, decision: 'accept', reason: '确认' })).isError).toBe(true)
    }
    assertImageInput.mockRejectedValueOnce(new Error('当前模型不能看图'))
    expect((await call('generate_bid_image', request)).isError).toBe(true)
    expect(generate).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('项目风格只保存模型和语义，旧格式及磁盘连接字段不能经真实工具恢复', async () => {
    const { agent, workspace, commits, call, project, generate } = await fixture()
    const path = join(workspace.projectRoot, 'chapters/image-style.json')
    const style = await readBidImageStyle(workspace)
    expect(style).toMatchObject({ schema_version: 2, model: connection.model })
    expect(style).not.toHaveProperty('connection')
    const runtime = attachBidImageStyle(agent, workspace, connection, commits, 0)
    try {
      for (const extra of [{ schema_version: 1 }, { connection },
        { baseURL: 'https://untrusted.example/v1' }, { apiKeyEnv: 'OTHER_SECRET' }]) {
        await writeFile(path, JSON.stringify({ ...style, ...extra }))
        await expect(readBidImageStyle(workspace)).rejects.toThrow()
        expect((await call('set_image_style', { prompt: project.style.prompt })).isError).toBe(true)
      }
      expect(generate).not.toHaveBeenCalled()
      await writeFile(path, JSON.stringify(style))
      expect((await call('set_image_style', { prompt: project.style.prompt })).isError).toBeFalsy()
    } finally { runtime.dispose() }
  })

  it('恢复冻结模型时只解析当前正式地址，连接变化不改变图片请求缓存身份', async () => {
    const { agent, workspace, call, project, generate, images, currentConnection } = await fixture()
    await call('generate_bid_image', request)
    await call('review_bid_image', { image_position: 0, decision: 'accept', reason: '已查看首图，符合方案。' })
    const savedId = images[0]!.id
    currentConnection.model = ''
    currentConnection.baseURL = 'https://current-config.example/v1'
    await call('generate_bid_image', request)
    expect(images[0]!.id).toBe(savedId)
    expect(generate).toHaveBeenCalledOnce()
    expect((await call('generate_bid_image', { ...request, prompt: '当前正式接口生成第二场景' })).isError).toBeFalsy()
    expect(generate.mock.calls.at(-1)![0]).toMatchObject({ model: project.style.model })
    expect(generate.mock.calls.at(-1)![0]).not.toHaveProperty('connection')
    expect(agent.session.events.findLast(event => event.type === 'bid.image.requested')).toMatchObject({
      data: { model: connection.model, base_url: currentConnection.baseURL },
    })
    expect(await readBidImageStyle(workspace)).toMatchObject({ model: connection.model })
    expect(await readBidImageStyle(workspace)).not.toHaveProperty('connection')
  })

  it('并发章节在首图接受后使用同一参考图；失败Writer释放等待且取消等待不发请求', async () => {
    const { project, images, generate, png, agent } = await fixture()
    const signal = new AbortController().signal
    await project.generate('SEC-1', images, request, signal, agent)
    const other: BidChapterImage[] = []
    const next = project.generate('SEC-2', other, { ...request, prompt: '另一个设备区域的效果' }, signal, agent)
    await Promise.resolve()
    expect(generate).toHaveBeenCalledOnce()
    await project.review('SEC-1', images, { image_position: 0, decision: 'accept', reason: '内容与风格通过' }, signal)
    await next
    expect(generate.mock.calls[1]![0].reference).toEqual(png)

    const isolated = await fixture()
    const retryProject = createBidProjectImageSession(isolated.workspace, isolated.provider, isolated.project.style, isolated.commits)
    // 首图所属Writer离开时必须主动结算，后续章节不能等一个已结束的会话。
    const firstImages: BidChapterImage[] = []
    await retryProject.generate('first', firstImages, request, signal, isolated.agent)
    const controller = new AbortController()
    const cancelled = retryProject.generate('cancelled', [], request, controller.signal, isolated.agent)
    controller.abort(new Error('已取消'))
    await expect(cancelled).rejects.toThrow('已取消')
    const remaining: BidChapterImage[] = []
    const resumed = retryProject.generate('remaining', remaining, request, signal, isolated.agent)
    retryProject.release('first')
    await expect(resumed).resolves.toMatchObject({ section_id: 'remaining' })
    retryProject.release('remaining')
  })

  it('恢复多章待确认图片并发接受时，项目参考图只由首次结算确定', async () => {
    const { workspace, project, images, agent } = await fixture()
    const signal = new AbortController().signal
    await project.generate('SEC-1', images, request, signal, agent)
    project.release('SEC-1')
    const other: BidChapterImage[] = []
    await project.generate('SEC-2', other, { ...request, prompt: '另一章待确认的场景' }, signal, agent)
    project.release('SEC-2')
    await Promise.all([
      project.review('SEC-1', images, { image_position: 0, decision: 'accept', reason: '首图视觉通过' }, signal),
      project.review('SEC-2', other, { image_position: 0, decision: 'accept', reason: '另一图视觉通过' }, signal),
    ])
    expect((await readBidImageStyle(workspace))?.reference_image?.id).toBe(images[0]!.id)
    expect(project.style.reference_image?.id).toBe(images[0]!.id)
    expect(other[0]!.visual_status).toBe('accepted')
  })

  it('拒绝图片可重绘，已接受资产不可撤销，文件篡改使正式验收失败', async () => {
    const { project, images, workspace, call, agent } = await fixture()
    const signal = new AbortController().signal
    await project.generate('SEC-1', images, request, signal, agent)
    await project.review('SEC-1', images, { image_position: 0, decision: 'reject', reason: '设备外观与方案不符' }, signal)
    await expect(project.generate('SEC-1', images, request, signal, agent)).rejects.toThrow('调整 prompt')
    await project.generate('SEC-1', images, { ...request, prompt: '修正后的设备方案' }, signal, agent)
    await project.review('SEC-1', images, { image_position: 1, decision: 'accept', reason: '实际图已修正' }, signal)
    expect((await call('review_bid_image', { image_position: 1, decision: 'reject', reason: '删除' })).isError).toBe(true)
    await writeFile(join(workspace.projectRoot, images[1]!.path), Buffer.from('损坏内容'))
    await expect(readBidImageBytes(workspace, images[1]!.id)).rejects.toThrow()
    expect(await validateChapterImages(workspace, [images[1]!], `![图](${images[1]!.path})`)).not.toEqual([])
  })

  it('全书普通图片与生成图共享20MiB精确预算，超限不写入图片或改动正文', async () => {
    const { project, images, workspace, png, agent } = await fixture()
    const signal = new AbortController().signal
    await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
    const body = '![资料图](ordinary.png)'
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), body)
    await writeFile(join(workspace.projectRoot, 'ordinary.png'), Buffer.concat([png, Buffer.alloc(DOCX_MAX_BODY_IMAGE_BYTES - png.length * 2)]))
    await project.generate('SEC-1', images, request, signal, agent)
    await project.review('SEC-1', images, { image_position: 0, decision: 'accept', reason: '通过' }, signal)
    expect(await validateChapterImages(workspace, images, `![生成图](${images[0]!.path})`, 'chapters/sections/0001.md')).toEqual([])
    await writeFile(join(workspace.projectRoot, 'ordinary.png'), Buffer.concat([png, Buffer.alloc(DOCX_MAX_BODY_IMAGE_BYTES - png.length + 1)]))
    expect(await validateChapterImages(workspace, images, `![生成图](${images[0]!.path})`, 'chapters/sections/0001.md'))
      .toContainEqual(expect.stringContaining('20 MiB'))
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')).toBe(body)
  })

  it('不同Writer并发生成的大图在串行提交处拒绝累计超限，首个资产保持可用', async () => {
    const { project, images, png, generate, agent, beforeRequest } = await fixture()
    const signal = new AbortController().signal
    await project.generate('SEC-1', images, request, signal, agent)
    await project.review('SEC-1', images, { image_position: 0, decision: 'accept', reason: '通过' }, signal)
    project.release('SEC-1')
    generate.mockImplementation(async (request) => {
      await beforeRequest(request)
      return {
        png: Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024 - png.length - 1), Buffer.from([request.prompt.includes('二区') ? 2 : 1])]),
        width: 24, height: 16, model: request.model ?? connection.model,
      }
    })
    const first: BidChapterImage[] = []
    const second: BidChapterImage[] = []
    const results = await Promise.allSettled([
      project.generate('SEC-2', first, { ...request, prompt: '一区效果' }, signal, agent),
      project.generate('SEC-3', second, { ...request, prompt: '二区效果' }, signal, agent),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(first.length + second.length).toBe(1)
    project.release('SEC-2')
    project.release('SEC-3')
  })

  it('付费请求前完整prompt和参考附件已持久化，接口失败仍保留该次请求', async () => {
    const { ctx, agent, project, images, generate, beforeRequest } = await fixture()
    const signal = new AbortController().signal
    generate.mockImplementationOnce(async (request) => {
      await beforeRequest(request)
      const persisted = await ctx.sessionPersistence.inspect(agent.id, signal)
      expect(persisted?.events.findLast(event => event.type === 'bid.image.requested'))
        .toMatchObject({ data: { prompt: request.prompt, size: request.size, model: connection.model } })
      throw new Error('外部图片API失败')
    })
    await expect(project.generate('SEC-1', images, request, signal, agent)).rejects.toThrow('外部图片API失败')
    expect(agent.session.events.filter(event => event.type === 'bid.image.requested')).toHaveLength(1)
    expect(images).toEqual([])
    await project.generate('SEC-1', images, { ...request, prompt: '重新选择场景' }, signal, agent)
    await project.review('SEC-1', images, { image_position: 0, decision: 'accept', reason: '参考风格已确认' }, signal)
    await project.generate('SEC-2', [], { ...request, prompt: '下一场景' }, signal, agent)
    const recorded = agent.session.events.findLast(event => event.type === 'bid.image.requested')!
    expect(recorded.type).toBe('bid.image.requested')
    if (recorded.type !== 'bid.image.requested' || recorded.data.reference === undefined) throw new Error('缺少实际参考附件')
    const bytes = await ctx.attachments.readImage(recorded.data.reference.attachment, signal)
    expect(generate.mock.calls.at(-1)![0].reference).toEqual(Buffer.from(bytes.data))
  })
})
