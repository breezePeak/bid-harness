import { scriptedVerificationCall } from './task-verifier.ts'
import { mappingModelReply } from './mapping-model-positions.ts'
import { chapterModelReply } from './chapter-model-positions.ts'
import { nestedModelSections } from './outline-model-tree.ts'
/** S4/S5 真实工具循环与 Loader 回放共用的外部结果和输入资料。 */
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, HarnessError, LlmAdapter, WebError, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SearchError } from '@deepseek-ai/dsh-tool-fs-search'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-web'
import {
  BidOrchestrator, BidWorkspace, createScoringResponsePointCatalog, executeEvidenceMapping,
  validateEvidenceMapping, resolveMappingCorpusLocations, buildBidStageTask, executeChapterWriting,
  executeOutlineGeneration, validateOutlineGeneration,
  executeTenderAnalysis, validateTenderAnalysis, outlineArtifactSha256, parseOutlineArtifact,
  parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact,
  parseTenderScoringArtifact, parseTenderScoringSelection,
  webEvidenceContentSha256, webEvidenceSourceId, createTestBidRunContext,
  parseEvidenceMapArtifact, parseChapterMetadata,
  checkpointBidProjectState, readBidProjectState,
} from '@deepseek-ai/dsh-bid'
import { persistBidWorkRequest } from '../../src/work-descriptor.ts'

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
function reviewPendingMappingItems(options: GenerateOptions): StreamChunk[] {
  for (const message of [...options.messages].reverse()) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      for (const content of block.content) {
        if (content.type !== 'text' || !content.text.startsWith('{')) continue
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
  reviewOverflow = false
  structureRecovery = false
  outlineReview?: { contextWindow: number; quality: object }
  readonly requests: GenerateOptions[] = []
  readonly reviewScript: ScriptStep[] = []
  constructor(
    private readonly parentId: SessionId,
    private readonly parentScript: ScriptStep[],
    private readonly childScript: ScriptStep[],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      ...(this.outlineReview === undefined ? {} : { context: { contextWindow: this.outlineReview.contextWindow } }) })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.outlineReview !== undefined && options.system?.includes('技术标目录轻量复核 Subagent')) {
      yield* mappingModelReply(toolCall('review-large-original', 'structured_output', this.outlineReview.quality), options)
      return
    }
    if (this.reviewOverflow && options.system?.includes('技术标目录轻量复核 Subagent')) {
      this.reviewOverflow = false
      yield { type: 'finish', reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: '注入的 provider context overflow' } } }
      return
    }
    if (this.structureRecovery && options.system?.includes('技术标目录轻量复核 Subagent')) {
      const prompt = options.messages.flatMap(message => message.content)
        .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      const repaired = prompt.includes('由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。')
      yield* mappingModelReply(toolCall(repaired ? 'review-actual-repair' : 'review-unresolved-structure', 'structured_output', {
        issues: [], blocking_issues: repaired ? [] : [{ section_id: 'SEC-SECURITY',
          reason: '当前职责尚未明确授权核验与审计追溯的执行责任。' }],
      }), options)
      return
    }
    const verification = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('核验输入：'))
    if (verification?.type === 'text') {
      const input = JSON.parse(verification.text.slice(verification.text.indexOf('核验输入：') + '核验输入：'.length)) as Parameters<typeof scriptedVerificationCall>[0]
      const call = scriptedVerificationCall(input, options.messages)
      yield* toolCall('verification', call.name, call.args)
      return
    }
    if (!this.interactive && options.sessionId === this.parentId && options.messages.at(-1)?.source.kind === 'subagent-settled') {
      yield* finalText('等待 Host 下发目录深化任务。')
      return
    }
    const script = options.sessionId === this.parentId ? this.parentScript
      : this.reviewScript.length > 0 && (options.system?.includes('技术标目录质量复核 Subagent')
        || options.system?.includes('技术标章节独立审查 Subagent') || options.system?.includes('独立 S5 Chapter Reviewer')
        || options.system?.includes('段落修订 Delta Reviewer'))
        ? this.reviewScript : this.childScript
    const response = script.shift()
    if (response === undefined && this.interactive) {
      yield* finalText('等待用户确认。')
      return
    }
    if (response === undefined) throw new Error('Bid scripted adapter exhausted')
    const chunks = typeof response === 'function' ? response(options) : response
    yield* mappingModelReply(chapterModelReply(chunks, options), options)
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
export function registerIntegrationTools(ctx: Context, root: string, sourceUrls: string | readonly string[], webFailure?: {
  code: string
  statusCode?: number | undefined
  remaining: number
  tool?: 'web_search' | 'web_fetch'
  retryAfter?: string
  production?: true
}): void {
  const urls = typeof sourceUrls === 'string' ? [sourceUrls] : [...sourceUrls]
  let searchIndex = 0
  if (webFailure?.production !== true) ctx.provide('web', {
    diagnose: async () => ({
      search: { selectedProviderId: 'fixture-web-search', providers: [] },
      fetch: { selectedProviderId: 'fixture-web-fetch', providers: [] },
    }),
  })
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
  if (webFailure?.production === true) {
    ctx.effect(() => ctx.web.registerSearchProvider({ id: 'fixture-web-search', available: () => true,
      search: async () => ({
        sources: urls.length === 0 ? [] : [{ url: urls[Math.min(searchIndex++, urls.length - 1)]! }], truncated: false,
      }) }))
    ctx.effect(() => ctx.web.registerFetchProvider({ id: 'fixture-web-fetch', available: () => true,
      fetch: async ({ url }) => {
        if (webFailure.remaining-- > 0) throw new WebError('注入的联网故障', webFailure.code, {
          ...(webFailure.statusCode === undefined ? {} : { statusCode: webFailure.statusCode }), retryAfter: webFailure.retryAfter ?? '0',
        })
        if (!urls.includes(url)) throw new Error('固定场景未提供该外部来源正文。')
        return { url, statusCode: 200, body: { kind: 'text', content: '官方标准要求访问控制与安全审计。' }, truncated: false }
      } }))
    return
  }
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
    execute: async () => {
      if (webFailure !== undefined && webFailure.tool !== 'web_fetch' && webFailure.remaining-- > 0) {
        throw Object.assign(new HarnessError('注入的联网故障', webFailure.code), {
          statusCode: webFailure.statusCode, retryAfter: webFailure.retryAfter ?? '0',
        })
      }
      return { sources: urls.length === 0 ? [] : [{ url: urls[Math.min(searchIndex++, urls.length - 1)]! }], truncated: false }
    },
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
      if (webFailure?.tool === 'web_fetch' && webFailure.remaining-- > 0) {
        throw Object.assign(new HarnessError('注入的联网故障', webFailure.code), {
          statusCode: webFailure.statusCode, retryAfter: webFailure.retryAfter ?? '0',
        })
      }
      if (!urls.includes(args.url)) throw new Error('固定场景未提供该外部来源正文。')
      return { url: args.url, statusCode: 200, body: { kind: 'text' as const, content: '官方标准要求访问控制与安全审计。' }, truncated: false }
    },
  })))
}

