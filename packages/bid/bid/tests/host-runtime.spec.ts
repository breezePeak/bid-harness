import { Buffer } from 'node:buffer'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import BidHostRuntime, * as Bid from '@deepseek-ai/dsh-bid'

let nextRpc = 1
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`bid-host-${String(nextRpc++)}`), payload }
}

async function harness(config?: Bid.Config): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime, config)
  return {
    ctx,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
      cwd: '/workspace',
    }),
  }
}

function attach(ctx: Context, agentPreset?: string, cwd = '/workspace'): {
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const session = ctx.sessions.create(undefined, {
    meta: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
  })
  const followup = vi.fn()
  const steer = vi.fn()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    followup,
    steer,
  } as unknown as Agent
  ctx.agents.register(agent)
  return { agent, followup, steer }
}

describe('Bid Host runtime composition', () => {
  it('registers bid.runtime and rejects direct Bid session prompts before dispatch', async () => {
    const { ctx, api } = await harness()
    const { agent, followup, steer } = attach(ctx, 'bid')

    expect(ctx.sessionProjections.snapshot(agent.session).values[Bid.BID_RUNTIME_PROJECTION_KEY]).toMatchObject({
      runtime: { stage: 'file_intake', status: 'pending' },
      allowedExtensions: Bid.DEFAULT_BID_CONFIG.allowedExtensions,
      maxFiles: Bid.DEFAULT_BID_CONFIG.maxFiles,
      maxFileBytes: Bid.DEFAULT_BID_CONFIG.maxFileBytes,
      maxTotalBytes: Bid.DEFAULT_BID_CONFIG.maxTotalBytes,
    })
    const response = await api.sessions.prompt(request({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'bypass the workflow' }],
    }))

    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'prompt-admission-rejected',
        message: 'Bid session prompt rejected by Host admission: bid.upload_required',
        details: { reason: 'bid.upload_required' },
      },
    })
    expect(followup).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    expect(agent.session.events).toHaveLength(0)
  })

  it('preserves the generic follow-up path for a standard session', async () => {
    const { ctx, api } = await harness()
    const { agent, followup, steer } = attach(ctx, 'standard')

    const response = await api.sessions.prompt(request({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'ordinary prompt' }],
    }))

    expect(response.result).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })

  it('imports a real batch through the dedicated Host action and stops before S2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')

    const result = await ctx.bid.uploadFiles(agent.session, [{
      name: '招标要求.md',
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])

    expect(result).toEqual({ ok: true, value: { stage: 'tender_analysis', status: 'pending' } })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
    ])
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'tender_analysis', status: 'pending' })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    const manifest = JSON.parse(await readFile(workspace.manifestPath, 'utf8')) as Bid.BidManifest
    expect(manifest.files).toMatchObject([{
      originalName: '招标要求.md',
      parseStatus: 'success',
      inputPath: 'input/招标要求.md',
      documentPath: 'corpus/招标要求.md/document.md',
      chunkIndexPath: 'corpus/招标要求.md/chunks/index.json',
    }])
    await expect(readFile(join(workspace.sessionRoot, manifest.files[0]!.chunkIndexPath!), 'utf8'))
      .resolves.toContain('"schema_version": 1')
  })

  it('rejects non-Bid, invalid, and no-longer-admitted batches before a stage starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness({
      allowedExtensions: ['.txt'],
      maxFiles: 1,
      maxFileBytes: 4,
      maxTotalBytes: 4,
    })
    const standard = attach(ctx, 'standard', root).agent.session
    const bid = attach(ctx, 'bid', root).agent.session
    const one = Buffer.from('x')

    await expect(ctx.bid.uploadFiles(standard, [{ name: 'x.txt', size: 1, data: one.toString('base64') }]))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_SESSION_REQUIRED' } })
    for (const [file, code] of [
      [{ name: '../x.txt', size: 1, data: one.toString('base64') }, 'BID_FILE_NAME_INVALID'],
      [{ name: 'x.exe', size: 1, data: one.toString('base64') }, 'BID_FILE_TYPE_UNSUPPORTED'],
      [{ name: 'x.txt', size: 5, data: one.toString('base64') }, 'BID_FILE_SIZE_LIMIT'],
      [{ name: 'x.txt', size: 1, data: 'not-base64' }, 'BID_FILE_INTAKE_FAILED'],
    ] as const) {
      await expect(ctx.bid.uploadFiles(bid, [file])).resolves.toMatchObject({ ok: false, error: { code } })
      expect(bid.events).toHaveLength(0)
    }
    await expect(ctx.bid.uploadFiles(bid, [
      { name: 'first.txt', size: 1, data: one.toString('base64') },
      { name: 'second.txt', size: 1, data: one.toString('base64') },
    ])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_COUNT_LIMIT' } })
    expect(bid.events).toHaveLength(0)

    const success = await ctx.bid.uploadFiles(bid, [{ name: 'x.txt', size: 1, data: one.toString('base64') }])
    expect(success.ok).toBe(true)
    await expect(ctx.bid.uploadFiles(bid, [{ name: 'y.txt', size: 1, data: one.toString('base64') }]))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_NOT_ALLOWED' } })
    expect(bid.events).toHaveLength(2)
  })

  it('rejects only concurrent work for the same Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const first = attach(ctx, 'bid', root).agent.session
    const second = attach(ctx, 'bid', root).agent.session
    const bytes = Buffer.from('并发导入', 'utf8')
    const files = [{ name: '要求.txt', size: bytes.byteLength, data: bytes.toString('base64') }]

    const firstRequest = ctx.bid.uploadFiles(first, files)
    await expect(ctx.bid.uploadFiles(first, files))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS' } })
    await expect(ctx.bid.uploadFiles(second, files)).resolves.toMatchObject({ ok: true })
    await expect(firstRequest).resolves.toMatchObject({ ok: true })
  })

  it('records a failed parse and accepts a clean replacement batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const session = attach(ctx, 'bid', root).agent.session

    const valid = Buffer.from('先成功解析', 'utf8')
    await expect(ctx.bid.uploadFiles(session, [
      { name: '有效但同批.txt', size: valid.byteLength, data: valid.toString('base64') },
      { name: '损坏.txt', size: 1, data: Buffer.from([0xff]).toString('base64') },
    ])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(Bid.getBidClientProjection(session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE)))
      .toMatchObject({ runtime: { stage: 'file_intake', status: 'failed' }, allowedActions: ['upload_files'] })

    const replacement = Buffer.from('有效内容', 'utf8')
    await expect(ctx.bid.uploadFiles(session, [{
      name: '有效.txt',
      size: replacement.byteLength,
      data: replacement.toString('base64'),
    }])).resolves.toEqual({ ok: true, value: { stage: 'tender_analysis', status: 'pending' } })
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.failed',
      'bid.stage.started',
      'bid.stage.completed',
    ])
  })

  it('fails needs-OCR intake without advancing to tender analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const session = attach(ctx, 'bid', root).agent.session
    const bytes = await readFile(fixture('scanned-document.pdf'))

    await expect(ctx.bid.uploadFiles(session, [{
      name: '扫描件.pdf',
      mediaType: 'application/pdf',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toMatchObject({ stage: 'file_intake', status: 'failed' })
  })
})
