/** S4/S5 真实工具循环与 Loader 回放共用的外部结果和输入资料。 */
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SearchError } from '@deepseek-ai/dsh-tool-fs-search'
import type {} from '@deepseek-ai/dsh-fs'
import {
  BidOrchestrator, BidWorkspace, createScoringResponsePointCatalog, executeEvidenceMapping,
  validateEvidenceMapping, resolveMappingCorpusLocations, buildBidStageTask, executeChapterWriting,
  executeOutlineGeneration, validateOutlineGeneration,
  executeTenderAnalysis, validateTenderAnalysis, outlineArtifactSha256, parseOutlineArtifact,
  parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact,
  parseTenderScoringArtifact, parseTenderScoringSelection, EVIDENCE_MAPPING_SCHEMA_VERSION,
  webEvidenceContentSha256, webEvidenceSourceId,
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

type ScriptStep = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[])

/** @param options 模型实际可见的工具结果。 @returns 针对当前待审引用的固定复核回复。 */
export function reviewPendingMappingItems(options: GenerateOptions): StreamChunk[] {
  for (const message of [...options.messages].reverse()) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      for (const content of block.content) {
        if (content.type !== 'text') continue
        const result = JSON.parse(content.text) as { pending_items?: Array<{ review_ref: string }> }
        if (result.pending_items === undefined) continue
        return toolCall('review-current-items', 'review_items', { items: result.pending_items.map(item => ({
          review_ref: item.review_ref, decision: 'keep', reason: '已对照招标安全要求和当前章节职责；任务及资料用途限于访问控制与审计，总述没有新增项目承诺。',
        })) })
      }
    }
  }
  throw new Error('模型上下文缺少待审项结果')
}

class ScriptedAdapter extends LlmAdapter {
  interactive = false
  readonly requests: GenerateOptions[] = []
  constructor(
    private readonly parentId: SessionId,
    private readonly parentScript: StreamChunk[][],
    private readonly childScript: ScriptStep[],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (!this.interactive && options.messages.at(-1)?.source.kind === 'subagent-settled') {
      yield* finalText('等待 Host 下发目录深化任务。')
      return
    }
    const response = (options.sessionId === this.parentId ? this.parentScript : this.childScript).shift()
    if (response === undefined) throw new Error('Bid scripted adapter exhausted')
    yield* typeof response === 'function' ? response(options) : response
  }
}

/** 回放文件工具与 Host 使用同一个实际磁盘工作区。 */
export default LocalFileSystem

/**
 * 注册回放所需的实际磁盘读写工具及固定外部 Web 返回。
 * @param ctx Loader 组装的工具服务。
 * @param root 隔离工作区。
 * @param sourceUrls 本场景允许的固定外部来源。
 */
export function registerIntegrationTools(ctx: Context, root: string, sourceUrls: string | readonly string[]): void {
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
    execute: async () => ({
      sources: urls.length === 0 ? [] : [{ url: urls[Math.min(searchIndex++, urls.length - 1)]! }], truncated: false,
    }),
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
    execute: async (args) => {
      if (!urls.includes(args.url)) throw new Error('固定场景未提供该外部来源正文。')
      return { url: args.url, statusCode: 200, body: { kind: 'text' as const, content: '官方标准要求访问控制与安全审计。' }, truncated: false }
    },
  })))
}

/**
 * 通过真实 Agent loop 和五个 staged 工具执行 S2 Host 提交协议。
 * @param ctx - Loader 组装的 Agent、工具和文件服务。
 * @param root - 本用例的隔离工作区。
 * @returns 模型工具调用、正式 Artifact 摘要和最终校验结果。
 */
