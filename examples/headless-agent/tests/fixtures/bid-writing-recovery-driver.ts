/** 无密钥 Loader 应用回放：真实 Host 执行职责冲突恢复与损坏格式结算。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  BidWorkspace, buildBidStageTask, checkpointBidProjectState, createTestBidRunContext,
  executeChapterWriting, parseWritingPlan, readBidProjectState,
} from '@deepseek-ai/dsh-bid'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chapterContentSha256 } from '../../../../packages/bid/bid/src/chapter-revision.ts'
import { ChapterAdapter } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-adapter.ts'
import { writeInputs } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-inputs.ts'
import { registerIntegrationTools } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { scriptedVerificationCall } from '../../../../packages/bid/bid/tests/fixtures/task-verifier.ts'
import type { WritingRequest } from '../../../../packages/bid/bid/src/writing-requirements.ts'
import { bindBidInputRecovery, readBidInputRecovery } from '../../../../packages/bid/bid/src/bid-input-recovery.ts'
import { persistBidWorkRequest } from '../../../../packages/bid/bid/src/work-descriptor.ts'
import { parseEvidenceMapArtifact } from '../../../../packages/bid/bid/src/evidence-mapping-artifacts.ts'
import { mappingModelReply } from '../../../../packages/bid/bid/tests/fixtures/mapping-model-positions.ts'
import { BidStageAttentionRequiredError } from '../../../../packages/bid/bid/src/control-plane-contract.ts'

const stageAnswer = '先写方案并配示意图，实际演示后续准备'

function tool(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

class WritingRecoveryAdapter extends LlmAdapter {
  readonly chapter = new ChapterAdapter()
  readonly mainRequests: GenerateOptions[] = []
  readonly researchSteps = new Map<string, number>()
  researchReceivedAnswer = false
  constructor(private readonly mainId: SessionId, private readonly scenario: string) { super() }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.system?.includes('技术标目录轻量复核 Subagent')) {
      yield* mappingModelReply(tool('structured_output', { scope: 'technical_bid', issues: [], blocking_issues: [] }), options)
      return
    }
    if (options.tools?.some(item => item.name === 'finish_mapping_task')) {
      const prompt = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      this.researchReceivedAnswer ||= prompt.includes(stageAnswer)
      if (!this.researchReceivedAnswer) throw new Error('真实章节研究没有收到用户回答')
      const step = this.researchSteps.get(String(options.sessionId)) ?? 0
      this.researchSteps.set(String(options.sessionId), step + 1)
      const rejected = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result' && block.isError)
      if (rejected !== undefined) throw new Error('研究脚本参数被正式入口拒绝：' + JSON.stringify(rejected))
      const checklistLine = prompt.split('\n').find(line => line.startsWith('answer_checklists：'))!
      const [checklist] = JSON.parse(checklistLine.slice('answer_checklists：'.length)) as Array<{
        section_id: string
        items: { item_ref: string }[]
      }>
      const objectsLine = prompt.split('\n').find(line => line.startsWith('对象位置：'))!
      const objects = JSON.parse(objectsLine.slice('对象位置：'.length)) as {
        references: { kind: string; position: number }[]
      }
      const basis = { kind: 'section_responsibility', explanation: '用户确认先写拟实施方案，实际演示资料后续准备。', requirement_positions: [] }
      if (step === 0) yield* mappingModelReply(tool('submit_section_research_assessment', {
        sufficient_for_blueprint: true,
        evidence_requirement: { kind: 'not_required', reason: '本节先写专业方案，不声称已部署或已完成实际演示。' },
        diagnostics: { tender_and_response_points: '按已确认职责响应演示要求。', technical_approach: '先写方案并准备示意图。',
          evidence_and_inferences: '示意图不证明系统现状。', project_specific_quality_risks: '实际演示条件后续准备。' },
        key_findings: [{ finding: '方案和实际演示准备分别说明。', explanation: '真实资料后续核实，不虚构现状。',
          nature: 'professional_design', basis: [{ reference_position: objects.references.find(item => item.kind === 'requirement')!.position }],
          evidence_boundary: '不宣称已完成演示。' }],
        unresolved_gaps: [],
      }), options)
      else if (step === 1) yield* mappingModelReply(tool('submit_section_mapping', {
        section_id: checklist!.section_id, local_materials: [], web_materials: [],
      }), options)
      else if (step === 2) yield* mappingModelReply(tool('update_section_task', {
        section_id: checklist!.section_id, basis,
        answer_plan: checklist!.items.map(item => ({ target_refs: [item.item_ref], mode: 'proposal',
          content: '先编写实施方案并准备示意图，实际系统演示条件后续核实。',
          basis: [{ kind: 'section_responsibility' }], boundary: '示意图不是真实系统截图，不宣称已部署或已测试。' })),
      }), options)
      else if (step === 3) yield* tool('finish_mapping_task', {})
      else throw new Error('真实研究未收敛：' + JSON.stringify(options.messages.at(-1)?.content))
      return
    }
    if (options.tools?.some(item => item.name === 'finish_final_check')) {
      const step = this.researchSteps.get(String(options.sessionId)) ?? 0
      this.researchSteps.set(String(options.sessionId), step + 1)
      if (step === 0) yield* tool('list_review_items', {})
      else if (step === 1) {
        const result = options.messages.flatMap(message => message.content)
          .filter(block => block.type === 'tool-result').flatMap(block => block.content)
          .filter(block => block.type === 'text').map(block => JSON.parse(block.text) as { pending_items?: { review_ref: string }[] })
          .findLast(item => item.pending_items !== undefined)
        yield* mappingModelReply(tool('review_items', { items: result!.pending_items!.map(item => ({ review_ref: item.review_ref,
          decision: 'keep', reason: '按用户决定写专业方案，不虚构实际演示成果。' })) }), options)
      } else if (step === 2) yield* tool('finish_final_check', {})
      else throw new Error('研究终审未收敛：' + JSON.stringify(options.messages.at(-1)?.content))
      return
    }
    const verification = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('核验输入：'))
    if (verification?.type === 'text') {
      const input = JSON.parse(verification.text.slice(verification.text.indexOf('核验输入：') + '核验输入：'.length)) as Parameters<typeof scriptedVerificationCall>[0]
      const call = scriptedVerificationCall(input, options.messages)
      yield* tool(call.name, call.args).map(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'
        ? { ...chunk, block: { ...chunk.block, id: CallId('verification') } } : chunk)
      return
    }
    if (options.sessionId !== this.mainId) {
      const prompt = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (prompt.includes('Relation Planning') || prompt.includes('Document Global Compliance Review') || prompt.includes('Final Document Review')) {
        if (!prompt.includes('Relation Planning')) this.chapter.requests.set('parent', { role: 'plan', tools: [], steps: 2 })
        yield* this.chapter.stream({ ...options, sessionId: SessionId('parent') })
      } else yield* this.chapter.stream(options)
      return
    }
    this.mainRequests.push(options)
    const last = options.messages.at(-1)?.source
    if (this.scenario === 'stage-input') {
      yield* answer('已按用户回答继续原任务，保留完成正文。')
    } else if (this.scenario.startsWith('saved-')) {
      if (this.mainRequests.length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: this.scenario.slice('saved-'.length), message: '暂态计划请求故障' } } }
      } else if (this.mainRequests.length === 2) {
        yield* tool('bid_recover_task', { target: 'writing_plan', instruction: '复用已保存的实施要求，重新提交失败的计划步骤。' })
      } else if (this.mainRequests.length === 3) {
        yield* tool('bid_stage_inspect', { view: 'task_contract_context' })
      } else if (this.mainRequests.length === 4) {
        const result = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result' && block.toolCallId === 'bid_stage_inspect')
        if (result?.type !== 'tool-result') throw new Error('保存要求恢复缺少实际计划上下文')
        const content = result.content.find(block => block.type === 'text')
        if (content?.type !== 'text') throw new Error('保存要求恢复缺少实际对象表')
        const input = JSON.parse(content.text) as { objects: { sections: { position: number; label: string }[] }
          task_contract_context: { blueprint: { sections: { title: string; writable: boolean }[] } } }
        yield* tool('bid_confirm_writing_plan', { update_kind: 'initial', user_message_positions: [],
          global_instructions: ['重点说明实施步骤。'], document_acceptance: [],
          sections: input.task_contract_context.blueprint.sections.filter(section => section.writable).map(section => ({
            section_position: input.objects.sections.find(item => item.label === section.title)!.position,
            task: `编写 ${section.title}`, user_message_positions: [], writing_instructions: ['重点说明实施步骤。'], acceptance_criteria: [],
          })) })
      } else yield* answer('已保存的实施要求已用于实际写作计划。')
    } else if (this.scenario === 'corrupt-format') {
      yield* answer('格式配置已损坏，页数核验被阻断；需要修复该配置后再继续。')
    } else if (this.mainRequests.length === 1) {
      yield* answer('我已看到职责冲突。')
    } else if (this.mainRequests.length === 2) {
      yield* tool('bid_stage_inspect', { view: 'recovery' })
    } else if (this.mainRequests.length === 3) {
      delete this.chapter.reviewSummary
      yield* tool('bid_recover_task', { target: 'run', instruction: '保留已确认职责，重新核验原候选的职责分配及审批意见。' })
    } else if (last?.kind === 'plugin' && last.form === 'notice' && last.summary?.startsWith('bid-result:')) {
      yield* answer('已读取正式结果；原审批意见已核验完成。')
    } else yield* answer('Host 已接纳恢复，等待实际核验结果。')
  }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 25_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`)
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 Bid 写作恢复回放配置')
const scenario = process.env.DSH_BID_WRITING_RECOVERY_SCENARIO ?? 'assignment-conflict'
let ctx: Context | undefined
try {
  ctx = await boot('bid-writing-recovery-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  const outline = await writeInputs(workspace)
  await workspace.import([{ name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('已核验的项目实施参考资料。') }])
  registerIntegrationTools(ctx, process.cwd(), [])
  const savedRequirements = scenario.startsWith('saved-')
  const stageInput = scenario === 'stage-input'
  if (stageInput) {
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), JSON.stringify(outline))
    await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({ schema_version: 1,
      scope: 'technical_bid', checked_requirement_ids: ['REQ-1', 'REQ-2', 'REQ-3'], checked_scoring_ids: ['SCORE-1', 'SCORE-2', 'SCORE-3'],
      checked_scoring_response_point_ids: ['RP-000001', 'RP-000002', 'RP-000003'], reviewed_section_ids: outline.sections.map(item => item.id), issues: [] }))
    const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(evidencePath, 'utf8')))
    evidence.section_mappings[1]!.answer_plan = evidence.section_mappings[1]!.answer_plan!.map(item => ({
      ...item, mode: 'gap', content: '实际演示资料未提供。', basis: [], boundary: '不能虚构演示系统。', required_input: '请明确演示章节写作方式。',
    }))
    await writeFile(evidencePath, JSON.stringify(evidence))
  }
  if (savedRequirements) await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'))
  else {
    const seed = new ChapterAdapter()
    ctx.effect(() => ctx!.llm.registerAdapter(['seed'], seed))
    const seedAgent = ctx.agentLoop.create(SessionId('parent'), { provider: 'seed', model: 'mock' }, { cwd: process.cwd() })
    try {
      await executeChapterWriting(seedAgent, workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: 1, maxConcurrency: 1, run: createTestBidRunContext(),
      })
    } catch (error: unknown) {
      if (!stageInput || !(error instanceof BidStageAttentionRequiredError)
        || !error.issues.every(issue => issue.code === 'CHAPTER_WRITING_INPUT_REQUIRED')) throw error
    }
  }
  const bodyPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const beforeBody = savedRequirements ? '' : await readFile(bodyPath, 'utf8')
  const manifestPath = join(workspace.projectRoot, 'chapters/manifest.json')
  const beforeManifest = savedRequirements ? '' : await readFile(manifestPath, 'utf8')
  if (scenario === 'corrupt-format') {
    const planPath = join(workspace.projectRoot, 'chapters/writing-plan.json')
    const plan = parseWritingPlan(JSON.parse(await readFile(planPath, 'utf8')))
    await writeFile(planPath, JSON.stringify({ ...plan, document_acceptance: [{ id: 'AC-000005', scope: { kind: 'document' },
      description: '必须得到有效页数', priority: 'required', evaluator: { kind: 'deterministic', metric: 'estimated_pages', min: 0, max: null } }] }))
    await mkdir(join(workspace.projectRoot, 'word-export'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'word-export/default.config.json'), '{损坏')
  }
  const stage = 'chapter_writing' as const
  const payload = { stage }
  const inputs = stageInput ? await Promise.all(buildBidStageTask(stage).inputs.map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(join(workspace.projectRoot, path))).digest('hex') }))) : []
  const work = stageInput ? await persistBidWorkRequest(workspace, { kind: 'stage_execution', stage: stage }, payload, { stage, inputs, payload }) : undefined
  const suspended = work === undefined ? undefined : { runId: 'stage-input-original', epoch: 1, baseProjectRevision: 0,
    work, cause: 'awaiting_input' as const, startedAt: 1, updatedAt: 2, error: { message: '演示章节需要用户决定。',
      issues: [{ code: 'CHAPTER_WRITING_INPUT_REQUIRED', artifact: 'SEC-2', message: '缺少实际演示资料，请明确本章写作方式。' }] } }
  await checkpointBidProjectState(workspace, suspended === undefined
    ? { workflow: { kind: 'full_bid', stage: stage }, status: savedRequirements ? 'waiting_user' : 'completed', run: null }
    : { workflow: { kind: 'full_bid', stage: stage }, status: 'suspended', run: suspended })
  const mainId = SessionId('bid-writing-recovery-main')
  const adapter = new WritingRecoveryAdapter(mainId, scenario)
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], adapter))
  let questions = 0
  ctx.effect(() => ctx!.userQuestions.registerProvider({ ask: async ({ questions: items }) => {
    questions++
    if (!savedRequirements && !stageInput) throw new Error('执行故障不应创建用户问题')
    return { answers: [{ id: items[0]!.id, selected: [], custom: stageInput ? stageAnswer : '重点说明实施步骤。' }] }
  } }))
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: mainId, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  const host = ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }>
    recoveryTasks: Set<Promise<unknown>>
    pendingCapabilityInputs: Map<string, Promise<void>> }
  await until(() => agent.session.events.some(event => event.type === 'bid.project.resumed') && host.inFlight.size === 0, '项目恢复并释放操作锁')
  if (stageInput) {
    try {
      await until(async () => {
        const state = await readBidProjectState(workspace)
        if (state?.status === 'failed') throw new Error(JSON.stringify(state.failure))
        return state?.status === 'completed'
      }, '原阶段按真实回答完成缺口章节')
    }
    catch (error: unknown) {
      throw new Error(JSON.stringify({ state: await readBidProjectState(workspace), questions,
        journal: await readBidInputRecovery(workspace, bindBidInputRecovery(String(mainId), suspended!, 'stage', suspended!.runId), 3),
        researchReceivedAnswer: adapter.researchReceivedAnswer,
        events: agent.session.events.filter(event => event.type.startsWith('bid.')).slice(-8),
      }), { cause: error })
    }
    await until(() => host.inFlight.size === 0 && host.pendingCapabilityInputs.size === 0, '输入结算')
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const journal = await readBidInputRecovery(workspace, bindBidInputRecovery(String(mainId), suspended!, 'stage', suspended!.runId), 3)
    const started = agent.session.events.findLast(event => event.type === 'bid.run.started')
    const reviewerIds = [...adapter.researchSteps.keys(), ...[...adapter.chapter.requests.entries()]
      .filter(([, request]) => request.role !== 'plan').map(([id]) => id)]
    await writeFile(join(process.cwd(), 'recovery-snapshot.json'), JSON.stringify({ mainId, reviewerIds }))
    process.stdout.write(`${JSON.stringify({ questions, researchReceivedAnswer: adapter.researchReceivedAnswer,
      finalStatus: (await readBidProjectState(workspace))?.status,
      bodyPreserved: await readFile(bodyPath, 'utf8') === beforeBody,
      sameWork: started?.data.run.work.workId === suspended!.work.workId,
      resumedOriginal: started?.data.run.resumeOf?.runId === suspended!.runId,
      journalPhase: journal.phase, attempts: journal.attempts,
      answerBound: agent.session.events.some(event => event.type === 'user/message' && String(event.data.id) === journal.answer_message_id),
      writerSections: [...adapter.chapter.requests.values()].filter(item => item.role === 'writer').map(item => item.sectionId),
      recoveryRequests: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      failures: agent.session.events.filter(event => event.type === 'bid.task.changed' && event.data.state.status === 'failed').length,
    })}\n`)
  } else if (savedRequirements) {
    await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
    const requestPath = join(workspace.projectRoot, 'chapters/writing-request.json')
    await until(async () => (JSON.parse(await readFile(requestPath, 'utf8')) as WritingRequest).state === 'consumed', '原回答生成计划')
    await until(() => host.inFlight.size === 0 && host.recoveryTasks.size === 0, '实际写作结算')
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const request = JSON.parse(await readFile(requestPath, 'utf8')) as WritingRequest
    await writeFile(join(process.cwd(), 'recovery-snapshot.json'), JSON.stringify({ mainId, reviewerIds: [] }))
    process.stdout.write(`${JSON.stringify({ questions, noGoal: ctx.get('goals') === undefined,
      requestState: request.state, answer: request.answer?.custom,
      planIncludesAnswer: (await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')).includes('重点说明实施步骤。'),
      originalFailure: agent.session.events.some(event => event.type === 'bid.writing_entry.changed' && event.data.view.error?.code === scenario.slice('saved-'.length)),
      recoveryRequests: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      confirmCalls: agent.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'bid_confirm_writing_plan').length,
      startedRuns: agent.session.events.filter(event => event.type === 'bid.run.started').length,
      roundStates: agent.session.events.filter(event => event.type === 'bid.recovery.round').map(event => event.data.state),
      planVersion: parseWritingPlan(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8'))).plan_version,
      finalStatus: (await readBidProjectState(workspace))?.status,
    })}\n`)
  } else {
    const instruction = scenario === 'corrupt-format' ? '重新审核整书页数。' : '核对本章职责并改进措辞。'
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: instruction }] })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const authorization = { session_id: String(agent.id), message_id: String(message.id) }
    let failed: { status: string; failure?: unknown }
    if (scenario === 'assignment-conflict') {
      const added = await ctx.bid.addRevisionIssue(agent.session, { section_id: 'SEC-1', scope: 'chapter',
        reference: { scope: 'chapter', base_content_sha256: chapterContentSha256(beforeBody) }, instruction, suggestion: null })
      if (!added.ok) throw new Error(JSON.stringify(added))
      const issue = added.value.issues[0]!
      adapter.chapter.reviewSummary = { assignment_conflicts: [{ task: '职责重复', basis: '当前任务与第二章职责重叠',
        related_section_positions: [outline.sections.findIndex(section => section.id === 'SEC-2')] }] }
      failed = await ctx.bid.runCapabilityTask(agent, { goal: instruction, issue_ids: [issue.issue_id],
        scope: { kind: 'sections', section_ids: ['SEC-1'] }, steps: [{ description: '修订当前章', scope: { source: 'task' },
          call: { capability: 'chapter.revision_batch', input: { issue_ids: [issue.issue_id], tasks: [{
            task_id: 'task-1', section_id: 'SEC-1', issue_ids: [issue.issue_id], depends_on: [],
          }] } } }] }, authorization, ['chapters/execution-log.json'])
    } else {
      failed = await ctx.bid.runCapabilityTask(agent, { goal: instruction, scope: { kind: 'project' }, steps: [{
        description: instruction, scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: instruction } },
      }] }, authorization, ['chapters/execution-log.json'])
    }
    const bodyPreservedAtFailure = await readFile(bodyPath, 'utf8') === beforeBody
    await until(() => agent.session.events.some(event => event.type === 'bid.recovery.round'
    && event.data.state === (scenario === 'assignment-conflict' ? 'recovered' : 'blocked')), '恢复结算')
    await agent.whenIdle()
    await until(() => host.inFlight.size === 0 && host.recoveryTasks.size === 0, 'Host 释放')
    await ctx.sessions.flush(agent.session)
    const starts = agent.session.events.filter(event => event.type === 'bid.run.started')
    const first = starts[0]!, last = starts.at(-1)!
    const rounds = agent.session.events.filter(event => event.type === 'bid.recovery.round')
    const reviewerIds = [...adapter.chapter.requests.entries()].filter(([, value]) => value.role === 'review').map(([id]) => id)
    await writeFile(join(process.cwd(), 'recovery-snapshot.json'), JSON.stringify({ mainId, reviewerIds }))
    process.stdout.write(`${JSON.stringify({
      initial: failed, questions, noGoal: ctx.get('goals') === undefined, bodyPreservedAtFailure,
      finalStatus: (await readBidProjectState(workspace))?.status,
      bodyPreservedAfterSettlement: await readFile(bodyPath, 'utf8') === beforeBody,
      manifestPreservedAfterSettlement: await readFile(manifestPath, 'utf8') === beforeManifest,
      startedRuns: starts.length, sameWork: last.data.run.work.workId === first.data.run.work.workId,
      resumedOriginal: last.data.run.resumeOf?.runId === first.data.run.runId,
      rounds: rounds.map(event => [event.data.round, event.data.state]),
      calls: agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      recoveryRequests: agent.session.events.filter(event => event.type === 'bid.recovery.requested').length,
      completedNotices: agent.session.events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed').length,
      revisionStatuses: scenario === 'assignment-conflict' ? (await ctx.bid.getRevisionQueue(agent.session)).issues.map(issue => issue.status) : [],
    })}\n`)
  }
} finally { await ctx?.fiber.dispose() }
