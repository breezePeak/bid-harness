import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { describe, expect, it } from 'vitest'
import {
  BidOrchestrator,
  BidWorkspace,
  buildBidStageTask,
  createScoringResponsePointCatalog,
  executeEvidenceMapping,
  parseWebEvidenceSourcesArtifact,
  parseEvidenceMapArtifact,
  validateEvidenceMapping,
} from '@deepseek-ai/dsh-bid'

function toolCall(callId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(callId)
  const serialized = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function finalText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = this.script.shift()
    if (response === undefined) throw new Error('S4 scripted adapter exhausted')
    yield* response
  }
}

class IntegrationFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  resolve(path: string): Promise<{ targetKey: string; displayPath: string }> {
    return Promise.resolve({ targetKey: path, displayPath: path })
  }
}

function registerIntegrationTools(ctx: Context, root: string, sourceUrls: string | readonly string[]): void {
  const urls = typeof sourceUrls === 'string' ? [sourceUrls] : [...sourceUrls]
  let searchIndex = 0
  ctx.tools.register(defineTool({
    name: 'read', description: 'Read a UTF-8 file.', parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return readFile(resolve(root, args.file_path), 'utf8')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'grep', description: 'Find local technical material.', parameters: {
      pattern: { type: 'string', required: true }, path: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => (await readFile(resolve(root, args.path), 'utf8')).includes(args.pattern)
      ? `${args.path}: access control`
      : '',
  }))
  ctx.tools.register(defineTool({
    name: 'write', description: 'Write a UTF-8 file.', parameters: {
      file_path: { type: 'string', required: true }, content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const path = resolve(root, args.file_path)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, args.content, 'utf8')
      return 'written'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'web_search', description: 'Search public technical sources.', parameters: {
      queries: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true } } } },
        truncated: { type: 'boolean', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ sources: [{ url: urls[Math.min(searchIndex++, urls.length - 1)]! }], truncated: false }),
  }))
  ctx.tools.register(defineTool({
    name: 'web_fetch', description: 'Fetch one public technical source.', parameters: { url: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        url: { type: 'string', required: true }, statusCode: { type: 'integer', required: true },
        body: { type: 'object', required: true, additionalProperties: false, properties: {
          kind: { type: 'string', required: true, const: 'text' }, content: { type: 'string', required: true },
        } },
        truncated: { type: 'boolean', required: true },
      } },
      render: (_args, value) => {
        return [{ type: 'text', text: `Fetched ${value.url} (HTTP ${value.statusCode})\n\n${value.body.content}` }]
      },
      presentationMeta: (_args, value) => {
        return { url: value.url, statusCode: value.statusCode, truncated: value.truncated }
      },
    },
    execute: async args => ({ url: args.url, statusCode: 200, body: { kind: 'text' as const, content: '官方标准要求访问控制与安全审计。' }, truncated: false }),
  }))
}

async function prepareS2(workspace: BidWorkspace): Promise<{
  chunk: string
  requirementId: string
  scoringId: string
  responsePointId: string
}> {
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('需要访问控制与安全审计方案。') },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('本地资料只有实施流程。') },
  ])
  if (tender === undefined || reference === undefined || reference.chunkIndexPath === null || reference.chunksPath === null) throw new Error('S4 integration corpus missing')
  const chunkIndex = JSON.parse(await readFile(join(workspace.sessionRoot, reference.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
  const chunk = `${reference.chunksPath}/${chunkIndex.chunks[0]!.path}`
  const sourceRef = { file_id: tender.id, chunk, line_start: 1, line_end: 1 }
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '访问控制项目', tender_name: null, purchaser: null, owner: null, project_background: ['安全建设'], project_objectives: ['访问控制'], project_scope: ['技术方案'], technical_scope: ['安全'], delivery_scope: ['方案'], implementation_constraints: [], key_technical_points: ['访问控制'], source_refs: [sourceRef], analyzed_tender_files: [tender.id] }))
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '访问控制', normalized_requirement: '提供访问控制方案', mandatory: true, source_refs: [sourceRef] }] }))
  const scoring = { schema_version: 1 as const, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '安全', raw_text: '安全审计', criterion: '方案完整', score: 5, score_range: null, must_answer: true, source_refs: [sourceRef] }] }
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify(scoring))
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [{ scoring_id: 'SCORE-1', order: 1, text: '说明访问控制' }] })))
  await writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] }))
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-SECURITY', parent_id: null, order: 1, level: 1, title: '访问控制与安全审计', purpose: '响应安全技术要求。', writable: true, must_answer: ['说明访问控制与安全审计措施。'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明访问控制' }], suggested_tables: [], suggested_figures: [], writing_notes: [] }] })),
    writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'], checked_scoring_response_point_ids: ['RP-000001'], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })),
  ])
  return { chunk, requirementId: 'REQ-1', scoringId: 'SCORE-1', responsePointId: 'RP-000001' }
}

function transientWebMaterial(url: string) {
  return {
    url, usage: 'reference' as const, summary: '要求访问控制与审计。', supports: '支持安全方案。',
  }
}

function partialResult(url: string) {
  const web = transientWebMaterial(url)
  return {
    task_id: 'TASK-SECURITY',
    section_mappings: [{ section_id: 'SEC-SECURITY', local_materials: [], web_materials: [web], missing_topics: [], writing_dimensions: ['身份鉴别与访问控制', '安全审计'] }],
    refinement_suggestions: [],
  }
}