export async function runTenderAnalysisLoop(ctx: Context, root: string) {
  const workspace = new BidWorkspace(root)
  const tenderText = [
    '# 智慧审计平台建设项目',
    '系统必须支持统一身份认证和审计日志。',
    '技术评分：总体技术方案完整合理得 10 分。',
    '技术方案必须提供数据安全措施。',
  ].join('\n')
  const [tender] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tenderText) },
  ])
  if (tender === undefined || tender.chunkIndexPath === null) throw new Error('S2 integration corpus missing')
  const index = JSON.parse(await readFile(join(workspace.projectRoot, tender.chunkIndexPath), 'utf8')) as {
    chunks: Array<{ id: string }>
  }
  const chunk = index.chunks[0]?.id
  if (chunk === undefined) throw new Error('S2 integration chunk missing')
  const source = (semantic_hint: string) => ({ file_ref: 'T1', chunk, semantic_hint })
  const sessionId = SessionId('s2-real-loop')
  const parentScript = [
    toolCall('submit-project', 'submit_project_fact', {
      field: 'project_name', value: '智慧审计平台建设项目', sources: [source('智慧审计平台建设项目')],
    }),
    toolCall('submit-requirement', 'submit_requirement', {
      category: '功能要求', normalized_requirement: '系统必须支持统一身份认证和审计日志。', mandatory: true,
      sources: [source('系统必须支持统一身份认证和审计日志。')],
    }),
    toolCall('submit-scoring', 'submit_scoring_item', {
      group: '技术评分', title: '总体技术方案', criterion: '总体技术方案完整合理得 10 分。',
      score: 10, score_range: null, must_answer: true,
      sources: [source('技术评分：总体技术方案完整合理得 10 分。')],
    }),
    toolCall('submit-compliance', 'submit_compliance_item', {
      type: '强制要求', normalized_rule: '技术方案必须提供数据安全措施。', severity: 'mandatory',
      sources: [source('技术方案必须提供数据安全措施。')],
    }),
    toolCall('finish-analysis', 'finish_tender_analysis', {}),
    toolCall('finish-analysis-review', 'finish_tender_analysis', { review_revision: 4 }),
    finalText('S2 staged submission reviewed and completed.'),
  ]
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(sessionId, parentScript, [])))
  registerIntegrationTools(ctx, root, [])
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  const artifacts = await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), { maxRepairAttempts: 0 })
  const validation = await validateTenderAnalysis(workspace, 'tender_analysis', artifacts)
  if (!validation.ok) {
    const results = agent.session.events.filter(event => event.type === 'tool/result').map(event => event.data.message.content)
    throw new Error(`S2 integration validation failed: ${JSON.stringify({ validation, results })}`)
  }
  const [project, requirements, scoring, compliance] = await Promise.all([
    readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8').then(JSON.parse).then(parseTenderProjectArtifact),
    readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8').then(JSON.parse).then(parseTenderRequirementsArtifact),
    readFile(join(workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8').then(JSON.parse).then(parseTenderScoringArtifact),
    readFile(join(workspace.projectRoot, 'analysis/compliance.json'), 'utf8').then(JSON.parse).then(parseTenderComplianceArtifact),
  ])
  const selection = parseTenderScoringSelection(
    JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/tender-analysis-selection.json'), 'utf8')),
    scoring,
  )
  return {
    calls: agent.session.events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : []),
    validation,
    artifacts: artifacts.map(artifact => artifact.path),
    project: {
      name: project.project_name,
      tender_files: project.analyzed_tender_files.length,
      source_lines: project.source_refs.map(ref => [ref.line_start, ref.line_end]),
    },
    requirements: requirements.requirements.map(item => ({ id: item.id, mandatory: item.mandatory })),
    scoring: scoring.scoring_items.map(item => ({ id: item.id, parent: item.parent, score: item.score })),
    selected_scoring_ids: selection.selected_scoring_ids,
    compliance: compliance.compliance_items.map(item => ({ id: item.id, severity: item.severity })),
  }
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
    writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 4, scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'], checked_scoring_response_point_ids: ['RP-000001'], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })),
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
  }
}

function sectionSubmission(url: string) {
  const mapping = partialResult(url).section_mappings[0]!
  return {
    section_id: mapping.section_id,
    local_materials: [{ material_ref: 'M1:chunk_0001', usage: 'reference', summary: '支持本章实施组织任务，仅参考流程组织思路，不据此新增具体技术步骤或项目承诺。' }],
    web_materials: mapping.web_materials,
  }
}

