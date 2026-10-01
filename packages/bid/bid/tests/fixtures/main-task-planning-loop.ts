/** 自然语言到真实 Host 工具循环的夹具；只有外部模型回复由脚本控制。 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BidWorkspace, checkpointBidProjectState, outlineArtifactSha256, parseOutlineArtifact, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { collectDocxExportSnapshot } from '../../src/docx-export.ts'
import { readChapterLocations } from '../../src/chapter-storage.ts'
import { chapterExecutionPlanSchema } from '../../src/chapter-writing-plan-artifacts.ts'
import { parseChapterReviewArtifact } from '../../src/chapter-writing-review-artifacts.ts'
import { parseWritingPlan } from '../../src/writing-requirements.ts'
import { chapterEvidenceInputFingerprint, pickChapterContext } from '../../src/chapter-writing-executor.ts'
import { parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact,
  parseTenderComplianceArtifact } from '../../src/tender-analysis-artifacts.ts'
import { parseEvidenceMapArtifact } from '../../src/evidence-mapping-artifacts.ts'
import { parseScoringResponsePointCatalog, scoringArtifactSha256 } from '../../src/scoring-response-point-artifacts.ts'
import { parseWebEvidenceSourcesArtifact } from '../../src/web-evidence-source-artifacts.ts'
import { parseOrMigrateChapterExecutionLog } from '../../src/chapter-writing-plan-artifacts.ts'
import { createBidCapabilityDispatcher } from '../../src/bid-capability-dispatcher.ts'
import { modelBidTaskVerifier } from '../../src/bid-task-verification.ts'
import { seedCapabilityProject } from '../capability-fixture.ts'
import { ChapterAdapter } from './chapter-writing-adapter.ts'
import IntegrationFileSystem, { registerIntegrationTools } from './evidence-mapping-loop.ts'
import { mappingModelReply } from './mapping-model-positions.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
/** @template T Host 注入的上下文类型。 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- 解析 JSON 的返回类型由上下文协议确定。
function inputJson<T>(prompt: string, prefix: string): T {
  const line = prompt.split('\n').find(value => value.startsWith(prefix))
  if (line === undefined) throw new Error('模型上下文缺少 ' + prefix)
  return JSON.parse(line.slice(prefix.length)) as T
}

class PlanningAdapter extends ChapterAdapter {
  constructor(private readonly recoveryWorkspace?: BidWorkspace, private readonly repeatCompletedWriting = false,
    private readonly structure: 'split' | 'add' = 'split') { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  readonly inputs: GenerateOptions[] = []
  readonly errors: string[] = []
  private mainStep = 0
  private recoveryAttempts = 0
  private readonly mappingSteps = new Map<string, number>()
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.inputs.push(options)
    const prompt = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (prompt.includes('核验输入：')) {
      const schema = inputJson<{ $schema?: string; additionalProperties?: boolean }>(prompt, '输出 schema：')
      if (schema.$schema !== undefined || schema.additionalProperties !== false
        || !prompt.includes('只返回业务字段，不返回 $schema')) throw new Error('任务核验输出协议混入 schema 元数据或缺少严格字段约束')
      const input = inputJson<{ requirements?: readonly object[]; sources: readonly object[] }>(prompt, '核验输入：')
      const check = { met: true, reason: '脚本要求 Host 另行校验真实新节点及全部新叶节的当前审核' }
      const requirements = [{
        description: '本章建立三个真实目录子节并保留原文、完成正文和审核', object: 'outline' as const,
        new_children: true, completed_content: true, repair: false, preserve_migrated_content: true, check }]
      yield* answer(JSON.stringify(input.requirements === undefined
        ? { scope_authorized: true, sources: input.sources.map(() => ({ relevant: true, requirements })) }
        : { scope_authorized: true, checks: input.requirements.map(() => check) }))
      return
    }
    if (prompt.includes('当前候选目录：') && !prompt.includes('Current Chapter Blueprint：')) {
      const targets = inputJson<object[]>(prompt, '本次可修改章节：')
      yield* answer(JSON.stringify(targets.map((_, index) => ({ requirement_positions: index === 0 ? [0] : [],
        scoring_positions: index === 0 ? [0] : [], response_point_positions: index === 0 ? [0] : [], compliance_positions: [] }))))
      return
    }
    if (prompt.includes('源正文完整 Markdown 块：')) {
      const blocks = inputJson<object[]>(prompt, '源正文完整 Markdown 块：')
      yield* answer(JSON.stringify(blocks.map((_, index) => ({
        disposition: 'move', target_positions: [Math.min(Math.floor(index / 2), 2)] }))))
      return
    }
    if (options.tools?.some(tool => tool.name === 'finish_mapping_task')) {
      const id = String(options.sessionId)
      const step = this.mappingSteps.get(id) ?? 0
      this.mappingSteps.set(id, step + 1)
      if (step > 6) throw new Error('研究脚本未收敛：' + JSON.stringify(options.messages.at(-1)?.content))
      const checklist = inputJson<Array<{ section_id: string; items: Array<{ item_ref: string }> }>>(prompt, 'answer_checklists：')[0]
      if (checklist === undefined) throw new Error('研究任务没有章节回答清单')
      const { section_id, items } = checklist
      const objects = inputJson<{ sections: Array<{ id: string; position: number }> }>(prompt, '对象位置：')
      const section_position = objects.sections.find(section => section.id === section_id)!.position
      if (step === 0) yield* call('submit_section_mapping', { section_position, local_materials: [], web_materials: [] })
      else if (step === 1) yield* call('update_section_task', { section_position, basis: {
        kind: 'section_responsibility', explanation: '本节只说明本阶段的执行方法，不扩展现实企业事实。', requirement_positions: [],
      }, writing_dimensions: ['保留源章执行步骤、产物和校验记录'], answer_plan: items.map(item => ({ target_refs: [item.item_ref], mode: 'proposal',
        content: '沿用源章已分配的流程方法和记录，按本阶段职责形成结果。',
        basis: [{ kind: 'section_responsibility' }], boundary: '方法是本方案设计，不宣称企业已有能力或新事实。' })) })
      else yield* call('finish_mapping_task', {})
      return
    }
    if (options.tools?.some(tool => tool.name === 'finish_final_check')) {
      const id = String(options.sessionId)
      const step = this.mappingSteps.get(id) ?? 0
      this.mappingSteps.set(id, step + 1)
      if (step > 6) throw new Error('Final Check 脚本未收敛：' + JSON.stringify(options.messages.at(-1)?.content))
      if (step === 0) yield* call('list_review_items', {})
      else if (step === 1) {
        const result = options.messages.flatMap(message => message.content)
          .filter(block => block.type === 'tool-result').flatMap(block => block.content)
          .filter(block => block.type === 'text').map(block => JSON.parse(block.text) as { pending_items?: Array<{ review_ref: string }> })
          .findLast(item => item.pending_items !== undefined)
        yield* mappingModelReply(call('review_items', { items: result?.pending_items?.map(item => ({ review_ref: item.review_ref,
          decision: 'keep', reason: '回应计划仅描述原章流程的专业方案，不增加企业事实或额外承诺。' })) ?? [] }), options)
      } else yield* call('finish_final_check', {})
      return
    }
    if (options.tools?.some(tool => tool.name === 'finish_chapter_plan')) {
      const id = String(options.sessionId)
      const step = this.mappingSteps.get(id) ?? 0
      this.mappingSteps.set(id, step + 1)
      if (step > 4) throw new Error('章节关系规划没有收敛')
      yield* step === 0 ? call('add_global_consistency_note', { note: '三个阶段沿用原章术语与流程产物。' })
        : call('finish_chapter_plan', {})
      return
    }
    if (String(options.sessionId) === 'task-planning-main') {
      const state = this.recoveryWorkspace === undefined ? null : await readBidProjectState(this.recoveryWorkspace)
      if (state?.status === 'suspended') {
        if (this.recoveryAttempts++ >= 3) {
          const error = '故障恢复脚本未收敛：' + JSON.stringify(options.messages.at(-1)?.content)
          this.errors.push(error)
          throw new Error(error)
        }
        yield* call('bid_recover_task', { target: 'run',
          instruction: '沿用原 Work、原目标和范围，只恢复被注入故障打断的部分，保留已完成前缀。' })
        return
      }
      const last = options.messages.at(-1)?.source
      if (last?.kind === 'plugin' || last?.kind === 'subagent-settled') {
        yield* answer('已读取任务核验和发布凭据，三个新子章节已写完并通过审核。')
        return
      }
      switch (this.mainStep++) {
        case 0: yield* call('bid_project_inspect', { query: { object: 'outline' } }); return
        case 1: yield* call('bid_project_inspect', { query: { object: 'chapters', section_positions: [2] } }); return
        case 2: yield* call('bid_run_task', { task: { goal: '本章三个阶段建立真实子章并完成正文',
          scope: { kind: 'sections', section_positions: [2] }, steps: [
            { description: '将本章三个阶段拆成真实目录子章', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
              operations: this.structure === 'split' ? [{ type: 'split_section', section_position: 2, children: [
                { title: '收集输入', purpose: '收集输入并回答主题1', must_answer: ['回答主题1', '收集输入'] },
                { title: '校验结果', purpose: '校验结果', must_answer: ['校验结果'] },
                { title: '交付成果', purpose: '交付成果', must_answer: ['交付成果'] },
              ] }] : [
                { type: 'add_section', parent_position: 2, order: 1, writable: true,
                  title: '收集输入', purpose: '收集输入并回答主题1', must_answer: ['回答主题1', '收集输入'] },
                { type: 'add_section', parent_position: 2, order: 2, writable: true,
                  title: '校验结果', purpose: '校验结果', must_answer: ['校验结果'] },
                { type: 'add_section', parent_position: 2, order: 3, writable: true,
                  title: '交付成果', purpose: '交付成果', must_answer: ['交付成果'] },
              ],
            } } },
            { description: '完整迁移本章原文块到 Host 返回的新叶节', scope: { source: 'task' }, call: {
              capability: 'chapter.reorganize', input: { source_section_positions: [2], instruction: '完整保留原文，按三个阶段迁移。' } } },
            { description: '使用已迁移草稿完成新叶节正文及审核', scope: { source: 'previous_targets' }, call: {
              capability: 'chapter.write', input: { instruction: '保留已分配原文，完成每个新叶节及审核；不得新增企业事实。' } } },
            ...(this.repeatCompletedWriting ? [{ description: '再次完善已完成新叶节并保留原文',
              scope: { source: 'previous_targets' as const }, call: { capability: 'chapter.write' as const,
                input: { instruction: '保留此前正文和原始迁移内容，再次完成写作与审核。' } } }] : []),
            { description: '按当前写作计划再次核查新叶节，复用正文而不调用 Writer', scope: { source: 'previous_targets' }, call: {
              capability: 'chapter.review', input: { reason: '核查拆分后的当前正文、审核和写作计划一致。' } } },
          ] } }); return
        default: yield* answer('已读取发布凭据，三个真实子章节已完成。'); return
      }
    }
    if (options.tools?.some(tool => tool.name === 'submit_chapter')) {
      const id = String(options.sessionId)
      const step = this.mappingSteps.get(id) ?? 0
      this.mappingSteps.set(id, step + 1)
      if (step > 6) {
        const error = 'Writer 脚本未收敛：' + JSON.stringify(options.messages.at(-1)?.content).slice(0, 1500)
        this.errors.push(error)
        throw new Error(error)
      }
      const marker = '已分配给本节的原文草稿：\n'
      const start = prompt.lastIndexOf(marker)
      const blockLine = prompt.split('\n').find(line => line.startsWith('原文保留块：'))
      if (start < 0 && blockLine === undefined) throw new Error('新叶节 Writer 没有收到迁移 seed')
      const seed = blockLine === undefined ? prompt.slice(start + marker.length).split('\n\n这是同一章节 Writer 的修复轮次。')[0]!
        .split('\n\n能力执行要求：')[0]!.split('\n\n本节迁移原文的流程图定义；')[0]!.replace(/^#+ .*\n/um, '').trim()
        : (JSON.parse(blockLine.slice('原文保留块：'.length)) as Array<{ position: number }>).
          map(block => '{{reuse:' + String(block.position) + '}}').join('\n\n')
      const blueprint = inputJson<{ title: string }>(prompt, 'Current Chapter Blueprint：')
      const markdown = '# ' + blueprint.title + '\n\n' + seed
      yield* call('submit_chapter', { markdown, metadata: blockLine === undefined && seed.includes('{{flowchart:process-flow}}') ? {
        flowcharts: [{ key: 'process-flow', title: '流程关系', direction: 'TB',
          nodes: [{ key: 'start', type: 'start', text: '启动' }, { key: 'finish', type: 'end', text: '完成' }],
          edges: [{ from: 'start', to: 'finish' }] }],
      } : {} })
      return
    }
    try { yield* super.stream(options) } catch (error) {
      const message = '模型脚本协议不匹配：' + JSON.stringify({ tools: options.tools?.map(tool => tool.name), prompt: prompt.slice(-1800) })
      this.errors.push(message)
      throw new Error(message, { cause: error })
    }
  }
}

/**
 * 建立含 S2.3 原文、表格和流程图的五章已完成项目。
 * @param root 隔离项目根目录。
 * @param completeSourceFacts 真实模型验收使用完整的虚构工作流程采购条款和来源，避免占位条款造成外部资料缺口。
 * @returns 已保存完成态的项目。
 */
