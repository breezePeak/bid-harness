import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import BidHostRuntime, * as Bid from '@deepseek-ai/dsh-bid'

let nextRpc = 1
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

class TestFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  resolve(path: string): Promise<{ targetKey: string; displayPath: string }> {
    return Promise.resolve({ targetKey: path, displayPath: path })
  }
}

class TestTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  restrict(): () => void {
    return () => {}
  }

  guard(): () => void {
    return () => {}
  }

  schemas(): Array<{ name: string }> {
    return ['grep', 'read', 'write', 'web_search', 'web_fetch'].map(name => ({ name }))
  }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`bid-host-${String(nextRpc++)}`), payload }
}

async function harness(config?: Bid.Config): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TestFileSystem)
  await ctx.plugin(TestTools)
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
    const chunkPath = join(workspace.sessionRoot, file.chunksPath!, chunk.path)
    const lineCount = (await readFile(chunkPath, 'utf8')).split('\n').length
    return {
      file_id: file.id,
      chunk: `${file.chunksPath!}/${chunk.path}`,
      line_start: 1,
      line_end: lineCount,
    }
  }))
  const firstRef = refs[0]!
  const sourceText = (await readFile(join(workspace.sessionRoot, firstRef.chunk), 'utf8')).trim()
  const documents = {
    'project.json': {
      schema_version: 1,
      project_name: '测试项目',
      tender_name: '测试招标',
      purchaser: null,
      owner: null,
      project_background: ['项目需要按期交付'],
      project_objectives: ['完成技术交付'],
      project_scope: ['按期交付'],
      technical_scope: [],
      delivery_scope: ['按期交付'],
      implementation_constraints: ['交付期限'],
      key_technical_points: ['交付保障'],
      source_refs: refs,
      analyzed_tender_files: tenderFiles.map(file => file.id),
    },
    'requirements.json': {
      schema_version: 1,
      requirements: [{
        id: 'REQ-1',
        category: 'delivery',
        raw_text: sourceText,
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
        raw_text: sourceText,
        criterion: '满足交付期限',
        score: null,
        score_range: null,
        must_answer: true,
        response_points: ['说明交付计划和保障措施'],
        source_refs: [firstRef],
      }],
    },
    'compliance.json': {
      schema_version: 1,
      compliance_items: [{
        id: 'COMP-1',
        type: 'delivery',
        raw_text: sourceText,
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

async function writeEvidenceMappingArtifact(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const manifest = await workspace.readManifest()
  const [requirements, scoring] = await Promise.all([
    readFile(join(workspace.sessionRoot, 'analysis/requirements.json'), 'utf8').then(JSON.parse) as Promise<{ requirements: Array<{ id: string }> }>,
    readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8').then(JSON.parse) as Promise<{ scoring_items: Array<{ id: string }> }>,
  ])
  const reference = manifest.files.find(file => file.role === 'reference' && file.parseStatus === 'success')
  let materials: unknown[] = []
  if (reference !== undefined && reference.chunksPath !== null && reference.chunkIndexPath !== null) {
    const index = JSON.parse(await readFile(join(workspace.sessionRoot, reference.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
    const chunk = `${reference.chunksPath}/${index.chunks[0]!.path}`
    const lines = (await readFile(join(workspace.sessionRoot, chunk), 'utf8')).split('\n').length
    materials = [{ file_id: reference.id, chunk, line_start: 1, line_end: lines, usage: 'adapt', summary: '可复用技术资料。' }]
  }
  const missing_topics = materials.length === 0 ? ['缺少可复用的本地技术资料。'] : []
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), `${JSON.stringify({
    schema_version: 2,
    requirement_mappings: requirements.requirements.map(item => ({
      requirement_id: item.id,
      materials,
      external_materials: [],
      missing_topics,
    })),
    scoring_mappings: scoring.scoring_items.map(item => ({
      scoring_id: item.id,
      materials,
      external_materials: [],
      missing_topics,
    })),
  }, null, 2)}\n`, 'utf8')
}

async function writeOutlineArtifact(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'outline/outline.json'), `${JSON.stringify({
    schema_version: 1, scope: 'technical_bid', document_title: '测试项目技术投标文件', global_compliance_ids: ['COMP-1'], sections: [{
      id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付要求。', writable: true,
      must_answer: ['说明交付计划和保障措施。'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
    }],
  }, null, 2)}\n`, 'utf8')
}

async function writeOutlineQualityReport(cwd: string, sessionId: string, sectionIds: readonly string[] = ['SEC-1']): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), `${JSON.stringify({
    schema_version: 1,
    scope: 'technical_bid',
    checked_requirement_ids: ['REQ-1'],
    checked_scoring_ids: ['SCORE-1'],
    reviewed_section_ids: sectionIds,
    issues: [],
  }, null, 2)}\n`, 'utf8')
}