/**
 * 通过真实 Agent loop 提交 S2 分析，覆盖重复上传身份与文件位置绑定。
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
  const files = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tenderText) },
    { name: 'appendix.md', role: 'tender', bytes: new TextEncoder().encode('实施过程应提交验收记录。') },
    { name: 'tender-copy.md', role: 'tender', bytes: new TextEncoder().encode(tenderText) },
  ])
  const tender = files[2]
  if (tender === undefined || tender.chunkIndexPath === null) throw new Error('S2 integration corpus missing')
  const index = JSON.parse(await readFile(join(workspace.projectRoot, tender.chunkIndexPath), 'utf8')) as {
    chunks: Array<{ id: string }>
  }
  const chunk = index.chunks[0]?.id
  if (chunk === undefined) throw new Error('S2 integration chunk missing')
  const source = (anchor_text: string) => ({ file_position: 2, chunk_position: 0, anchor_text })
  const sessionId = SessionId('s2-real-loop')
  const parentScript = [
    toolCall('submit-analysis', 'submit_tender_analysis', {
      project_facts: [{
        field: 'project_name', value: '智慧审计平台建设项目', sources: [source('智慧审计平台建设项目')],
      }],
      requirements: [{
        category: '功能要求', normalized_requirement: '系统必须支持统一身份认证和审计日志。', mandatory: true,
        sources: [source('系统必须支持统一身份认证和审计日志。')],
      }],
      scoring_items: [{
        group: '技术评分', title: '总体技术方案', criterion: '总体技术方案完整合理得 10 分。',
        score: 10, score_range: null, must_answer: true,
        sources: [source('技术评分：总体技术方案完整合理得 10 分。')],
      }],
      compliance_items: [{
        type: '强制要求', normalized_rule: '技术方案必须提供数据安全措施。', severity: 'mandatory',
        sources: [source('技术方案必须提供数据安全措施。')],
      }],
    }),
    finalText('S2 complete submission saved.'),
  ]
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(sessionId, parentScript, [])))
  registerIntegrationTools(ctx, root, [])
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  const artifacts = await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), {
    maxRepairAttempts: 0, run: createTestBidRunContext(),
  })
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
  const manifest = await workspace.readManifest()
  if (!isDeepStrictEqual(manifest.files.map(file => ({ id: file.id, inputPath: file.inputPath })),
    files.map(file => ({ id: file.id, inputPath: file.inputPath })))) throw new Error('S2 integration upload records changed')
  return {
    calls: agent.session.events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : []),
    validation,
    artifacts: artifacts.map(artifact => artifact.path),
    uploaded_tender_files: manifest.files.map(file => file.originalName),
    project: {
      name: project.project_name,
      tender_files: project.analyzed_tender_files.length,
      source_lines: project.source_refs.map(ref => [ref.line_start, ref.line_end]),
      source_files: project.source_refs.map(ref => manifest.files.find(file => file.chunksPath !== null
        && ref.chunk.startsWith(`${file.chunksPath}/`))?.originalName),
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
  if (tender.chunkIndexPath === null || tender.chunksPath === null) throw new Error('S4 integration tender corpus missing')
  const tenderIndex = JSON.parse(await readFile(join(workspace.projectRoot, tender.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
  const sourceRef = { file_id: tender.id, chunk: `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`, line_start: 1, line_end: 1 }
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '访问控制项目', tender_name: null, purchaser: null, owner: null, project_background: ['安全建设'], project_objectives: ['访问控制'], project_scope: ['技术方案'], technical_scope: ['安全'], delivery_scope: ['方案'], implementation_constraints: [], key_technical_points: ['访问控制'], source_refs: [sourceRef], analyzed_tender_files: [tender.id] }))
  await writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '访问控制', normalized_requirement: '提供访问控制方案', mandatory: true, source_refs: [sourceRef] }] }))
  const scoring = { schema_version: 1 as const, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '安全', raw_text: '安全审计', criterion: '方案完整', score: 5, score_range: null, must_answer: true, source_refs: [sourceRef] }] }
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring))
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-origin.json'), JSON.stringify(scoring))
  await writeFile(join(workspace.projectRoot, 'analysis/tender-analysis-selection.json'),
    JSON.stringify({ schema_version: 1, selected_scoring_ids: ['SCORE-1'] }))
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [{ scoring_id: 'SCORE-1', order: 1, text: '说明访问控制' }] })))
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] }))
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify({ schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-SECURITY', parent_id: null, order: 1, level: 1, title: '访问控制与安全审计', purpose: '响应安全技术要求。', writable: true, must_answer: ['说明访问控制与安全审计措施。'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明访问控制' }], suggested_tables: [], suggested_figures: [], writing_notes: [] }] })),
    writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 4, scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'], checked_scoring_response_point_ids: ['RP-000001'], reviewed_section_ids: ['SEC-SECURITY'], issues: [] })),
  ])
  return { chunk, requirementId: 'REQ-1', scoringId: 'SCORE-1', responsePointId: 'RP-000001' }
}

function expectedWebChunkRef(url: string): string {
  const content = '官方标准要求访问控制与安全审计。'
  return `W:${webEvidenceSourceId(url, webEvidenceContentSha256(content))}:C0001`
}

function transientWebMaterial(url: string) {
  return {
    chunk_refs: [expectedWebChunkRef(url)], usage: 'reference' as const, summary: '要求访问控制与审计。', supports: '支持安全方案。',
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

function researchAssessment(sufficient: boolean, affectsBlueprint: boolean, mode?: 'zero' | 'local' | 'external_unbound') {
  return {
    sufficient_for_blueprint: sufficient,
    evidence_requirement: mode === 'local' ? { kind: 'local_sufficient', reason: '已读取本地实施方法，本章不需要外部技术事实。' }
      : mode === 'external_unbound' ? { kind: 'external_required', reason: '本章安全方案需要引用公开标准的控制条款。' }
        : { kind: 'not_required', reason: '授权与审计安排属于依据招标任务提出的专业方案，参考资料只补充背景。' },
    diagnostics: {
      tender_and_response_points: '已理解访问控制与安全审计要求及评分响应点。',
      technical_approach: '已研究身份鉴别、权限控制和安全审计的技术路线。',
      evidence_and_inferences: '本地资料支持实施组织，公开标准用于技术背景，未把参考项目写成本项目事实。',
      project_specific_quality_risks: '已检查访问控制验证、审计完整性和项目资料边界。',
    },
    key_findings: [{ finding: '访问控制的授权操作需要通过审计记录验证。',
      explanation: '从身份鉴别、权限授予到操作记录，明确权限执行和追溯验证的方法。',
      nature: 'professional_design', basis: sufficient && mode === 'local' ? [{ kind: 'local_material', ref: 'M1:chunk_0001' }]
        : sufficient && mode === 'external_unbound' ? [{ kind: 'web_material', ref: expectedWebChunkRef('https://official.example/standard') }]
          : [{ kind: 'requirement', ref: 'REQ-1' }],
      evidence_boundary: '授权与审计安排是本方案设计，不声称项目已有账号规模或系统能力。' }],
    unresolved_gaps: [{
      topic: '当前项目的既有账号与权限清单未提供',
      affects_blueprint: affectsBlueprint,
      writing_impact: '不虚构具体账号规模，S5 按已确认边界编写核查方法。',
    }],
  }
}

/**
 * 在已组装的服务上执行 S4，模型与 Web 返回使用固定数据。
 * @param ctx - 真实 Agent、工具、持久化和 Subagent 服务。
 * @param root - 本用例的隔离工作区。
 * @param repair - 搜索错误后调整查询，跨 Child 轮次抓取 URL，并修复目录 Schema。
 * @param structureRecovery - 保留首代修复失败及后续补修脚本，供真实 Main 恢复或新授权使用。
 * @param largeReview - 装载超过常规分片目标的完整采购原文，并声明足够的模型上下文。
 * @returns 阶段结果、Host、工作区及模型实际请求。
 */
