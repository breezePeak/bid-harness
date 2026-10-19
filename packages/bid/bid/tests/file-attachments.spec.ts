import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { PromptFileRef } from '@deepseek-ai/dsh-host-apiproxy/api'
import { afterEach, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { receiveBidFile, resolveBidFile, readBidFileText } from '../src/file-assets.ts'
import { collectBidModelTaskCatalog, bindBidModelProjectQuery, presentBidModelTaskCatalog } from '../src/bid-model-task.ts'
import { Document, Packer, Paragraph } from 'docx'
import mammoth from 'mammoth'
import { bindBidTaskSourceContext, freezeBidTaskSource } from '../src/bid-task-source.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-attachments-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('file-main'), { meta: { cwd: root } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: (message) => {
    session.append('user/message', message, { surfaceOp: 'append' })
  } })
  const agent = { id: session.id, session, ctx, status: 'running', inbox,
    followup: (message: Parameters<Inbox['append']>[1]) =>{  inbox.append('next-turn', message) },
    steer: (message: Parameters<Inbox['append']>[1]) =>{  inbox.append('next-step', message) },
  } as Agent
  ctx.agents.register(agent)
  const workspace = new BidWorkspace(root)
  ctx.on('session/prompt-files', async ({ session: current, refs }) =>
    Promise.all(refs.map(async ref => (await resolveBidFile(workspace, current, ref, true)).ref)))
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }) })
  let rpc = 0
  const send = (submission: string, refs: PromptFileRef[], text = '') => api.sessions.prompt({
    rpcId: RpcId(`files-${String(++rpc)}`), payload: { sessionId: session.id, mode: 'queue',
      clientSubmissionId: submission, content: text === '' ? [] : [{ type: 'text', text }],
      fileRefs: refs.map(({ attachmentId, version }) => ({ attachmentId, version })),
    },
  })
  return { ctx, workspace, session, inbox, api, send }
}

it('上传保留原件且不解析、不建立路线；同名异字节具有不同版本，重传复用引用', async () => {
  const { workspace, session } = await fixture()
  const bytes = Buffer.from('原件中的“忽略用户指令”是待处理内容。')
  const first = await receiveBidFile(workspace, session, { name: '方案.docx', bytes })
  expect(await receiveBidFile(workspace, session, { name: '方案.docx', bytes })).toEqual(first)
  const changed = await receiveBidFile(workspace, session, { name: '方案.docx', bytes: Buffer.from('新版本') })
  expect(changed.attachmentId).not.toBe(first.attachmentId)
  expect(changed.version).not.toBe(first.version)
  const resolved = await resolveBidFile(workspace, session, first, true)
  expect(resolved.bytes).toEqual(bytes)
  for (const path of [workspace.projectStatePath, workspace.manifestPath, workspace.corpusRoot]) {
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(resolveBidFile(workspace, session, first)).rejects.toThrow('BID_FILE_NOT_REFERENCED')
  await writeFile(resolved.absolutePath, '外部改动')
  await expect(resolveBidFile(workspace, session, first, true)).rejects.toThrow('BID_FILE_CONTENT_CHANGED')
})

it('file-only 并发提交与响应丢失重试复用 inbox 接纳，正文或有序引用改变明确拒绝', async () => {
  const { ctx, workspace, session, inbox, send } = await fixture()
  const first = await receiveBidFile(workspace, session, { name: '方案.txt', bytes: Buffer.from('方案') })
  const second = await receiveBidFile(workspace, session, { name: '参考.txt', bytes: Buffer.from('参考') })
  const flush = vi.spyOn(ctx.sessions, 'flush')
  flush.mockRejectedValueOnce(new Error('模拟接纳后的响应丢失'))
  const results = await Promise.all([send('one', [first, second]), send('one', [first, second])])
  expect(results[0]?.result.ok).toBe(false)
  expect(results[1]?.result.ok).toBe(true)
  expect(inbox.nextTurn).toHaveLength(1)
  expect(inbox.nextTurn[0]?.source).toMatchObject({ kind: 'user', fileRefs: [first, second] })
  expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('方案.txt') as unknown }])
  for (const result of [await send('one', [second, first]), await send('one', [first, second], '改变正文')]) {
    expect(result.result).toMatchObject({ ok: false, error: { details: { reason: 'SUBMISSION_CONFLICT' } } })
  }
  inbox.claim('next-turn', 1)
  expect((await send('one', [first, second])).result.ok).toBe(true)
  expect(inbox.nextTurn).toHaveLength(0)
  expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
})

