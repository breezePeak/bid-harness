/** 正式 Bid preset 与 Host 沙箱装配的独立文件任务；可使用脚本或真实模型驱动。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, BID_INITIAL_TASK_STATE, checkpointBidProjectState, reduceBidTaskState,
  type BidTaskState } from '@deepseek-ai/dsh-bid'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { assertDocxDocumentContains } from '../../../../packages/bid/bid/tests/fixtures/general-docx.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const root = process.cwd()
const config = process.argv[2]
assert(config !== undefined)
const live = process.argv[3] === 'live'
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value: string) => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'"
const docxRequire = createRequire(join(repo, 'packages/bid/bid/package.json'))
const docxModule = docxRequire.resolve('docx')
const script = `import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const { Document, Packer, Paragraph } = createRequire(${JSON.stringify(join(repo, 'packages/bid/bid/package.json'))})(${JSON.stringify(docxModule)});
const text = await readFile('目录.md', 'utf8');
await writeFile('目录.docx', await Packer.toBuffer(new Document({ sections: [{ children: text.split('\\n').map(line => new Paragraph(line)) }] })));
`

const calls: Array<{ name: string; arguments: object }> = []
const schemas: string[][] = []
class Scripted extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const names = options.tools?.map(tool => tool.name) ?? []
    schemas.push(names)
    for (const name of ['read', 'write', shell, 'skill', 'bid_stage_inspect']) assert(names.includes(name), name)
    assert(!names.includes('create_goal'))
    assert(!names.some(name => name.startsWith('finish_') || name.startsWith('submit_')))
    const call = calls.shift()
    if (call === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '独立任务已执行，正式阶段保持原状。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('general-' + call.name),
      name: call.name, arguments: JSON.stringify(call.arguments) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const ctx = await boot('bid-general-tools', config, [
  ...loadOverlayPatches('bid-general-tools', join(repo, 'packages/bundle/base/cordis.patch.yml')),
  { id: 'hmr', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'settings', config: { path: join(root, '.settings.yml'), watch: false } },
  { id: 'credentials', config: { dshHome: join(root, '.dsh'), watch: false } },
  { id: 'attachment-local', config: { dshHome: join(root, '.dsh') } },
  { id: 'session-persistence-jsonl', config: { root: join(root, '.session-store'), compression: 'none' } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: root } },
  { insert: [
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {
      default: 'bid', roots: [{ path: join(repo, 'apps/cli/config/agent-presets'), trust: 'system' }], includeUserRoot: false,
    } },
    { id: 'bid-host-runtime', name: '@deepseek-ai/dsh-bid', config: { webSearchEnabled: false } },
  ] },
])
try {
  if (!live) ctx.effect(() => ctx.llm.registerAdapter(['fixture-general'], new Scripted()))
  await writeFile(join(root, '目录.md'), '一、实施准备\n二、过程控制\n三、验收移交\n')
  const workspace = new BidWorkspace(root)
  await mkdir(workspace.projectRoot, { recursive: true })
  const failure = { code: 'BID_TEST_FAILURE', message: '阶段资料尚未补齐' }
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'failed', run: null, failure })
  let { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('bid-general-main'),
    agentOptions: { provider: live ? 'deepseek-official' : 'fixture-general', model: live ? 'deepseek-v4-flash' : 'fixture' },
    meta: { cwd: root, agentPreset: 'bid' } })
  const send = async (text: string) => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    assert.equal(end?.type === 'turn/end' ? end.data.reason.kind : undefined, 'completed')
    if (!live) {
      const errors = agent.session.events.filter(event => event.type === 'tool/result'
        && event.data.message.content.some(block => block.type === 'tool-result' && block.isError))
      assert.equal(errors.length, 0, JSON.stringify(errors))
    }
  }
  const stages: Array<{ stage: BidTaskState['stage']; status: BidTaskState['status'] }> = [
    { stage: 'evidence_mapping', status: 'failed' },
    ...live ? [] : [
      { stage: 'outline_generation' as const, status: 'waiting_user' as const },
      { stage: 'evidence_mapping' as const, status: 'waiting_user' as const },
      { stage: 'chapter_writing' as const, status: 'running' as const },
      { stage: 'evidence_mapping' as const, status: 'suspended' as const },
    ],
  ]
  const outcomes: object[] = []
  for (const { stage, status } of stages) {
    const work = await persistBidWorkRequest(workspace, 'stage_execution', stage, { stage }, { stage })
    const run = { runId: work.workId, work, epoch: 1, baseProjectRevision: 1, startedAt: Date.now(), updatedAt: Date.now() }
    const state: BidTaskState = status === 'running' ? { stage, status, run }
      : status === 'suspended' ? { stage, status, run: { ...run, cause: 'user_stop' } }
        : status === 'failed' ? { stage, status, run: null, failure } : { stage, status: 'waiting_user', run: null }
    agent.session.append('bid.task.changed', { state })
    const before = agent.session.events.length
    if (status === 'failed') {
      if (!live) calls.push({ name: 'read', arguments: { file_path: join(root, '目录.md') } },
        { name: 'write', arguments: { file_path: join(root, '生成目录.mjs'), content: script } },
        { name: shell, arguments: {
          command: (shell === 'pwsh' ? '& ' : '') + quote(process.execPath) + ' ' + quote(join(root, '生成目录.mjs')),
          description: '从目录 Markdown 生成独立 Word 文件', workdir: root,
        } })
      await send(live ? `读取当前目录的目录.md，用现有通用文件和 ${shell} 工具自行编写并运行脚本生成有效的目录.docx。
docx 库的现有模块路径：${docxModule}；Node 路径：${process.execPath}。不修改正式 Bid 产物，不恢复 S4，不触发 S6。检查真实输出，遇错自行修复。`
        : '把当前目录的目录.md 整理成独立 Word，不恢复 S4，不执行 S6。')
      await assertDocxDocumentContains(await readFile(join(root, '目录.docx')), '实施准备')
    } else {
      const path = join(root, `${stage}-${status}.md`)
      calls.push({ name: 'write', arguments: { file_path: path, content: '独立任务' } })
      await send('创建独立 Markdown 文件，不修改或恢复正式阶段。')
      assert.equal(await readFile(path, 'utf8'), '独立任务')
    }
    assert.deepEqual(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE), state)
    assert(!agent.session.events.slice(before).some(event => event.type === 'bid.run.started' || event.type === 'bid.user_confirmation.received'))
    outcomes.push({ stage, status, fileCreated: true })
  }
  const web = await ctx.tools.execute({ agent, name: 'web_search', arguments: { query: 'fixture' },
    callId: CallId('general-web-denied'), signal: new AbortController().signal })
  assert(web.isError && JSON.stringify(web).includes('BID_WEB_ACCESS_DISABLED'))
  const outsidePath = join(homedir(), `bid-general-denied-${randomUUID()}.md`)
  const denied = await ctx.tools.execute({ agent, name: 'write', arguments: { file_path: outsidePath, content: '越界探测' },
    callId: CallId('general-fs-denied'), signal: new AbortController().signal })
  if (!denied.isError) await rm(outsidePath)
  assert(denied.isError && JSON.stringify(denied).includes('file access denied under workspace-write mode'))
  const probePath = join(workspace.projectRoot, '通用工具权限探测.md')
  const probe = await ctx.tools.execute({ agent, name: 'write', arguments: { file_path: probePath, content: '现有工作区权限' },
    callId: CallId('general-workspace-probe'), signal: new AbortController().signal })
  assert(!probe.isError)
  assert.equal(await readFile(probePath, 'utf8'), '现有工作区权限')
  await ctx.sessions.flush(agent.session)
  if (!live) {
    const state = { stage: 'evidence_mapping' as const, status: 'waiting_user' as const, run: null }
    await checkpointBidProjectState(workspace, state)
    agent.session.append('bid.task.changed', { state })
    await ctx.sessions.flush(agent.session)
    await ctx.agentLoop.disposeAgent(agent.id)
    const ready = Promise.withResolvers<undefined>()
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id === 'bid-general-main' && event.type === 'bid.project.resumed') ready.resolve(undefined)
    })
    agent = (await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('bid-general-main'),
      agentOptions: { provider: 'fixture-general', model: 'fixture' } })).agent
    await ready.promise
    stop()
    const path = join(root, '重载后独立文件.md')
    calls.push({ name: 'write', arguments: { file_path: path, content: '重载后仍可执行' } })
    await send('重载后创建独立文件，不确认正式目录。')
    assert.equal(await readFile(path, 'utf8'), '重载后仍可执行')
    assert.deepEqual(agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE), state)
  }
  process.stdout.write(JSON.stringify({ outcomes, shell, schemasChecked: live ? false : schemas.length > 0,
    webDenied: true, outsideWriteDenied: true, formalDirectoryWritable: true,
    businessStatePreserved: true, docxVerified: true, resumed: !live }) + '\n')
} finally { await ctx.fiber.dispose() }