function researchAssessment(sufficient: boolean, affectsOutlineDecision: boolean) {
  return {
    sufficient_for_outline_decision: sufficient,
    diagnostics: {
      tender_and_response_points: '已理解访问控制与安全审计要求及评分响应点。',
      technical_approach: '已研究身份鉴别、权限控制和安全审计的技术路线。',
      evidence_and_inferences: '本地资料支持实施组织，公开标准用于技术背景，未把参考项目写成本项目事实。',
      project_specific_quality_risks: '已检查访问控制验证、审计完整性和项目资料边界。',
    },
    key_findings: ['访问控制与安全审计属于同一安全技术过程，可在当前叶子内按写作维度展开。'],
    unresolved_gaps: [{
      topic: '当前项目的既有账号与权限清单未提供',
      affects_outline_decision: affectsOutlineDecision,
      writing_impact: '不虚构具体账号规模，S5 按已确认边界编写核查方法。',
    }],
    outline_capacity: {
      decision: sufficient ? 'adequate' : 'undetermined',
      reason: sufficient ? '当前叶子可承载统一安全过程，不需要机械拆节。' : '需要确认资料边界是否影响章节结构。',
    },
    topic_dispositions: [{
      topic: '访问控制与安全审计', placement: 'within_section',
      reason: '身份鉴别、权限控制和审计记录属于统一安全技术过程，在当前章节内连续论证。',
      basis: [{ kind: 'requirement', ref: 'REQ-1' }],
    }],
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
  await workspace.import([{
    name: 'reference-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode([
      '# 安全平台技术标', '## 身份治理', '### 账户生命周期', '### 权限审批', '## 安全运维', '### 访问控制与安全审计',
    ].join('\n\n')),
  }, {
    name: 'user-framework.md', role: 'outline_framework', bytes: new TextEncoder().encode([
      '# 安全平台方案', '## 访问控制与安全审计', '## 资产盘点', '### 资产发现', '### 资产核验',
      '', '框架内部编写说明。',
    ].join('\n\n')),
  }])
  const sourceUrl = 'https://official.example/standard'
  const unusedSourceUrl = 'https://official.example/unused'
  const workspacePath = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const quality = JSON.stringify({ schema_version: 4, scope: 'technical_bid', checked_requirement_ids: [s2.requirementId], checked_scoring_ids: [s2.scoringId], checked_scoring_response_point_ids: [s2.responsePointId], issues: [], blocking_issues: [] })
  const manifest = await workspace.readManifest()
  const [corpus] = await resolveMappingCorpusLocations(workspace, manifest)
  const tender = manifest.files.find(file => file.role === 'tender')!
  const framework = manifest.files.find(file => file.role === 'outline_framework')!
  if (corpus === undefined || tender.chunksPath === null || framework.chunksPath === null) throw new Error('missing mapping corpus')
  const parsedQuality = JSON.parse(quality) as Record<string, unknown>
  const childScript: ScriptStep[] = [
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
    toolCall('read-forbidden-framework', 'read', { file_path: `${workspacePath}/${framework.chunksPath}/chunk_0001.md` }),
    ...(repair ? [
      toolCall('search-unknown-scope', 'search_sources', { scope_ref: 'F999', keywords: ['实施'] }),
      toolCall('read-forged-path', 'read_source', { source_ref: 'F1', file_path: corpus.chunks[0]!.path }),
    ] : []),
    toolCall('read-heading', 'read_source', { source_ref: 'F2:H1:full' }),
    toolCall('search-local', 'search_sources', { scope_ref: 'F1', keywords: ['实施流程'] }),
    toolCall('read-chunk', 'read_source', { source_ref: 'M1:chunk_0001' }),
    ...(repair ? [
      toolCall('lock-before-research-ready', 'lock_section_outline', { comparison: '尚未提交研究充分性判断。' }),
    ] : []),
    toolCall('research-not-ready', 'submit_section_research_assessment', researchAssessment(false, true)),
    toolCall('search-research-gap', 'search_sources', { scope_ref: 'ALL', keywords: ['权限', '审计'] }),
    toolCall('research-ready', 'submit_section_research_assessment', researchAssessment(true, false)),
    ...(repair ? [
      toolCall('lock-without-comparison', 'lock_section_outline', {}),
    ] : []),
    toolCall('lock-initial-outline', 'lock_section_outline', {
      comparison: '用户原框架包含访问控制与安全审计、资产盘点及其子项；当前招标范围为访问控制与安全审计。输入旧标按身份治理与安全运维组织，本分支对应其中的访问控制与安全审计，保留已聚焦的候选叶子，不引入其他主题。',
    }),
    toolCall('submit-invalid-usage', 'submit_section_mapping', {
      ...sectionSubmission(sourceUrl),
      local_materials: [{ material_ref: 'M1:chunk_0001', usage: 'reference_bid', summary: '非法枚举回放。' }],
      web_materials: [],
    }),
    toolCall('search-source', 'web_search', { queries: ['访问控制安全审计官方标准'] }),
    ...(repair ? [toolCall('submit-before-fetch', 'submit_section_mapping', sectionSubmission(sourceUrl))] : []),
    toolCall('fetch-source', 'web_fetch', { url: sourceUrl }),
    ...(!repair ? [
      toolCall('search-unused', 'web_search', { queries: ['未采用的公开资料'] }),
      toolCall('fetch-unused', 'web_fetch', { url: unusedSourceUrl }),
    ] : []),
    toolCall('submit-after-fetch', 'submit_section_mapping', sectionSubmission(sourceUrl)),
    toolCall('update-task', 'update_section_task', {
      section_id: 'SEC-SECURITY', basis: { kind: 'tender_requirement', explanation: '招标要求访问控制方案与安全审计，明确已有安全任务的组织方式。', requirement_ids: ['REQ-1'] },
      writing_brief: (({ requirement_ids: _requirements, scoring_ids: _scores, scoring_response_point_ids: _points, ...brief }) => brief)(
        partialResult(sourceUrl).section_mappings[0]!.writing_brief,
      ),
      writing_dimensions: ['身份鉴别与访问控制', '安全审计'], missing_topics: [],
    }),
    toolCall('finish-initial-mapping', 'finish_mapping_task', {}),
    ...(repair ? [toolCall('submit-refinement-incomplete', 'structured_output', {
      ...parsedQuality, checked_requirement_ids: [],
    })] : []),
    toolCall('submit-refinement-quality', 'structured_output', parsedQuality),
    toolCall('reject-incomplete-final-check', 'finish_final_check', {}),
    toolCall('list-final-items', 'list_review_items', {}),
    reviewPendingMappingItems,
    toolCall('finish-final-check', 'finish_final_check', {}),
  ]
  const parentScript: StreamChunk[][] = []
  const adapter = new ScriptedAdapter(sessionId, parentScript, childScript)
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
  return { agent, workspace, sourceUrl, outcome, parentScript, childScript }
}