export async function seedMainTaskPlanningProject(root: string, completeSourceFacts = false): Promise<BidWorkspace> {
  const workspace = new BidWorkspace(root)
  const { outline } = await seedCapabilityProject(workspace, 'complete')
  const oldOutlineHash = outlineArtifactSha256(outline)
  const renamedHashes = new Map<string, string>()
  const requirement = '按收集输入、校验结果、交付成果三个阶段说明工作流程，明确各阶段输入、执行方法、产物和衔接记录。'
  const scoringRule = '工作流程应覆盖三阶段操作及衔接，说明输入登记、校验报告和成果交接记录。'
  let completeSource: { file_id: string; chunk: string; line_start: number; line_end: number } | undefined
  if (completeSourceFacts) {
    const [file] = await workspace.import([{ name: '测试采购工作流程要求.md', role: 'tender', bytes: new TextEncoder().encode(
      '# 虚构验收项目采购条款\n\n' + requirement + '\n\n' + scoringRule + '\n') }])
    if (file?.chunksPath == null) throw new Error('完整测试采购条款缺少分块')
    completeSource = { file_id: String(file.id), chunk: 'chunk_0001', line_start: 1, line_end: 5 }
  }
  await workspace.import([{ name: '工作流程依据.md', role: 'reference', bytes: new TextEncoder().encode([
    '# 验收示例项目的工作流程依据',
    '该文档仅定义本测试项目的已知输入，不代表现实企业事实。项目采用输入收集、结果校验、成果交付三个阶段。',
    '输入收集阶段接收项目要求清单、原始任务资料和前序交付记录。登记资料名称、提供方、接收时间、版本、完整性状态和去向，形成输入登记清单；提供方按清单补齐缺项，接收方记录补齐结果，再移交校验。',
    '结果校验阶段将输入登记清单逐项与要求清单对照，检查资料完整性、版本一致性及成果可追溯关系。相符项形成校验报告，不相符项登记问题、反馈补正并复核，未通过的项不得作为已通过成果交付。',
    '成果交付阶段整理通过校验的任务成果、输入登记清单、校验报告和交接记录。双方按成果清单逐项核对版本、状态及记录完整性，确认后形成交接记录并归档；存在问题时返回校验处理。',
    '责任角色采用资料提供方、输入接收方、校验方和成果接收方，不设置未经本项目确认的现实人员或数值时限。三阶段通过同一任务标识关联记录。',
    '源章流程图只表示启动到完成的整体关系，迁移时保留原图的启动、完成节点及连线；阶段操作由正文说明，不改变原图含义。',
  ].join('\n\n')) }])
  await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({
    schema_version: 4, scope: 'technical_bid',
    checked_requirement_ids: Array.from({ length: 5 }, (_, index) => 'REQ-' + String(index + 1)),
    checked_scoring_ids: Array.from({ length: 5 }, (_, index) => 'SCORE-' + String(index + 1)),
    checked_scoring_response_point_ids: Array.from({ length: 5 }, (_, index) => 'RP-' + String(index + 1).padStart(6, '0')),
    reviewed_section_ids: Array.from({ length: 5 }, (_, index) => 'SEC-' + String(index + 1)),
    issues: [],
  }))
  for (const path of await readdir(workspace.projectRoot, { recursive: true })) {
    if (!path.endsWith('.json') && !path.endsWith('.md')) continue
    const absolute = join(workspace.projectRoot, path)
    if (!(await lstat(absolute)).isFile()) continue
    const before = await readFile(absolute, 'utf8')
    let renamed = before.replaceAll('FLOW-SEC-1', 'FLOW-S23').replaceAll('SEC-1', 'S2.3')
    if (completeSourceFacts && path.endsWith('.json')) {
      renamed = renamed.replaceAll('"回答主题1"', JSON.stringify(requirement)).replaceAll('"要求1"', JSON.stringify(requirement))
        .replaceAll('"回答评分1"', JSON.stringify(scoringRule)).replaceAll('"评分1"', JSON.stringify(scoringRule))
    }
    const after = path.endsWith('.md') ? renamed.replace('| 步骤 | 产物 |', '表1 校验产物\n\n| 步骤 | 产物 |') : renamed
    if (path.endsWith('.md') && before !== after) renamedHashes.set(
      createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'))
    await writeFile(absolute, after)
  }
  if (completeSource !== undefined) {
    for (const [path, kind] of [['analysis/requirements.json', 'requirements'],
      ['analysis/scoring.json', 'scoring_items'], ['analysis/scoring-origin.json', 'scoring_items']] as const) {
      const absolute = join(workspace.projectRoot, path)
      const artifact = JSON.parse(await readFile(absolute, 'utf8')) as Record<string, Array<{ source_refs: typeof completeSource[] }>>
      artifact[kind]![0]!.source_refs = [completeSource]
      await writeFile(absolute, JSON.stringify(artifact) + '\n')
    }
    const catalogPath = join(workspace.projectRoot, 'analysis/scoring-response-points.json')
    const catalog = parseScoringResponsePointCatalog(JSON.parse(await readFile(catalogPath, 'utf8')))
    catalog.scoring_sha256 = scoringArtifactSha256(parseTenderScoringArtifact(JSON.parse(
      await readFile(join(workspace.projectRoot, 'analysis/scoring.json'), 'utf8'))))
    await writeFile(catalogPath, JSON.stringify(catalog) + '\n')
  }
  const renamedOutline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')))
  const outlineHash = outlineArtifactSha256(renamedOutline)
  renamedHashes.set(oldOutlineHash, outlineHash)
  for (const path of await readdir(workspace.projectRoot, { recursive: true })) {
    if (!path.endsWith('.json')) continue
    const absolute = join(workspace.projectRoot, path)
    if (!(await lstat(absolute)).isFile()) continue
    let text = await readFile(absolute, 'utf8')
    for (const [before, after] of renamedHashes) text = text.replaceAll(before, after)
    await writeFile(absolute, text)
  }
  await writeFile(join(workspace.projectRoot, 'chapters/execution-plan.json'), JSON.stringify(chapterExecutionPlanSchema.parse({
    schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: outlineHash, writing_plan_version: 1,
    global_consistency_notes: ['初始项目各章保持可追踪交付术语。'],
    sections: renamedOutline.sections.filter(section => section.writable).map(section => ({
      section_id: section.id, depends_on: [], related_sections: section.id === 'SEC-2'
        ? [{ section_id: 'S2.3', strength: 'weak', reason: '关联原章的流程交付术语。' }] : [], planning_notes: [],
    })),
  })) + '\n')
  const plan = parseWritingPlan(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')))
  const locations = await readChapterLocations(workspace)
  const completedLocation = locations.get('SEC-2')!
  await writeFile(join(workspace.projectRoot, 'chapters/reuse-seeds.json'), JSON.stringify({
    schema_version: 1, confirmed_outline_sha256: outlineArtifactSha256(renamedOutline), seeds: [{
      section_id: 'SEC-2', source_section_ids: ['completed-source'],
      content_path: completedLocation.contentPath, metadata_path: completedLocation.metadataPath,
      content_sha256: '0'.repeat(64),
    }],
  }) + '\n')
  const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8')) as unknown
  const context = { project: parseTenderProjectArtifact(await read('analysis/project.json')),
    requirements: parseTenderRequirementsArtifact(await read('analysis/requirements.json')),
    scoring: parseTenderScoringArtifact(await read('analysis/scoring.json')),
    compliance: parseTenderComplianceArtifact(await read('analysis/compliance.json')),
    evidence: parseEvidenceMapArtifact(await read('analysis/evidence-map.json')),
    responsePointCatalog: parseScoringResponsePointCatalog(await read('analysis/scoring-response-points.json')).points,
    outline: renamedOutline, writingPlan: plan }
  const manifest = await workspace.readManifest()
  const sources = parseWebEvidenceSourcesArtifact(await read('analysis/web-evidence-sources.json')).sources
  const executionLog = parseOrMigrateChapterExecutionLog(await read('chapters/execution-log.json'))
  const relatedLog = executionLog.sections.find(section => section.section_id === 'SEC-2')!
  relatedLog.related_sections = ['S2.3']
  for (const section of renamedOutline.sections.filter(section => section.writable)) {
    const location = locations.get(section.id)!
    const body = await readFile(join(workspace.projectRoot, location.contentPath), 'utf8')
    const review = parseChapterReviewArtifact(JSON.parse(await readFile(join(workspace.projectRoot, location.reviewPath), 'utf8')))
    const evidence_quotes = [body.split('\n\n')[1]!.trim()]
    const covered = (item: string) => ({ item, status: 'covered' as const, evidence_quotes, issue: null })
    await writeFile(join(workspace.projectRoot, location.reviewPath), JSON.stringify({ ...review,
      must_answer_coverage: section.must_answer.map(covered),
      requirement_coverage: section.requirement_ids.map(id => ({
        ...covered(context.requirements.requirements.find(item => item.id === id)!.normalized_requirement), requirement_id: id,
      })),
      response_point_coverage: (section.scoring_response_point_ids ?? []).map(id => ({
        ...covered(context.responsePointCatalog.find(item => item.id === id)!.text), response_point_id: id,
      })),
      acceptance_criteria_results: plan.sections.find(item => item.section_id === section.id)!.acceptance_criteria.map(item => ({
        criterion_id: item.id, evaluator: item.evaluator.kind, status: 'met', evidence_quotes, measured: null,
        reason: '初始项目的确定性历史审核记录；不作为真实模型验收证据。',
      })),
    }) + '\n')
    const fingerprint = chapterEvidenceInputFingerprint(pickChapterContext({ ...context, section, location }), manifest, sources)
    const log = executionLog.sections.find(item => item.section_id === section.id)!
    for (const attempt of log.attempts) attempt.input.evidence_sha256 = fingerprint
  }
  await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), JSON.stringify(executionLog) + '\n')
  await writeFile(join(workspace.projectRoot, 'chapters/applied-writing-plan.json'), JSON.stringify({
    schema_version: 1, plan_version: plan.plan_version,
  }) + '\n')
  await writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), JSON.stringify({
    schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
    confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
    authorization: { source: 'user_confirmation' },
  }) + '\n')
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
  return workspace
}

