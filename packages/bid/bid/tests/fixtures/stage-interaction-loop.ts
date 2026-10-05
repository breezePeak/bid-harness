import { modelTaskArguments } from './model-task.ts'
/** 阶段交互的真实 Main Agent 工具循环；只脚本化外部模型回复。 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { BidHostRuntime, BidOrchestratorError, checkpointBidProjectState, getOrCreateOutlineDraft,
  parseEvidenceMapArtifact, readBidProjectState, BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import { runEvidenceMappingLoop } from './evidence-mapping-loop.ts'
import { outlineRegenerationChanges } from '../../src/outline-regeneration-artifacts.ts'
import { seedCapabilityProject } from '../capability-fixture.ts'
import { collectBidModelTaskCatalog } from '../../src/bid-model-task.ts'
import { bidRecoverableRun } from '../../src/bid-recovery.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

async function waitCapabilityOperations(ctx: Context): Promise<void> {
  const operations = (ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
  while (operations.size > 0) await Promise.all([...operations.values()].map(operation => operation.done))
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

/** @param ctx 源码 Loader 装配。 @param root 临时项目。 @returns 原授权恢复后的真实目录和步骤结果。 */
export async function runCapabilityReplanLoop(ctx: Context, root: string) {
  const { agent, workspace, parentScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await seedCapabilityProject(workspace, 'complete')
  const state = { stage: 'evidence_mapping' as const, status: 'completed' as const, run: null }
  agent.session.append('bid.task.changed', { state })
  await checkpointBidProjectState(workspace, state)
  if (ctx.get('bid') === undefined) await ctx.plugin(BidHostRuntime)
  const before = agent.session.events.length
  const originalBody = await readFile(join(workspace.projectRoot, 'chapters/sections/0003.md'), 'utf8')
  const done = Promise.withResolvers<undefined>()
  const release = ctx.on('session/event', (session, event) => {
    const admitted = session.events.slice(before).find(item => item.type === 'bid.run.started'
      && item.data.run.work.kind === 'capability_task')
    if (session === agent.session && event.type === 'bid.run.notice' && event.data.kind === 'completed'
      && admitted?.type === 'bid.run.started' && event.data.workId === admitted.data.run.work.workId) done.resolve(undefined)
  }, { global: true })
  let initialDescriptionRejected = false
  let replacementDescriptionRejected = false
  let descriptionSchemaChecked = false
  let descriptionGuidanceChecked = false
  const longDescription = '说明'.repeat(10) + '长'
  const initialTask = { goal: '把章节3提升到顶层，并改名为独立实施方案；保留正文',
    scope: { kind: 'project' }, steps: [{ description: '生成包含独立实施方案的新目录',
      scope: { source: 'task' }, call: { capability: 'outline.generate', input: {} } }],
  }
  const initialArguments = await modelTaskArguments(agent, { task: initialTask })
  const replacementSteps = [
    { description: '将章节3提升到顶层并保留现有正文', scope: { source: 'task' }, call: { capability: 'outline.update', input: { operations: [
      { type: 'move_section', section_position: 4, parent_position: null, order: 3 },
    ] } } },
    { description: '将提升后的章节改名为独立实施方案', scope: { source: 'previous_targets' }, call: { capability: 'outline.update', input: { operations: [
      { type: 'update_section', section_position: 4, title: '独立实施方案' },
    ] } } },
  ]
  const checkDescriptionSchema = (options: GenerateOptions, name: 'bid_run_task' | 'bid_plan_task') => {
    type StepListSchema = { items?: { properties?: { description?: { maxLength?: number; description?: string } } } }
    const parameters = options.tools?.find(tool => tool.name === name)?.parameters as {
      properties?: { task?: { properties?: { steps?: StepListSchema } }; steps?: StepListSchema }
    } | undefined
    const description = (name === 'bid_run_task' ? parameters?.properties?.task?.properties?.steps
      : parameters?.properties?.steps)?.items?.properties?.description
    if (description?.maxLength !== 20 || !description.description?.includes('call.input')) {
      throw new Error(name + ' 未提供短摘要长度与详细要求位置')
    }
    const prompt = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (!prompt.includes('description 用一句单行短摘要') || !prompt.includes('详细要求放在 call.input 中')) {
      throw new Error('Main 缺少短摘要规划指导')
    }
  }
  const descriptionRejected = (options: GenerateOptions, name: string) => {
    const result = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      .findLast(block => block.toolCallId === CallId(name))
    return result?.isError === true && result.content.some(block => block.type === 'text'
      && block.text.includes('description') && block.text.includes('20'))
  }
  parentScript.push(
    call('bid_project_inspect', { query: { object: 'outline' } }),
    (options) => {
      checkDescriptionSchema(options, 'bid_run_task')
      return call('bid_run_task', { task: { ...initialTask,
        steps: initialTask.steps.map(step => ({ ...step, description: longDescription })) } })
    },
    (options) => {
      initialDescriptionRejected = descriptionRejected(options, 'bid_run_task')
      if (!initialDescriptionRejected) throw new Error('首次任务接纳了超长步骤说明')
      if (agent.session.events.slice(before).some(event => event.type === 'bid.run.started')) {
        throw new Error('超长步骤说明拒绝前已创建执行 Run')
      }
      return call('bid_run_task', initialArguments)
    },
    answer('已接纳任务，等待真实执行结果。'),
    call('bid_stage_inspect', { view: 'recovery' }),
    (options) => {
      if (!JSON.stringify(options.tools).includes('project 范围可跨分支重组及调整顶层章节')) throw new Error('缺少能力范围说明')
      return call('bid_project_inspect', { query: { object: 'task' } })
    },
    (options) => {
      for (const message of [...options.messages].reverse()) for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        for (const content of block.content) {
          if (content.type !== 'text') continue
          const value = JSON.parse(content.text) as { data?: {
            capability_task?: { work_id: string; steps: Array<{ index: number; status: string }> } } }
          const task = value.data?.capability_task
          if (task === undefined) continue
          const failed = task.steps.find(step => step.status === 'running')
          if (failed === undefined) throw new Error('未返回实际失败步骤')
          checkDescriptionSchema(options, 'bid_plan_task')
          descriptionSchemaChecked = true
          descriptionGuidanceChecked = true
          return call('bid_plan_task', { edit: 'replace_pending',
            steps: replacementSteps.map(step => ({ ...step, description: longDescription })) })
        }
      }
      throw new Error('任务检查缺少原目标和执行步骤')
    },
    (options) => {
      replacementDescriptionRejected = descriptionRejected(options, 'bid_plan_task')
      if (!replacementDescriptionRejected) throw new Error('重规划接纳了超长步骤说明')
      return call('bid_plan_task', { edit: 'replace_pending', steps: replacementSteps })
    },
    () => call('bid_recover_task', { target: 'run', instruction: '使用已有目录编辑能力完成原目标，按实际结果接续修改并保留正文。' }),
    answer('已调整能力计划并继续。'),
  )
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '把章节3提升到顶层，并改名为独立实施方案；保留正文。' }], source: { kind: 'user' } }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([done.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('能力重规划等待实际发布通知超时')) }, 35_000)
      })])
    } finally { clearTimeout(timer) }
    const operations = (ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
    await Promise.all([...operations.values()].map(operation => operation.done))
    await agent.whenIdle()
    const settled = await readBidProjectState(workspace)
    if (settled?.status !== 'completed') throw new Error('能力重规划未完成：' + JSON.stringify({
      state: settled, calls: agent.session.events.slice(before).filter(event => event.type === 'tool/call')
        .map(event => event.data.name),
      last: agent.session.deriveMessages().at(-1)?.content,
    }))
    const outline = (await getOrCreateOutlineDraft(workspace)).outline
    const section = outline.sections.find(item => item.id === 'SEC-3')!
    const events = agent.session.events.slice(before)
    await ctx.sessions.flush(agent.session)
    const plan = await ctx.bid.getCapabilityTaskPlan(agent.session)
    if (plan === null) throw new Error('已完成任务缺少真实能力计划')
    const checkpoint = JSON.parse(await readFile(join(workspace.projectRoot, 'runs', plan.workId,
      'task-checkpoint.json'), 'utf8')) as { plan_patches: unknown[] }
    return { section: { title: section.title, parent_id: section.parent_id, level: section.level },
      plan: { status: plan.status, steps: plan.steps.map(step => ({
        description: step.description, status: step.status, hasResult: Boolean(step.detail),
      })) },
      bodyPreserved: await readFile(join(workspace.projectRoot, 'chapters/sections/0003.md'), 'utf8') === originalBody,
      initialDescriptionRejected, replacementDescriptionRejected, descriptionSchemaChecked, descriptionGuidanceChecked,
      planPatchCount: checkpoint.plan_patches.length,
      userMessages: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length,
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      completed: events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed').length }
  } finally { release() }
}