export async function runEvidenceMappingLoop(ctx: Context, root: string, repair: boolean, interactive = false,
  fault?: {
    code: string
    statusCode?: number | undefined
    failures: number
    maxRetries?: number
    signal?: AbortSignal
    reviewOverflow?: boolean
    tool?: 'web_search' | 'web_fetch'
    retryAfter?: string
    resume?: true
    production?: true
  }, researchMode?: 'zero' | 'local' | 'external_unbound', structureRecovery = false, largeReview = false) {
  const sessionId = SessionId('s3-real-loop')
  const workspace = new BidWorkspace(root)
  const s2 = fault?.resume === true ? { requirementId: 'REQ-1', scoringId: 'SCORE-1', responsePointId: 'RP-000001' }
    : await prepareS2(workspace)
  if (fault?.resume !== true) await workspace.import([{
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
  const useWeb = researchMode !== 'zero' && researchMode !== 'local'
  const submittedMaterials = sectionSubmission(sourceUrl)
  if (!useWeb || researchMode === 'external_unbound') submittedMaterials.web_materials = []
  if (researchMode === 'zero') submittedMaterials.local_materials = []
  const workspacePath = relative(root, workspace.projectRoot).replaceAll('\\', '/')
  const quality = JSON.stringify({ scope: 'technical_bid', checked_requirement_ids: [s2.requirementId], checked_scoring_ids: [s2.scoringId], checked_scoring_response_point_ids: [s2.responsePointId], issues: [{ severity: 'advisory', message: '建议以权限表说明授权与追溯关系。' }], blocking_issues: [] })
  const manifest = await workspace.readManifest()
  const [corpus] = await resolveMappingCorpusLocations(workspace, manifest)
  const tender = manifest.files.find(file => file.role === 'tender')!
  const framework = manifest.files.find(file => file.role === 'outline_framework')!
  if (corpus === undefined || tender.chunksPath === null || framework.chunksPath === null) throw new Error('missing mapping corpus')
  if (largeReview) {
    const path = join(workspace.projectRoot, tender.chunksPath, 'chunk_0001.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\n${'采购原文完整保留。'.repeat(6_000)}原文末尾验收要求。`)
  }
  const parsedQuality = JSON.parse(quality) as Record<string, unknown>
  const blueprint = {
    section_id: 'SEC-SECURITY', basis: { kind: 'tender_requirement', explanation: '招标要求访问控制方案与安全审计，明确已有安全任务的组织方式。', requirement_ids: ['REQ-1'] },
    writing_brief: (({ requirement_ids: _requirements, scoring_ids: _scores, scoring_response_point_ids: _points, ...brief }) => brief)(
      partialResult(sourceUrl).section_mappings[0]!.writing_brief,
    ),
    writing_dimensions: ['身份鉴别与访问控制', '安全审计'], missing_topics: [],
    coverage_override: { requirement_ids: ['REQ-1'], scoring_ids: [], scoring_response_point_ids: ['RP-000001'] },
  }
  const answerPlan = {
    section_id: 'SEC-SECURITY', basis: blueprint.basis,
    answer_plan: ['R1', 'R2', 'R3'].map(ref => ({ target_refs: [ref], mode: 'proposal',
      content: '拟采用身份鉴别、分级授权和可追溯审计方法。',
      basis: [{ kind: 's2', artifact: 'requirement', record_id: 'REQ-1' },
        { kind: 's2', artifact: 'scoring', record_id: 'SCORE-1' }, { kind: 'section_responsibility' }],
      boundary: '具体既有能力与指标须以本项目核实资料为准。' })),
  }
  const structure = { decision: 'keep', reason: '本章聚焦权限执行与追溯验证，不同操作通过同一权限记录闭环说明。',
    navigation_analysis: '读者通过访问控制与安全审计标题可定位本项安全任务；账号核验、授权、记录属于同一方法的普通步骤，无需独立成果章节。',
    hidden_heading_pressure: false, topic_dispositions: [{ finding_index: 1, placement: 'within_section', reason: '段落和角色权限表可完整表达授权与追溯关系，无需隐藏正式子标题。' }],
  }
  const childScript: ScriptStep[] = [
    ...Array.from({ length: fault?.failures ?? 0 }, (_, index) =>
      fault?.tool === 'web_fetch'
        ? toolCall(`fault-fetch-${String(index)}`, 'web_fetch', { url: sourceUrl })
        : toolCall(`fault-search-${String(index)}`, 'web_search', { queries: ['注入网络故障'] })),
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
    toolCall('read-forbidden-framework', 'read', { file_path: `${workspacePath}/${framework.chunksPath}/chunk_0001.md` }),
    ...(repair ? [
      toolCall('search-unknown-scope', 'search_sources', { scope_ref: 'F999', keywords: ['实施'] }),
      toolCall('read-forged-path', 'read_source', { source_ref: 'F1', file_path: corpus.chunks[0]!.path }),
      toolCall('read-search-only-scope', 'read_source', { source_ref: 'ALL' }),
    ] : []),
    toolCall('read-heading', 'read_source', { source_ref: 'F2:H1:full' }),
    toolCall('search-local', 'search_sources', { scope_ref: 'F1', keywords: ['实施流程'] }),
    toolCall('read-chunk', 'read_source', { source_ref: 'M1:chunk_0001' }),
    ...(repair ? [
      toolCall('lock-before-research-ready', 'lock_section_outline', { comparison: '尚未提交研究充分性判断。' }),
    ] : []),
    toolCall('research-not-ready', 'submit_section_research_assessment', researchAssessment(false, true, researchMode)),
    toolCall('search-research-gap', 'search_sources', { scope_ref: 'ALL', keywords: ['权限', '审计'] }),
    ...(useWeb ? [toolCall('search-source', 'web_search', { queries: ['访问控制安全审计官方标准'] }),
      toolCall('fetch-source', 'web_fetch', { url: sourceUrl }),
      toolCall('list-source-chunks', 'list_web_chunks', { source_ref: expectedWebChunkRef(sourceUrl).slice(0, -6) }),
      toolCall('read-web-chunk', 'read_source', { source_ref: expectedWebChunkRef(sourceUrl) })] : []),
    toolCall('refresh-source-positions', 'list_mapping_objects', {}),
    ...(!repair && useWeb ? [
      toolCall('search-unused', 'web_search', { queries: ['未采用的公开资料'] }),
      toolCall('fetch-unused', 'web_fetch', { url: unusedSourceUrl }),
    ] : []),
    toolCall('research-ready', 'submit_section_research_assessment', researchAssessment(true, false, researchMode)),
    toolCall('update-task', 'update_section_task', blueprint),
    toolCall('prepare-answer-plan', 'update_section_task', answerPlan),
    ...(repair ? [
      toolCall('repeat-equivalent-task', 'update_section_task', blueprint),
      toolCall('reject-target-change-with-plan', 'update_section_task', {
        ...blueprint, writing_brief: { ...blueprint.writing_brief, must_answer: ['说明成果核验步骤。', ...blueprint.writing_brief.must_answer] },
        answer_plan: answerPlan.answer_plan,
      }),
      toolCall('list-after-rejected-target-change', 'list_mapping_objects', {}),
      toolCall('insert-answer-target', 'update_section_task', {
        ...blueprint, writing_brief: { ...blueprint.writing_brief, must_answer: ['说明成果核验步骤。', ...blueprint.writing_brief.must_answer] },
      }),
      toolCall('reject-expired-target-position', 'update_section_task', {
        section_id: blueprint.section_id, basis: blueprint.basis,
        answer_plan: [{ ...answerPlan.answer_plan[0]!, target_refs: undefined, target_positions: [0] }],
      }),
      (options: GenerateOptions) => {
        for (const message of [...options.messages].reverse()) for (const block of [...message.content].reverse()) {
          if (block.type !== 'tool-result') continue
          for (const content of block.content) {
            if (content.type !== 'text' || !content.text.startsWith('{')) continue
            const result = JSON.parse(content.text) as { objects?: { targets: Array<{ position: number }> } }
            if (result.objects === undefined) continue
            return toolCall('prepare-current-answer-targets', 'update_section_task', {
              section_id: blueprint.section_id, basis: blueprint.basis,
              answer_plan: result.objects.targets.map(target => ({ ...answerPlan.answer_plan[0]!,
                target_refs: undefined, target_positions: [target.position] })),
            })
          }
        }
        throw new Error('任务修改后缺少当前目标位置表')
      },
      toolCall('reorder-answer-targets', 'update_section_task', {
        ...blueprint, writing_brief: { ...blueprint.writing_brief, must_answer: [...blueprint.writing_brief.must_answer, '说明成果核验步骤。'] },
      }),
      toolCall('restore-answer-targets', 'update_section_task', blueprint),
    ] : []),
    toolCall('assess-structure', 'submit_section_structure_assessment', structure),
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
    ...(repair ? [toolCall('submit-before-fetch', 'submit_section_mapping', sectionSubmission(unusedSourceUrl))] : []),
    toolCall('submit-after-fetch', 'submit_section_mapping', submittedMaterials),
    ...(repair ? [
      toolCall('revise-blueprint', 'update_section_task', { ...blueprint, writing_dimensions: ['授权方法与条件', '安全审计'] }),
      toolCall('reject-stale-lock', 'lock_section_outline', { comparison: '必须重新核对新 Blueprint。' }),
      toolCall('restore-blueprint', 'update_section_task', blueprint),
      toolCall('restore-answer-plan', 'update_section_task', answerPlan),
      toolCall('reassess-current-structure', 'submit_section_structure_assessment', structure),
      toolCall('lock-current-structure', 'lock_section_outline', { comparison: '当前 Blueprint 的目录承载判断有效。' }),
    ] : []),
    toolCall('finish-initial-mapping', 'finish_mapping_task', {}),
    ...(researchMode === 'external_unbound' ? [finalText('所需外部标准正文尚未绑定到章节材料，保留当前缺口。')] : []),
    ...(repair && !largeReview ? [toolCall('submit-refinement-incomplete', 'structured_output', {
      ...parsedQuality, scope: 'commercial_bid',
    })] : []),
    ...(largeReview ? [] : [toolCall('submit-refinement-quality', 'structured_output', parsedQuality)]),
    toolCall('reject-incomplete-final-check', 'finish_final_check', {}),
    toolCall('list-final-items', 'list_review_items', {}),
    ...(useWeb ? [toolCall('reread-final-web-chunk', 'read_source', { source_ref: expectedWebChunkRef(sourceUrl) })] : []),
    reviewPendingMappingItems,
    toolCall('finish-final-check', 'finish_final_check', {}),
  ]
  if (structureRecovery) {
    const reviewIndex = childScript.findIndex(step => Array.isArray(step) && step.some(chunk =>
      chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.id === 'submit-refinement-quality'))
    const repairTask = (generation: number): ScriptStep[] => [
      toolCall(`repair-${generation}-read`, 'read_source', { source_ref: 'M1:chunk_0001' }),
      toolCall(`repair-${generation}-research`, 'submit_section_research_assessment', researchAssessment(true, false, researchMode)),
      toolCall(`repair-${generation}-task`, 'update_section_task', { ...blueprint, writing_brief: {
        ...blueprint.writing_brief, writing_notes: [generation === 1
          ? '核验授权申请与审批记录，保留待明确的审计追溯责任。'
          : '由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。'],
      } }),
      toolCall(`repair-${generation}-plan`, 'update_section_task', answerPlan),
      toolCall(`repair-${generation}-structure`, 'submit_section_structure_assessment', structure),
      toolCall(`repair-${generation}-lock`, 'lock_section_outline', { comparison: '沿用已研究的访问控制资料，按本次问题明确核验与追溯责任。' }),
      toolCall(`repair-${generation}-mapping`, 'submit_section_mapping', submittedMaterials),
      toolCall(`repair-${generation}-finish`, 'finish_mapping_task', {}),
    ]
    childScript.splice(reviewIndex, 1, ...repairTask(1), ...repairTask(2))
  }
  const parentScript: ScriptStep[] = []
  const adapter = new ScriptedAdapter(sessionId, parentScript, childScript)
  if (largeReview) adapter.outlineReview = { contextWindow: 32_768, quality: parsedQuality }
  adapter.structureRecovery = structureRecovery
  adapter.reviewOverflow = fault?.reviewOverflow === true
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, [sourceUrl, unusedSourceUrl], fault === undefined ? undefined
    : { code: fault.code, statusCode: fault.statusCode, remaining: fault.failures,
      ...(fault.tool === undefined ? {} : { tool: fault.tool }),
      ...(fault.retryAfter === undefined ? {} : { retryAfter: fault.retryAfter }),
      ...(fault.production === undefined ? {} : { production: fault.production }) })
  const agentOptions = { provider: 'mock', model: 'mock', ...(interactive ? { agentPreset: 'bid' } : {}) }
  const agent = fault?.resume === true
    ? (await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })).agent
    : interactive
      ? (await ctx.agentLoop.createAgent(ctx, { sessionId, agentOptions, meta: { cwd: root, agentPreset: 'bid' } })).agent
      : ctx.agentLoop.create(sessionId, agentOptions, { cwd: root })
  // Loader 装配的 Host 必须完成项目初始化，才能设置本场景的 S4 起点。
  const host = ctx.get('bid') as unknown as { inFlight: ReadonlyMap<unknown, { session: Session; done: Promise<void> }> } | undefined
  await [...host?.inFlight.values() ?? []].find(operation => operation.session === agent.session)?.done
  if (fault?.resume !== true) {
    agent.session.append('bid.stage.started', { stage: 'file_intake', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'file_intake', status: 'completed', artifacts: [] })
    agent.session.append('bid.stage.started', { stage: 'tender_analysis', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    agent.session.append('bid.stage.started', { stage: 'outline_generation', status: 'running' })
    agent.session.append('bid.stage.completed', { stage: 'outline_generation', status: 'completed', artifacts: [] })
  }
  const orchestrator = new BidOrchestrator(
    agent.session,
    { canExecute: stage => stage === 'evidence_mapping', execute: (task, run) => executeEvidenceMapping(agent, workspace, task, {
      maxRepairAttempts: repair || structureRecovery ? 1 : 0, maxConcurrency: 2,
      ...(fault?.maxRetries === undefined ? {} : { maxInfrastructureRetryAttempts: fault.maxRetries }),
      ...(run.resumeOf === undefined ? {} : { resume: true }),
      run: fault?.signal === undefined ? run : { ...run, signal: AbortSignal.any([run.signal, fault.signal]) },
    }) },
    { validate: (stage, artifacts) => validateEvidenceMapping(workspace, stage, artifacts) },
    undefined, undefined, undefined,
    structureRecovery ? async (stage) => {
      const payload = { stage }
      const inputs = await Promise.all(buildBidStageTask(stage).inputs.map(async path => ({ path,
        sha256: createHash('sha256').update(await readFile(join(workspace.projectRoot, path))).digest('hex'),
      })))
      return persistBidWorkRequest(workspace, 'stage_execution', stage, payload, { stage, inputs, payload }, `snapshot-${sessionId}-structure`)
    } : undefined,
  )

  const suspended = agent.session.events.findLast(event => event.type === 'bid.run.suspended' || event.type === 'bid.run.started')
  const outcome = fault?.resume === true && (suspended?.type === 'bid.run.suspended' || suspended?.type === 'bid.run.started')
    ? await orchestrator.resume(suspended.data.run.runId)
    : await orchestrator.runCurrentAutomaticStage()
  adapter.interactive = interactive
  return { agent, workspace, sourceUrl, outcome, requests: adapter.requests,
    parentScript, childScript, reviewScript: adapter.reviewScript }
}

/**
 * 在完整研究及首代结构修复失败后，通过正式 Main 恢复工具定向补修原 Work。
 * @param ctx 包含 Bid Host 的真实 Loader 装配。
 * @param root 临时项目目录。
 * @returns 原失败结果、恢复后状态及真实请求；恢复未完成时抛错。
 */
export async function runEvidenceMappingStructureRecoveryLoop(ctx: Context, root: string) {
  const result = await runEvidenceMappingLoop(ctx, root, false, true, undefined, 'local', true)
  if (result.outcome.status !== 'failed') throw new Error('结构恢复夹具未产生首代修复后的失败：' + JSON.stringify(result.outcome))
  const failedLog = JSON.parse(await readFile(join(result.workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
    tasks: Array<{ task_id: string; status: string }>
    failure?: unknown
  }
  if (!failedLog.tasks.some(task => task.task_id.startsWith('MAP-REPAIR-') && task.status === 'completed')) {
    throw new Error('首代结构修复未完成：' + JSON.stringify(failedLog))
  }
  const saved = await checkpointBidProjectState(result.workspace, result.outcome)
  result.agent.session.append('bid.project.resumed', { state: result.outcome, revision: saved.revision })
  await result.agent.whenIdle()
  const instruction = '保留已研究资料，明确授权岗位核验与审计岗位追溯责任，只补修失败章节后重新复核。'
  result.parentScript.push(toolCall('inspect-structure-recovery', 'bid_stage_inspect', { view: 'recovery' }),
    toolCall('accept-structure-recovery', 'bid_recover_task', { target: 'run', instruction }), finalText('已接纳定向补修，等待实际修改及复核结果。'))
  const done = Promise.withResolvers<undefined>()
  const off = ctx.on('session/event', (session, event) => {
    if (session === result.agent.session && event.type === 'bid.user_confirmation.required' && event.data.stage === 'evidence_mapping') done.resolve(undefined)
    if (session === result.agent.session && event.type === 'bid.task.changed' && event.data.state.status === 'failed') {
      done.reject(new Error('S4 定向补修失败：' + JSON.stringify(event.data.state.failure)))
    }
  }, { global: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    result.agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
    await Promise.race([done.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('S4 定向补修未完成：' + JSON.stringify(result.agent.session.events
        .filter(event => event.type === 'tool/result' || event.type === 'bid.task.changed').slice(-5)))) }, 45_000)
    })])
    const operations = (ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
    await Promise.all([...operations.values()].map(operation => operation.done))
    await result.agent.whenIdle()
    await ctx.sessions.flush(result.agent.session)
  } finally { clearTimeout(timer); off() }
  return { ...result, instruction, outcome: await readBidProjectState(result.workspace), firstOutcome: result.outcome }
}

/**
 * 通过真实 Writer 工具和 Reviewer 分批提交，验证补搜资料回流及网页引用在修复中的往返。
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
  await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
  const evidenceBefore = JSON.stringify({ section_mappings: [{
    section_id: section.id, local_materials: [], web_materials: [],
    missing_topics: ['缺少实施流程参考资料。'], writing_dimensions: ['身份鉴别与访问控制', '安全审计'],
    answer_plan: [{ targets: [{ kind: 'must_answer', position: 0, text: section.must_answer[0] },
      { kind: 'requirement', id: 'REQ-1' }, { kind: 'response_point', id: 'RP-000001' }],
    mode: 'proposal', content: '按访问控制任务设计权限授予、检查与审计留存流程。',
    basis: [{ kind: 'section_responsibility', section_id: section.id }],
    boundary: '实际系统能力和实施参数仍以本项目资料核实。' }],
  }] })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(outline)),
    writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({
      schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
      confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
    })),
    writeFile(evidencePath, evidenceBefore),
    writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ stage: 'evidence_mapping', sources: [] })),
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
  const webUrl = 'https://official.example/standard'
  const candidate = {
    markdown: '# 访问控制与安全审计\n\n本项目先核查角色与访问权限，再组织安全审计和结果复核。实施流程以本地资料为编排参考，按权限授予、执行检查、记录留存三个步骤说明责任与交付结果。\n\n表 访问控制与安全审计管理台账\n| 管理事项 | 台账记录内容 |\n| --- | --- |\n| 权限授予 | 访问权限 |\n| 执行检查 | 安全审计 |\n| 记录留存 | 复核结果 |',
    metadata: {
      local_materials_used: [{ file_ref: 'F1', chunk: corpus.chunks[0]!.id, usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。' }],
      additional_web_materials: [{ url: webUrl, usage: 'reference', summary: '要求访问控制与审计。', supports: '支持安全方案。' }],
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
    external_input_gaps: [],
    external_input_only: false,
  }
  const parentScript = [
    toolCall('add-plan-note', 'add_global_consistency_note', { note: '统一使用访问控制项目名称和权限审计术语。' }),
    toolCall('finish-plan', 'finish_chapter_plan', {}),
    toolCall('read-global-chapter', 'read_completed_chapter', { section_position: 0, start: 0, length: 12_000 }),
    toolCall('review-global', 'review_global_compliance', {
      compliance_position: 0, category: 'cross_chapter_constraint', owners: [{ kind: 'document', section_position: null }],
      status: 'pass', checked_section_positions: [0], evidence_refs: ['DQ1'], affected_section_positions: [], issue: null,
    }),
    toolCall('finish-global-review', 'finish_global_compliance_review', {}),
    toolCall('finish-writing-plan', 'submit_chapter_writing_completion_review', {
      action: 'complete', reason: '章节与整书 required 条件均已满足。',
      document_acceptance: [
        { criterion_position: 0, status: 'met', evidence_quote_refs: [], reason: '整书术语与技术响应一致。' },
      ],
    }),
  ]
  const childScript = [
    toolCall('read-forbidden-tender', 'read', { file_path: `${workspacePath}/${tender.chunksPath}/chunk_0001.md` }),
    toolCall('grep-supplement', 'grep', { pattern: '实施流程', path: corpus.chunks_path }),
    toolCall('read-supplement', 'read', { file_path: corpus.chunks[0]!.path }),
    toolCall('fetch-writing-source', 'web_fetch', { url: webUrl }),
    toolCall('reject-bad-reference', 'submit_chapter', { ...candidate, metadata: { local_materials_used: [{ ...candidate.metadata.local_materials_used[0], file_ref: 'F999' }] } }),
    toolCall('reject-bad-web-reference', 'submit_chapter', { ...candidate, metadata: { web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '不可用的公开资料', supports: '安全审计要求' }] } }),
    toolCall('reject-new-atx-heading', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n## 补充服务方案\n\n我方组织访问控制实施。` }),
    toolCall('reject-new-setext-heading', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n补充服务方案\n---\n\n不属于确认目录的目录层级。` }),
    toolCall('reject-internal-id', 'submit_chapter', { ...candidate, markdown: `${candidate.markdown}\n\n我方按 REQ-1 组织访问控制实施。` }),
    toolCall('submit-chapter', 'submit_chapter', candidate),
    toolCall('research-read-local', 'read_source', { source_ref: 'M1:chunk_0001' }),
    toolCall('research-read-web', 'read_source', { source_ref: expectedWebChunkRef(webUrl) }),
    toolCall('research-ready', 'submit_section_research_assessment', researchAssessment(true, false)),
    toolCall('research-plan', 'update_section_task', {
      section_id: section.id, basis: { kind: 'tender_requirement', explanation: '核对访问控制任务的实施组织。', requirement_ids: ['REQ-1'] },
      answer_plan: ['R1', 'R2', 'R3'].map(ref => ({ target_refs: [ref], mode: 'proposal',
        content: '结合已验证的实施流程资料，拟采用权限授予、执行检查和审计留存方法。',
        basis: [{ kind: 'section_responsibility' }], boundary: '本地参考流程不证明项目已有系统能力。' })),
    }),
    toolCall('research-structure', 'submit_section_structure_assessment', {
      decision: 'keep', reason: '补搜资料用于本章实施流程，无需改变确认目录。',
      navigation_analysis: '当前标题覆盖访问控制与安全审计，实施步骤保留在本章正文。',
      hidden_heading_pressure: false, topic_dispositions: [],
    }),
    toolCall('research-lock', 'lock_section_outline', { comparison: '确认目录的章节职责和标题保持一致。' }),
    toolCall('research-submit', 'submit_section_mapping', {
      section_id: section.id,
      local_materials: [{ material_ref: 'M1:chunk_0001', usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。' }],
      web_materials: [transientWebMaterial(webUrl)],
    }),
    toolCall('research-finish', 'finish_mapping_task', {}),
    toolCall('research-quality', 'structured_output', {
      scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'],
      checked_scoring_response_point_ids: ['RP-000001'], issues: [], blocking_issues: [],
    }),
    toolCall('research-final-list', 'list_review_items', {}),
    toolCall('research-final-read-web', 'read_source', { source_ref: expectedWebChunkRef(webUrl) }),
    reviewPendingMappingItems,
    toolCall('research-final-finish', 'finish_final_check', {}),
    (options: GenerateOptions) => {
      const text = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      const line = text.split('\n').findLast(line => line.startsWith('当前候选：'))
      if (line === undefined) throw new Error('修复请求缺少程序投影的候选')
      const projected = JSON.parse(line.slice('当前候选：'.length)) as { markdown: string; metadata: object }
      return toolCall('resubmit-web-candidate', 'submit_chapter', { ...projected, markdown: projected.markdown + '\n\n质量检查由实施负责人组织，审计结果由复核人员确认。' })
    },
  ]
  const reviewRound = (blocking_issues: string[]): ScriptStep[] => [
    toolCall('review-incomplete', 'finish_chapter_review', {}),
    toolCall('submit-coverage', 'review_coverage_items', { items: Array.from({ length: section.must_answer.length + section.requirement_ids.length + (section.scoring_response_point_ids ?? []).length + 1 }, (_, index) => ({ item_ref: `R${index + 1}`, ...coverage })) }),
    toolCall('review-global-constraint', 'review_global_constraints', {
      items: [{ compliance_position: 0, status: 'not_applicable', evidence_quote_refs: [], issue: '当前章节没有冲突表述。' }],
    }),
    toolCall('review-acceptance', 'review_acceptance_criteria', {
      items: [{ criterion_position: 0, status: 'met', evidence_quote_refs: ['Q2'], reason: '正文详细说明了访问控制实施流程。' }],
    }),
    toolCall('submit-summary', 'set_review_summary', { ...summary, blocking_issues }),
    toolCall('finish-review', 'finish_chapter_review', {}),
  ]
  const reviewScript = [...reviewRound(['补充质量检查责任。']), ...reviewRound([])]
  const adapter = new ScriptedAdapter(sessionId, parentScript, childScript)
  adapter.reviewScript.push(...reviewScript)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, 'https://official.example/standard')
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), {
    maxRepairAttempts: 1, maxConcurrency: 1, run: createTestBidRunContext(),
  })
  const mapped = parseEvidenceMapArtifact(JSON.parse(await readFile(evidencePath, 'utf8')))
  const metadata = parseChapterMetadata(JSON.parse(await readFile(join(workspace.projectRoot,
    'chapters/meta/0001.json'), 'utf8')))
  if (JSON.stringify(mapped.section_mappings[0]?.local_materials) !== JSON.stringify(metadata.local_materials_used)
    || (mapped.section_mappings[0]?.answer_plan?.length ?? 0) === 0) {
    throw new Error('S5 实际使用的补搜资料未回流当前 Evidence')
  }
  return { agent, artifacts, workspace, evidenceSynced: true, requests: adapter.requests, parentScript, childScript,
    reviewScript: adapter.reviewScript }
}

/**
 * 通过真实工具循环验证 S3 初稿遗漏后的局部续修与用户确认停点。
 * @param ctx Loader 组装的 Agent、工具及持久化服务。
 * @param root 场景隔离工作区。
 * @param scenario 正常生成、叶节响应点缺项，或父章修复失败后的原 Work 恢复。
 * @returns 阶段失败与重试结果、正式产物及实际模型任务数。
 */
export async function runOutlineGenerationLoop(ctx: Context, root: string,
  scenario: 'normal' | 'structural-parent' | 'missing-response-point' = 'normal') {
  const workspace = new BidWorkspace(root)
  await prepareS2(workspace)
  const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')))
  await rm(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'))
  await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
  await Promise.all(['outline/outline.json', 'outline/quality-report.json', 'outline/draft.json', 'outline/generation-inputs.json']
    .map(path => rm(join(workspace.projectRoot, path), { force: true })))
  const texts = ['身份鉴别', '角色权限', '账号生命周期', '最小权限', '会话控制', '数据分类', '敏感数据保护', '访问日志', '安全告警', '异常处置', '审计留存与追溯']
  const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8')))
  scoring.scoring_items[0]!.raw_text = '技术方案逐项说明：' + texts.join('、') + '。'
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring))
  const pointIds = texts.map((_text, index) => 'RP-' + String(index + 1).padStart(6, '0'))
  const section = outline.sections[0]!
  section.scoring_response_point_ids = pointIds
  section.must_answer = texts.map(text => '说明' + text + '的实施措施。')
  section.scoring_ids = ['SCORE-1']
  const untouched = { ...section, id: 'SEC-SERVICE', order: 2, title: '服务组织', purpose: '说明服务组织与协同安排。',
    must_answer: ['说明服务岗位与协调流程。'], requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [] }
  outline.sections.push(untouched)
  if (scenario === 'structural-parent') outline.sections.push({ ...untouched,
    id: 'SEC-DETAIL', parent_id: section.id, order: 1, level: 2,
    title: '访问控制实施流程', purpose: '说明身份鉴别与权限授予流程。',
    must_answer: ['说明身份鉴别与权限授予流程。'], requirement_ids: ['REQ-1'],
  })
  const candidate = { document_title: outline.document_title, global_compliance_positions: [],
    sections: nestedModelSections(outline.sections.map(({ id: _id, parent_id, level: _level, order: _order,
      writable: _writable, requirement_ids,
      scoring_ids, compliance_ids, scoring_response_point_ids, scoring_response_points: _points,
      framework_refs: _frameworks, ...item }) => ({ ...item, title: `一、${item.title}`,
      parent_position: parent_id === null ? null : outline.sections.findIndex(section => section.id === parent_id),
      requirement_positions: requirement_ids.map(() => 0), scoring_positions: scoring_ids.map(() => 0),
      compliance_positions: compliance_ids.map(() => 0),
      response_point_positions: scoring_response_point_ids?.map(id => pointIds.indexOf(id)) ?? [], framework_refs: [],
    }))) }
  const responseCandidate = { points: texts.map(text => ({ scoring_position: 0, text: '说明' + text })) }
  const sessionId = SessionId('s3-outline-recovery')
  const parentScript: ScriptStep[] = []
  const repairScript: ScriptStep[] = []
  if (scenario === 'structural-parent') {
    const attempts = [
      [{ type: 'update_section', section_position: 2, response_point_positions: [999_999],
        must_answer: ['说明身份鉴别与权限授予流程。'] }],
      [{ type: 'add_section', parent_position: 1, sibling_position: 1,
        title: '安全审计与追溯措施', purpose: '完整响应各项安全技术措施。',
        must_answer: section.must_answer, requirement_positions: [0], scoring_positions: [0],
        response_point_positions: pointIds.map((_id, index) => index),
      }],
    ]
    for (const [attempt, operations] of attempts.entries()) {
      if (attempt === 1) repairScript.push(toolCall('reject-outline-add-missing-answer', 'structured_output', {
        operations: [{ type: 'add_section', parent_position: 1, sibling_position: 1,
          title: '安全审计与追溯措施', purpose: '完整响应各项安全技术措施。' }],
      }))
      repairScript.push(toolCall(`repair-outline-${attempt + 1}`, 'structured_output', { operations }))
    }
  }
  if (scenario === 'missing-response-point') {
    candidate.sections[0]!.response_point_positions = pointIds.slice(0, -1).map((_id, index) => index)
    repairScript.push(toolCall('reject-outline-update-missing-answer', 'structured_output', { operations: [
      { type: 'update_section', section_position: 1, response_point_positions: pointIds.map((_id, index) => index) },
    ] }))
    repairScript.push(toolCall('repair-outline-response-point', 'structured_output', { operations: [
      { type: 'update_section', section_position: 1, response_point_positions: pointIds.map((_id, index) => index),
        must_answer: section.must_answer, writing_notes: ['明确审计留存期限与追溯责任。'] },
    ] }))
  }
  const childScript = [
    toolCall('response-points-analysis', 'structured_output', responseCandidate),
    toolCall('response-points-review', 'structured_output', responseCandidate),
    toolCall('initial-outline', 'structured_output', candidate),
    ...repairScript,
    toolCall('quality-review', 'structured_output', {
      operations: [{ type: 'update_section', section_position: 1, title: '2.1 1.1 访问控制、安全审计与追溯' }],
      issues: [{ message: '请确认安全审计与追溯安排。' }],
    }),
  ]
  const adapter = new ScriptedAdapter(sessionId, parentScript, childScript)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, root, [])
  const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: root })
  for (const stage of ['file_intake', 'tender_analysis'] as const) {
    agent.session.append('bid.stage.started', { stage, status: 'running' })
    agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
  }
  const orchestrator = new BidOrchestrator(agent.session,
    { canExecute: stage => stage === 'outline_generation', execute: (task, run) => executeOutlineGeneration(agent, workspace, task, { maxRepairAttempts: 0, run }) },
    { validate: (stage, artifacts) => validateOutlineGeneration(workspace, stage, artifacts) })
  let outcome = await orchestrator.runCurrentAutomaticStage()
  let recovery: { failed: boolean; matched_notice: boolean; same_work: boolean; resumed_original_run: boolean } | undefined
  if (scenario === 'structural-parent') {
    const failed = outcome.status === 'failed'
    const started = agent.session.events.findLast(event => event.type === 'bid.run.started')
    const notice = agent.session.events.findLast(event => event.type === 'bid.run.notice')
    if (started?.type !== 'bid.run.started' || notice?.type !== 'bid.run.notice') throw new Error('缺少原失败 Run 和通知')
    const original = started.data.run
    const matchedNotice = notice.data.noticeId === `run:${original.runId}:failed` && notice.data.runId === original.runId
    outcome = await orchestrator.resume(original.runId)
    const resumed = agent.session.events.findLast(event => event.type === 'bid.run.started')
    recovery = { failed, matched_notice: matchedNotice,
      same_work: resumed?.type === 'bid.run.started' && JSON.stringify(resumed.data.run.work) === JSON.stringify(original.work),
      resumed_original_run: resumed?.type === 'bid.run.started' && resumed.data.run.resumeOf?.runId === original.runId,
    }
  }
  if (outcome.status !== 'waiting_user') throw new Error('S3 没有进入用户确认：' + JSON.stringify(outcome))
  const result = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
  const report = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')) as unknown
  const untouchedId = scenario === 'structural-parent' ? 'SEC-003' : 'SEC-002'
  const untouchedUnchanged = isDeepStrictEqual({ ...outline.sections[1], id: untouchedId, order: 3, framework_refs: [] },
    result.sections.find(item => item.id === untouchedId))
  if (!untouchedUnchanged) throw new Error('S3 修改了无关内容')
  return { outcome, untouchedUnchanged, outline: result, report, ...(recovery === undefined ? {} : { recovery }),
    confirmationEvents: agent.session.events.filter(event => event.type === 'bid.user_confirmation.received').length }
}
