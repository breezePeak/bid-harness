/** S4/S5 真实工具循环与 Loader 回放共用的外部结果和输入资料。 */
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SearchError } from '@deepseek-ai/dsh-tool-fs-search'
import type {} from '@deepseek-ai/dsh-fs'
import {
  BidOrchestrator, BidWorkspace, createScoringResponsePointCatalog, executeEvidenceMapping,
  validateEvidenceMapping, resolveMappingCorpusLocations, buildBidStageTask, executeChapterWriting,
  outlineArtifactSha256, parseOutlineArtifact, CHAPTER_EXECUTION_SCHEMA_VERSION, EVIDENCE_MAPPING_SCHEMA_VERSION,
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
    if (response === undefined) throw new Error('Bid scripted adapter exhausted')
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
  const chunkIndex = JSON.parse(await readFile(join(workspace.projectRoot, reference.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
  const chunk = `${reference.chunksPath}/${chunkIndex.chunks[0]!.path}`
  const sourceRef = { file_id: tender.id, chunk, line_start: 1, line_end: 1 }
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '访问控制项目', tender_name: null, purchaser: null, owner: null, project_background: ['安全建设'], project_objectives: ['访问控制'], project_scope: ['技术方案'], technical_scope: ['安全'], delivery_scope: ['方案'], implementation_constraints: [], key_technical_points: ['访问控制'], source_refs: [sourceRef], analyzed_tender_files: [tender.id] }))
  await writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '访问控制', normalized_requirement: '提供访问控制方案', mandatory: true, source_refs: [sourceRef] }] }))
  const scoring = { schema_version: 1 as const, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '安全', raw_text: '安全审计', criterion: '方案完整', score: 5, score_range: null, must_answer: true, source_refs: [sourceRef] }] }
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring))
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [{ scoring_id: 'SCORE-1', order: 1, text: '说明访问控制' }] })))
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] }))
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-SECURITY', parent_id: null, order: 1, level: 1, title: '访问控制与安全审计', purpose: '响应安全技术要求。', writable: true, must_answer: ['说明访问控制与安全审计措施。'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明访问控制' }], suggested_tables: [], suggested_figures: [], writing_notes: [] }] })),
    writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'], checked_scoring_response_point_ids: ['RP-000001'], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })),
  ])
  return { chunk, requirementId: 'REQ-1', scoringId: 'SCORE-1', responsePointId: 'RP-000001' }
}

function transientWebMaterial(url: string) {
  return {
    url, usage: 'reference' as const, summary: '要求访问控制与审计。', supports: '支持安全方案。',
  }
}