/**
 * 使用可控 provider 驱动真实工具循环。
 * @param ctx 已装配真实服务的 Context。
 * @param root 隔离项目根目录。
 * @param fault 故障位置或对已完成新叶节的重复写作。
 * @param structure 在原章下新增子章或一次拆分。
 * @param selectedRoute 是否通过会话模型选择覆盖启动时的路由。
 * @returns 工具序列和正式产物事实。
 */
export async function runMainTaskPlanningLoop(ctx: Context, root: string,
  fault?: 'after_split' | 'after_migration' | 'writing' | 'before_verification' | 'repeat_completed',
  structure: 'split' | 'add' = 'split', selectedRoute = false) {
  const workspace = await seedMainTaskPlanningProject(root)
  const outside = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
  const canonicalBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const adapter = new PlanningAdapter(fault === undefined ? undefined : workspace, fault === 'repeat_completed', structure)
  const executions: string[] = []
  let interrupted = false
  if (fault !== undefined) {
    const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 2,
      evidenceMappingMaxConcurrency: 2, chapterWritingMaxConcurrency: 2, webSearchEnabled: false })
    const interrupt = () => {
      interrupted = true
      throw Object.assign(new Error('验收故障注入：' + fault), { code: 'ETIMEDOUT' })
    }
    ctx.effect(() => ctx.bid.registerCapabilityTaskDispatcher({ ...dispatcher,
      allowedWrites: (...args) => {
        if (!interrupted && (fault === 'after_split' && args[0].capability === 'chapter.reorganize'
          || fault === 'after_migration' && args[0].capability === 'chapter.write')) interrupt()
        return dispatcher.allowedWrites(...args)
      },
      execute: async (...args) => {
        executions.push(args[0].capability)
        const outcome = await dispatcher.execute(...args)
        if (canonicalBody !== await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')) {
          throw new Error('候选步骤在最终核验前改写了正式正文。')
        }
        if (!interrupted && fault === 'writing' && args[0].capability === 'chapter.write') interrupt()
        return outcome
      },
      verifyTask: (...args) => {
        if (!interrupted && fault === 'before_verification' && args[0].phase === 'result') interrupt()
        return modelBidTaskVerifier(...args)
      },
    }))
  }
  ctx.effect(() => ctx.llm.registerAdapter(['planning-mock', 'planning-selected'], adapter))
  if (ctx.get('fs') === undefined) await ctx.plugin(IntegrationFileSystem)
  registerIntegrationTools(ctx, root, [])
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('task-planning-main'),
    agentOptions: { provider: 'planning-mock', model: 'planning-mock' }, meta: { cwd: root, agentPreset: 'bid' } })
  const agent = handle.agent
  if (selectedRoute) ctx.effect(() => installModelSelection(agent.ctx, {
    current: { provider: 'planning-selected', model: 'selected-model' }, assembled: undefined,
  }))
  const text = '只修改本章 S2.3，把三个阶段拆成真实目录子章节，保留原文并完成正文和审核。不要改其他章节。'
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  const host = ctx.bid as unknown as { readonly inFlight: Map<string, { readonly done: Promise<unknown> }> }
  while (host.inFlight.size > 0) {
    await Promise.all([...host.inFlight.values()].map(operation => operation.done))
    await agent.whenIdle()
  }
  const state = await readBidProjectState(workspace)
  if (state?.status !== 'completed') throw new Error('真实任务链路未完成：' + JSON.stringify({ state, errors: adapter.errors }))
  const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')))
  const children = outline.sections.filter(section => section.parent_id === 'S2.3')
  const locations = await readChapterLocations(workspace)
  const bodies = await Promise.all(children.map(async (section) => {
    const location = locations.get(section.id)
    if (location === undefined) throw new Error('新叶节没有实际位置')
    return readFile(join(workspace.projectRoot, location.contentPath), 'utf8')
  }))
  const workbench = await ctx.bid.getReviewWorkbench(agent.session)
  const snapshot = await collectDocxExportSnapshot(workspace)
  await ctx.sessions.flush(agent.session)
  const executionParents = new Set(agent.session.events.flatMap(event => event.type === 'bid.run.started'
    && event.data.run.executionSessionId !== undefined ? [event.data.run.executionSessionId] : []))
  return { state: state?.status, source: text, children: children.map(section => section.title),
    ...selectedRoute ? { selectedRouteInherited: adapter.inputs.length > 0
      && adapter.inputs.every(input => input.provider === 'planning-selected' && input.model === 'selected-model') } : {},
    executionParentModelTurns: adapter.inputs.filter(input => input.sessionId !== undefined
      && executionParents.has(input.sessionId)).length,
    workbench: workbench.outline.filter(section => children.some(child => child.id === section.section_id))
      .map(section => ({ status: section.writing_status, content: section.content_available })),
    seedPreserved: ['流程一：收集输入。', '流程二：校验结果。', '流程三：交付成果。', '表1 校验产物', '| 校验 | 报告 |', '{{flowchart:process-flow}}']
      .every(text => bodies.some(body => body.includes(text))),
    outsidePreserved: outside === await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8'),
    outsideCompleted: parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(
      join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8'))).sections
      .filter(section => !children.some(child => child.id === section.section_id)).every(section => section.status === 'completed'),
    exportedChildren: children.filter(section => snapshot.markdown.includes(section.title)).map(section => section.title),
    calls: agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name),
    userMessages: agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length,
    interrupted, executions,
    workIds: [...new Set(agent.session.events.flatMap(event => event.type === 'bid.run.started' ? [event.data.run.work.workId] : []))],
    verifiers: adapter.inputs.filter(input => input.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('核验输入：')))).length }
}
