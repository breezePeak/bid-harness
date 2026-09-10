/** 真实模型只解释模板正文和程序提取的样式候选。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { SessionId } from '@deepseek-ai/dsh-session'
import { saveDocxTemplate } from '../../../../packages/bid/bid/src/docx-format-store.ts'
import { seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const TEMPLATE = 'UEsDBBQAAAAIABuuKl3GEnoHrAAAAPEAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2Puw7CMAxFf6XKiqgLAwNK0oEdGPgBK3HbiOahJBT4exKQOjBax/dcm/cvOzcLxWS8E2zXdqyX/PYOlJpCXBJsyjkcAZKayGJqfSBXyOCjxVzGOEJAdceRYN91B1DeZXJ5m6uDSX4p8mg0NVeM+YyWBIOnjxq0Vw9bNttiY83pF6vNgmEIs1GYy02wOP3XufXDYBSt+WoL0StKybjRzu1KLBq3qXqQHL5PyQ9QSwMEFAAAAAgAG64qXbviwsEDAQAAewEAABEAAAB3b3JkL2RvY3VtZW50LnhtbLOxr8jNUShLLSrOzM+zVTLUM1Cyt7Mpt0rJTy7NTc0rUQBK5xVbldsqZZSUFFjp6xcnZ6TmJhbr5Rek5gHl0vKLchNLgNyidP3y/KKUgqL85NTi4sy89NwcfSMDAzP93MTMPCWQkUn5KZUgugBMBBSBqeCSypxUhXKrssQcWyU/kGE5Svp2NvpwFWCixO7Z2sXPprU/2bv/+ZQVT9d1P9k7+f2enqdrpz/t325o+nxxK5D3YmHPi+1zn87e9XTdLCMDsNjsp63bnuyd+WRH79P+GY8bmkDmloBNBxoLsoN898xc97Jh1rMVC5/N3f98ya4n+7ohLsRuCZCE+B7IgIWsHQBQSwMEFAAAAAgAG64qXVjBko6iAAAA8QAAAA8AAAB3b3JkL3N0eWxlcy54bWxFjUsOwjAMRK9S5QCkVIhF1LRrNogrWG36kfKTHRrK6UkiKCt75nnGbf8yutoU0uqsZOdTzfqujYLCrhVVCVoSUbIlBC84p2FRBujkvLKJTQ4NhCRx5tHh6NENimi1s9G8qesrN7BadhRWUYTdK8k8IMwIfmHJGtUETx3S96zK4W2U7J7LdQlbMDm7gT5snn18YOl+/2BzyYB/SZql7b9R9wFQSwECFAAUAAAACAAbripdxhJ6B6wAAADxAAAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIABuuKl274sLBAwEAAHsBAAARAAAAAAAAAAAAAAAAAN0AAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUABQAAAAIABuuKl1YwZKOogAAAPEAAAAPAAAAAAAAAAAAAAAAAA8CAAB3b3JkL3N0eWxlcy54bWxQSwUGAAAAAAMAAwC9AAAA3gIAAAAA'

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
  const bytes = Buffer.from(TEMPLATE, 'base64')
  const extracted = await saveDocxTemplate(workspace, { revision: 0, name: '格式说明.docx', bytes })
  const chapter = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const original = await readFile(chapter, 'utf8')
  const suggestion = await ctx.bid.suggestDocxFormat(session)
  const unchanged = await ctx.bid.getDocxFormat(session)
  process.stdout.write(`${JSON.stringify({ suggestion,
    extractedText: extracted.state.extracted.paragraphs,
    configuredSize: unchanged.values['body.size'],
    chapterUnchanged: original === await readFile(chapter, 'utf8'),
    loggedRequest: session.events.some(event => event.type === 'bid.word-format.request') })}\n`)
} finally { await ctx.fiber.dispose() }
