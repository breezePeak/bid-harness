/** fresh Session 通过真实源码 Loader 接管已有项目，不复制聊天。 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BID_INITIAL_RUNTIME_STATE, BidWorkspace, checkpointBidProjectState, reduceBidRuntimeState } from '@deepseek-ai/dsh-bid'
import { SessionId } from '@deepseek-ai/dsh-session'
import { seedConversation, seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少项目接管回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-project-session-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
  const host = ctx.bid as unknown as { readonly inFlight: Map<string, { done: Promise<void> }> }
  const createFresh = async (id: string, cwd = process.cwd()) => {
    const initialized = Promise.withResolvers<undefined>()
    const off = ctx!.on('session/event', (session, event) => {
      if (session.id === id && event.type === 'bid.project.resumed') initialized.resolve(undefined)
    }, { global: true })
    try {
      const handle = await ctx!.agentLoop.createAgent(ctx!, {
        sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd, agentPreset: 'bid' },
      })
      await initialized.promise
      await Promise.all([...host.inFlight.values()].map(operation => operation.done))
      return handle.agent.session
    } finally { off() }
  }
  const a = await createFresh('project-session-a')
  seedConversation(a)
  await ctx.sessions.flush(a)
  const b = await createFresh('project-session-b')
  const outline = await ctx.bid.getOutlineForConfirmation(b)
  const exportRoot = join(process.cwd(), 'export-project')
  await mkdir(exportRoot)
  const exportWorkspace = new BidWorkspace(exportRoot)
  await seedProjectArtifacts(exportWorkspace)
  await checkpointBidProjectState(exportWorkspace, { stage: 'docx_export', status: 'pending' })
  const exporting = await createFresh('export-session-a', exportRoot)
  const docx = await readFile(join(exportWorkspace.outputRoot, 'bid.docx'))
  const exportedState = await readFile(exportWorkspace.projectStatePath, 'utf8')
  const completed = await createFresh('export-session-b', exportRoot)
  process.stdout.write(`${JSON.stringify({
    runtime: b.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE),
    messages: b.deriveMessages(), nodes: b.surface.nodes,
    parentSession: b.header.parentSession ?? null, seedLength: b.header.seedLength ?? null,
    outlineTitles: outline.sections.map(section => section.title),
    fileCount: (await workspace.readManifest()).files.length,
    previousMessageCount: a.deriveMessages().length,
    export: {
      runtime: exporting.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE),
      nextRuntime: completed.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE),
      messages: completed.deriveMessages(),
      executions: [...exporting.events, ...completed.events].filter(event => event.type === 'bid.stage.started' && event.data.stage === 'docx_export').length,
      docxAvailable: docx.length > 0 && docx.subarray(0, 2).toString() === 'PK',
      unchanged: docx.equals(await readFile(join(exportWorkspace.outputRoot, 'bid.docx'))),
      checkpointUnchanged: await readFile(exportWorkspace.projectStatePath, 'utf8') === exportedState,
    },
  })}\n`)
} finally { await ctx?.fiber.dispose() }
