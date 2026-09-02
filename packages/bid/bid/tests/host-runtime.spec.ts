import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type ContinuableStartSpec, type ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
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
  await ctx.plugin(SubagentRuntime)
  let child = 0
  let continuableChild = 0
  type ContinuableFixture = {
    child: Agent
    request: ContinuableStartSpec
    idle: Promise<void>
    resolveIdle: () => void
  }
  const continuableChildren = new Map<string, ContinuableFixture>()
  const mappingResult = (text: string): Record<string, unknown> => {
    const task = JSON.parse(text.split('\n').find(line => line.startsWith('Mapping Task：'))!.slice('Mapping Task：'.length)) as {
      task_id: string
      requirement_ids: string[]
      scoring_ids: string[]
    }
    const points = JSON.parse(text.split('\n').find(line => line.startsWith('相关 Response Points：'))!.slice('相关 Response Points：'.length)) as Array<{
      id: string
      scoring_id: string
      text: string
    }>
    const missing_topics = ['测试未提供补充资料。']
    return {
      task_id: task.task_id,
      requirement_mappings: task.requirement_ids.map(requirement_id => ({ requirement_id, materials: [], external_materials: [], missing_topics, writing_dimensions: ['技术响应'] })),
      scoring_mappings: task.scoring_ids.map(scoring_id => ({ scoring_id, materials: [], external_materials: [], missing_topics })),
      response_point_mappings: points.map(point => ({ response_point_id: point.id, scoring_id: point.scoring_id, response_point: point.text, materials: [], external_materials: [], missing_topics, writing_dimensions: ['技术响应'] })),
      research_topics: [],
      framework_mappings: [],
      reference_bid_mappings: [],
      findings: [],
      missing_topics,
    }
  }
  const settleContinuable = (fixture: ContinuableFixture): void => {
    const text = fixture.request.request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    ;(fixture.child.session.events as unknown[]).push({
      type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(mappingResult(text)) }] } },
      seq: fixture.child.session.events.length,
    })
    fixture.resolveIdle()
  }
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: (request: ResolvedSubagentStartRequest) => {
      const text = request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.includes('当前阶段：evidence_mapping / Mapping Subagent')) {
        const id = SessionId(`evidence-child-${++child}`)
        return Promise.resolve({
          id,
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed' as const,
            output: [],
            structured: mappingResult(text),
          }),
          dispose: () => Promise.resolve(),
        })
      }
      if (text.includes('你是独立 S6 Chapter Reviewer')) {
        const section = JSON.parse(text.split('\n').find(line => line.startsWith('Current Chapter Blueprint：'))!.slice('Current Chapter Blueprint：'.length)) as {
          id: string
          must_answer: string[]
          scoring_response_point_ids: string[]
          scoring_response_points: Array<{ scoring_id: string; response_point: string }>
        }
        const requirements = JSON.parse(text.split('\n').find(line => line.startsWith('Relevant Requirements：'))!.slice('Relevant Requirements：'.length)) as Array<{ id: string }>
        const compliance = JSON.parse(text.split('\n').find(line => line.startsWith('Relevant Compliance：'))!.slice('Relevant Compliance：'.length)) as Array<{ id: string }>
        const evidenceQuote = '本方案交付计划覆盖项目阶段和保障措施，确保按期完成技术交付。'
        const coverage = (item: string) => ({ item, status: 'covered' as const, evidence_quotes: [evidenceQuote], issue: null })
        return Promise.resolve({
          id: SessionId(`chapter-reviewer-${++child}`),
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed' as const,
            output: [],
            structured: {
              schema_version: 1,
              section_id: section.id,
              verdict: 'pass',
              must_answer_coverage: section.must_answer.map(coverage),
              requirement_coverage: requirements.map(item => ({ ...coverage(item.id), requirement_id: item.id })),
              response_point_coverage: section.scoring_response_points.map((item, index) => ({
                ...coverage(item.response_point), response_point_id: section.scoring_response_point_ids[index],
              })),
              compliance_coverage: compliance.map(item => ({ ...coverage(item.id), compliance_id: item.id })),
              source_mapping_review: [],
              claim_checks: [],
              quality_checks: {
                content_mode_respected: true,
                project_specific: true,
                structure_complete: true,
                legacy_project_pollution_free: true,
                placeholder_free: true,
                obvious_repetition_free: true,
              },
              blocking_issues: [],
            },
          }),
          dispose: () => Promise.resolve(),
        })
      }
      const blueprintLine = text.split('\n').find(line => line.startsWith('Current Chapter Blueprint：'))
      if (blueprintLine === undefined) throw new Error('missing chapter blueprint')
      const section = JSON.parse(blueprintLine.slice('Current Chapter Blueprint：'.length)) as {
        id: string
        must_answer: string[]
        scoring_response_point_ids: string[]
        scoring_response_points: Array<{ scoring_id: string; response_point: string }>
        source_mapping_ids: string[]
      }
      const id = SessionId(`chapter-child-${++child}`)
      return Promise.resolve({
        id,
        localAgent: undefined,
        result: Promise.resolve({
          stopReason: 'completed' as const,
          output: [],
          structured: {
            section_id: section.id,
            markdown: '本方案交付计划覆盖项目阶段和保障措施，确保按期完成技术交付。',
            metadata: {
              section_id: section.id,
              covered_must_answer: section.must_answer,
              covered_scoring_response_point_ids: section.scoring_response_point_ids,
              covered_scoring_response_points: section.scoring_response_points,
              assigned_source_mapping_ids: section.source_mapping_ids,
              source_mapping_usage: [],
              source_mapping_ids_used: [],
              evidence_used: [],
              additional_materials: [],
              external_evidence_used: [],
              additional_external_materials: [],
              unresolved_topics: [],
              handoff: {
                section_id: section.id,
                decisions: [],
                terminology: [],
                numbers_and_parameters: [],
                interfaces: [],
                deployment_constraints: [],
                cross_reference_targets: [],
                unresolved_topics: [],
              },
            },
          },
        }),
        dispose: () => Promise.resolve(),
      })
    },
    prepareContinuable: async () => ({}),
  })
  vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (request) => {
    const id = SessionId(`evidence-child-${++continuableChild}`)
    let resolveIdle!: () => void
    const fixture = {
      request,
      idle: new Promise<void>((resolve) => { resolveIdle = resolve }),
      resolveIdle,
      child: undefined as unknown as Agent,
    }
    fixture.child = {
      id,
      status: 'running',
      session: { id, header: { cwd: request.request.parent.session.header.cwd, parentSession: request.request.parent.id, origin: 'subagent' }, events: [] },
      whenIdle: () => fixture.idle,
    } as unknown as Agent
    continuableChildren.set(String(id), fixture)
    ctx.agents.register(fixture.child)
    queueMicrotask(() => settleContinuable(fixture))
    return { childId: id, messageId: `message-${id}` as never }
  })
  vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (_parent, childId) => {
    const fixture = continuableChildren.get(String(childId))
    if (fixture === undefined) throw new Error(`missing continuable fixture ${childId}`)
    fixture.idle = new Promise<void>((resolve) => { fixture.resolveIdle = resolve })
    queueMicrotask(() => settleContinuable(fixture))
    return `message-${childId}` as never
  })
  vi.spyOn(ctx.subagents, 'drainContinuableChildren').mockImplementation(async (_parent, childIds) => {
    for (const childId of childIds) continuableChildren.delete(String(childId))
  })
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
    readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8').then(JSON.parse) as Promise<{ scoring_items: Array<{ id: string; response_points: string[] }> }>,
  ])
  const reference = manifest.files.find(file => file.role === 'reference' && file.parseStatus === 'success')
  let materials: unknown[] = []
  if (reference !== undefined && reference.chunksPath !== null && reference.chunkIndexPath !== null) {
    const index = JSON.parse(await readFile(join(workspace.sessionRoot, reference.chunkIndexPath), 'utf8')) as { chunks: Array<{ id: string }> }
    materials = [{ file_id: reference.id, chunk: index.chunks[0]!.id, usage: 'adapt', summary: '可复用技术资料。' }]
  }
  const missing_topics = materials.length === 0 ? ['缺少可复用的本地技术资料。'] : []
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), `${JSON.stringify({
    schema_version: 6,
    source_strategy: { mode: 'generated_from_scratch', framework_file_id: null, reference_bid_file_ids: [] },
    framework_mappings: [],
    reference_bid_mappings: [],
    research_topics: [],
    requirement_mappings: requirements.requirements.map(item => ({
      requirement_id: item.id,
      materials,
      external_materials: [],
      missing_topics,
      writing_dimensions: ['技术响应'],
    })),
    response_point_mappings: scoring.scoring_items.flatMap((item, itemIndex) => item.response_points.map((response_point, pointIndex) => ({ response_point_id: `RP-${String(scoring.scoring_items.slice(0, itemIndex).reduce((count, previous) => count + previous.response_points.length, 0) + pointIndex + 1).padStart(6, '0')}`, scoring_id: item.id, response_point, materials, external_materials: [], missing_topics, writing_dimensions: ['技术响应'] }))),
    scoring_mappings: scoring.scoring_items.map(item => ({
      scoring_id: item.id,
      materials,
      external_materials: [],
      missing_topics,
    })),
  }, null, 2)}\n`, 'utf8')
}

