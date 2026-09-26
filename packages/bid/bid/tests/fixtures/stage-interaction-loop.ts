/** 阶段交互的真实 Main Agent 工具循环；只脚本化外部模型回复。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { BidHostRuntime, BidOrchestratorError, checkpointBidProjectState, getOrCreateOutlineDraft, parseEvidenceMapArtifact, BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import { runEvidenceMappingLoop } from './evidence-mapping-loop.ts'
import { outlineRegenerationChanges } from '../../src/outline-regeneration-artifacts.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

function visibleTarget(options: GenerateOptions, pattern: RegExp): string {
  for (const message of [...options.messages].reverse()) {
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const match = pattern.exec(block.text)
      if (match?.[1] !== undefined) return match[1]
    }
  }
  throw new Error('模型上下文缺少候选文件路径')
}

/** @param ctx 测试装配。 @param root 临时工作区。 @returns 整本重生成后的 Draft 与阶段状态。 */
export async function runFullOutlineRegenerationLoop(ctx: Context, root: string) {
  const { agent, workspace, childScript, reviewScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await checkpointBidProjectState(workspace, agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
  await ctx.plugin(SessionProjectionRegistry)
  if (ctx.get('userQuestions') === undefined) await ctx.plugin(UserQuestionService)
  await ctx.plugin(BidHostRuntime)
  agent.session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
  const host = ctx.get('bid') as unknown as { inFlight: ReadonlyMap<unknown, { session: unknown; done: Promise<void> }> }
  const waitHostOperation = async () => {
    await [...host.inFlight.values()].find(operation => operation.session === agent.session)?.done
  }
  const draft = await getOrCreateOutlineDraft(workspace)
  const candidate = { ...draft.outline, sections: draft.outline.sections.map(section => ({ ...section, title: `${section.title}方案` })) }
  const original = await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')
  const changeSet = { schema_version: 1, base_revision: draft.revision, base_draft_sha256: draft.draft_outline_sha256,
    changes: outlineRegenerationChanges(draft.outline, candidate).map(change => ({ ...change, reason: '明确方案标题' })) }
  childScript.push(
    options => call('write', { file_path: visibleTarget(options, /本轮初稿唯一输出：([^。\r\n]+)/u), content: JSON.stringify(candidate) }),
    options => call('write', { file_path: visibleTarget(options, /同时写入 ([^，\r\n]+)/u), content: JSON.stringify(changeSet) }),
    answer('目录已重生成。'),
  )
  reviewScript.push(
    call('structured_output', { operations: [], issues: [] }),
    answer('目录已复核。'),
  )
  const start = agent.session.events.length
  const result = await ctx.bid.regenerateOutline(agent.session, {
    expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256, feedback: '明确方案标题',
  })
  await waitHostOperation()
  return { result, draft: await getOrCreateOutlineDraft(workspace),
    canonicalPreserved: await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8') === original,
    state: agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE),
    transitions: agent.session.events.slice(start).filter(event => event.type.startsWith('bid.') && event.type !== 'bid.project.resumed').map(event => event.type) }
}

/** @param ctx 真实 Loader 或测试装配。 @param root 临时工作区。 @returns 不含环境路径的阶段交互结果。 */
export async function runStageInteractionLoop(ctx: Context, root: string, checkRejections = false) {
  const { agent, workspace, parentScript, childScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await checkpointBidProjectState(workspace, agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE))
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  if (ctx.get('userQuestions') === undefined) await ctx.plugin(UserQuestionService)
  const hostFiber = ctx.get('bid') === undefined ? ctx.plugin(BidHostRuntime) : undefined
  await hostFiber
  agent.session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
  const host = ctx.get('bid') as unknown as { inFlight: ReadonlyMap<unknown, { session: unknown; done: Promise<void> }> }
  const waitHostOperation = async () => {
    await [...host.inFlight.values()].find(operation => operation.session === agent.session)?.done
  }
  const before = agent.session.events.length
  const concurrent: Promise<string>[] = []
  const releaseObserver = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'bid.run.started') return
    concurrent.push(ctx.serial('session/prompt-admission', { session, mode: 'steer', content: [{ type: 'text', text: 'test' }] })
      .then((rejection) => {
        if (rejection !== undefined) throw new Error(`阶段执行期间拒绝了普通消息：${rejection.reason}`)
        return ctx.bid.applyOutlineDraftOperations(session, { expected_revision: 1, expected_draft_sha256: 'a'.repeat(64), operations: [] })
      })
      .then(() => 'unexpected success', (error: unknown) => error instanceof BidOrchestratorError ? error.code : String(error)))
  }, { global: true })
  const turns: Array<{ input: string; admitted: boolean }> = []
  const send = async (input: string, script: StreamChunk[][]) => {
    const rejection = await ctx.serial('session/prompt-admission', { session: agent.session, mode: 'steer', content: [{ type: 'text', text: input }] })
    turns.push({ input, admitted: rejection === undefined })
    if (rejection !== undefined) throw new Error(`${input}: ${JSON.stringify(rejection)}`)
    parentScript.push(...script)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await waitHostOperation()
    if (parentScript.length !== 0) throw new Error('Main Agent 未完成阶段工具调用')
  }
  const identity = async () => {
    const draft = await getOrCreateOutlineDraft(workspace)
    return { expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256 }
  }
  for (const input of ['现在是什么情况？', '这样可以吗？', '可以', '没问题']) {
    await send(input, [call('bid_stage_inspect', {}), answer('仍需点击正式确认按钮。')])
  }
  const outlinePath = join(workspace.projectRoot, 'outline/outline.json')
  const original = await readFile(outlinePath, 'utf8')
  await send('更新目录', [call('write', { file_path: outlinePath, content: '{}' }), answer('请使用阶段工具修改。')])
  const rawWriteBlocked = await readFile(outlinePath, 'utf8') === original
  const initial = await getOrCreateOutlineDraft(workspace)
  const sectionId = initial.outline.sections[0]!.id
  await send('第一章拆成实施准备、实施过程、验收移交', [call('bid_outline_apply_operations', {
    ...await identity(), operations: [{ type: 'split_section', section_id: sectionId, children: ['实施准备', '实施过程', '验收移交'].map(title => ({ title, purpose: title, must_answer: [`${title}的安排`] })) }],
    business_bindings: [{ section_id: 'SEC-001', requirement_ids: initial.outline.sections[0]!.requirement_ids,
      scoring_ids: initial.outline.sections[0]!.scoring_ids,
      scoring_response_point_ids: initial.outline.sections[0]!.scoring_response_point_ids ?? [],
      compliance_ids: initial.outline.sections[0]!.compliance_ids }],
  }), answer('已更新，请重新确认。')])
  const split = await getOrCreateOutlineDraft(workspace)
  const target = split.outline.sections.find(item => item.parent_id === sectionId)!
  childScript.push(answer(JSON.stringify([{ type: 'update_section', section_id: target.id, title: '实施准备与资源核查' }])))
  await send('实施准备这一节重新规划一下', [call('bid_outline_regenerate_scope', { ...await identity(), section_ids: [target.id], feedback: '明确资源核查' }), answer('已更新，请重新确认。')])
  if (await readFile(outlinePath, 'utf8') !== original) throw new Error('连续编辑覆盖了已完成研究的目录')
  const priorMap = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
  const requirementsPath = join(workspace.projectRoot, 'analysis/requirements.json')
  const beforeReadOnly = await readFile(requirementsPath, 'utf8')
  const runsBeforeReadOnly = agent.session.events.filter(event => event.type === 'bid.run.started').length
  await send('先讨论第一条要求，暂不修改', [
    call('bid_project_inspect', { query: { object: 'tender', part: 'requirements' } }),
    answer('已读取第一条要求，等待明确修改指令。'),
  ])
  const readOnlyNoWork = await readFile(requirementsPath, 'utf8') === beforeReadOnly
    && agent.session.events.filter(event => event.type === 'bid.run.started').length === runsBeforeReadOnly
  const beforePlanOnly = await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')
  const runsBeforePlanOnly = agent.session.events.filter(event => event.type === 'bid.run.started').length
  const requestsPath = join(workspace.root, '.bid-harness/requests')
  const requestIds = async (): Promise<string[]> => {
    try { return await readdir(requestsPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const requestsBeforePlanOnly = await requestIds()
  await send('先讨论把实施流程拆成小节的方案，暂不修改', [
    call('bid_project_inspect', { query: { object: 'outline' } }),
    answer('可以按准备、执行和验收拆分；目前只提出方案，等待修改指令。'),
  ])
  const planOnlyNoWork = await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8') === beforePlanOnly
    && await readFile(outlinePath, 'utf8') === original
    && JSON.stringify(await requestIds()) === JSON.stringify(requestsBeforePlanOnly)
    && agent.session.events.filter(event => event.type === 'bid.run.started').length === runsBeforePlanOnly
  await send('把第一条要求的理解改为明确实施边界', [
    call('bid_run_task', { task: { goal: '更正第一条要求的理解', scope: { kind: 'project' },
      steps: [{ scope: { source: 'task' }, call: { capability: 'tender.update', input: {
        operations: [{ type: 'update_requirement', requirement_id: 'REQ-1',
          fields: { normalized_requirement: '明确实施边界' } }],
      } } }],
    } }),
    answer('已更正招标理解。'),
  ])
  const updatedRequirements = JSON.parse(await readFile(requirementsPath, 'utf8')) as {
    requirements: Array<{ id: string; normalized_requirement: string }>
  }
  const capabilityUpdates = agent.session.events.filter(event => event.type === 'bid.run.started'
    && event.data.run.work.kind === 'capability_task').length
  const finalDraft = await getOrCreateOutlineDraft(workspace)
  if (await readFile(outlinePath, 'utf8') !== original) throw new Error('局部资料研究覆盖了其他章节的研究基线')
  const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
  if (checkRejections) {
    const paths = [
      'outline/draft.json', 'outline/outline.json', 'outline/quality-report.json', 'analysis/evidence-map.json',
      'analysis/web-evidence-sources.json', 'analysis/evidence-mapping-plan.json', 'analysis/evidence-mapping-log.json',
    ]
    const baseline = await Promise.all(paths.map(path => readFile(join(workspace.projectRoot, path), 'utf8')))
    const after = await Promise.all(paths.map(path => readFile(join(workspace.projectRoot, path), 'utf8')))
    if (JSON.stringify(after) !== JSON.stringify(baseline)) throw new Error('失败后未恢复阶段产物')
  }
  const untouchedEvidencePreserved = map.section_mappings.filter(item => item.section_id !== target.id)
    .every((item) => {
      const previous = priorMap.section_mappings.find(mapping => mapping.section_id === item.section_id)
      return JSON.stringify(item) === JSON.stringify(previous)
    })
  childScript.push((options) => {
    const candidate = JSON.parse(visibleTarget(options, /当前候选目录：([^\r\n]+)/u)) as typeof finalDraft.outline
    const child = candidate.sections.find(section => section.parent_id === target.id)
    if (child === undefined) throw new Error('拆分候选缺少新章节')
    return answer(JSON.stringify([{ section_id: child.id, requirement_ids: target.requirement_ids,
      scoring_ids: target.scoring_ids, scoring_response_point_ids: target.scoring_response_point_ids ?? [],
      compliance_ids: target.compliance_ids }]))
  })
  await send('将实施准备拆为人员准备和资源核查两个小节，只调整目录', [
    call('bid_run_task', { task: { goal: '拆分实施准备目录',
      scope: { kind: 'sections', section_ids: [target.id] }, steps: [{ scope: { source: 'task' },
        call: { capability: 'outline.update', input: {
          operations: [{ type: 'split_section', section_id: target.id,
            children: ['人员准备', '资源核查'].map(title => ({ title, purpose: title, must_answer: [`${title}的安排`] })) }],
          defer_content_migration: true,
        } } }],
    } }), answer('正在拆分目录并分配业务要求。'),
  ])
  const capabilityDraft = await getOrCreateOutlineDraft(workspace)
  const splitChildren = capabilityDraft.outline.sections.filter(section => section.parent_id === target.id)
  const capabilitySplit = splitChildren.map(section => ({ title: section.title,
    responsePoints: section.scoring_response_point_ids ?? [] }))
  if (childScript.length !== 0 || splitChildren.length !== 2) throw new Error('目录能力未完成拆分与业务分配')
  const calls = agent.session.events.slice(before).filter(event => event.type === 'tool/call').map(event => event.data.name)
  const failures = agent.session.events.slice(before).filter(event => event.type === 'tool/result').filter(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError))
  const state = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const visibleTools = ctx.tools.schemas(agent).map(tool => tool.name)
  const confirmations = agent.session.events.slice(before).filter(event => event.type === 'bid.user_confirmation.received' || event.type === 'bid.stage.completed').length
  await ctx.sessions.flush(agent.session)
  releaseObserver()
  await hostFiber?.dispose()
  return { turns, calls, failures: failures.length, rawWriteBlocked, untouchedEvidencePreserved, confirmations, state,
    readOnlyNoWork, planOnlyNoWork, capabilityUpdates, capabilitySplit,
    updatedRequirement: updatedRequirements.requirements.find(item => item.id === 'REQ-1')?.normalized_requirement,
    revision: finalDraft.revision, titles: finalDraft.outline.sections.map(section => section.title),
    visibleTools, concurrent: await Promise.all(concurrent), disposed: hostFiber === undefined ? null : !ctx.tools.schemas(agent).some(tool => tool.name.startsWith('bid_')) }
}
