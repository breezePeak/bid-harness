/** 正式 Bid preset、HTTP 附件、主 Agent、能力发布和重载下载的完整应用回放。 */
import assert from 'node:assert/strict'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { nativeDocumentFixture } from '../../../../packages/bid/bid/tests/fixtures/native-document.ts'
import { scriptedVerificationCall } from '../../../../packages/bid/bid/tests/fixtures/task-verifier.ts'
import { resolveBidToolAuthorization } from '../../../../packages/bid/bid/src/bid-tool-authorization.ts'

const root = process.cwd()
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const config = process.argv[2]
assert(config !== undefined)
const live = process.argv.includes('--live')
const route = live ? { provider: process.env.DSH_BID_EVAL_PROVIDER ?? 'pp', model: process.env.DSH_BID_EVAL_MODEL ?? 'gpt-5.6-luna' }
  : { provider: 'task-entry', model: 'visual' }
const evidenceRoot = join(repo, '.artifacts', 'bid-task-refactor-demo')
const liveHome = process.env.DSH_BID_EVAL_HOME ?? join(homedir(), '.dsh')
const calls: Array<{ name: string; args: object }> = []
const schemas: string[][] = []
class TaskAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const line = text.split('\n').find(value => value.startsWith('核验输入：'))
    let call: { name: string; args: object } | undefined
    let response = '已收到，按你的任务处理。'
    if (line !== undefined) call = scriptedVerificationCall(
      JSON.parse(line.slice('核验输入：'.length)) as Parameters<typeof scriptedVerificationCall>[0], options.messages)
    else if (options.tools === undefined || options.tools.length === 0) {
      assert(options.messages.some(message => message.content.some(block => block.type === 'image')))
      response = JSON.stringify(text.includes('page_position') ? { status: 'pass', issues: [], fixes: [] }
        : { status: 'pass', reason: '实际流程图的标签和箭头可读。' })
    } else {
      const names = options.tools.map(tool => tool.name)
      schemas.push(names)
      assert(names.includes('bid_project_inspect'), `模型回放缺少主会话工具：${names.join(',')}，输入：${text.slice(-500)}`)
      const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
      if (agent !== undefined && resolveBidToolAuthorization(agent) !== undefined) call = calls.shift()
      if (call !== undefined) assert(names.includes(call.name), call.name)
    }
    yield { type: 'block-start', index: 0, blockType: call === undefined ? 'text' : 'tool-call' }
    yield { type: 'block-end', index: 0, block: call === undefined ? { type: 'text', text: response }
      : { type: 'tool-call', id: CallId(line === undefined ? call.name : 'verification'), name: call.name, arguments: JSON.stringify(call.args) } }
    yield { type: 'finish', reason: { kind: call === undefined ? 'stop' : 'tool-calls' } }
  }
}
const ctx = await boot('bid-task-entry', config, [
  ...loadOverlayPatches('bid-task-entry', join(repo, 'packages/bundle/base/cordis.patch.yml')),
  { id: 'hmr', disabled: true }, { id: 'session-telemetry-otel', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'settings', config: { ...(live ? { dshHome: liveHome } : { path: join(root, '.settings.yml') }), watch: false } },
  { id: 'credentials', config: { dshHome: live ? liveHome : join(root, '.dsh'), watch: false } },
  { id: 'attachment-local', config: { dshHome: join(root, '.dsh') } },
  { id: 'session-persistence-jsonl', config: { root: join(root, '.session-store'), compression: 'none' } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: root } },
  { insert: [
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'bid',
      roots: [{ path: join(repo, 'apps/cli/config/agent-presets'), trust: 'system' }], includeUserRoot: false } },
    { id: 'bid-host-runtime', name: '@deepseek-ai/dsh-bid', config: { webSearchEnabled: false,
      ...(live ? { imageGeneration: { model: process.env.BID_IMAGE_E2E_MODEL ?? 'gpt-image-2' } } : {}) } },
    { id: 'task-http', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
  ] },
])
try {
  const scripted = new TaskAdapter()
  if (live) ctx.on('llm/stream', (options, next) => options.tools?.length ? scripted.stream(options) : next())
  else ctx.effect(() => ctx.llm.registerAdapter(['task-entry'], scripted))
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => route })
  let { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('task-entry-main'),
    agentOptions: route, meta: { cwd: root, agentPreset: 'bid' } })
  const workspace = new BidWorkspace(root)
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  let submission = 0
  const send = async (text: string, fileRefs?: Array<{ attachmentId: string; version: string }>) => {
    const result = await api.sessions.prompt({ rpcId: RpcId(String(++submission)), payload: { sessionId: agent.session.id,
      mode: 'queue', clientSubmissionId: String(submission), content: [{ type: 'text', text }],
      ...(fileRefs === undefined ? {} : {
        fileRefs: fileRefs.map(({ attachmentId, version }) => promptFileRefSchema.parse({ attachmentId, version })),
      }) } })
    assert(result.result.ok, JSON.stringify(result))
    await agent.whenIdle()
    const errors = agent.session.events.filter(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'tool-result' && block.isError))
    assert.equal(errors.length, 0, JSON.stringify(errors))
  }
  const completed = (session: Session) => {
    const done = Promise.withResolvers<string>()
    const timeout = setTimeout(() =>{  done.reject(new Error('任务未在限定时间完成')) }, live ? 480_000 : 100_000)
    const off = ctx.on('session/event', (current, event) => {
      if (current !== session) return
      if (event.type === 'bid.run.completed') done.resolve(event.data.run.work.workId)
      if (event.type === 'bid.task.changed' && event.data.state.status === 'failed') done.reject(new Error(JSON.stringify(event.data.state)))
    }, { global: true })
    const result = done.promise.finally(() => { clearTimeout(timeout); off() })
    void result.catch(() => {}) // send 等待主会话空闲期间先保留后台失败，随后由调用方 await 抛出。
    return result
  }
  await send('你好，说明一下能处理哪些任务。')
  assert.equal(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).workflow, null)
  assert(!agent.session.events.some(event => event.type === 'bid.run.started'))
  const original = await nativeDocumentFixture()
  await writeFile(join(root, '配图前.docx'), original.bytes)
  if (live) {
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(join(evidenceRoot, '配图前.docx'), original.bytes)
  }
  const upload = await fetch(`${base}/api/bid/attachments`, { method: 'POST', headers: {
    origin: base, 'x-dsh-bid-session-id': String(agent.session.id), 'x-dsh-file-name': encodeURIComponent('已有成稿.docx'),
    'x-dsh-file-size': String(original.bytes.length),
  }, body: new Uint8Array(original.bytes) })
  assert.equal(upload.status, 200, await upload.clone().text())
  const { ref } = await upload.json() as { ref: { attachmentId: string; version: string } }
  await send('先保留这份成稿。', [ref])
  for (const path of ['manifest.json', 'corpus', 'assets/parsed']) await assert.rejects(access(join(workspace.projectRoot, path)), { code: 'ENOENT' })
  assert(!agent.session.events.some(event => event.type === 'bid.run.started'))
  calls.push({ name: 'bid_project_inspect', args: { query: { object: 'document', file_position: 0 } } })
  await send('读取原稿的结构，定位第二处重复原文。')
  const tool = agent.session.events.findLast(event => event.type === 'tool/result')
  assert(tool?.type === 'tool/result')
  const payload = tool.data.message.content.flatMap(block => block.type === 'tool-result' ? block.content : [])
    .find(block => block.type === 'text')
  assert(payload?.type === 'text')
  const inspected = JSON.parse(payload.text) as { objects: { document_blocks: Array<{ position: number; label: string }> } }
  const target = inspected.objects.document_blocks.filter(block => (JSON.parse(block.label) as { text: string }).text === '重复原文')[1]!
  assert(target !== undefined)
  const flow = { description: '绘制接收处理流程', scope: { source: 'task' }, call: { capability: 'flowchart.create', input: {
    title: '接收处理流程', purpose: '说明检查、处理与退回重检', nodes: [{ type: 'start', text: '接收' },
      { type: 'decision', text: '检查合格？' }, { type: 'process', text: '处理' }, { type: 'process', text: '退回修正' }, { type: 'end', text: '完成' }],
    edges: [{ from_position: 0, to_position: 1 }, { from_position: 1, to_position: 2, label: '合格' },
      { from_position: 1, to_position: 3, label: '不合格' }, { from_position: 3, to_position: 1, label: '重新检查' }, { from_position: 2, to_position: 4 }],
  } } }
  calls.push({ name: 'bid_run_task', args: { task: { goal: '生成接收处理流程图', scope: { kind: 'project' }, steps: [flow] } } })
  let finished = completed(agent.session)
  await send('只绘制接收处理流程图，检查不合格退回修正后重检，不修改 Word。')
  const flowWork = await finished
  await agent.whenIdle()
  const flowFiles = await ctx.bid.getTaskDeliverables(agent.session, flowWork)
  assert.deepEqual(flowFiles.files.map(file => file.mediaType).sort(), ['application/json', 'image/png', 'image/svg+xml'])
  const saveDeliverables = async (workId: string) => {
    const view = await ctx.bid.getTaskDeliverables(agent.session, workId)
    for (const file of view.files) {
      const query = new URLSearchParams({ session: String(agent.session.id), work: workId, receipt: view.receipt,
        position: String(file.position), mode: 'download' })
      const response = await fetch(`${base}/api/bid/artifacts?${query}`, { headers: { origin: base } })
      assert.equal(response.status, 200)
      await writeFile(join(evidenceRoot, file.name), Buffer.from(await response.arrayBuffer()))
    }
  }
  if (live) {
    await saveDeliverables(flowWork)
    calls.push({ name: 'bid_run_task', args: { task: { goal: '独立生成机房维护概念图', scope: { kind: 'project' }, steps: [{
      description: '绘制机房维护概念场景并检查图片', scope: { source: 'task' }, call: { capability: 'project_image.create', input: {
        title: '机房维护概念图', purpose: '解释设备部署与维护通道', size: '1536x1024',
        prompt: '等距透视的数据中心机房概念插画，几排设备机柜和清晰维护通道，维护人员检查设备；无文字、数字或标识，不表示真实企业现场或业绩。',
        style: '白色背景、蓝灰主色、少量青色，整洁商务方案插画。',
      } },
    }] } } })
    finished = completed(agent.session)
    await send('独立生成一张机房维护概念图：设备机柜、维护通道与检查设备的人员，蓝灰青色，不修改原稿，不表示真实项目业绩。')
    await saveDeliverables(await finished)
    await agent.whenIdle()
  }
  calls.push({ name: 'bid_run_task', args: { task: { goal: '给原 Word 第二处重复原文添加流程图并检查页面', scope: { kind: 'files', file_positions: [0] }, steps: [flow,
    { description: '将流程图插入原稿', scope: { source: 'task' }, call: { capability: 'document.patch', input: {
      document: { source: 'file', file_position: 0 }, operations: [{ type: 'insert_figure', block_position: target.position, placement: 'after',
        figure: { source: 'step_outputs', step_position: 0, output_positions: [0] }, caption: '接收处理流程' }],
    } } }, { description: '检查最终 Word 页面', scope: { source: 'task' }, call: { capability: 'document.layout_review', input: {
      document: { source: 'step_outputs', step_position: 1, output_positions: [0] }, mode: 'repair', reason: '检查实际图片和题注，保留原文结构。',
    } } },
  ] } } })
  finished = completed(agent.session)
  await send('在原稿第二处重复原文后增加接收处理流程图和题注，保留其余原文结构，检查页面后交付修改版。')
  const documentWork = await finished
  await agent.whenIdle()
  const files = await ctx.bid.getTaskDeliverables(agent.session, documentWork)
  calls.push({ name: 'bid_project_inspect', args: { query: { object: 'task' } } })
  await send('查看刚才配图任务的实际完成状态。')
  const taskResult = agent.session.events.findLast(event => event.type === 'tool/result')
  assert(taskResult?.type === 'tool/result')
  const taskText = taskResult.data.message.content.flatMap(block => block.type === 'tool-result' ? block.content : [])
    .find(block => block.type === 'text')
  assert(taskText?.type === 'text')
  assert.equal((JSON.parse(taskText.text) as { data: { stage: unknown } }).data.stage, null)
  const doc = files.files.find(file => file.name.endsWith('.docx'))!
  assert(doc !== undefined)
  const query = new URLSearchParams({ session: String(agent.session.id), work: documentWork, receipt: files.receipt, position: String(doc.position), mode: 'download' })
  const url = `${base}/api/bid/artifacts?${query}`
  const download = await fetch(url, { headers: { origin: base } })
  assert.equal(download.status, 200, await download.clone().text())
  const bytes = Buffer.from(await download.arrayBuffer())
  await writeFile(join(root, '配图后.docx'), bytes)
  if (live) {
    await writeFile(join(evidenceRoot, '配图后.docx'), bytes)
    await saveDeliverables(documentWork)
    await writeFile(join(evidenceRoot, '验证事件.json'), JSON.stringify({ route, planning: '正式工具入口使用确定性脚本，图片 API 和视觉检查使用真实服务',
      events: agent.session.events.filter(event => ['bid.visual-review.request', 'bid.visual-review.result', 'bid.image.requested', 'bid.run.completed'].includes(event.type)),
    }, null, 2) + '\n')
  }
  assert.equal(bytes.subarray(0, 2).toString(), 'PK')
  assert.equal((await fetch(url + '&path=../../secret', { headers: { origin: base } })).status, 400)
  assert.equal((await fetch(url, { headers: { origin: 'https://untrusted.example' } })).status, 403)
  await ctx.sessions.flush(agent.session)
  await ctx.agentLoop.disposeAgent(agent.id)
  agent = (await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('task-entry-main'),
    agentOptions: route })).agent
  assert.deepEqual(await ctx.bid.getTaskDeliverables(agent.session, documentWork), files)
  assert((await readFile(join(root, '配图前.docx'))).equals(original.bytes))
  assert(Buffer.from(await (await fetch(url, { headers: { origin: base } })).arrayBuffer()).equals(bytes))
  assert.equal(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).workflow, null)
  calls.push({ name: 'bid_start_workflow', args: {} })
  await send('现在我要从招标资料开始完整编写标书。')
  assert.equal(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).workflow?.stage, 'file_intake')
  process.stdout.write(JSON.stringify({ chat: true, uploadOnly: true, flowchart: true, nativeWord: true,
    actualPages: true, httpDownload: true, unsafeDownloadRejected: true, resumed: true, explicitWorkflow: true,
    schemaCalls: schemas.length > 0 }) + '\n')
} finally {
  if (live) {
    await mkdir(evidenceRoot, { recursive: true })
    await cp(new BidWorkspace(root).projectRoot, join(evidenceRoot, `project-${String(Date.now())}`), { recursive: true })
  }
  await ctx.fiber.dispose()
}
