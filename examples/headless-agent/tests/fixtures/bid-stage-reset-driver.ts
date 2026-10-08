/** 真实源码 Loader 的 S1 命令重置，清空项目资料与 Word 配置并保留原文件和聊天日志。 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  BID_INITIAL_TASK_STATE, BidWorkspace, checkpointBidProjectState, getBidClientProjection,
  readBidProjectState, reduceBidTaskState,
} from '@deepseek-ai/dsh-bid'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { seedConversation, seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'
import { readDocxFormat, saveDocxFormat, saveDocxTemplate } from '../../../../packages/bid/bid/src/docx-format-store.ts'

/** 模型请求计数只观察外部模型调用；重置命令应由 Host 完成。 */
class StageResetAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S1 重置回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-stage-reset-snapshot', configPath)
  const adapter = new StageResetAdapter()
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], adapter))
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  const originalTender = await readFile(join(workspace.inputRoot, 'tender.md'))
  await writeFile(join(workspace.root, 'tender.md'), originalTender)
  const builtInTemplatePath = new URL('../../../../packages/bid/bid/assets/templates/default-technical-bid.docx', import.meta.url)
  const builtInTemplate = await readFile(builtInTemplatePath)
  await writeFile(join(workspace.root, 'layout.docx'), builtInTemplate)
  const template = await saveDocxTemplate(workspace, { revision: 0, name: 'layout.docx', bytes: builtInTemplate })
  await saveDocxFormat(workspace, template.templateId, {
    revision: template.state.revision, userConfirmed: { 'body.font': '仿宋' },
  })
  const defaultFormat = await readDocxFormat(workspace, null)
  await saveDocxFormat(workspace, null, {
    revision: defaultFormat.state.revision, userConfirmed: { 'body.font': '楷体' },
  })
  for (const path of ['flowcharts', 'output']) {
    await mkdir(join(workspace.projectRoot, path), { recursive: true })
    await writeFile(join(workspace.projectRoot, path, 'prior-artifact.txt'), '重置前产物\n')
  }
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user', run: null })
  let executionAgents = 0
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') executionAgents++
  }, { global: true })
  const host = ctx.bid as unknown as { readonly inFlight: Map<string, { done: Promise<void> }> }
  const createFresh = async (id: string) => {
    const initialized = Promise.withResolvers<undefined>()
    const off = ctx!.on('session/event', (session, event) => {
      if (session.id === id && event.type === 'bid.project.resumed') initialized.resolve(undefined)
    }, { global: true })
    try {
      const handle = await ctx!.agentLoop.createAgent(ctx!, {
        sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' },
        meta: { cwd: process.cwd(), agentPreset: 'bid' },
      })
      await initialized.promise
      await Promise.all([...host.inFlight.values()].map(operation => operation.done))
      return handle.agent
    } finally { off() }
  }
  const agent = await createFresh('bid-reset-s1')
  seedConversation(agent.session)
  const conversation = [...agent.session.events]
  const listed = ctx.commands.list(agent).find(command => command.name === 'bid-reset-s1')
  const command = await ctx.commands.execute(agent, '/bid-reset-s1', [], new AbortController().signal)
  if (command === undefined) throw new Error('缺少 /bid-reset-s1 命令')
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  const task = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const saved = await readBidProjectState(workspace)
  const restored = await createFresh('bid-reset-s1-restored')
  const restoredTask = restored.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const removed = await Promise.all([
    'input', 'corpus', 'manifest.json', 'word-export', 'analysis', 'outline', 'chapters', 'flowcharts', 'output',
  ].map(async path => ({
    path, removed: await access(join(workspace.projectRoot, path)).then(() => false, () => true),
  })))
  const library = await ctx.bid.getDocxTemplateLibrary(agent.session)
  const resetFormat = await ctx.bid.getDocxFormat(agent.session, null)
  const commandEvents = agent.session.events.filter(event => event.type === 'command/run' || event.type === 'command/done')
  process.stdout.write(`${JSON.stringify({
    listed, result: command.result, task, restoredTask,
    durableTask: saved === undefined ? null : { stage: saved.stage, status: saved.status, run: saved.run },
    allowedActions: getBidClientProjection(task).allowedActions,
    emptyManifest: (await workspace.readManifest()).files,
    preserved: {
      originalTender: (await readFile(join(workspace.root, 'tender.md'))).equals(originalTender),
      originalTemplate: (await readFile(join(workspace.root, 'layout.docx'))).equals(builtInTemplate),
      builtInTemplate: (await readFile(builtInTemplatePath)).equals(builtInTemplate),
      chatHistory: conversation.every(event => agent.session.events.includes(event)),
    },
    wordFormat: { templateCount: library.templates.length, estimateTemplateId: library.estimateTemplateId,
      userConfirmed: resetFormat.state.userConfirmed, systemDefaultAvailable: resetFormat.state.extracted.paragraphs.length > 0 },
    removed, modelRequests: adapter.calls, executionAgents,
    runs: [...agent.session.events, ...restored.session.events].filter(event => event.type === 'bid.run.started').length,
    locksReleased: host.inFlight.size === 0,
    commandLifecycle: {
      events: commandEvents.map(event => event.type),
      sameId: commandEvents.every(event => event.data.commandId === command.commandId),
    },
    modelMessages: agent.session.deriveMessages().map(message => ({ source: message.source, content: message.content })),
    restoredModelMessages: restored.session.deriveMessages(),
  })}\n`)
} finally { await ctx?.fiber.dispose() }