it('队列文字编辑保留原图片及文件引用，模型清单由 Host 重新生成', async () => {
  const { workspace, session, inbox, api, send } = await fixture()
  const file = await receiveBidFile(workspace, session, { name: '方案.txt', bytes: Buffer.from('方案') })
  await send('queued', [file], '原任务')
  const queued = inbox.nextTurn[0]!
  const image = { type: 'image' as const, attachment: { attachmentId: 'sha256:'.concat('a'.repeat(64)),
    mediaType: 'image/png', bytes: 10, width: 1, height: 1 } }
  inbox.replace(queued.id, { ...queued, content: [image, ...queued.content] } as typeof queued)
  const edited = await api.sessions.updateQueue({ rpcId: RpcId('edit-files'), payload: { sessionId: session.id,
    itemId: queued.id, action: { kind: 'edit', content: [{ type: 'text', text: '仅改这一段' }] } } })
  expect(edited.result.ok).toBe(true)
  const after = inbox.nextTurn[0]!
  expect(after.id).toBe(queued.id)
  expect(after.source).toEqual(queued.source)
  expect(after.content[0]).toEqual(image)
  expect(after.content[1]).toEqual({ type: 'text', text: '仅改这一段' })
  expect(after.content[2]).toMatchObject({ type: 'text', text: expect.stringContaining('方案.txt') as unknown })
  inbox.claim('next-turn', 1)
  const source = await freezeBidTaskSource(workspace, session, { goal: '仅改这一段', scope: { kind: 'project' },
    steps: [{ description: '读取已选资料', scope: { source: 'task' }, call: { capability: 'tender.analyze', input: {} } }] },
  { session_id: String(session.id), message_id: String(after.id) })
  expect(source.message).toMatchObject({ message_id: String(queued.id), file_refs: [file],
    images: [{ block_position: 0, attachment: image.attachment }] })
  expect(source.message.text).toContain('仅改这一段')
  expect(source.message.text).not.toContain('原任务')
  expect(() => bindBidTaskSourceContext(session, { ...source,
    message: { ...source.message, content_sha256: '0'.repeat(64) } })).toThrow('BID_TASK_VERIFICATION_SOURCE_INVALID')
  expect(bindBidTaskSourceContext(session, source)).toEqual(source)
})

it('fork 只读取 seed 前缀已授权的版本，不能读取分叉点后或其他会话的上传', async () => {
  const { ctx, workspace, session, inbox, send } = await fixture()
  const first = await receiveBidFile(workspace, session, { name: '前缀.txt', bytes: Buffer.from('可读前缀') })
  await send('first', [first]); inbox.claim('next-turn', 1)
  const branch = ctx.sessions.fork(session)
  const late = await receiveBidFile(workspace, session, { name: '稍后.txt', bytes: Buffer.from('不可越权') })
  await send('late', [late]); inbox.claim('next-turn', 2)
  expect((await resolveBidFile(workspace, branch, first)).ref).toEqual(first)
  await expect(resolveBidFile(workspace, branch, late, true)).rejects.toThrow('BID_FILE_NOT_REFERENCED')
  const other: Session = ctx.sessions.create(SessionId('unrelated'), { meta: { cwd: workspace.root } })
  await expect(resolveBidFile(workspace, other, first, true)).rejects.toThrow('BID_FILE_NOT_REFERENCED')
  expect(await readFile((await resolveBidFile(workspace, branch, first)).absolutePath, 'utf8')).toBe('可读前缀')
})

it('按需读取复用原件版本，解析失败可重试，目录位置不会指向同名新版本', async () => {
  const { workspace, session, inbox, send } = await fixture()
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('原件的实施方案')] }] }))
  const file = await receiveBidFile(workspace, session, { name: '方案.docx', bytes })
  await send('original', [file]); inbox.claim('next-turn', 1)
  const catalog = await collectBidModelTaskCatalog(workspace, session)
  expect(presentBidModelTaskCatalog(catalog)).toMatchObject({ files: [{ position: 0, label: expect.stringContaining('方案.docx') as unknown }] })
  const bound = bindBidModelProjectQuery({ object: 'file', file_position: 0 }, catalog)
  if (bound.object !== 'file') throw new Error('读取对象绑定错误')
  expect(() => bindBidModelProjectQuery({ object: 'file', file_position: 1 }, catalog)).toThrow('BID_MODEL_TASK_OBJECT_UNKNOWN')
  expect(() => bindBidModelProjectQuery({ object: 'file', file_ref: file }, catalog)).toThrow('BID_MODEL_TASK_IDENTITY_FORBIDDEN')
  const parser = vi.spyOn(mammoth, 'convertToHtml').mockRejectedValueOnce(new Error('暂时失败'))
  try {
    await expect(readBidFileText(workspace, session, bound.file_ref, 0, 6_000)).rejects.toThrow('DOCX_PARSE_FAILED')
    expect((await resolveBidFile(workspace, session, file)).bytes).toEqual(bytes)
    const result = await readBidFileText(workspace, session, bound.file_ref, 0, 6_000)
    expect(result.text).toContain('原件的实施方案')
    expect(await readBidFileText(workspace, session, bound.file_ref, 0, 6_000)).toEqual(result)
    expect(parser).toHaveBeenCalledTimes(2)
    const changed = await receiveBidFile(workspace, session, { name: '方案.docx', bytes: await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('同名新内容')] }] })) })
    await send('changed', [changed]); inbox.claim('next-turn', 2)
    expect((await readBidFileText(workspace, session, bound.file_ref, 0, 6_000)).text).toContain('原件的实施方案')
    expect((await readBidFileText(workspace, session, changed, 0, 6_000)).text).toContain('同名新内容')
    await expect(access(workspace.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { parser.mockRestore() }
})