async function writeEvidenceMappingPlan(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const [requirements, scoring, points, compliance] = await Promise.all([
    readFile(join(workspace.sessionRoot, 'analysis/requirements.json'), 'utf8').then(JSON.parse) as Promise<{ requirements: Array<{ id: string }> }>,
    readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8').then(JSON.parse) as Promise<{ scoring_items: Array<{ id: string }> }>,
    readFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), 'utf8').then(JSON.parse) as Promise<{ points: Array<{ id: string }> }>,
    readFile(join(workspace.sessionRoot, 'analysis/compliance.json'), 'utf8').then(JSON.parse) as Promise<{ compliance_items: Array<{ id: string }> }>,
  ])
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-plan.json'), `${JSON.stringify({
    schema_version: 1,
    global_analysis: ['按技术响应主题完成资料映射。'],
    source_strategy_notes: [],
    tasks: [{
      task_id: 'TASK-1',
      title: '技术响应',
      objective: '覆盖全部技术要求与评分响应点。',
      requirement_ids: requirements.requirements.map(item => item.id),
      scoring_ids: scoring.scoring_items.map(item => item.id),
      response_point_ids: points.points.map(item => item.id),
      compliance_ids: compliance.compliance_items.map(item => item.id),
      source_focus: [],
      research_topics: [],
    }],
  }, null, 2)}\n`, 'utf8')
}

async function writeOutlineArtifact(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const scoring = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8')) as { scoring_items: Array<{ id: string; response_points: string[] }> }
  const scoring_response_points = scoring.scoring_items.flatMap(item =>
    item.response_points.map(response_point => ({ scoring_id: item.id, response_point })))
  const scoring_response_point_ids = scoring_response_points.map((_, index) => `RP-${String(index + 1).padStart(6, '0')}`)
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'outline/outline.json'), `${JSON.stringify({
    schema_version: 2, scope: 'technical_bid', document_title: '测试项目技术投标文件', global_compliance_ids: ['COMP-1'], sections: [{
      id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '交付方案', purpose: '响应交付要求。', writable: true,
      must_answer: ['说明交付计划和保障措施。'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated', content_mode: 'write_new', source_mapping_ids: [], scoring_response_point_ids, scoring_response_points, suggested_tables: [], suggested_figures: [], writing_notes: [],
    }],
  }, null, 2)}\n`, 'utf8')
}

async function writeOutlineQualityReport(cwd: string, sessionId: string, sectionIds: readonly string[] = ['SEC-1']): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const scoring = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8')) as { scoring_items: Array<{ id: string; response_points: string[] }> }
  await writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), `${JSON.stringify({
    schema_version: 2,
    scope: 'technical_bid',
    checked_requirement_ids: ['REQ-1'],
    checked_scoring_ids: ['SCORE-1'],
    checked_source_mapping_ids: [],
    checked_scoring_response_point_ids: scoring.scoring_items.flatMap(item => item.response_points).map((_, index) => `RP-${String(index + 1).padStart(6, '0')}`),
    reviewed_section_ids: sectionIds,
    issues: [],
  }, null, 2)}\n`, 'utf8')
  try { await readFile(join(workspace.sessionRoot, 'outline/draft.json'), 'utf8'); await writeOutlineRegenerationChangeSet(cwd, sessionId) } catch { /* A normal S4 run has no S5 draft. */ }
}

async function writeOutlineRegenerationChangeSet(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const draft = JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/draft.json'), 'utf8')) as { revision: number; draft_outline_sha256: string }
  await mkdir(join(workspace.sessionRoot, 'outline/regeneration'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'outline/regeneration/change-set.json'), `${JSON.stringify({ schema_version: 1, base_revision: draft.revision, base_draft_sha256: draft.draft_outline_sha256, changes: [] }, null, 2)}\n`)
}

async function writeOutlineFromDraft(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const draft = JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/draft.json'), 'utf8')) as { outline: unknown }
  await writeFile(join(workspace.sessionRoot, 'outline/outline.json'), `${JSON.stringify(draft.outline, null, 2)}\n`)
}

async function writeChapterExecutionPlan(cwd: string, sessionId: string): Promise<void> {
  const workspace = new Bid.BidWorkspace(cwd, sessionId)
  const outline = Bid.parseConfirmedOutlineArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8')))
  await mkdir(join(workspace.sessionRoot, 'chapters'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'chapters/execution-plan.json'), `${JSON.stringify({
    schema_version: 2,
    scope: 'technical_bid',
    confirmed_outline_sha256: Bid.outlineArtifactSha256(outline),
    global_consistency_notes: ['统一项目名称和交付周期。'],
    sections: outline.sections.filter(section => section.writable).map(section => ({
      section_id: section.id,
      depends_on: [],
      related_sections: [],
      planning_notes: [],
    })),
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
  origin?: 'subagent',
): {
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const session = ctx.sessions.create(undefined, {
    meta: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }), ...(origin === undefined ? {} : { origin }) },
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
      } else if (prompt.includes('当前阶段：tender_analysis')) await writeTenderAnalysisArtifacts(cwd, session.id)
      else if (prompt.includes('evidence_mapping / Main-Agent Planning')) await writeEvidenceMappingPlan(cwd, session.id)
      else if (prompt.includes('evidence_mapping / Main-Agent Merge')) await writeEvidenceMappingArtifact(cwd, session.id)
      else if (prompt.includes('当前阶段：outline_generation')) await writeOutlineArtifact(cwd, session.id)
      else await writeChapterExecutionPlan(cwd, session.id)
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
    const { agent, followup } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')
    const referenceBytes = Buffer.from('# 参考资料\n\n项目实施经验。', 'utf8')

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
      size: referenceBytes.byteLength,
      data: referenceBytes.toString('base64'),
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
    const responsePointId = analysis.response_point_catalog.points[0]!.id
    await expect(ctx.bid.confirmTenderAnalysis(agent.session, [
      { type: 'update_project', fields: { key_technical_points: ['重点说明按期交付保障'] } },
      { type: 'update_scoring_item', scoring_id: scoringId, criterion: '重点评价交付保障' },
      { type: 'update_response_point', scoring_id: scoringId, response_point_id: responsePointId, text: '交付计划' },
      { type: 'add_response_point', scoring_id: scoringId, order: 2, text: '进度保障' },
    ])).resolves.toEqual({ ok: true, value: { stage: 'outline_confirmation', status: 'waiting_user' } })
    expect(followup.mock.calls.map(call => promptText(call[0])).find(prompt => prompt.includes('当前阶段：outline_generation')))
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

  it('fails an interrupted running stage through the session-start entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    for (const stage of ['file_intake', 'tender_analysis'] as const) {
      agent.session.append('bid.stage.started', { stage, status: 'running' })
      agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    agent.session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })

    await vi.waitFor(() => {
      expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
        .toEqual({
          stage: 'evidence_mapping',
          status: 'failed',
          failureReason: '阶段执行因后端停止而中断，请重试当前阶段。',
        })
    })
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'bid.stage.failed',
      data: { stage: 'evidence_mapping', status: 'failed' },
    })
  })

  it('resets only the exact current stage and re-enters its executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    for (const stage of ['file_intake', 'tender_analysis'] as const) {
      agent.session.append('bid.stage.started', { stage, status: 'running' })
      agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    agent.session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
    agent.session.append('bid.stage.failed', { stage: 'evidence_mapping', status: 'failed', reason: 'interrupted' })
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

    await expect(ctx.bid.resetStage(agent, 'outline_generation')).rejects.toMatchObject({
      code: 'BID_STAGE_RESET_NOT_ALLOWED',
    })
    await expect(ctx.bid.resetStage(agent, 'evidence_mapping')).resolves.toEqual({
      stage: 'outline_generation', status: 'pending',
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(agent.session.events.slice(-3).map(event => event.type)).toEqual([
      'bid.stage.reset', 'bid.stage.started', 'bid.stage.completed',
    ])
  })

  it('discards the S5 draft and partial confirmation before returning to confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    for (const stage of ['file_intake', 'tender_analysis', 'evidence_mapping', 'outline_generation'] as const) {
      agent.session.append('bid.stage.started', { stage, status: 'running' })
      agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    agent.session.append('bid.user_confirmation.required', {
      stage: 'outline_confirmation', status: 'waiting_user',
    })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
    const paths = ['draft.json', 'confirmed-outline.json', 'confirmation.json']
      .map(name => join(workspace.sessionRoot, 'outline', name))
    await Promise.all(paths.map(path => writeFile(path, '{}')))

    await expect(ctx.bid.resetStage(agent, 'outline_confirmation')).resolves.toEqual({
      stage: 'outline_confirmation', status: 'waiting_user',
    })
    for (const path of paths) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(agent.session.events.slice(-2).map(event => event.type)).toEqual([
      'bid.stage.reset', 'bid.user_confirmation.required',
    ])
  })

  it('returns only current S3 Mapping Task counts while evidence mapping runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-progress-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    for (const stage of ['file_intake', 'tender_analysis'] as const) {
      agent.session.append('bid.stage.started', { stage, status: 'running' })
      agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
    }
    agent.session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
    await writeFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), JSON.stringify({
      schema_version: 1,
      max_concurrency: 3,
      observed_max_concurrency: 2,
      tasks: [
        { task_id: 'MAP-01', status: 'completed', attempts: [], final_child_session_id: 'child-1' },
        { task_id: 'MAP-02', status: 'running', attempts: [], final_child_session_id: null },
        { task_id: 'MAP-03', status: 'pending', attempts: [], final_child_session_id: null },
      ],
    }))

    await expect(ctx.bid.getEvidenceMappingProgress(agent.session)).resolves.toEqual({
      total: 3,
      completed: 1,
      running: 1,
      not_started: 1,
      failed: 0,
    })
  })

  it('does not start the parent Bid workflow for a subagent-origin session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-child-'))
    const { ctx } = await harness()
    const { agent, followup } = attach(ctx, 'bid', root, undefined, 'subagent')

    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    await Promise.resolve()
    expect(followup).not.toHaveBeenCalled()
    expect(agent.session.events).toHaveLength(0)
  })

  it('repairs an invalid S2 Artifact once through the live Agent before waiting for confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    let tenderRuns = 0
    let repairRuns = 0
    const prompts: string[] = []
    const writer = async (cwd: string, sessionId: string, _attempt: number, prompt: string): Promise<void> => {
      prompts.push(prompt)
      const workspace = new Bid.BidWorkspace(cwd, sessionId)
      if (prompt.includes('当前阶段：tender_analysis / Coverage Audit') || prompt.includes('当前阶段：outline_generation / Blueprint Quality Review')) return
      if (prompt.includes('tender_analysis / Artifact Repair') && ++repairRuns === 1) return
      if (prompt.includes('evidence_mapping / Main-Agent Planning')) {
        await writeEvidenceMappingPlan(cwd, sessionId)
        return
      }
      if (prompt.includes('evidence_mapping / Main-Agent Merge')) {
        await writeEvidenceMappingArtifact(cwd, sessionId)
        return
      }
      if (prompt.includes('当前阶段：outline_generation')) return
      if (tenderRuns > 0 && !prompt.includes('tender_analysis / Artifact Repair')) {
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
      value: { stage: 'tender_analysis', status: 'waiting_user' },
    })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.user_confirmation.required',
    ])
    expect(prompts.filter(prompt => prompt.includes('tender_analysis / Artifact Repair'))).toHaveLength(2)
    expect(ctx.sessionProjections.snapshot(agent.session).values[Bid.BID_RUNTIME_PROJECTION_KEY])
      .toMatchObject({ runtime: { stage: 'tender_analysis', status: 'waiting_user' }, allowedActions: ['confirm_tender_analysis'] })
    await expect(ctx.bid.getTenderAnalysisForConfirmation(agent.session)).resolves.toMatchObject({
      project: { project_name: '测试项目' },
      scoring: { scoring_items: [{ response_points: ['说明交付计划和保障措施'] }] },
    })
    await expect(ctx.bid.confirmTenderAnalysis(agent.session, [])).resolves.toMatchObject({
      ok: true,
      value: {
        stage: 'outline_generation', status: 'failed',
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped.
        failureReason: expect.stringContaining('OUTLINE_GENERATION_INPUT_INVALID'),
      },
    })
    expect(agent.session.events.map(event => event.type)).toEqual([
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.user_confirmation.required',
      'bid.user_confirmation.received', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.completed',
      'bid.stage.started', 'bid.stage.failed',
    ])
  })

  it('projects final S2 issues when the single repair leaves an Artifact invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const prompts: string[] = []
    const writer = async (cwd: string, sessionId: string, _attempt: number, prompt: string): Promise<void> => {
      prompts.push(prompt)
      if (prompt.includes('tender_analysis / Coverage Audit') || prompt.includes('tender_analysis / Artifact Repair')) return
      await writeTenderAnalysisArtifacts(cwd, sessionId)
      const workspace = new Bid.BidWorkspace(cwd, sessionId)
      const scoringPath = join(workspace.sessionRoot, 'analysis/scoring.json')
      const scoring = JSON.parse(await readFile(scoringPath, 'utf8')) as { scoring_items: Array<Record<string, unknown>> }
      scoring.scoring_items[0]!.response_points = []
      await writeFile(scoringPath, `${JSON.stringify(scoring)}\n`, 'utf8')
    }
    const { agent } = attach(ctx, 'bid', root, writer)
    const bytes = Buffer.from('# 招标要求\n\n按期交付。', 'utf8')

    await expect(ctx.bid.uploadFiles(agent.session, [{
      name: '招标要求.md',
      role: 'tender',
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    }])).resolves.toEqual({
      ok: true,
      value: {
        stage: 'tender_analysis',
        status: 'failed',
        failureReason: '招标分析结果未通过校验。',
        failureIssues: [{
          code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
          artifact: 'analysis/scoring.json',
          path: 'scoring_items[0].response_points',
          message: '至少需要一项技术响应重点。',
        }],
      },
    })
    expect(prompts.filter(prompt => prompt.includes('tender_analysis / Artifact Repair'))).toHaveLength(3)
    expect(ctx.sessionProjections.snapshot(agent.session).values[Bid.BID_RUNTIME_PROJECTION_KEY])
      .toMatchObject({
        runtime: {
          stage: 'tender_analysis',
          status: 'failed',
          failureIssues: [{
            artifact: 'analysis/scoring.json',
            path: 'scoring_items[0].response_points',
            message: '至少需要一项技术响应重点。',
          }],
        },
        allowedActions: ['retry_stage'],
      })
  })

  it('rejects non-Bid, invalid, and no-longer-admitted batches before a stage starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness({
      allowedExtensions: ['.txt'],
      maxFiles: 1,
      maxFileBytes: 4,
      maxTotalBytes: 4,
      modelStageRepairAttempts: Bid.DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS,
      evidenceMappingMaxConcurrency: Bid.DEFAULT_EVIDENCE_MAPPING_MAX_CONCURRENCY,
      chapterWritingMaxConcurrency: Bid.DEFAULT_CHAPTER_WRITING_MAX_CONCURRENCY,
      trustedHosts: [],
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
      [{ name: 'x.txt', role: 'unknown' as never, size: 1, data: one.toString('base64') }, 'BID_FILE_ROLE_INVALID'],
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

  it('persists the complete tender and reference-bid batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const tender = Buffer.from('招标文件', 'utf8')
    const referenceBid = Buffer.from('旧参考标书', 'utf8')

    await expect(ctx.bid.uploadFiles(agent.session, [
      { name: 'tender.txt', role: 'tender', size: tender.byteLength, data: tender.toString('base64') },
      { name: 'reference-bid.txt', role: 'reference_bid', size: referenceBid.byteLength, data: referenceBid.toString('base64') },
    ])).resolves.toMatchObject({ ok: true })

    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    const manifest = JSON.parse(await readFile(workspace.manifestPath, 'utf8')) as Bid.BidManifest
    expect(manifest.files).toHaveLength(2)
    expect(manifest.files.map(file => ({ originalName: file.originalName, role: file.role }))).toEqual([
      { originalName: 'tender.txt', role: 'tender' },
      { originalName: 'reference-bid.txt', role: 'reference_bid' },
    ])
    await expect(readFile(join(workspace.sessionRoot, manifest.files[0]!.inputPath))).resolves.toEqual(tender)
    await expect(readFile(join(workspace.sessionRoot, manifest.files[1]!.inputPath))).resolves.toEqual(referenceBid)
  })

  it('accepts a raw binary tender and reference-bid batch without base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const tender = Buffer.from('招标文件', 'utf8')
    const referenceBid = Buffer.from('旧参考标书', 'utf8')
    const request = Object.assign(Readable.from([tender, referenceBid]), {
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        'x-dsh-bid-session-id': agent.session.id,
        'x-dsh-bid-files': encodeURIComponent(JSON.stringify([
          { name: 'tender.txt', role: 'tender', size: tender.byteLength },
          { name: 'reference-bid.txt', role: 'reference_bid', size: referenceBid.byteLength },
        ])),
      },
    })
    const response = { writeHead: vi.fn(), end: vi.fn() }

    await (ctx.bid as unknown as {
      handleBinaryUpload: (req: typeof request, res: typeof response) => Promise<void>
    }).handleBinaryUpload(request, response)

    expect(JSON.parse(String(response.end.mock.calls[0]?.[0]))).toMatchObject({ ok: true })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    const manifest = await workspace.readManifest()
    expect(manifest.files.map(file => ({ originalName: file.originalName, role: file.role }))).toEqual([
      { originalName: 'tender.txt', role: 'tender' },
      { originalName: 'reference-bid.txt', role: 'reference_bid' },
    ])
    await expect(readFile(join(workspace.sessionRoot, manifest.files[0]!.inputPath))).resolves.toEqual(tender)
    await expect(readFile(join(workspace.sessionRoot, manifest.files[1]!.inputPath))).resolves.toEqual(referenceBid)
  })

  it('keeps S1 failed when a declared binary file is missing from the request body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const tender = Buffer.from('招标文件', 'utf8')
    const request = Object.assign(Readable.from([tender]), {
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        'x-dsh-bid-session-id': agent.session.id,
        'x-dsh-bid-files': encodeURIComponent(JSON.stringify([
          { name: 'tender.txt', role: 'tender', size: tender.byteLength },
          { name: 'reference-bid.txt', role: 'reference_bid', size: 1 },
        ])),
      },
    })
    const response = { writeHead: vi.fn(), end: vi.fn() }

    await (ctx.bid as unknown as {
      handleBinaryUpload: (req: typeof request, res: typeof response) => Promise<void>
    }).handleBinaryUpload(request, response)

    expect(JSON.parse(String(response.end.mock.calls[0]?.[0]))).toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(agent.session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toMatchObject({ stage: 'file_intake', status: 'failed' })
  })

  it('fails S1 when a selected file cannot be decoded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const tender = Buffer.from('招标文件', 'utf8')

    await expect(ctx.bid.uploadFiles(agent.session, [
      { name: 'tender.txt', role: 'tender', size: tender.byteLength, data: tender.toString('base64') },
      { name: 'reference-bid.txt', role: 'reference_bid', size: 1, data: '!!!!' },
    ])).resolves.toMatchObject({ ok: false, error: { code: 'BID_FILE_INTAKE_FAILED' } })
    expect(agent.session.events.map(event => event.type)).toEqual(['bid.stage.started', 'bid.stage.failed'])
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toMatchObject({ stage: 'file_intake', status: 'failed', failureReason: 'executor failed: Error: file intake could not decode every selected file' })
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
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped.
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
    const referenceBytes = Buffer.from('参考技术资料', 'utf8')
    await ctx.bid.uploadFiles(agent.session, [
      { name: '招标.txt', role: 'tender', size: bytes.byteLength, data: bytes.toString('base64') },
      { name: '参考.txt', role: 'reference', size: referenceBytes.byteLength, data: referenceBytes.toString('base64') },
    ])
    await ctx.bid.confirmTenderAnalysis(agent.session, [])
    const original = await ctx.bid.getOutlineDraft(agent.session)
    expect(original.revision).toBe(1)
    const unchanged = await ctx.bid.applyOutlineDraftOperations(agent.session, {
      expected_revision: original.revision,
      expected_draft_sha256: original.draft_outline_sha256,
      operations: [],
    })
    expect(unchanged).toEqual({ ok: true, value: original })
    const mutation = await ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: original.revision, expected_draft_sha256: original.draft_outline_sha256, operations: [{ type: 'update_section', section_id: 'SEC-1', title: '已确认交付方案' }] })
    if (!mutation.ok) throw new Error(mutation.error.message)
    expect(mutation.value.revision).toBe(2)
    expect(mutation.value.draft_outline_sha256).not.toBe(original.draft_outline_sha256)
    await expect(ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: original.revision, expected_draft_sha256: original.draft_outline_sha256, operations: [{ type: 'update_section', section_id: 'SEC-1', title: '陈旧覆盖' }] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT', current: { revision: 2 } } })
    const addition = await ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: mutation.value.revision, expected_draft_sha256: mutation.value.draft_outline_sha256, operations: [{ type: 'add_section', parent_id: null, order: 2, writable: true, title: '补充说明', purpose: '补充说明。', must_answer: ['说明补充事项。'] }] })
    if (!addition.ok) throw new Error(addition.error.message)
    const added = addition.value.outline.sections.find(section => section.title === '补充说明')
    expect(added?.id).toMatch(/^SEC-\d{3}$/u)
    if (added === undefined) throw new Error('Host did not return the added section')
    const continued = await ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: addition.value.revision, expected_draft_sha256: addition.value.draft_outline_sha256, operations: [{ type: 'update_section', section_id: added.id, title: '补充事项' }, { type: 'move_section', section_id: added.id, parent_id: null, order: 1 }, { type: 'delete_section', section_id: added.id }] })
    if (!continued.ok) throw new Error(continued.error.message)
    const draft = await ctx.bid.getOutlineDraft(agent.session)
    expect(draft).toEqual(continued.value)
    const result = await ctx.bid.confirmOutline(agent.session, {
      expected_revision: draft.revision,
      expected_draft_sha256: draft.draft_outline_sha256,
    })
    expect(result).toEqual({ ok: true, value: { stage: 'book_review', status: 'waiting_user' } })
    const workspace = new Bid.BidWorkspace(root, agent.session.id)
    expect(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/outline.json'), 'utf8'))).not.toEqual(draft.outline)
    expect(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8')))
      .toMatchObject({ sections: [{ id: 'SEC-1', title: '已确认交付方案' }] })
    const confirmation = Bid.parseOutlineConfirmationArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmation.json'), 'utf8')))
    expect(confirmation).toMatchObject({ scope: 'technical_bid', decision: 'confirmed' })
    expect(confirmation.source_outline_sha256).toBe(draft.source_outline_sha256)
    expect(confirmation.confirmed_outline_sha256).toBe(Bid.outlineArtifactSha256(JSON.parse(await readFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), 'utf8'))))
    expect(agent.session.events.find(event => event.type === 'bid.stage.completed' && event.data.stage === 'outline_confirmation'))
      .toMatchObject({ data: { artifacts: [
        { stage: 'outline_confirmation', type: 'confirmed_outline', path: 'outline/confirmed-outline.json' },
        { stage: 'outline_confirmation', type: 'outline_confirmation', path: 'outline/confirmation.json' },
      ] } })
    await expect(readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')).resolves.toContain('SEC-1')
    await expect(ctx.bid.getReviewWorkbench(agent.session)).resolves.toMatchObject({
      schema_version: 1,
      outline: [expect.objectContaining({ section_id: 'SEC-1', has_content: true })],
      review: { review_mode: 'framework_only', quality_gate: 'not_evaluated', issues: [] },
    })
    await expect(ctx.bid.getReviewChapter(agent.session, 'SEC-1')).resolves.toMatchObject({
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped.
      section_id: 'SEC-1', writable: true, markdown: expect.stringContaining('交付计划'),
    })
    await expect(ctx.bid.getReviewChapter(agent.session, 'missing')).rejects.toThrow('BID_REVIEW_SECTION_UNKNOWN')
    const chapterPath = join(workspace.sessionRoot, 'chapters/sections/0001.md')
    const chapter = await readFile(chapterPath, 'utf8')
    await writeFile(chapterPath, `${chapter}已修改。\n`, 'utf8')
    await expect(ctx.bid.completeReview(agent.session)).resolves.toMatchObject({
      ok: false,
      error: { code: 'BID_REVIEW_CONTENT_CHANGED' },
    })
    await writeFile(chapterPath, chapter, 'utf8')
    await expect(ctx.bid.completeReview(agent.session)).resolves.toEqual({
      ok: true,
      value: { stage: 'docx_export', status: 'pending' },
    })
  })

  it('logs outline feedback and regenerates S4 before returning to S5', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const prompts: string[] = []
    const { agent } = attach(ctx, 'bid', root, async (cwd, sessionId, _attempt, prompt) => {
      prompts.push(prompt)
      if (prompt.includes('当前阶段：tender_analysis')) await writeTenderAnalysisArtifacts(cwd, sessionId)
      else if (prompt.includes('evidence_mapping / Main-Agent Planning')) await writeEvidenceMappingPlan(cwd, sessionId)
      else if (prompt.includes('evidence_mapping / Main-Agent Merge')) await writeEvidenceMappingArtifact(cwd, sessionId)
      else if (prompt.includes('Blueprint Quality Review')) await writeOutlineQualityReport(cwd, sessionId)
      else if (prompt.includes('当前阶段：outline_generation')) {
        if (prompt.includes('当前基线 revision=') || prompt.includes('这是基于 outline/draft.json revision=')) {
          await writeOutlineFromDraft(cwd, sessionId)
          await writeOutlineRegenerationChangeSet(cwd, sessionId)
        } else await writeOutlineArtifact(cwd, sessionId)
      }
    })
    const bytes = Buffer.from('技术标资料', 'utf8')
    const referenceBytes = Buffer.from('参考技术资料', 'utf8')
    await ctx.bid.uploadFiles(agent.session, [
      { name: '招标.txt', role: 'tender', size: bytes.byteLength, data: bytes.toString('base64') },
      { name: '参考.txt', role: 'reference', size: referenceBytes.byteLength, data: referenceBytes.toString('base64') },
    ])
    await ctx.bid.confirmTenderAnalysis(agent.session, [])

    const initial = await ctx.bid.getOutlineDraft(agent.session)
    const manual = await ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: initial.revision, expected_draft_sha256: initial.draft_outline_sha256, operations: [{ type: 'update_section', section_id: 'SEC-1', title: '已手工确认的交付方案' }] })
    if (!manual.ok) throw new Error(manual.error.message)
    const draft = manual.value
    await expect(ctx.bid.regenerateOutline(agent.session, { feedback: '   ', expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'BID_OUTLINE_FEEDBACK_REQUIRED' },
    })
    await expect(ctx.bid.regenerateOutline(agent.session, { feedback: '  拆细实施章节  ', expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256 })).resolves.toEqual({
      ok: true,
      value: { stage: 'outline_confirmation', status: 'waiting_user' },
    })
    expect(agent.session.events.some(event => event.type === 'bid.user_confirmation.received' && event.data.stage === 'outline_confirmation' && !event.data.confirmed)).toBe(false)
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE)).toEqual({ stage: 'outline_confirmation', status: 'waiting_user' })
    expect((await ctx.bid.getOutlineDraft(agent.session)).outline.sections[0]?.title).toBe('已手工确认的交付方案')
    expect(prompts.filter(prompt => prompt.includes('<outline-revision-feedback>'))).toEqual([
      expect.stringContaining('拆细实施章节'),
    ])
  })

  it('keeps S5 waiting when deletion removes mandatory coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-'))
    const { ctx } = await harness()
    const { agent } = attach(ctx, 'bid', root)
    const bytes = Buffer.from('技术标资料', 'utf8')
    const referenceBytes = Buffer.from('参考技术资料', 'utf8')
    await ctx.bid.uploadFiles(agent.session, [
      { name: '招标.txt', role: 'tender', size: bytes.byteLength, data: bytes.toString('base64') },
      { name: '参考.txt', role: 'reference', size: referenceBytes.byteLength, data: referenceBytes.toString('base64') },
    ])
    await ctx.bid.confirmTenderAnalysis(agent.session, [])
    const draft = await ctx.bid.getOutlineDraft(agent.session)
    await expect(ctx.bid.applyOutlineDraftOperations(agent.session, { expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256, operations: [{ type: 'delete_section', section_id: 'SEC-1' }] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BID_INVALID_USER_OUTLINE' } })
    expect(agent.session.events.reduce(Bid.reduceBidRuntimeState, Bid.BID_INITIAL_RUNTIME_STATE))
      .toEqual({ stage: 'outline_confirmation', status: 'waiting_user' })
  })
})