async function writeChapterArtifact(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'chapters/meta'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), '交付计划覆盖项目阶段和保障措施。\n', 'utf8')
  await writeFile(join(workspace.sessionRoot, 'chapters/meta/0001.json'), `${JSON.stringify({
    section_id: 'SEC-1', covered_must_answer: ['说明交付计划和保障措施。'], evidence_used: [], additional_materials: [], unresolved_topics: [],
  }, null, 2)}\n`, 'utf8')
}

function promptText(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
}

function attach(
  ctx: Context,
  agentPreset?: string,
  cwd = '/workspace',
  analysisWriter?: (cwd: string, sessionId: string, attempt: number, prompt: string) => Promise<void>,
): {
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
  let analysisAttempt = 0
  let currentPrompt = ''
  followup.mockImplementation((message: unknown) => {
    analysisPending = true
    currentPrompt = promptText(message)
  })
  const whenIdle = vi.fn(async () => {
    if (!analysisPending || agentPreset !== 'bid') return
    analysisPending = false
    const prompt = currentPrompt
    currentPrompt = ''
    if (analysisWriter === undefined) {
      if (prompt.includes('当前阶段：tender_analysis / Coverage Audit')) {
        await writeTenderAnalysisArtifacts(cwd, session.id)
        return
      } else if (prompt.includes('当前阶段：outline_generation / Blueprint Quality Review')) {
        await writeOutlineQualityReport(cwd, session.id)
        return
      } else if (analysisAttempt === 0) await writeTenderAnalysisArtifacts(cwd, session.id)
      else if (analysisAttempt === 1) await writeEvidenceMappingArtifact(cwd, session.id)
      else if (analysisAttempt === 2) await writeOutlineArtifact(cwd, session.id)
      else await writeChapterArtifact(cwd, session.id)
      analysisAttempt++
    } else {
      await analysisWriter(cwd, session.id, analysisAttempt++, prompt)
    }
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

  it('waits after S2, persists user edits, then runs through S4', async () => {
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
    }, {
      name: '技术资料.md',
      role: 'reference',
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])

    expect(result).toEqual({ ok: true, value: { stage: 'tender_analysis', status: 'waiting_user' } })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.started',
      'bid.user_confirmation.required',
    ])
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    expect(agent.session.events.some(event => event.type === 'bid.stage.completed' && event.data.stage === 'tender_analysis')).toBe(false)
    const analysis = await ctx.bid.getTenderAnalysisForConfirmation(agent.session)
    const scoringId = analysis.scoring.scoring_items[0]!.id
    await expect(ctx.bid.confirmTenderAnalysis(agent.session, [
      { type: 'update_project', fields: { key_technical_points: ['重点说明按期交付保障'] } },
      { type: 'update_scoring_item', scoring_id: scoringId, criterion: '重点评价交付保障', response_points: ['交付计划', '进度保障'] },
    ])).resolves.toEqual({ ok: true, value: { stage: 'outline_confirmation', status: 'waiting_user' } })
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'outline_confirmation', status: 'waiting_user' })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    const manifest = JSON.parse(await readFile(workspace.manifestPath, 'utf8')) as Bid.BidManifest
    expect(manifest.files[0]).toMatchObject({
      originalName: '招标要求.md',
      parseStatus: 'success',
      inputPath: 'input/招标要求.md',
      documentPath: 'corpus/招标要求.md/document.md',
      chunkIndexPath: 'corpus/招标要求.md/chunks/index.json',
    })
    await expect(readFile(join(workspace.sessionRoot, manifest.files[0]!.chunkIndexPath!), 'utf8'))
      .resolves.toContain('"schema_version": 1')
    await expect(readFile(join(workspace.sessionRoot, 'analysis/project.json'), 'utf8'))
      .resolves.toContain('重点说明按期交付保障')
    await expect(readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8'))
      .resolves.toContain('进度保障')
    await expect(readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8'))
      .resolves.toContain('"requirement_mappings"')
    await expect(readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8'))
      .resolves.toContain('"must_answer"')
  })

  it('drives a restored tender-analysis stage through agent/session-start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    await workspace.import([{ name: '招标要求.md', role: 'tender', type: 'text/markdown', bytes }])
    agent.session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    agent.session.append('bid.stage.completed', {
      stage: 'file_intake',
      status: 'completed',
      artifacts: [{ stage: 'file_intake', type: 'manifest', path: 'manifest.json' }],
    })

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })

    await vi.waitFor(() => {
      expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
        .toEqual({ stage: 'tender_analysis', status: 'waiting_user' })
    })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.started',
      'bid.user_confirmation.required',
    ])
  })

  it('drives a restored executable stage through the same session-start entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    for (const stage of ['file_intake', 'tender_analysis'] as const) {
      agent.session.append('bid.stage.started', { stage, status: 'running' })
      agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    const runtime = ctx.bid as unknown as {
      automaticOrchestrator(agent: Agent, workspace: Bid.BidWorkspace): Bid.BidOrchestrator
    }
    const execute = vi.fn(async (task: Bid.BidStageTask): Promise<Bid.StageArtifact[]> =>
      task.requiredArtifacts.map(path => ({ stage: task.stage, type: path, path })))
    vi.spyOn(runtime, 'automaticOrchestrator').mockImplementation(currentAgent => new Bid.BidOrchestrator(
      currentAgent.session,
      { canExecute: stage => stage === 'evidence_mapping', execute },
      { validate: async () => ({ ok: true }) },
    ))

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })

    await vi.waitFor(() => {
      expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
        .toEqual({ stage: 'outline_generation', status: 'pending' })
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0].stage).toBe('evidence_mapping')
  })

  it('returns an S2 failure as runtime state and drives the generic retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    let tenderRuns = 0
    const writer = async (cwd: string, sessionId: string, _attempt: number, prompt: string): Promise<void> => {
      const workspace = new Bid.BidWorkspace(cwd, sessionId)
      if (prompt.includes('当前阶段：tender_analysis / Coverage Audit') || prompt.includes('当前阶段：outline_generation / Blueprint Quality Review')) return
      if (prompt.includes('当前阶段：evidence_mapping')) {
        await writeEvidenceMappingArtifact(cwd, sessionId)
        return
      }
      if (prompt.includes('当前阶段：outline_generation')) return
      if (tenderRuns > 0) {
        for (const name of ['project.json', 'requirements.json', 'scoring.json', 'compliance.json']) {
          await expect(readFile(join(workspace.sessionRoot, 'analysis', name), 'utf8'))
            .rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
      await writeTenderAnalysisArtifacts(cwd, sessionId)
      if (tenderRuns === 0) {
        await writeFile(
          join(workspace.sessionRoot, 'analysis/requirements.json'),
          '{ invalid json',
          'utf8',
        )
      }
      tenderRuns++
    }
    const { agent } = attach(ctx, 'bid', root, writer)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')
    const files = [{
      name: '招标要求.md',
      role: 'tender' as const,
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }]

    await expect(ctx.bid.uploadFiles(agent.session, files)).resolves.toEqual({
      ok: true,
      value: { stage: 'tender_analysis', status: 'failed', failureReason: expect.stringContaining('TENDER_ANALYSIS_ARTIFACT_INVALID') },
    })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
    ])
    expect(ctx.sessionProjections.snapshot(agent.session).values[Bid.BID_RUNTIME_PROJECTION_KEY])
      .toMatchObject({ runtime: { stage: 'tender_analysis', status: 'failed' }, allowedActions: ['retry_stage'] })

    await expect(ctx.bid.retryStage(agent.session)).resolves.toEqual({
      ok: true,
      value: { stage: 'tender_analysis', status: 'waiting_user' },
    })
    await expect(ctx.bid.confirmTenderAnalysis(agent.session, [])).resolves.toEqual({
      ok: true,
      value: {
        stage: 'outline_generation', status: 'failed',
        failureReason: expect.stringContaining('OUTLINE_GENERATION_INPUT_INVALID'),
      },
    })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
      'bid.stage.started', 'bid.user_confirmation.required',
      'bid.user_confirmation.received', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
    ])
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

  it('records a failed parse without blocking a valid file in the same batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const session = attach(ctx, 'bid', root).agent.session

    const valid = Buffer.from('先成功解析', 'utf8')
    const result = await ctx.bid.uploadFiles(session, [
      { name: '有效但同批.txt', role: 'tender', size: valid.byteLength, data: valid.toString('base64') },
      { name: '损坏.txt', role: 'tender', size: 1, data: Buffer.from([0xff]).toString('base64') },
    ])
    expect(result).toMatchObject({ ok: true, value: { stage: 'tender_analysis', status: 'waiting_user' } })
    expect(result.ok && result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '损坏.txt', status: 'failed', error: expect.objectContaining({ code: 'BID_FILE_PARSE_FAILED' }) }),
      expect.objectContaining({ name: '有效但同批.txt', status: 'completed' }),
    ]))
    expect(session.events.map(event => event.type)).toEqual([
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.started',
      'bid.user_confirmation.required',
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

  it('persists a user-edited confirmed outline and advances S5 without replacing S4', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('技术标资料', 'utf8')
    await ctx.bid.uploadFiles(agent.session, [
      { name: '招标.txt', role: 'tender', size: bytes.byteLength, data: bytes.toString('base64') },
      { name: '参考.txt', role: 'reference', size: bytes.byteLength, data: bytes.toString('base64') },
    ])
    await ctx.bid.confirmTenderAnalysis(agent.session, [])
    const draft = await ctx.bid.getOutlineForConfirmation(agent.session)
    const result = await ctx.bid.confirmOutline(agent.session, [{ type: 'update_section', section_id: 'SEC-1', title: '已确认交付方案' }])
    expect(result).toEqual({ ok: true, value: { stage: 'book_review', status: 'pending' } })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    expect(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8'))).toEqual(draft)
    expect(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8')))
      .toMatchObject({ sections: [{ id: 'SEC-1', title: '已确认交付方案' }] })
    const confirmation = Bid.parseOutlineConfirmationArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmation.json'), 'utf8')))
    expect(confirmation).toMatchObject({ scope: 'technical_bid', decision: 'confirmed' })
    expect(confirmation.source_outline_sha256).toBe(Bid.outlineArtifactSha256(draft))
    expect(confirmation.confirmed_outline_sha256).toBe(Bid.outlineArtifactSha256(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8'))))
    expect(agent.session.events.find(event => event.type === 'bid.stage.completed' && event.data.stage === 'outline_confirmation'))
      .toMatchObject({ data: { artifacts: [
        { stage: 'outline_confirmation', type: 'confirmed_outline', path: 'outline/confirmed-outline.json' },
        { stage: 'outline_confirmation', type: 'outline_confirmation', path: 'outline/confirmation.json' },
      ] } })
    await expect(readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')).resolves.toContain('SEC-1')
  })

  it('keeps S5 waiting when deletion removes mandatory coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('技术标资料', 'utf8')
    await ctx.bid.uploadFiles(agent.session, [
      { name: '招标.txt', role: 'tender', size: bytes.byteLength, data: bytes.toString('base64') },
      { name: '参考.txt', role: 'reference', size: bytes.byteLength, data: bytes.toString('base64') },
    ])
    await ctx.bid.confirmTenderAnalysis(agent.session, [])
    await expect(ctx.bid.confirmOutline(agent.session, [{ type: 'delete_section', section_id: 'SEC-1' }]))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_INVALID_USER_OUTLINE' } })
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'outline_confirmation', status: 'waiting_user' })
  })
})