/**
 * 通过真实 Writer 工具和 Reviewer 私有分批提交，补充 S4 未映射的本地资料。
 * @param ctx - Loader 组装的 Agent、工具、持久化和 Subagent 服务。
 * @param root - 本用例的隔离工作区。
 * @returns 章节阶段产物及工作区；S4 map 变更时抛错。
 */
export async function runChapterWritingLoop(ctx: Context, root: string) {
  const sessionId = SessionId('s5-real-loop')
  const workspace = new BidWorkspace(root)
  await prepareS2(workspace)
  const requirements = parseTenderRequirementsArtifact(JSON.parse(
    await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8'),
  ))
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({
    schema_version: 1,
    compliance_items: [{
      id: 'GLOBAL-1', type: '全局约束', raw_text: '全书安全术语保持一致', normalized_rule: '全书安全术语保持一致',
      severity: 'mandatory', source_refs: requirements.requirements[0]!.source_refs,
    }],
  }))
  const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')))
  outline.global_compliance_ids = ['GLOBAL-1']
  const section = outline.sections[0]!
  Object.assign(section, partialResult('https://official.example/standard').section_mappings[0]!.writing_brief)
  const outlineHash = outlineArtifactSha256(outline)
  const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
  const unavailableSources = ['missing', 'hash'].map((kind) => {
    const url = `https://official.example/${kind}`
    const hash = webEvidenceContentSha256('公开技术资料原文')
    const id = webEvidenceSourceId(url, hash)
    return { source_id: id, requested_url: url, final_url: url, content_sha256: hash,
      snapshot_path: `analysis/web-sources/${id}.md`, status_code: 200, truncated: false, fetched_at: '2026-09-01T00:00:00.000Z' }
  })
  const missing = unavailableSources[0]!
  await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
  await writeFile(join(workspace.projectRoot, unavailableSources[1]!.snapshot_path), '与账本 Hash 不符的正文')
  const evidenceBefore = JSON.stringify({ schema_version: EVIDENCE_MAPPING_SCHEMA_VERSION, section_mappings: [{
    section_id: section.id, local_materials: [], web_materials: [{ source_id: missing.source_id, snapshot_path: missing.snapshot_path,
      usage: 'reference', summary: 'S4 已映射的公开审计资料。', supports: '安全审计要求' }],
    missing_topics: ['缺少实施流程参考资料。'], writing_dimensions: ['身份鉴别与访问控制', '安全审计'],
  }] })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline)),
    writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({
      schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
      confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
    })),
    writeFile(evidencePath, evidenceBefore),
    writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ schema_version: 2, stage: 'evidence_mapping', sources: unavailableSources })),
    writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify({
      schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
      confirmed_outline_sha256: outlineHash,
      user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
      user_requirements: ['整份约 20 页，重点展开访问控制，使用正式技术方案风格，按这些要求直接开始。'],
      global_instructions: ['完整响应访问控制与安全审计要求。', '使用正式、可执行的技术方案表述。'],
      document_acceptance: [{
        id: 'AC-000001', scope: { kind: 'document' }, description: '整书形成一致且完整的技术响应。',
        priority: 'required', evaluator: { kind: 'semantic' },
      }],
      sections: [{
        section_id: section.id, task: '完整响应访问控制与安全审计要求。',
        user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
        user_requirements: ['重点展开访问控制。'],
        writing_instructions: ['展开访问控制实施流程。'],
        acceptance_criteria: [{
          id: 'AC-000002', scope: { kind: 'section', section_id: section.id }, description: '详细说明访问控制实施流程。',
          priority: 'required', evaluator: { kind: 'semantic' },
        }],
      }],
      revision: null,
    })),
  ])
  const manifest = await workspace.readManifest()
  const [corpus] = await resolveMappingCorpusLocations(workspace, manifest)
  const tender = manifest.files.find(file => file.role === 'tender')!
  if (corpus === undefined || tender.chunksPath === null) throw new Error('缺少 S5 回放资料')
  const workspacePath = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const candidate = {
    markdown: '# 访问控制与安全审计\n\n本项目先核查角色与访问权限，再组织安全审计和结果复核。实施流程以本地资料为编排参考，按权限授予、执行检查、记录留存三个步骤说明责任与交付结果。',
    metadata: {
      local_materials_used: [{ file_ref: 'F1', chunk: corpus.chunks[0]!.id, usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。' }],
    },
  }
  const coverage = { status: 'covered', evidence_quote_refs: ['Q2'], issue: null }
  const summary = {
    quality_checks: {
      bidder_response_voice: true,
      project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
      placeholder_free: true, obvious_repetition_free: true,
    },
    blocking_issues: [],
    assignment_conflicts: [],
  }
  const parentScript = [
    toolCall('add-plan-note', 'add_global_consistency_note', { note: '统一使用访问控制项目名称和权限审计术语。' }),
    toolCall('finish-plan', 'finish_chapter_plan', {}),
    toolCall('review-global', 'review_global_compliance', {
      compliance_id: 'GLOBAL-1', category: 'cross_chapter_constraint', owners: [{ kind: 'document', section_id: null }],
      status: 'pass', checked_section_ids: ['SEC-SECURITY'], evidence_refs: ['D1'], affected_section_ids: [], issue: null,
    }),
    toolCall('finish-global-review', 'finish_global_compliance_review', {}),
    toolCall('finish-writing-plan', 'submit_chapter_writing_completion_review', {
      action: 'complete', reason: '章节与整书 required 条件均已满足。',
      document_acceptance: [
        { criterion_id: 'AC-000001', status: 'met', evidence_quote_refs: [], reason: '整书术语与技术响应一致。' },
      ],
    }),
  ]
  const childScript = [
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
    toolCall('grep-supplement', 'grep', { pattern: '实施流程', path: corpus.chunks_path }),
    toolCall('read-supplement', 'read', { file_path: corpus.chunks[0]!.path }),
    toolCall('reject-bad-reference', 'submit_chapter', { ...candidate, metadata: { local_materials_used: [{ ...candidate.metadata.local_materials_used[0], file_ref: 'F999' }] } }),
    toolCall('reject-bad-web-reference', 'submit_chapter', { ...candidate, metadata: { web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '不可用的公开资料', supports: '安全审计要求' }] } }),
    toolCall('reject-new-atx-heading', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n## 补充服务方案\n\n我方组织访问控制实施。` }),
    toolCall('reject-new-setext-heading', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n补充服务方案\n---\n\n不属于确认目录的目录层级。` }),
    toolCall('reject-internal-id', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n我方按 REQ-1 组织访问控制实施。` }),
    toolCall('submit-chapter', 'submit_chapter', candidate),
    toolCall('review-incomplete', 'finish_chapter_review', {}),
    toolCall('submit-coverage', 'review_coverage_items', { items: Array.from({ length: section.must_answer.length + section.requirement_ids.length + (section.scoring_response_point_ids ?? []).length + 1 }, (_, index) => ({ item_ref: `R${index + 1}`, ...coverage })) }),
    toolCall('review-global-constraint', 'review_global_constraints', {
      items: [{ compliance_id: 'GLOBAL-1', status: 'not_applicable', evidence_quote_refs: [], issue: '当前章节没有冲突表述。' }],
    }),
    toolCall('review-acceptance', 'review_acceptance_criteria', {
      items: [{ criterion_id: 'AC-000002', status: 'met', evidence_quote_refs: ['Q2'], reason: '正文详细说明了访问控制实施流程。' }],
    }),
    toolCall('submit-summary', 'set_review_summary', summary),
    toolCall('finish-review', 'finish_chapter_review', {}),
  ]
  const adapter = new ScriptedAdapter(sessionId, parentScript, childScript)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, 'https://official.example/standard')
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 0, maxConcurrency: 1 })
  if (await readFile(evidencePath, 'utf8') !== evidenceBefore) throw new Error('S5 补搜修改了 S4 evidence map')
  return { agent, artifacts, workspace, requests: adapter.requests, parentScript, childScript }
}

