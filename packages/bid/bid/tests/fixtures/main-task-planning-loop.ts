/** 自然语言到真实 Host 工具循环的夹具；只有外部模型回复由脚本控制。 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { BidWorkspace, checkpointBidProjectState, outlineArtifactSha256, parseOutlineArtifact, readBidProjectState, type OutlineArtifact } from '@deepseek-ai/dsh-bid'
import { collectDocxExportSnapshot } from '../../src/docx-export.ts'
import { readChapterLocations } from '../../src/chapter-storage.ts'
import { buildWritableSectionWorklist } from '../../src/section-evidence-context.ts'
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
import { capabilityTaskCheckpointSchema, capabilityTaskRequestSchema } from '../../src/bid-capability-task.ts'
import { enqueueCapabilityRequest } from '../../src/bid-capability-queue.ts'
import { readBidChapterCommandJournal } from '../../src/chapter-command-journal.ts'
import type { BidRunContext } from '../../src/run-coordinator.ts'
import { readBidWorkRequest } from '../../src/work-descriptor.ts'
import { bidRecoverableRun } from '../../src/bid-recovery.ts'
import { seedCapabilityProject } from '../capability-fixture.ts'
import { ChapterAdapter } from './chapter-writing-adapter.ts'
import IntegrationFileSystem, { registerIntegrationTools } from './evidence-mapping-loop.ts'
import { mappingModelReply } from './mapping-model-positions.ts'
import { chapterModelReply } from './chapter-model-positions.ts'

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

const clarificationRequest = '本章也需要小章节。把三个阶段拆成真实目录子章节，保留原文、表格和流程图，并完成正文和审核。不要改其他章节；具体是哪章等我确认后再执行。'
const numericClarificationRequest = '我需要将第8章也细化一下，增加几个小章节。'
const numericClarificationOptions = '请选择要细化的章节：1 项目服务方案；2 工作进度计划；3 工作流程。'

class PlanningAdapter extends ChapterAdapter {
  constructor(private readonly recoveryWorkspace?: BidWorkspace, private readonly repeatCompletedWriting = false,
    private readonly structure: 'split' | 'add' = 'split', private partialFailure = false,
    private readonly clarify: boolean | 'numeric' = false, private readonly sixSparse = false,
    private assignmentConflict = false, private readonly completedRepair = false,
    private readonly bindingRepair = false, private unreadVerification = false, private readonly publishedCorrection = false,
    private readonly migrationRestart = false, private readonly rulesUpdate = false) { super() }
  onRecovery?: () => void
  mainSession?: Session
  readonly resumedWriterTitles = new Set<string>()
  private replanned = false
  private bindingInspected = false
  private clarificationAnswered = false
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  readonly inputs: GenerateOptions[] = []
  readonly errors: string[] = []
  unreadVerificationRejected = false
  missingCitationRejected = false
  unfoundedRestrictionRejected = false
  private unfoundedRestrictionSubmitted = false
  private missingCitationSubmitted = false
  private mainStep = 0
  private recoveryAttempts = 0
  private readonly mappingSteps = new Map<string, number>()
  private migrationSubmissions = 0
  private completedRepairReviews = 0
  private correctionStep = 0
  private readonly draftWrites = new Map<string, number>()
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.inputs.push(options)
    const prompt = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (prompt.includes('核验输入：')) {
      const schema = inputJson<{
        $schema?: string
        additionalProperties?: boolean
        properties: Record<string, { minItems?: number; maxItems?: number }>
      }>(prompt, '输出 schema：')
      if (schema.$schema !== undefined || schema.additionalProperties !== false
        || !prompt.includes('只返回业务字段，不返回 $schema')) throw new Error('任务核验输出协议混入 schema 元数据或缺少严格字段约束')
      if (!prompt.includes('result 核验在正式发布之前执行')) throw new Error('任务产物核验混淆候选检查与正式发布')
      if (!prompt.includes('以这些原始绑定为准')) throw new Error('任务核验缺少原始目录绑定的归属依据')
      const input = inputJson<{
        phase: 'plan' | 'result'
        accepted_plan_sha256?: string
        clarification_dialogue?: readonly { role: string; text: string }[]
        requirements?: readonly object[]
        sources: readonly { text?: string; context_messages?: string[] }[]
        evidence: readonly { evidence_position: number; path: string; total_characters: number; text?: string }[]
      }>(prompt, '核验输入：')
      if (this.clarify && (input.sources[0]?.text !== (this.clarify === 'numeric' ? '3' : 'S2.3')
        || JSON.stringify(input.sources[0]?.context_messages) !== JSON.stringify([
          this.clarify === 'numeric' ? numericClarificationRequest : clarificationRequest]))) {
        throw new Error('任务核验丢失原拆章要求或没有绑定最新章节澄清')
      }
      if (input.evidence.some(file => file.text !== undefined)) throw new Error('任务核验首次输入不得内联完整文件')
      if (!options.tools?.some(tool => tool.name === 'read_task_evidence')) throw new Error('核验会话缺少冻结证据只读工具')
      const toolResults = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      if (this.clarify === 'numeric') {
        if (!input.clarification_dialogue?.some(message => message.role === 'assistant'
          && message.text === numericClarificationOptions)) throw new Error('数字选择丢失助手选项')
        if (input.phase === 'result' && input.accepted_plan_sha256 === undefined) throw new Error('产物核验丢失已接纳计划身份')
        this.unfoundedRestrictionRejected ||= toolResults.some(block => block.content.some(content => content.type === 'text'
          && content.text.includes('BID_TASK_VERIFICATION_CONSTRAINT_SOURCE_INVALID')))
      }
      if (toolResults.some(block => block.content.some(content => content.type === 'text'
        && content.text.includes('BID_TASK_VERIFICATION_EVIDENCE_UNREAD') && content.text.includes('start=1')))) this.unreadVerificationRejected = true
      if (input.phase === 'result' && this.unreadVerification) {
        const partial = input.evidence.find(file => file.path.startsWith('chapters/sections/'))!
        if (!toolResults.some(block => block.toolCallId === CallId('read_task_evidence'))) {
          yield* call('read_task_evidence', { evidence_position: partial.evidence_position, start: 0, length: 1 })
          return
        }
        this.unreadVerification = false
        yield* call('structured_output', { checks: input.requirements!.map(() => ({ met: true,
          reason: '故障注入：只读首字符就引用全部证据', evidence_positions: [partial.evidence_position,
            ...input.evidence.filter(file => file !== partial).map(file => file.evidence_position)] })) })
        return
      }
      const reads = options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'tool-result').filter(block => block.toolCallId === CallId('read_task_evidence')).flatMap(block => block.content)
        .filter(block => block.type === 'text').map(block => JSON.parse(block.text) as {
          evidence_position?: number
          text?: string
          end?: number
          next_start?: number | null
        })
      const required = input.phase === 'result' ? input.evidence
        .filter(file => /^chapters\/(?:sections|meta|reviews)\//u.test(file.path))
        : input.evidence.filter(file => file.total_characters > 0).slice(0, 1)
      if (required.length === 0) throw new Error('核验没有真实文件证据')
      const file = required.find(file => !reads.some(read => read.evidence_position === file.evidence_position
        && read.end === file.total_characters))
      if (file !== undefined) {
        const start = reads.findLast(read => read.evidence_position === file.evidence_position)?.next_start ?? 0
        yield* call('read_task_evidence', { evidence_position: file.evidence_position, start, length: 12_000 })
        return
      }
      if (reads.some(read => read.text === undefined || read.text.length > 12_000)) throw new Error('核验只读工具没有返回有界原文')
      const array = schema.properties[input.requirements === undefined ? 'sources' : 'checks']
      const count = input.requirements?.length ?? input.sources.length
      if (array?.minItems !== count || array.maxItems !== count) throw new Error('任务核验未约束完整来源或检查项数量')
      const check = { met: true, reason: '脚本要求 Host 另行校验真实新节点及全部新叶节的当前审核',
        evidence_positions: required.map(file => file.evidence_position) }
      if (this.rulesUpdate && input.phase === 'result') {
        if (!this.missingCitationSubmitted) {
          this.missingCitationSubmitted = true
          yield* call('structured_output', { checks: input.requirements!.map(() => ({ ...check,
            evidence_positions: check.evidence_positions.slice(1) })) })
          return
        }
        this.missingCitationRejected = toolResults.some(block => block.content.some(content => content.type === 'text'
          && content.text.includes('evidence_position') && content.text.includes(required[0]!.path)
          && content.text.includes('本项 evidence_positions')))
        if (!this.missingCitationRejected) throw new Error('缺失引用未返回可修正的准确索引。')
      }
      const requirements = [{
        source_quote: input.sources[0]?.context_messages?.[0] ?? input.sources[0]?.text ?? '', object: 'outline' as const,
        new_children: true, completed_content: true, repair: false, preserve_migrated_content: true, check }]
      if (this.clarify === 'numeric' && input.requirements === undefined && !this.unfoundedRestrictionSubmitted) {
        this.unfoundedRestrictionSubmitted = true
        yield* call('structured_output', { scope_authorized: true, scope_constraints: [{ source_position: 0,
          quote: '仅改目录，不允许写正文', forbidden_capabilities: ['chapter.write'] }],
        sources: input.sources.map(() => ({ relevant: true, requirements })) })
        return
      }
      yield* call('structured_output', input.requirements === undefined
        ? { scope_authorized: true, scope_constraints: [], sources: input.sources.map(() => ({ relevant: true, requirements })) }
        : { checks: input.requirements.map(() => check) })
      return
    }
    if (prompt.includes('当前候选目录：') && !prompt.includes('Current Chapter Blueprint：')) {
      const targets = inputJson<object[]>(prompt, '本次可修改章节：')
      yield* answer(JSON.stringify(targets.map((_, index) => ({ requirement_positions: index === 0 ? [0] : [],
        scoring_positions: index === 0 ? [0] : [], response_point_positions: index === 0 ? [0] : [], compliance_positions: [] }))))
      return
    }
    if (prompt.includes('源正文完整 Markdown 块：')) {
      const targets = inputJson<Array<{ position: number; outline_position: number; title: string }>>(prompt, '当前可写目标章节：')
      if (targets.some((target, index) => target.position !== index || target.outline_position === undefined)
        || targets[0]?.position === targets[0]?.outline_position) throw new Error('原文分配缺少目录位置与局部目标位置的明确对应')
      const blocks = inputJson<Array<{ position: number; type: string; markdown: string }>>(prompt, '源正文完整 Markdown 块：')
      const submission = this.migrationSubmissions++
      if (submission > 4) throw new Error('原文迁移回放的分配未收敛：' + JSON.stringify(options.messages.at(-1)?.content))
      const linked = inputJson<number[][]>(prompt, '必须分配到相同目标的关联块位置：')
      const assignments = Object.fromEntries(blocks.filter(block => !this.sixSparse || submission !== 0
        || block.position < blocks.length - 2).map(block => [String(block.position), {
        disposition: this.sixSparse && submission === 2 ? 'share' : 'move', target_positions: this.sixSparse && submission === 2
          ? [0, 1, 2, 5] : [this.sixSparse
            ? block.type === 'table' || submission > 1 && linked.some(group => group.includes(block.position)
              && group.some(position => blocks[position]?.type === 'table')) ? 2 : block.position === blocks.length - 1 ? 5 : 0
            : Math.min(Math.floor(block.position / 2), 2)],
      }]))
      if (!this.sixSparse) for (const group of linked) {
        const target = group.some(position => blocks[position]?.type === 'table') ? 1
          : assignments[String(Math.min(...group))]?.target_positions[0] ?? 0
        for (const position of group) assignments[String(position)] = { disposition: 'move', target_positions: [target] }
      }
      yield* call('structured_output', { assignments })
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
      if (step === 0) yield* mappingModelReply(call('submit_section_mapping', { section_position, local_materials: [], web_materials: [] }), options)
      else if (step === 1) yield* mappingModelReply(call('update_section_task', { section_position, basis: {
        kind: 'section_responsibility', explanation: '本节只说明本阶段的执行方法，不扩展现实企业事实。', requirement_positions: [],
      }, writing_dimensions: ['保留源章执行步骤、产物和校验记录'], answer_plan: items.map(item => ({ target_refs: [item.item_ref], mode: 'proposal',
        content: '沿用源章已分配的流程方法和记录，按本阶段职责形成结果。',
        basis: [{ kind: 'section_responsibility' }], boundary: '方法是本方案设计，不宣称企业已有能力或新事实。' })) }), options)
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
        : this.rulesUpdate && step === 1 ? call('set_chapter_relations', {
          section_position: buildWritableSectionWorklist(inputJson<OutlineArtifact>(prompt, 'Confirmed Outline：'))
            .findIndex(section => section.title === '校验结果'),
          depends_on: [{ section_position: buildWritableSectionWorklist(inputJson<OutlineArtifact>(prompt, 'Confirmed Outline：'))
            .findIndex(section => section.id === 'SEC-2'),
          reason: '消费范围外已审核章节的最终交接记录；当前资料不提供该章最终决定。' }],
          related_sections: [], planning_notes: [],
        })
          : call('finish_chapter_plan', {})
      return
    }
    if (String(options.sessionId) === 'task-planning-main') {
      if (this.clarify && !this.clarificationAnswered) {
        this.clarificationAnswered = true
        yield* answer(this.clarify === 'numeric' ? numericClarificationOptions : '请确认要拆分的章节。')
        return
      }
      const state = this.recoveryWorkspace === undefined ? null : await readBidProjectState(this.recoveryWorkspace)
      if (this.publishedCorrection && this.correctionStep < 2 && state?.status === 'completed' && prompt.includes('纠正刚才已发布结果')) {
        if (this.correctionStep++ === 0) {
          yield* call('bid_project_inspect', { query: { object: 'task' } })
          return
        }
        yield* call('bid_plan_task', { edit: 'append', steps: [{ description: '在原 Work 复核已发布子章并重新验收',
          scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '按用户纠正要求核对全部新子章。' } } }] })
        return
      }
      const interruptedRun = state == null || this.mainSession === undefined ? undefined
        : bidRecoverableRun(this.mainSession, state)
      if (interruptedRun !== undefined) {
        this.onRecovery?.()
        if (this.migrationRestart && !prompt.includes('重新迁移未完成写作')) {
          yield* answer('已保存候选；原文归属需要重新迁移，等待新的用户执行指令。')
          return
        }
        if (this.migrationRestart && !this.replanned) {
          if (!this.bindingInspected) {
            this.bindingInspected = true
            yield* call('bid_project_inspect', { query: { object: 'outline', source: 'candidate' } })
            return
          }
          this.replanned = true
          const outline = parseOutlineArtifact(JSON.parse(await readFile(join(this.recoveryWorkspace!.projectRoot, 'runs',
            interruptedRun.work.workId, 'work/.bid-harness/outline/confirmed-outline.json'), 'utf8')))
          const sources = outline.sections.flatMap((section, index) => section.id === 'S2.3' || section.parent_id === 'S2.3' ? [index] : [])
          yield* call('bid_plan_task', { edit: 'restart_pending', steps: [
            { description: '从已接纳结果重新迁移全部原文', scope: { source: 'task' }, call: { capability: 'chapter.reorganize',
              input: { instruction: '重新迁移全部原文，保留完整且唯一的原文块及表格流程图。', source_section_positions: sources } } },
            { description: '重新完成全部子章正文与独立审核', scope: { source: 'task' }, call: { capability: 'chapter.write',
              input: { instruction: '按重新迁移结果完成全部子章正文与独立审核。' } } },
          ] })
          return
        }
        if (this.bindingRepair && this.replanned) {
          const result = options.messages.flatMap(message => message.content)
            .findLast(block => block.type === 'tool-result' && block.toolCallId === CallId('bid_plan_task'))
          if (result?.type === 'tool-result'
            && !result.content.some(block => block.type === 'text' && block.text.includes('"accepted":true'))) {
            const error = '业务绑定恢复计划未接纳：' + JSON.stringify(result.content)
            this.errors.push(error)
            throw new Error(error)
          }
        }
        if (this.partialFailure || (this.completedRepair || this.rulesUpdate) && !this.replanned) {
          if (this.bindingRepair && !this.bindingInspected) {
            this.bindingInspected = true
            yield* call('bid_project_inspect', { query: { object: 'outline', source: 'candidate' } })
            return
          }
          this.partialFailure = false
          this.replanned = true
          const outline = parseOutlineArtifact(JSON.parse(await readFile(join(this.recoveryWorkspace!.projectRoot, 'runs',
            interruptedRun.work.workId, 'work/.bid-harness/outline/confirmed-outline.json'), 'utf8')))
          const sectionPosition = outline.sections.findIndex(section => section.title === '校验结果')
          yield* call('bid_plan_task', { edit: this.rulesUpdate ? 'append' : 'replace_pending',
            steps: [...this.rulesUpdate ? [{ description: '统一当前子章写作与验收规则', scope: { source: 'task' }, call: {
              capability: 'writing.plan', input: { update_kind: 'patch', user_message_positions: [0],
                summary: '按已授权原文保留要求补齐当前子章规则。', affected_section_positions: [sectionPosition],
                sections: [{ section_position: sectionPosition, writing_instructions: ['保留原文并说明校验报告与交接记录。'],
                  acceptance_criteria: { add: [{ description: '完整保留原文及校验表，说明校验报告与交接记录。',
                    priority: 'required', evaluator: { kind: 'semantic' } }], update: [], delete_criterion_positions: [] } }],
              } } }] : [], ...this.bindingRepair ? [{ description: '纠正校验结果的需求归属', scope: { source: 'task' }, call: {
              capability: 'outline.update', input: { operations: [], business_bindings: [{ section_position: sectionPosition,
                requirement_positions: this.rulesUpdate ? [] : [0], scoring_positions: [],
                response_point_positions: [], compliance_positions: [] }],
              } } }] : [], { description: '恢复全部新叶节，复用已完成正文审核', scope: { source: 'task' },
              call: { capability: 'chapter.write', input: { instruction: '保留所有迁移原文与已完成结果，仅补未完成章节。' } } },
            { description: '审核全部新叶节的当前正文', scope: { source: 'previous_targets' },
              call: { capability: 'chapter.review', input: { reason: '核对所有新叶节完成正文和审核。' } } },
            ...this.rulesUpdate ? [{ description: '修订交付说明并保留原图',
              scope: { source: 'section_ids', section_positions: [outline.sections.findIndex(section => section.title === '交付成果')] },
              call: { capability: 'chapter.revise', input: { instruction: '保留全部原文和原流程图，在原图旁说明交付前必须完成校验。',
                reference: { scope: 'chapter', section_position: outline.sections.findIndex(section => section.title === '交付成果') } } } }] : []] })
          return
        }
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
      const taskTool = options.tools?.find(tool => tool.name === 'bid_run_task')
      if (taskTool !== undefined && !JSON.stringify(taskTool).includes('"business_bindings"')) {
        throw new Error('公开目录能力未提供已有章节的业务归属选择')
      }
      switch (this.mainStep++) {
        case 0: yield* call('bid_project_inspect', { query: { object: 'outline' } }); return
        case 1: yield* call('bid_project_inspect', { query: { object: 'chapters', section_positions: [2] } }); return
        case 2: yield* call('bid_run_task', { task: { goal: '本章三个阶段建立真实子章并完成正文',
          scope: { kind: 'sections', section_positions: [2] }, steps: [
            { description: '将本章三个阶段拆成真实目录子章', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
              operations: this.structure === 'split' ? [{ type: 'split_section', section_position: 2, children: this.sixSparse
                ? ['收集输入', '边界确认', '校验结果', '内业处理', '复核整改', '交付成果'].map(title => ({ title,
                  purpose: title, must_answer: [title] })) : [
                  { title: '收集输入', purpose: '收集输入并回答主题1', must_answer: ['回答主题1', '收集输入'] },
                  { title: '校验结果', purpose: '校验结果', must_answer: ['校验结果'] },
                  { title: '交付成果', purpose: '交付成果', must_answer: ['交付成果'] },
                ] }] : [
                { type: 'add_section', parent_position: 2, sibling_position: 0,
                  title: '收集输入', purpose: '收集输入并回答主题1', must_answer: ['回答主题1', '收集输入'] },
                { type: 'add_section', parent_position: 2, sibling_position: 1,
                  title: '校验结果', purpose: '校验结果', must_answer: ['校验结果'] },
                { type: 'add_section', parent_position: 2, sibling_position: 2,
                  title: '交付成果', purpose: '交付成果', must_answer: ['交付成果'] },
              ],
            } } },
            { description: '迁移本章原文到新叶节', scope: { source: 'task' }, call: {
              capability: 'chapter.reorganize', input: { source_section_positions: [2], instruction: '完整保留原文，按三个阶段迁移。' } } },
            { description: '使用已迁移草稿完成新叶节正文及审核', scope: { source: 'previous_targets' }, call: {
              capability: 'chapter.write', input: { instruction: '保留已分配原文，完成每个新叶节及审核；不得新增企业事实。' } } },
            ...(this.repeatCompletedWriting ? [{ description: '再次完善已完成新叶节并保留原文',
              scope: { source: 'previous_targets' as const }, call: { capability: 'chapter.write' as const,
                input: { instruction: '保留此前正文和原始迁移内容，再次完成写作与审核。' } } }] : []),
            { description: '复用正文并复核新叶节', scope: { source: 'previous_targets' }, call: {
              capability: 'chapter.review', input: { reason: '核查拆分后的当前正文、审核和写作计划一致。' } } },
          ] } }); return
        default: yield* answer('已读取发布凭据，三个真实子章节已完成。'); return
      }
    }
    if (options.tools?.some(tool => tool.name === 'submit_chapter')) {
      const lastPrompt = options.messages.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
      if (lastPrompt.includes('这是你刚刚生成的流程图真实渲染结果。')) {
        yield* call('submit_chapter', inputJson<object>(lastPrompt, '当前完整 candidate：'))
        return
      }
      const blueprint = inputJson<{ title: string }>(prompt, 'Current Chapter Blueprint：')
      if (this.partialFailure && blueprint.title === '交付成果') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ETIMEDOUT', message: '部分正文完成后的可恢复模型中断' } } }
        return
      }
      if (this.completedRepair && this.completedRepairReviews > 0 && !this.replanned && blueprint.title === '校验结果') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ETIMEDOUT', message: '整改流断开，保留已审核候选' } } }
        return
      }
      if (this.replanned) this.resumedWriterTitles.add(blueprint.title)
      const id = String(options.sessionId)
      const step = this.mappingSteps.get(id) ?? 0
      this.mappingSteps.set(id, step + 1)
      if (step > 12) {
        const error = 'Writer 脚本未收敛：' + JSON.stringify(options.messages.at(-1)?.content).slice(0, 1500)
        this.errors.push(error)
        throw new Error(error)
      }
      const marker = '已分配给本节的原文草稿：\n'
      const start = prompt.lastIndexOf(marker)
      const blockLine = prompt.split('\n').find(line => line.startsWith('原文保留块：'))
      if (start < 0 && blockLine === undefined && !this.sixSparse) throw new Error('新叶节 Writer 没有收到迁移 seed')
      const seed = start < 0 && blockLine === undefined ? `${blueprint.title}：核对本阶段输入，执行处理并登记结果，完成交接确认。`
        : blockLine === undefined ? prompt.slice(start + marker.length).split('\n\n这是同一章节 Writer 的修复轮次。')[0]!
          .split('\n\n能力执行要求：')[0]!.split('\n\n本节迁移原文的流程图定义；')[0]!.replace(/^#+ .*\n/um, '').trim()
          : (JSON.parse(blockLine.slice('原文保留块：'.length)) as Array<{ position: number }>).
            map(block => '{{reuse:' + String(block.position) + '}}').join('\n\n')
      const draftWrite = this.draftWrites.get(blueprint.title) ?? 0
      this.draftWrites.set(blueprint.title, draftWrite + 1)
      if (this.sixSparse && draftWrite > 0 && (!prompt.includes('需要整改的候选新增说明。')
        || blockLine?.includes('需要整改的候选新增说明。'))) throw new Error('候选新增正文被误锁为原文或没有进入修订输入')
      const markdown = '# ' + blueprint.title + '\n\n' + seed + (this.sixSparse
        ? '\n\n' + (draftWrite === 0 ? '需要整改的候选新增说明。' : '整改后的候选新增说明。') : '')
        + (prompt.includes('保留全部原文和原流程图，在原图旁说明交付前必须完成校验。')
          ? '\n\n交付成果前必须完成校验，按已通过的成果清单逐项核对并形成交接记录。' : '')
      yield* chapterModelReply(call('submit_chapter', { markdown, metadata: blockLine === undefined && seed.includes('{{flowchart:process-flow}}') ? {
        flowcharts: [{ key: 'process-flow', title: '流程关系', direction: 'TB',
          nodes: [{ key: 'start', type: 'start', text: '启动' }, { key: 'finish', type: 'end', text: '完成' }],
          edges: [{ from: 'start', to: 'finish' }] }],
      } : {} }), options)
      return
    }
    if (this.sixSparse && options.tools?.some(tool => tool.name === 'finish_chapter_review')
      && prompt.includes('{{flowchart:process-flow}}') && !prompt.includes('当前必须原貌保留的原图：')) {
      throw new Error('独立 Reviewer 没有收到正式原图的只读身份')
    }
    if (options.tools?.some(tool => tool.name === 'review_revision_issues')
      && !options.messages.some(message => message.content.some(block => block.type === 'tool-result'
        && block.toolCallId === CallId('review_revision_issues')))) {
      yield* call('review_revision_issues', { items: [{ issue_position: 0, status: 'satisfied', reason: '保留原文及原图，交付说明符合当前意见。' }] })
      return
    }
    try {
      for await (const chunk of super.stream(options)) {
        if (this.completedRepair && this.completedRepairReviews < 2 && chunk.type === 'block-end' && chunk.block.type === 'tool-call'
          && chunk.block.name === 'set_review_summary'
          && inputJson<{ title: string }>(prompt, 'Current Chapter Blueprint：').title === '校验结果') {
          this.completedRepairReviews += 1
          const args = JSON.parse(chunk.block.arguments) as object
          yield { ...chunk, block: { ...chunk.block, arguments: JSON.stringify({ ...args,
            blocking_issues: ['合并当前候选新增的重复说明，保留所有分配原文。'],
          }) } }
        } else if (this.assignmentConflict && chunk.type === 'block-end' && chunk.block.type === 'tool-call'
          && chunk.block.name === 'set_review_summary') {
          this.assignmentConflict = false
          const section = inputJson<{ id: string }>(prompt, 'Current Chapter Blueprint：')
          const args = JSON.parse(chunk.block.arguments) as object
          yield { ...chunk, block: { ...chunk.block, arguments: JSON.stringify({ ...args,
            assignment_conflicts: [{ task: '步骤只要求另一节正文', basis: '步骤指令与当前章节职责冲突，须由 Main 调整能力计划。',
              related_section_positions: [inputJson<Array<{ id: string }>>(prompt, 'Confirmed Outline Responsibilities：')
                .findIndex(item => item.id === section.id)] }],
          }) } }
        } else yield chunk
      }
    } catch (error) {
      const message = '模型脚本协议不匹配：' + JSON.stringify({ tools: options.tools?.map(tool => tool.name), prompt: prompt.slice(-1800), error: String(error) })
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
 * @param clarify 是否用第二条章节名称消息澄清第一条拆章要求。
 * @param sixSparse 是否拆为六个叶节并模拟漏块、表题分离及原文共享；部分叶节没有迁移草稿。
 * @returns 工具序列和正式产物事实。
 */
