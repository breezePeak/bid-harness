/** 真实模型只解释模板正文和程序提取的样式候选。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { saveDocxTemplate } from '../../../../packages/bid/bid/src/docx-format-store.ts'
import { seedProjectArtifacts } from '../../../../packages/bid/bid/tests/fixtures/project-session.ts'

const TEMPLATE = 'UEsDBBQAAAAIABuuKl3GEnoHrAAAAPEAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2Puw7CMAxFf6XKiqgLAwNK0oEdGPgBK3HbiOahJBT4exKQOjBax/dcm/cvOzcLxWS8E2zXdqyX/PYOlJpCXBJsyjkcAZKayGJqfSBXyOCjxVzGOEJAdceRYN91B1DeZXJ5m6uDSX4p8mg0NVeM+YyWBIOnjxq0Vw9bNttiY83pF6vNgmEIs1GYy02wOP3XufXDYBSt+WoL0StKybjRzu1KLBq3qXqQHL5PyQ9QSwMEFAAAAAgAG64qXbviwsEDAQAAewEAABEAAAB3b3JkL2RvY3VtZW50LnhtbLOxr8jNUShLLSrOzM+zVTLUM1Cyt7Mpt0rJTy7NTc0rUQBK5xVbldsqZZSUFFjp6xcnZ6TmJhbr5Rek5gHl0vKLchNLgNyidP3y/KKUgqL85NTi4sy89NwcfSMDAzP93MTMPCWQkUn5KZUgugBMBBSBqeCSypxUhXKrssQcWyU/kGE5Svp2NvpwFWCixO7Z2sXPprU/2bv/+ZQVT9d1P9k7+f2enqdrpz/t325o+nxxK5D3YmHPi+1zn87e9XTdLCMDsNjsp63bnuyd+WRH79P+GY8bmkDmloBNBxoLsoN898xc97Jh1rMVC5/N3f98ya4n+7ohLsRuCZCE+B7IgIWsHQBQSwMEFAAAAAgAG64qXVjBko6iAAAA8QAAAA8AAAB3b3JkL3N0eWxlcy54bWxFjUsOwjAMRK9S5QCkVIhF1LRrNogrWG36kfKTHRrK6UkiKCt75nnGbf8yutoU0uqsZOdTzfqujYLCrhVVCVoSUbIlBC84p2FRBujkvLKJTQ4NhCRx5tHh6NENimi1s9G8qesrN7BadhRWUYTdK8k8IMwIfmHJGtUETx3S96zK4W2U7J7LdQlbMDm7gT5snn18YOl+/2BzyYB/SZql7b9R9wFQSwECFAAUAAAACAAbripdxhJ6B6wAAADxAAAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIABuuKl274sLBAwEAAHsBAAARAAAAAAAAAAAAAAAAAN0AAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUABQAAAAIABuuKl1YwZKOogAAAPEAAAAPAAAAAAAAAAAAAAAAAA8CAAB3b3JkL3N0eWxlcy54bWxQSwUGAAAAAAMAAwC9AAAA3gIAAAAA'

const snapshot = process.argv[3] === 'snapshot'
const provider = snapshot ? 'format-snapshot' : process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'
const model = snapshot ? 'format-snapshot' : process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash'
class FormatAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('缺少模板格式输入')
    const input = JSON.parse(block.text) as { fields: Array<{ position: number; label: string }>; candidates: Array<[number, string]> }
    const field = (label: string): number => {
      const selected = input.fields.find(item => item.label === label)
      if (selected === undefined) throw new Error('缺少模板字段：' + label)
      return selected.position
    }
    const evidence = '正文使用宋体，字号15磅，行距固定20磅'
    const response = { rules: [
      { field_position: field('正文中文字体'), value: '宋体', evidence },
      { field_position: field('正文字号（磅）'), value: 15, evidence },
      { field_position: field('正文行距类型'), value: 'exact', evidence },
      { field_position: field('正文行距（倍数或磅）'), value: 20, evidence },
    ], mapping: { body: input.candidates.find(([, name]) => name === 'Normal')?.[0] } }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(response) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = await boot('bid-word-format-e2e', process.argv[2]!)
try {
  if (snapshot) ctx.effect(() => ctx.llm.registerAdapter([provider], new FormatAdapter()))
  const workspace = new BidWorkspace(process.cwd())
  await seedProjectArtifacts(workspace)
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
  const ready = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => { if (session.id === 'word-format' && event.type === 'bid.project.resumed') ready.resolve(undefined) }, { global: true })
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('word-format'), agentOptions: { provider, model }, meta: { cwd: process.cwd(), agentPreset: 'bid' } })
  await ready.promise
  off()
  const host = ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }
  await Promise.all([...host.inFlight.values()].map(operation => operation.done))
  const session = handle.agent.session
  session.append('request/header', { header: { config: { provider, model } }, reason: 'initial' })
  const bytes = Buffer.from(TEMPLATE, 'base64')
  const extracted = await saveDocxTemplate(workspace, { revision: 0, name: '格式说明.docx', bytes })
  if (extracted.templateId === null) throw new Error('模板上传未返回模板 ID。')
  const chapter = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const original = await readFile(chapter, 'utf8')
  const suggestion = await ctx.bid.suggestDocxFormat(session, extracted.templateId)
  const unchanged = await ctx.bid.getDocxFormat(session, extracted.templateId)
  const event = session.events.findLast(event => event.type === 'bid.word-format.request')
  if (event?.type !== 'bid.word-format.request') throw new Error('模板模型输入没有会话记录')
  const input = event.data.messages[0]?.content[0]
  if (input?.type !== 'text') throw new Error('模板模型输入不是文本')
  const protocol = JSON.parse(input.text) as { fields: Array<{ position: number; key?: string }>
    candidateColumns: string[]
    candidates: unknown[][] }
  process.stdout.write(`${JSON.stringify({ suggestion,
    extractedText: extracted.state.extracted.paragraphs,
    configuredSize: unchanged.values['body.size'],
    chapterUnchanged: original === await readFile(chapter, 'utf8'),
    loggedRequest: true,
    modelProtocol: { system: event.data.system,
      candidateColumns: protocol.candidateColumns,
      fieldPositions: protocol.fields.every((field, index) => field.position === index && field.key === undefined),
      candidatePositions: protocol.candidates.every((candidate, index) => candidate[0] === index) },
  })}\n`)
} finally { await ctx.fiber.dispose() }