/**
 * 通过真实工具循环验证 S3 初稿遗漏后的局部续修与用户确认停点。
 * @param ctx Loader 组装的 Agent、工具及持久化服务。
 * @param root 场景隔离工作区。
 * @returns 阶段失败与重试结果、正式产物及实际模型任务数。
 */
export async function runOutlineGenerationLoop(ctx: Context, root: string) {
  const workspace = new BidWorkspace(root)
  await prepareS2(workspace)
  const prefix = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')))
  await rm(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'))
  await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
  const texts = ['身份鉴别', '角色权限', '账号生命周期', '最小权限', '会话控制', '数据分类', '敏感数据保护', '访问日志', '安全告警', '异常处置', '审计留存与追溯']
  const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
  scoring.scoring_items[0]!.raw_text = '技术方案逐项说明：' + texts.join('、') + '。'
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring))
  const pointIds = texts.map((_text, index) => 'RP-' + String(index + 1).padStart(6, '0'))
  const section = outline.sections[0]!
  section.scoring_response_point_ids = pointIds.slice(0, 10)
  section.must_answer = texts.slice(0, 10).map(text => '说明' + text + '的实施措施。')
  section.scoring_ids = []
  const untouched = { ...section, id: 'SEC-SERVICE', order: 2, title: '服务组织', purpose: '说明服务组织与协同安排。',
    must_answer: ['说明服务岗位与协调流程。'], requirement_ids: [], scoring_response_point_ids: [], scoring_response_points: [] }
  outline.sections.push(untouched)
  const candidate = { ...outline, sections: outline.sections.map(({ scoring_response_points: _points, ...item }) => item) }
  candidate.sections[0] = {
    ...candidate.sections[0]!, title: 'REQ-1 安全方案',
    scoring_response_point_ids: [...pointIds.slice(0, 10), 'RP-999999'], scoring_ids: ['SCORE-UNKNOWN'], requirement_ids: [],
  }
  const responseCandidate = { schema_version: 1, points: texts.map((text, index) => ({ scoring_id: 'SCORE-1', order: index + 1, text: '说明' + text })) }
  const sessionId = SessionId('s3-outline-recovery')
  const parentScript = [
    toolCall('response-points', 'write', { file_path: prefix + '/analysis/scoring-response-points.candidate.json', content: JSON.stringify(responseCandidate) }),
    finalText('评分响应点候选已完成。'),
    finalText('评分原文逐项复核完成。'),
    toolCall('draft', 'write', { file_path: prefix + '/outline/outline.json', content: JSON.stringify(candidate) }),
    finalText('初步目录候选已完成。'),
  ]
  const adapter = new ScriptedAdapter(sessionId, parentScript, [])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, [])
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  for (const stage of ['file_intake', 'tender_analysis'] as const) {
    agent.session.append('bid.stage.started', { stage, status: 'running' })
    agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
  }
  let maxRepairAttempts = 0
  const orchestrator = new BidOrchestrator(agent.session,
    { canExecute: stage => stage === 'outline_generation', execute: task => executeOutlineGeneration(agent, workspace, task, { maxRepairAttempts }) },
    { validate: (stage, artifacts) => validateOutlineGeneration(workspace, stage, artifacts) })
  const failed = await orchestrator.runCurrentAutomaticStage()
  if (failed.status !== 'failed' || !failed.failureReason?.includes('RP-999999')) throw new Error('未知 RP 未进入可续修的失败状态')
  const catalogBefore = await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')
  const baseline = outline
  parentScript.push(
    toolCall('forbidden-catalog-write', 'write', { file_path: prefix + '/analysis/scoring-response-points.json', content: '{}' }),
    toolCall('candidate-repair', 'write', { file_path: prefix + '/outline/candidate-repair.json', content: JSON.stringify([
      { section_index: 0, field: 'scoring_response_point_ids', value: pointIds.slice(0, 10) },
      { section_index: 0, field: 'scoring_ids', value: ['SCORE-1'] },
    ]) }),
    finalText('根据正式评分原文重新明确选择合法 RP 与评分关联。'),
    toolCall('requirement-repair', 'write', { file_path: prefix + '/outline/repair-operations.json', content: JSON.stringify([
      { type: 'update_section', section_id: section.id, requirement_ids: section.requirement_ids },
    ]) }),
    finalText('将招标要求关联至现有安全方案章节。'),
    toolCall('customer-text-repair', 'write', { file_path: prefix + '/outline/repair-operations.json', content: JSON.stringify([{
      type: 'update_section', section_id: section.id, title: section.title,
    }]) }),
    finalText('已用客户可理解的自然语言替换内部编号标题。'),
    toolCall('local-repair', 'write', { file_path: prefix + '/outline/repair-operations.json', content: JSON.stringify([{
      type: 'update_section', section_id: section.id, scoring_response_point_ids: pointIds,
      must_answer: [...section.must_answer, '说明审计日志留存期限、归档责任和事件追溯流程。'],
    }]) }),
    finalText('已提交审计留存与追溯的局部修复。'),
    toolCall('quality-review', 'submit_outline_quality_review', { issues: [] }),
    finalText('逐项复核章节归属和写作指导已完成。'),
  )
  maxRepairAttempts = 4
  const outcome = await orchestrator.retry()
  const result = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
  const report = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')) as unknown
  const catalogUnchanged = catalogBefore === await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')
  const untouchedUnchanged = JSON.stringify(baseline.sections[1]) === JSON.stringify(result.sections[1])
  if (!catalogUnchanged || !untouchedUnchanged || outcome.status !== 'waiting_user') throw new Error('S3 续修改变了无关内容或跳过用户确认')
  return { failed, outcome, catalogUnchanged, untouchedUnchanged, outline: result, report,
    confirmationEvents: agent.session.events.filter(event => event.type === 'bid.user_confirmation.received').length }
}
