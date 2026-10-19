/** 只提交自然语言与上传原件；主模型、语义核验、作图和页面视觉均使用配置的真实服务。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { nativeDocumentFixture, assertNativeDocumentPreserved } from '../../../../packages/bid/bid/tests/fixtures/native-document.ts'
import { bidDocumentRecordSchema } from '../../../../packages/bid/bid/src/document-assets.ts'

const root = process.cwd()
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const config = process.argv[2]
const provider = process.env.DSH_BID_EVAL_PROVIDER
assert(config !== undefined && provider !== undefined)
const route = { provider, model: process.env.DSH_BID_EVAL_MODEL ?? 'gpt-5.6-luna' }
const liveHome = process.env.DSH_BID_EVAL_HOME ?? join(homedir(), '.dsh')
const evidenceRoot = join(repo, '.artifacts', 'bid-main-agent-live', String(Date.now()))
await mkdir(evidenceRoot, { recursive: true })
process.stderr.write(`验证证据：${evidenceRoot}\n`)
const ctx = await boot('bid-main-agent', config, [
  ...loadOverlayPatches('bid-main-agent', join(repo, 'packages/bundle/base/cordis.patch.yml')),
  { id: 'hmr', disabled: true }, { id: 'session-telemetry-otel', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'settings', config: { dshHome: liveHome, watch: false } },
  { id: 'credentials', config: { dshHome: liveHome, watch: false } },
  { id: 'attachment-local', config: { dshHome: join(root, '.dsh') } },
  { id: 'session-persistence-jsonl', config: { root: join(root, '.session-store'), compression: 'none' } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: root } },
  { insert: [
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'bid',
      roots: [{ path: join(repo, 'apps/cli/config/agent-presets'), trust: 'system' }], includeUserRoot: false } },
    { id: 'bid-host-runtime', name: '@deepseek-ai/dsh-bid', config: { webSearchEnabled: false,
      imageGeneration: { model: process.env.BID_IMAGE_E2E_MODEL ?? 'gpt-image-2' } } },
    { id: 'task-http', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
  ] },
])
const sessions = new Set<Session>()
ctx.on('session/event', (session, event) => {
  sessions.add(session)
  if (['tool/call', 'tool/result', 'bid.run.started', 'bid.run.completed', 'bid.task.changed', 'assistant/message',
    'bid.visual-review.request', 'bid.image.requested'].includes(event.type)) {
    const line = JSON.stringify({ session: session.id, event }) + '\n'
    process.stderr.write(line)
    appendFileSync(join(evidenceRoot, '进度.jsonl'), line)
  }
}, { global: true })
try {
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => route })
  let { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('bid-main-live'),
    agentOptions: route, meta: { cwd: root, agentPreset: 'bid' } })
  const workspace = new BidWorkspace(root)
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const original = await nativeDocumentFixture()
  await writeFile(join(root, '设备维护成稿.docx'), original.bytes)
  await writeFile(join(evidenceRoot, '配图前.docx'), original.bytes)
  const upload = await fetch(`${base}/api/bid/attachments`, { method: 'POST', headers: {
    origin: base, 'x-dsh-bid-session-id': String(agent.session.id), 'x-dsh-file-name': encodeURIComponent('设备维护成稿.docx'),
    'x-dsh-file-size': String(original.bytes.length),
  }, body: new Uint8Array(original.bytes) })
  assert.equal(upload.status, 200, await upload.clone().text())
  const { ref } = await upload.json() as { ref: { attachmentId: string; version: string } }
  const prompt = '请给这份现有的设备维护 Word 成稿自动配图。先读原文，再自行选择合适的位置，补上一张说明检查、异常复核和记录保存的流程图，以及一张设备维护场景概念插画。图的内容、布局和插入位置由你根据原稿决定，添加合适的题注。保留全部原文、表格、已有图片、页眉页脚、书签和链接，不把概念插画当成真实项目照片。检查修改后的实际页面，发现配图或排版问题就修好，最后交付可下载的修改版 Word。'
  await writeFile(join(evidenceRoot, '请求.json'), JSON.stringify({ route, prompt, ref }, null, 2) + '\n')
  const submitted = await api.sessions.prompt({ rpcId: RpcId('1'), payload: { sessionId: agent.session.id,
    mode: 'queue', clientSubmissionId: '1', content: [{ type: 'text', text: prompt }],
    fileRefs: [promptFileRefSchema.parse({ attachmentId: ref.attachmentId, version: ref.version })] } })
  assert(submitted.result.ok, JSON.stringify(submitted))
  const deadline = Date.now() + 1_770_000
  const visited = new Set<string>()
  let delivered: { workId: string; view: Awaited<ReturnType<typeof ctx.bid.getTaskDeliverables>> } | undefined
  while (Date.now() < deadline && delivered === undefined) {
    for (const event of agent.session.events) {
      if (event.type !== 'bid.run.completed' || visited.has(event.data.run.work.workId)) continue
      const workId = event.data.run.work.workId
      visited.add(workId)
      const view = await ctx.bid.getTaskDeliverables(agent.session, workId)
      if (view.files.some(file => file.name.endsWith('.docx'))) delivered = { workId, view }
    }
    if (delivered === undefined) await delay(1000)
  }
  assert(delivered !== undefined, '真实主 Agent 未在限定时间交付 Word；查看保留的完整会话与候选。')
  await agent.whenIdle()
  const calls = agent.session.events.filter(event => event.type === 'tool/call')
  assert(JSON.stringify(calls).includes('bid_project_inspect'))
  assert(JSON.stringify(calls).includes('bid_run_task'))
  for (const capability of ['flowchart.create', 'project_image.create', 'document.patch', 'document.layout_review']) {
    assert(JSON.stringify(calls).includes(capability), `真实主模型未调用 ${capability}`)
  }
  const verifiers = [...sessions].filter(session => session !== agent.session && session.events.some(event =>
    event.type === 'tool/call' && JSON.stringify(event.data).includes('structured_output')))
  assert(verifiers.length >= 2, '缺少真实计划与结果核验会话')
  assert(!verifiers.some(session => session.events.some(event => event.type === 'tool/call'
    && JSON.stringify(event.data).includes('bid_read_recovery_input'))), '语义核验混入执行者恢复建议')
  assert(verifiers.some(session => session.events.some(event => event.type === 'tool/call' && JSON.stringify(event.data).includes('read_task_evidence'))))
  const download = async (position: number, mode: 'download' | 'preview') => {
    const query = new URLSearchParams({ session: String(agent.session.id), work: delivered.workId,
      receipt: delivered.view.receipt, position: String(position), mode })
    const response = await fetch(`${base}/api/bid/artifacts?${query}`, { headers: { origin: base } })
    assert.equal(response.status, 200)
    return Buffer.from(await response.arrayBuffer())
  }
  const doc = delivered.view.files.find(file => file.name.endsWith('.docx'))!
  const bytes = await download(doc.position, 'download')
  await writeFile(join(evidenceRoot, '配图后.docx'), bytes)
  await writeFile(join(evidenceRoot, '实际页面.pdf'), await download(doc.position, 'preview'))
  for (const file of delivered.view.files) await writeFile(join(evidenceRoot, file.name), await download(file.position, 'download'))
  const unchanged = await assertNativeDocumentPreserved(original.bytes, bytes)
  const documentPaths = await readdir(join(workspace.projectRoot, 'assets/documents'), { recursive: true })
  const records = await Promise.all(documentPaths.filter(path => path.endsWith('record.json')).map(async path =>
    bidDocumentRecordSchema.parse(JSON.parse(await readFile(join(workspace.projectRoot, 'assets/documents', path), 'utf8')))))
  const version = createHash('sha256').update(bytes).digest('hex')
  const record = records.find(value => value.work_id === delivered.workId && value.ref.version === version
    && value.page_review?.status === 'passed')
  assert(record?.page_review?.status === 'passed')
  await cp(join(workspace.projectRoot, record.page_review.report), join(evidenceRoot, '页面审核.json'))
  assert((await readFile(join(root, '设备维护成稿.docx'))).equals(original.bytes))
  await ctx.sessions.flush(agent.session)
  await ctx.agentLoop.disposeAgent(agent.id)
  agent = (await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('bid-main-live'), agentOptions: route })).agent
  assert.deepEqual(await ctx.bid.getTaskDeliverables(agent.session, delivered.workId), delivered.view)
  assert((await download(doc.position, 'download')).equals(bytes))
  assert.equal(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE).workflow, null)
  const result = { realMain: true, realVerifier: true, nativeWord: true, actualPages: true, httpDownload: true, resumed: true,
    route, workId: delivered.workId, verifierSessions: verifiers.map(session => session.id), unchangedParts: unchanged,
    changes: record.changes, deliverables: delivered.view }
  await writeFile(join(evidenceRoot, '验证结果.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result) + '\n')
} finally {
  for (const session of sessions) {
    await writeFile(join(evidenceRoot, `session-${session.id}.json`), JSON.stringify(session.events, null, 2) + '\n')
  }
  await cp(new BidWorkspace(root).projectRoot, join(evidenceRoot, 'project'), { recursive: true })
  for (const session of ctx.sessions.list()) await ctx.sessions.flush(session)
  await cp(join(root, '.session-store'), join(evidenceRoot, 'session-store'), { recursive: true })
  await ctx.fiber.dispose()
}
