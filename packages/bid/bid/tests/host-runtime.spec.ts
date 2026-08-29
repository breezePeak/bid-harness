import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

async function writeTenderAnalysisArtifacts(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const manifest = JSON.parse(await readFile(workspace.manifestPath, 'utf8')) as Bid.BidManifest
  const tenderFiles = manifest.files.filter(file => file.role === 'tender' && file.parseStatus === 'success')
  const refs = await Promise.all(tenderFiles.map(async (file) => {
    const index = JSON.parse(await readFile(join(workspace.sessionRoot, file.chunkIndexPath!), 'utf8')) as {
      chunks: Array<{ path: string }>
    }
    const chunk = index.chunks[0]!
    return {
      file_id: file.id,
      chunk: `${file.chunksPath!}/${chunk.path}`,
      line_start: 1,
      line_end: 1,
    }
  }))
  const firstRef = refs[0]!
  const documents = {
    'project.json': {
      schema_version: 1,
      project_name: '测试项目',
      tender_name: '测试招标',
      purchaser: null,
      owner: null,
      project_scope: ['按期交付'],
      technical_scope: [],
      delivery_scope: ['按期交付'],
      source_refs: refs,
      analyzed_tender_files: tenderFiles.map(file => file.id),
    },
    'requirements.json': {
      schema_version: 1,
      requirements: [{
        id: 'REQ-1',
        category: 'delivery',
        raw_text: '按期交付。',
        normalized_requirement: '按期交付',
        mandatory: true,
        source_refs: [firstRef],
      }],
    },
    'scoring.json': {
      schema_version: 1,
      scoring_items: [{
        id: 'SCORE-1',
        parent: null,
        group: null,
        title: '交付能力',
        raw_text: '按期交付。',
        criterion: '满足交付期限',
        score: null,
        score_range: null,
        must_answer: true,
        source_refs: [firstRef],
      }],
    },
    'compliance.json': {
      schema_version: 1,
      compliance_items: [{
        id: 'COMP-1',
        type: 'delivery',
        raw_text: '按期交付。',
        normalized_rule: '必须按期交付',
        severity: 'mandatory',
        source_refs: [firstRef],
      }],
    },
  }
  const analysisRoot = join(workspace.sessionRoot, 'analysis')
  await mkdir(analysisRoot, { recursive: true })
  await Promise.all(Object.entries(documents).map(([name, document]) =>
    writeFile(join(analysisRoot, name), `${JSON.stringify(document, null, 2)}\n`, 'utf8')))
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
  let analysisPending = false
  followup.mockImplementation(() => {
    analysisPending = true
  })
  const restrict = vi.fn(() => vi.fn())
  const guard = vi.fn(() => vi.fn())
  Object.defineProperty(ctx, 'tools', { value: { restrict, guard }, configurable: true })
  const whenIdle = vi.fn(async () => {
    if (!analysisPending || agentPreset !== 'bid') return
    analysisPending = false
    await writeTenderAnalysisArtifacts(cwd, session.id)
  })
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    followup,
    steer,
    whenIdle,
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

  it('imports a real batch, runs S2, and stops before S3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')

    const result = await ctx.bid.uploadFiles(agent.session, [{
      name: '招标要求.md',
      role: 'tender',
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])

    expect(result).toEqual({ ok: true, value: { stage: 'evidence_mapping', status: 'pending' } })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.started',
      'bid.stage.completed',
    ])
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'evidence_mapping', status: 'pending' })
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
    await expect(readFile(join(workspace.sessionRoot, 'analysis/project.json'), 'utf8'))
      .resolves.toContain('"analyzed_tender_files"')
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

    await expect(ctx.bid.uploadFiles(standard, [{ name: 'x.txt', role: 'tender', size: 1, data: one.toString('base64') }]))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_SESSION_REQUIRED' } })
    for (const [file, code] of [
      [{ name: '../x.txt', role: 'tender', size: 1, data: one.toString('base64') }, 'BID_FILE_NAME_INVALID'],
      [{ name: 'x.exe', role: 'tender', size: 1, data: one.toString('base64') }, 'BID_FILE_TYPE_UNSUPPORTED'],
      [{ name: 'x.txt', role: 'tender', size: 5, data: one.toString('base64') }, 'BID_FILE_SIZE_LIMIT'],
      [{ name: 'x.txt', role: 'tender', size: 1, data: 'not-base64' }, 'BID_FILE_INTAKE_FAILED'],
    ] as const) {
      await expect(ctx.bid.uploadFiles(bid, [file])).resolves.toMatchObject({ ok: false, error: { code } })
      expect(bid.events).toHaveLength(0)
    }
    await expect(ctx.bid.uploadFiles(bid, [
      { name: 'first.txt', role: 'tender', size: 1, data: one.toString('base64') },
      { name: 'second.txt', role: 'tender', size: 1, data: one.toString('base64') },
    ])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_COUNT_LIMIT' } })
    expect(bid.events).toHaveLength(0)

    const success = await ctx.bid.uploadFiles(bid, [{ name: 'x.txt', role: 'tender', size: 1, data: one.toString('base64') }])
    expect(success.ok).toBe(true)
    await expect(ctx.bid.uploadFiles(bid, [{ name: 'y.txt', role: 'tender', size: 1, data: one.toString('base64') }]))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_NOT_ALLOWED' } })
    expect(bid.events).toHaveLength(4)
  })

  it('rejects only concurrent work for the same Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const first = attach(ctx, 'bid', root).agent.session
    const second = attach(ctx, 'bid', root).agent.session
    const bytes = Buffer.from('并发导入', 'utf8')
    const files = [{ name: '要求.txt', role: 'tender' as const, size: bytes.byteLength, data: bytes.toString('base64') }]

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
      { name: '有效但同批.txt', role: 'tender', size: valid.byteLength, data: valid.toString('base64') },
      { name: '损坏.txt', role: 'tender', size: 1, data: Buffer.from([0xff]).toString('base64') },
    ])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(Bid.getBidClientProjection(session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE)))
      .toMatchObject({ runtime: { stage: 'file_intake', status: 'failed' }, allowedActions: ['upload_files'] })

    const replacement = Buffer.from('有效内容', 'utf8')
    await expect(ctx.bid.uploadFiles(session, [{
      name: '有效.txt',
      role: 'tender',
      size: replacement.byteLength,
      data: replacement.toString('base64'),
    }])).resolves.toEqual({ ok: true, value: { stage: 'evidence_mapping', status: 'pending' } })
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.failed',
      'bid.stage.started',
      'bid.stage.completed',
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
      role: 'tender',
      mediaType: 'application/pdf',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toMatchObject({ stage: 'file_intake', status: 'failed' })
  })
})