describe('S4 Web evidence through a real Agent Tool loop', () => {
  it('plans in the Main Agent, maps in a fresh child, and completes evidence_mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s3-loop-'))
    const sessionId = SessionId('s3-real-loop')
    const workspace = new BidWorkspace(root, sessionId)
    const s2 = await prepareS2(workspace)
    const sourceUrl = 'https://official.example/standard'
    const unusedSourceUrl = 'https://official.example/unused'
    const workspacePath = relative(root, workspace.sessionRoot).replaceAll('\\', '/')
    const planPath = `${workspacePath}/analysis/evidence-mapping-plan.json`
    const plan = JSON.stringify({
      schema_version: 3,
      global_analysis: ['访问控制章节由一个任务负责。'],
      research_notes: ['本地资料与公开标准结合。'],
      tasks: [{
        task_id: 'TASK-SECURITY',
        title: '访问控制与审计',
        objective: '定位本地实施资料并补充公开技术依据。',
        section_ids: ['SEC-SECURITY'],
        research_topics: ['访问控制安全审计官方标准'],
      }],
    })
    const initialOutline = await readFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), 'utf8')
    const quality = JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: [s2.requirementId], checked_scoring_ids: [s2.scoringId], checked_scoring_response_point_ids: [s2.responsePointId], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })
    const script = [
      toolCall('read-manifest', 'read', { file_path: `${relative(root, workspace.sessionRoot).replaceAll('\\', '/')}/manifest.json` }),
      toolCall('read-project', 'read', { file_path: `${relative(root, workspace.sessionRoot).replaceAll('\\', '/')}/analysis/project.json` }),
      toolCall('read-requirements', 'read', { file_path: `${relative(root, workspace.sessionRoot).replaceAll('\\', '/')}/analysis/requirements.json` }),
      toolCall('read-scoring', 'read', { file_path: `${relative(root, workspace.sessionRoot).replaceAll('\\', '/')}/analysis/scoring.json` }),
      toolCall('read-response-points', 'read', { file_path: `${workspacePath}/analysis/scoring-response-points.json` }),
      toolCall('read-compliance', 'read', { file_path: `${relative(root, workspace.sessionRoot).replaceAll('\\', '/')}/analysis/compliance.json` }),
      toolCall('write-plan', 'write', { file_path: planPath, content: plan }),
      finalText('规划完成。'),
      toolCall('grep-local', 'grep', { pattern: '实施流程', path: `${workspacePath}/${s2.chunk}` }),
      toolCall('read-chunk', 'read', { file_path: `${workspacePath}/${s2.chunk}` }),
      toolCall('search-source', 'web_search', { queries: ['访问控制安全审计官方标准'] }),
      toolCall('fetch-source', 'web_fetch', { url: sourceUrl }),
      toolCall('search-unused', 'web_search', { queries: ['未采用的公开资料'] }),
      toolCall('fetch-unused', 'web_fetch', { url: unusedSourceUrl }),
      finalText(JSON.stringify(partialResult(sourceUrl))),
      finalText('等待 Host 下发目录深化任务。'),
      toolCall('read-initial-outline', 'read', { file_path: `${workspacePath}/outline/initial-confirmed-outline.json` }),
      toolCall('read-section-map', 'read', { file_path: `${workspacePath}/analysis/evidence-map.json` }),
      toolCall('write-refined-outline', 'write', { file_path: `${workspacePath}/outline/refined-outline.candidate.json`, content: initialOutline }),
      finalText('目录无需深化。'),
      toolCall('read-refined-outline', 'read', { file_path: `${workspacePath}/outline/refined-outline.candidate.json` }),
      toolCall('read-refined-map', 'read', { file_path: `${workspacePath}/analysis/evidence-map.json` }),
      toolCall('write-refinement-quality', 'write', { file_path: `${workspacePath}/outline/quality-report.json`, content: quality }),
      finalText('复核完成。'),
    ]
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(script))
    registerIntegrationTools(ctx, root, [sourceUrl, unusedSourceUrl])
    const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
    agent.session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
    agent.session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    agent.session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
    const orchestrator = new BidOrchestrator(
      agent.session,
      { canExecute: stage => stage === 'evidence_mapping', execute: task => executeEvidenceMapping(agent, workspace, task, { maxRepairAttempts: 0, maxConcurrency: 2 }) },
      { validate: (stage, artifacts) => validateEvidenceMapping(workspace, stage, artifacts) },
    )

    await expect(orchestrator.runCurrentAutomaticStage()).resolves.toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
    const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
    expect(ledger.sources).toHaveLength(1)
    expect(ledger.sources[0]?.requested_url).toBe(sourceUrl)
    const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(map.section_mappings[0]?.web_materials).toEqual([{
      source_id: ledger.sources[0]!.source_id,
      snapshot_path: ledger.sources[0]!.snapshot_path,
      usage: 'reference',
      summary: '要求访问控制与审计。',
      supports: '支持安全方案。',
    }])
    expect(map.section_mappings[0]?.local_materials).toEqual([])
    expect(await readFile(join(workspace.sessionRoot, ledger.sources[0]!.snapshot_path), 'utf8')).toContain('官方标准要求访问控制与安全审计')
    expect(agent.session.events.some(event => event.type === 'bid.user_confirmation.required' && event.data.stage === 'evidence_mapping')).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
      'read', 'read', 'read', 'read', 'read', 'read', 'write', 'read', 'read', 'write', 'read', 'read', 'write',
    ])
    expect(buildBidStageTask('evidence_mapping').requiredArtifacts).toEqual(['analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/outline.json', 'outline/quality-report.json'])
    await ctx.fiber.dispose()
  }, 15_000)
})
