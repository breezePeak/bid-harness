/** fresh Session 通过真实源码 Loader 接管已有项目，不复制聊天。 */
import { mkdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BID_INITIAL_TASK_STATE, BidWorkspace, checkpointBidProjectState, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import { BID_DOCX_EXPORT_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import { SessionId } from '@deepseek-ai/dsh-session'
import { seedConversation, seedProjectArtifacts, summarizeDocxHeadingNumbering } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少项目接管回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-project-session-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user', run: null })
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
  const details = await ctx.bid.getDetails(b)
  const exportRoot = join(process.cwd(), 'export-project')
  await mkdir(exportRoot)
  const exportWorkspace = new BidWorkspace(exportRoot)
  await seedProjectArtifacts(exportWorkspace)
  await checkpointBidProjectState(exportWorkspace, { stage: 'docx_export', status: 'ready', run: null })
  const exporting = await createFresh('export-session-a', exportRoot)
  const automaticExport = await access(join(exportWorkspace.outputRoot, 'bid.docx')).then(() => true, () => false)
  const startingFormat = await ctx.bid.getDocxFormat(exporting, null)
  const preview = await ctx.bid.previewDocx(exporting, null)
  const beforeGenerate = await access(join(exportWorkspace.outputRoot, 'bid.docx')).then(() => true, () => false)
  const generated = await ctx.bid.exportDocx(exporting, null)
  if (!generated.ok) throw new Error(generated.error.message)
  const exportEvents = exporting.events.filter(event => event.type === 'bid.docx_export.changed')
  const operation = ctx.sessionProjections.snapshot(exporting).values[BID_DOCX_EXPORT_PROJECTION_KEY]
  const docx = await readFile(join(exportWorkspace.projectRoot, generated.value.path))
  const exportedState = await readFile(exportWorkspace.projectStatePath, 'utf8')
  const completed = await createFresh('export-session-b', exportRoot)
  const completedDetails = await ctx.bid.getDetails(completed)
  const restoredFormat = await ctx.bid.getDocxFormat(completed, null)
  process.stdout.write(`${JSON.stringify({
    task: b.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
    messages: b.deriveMessages(), nodes: b.surface.nodes,
    parentSession: b.header.parentSession ?? null, seedLength: b.header.seedLength ?? null,
    outlineTitles: outline.sections.map(section => section.title),
    details: {
      tender: details.tender?.project.project_name, outline: details.outline?.sections.map(section => section.title), body: details.body,
    },
    fileCount: (await workspace.readManifest()).files.length,
    previousMessageCount: a.deriveMessages().length,
    export: {
      operation: {
        steps: exportEvents.map(event => `${event.data.operation.status}:${event.data.operation.phase}`),
        oneId: new Set(exportEvents.map(event => event.data.operation.operationId)).size === 1,
        resultMatches: operation?.status === 'completed' && operation.path === generated.value.path,
        filePathMatches: operation?.status === 'completed'
          && operation.filePath?.toLocaleLowerCase('en-US')
            === join(exportWorkspace.projectRoot, generated.value.path).toLocaleLowerCase('en-US'),
        projectionStatus: operation?.status,
      },
      automaticExport, beforeGenerate, formatRestored: JSON.stringify(restoredFormat.state.resolved) === JSON.stringify(startingFormat.state.resolved), previewIsFixedSample: preview.previewHtml?.includes('这是一段正文示例'),
      details: {
        tender: completedDetails.tender?.project.project_name,
        outline: completedDetails.outline?.sections.map(section => section.title), body: completedDetails.body,
      },
      task: exporting.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
      nextTask: completed.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
      messages: completed.deriveMessages(),
      executions: [...exporting.events, ...completed.events].filter(event => event.type === 'bid.stage.started' && event.data.stage === 'docx_export').length,
      docxAvailable: docx.length > 0 && docx.subarray(0, 2).toString() === 'PK',
      headingNumbering: await summarizeDocxHeadingNumbering(docx),
      unchanged: docx.equals(await readFile(join(exportWorkspace.projectRoot, generated.value.path))),
      checkpointUnchanged: await readFile(exportWorkspace.projectStatePath, 'utf8') === exportedState,
    },
  })}\n`)
} finally { await ctx?.fiber.dispose() }