function partialResult(url: string, taskId = 'MAP-INIT-SEC-SECURITY') {
  const web = transientWebMaterial(url)
  return {
    task_id: taskId,
    section_mappings: [{
      section_id: 'SEC-SECURITY', local_materials: [], web_materials: [web], missing_topics: [], writing_dimensions: ['身份鉴别与访问控制', '安全审计'],
      writing_brief: {
        purpose: '为访问控制项目说明权限控制与安全审计措施，响应安全技术评分。',
        must_answer: ['说明访问控制与安全审计措施。'],
        writing_notes: ['分别说明身份鉴别、权限授予和审计记录的执行方法。'],
        suggested_tables: ['角色权限与审计记录对照表'], suggested_figures: [],
        requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], scoring_response_point_ids: ['RP-000001'],
      },
    }],
    refinement_suggestions: [],
    branch_summaries: [],
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
  const workspace = new BidWorkspace(root)
  const s2 = await prepareS2(workspace)
  const sourceUrl = 'https://official.example/standard'
  const unusedSourceUrl = 'https://official.example/unused'
  const workspacePath = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const initialOutline = await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')
  const quality = JSON.stringify({ schema_version: 3, scope: 'technical_bid', checked_requirement_ids: [s2.requirementId], checked_scoring_ids: [s2.scoringId], checked_scoring_response_point_ids: [s2.responsePointId], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })
  const manifest = await workspace.readManifest()
  const [corpus] = await resolveMappingCorpusLocations(workspace, manifest)
  const tender = manifest.files.find(file => file.role === 'tender')!
  if (corpus === undefined || tender.chunksPath === null) throw new Error('missing mapping corpus')
  const childScript = [
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
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
    finalText(JSON.stringify(partialResult(sourceUrl, 'MAP-FINAL-CHECK'))),
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
  // Loader 装配的 Host 必须完成项目初始化，才能设置本场景的 S4 起点。
  const host = ctx.get('bid') as unknown as { inFlight: ReadonlyMap<unknown, { session: Session; done: Promise<void> }> } | undefined
  await [...host?.inFlight.values() ?? []].find(operation => operation.session === agent.session)?.done
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

/**
 * 通过真实 Writer 工具和 Reviewer 结构化提交，补充 S4 未映射的本地资料。
 * @param ctx - Loader 组装的 Agent、工具、持久化和 Subagent 服务。
 * @param root - 本用例的隔离工作区。
 * @returns 章节阶段产物及工作区；S4 map 变更时抛错。
 */
export async function runChapterWritingLoop(ctx: Context, root: string) {
  const sessionId = SessionId('s5-real-loop')
  const workspace = new BidWorkspace(root)
  await prepareS2(workspace)
  const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')))
  const section = outline.sections[0]!
  Object.assign(section, partialResult('https://official.example/standard').section_mappings[0]!.writing_brief)
  const outlineHash = outlineArtifactSha256(outline)
  const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
  const evidenceBefore = JSON.stringify({ schema_version: EVIDENCE_MAPPING_SCHEMA_VERSION, section_mappings: [{
    section_id: section.id, local_materials: [], web_materials: [],
    missing_topics: ['缺少实施流程参考资料。'], writing_dimensions: ['身份鉴别与访问控制', '安全审计'],
  }] })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline)),
    writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({
      schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
      confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
    })),
    writeFile(evidencePath, evidenceBefore),
    writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ schema_version: 2, stage: 'evidence_mapping', sources: [] })),
  ])
  const manifest = await workspace.readManifest()
  const [corpus] = await resolveMappingCorpusLocations(workspace, manifest)
  const tender = manifest.files.find(file => file.role === 'tender')!
  if (corpus === undefined || tender.chunksPath === null) throw new Error('缺少 S5 回放资料')
  const workspacePath = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const candidate = {
    section_id: section.id,
    markdown: '# 访问控制与安全审计\n\n本项目先核查角色与访问权限，再组织安全审计和结果复核。实施流程以本地资料为编排参考，按权限授予、执行检查、记录留存三个步骤说明责任与交付结果。',
    metadata: {
      section_id: section.id, covered_must_answer: section.must_answer,
      covered_scoring_response_point_ids: section.scoring_response_point_ids,
      covered_scoring_response_points: section.scoring_response_points,
      local_materials_used: [{ source_kind: corpus.role, file_id: corpus.file_id, chunk: corpus.chunks[0]!.id, usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。' }],
      web_materials_used: [], additional_web_materials: [], unresolved_topics: [],
      handoff: {
        section_id: section.id, decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [],
        deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [],
      },
    },
  }
  const coverage = { status: 'covered', evidence_quotes: ['Q2'], issue: null }
  const review = {
    schema_version: 2, section_id: section.id, verdict: 'pass',
    must_answer_coverage: section.must_answer.map(item => ({ item, ...coverage })),
    requirement_coverage: [{ requirement_id: 'REQ-1', item: '提供访问控制方案', ...coverage }],
    response_point_coverage: [{ response_point_id: 'RP-000001', item: '说明访问控制', ...coverage }],
    compliance_coverage: [], claim_checks: [],
    quality_checks: {
      project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
      placeholder_free: true, obvious_repetition_free: true,
    },
    blocking_issues: [],
  }
  const parentScript = [
    toolCall('write-chapter-plan', 'write', { file_path: `${workspacePath}/chapters/execution-plan.json`, content: JSON.stringify({
      schema_version: CHAPTER_EXECUTION_SCHEMA_VERSION, scope: 'technical_bid', confirmed_outline_sha256: outlineHash,
      global_consistency_notes: ['统一使用访问控制项目名称和权限审计术语。'], sections: [{ section_id: section.id, depends_on: [], related_sections: [], planning_notes: [] }],
    }) }),
    finalText('章节依赖规划完成。'),
  ]
  const childScript = [
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
    toolCall('grep-supplement', 'grep', { pattern: '实施流程', path: corpus.chunks_path }),
    toolCall('read-supplement', 'read', { file_path: corpus.chunks[0]!.path }),
    toolCall('submit-chapter', 'structured_output', candidate),
    toolCall('submit-review', 'structured_output', review),
  ]
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(sessionId, parentScript, childScript)))
  registerIntegrationTools(ctx, root, 'https://official.example/standard')
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1 })
  if (await readFile(evidencePath, 'utf8') !== evidenceBefore) throw new Error('S5 补搜修改了 S4 evidence map')
  return { agent, artifacts, workspace }
}
