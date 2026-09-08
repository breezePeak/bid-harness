/** 真实模型只理解格式描述；配置和正文的变更由程序检查。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { SessionId } from '@deepseek-ai/dsh-session'
import { seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const ctx = await boot('bid-word-format-e2e', process.argv[2]!)
try {
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
  const ready = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => { if (session.id === 'word-format' && event.type === 'bid.project.resumed') ready.resolve(undefined) }, { global: true })
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('word-format'), agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, meta: { cwd: process.cwd(), agentPreset: 'bid' } })
  await ready.promise
  off()
  const host = ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }
  await Promise.all([...host.inFlight.values()].map(operation => operation.done))
  const session = handle.agent.session
  session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'initial' })
  const view = await ctx.bid.getDocxFormat(session)
  const chapter = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const original = await readFile(chapter, 'utf8')
  await ctx.bid.saveDocxFormat(session, { revision: view.state.revision, source: 'default', mapping: {}, overrides: {}, description: '正文使用宋体，字号15磅，行距固定20磅；其余不变。' })
  const suggestion = await ctx.bid.suggestDocxFormat(session)
  const unchanged = await ctx.bid.getDocxFormat(session)
  process.stdout.write(`${JSON.stringify({ suggestion, configuredSize: unchanged.values['body.size'], chapterUnchanged: original === await readFile(chapter, 'utf8'), loggedRequest: session.events.some(event => event.type === 'bid.word-format.request') })}\n`)
} finally { await ctx.fiber.dispose() }