/** @param ctx 源码 Loader 装配。 @param root 临时项目。 @param terminal 是否模拟旧任务的授权阻断。 @returns 新用户任务接管旧 Work 后的正式目录身份。 */
export async function runCapabilitySupersedeLoop(ctx: Context, root: string, terminal = false) {
  const { agent, workspace, parentScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  const seeded = await seedCapabilityProject(workspace, 'complete')
  const wrongTitle = '提供完整的建设方案，包括首个细粒度评分响应点'
  const wrong = { ...seeded.outline, sections: seeded.outline.sections.map(section =>
    section.id === 'SEC-1' ? { ...section, parent_id: null, order: 3, level: 1, title: wrongTitle } : section) }
  for (const path of ['outline/outline.json', 'outline/confirmed-outline.json']) {
    await writeFile(join(workspace.projectRoot, path), `${JSON.stringify(wrong)}\n`)
  }
  const stable = { stage: 'evidence_mapping' as const, status: 'completed' as const, run: null }
  agent.session.append('bid.task.changed', { state: stable })
  await checkpointBidProjectState(workspace, stable)
  if (ctx.get('bid') === undefined) await ctx.plugin(BidHostRuntime)
  const before = agent.session.events.length
  parentScript.push(
    call('bid_run_task', await modelTaskArguments(agent, { task: { goal: '完成 S4 资料映射', scope: { kind: 'project' }, steps: [{
      description: '重新生成已有目录', scope: { source: 'task' }, call: { capability: 'outline.generate', input: {} },
    }] } })),
    answer('旧任务执行失败。'),
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '完成 S4 资料映射' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await waitCapabilityOperations(ctx)
  await agent.whenIdle()
  const old = await readBidProjectState(workspace)
  if (old?.status !== 'failed') throw new Error('旧能力任务未保存失败状态')
  const oldRun = bidRecoverableRun(agent.session, old)
  if (oldRun?.work.kind !== 'capability_task') throw new Error('旧能力任务缺少原 Run 身份')
  const oldWorkId = oldRun.work.workId
  if (terminal) {
    const failed = { stage: old.stage, status: 'failed' as const, run: null,
      failure: { code: 'BID_TASK_SCOPE_AUTHORIZATION_REQUIRED', message: '旧任务授权范围需要新用户消息澄清',
        recovery: { kind: 'blocked' as const, unit: oldWorkId, reason: '旧任务授权范围需要新用户消息澄清' } } }
    agent.session.append('bid.task.changed', { state: failed })
    agent.session.append('bid.run.notice', { noticeId: `run:${oldRun.runId}:failed`, supersedesTurn: null,
      runId: oldRun.runId, stage: old.stage, kind: 'interrupted', severity: 'error', message: failed.failure.message })
    await checkpointBidProjectState(workspace, failed)
  }
  parentScript.push(
    call('bid_project_inspect', { query: { object: 'task' } }),
    call('bid_run_task', await modelTaskArguments(agent, { task: { goal: '修正评分点目录层级，首个细粒度评分点不作大标题',
      scope: { kind: 'project' }, allow_pending_content: true, steps: [{
        description: '移回设计评分点并恢复章节标题', scope: { source: 'task' },
        call: { capability: 'outline.update', input: { operations: [
          { type: 'move_section', section_id: 'SEC-1', parent_id: 'GROUP-A', order: 1 },
          { type: 'update_section', section_id: 'SEC-1', title: '总体实施方案',
            must_answer: ['回答评分1，说明实施方案的范围和方法'] },
        ] } },
      }] }, supersede: { run_id: oldRun.runId, expected_project_revision: old.revision } })),
    answer('已接纳新任务，等待真实结果。'),
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '修正评分点目录层级，首个细粒度评分点不作大标题' }],
    source: { kind: 'user' } }))
  await agent.whenIdle()
  await waitCapabilityOperations(ctx)
  await agent.whenIdle()
  const current = await readBidProjectState(workspace)
  const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as typeof wrong
  const leaf = outline.sections.find(section => section.id === 'SEC-1')
  const events = agent.session.events.slice(before)
  const runs = events.filter(event => event.type === 'bid.run.started')
  await ctx.sessions.flush(agent.session)
  return { status: current?.status, wrongTitleGone: !outline.sections.some(section => section.title === wrongTitle),
    leaf: leaf === undefined ? null : { title: leaf.title, parent_id: leaf.parent_id,
      responsePoints: leaf.scoring_response_point_ids, mustAnswer: leaf.must_answer },
    distinctWork: runs.length === 2 && runs[0]?.data.run.work.workId !== runs[1]?.data.run.work.workId
      && runs[0]?.data.run.work.workId === oldWorkId,
    resumedOldWork: runs[1]?.data.run.resumeOf !== undefined,
    calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
    supersededNotice: events.some(event => event.type === 'bid.run.notice'
      && event.data.noticeId === `run:${oldRun.runId}:superseded`),
  }
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
  for (const input of ['现在是什么情况？', '这样可以吗？', '可以', '没问题']) {
    await send(input, [call('bid_stage_inspect', {}), answer('仍需点击正式确认按钮。')])
  }
  const outlinePath = join(workspace.projectRoot, 'outline/outline.json')
  const original = await readFile(outlinePath, 'utf8')
  await send('更新目录', [call('write', { file_path: outlinePath, content: '{}' }), answer('请使用阶段工具修改。')])
  const rawWriteBlocked = await readFile(outlinePath, 'utf8') === original
  const initial = await getOrCreateOutlineDraft(workspace)
  const sectionId = initial.outline.sections[0]!.id
  const businessObjects = (await collectBidModelTaskCatalog(workspace)).objects
  childScript.push((options) => {
    const targets = JSON.parse(visibleTarget(options, /本次可修改章节：([^\r\n]+)/u)) as object[]
    const candidate = JSON.parse(visibleTarget(options, /当前候选目录：([^\r\n]+)/u)) as Array<{
      title: string
      requirement_positions: number[]
      scoring_positions: number[]
      response_point_positions: number[]
      compliance_positions: number[]
    }>
    const parent = candidate.find(section => section.title === initial.outline.sections[0]!.title)!
    return answer(JSON.stringify(targets.map((_, index) => ({ requirement_positions: index === 0 ? parent.requirement_positions : [],
      scoring_positions: index === 0 ? parent.scoring_positions : [],
      response_point_positions: index === 0 ? (initial.outline.sections[0]!.scoring_response_point_ids ?? [])
        .map(id => businessObjects.response_points.findIndex(entry => entry.id === id)) : [],
      compliance_positions: index === 0 ? parent.compliance_positions : [] }))))
  })
  await send('第一章拆成实施准备、实施过程、验收移交', [call('bid_outline_apply_operations', {
    operations: [{ type: 'split_section', draft_section_position: 0, children: ['实施准备', '实施过程', '验收移交'].map(title => ({ title, purpose: title, must_answer: [`${title}的安排`] })) }],
  }), answer('已更新，请重新确认。')])
  const split = await getOrCreateOutlineDraft(workspace)
  const target = split.outline.sections.find(item => item.parent_id === sectionId)!
  childScript.push(answer(JSON.stringify([{ type: 'update_section', section_id: target.id, title: '实施准备与资源核查' }])))
  await send('实施准备这一节重新规划一下', [call('bid_project_inspect', { query: { object: 'outline' } }), call('bid_outline_regenerate_scope', {
    draft_section_positions: [split.outline.sections.findIndex(section => section.id === target.id)], feedback: '明确资源核查' }), answer('已更新，请重新确认。')])
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
    call('bid_run_task', await modelTaskArguments(agent, { task: { goal: '更正第一条要求的理解', scope: { kind: 'project' },
      steps: [{ description: '执行已授权的测试步骤', scope: { source: 'task' }, call: { capability: 'tender.update', input: {
        operations: [{ type: 'update_requirement', requirement_id: 'REQ-1',
          fields: { normalized_requirement: '明确实施边界' } }],
      } } }],
    } })),
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
    const targets = JSON.parse(visibleTarget(options, /本次可修改章节：([^\r\n]+)/u)) as object[]
    const positions = (entries: readonly { id: string }[], ids: readonly string[]) =>
      ids.map(id => entries.findIndex(entry => entry.id === id))
    return answer(JSON.stringify(targets.map((_, index) => ({
      requirement_positions: index === 0 ? positions(businessObjects.requirements, target.requirement_ids) : [],
      scoring_positions: index === 0 ? positions(businessObjects.scoring, target.scoring_ids) : [],
      response_point_positions: index === 0 ? positions(businessObjects.response_points, target.scoring_response_point_ids ?? []) : [],
      compliance_positions: index === 0 ? positions(businessObjects.compliance, target.compliance_ids) : [],
    }))))
  })
  const splitTask = { goal: '拆分实施准备目录',
    scope: { kind: 'sections', section_ids: [target.id] }, steps: [{ description: '执行已授权的测试步骤', scope: { source: 'task' },
      call: { capability: 'outline.update', input: {
        operations: [{ type: 'split_section', section_id: target.id,
          children: ['人员准备', '资源核查'].map(title => ({ title, purpose: title, must_answer: [`${title}的安排`] })) }],
        defer_content_migration: true,
      } } }],
  }
  await send('将实施准备拆为人员准备和资源核查两个小节，只调整目录', [
    call('bid_run_task', await modelTaskArguments(agent, { task: { ...splitTask, steps: [...splitTask.steps, {
      description: '迁移原文但故意缺少后续正文复核', scope: { source: 'task' },
      call: { capability: 'chapter.reorganize', input: { instruction: '保留原文', source_section_ids: [target.id] } },
    }] } })),
    call('bid_run_task', await modelTaskArguments(agent, { task: { ...splitTask, allow_pending_content: true } })),
    answer('正在拆分目录并分配业务要求。'),
  ])
  const capabilityDraft = await getOrCreateOutlineDraft(workspace)
  const splitChildren = capabilityDraft.outline.sections.filter(section => section.parent_id === target.id)
  const capabilitySplit = splitChildren.map(section => ({ title: section.title,
    responsePoints: section.scoring_response_point_ids ?? [] }))
  if (childScript.length !== 0 || splitChildren.length !== 2) throw new Error('目录能力未完成拆分与业务分配')
  const calls = agent.session.events.slice(before).filter(event => event.type === 'tool/call').map(event => event.data.name)
  const failures = agent.session.events.slice(before).filter(event => event.type === 'tool/result').filter(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError))
  const incompletePlanRejected = JSON.stringify(failures).includes('BID_CAPABILITY_CONTENT_FOLLOWUP_REQUIRED')
  if (!incompletePlanRejected) throw new Error('工具接纳了缺少正文后续步骤的计划')
  const state = agent.session.events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)
  const visibleTools = ctx.tools.schemas(agent).map(tool => tool.name)
  const confirmations = agent.session.events.slice(before).filter(event => event.type === 'bid.user_confirmation.received' || event.type === 'bid.stage.completed').length
  await ctx.sessions.flush(agent.session)
  releaseObserver()
  await hostFiber?.dispose()
  return { turns, calls, failures: failures.length, rawWriteBlocked, untouchedEvidencePreserved, confirmations, state,
    readOnlyNoWork, planOnlyNoWork, capabilityUpdates, capabilitySplit, incompletePlanRejected,
    updatedRequirement: updatedRequirements.requirements.find(item => item.id === 'REQ-1')?.normalized_requirement,
    revision: finalDraft.revision, titles: finalDraft.outline.sections.map(section => section.title),
    visibleTools, concurrent: await Promise.all(concurrent), disposed: hostFiber === undefined ? null : !ctx.tools.schemas(agent).some(tool => tool.name.startsWith('bid_')) }
}
