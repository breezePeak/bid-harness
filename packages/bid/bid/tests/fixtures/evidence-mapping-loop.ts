/** S4 真实工具循环与 Loader 回放共用的外部结果和输入资料。 */
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SearchError } from '@deepseek-ai/dsh-tool-fs-search'
import type {} from '@deepseek-ai/dsh-fs'
import {
  BidOrchestrator, BidWorkspace, createScoringResponsePointCatalog, executeEvidenceMapping,
  validateEvidenceMapping, resolveMappingCorpusLocations,
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
  interactive = false
  constructor(
    private readonly parentId: SessionId,
    private readonly parentScript: StreamChunk[][],
    private readonly childScript: StreamChunk[][],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.interactive && options.messages.at(-1)?.source.kind === 'subagent-settled') {
      yield* finalText('等待 Host 下发目录深化任务。')
      return
    }
    const response = (options.sessionId === this.parentId ? this.parentScript : this.childScript).shift()
    if (response === undefined) throw new Error('S4 scripted adapter exhausted')
    yield* response
  }
}

/** 回放文件工具与 Host 使用同一个实际磁盘工作区。 */
export default class IntegrationFileSystem extends Service {
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
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read', description: 'Read a UTF-8 file.', parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return readFile(resolve(root, args.file_path), 'utf8')
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'grep', description: 'Find local technical material.', parameters: {
      pattern: { type: 'string', required: true }, path: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => {
      if (args.pattern === '[') throw new SearchError('请修正无效的搜索表达式。', 'SEARCH_INVALID_PATTERN')
      if (args.pattern === '.*') throw new SearchError('请缩小搜索范围。', 'SEARCH_RAW_OUTPUT_OVERFLOW')
      const path = resolve(root, args.path)
      const files = (await lstat(path)).isDirectory() ? (await readdir(path)).filter(file => file.endsWith('.md')).map(file => join(path, file)) : [path]
      const matches = await Promise.all(files.map(async file => (await readFile(file, 'utf8')).includes(args.pattern) ? file : ''))
      return matches.filter(Boolean).join('\n')
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
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
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
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
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
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
  })))
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
    task_id: 'MAP-INIT-SEC-SECURITY',
    section_mappings: [{ section_id: 'SEC-SECURITY', local_materials: [], web_materials: [web], missing_topics: [], writing_dimensions: ['身份鉴别与访问控制', '安全审计'] }],
    refinement_suggestions: [],
  }
}

/**
 * 在已组装的服务上执行 S4，模型与 Web 返回使用固定数据。
 * @param ctx - 真实 Agent、工具、持久化和 Subagent 服务。
 * @param root - 本用例的隔离工作区。
 * @param repair - 搜索错误后调整查询，跨 Child 轮次抓取 URL，并修复目录 Schema。
 * @returns 阶段结果、Host 及其工作区。
 */
export async function runEvidenceMappingLoop(ctx: Context, root: string, repair: boolean, interactive = false) {
  const sessionId = SessionId('s3-real-loop')
  const workspace = new BidWorkspace(root, sessionId)
  const s2 = await prepareS2(workspace)
  const sourceUrl = 'https://official.example/standard'
  const unusedSourceUrl = 'https://official.example/unused'
  const workspacePath = relative(root, workspace.sessionRoot).replaceAll('\\', '/')
  const initialOutline = await readFile(join(workspace.sessionRoot, 'outline/initial-confirmed-outline.json'), 'utf8')
  const quality = JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: [s2.requirementId], checked_scoring_ids: [s2.scoringId], checked_scoring_response_point_ids: [s2.responsePointId], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })
  const [corpus] = await resolveMappingCorpusLocations(workspace, await workspace.readManifest())
  if (corpus === undefined) throw new Error('missing reference corpus')
  const childScript = [
    ...(repair ? [
      toolCall('grep-invalid', 'grep', { pattern: '[', path: corpus.chunks_path }),
      toolCall('grep-overflow', 'grep', { pattern: '.*', path: corpus.chunks_path }),
    ] : []),
    toolCall('grep-local', 'grep', { pattern: '实施流程', path: corpus.chunks_path }),
    toolCall('read-chunk', 'read', { file_path: corpus.chunks[0]!.path }),
    toolCall('search-source', 'web_search', { queries: ['访问控制安全审计官方标准'] }),
    ...(repair ? [finalText(JSON.stringify(partialResult(sourceUrl)))] : []),
    toolCall('fetch-source', 'web_fetch', { url: sourceUrl }),
    ...(!repair ? [
      toolCall('search-unused', 'web_search', { queries: ['未采用的公开资料'] }),
      toolCall('fetch-unused', 'web_fetch', { url: unusedSourceUrl }),
    ] : []),
    finalText(JSON.stringify(partialResult(sourceUrl))),
  ]
  const refinementScript = [
    toolCall('read-initial-outline', 'read', { file_path: `${workspacePath}/outline/initial-confirmed-outline.json` }),
    toolCall('read-section-map', 'read', { file_path: `${workspacePath}/analysis/evidence-map.json` }),
    toolCall('write-refined-outline', 'write', { file_path: `${workspacePath}/outline/refined-outline.candidate.json`, content: repair ? '{}' : initialOutline }),
    finalText('目录无需深化。'),
    ...(repair ? [
      toolCall('repair-refined-outline', 'write', { file_path: `${workspacePath}/outline/refined-outline.candidate.json`, content: initialOutline }),
      finalText('目录产物已修复。'),
    ] : []),
    toolCall('read-refined-outline', 'read', { file_path: `${workspacePath}/outline/refined-outline.candidate.json` }),
    toolCall('read-refined-map', 'read', { file_path: `${workspacePath}/analysis/evidence-map.json` }),
    toolCall('write-refinement-quality', 'write', { file_path: `${workspacePath}/outline/quality-report.json`, content: quality }),
    finalText('复核完成。'),
  ]
  const adapter = new ScriptedAdapter(sessionId, refinementScript, childScript)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, [sourceUrl, unusedSourceUrl])
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root, ...(interactive ? { agentPreset: 'bid' } : {}) })
  agent.session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
  agent.session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
  agent.session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
  agent.session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
  agent.session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
  agent.session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
  const orchestrator = new BidOrchestrator(
    agent.session,
    { canExecute: stage => stage === 'evidence_mapping', execute: task => executeEvidenceMapping(agent, workspace, task, { maxRepairAttempts: repair ? 1 : 0, maxConcurrency: 2 }) },
    { validate: (stage, artifacts) => validateEvidenceMapping(workspace, stage, artifacts) },
  )

  const outcome = await orchestrator.runCurrentAutomaticStage()
  adapter.interactive = interactive
  return { agent, workspace, sourceUrl, outcome, parentScript: refinementScript, childScript }
}