export async function runMainTaskPlanningLoop(ctx: Context, root: string,
  fault?: 'after_split' | 'after_migration' | 'writing' | 'reviewing' | 'before_verification' | 'unread_verification' | 'published_correction' | 'migration_restart' | 'repeat_completed' | 'partial_replan' | 'authorization_recheck' | 'assignment_conflict' | 'completed_repair' | 'binding_repair' | 'rules_update',
  structure: 'split' | 'add' = 'split', selectedRoute = false, clarify: boolean | 'numeric' = false, sixSparse = false) {
  const workspace = await seedMainTaskPlanningProject(root)
  const outside = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
  const canonicalBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const adapter = new PlanningAdapter(fault === undefined ? undefined : workspace, fault === 'repeat_completed' || sixSparse, structure,
    fault === 'partial_replan' || fault === 'assignment_conflict', clarify, sixSparse, fault === 'assignment_conflict',
    fault === 'completed_repair' || fault === 'binding_repair', fault === 'binding_repair' || fault === 'rules_update', fault === 'unread_verification', fault === 'published_correction', fault === 'migration_restart', fault === 'rules_update')
  const executions: string[] = []
  let interrupted = false
  let acceptedCheckpointRestored = false
  let reviewRecoveryInputStart: number | undefined
  let unreadVerificationRejected = false
  let queuedReplacement: string | undefined
  if (fault === 'assignment_conflict' || fault === 'completed_repair' || fault === 'binding_repair' || fault === 'rules_update') adapter.onRecovery = () => { interrupted = true }
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
        if (fault === 'rules_update' && interrupted && args[0].capability === 'chapter.write' && !acceptedCheckpointRestored) {
          const candidate = args[1].working.projectRoot
          const logPath = join(candidate, 'chapters/execution-log.json')
          const log = parseOrMigrateChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
          const target = log.sections.find(section => args[1].sectionIds?.has(section.section_id))
          const outside = log.sections.find(section => !args[1].sectionIds?.has(section.section_id))
          if (target === undefined || outside === undefined) throw new Error('检查点故障缺少范围内外章节。')
          const planPath = join(candidate, 'chapters/execution-plan.json')
          const plan = chapterExecutionPlanSchema.parse(JSON.parse(await readFile(planPath, 'utf8')))
          plan.sections.find(section => section.section_id === outside.section_id)!.related_sections = [
            { section_id: target.section_id, reason: '候选计划关联目标章节。', strength: 'weak' },
          ]
          await args[1].run.commits.writeJson(planPath, plan)
          await args[1].run.commits.writeJson(logPath, { ...log,
            sections: log.sections.map(section => args[1].sectionIds?.has(section.section_id) ? section : { ...section,
              status: 'pending', phase: 'queued', attempts: [], final_writer_child_session_id: null, final_reviewer_child_session_id: null }) })
          acceptedCheckpointRestored = true
        }
        if (!interrupted && fault === 'reviewing' && args[0].capability === 'chapter.review') {
          const controller = new AbortController()
          const originalRun = args[1].run
          let reviewStarts = 0
          return dispatcher.execute(args[0], { ...args[1], run: { ...originalRun,
            signal: AbortSignal.any([originalRun.signal, controller.signal]),
            reportProgress(progress) {
              originalRun.reportProgress(progress)
              if (progress.phase !== 'reviewing' || reviewStarts++ !== 1) return
              interrupted = true
              reviewRecoveryInputStart = adapter.inputs.length
              controller.abort(Object.assign(new Error('审核部分完成后中断'), { code: 'ETIMEDOUT' }))
            },
          } })
        }
        if (fault === 'binding_repair' && args[0].capability === 'chapter.write' && queuedReplacement === undefined) {
          const host = ctx.bid as unknown as { readonly inFlight: Map<string, { readonly runs: { readonly current?: BidRunContext } }> }
          const run = [...host.inFlight.values()][0]?.runs.current
          if (run === undefined) throw new Error('缺少持有正式项目的原 Run')
          const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, run.work))
          queuedReplacement = (await enqueueCapabilityRequest(workspace, run, request.task, request.authorization)).queue_id
        }
        const outcome = args[0].capability === 'chapter.revise'
          ? await (ctx.bid as unknown as { readonly builtInCapabilityDispatcher: ReturnType<typeof createBidCapabilityDispatcher> })
            .builtInCapabilityDispatcher.execute(...args)
          : await dispatcher.execute(...args)
        if (canonicalBody !== await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')) {
          throw new Error('候选步骤在最终核验前改写了正式正文。')
        }
        if (!interrupted && (fault === 'writing' || fault === 'migration_restart') && args[0].capability === 'chapter.write') interrupt()
        return outcome
      },
      verifyTask: async (...args) => {
        if (!interrupted && (fault === 'before_verification' || fault === 'rules_update') && args[0].phase === 'result') interrupt()
        const decision = await modelBidTaskVerifier(...args)
        if (fault === 'unread_verification' && adapter.unreadVerificationRejected) {
          const host = ctx.bid as unknown as { readonly inFlight: Map<string, { readonly runs: { readonly current?: BidRunContext } }> }
          const started = [...host.inFlight.values()][0]?.runs.current
          if (started === undefined) throw new Error('核验失败时缺少原 Work')
          const resultPath = join(workspace.projectRoot, 'requests', started.work.workId, 'result.json')
          try { await readFile(resultPath) } catch (missing) {
            if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
            unreadVerificationRejected = true
          }
          if (!unreadVerificationRejected) throw new Error('未读证据拒绝前已经发布正式凭据')
        }
        if (!interrupted && fault === 'authorization_recheck' && args[0].phase === 'result') {
          interrupted = true
          return { ...decision, scope_authorized: false }
        }
        return decision
      },
    }))
  }
  ctx.effect(() => ctx.llm.registerAdapter(['planning-mock', 'planning-selected'], adapter))
  if (ctx.get('fs') === undefined) await ctx.plugin(IntegrationFileSystem)
  registerIntegrationTools(ctx, root, [])
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('task-planning-main'),
    agentOptions: { provider: 'planning-mock', model: 'planning-mock' }, meta: { cwd: root, agentPreset: 'bid' } })
  const agent = handle.agent
  adapter.mainSession = agent.session
  let migrationRestartRequested = false
  if (fault === 'migration_restart') adapter.onRecovery = () => {
    if (migrationRestartRequested) return
    migrationRestartRequested = true
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '重新迁移未完成写作：保留已接纳步骤和旧候选历史，从已接纳结果重新迁移完整原文，完成全部子章写作与审核。不要改目录或范围外成果。' }] }))
  }
  const selection = { current: { provider: 'planning-selected', model: 'selected-model' }, assembled: undefined }
  let recoveryInputStart: number | undefined
  if (selectedRoute && fault !== 'partial_replan') ctx.effect(() => installModelSelection(agent.ctx, selection))
  if (fault === 'partial_replan') adapter.onRecovery = () => {
    if (recoveryInputStart !== undefined) return
    interrupted = true
    recoveryInputStart = adapter.inputs.length
    ctx.effect(() => installModelSelection(agent.ctx, selection))
  }
  if (clarify) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: clarify === 'numeric' ? numericClarificationRequest : clarificationRequest }] }))
    await agent.whenIdle()
    if (agent.session.events.some(event => event.type === 'bid.run.started')) throw new Error('章节澄清前已越权启动任务')
  }
  const text = clarify ? clarify === 'numeric' ? '3' : 'S2.3' : sixSparse
    ? '只修改本章 S2.3，拆成收集输入、边界确认、校验结果、内业处理、复核整改、交付成果六个真实子章节，原文完整且唯一，完成全部子章正文和审核。不要改其他章节。'
    : '只修改本章 S2.3，把三个阶段拆成真实目录子章节，保留原文并完成正文和审核。不要改其他章节。'
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  const host = ctx.bid as unknown as { readonly inFlight: Map<string, { readonly done: Promise<unknown> }> }
  const settle = async () => {
    while (host.inFlight.size > 0) {
      await Promise.all([...host.inFlight.values()].map(operation => operation.done))
      await agent.whenIdle()
    }
  }
  await settle()
  if (fault === 'published_correction') {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '纠正刚才已发布结果：在原 Work 复核全部新子章，保留目录、原文及范围外成果，重新验收发布。' }] }))
    await agent.whenIdle()
    await settle()
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
  const reviews = await Promise.all(children.map(async section => parseChapterReviewArtifact(JSON.parse(
    await readFile(join(workspace.projectRoot, locations.get(section.id)!.reviewPath), 'utf8')))))
  const snapshot = await collectDocxExportSnapshot(workspace)
  await ctx.sessions.flush(agent.session)
  const executionParents = new Set(agent.session.events.flatMap(event => event.type === 'bid.run.started'
    && event.data.run.executionSessionId !== undefined ? [event.data.run.executionSessionId] : []))
  const start = agent.session.events.find(event => event.type === 'bid.run.started')
  if (start?.type !== 'bid.run.started') throw new Error('任务没有已接纳 Work')
  const source = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, start.data.run.work)).source_snapshot
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(join(workspace.projectRoot, 'runs', start.data.run.work.workId,
    'task-checkpoint.json'), 'utf8')))
  return { state: state?.status, source: text, children: children.map(section => section.title),
    ...sixSparse ? { migrationSubmissions: adapter.inputs.filter(input => input.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('源正文完整 Markdown 块：')))).length,
    generatedDraftRepaired: bodies.every(body => body.includes('整改后的候选新增说明。') && !body.includes('需要整改的候选新增说明。')),
    originalUnique: ['流程一：收集输入。', '流程二：校验结果。', '流程三：交付成果。', '表1 校验产物', '| 校验 | 报告 |', '{{flowchart:process-flow}}']
      .every(text => bodies.reduce((count, body) => count + body.split(text).length - 1, 0) === 1) } : {},
    ...clarify ? { sourceContext: source?.context_messages?.map(message => message.text) } : {},
    ...clarify === 'numeric' ? { unfoundedRestrictionRejected: adapter.unfoundedRestrictionRejected,
      noSuspension: !agent.session.events.some(event => event.type === 'bid.run.suspended'),
      verifiedCompletionNotice: agent.session.events.some(event => event.type === 'bid.run.notice'
        && event.data.kind === 'completed' && event.data.message.includes('本次任务范围内目标已通过核验并正式发布，goal_met=true；')) } : {},
    ...selectedRoute ? { selectedRouteInherited: adapter.inputs.length > 0
      && adapter.inputs.slice(recoveryInputStart ?? 0)
        .every(input => input.provider === 'planning-selected' && input.model === 'selected-model') } : {},
    ...fault === 'partial_replan' || fault === 'completed_repair' || fault === 'binding_repair' || fault === 'rules_update'
      ? { resumedWriterTitles: [...adapter.resumedWriterTitles], planPatchCount: checkpoint.plan_patches.length } : {},
    ...fault === 'rules_update' ? {
      revisionPreservationShared: ['submit_chapter', 'review_revision_issues'].every(name => adapter.inputs.some(input =>
        input.tools?.some(tool => tool.name === name) && input.messages.some(message => message.content.some(block =>
          block.type === 'text' && block.text.includes('保留全部原文和原流程图，在原图旁说明交付前必须完成校验。')
          && block.text.includes(name === 'submit_chapter' ? '原文保留块：' : '当前必须原貌保留的原图：'))))),
      revisionPublished: bodies.filter(body => body.includes('交付成果前必须完成校验，按已通过的成果清单逐项核对并形成交接记录。')).length === 1,
      recoveryErrors: agent.session.events.flatMap(event => event.type === 'bid.task.changed'
        && event.data.state.status === 'failed' ? [event.data.state.failure] : []),
      missingCitationRejected: adapter.missingCitationRejected,
      acceptedCheckpointRestored,
      outsideDependencyPreserved: chapterExecutionPlanSchema.parse(JSON.parse(await readFile(
        join(workspace.projectRoot, 'chapters/execution-plan.json'), 'utf8'))).sections
        .find(section => section.section_id === children.find(child => child.title === '校验结果')?.id)
        ?.depends_on.some(dependency => dependency.section_id === 'SEC-2'),
      currentRulesShared: ['submit_chapter', 'finish_chapter_review'].every(name => adapter.inputs.some(input =>
        input.tools?.some(tool => tool.name === name) && input.messages.some(message => message.content.some(block =>
          block.type === 'text' && block.text.includes('完整保留原文及校验表，说明校验报告与交接记录。'))))),
      currentRulesReviewed: parseWritingPlan(JSON.parse(await readFile(
        join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8'))).sections
        .filter(section => children.some(child => child.id === section.section_id))
        .every(section => section.acceptance_criteria.every(criterion =>
          reviews.find(review => review.section_id === section.section_id)?.acceptance_criteria_results
            .some(result => result.criterion_id === criterion.id && result.status === 'met'))) } : {},
    ...fault === 'binding_repair' ? { bindingRepaired: children.find(section => section.title === '校验结果')
      ?.requirement_ids.includes('REQ-1'),
    queuedReplacementCanceled: (await readBidChapterCommandJournal(workspace, start.data.run.work.workId))
      .some(record => record.status === 'canceled' && typeof record.command === 'object' && record.command !== null
        && 'queue_id' in record.command && record.command.queue_id === queuedReplacement) } : {},
    ...fault === 'reviewing' ? { reviewResumeNoWriter: reviewRecoveryInputStart !== undefined
      && adapter.inputs.slice(reviewRecoveryInputStart).every(input =>
        !input.tools?.some(tool => tool.name === 'submit_chapter')) } : {},
    ...fault === 'unread_verification' ? { unreadVerificationRejected } : {},
    ...fault === 'migration_restart' ? { migrationRestarted: checkpoint.plan_patches.at(-1)?.restart_pending === true
      && checkpoint.plan_patches.at(-1)?.writing_resume_seed === undefined, planPatchCount: checkpoint.plan_patches.length } : {},
    ...fault === 'published_correction' ? { priorPublicationPreserved: checkpoint.publications?.length === 1
      && checkpoint.publications[0]?.receipt.goal_met === true, planPatchCount: checkpoint.plan_patches.length,
    publicationNotices: agent.session.events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed').length,
    correctionNoticeMatchesRun: agent.session.events.findLast(event => event.type === 'bid.run.notice')?.data.runId
      === agent.session.events.findLast(event => event.type === 'bid.run.started')?.data.run.runId } : {},
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
    verifiers: new Set(adapter.inputs.filter(input => input.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('核验输入：')))).map(input => input.sessionId)).size }
}
