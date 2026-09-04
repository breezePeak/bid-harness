/** 阶段交互的真实 Main Agent 工具循环；只脚本化外部模型回复。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { BidHostRuntime, BidOrchestratorError, checkpointBidProjectState, getOrCreateOutlineDraft, parseEvidenceMapArtifact, BID_INITIAL_RUNTIME_STATE, reduceBidRuntimeState } from '@deepseek-ai/dsh-bid'
import { runEvidenceMappingLoop } from './evidence-mapping-loop.ts'
import { outlineRegenerationChanges } from '../../src/outline-regeneration-artifacts.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

/** @param ctx 测试装配。 @param root 临时工作区。 @returns 整本重生成后的 Draft 与阶段状态。 */
export async function runFullOutlineRegenerationLoop(ctx: Context, root: string) {
  const { agent, workspace, parentScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await checkpointBidProjectState(workspace, agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE))
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  const draft = await getOrCreateOutlineDraft(workspace)
  const candidate = { ...draft.outline, sections: draft.outline.sections.map(section => ({ ...section, title: `${section.title}方案` })) }
  const original = await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')
  const quality = await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')
  const changeSet = { schema_version: 1, base_revision: draft.revision, base_draft_sha256: draft.draft_outline_sha256,
    changes: outlineRegenerationChanges(draft.outline, candidate).map(change => ({ ...change, reason: '明确方案标题' })) }
  parentScript.push(
    call('write', { file_path: join(workspace.projectRoot, 'outline/outline.json'), content: JSON.stringify(candidate) }),
    call('write', { file_path: join(workspace.projectRoot, 'outline/regeneration/change-set.json'), content: JSON.stringify(changeSet) }),
    answer('目录已重生成。'),
    call('write', { file_path: join(workspace.projectRoot, 'outline/quality-report.json'), content: quality }),
    answer('目录已复核。'),
  )
  const start = agent.session.events.length
  const result = await ctx.bid.regenerateOutline(agent.session, {
    expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256, feedback: '明确方案标题',
  })
  return { result, draft: await getOrCreateOutlineDraft(workspace),
    canonicalPreserved: await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8') === original,
    state: agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE),
    transitions: agent.session.events.slice(start).filter(event => event.type.startsWith('bid.') && event.type !== 'bid.project.resumed').map(event => event.type) }
}

/** @param ctx 真实 Loader 或测试装配。 @param root 临时工作区。 @returns 不含环境路径的阶段交互结果。 */
export async function runStageInteractionLoop(ctx: Context, root: string, checkRejections = false) {
  const { agent, workspace, parentScript, childScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await checkpointBidProjectState(workspace, agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE))
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  const hostFiber = ctx.get('bid') === undefined ? ctx.plugin(BidHostRuntime) : undefined
  await hostFiber
  const before = agent.session.events.length
  const concurrent: Promise<string>[] = []
  const releaseObserver = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'bid.stage.started') return
    if (ctx.bail('session/prompt-admission', { session, mode: 'steer', content: [{ type: 'text', text: 'test' }] }) === undefined) throw new Error('阶段执行期间接受了普通消息')
    concurrent.push(ctx.bid.applyOutlineDraftOperations(session, { expected_revision: 1, expected_draft_sha256: 'a'.repeat(64), operations: [] })
      .then(() => 'unexpected success', (error: unknown) => error instanceof BidOrchestratorError ? error.code : String(error)))
  }, { global: true })
  const turns: Array<{ input: string; admitted: boolean }> = []
  const send = async (input: string, script: StreamChunk[][]) => {
    const rejection = ctx.bail('session/prompt-admission', { session: agent.session, mode: 'steer', content: [{ type: 'text', text: input }] })
    turns.push({ input, admitted: rejection === undefined })
    if (rejection !== undefined) throw new Error(JSON.stringify(rejection))
    parentScript.push(...script)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
    await agent.whenIdle()
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
  }), answer('已更新，请重新确认。')])
  const split = await getOrCreateOutlineDraft(workspace)
  const target = split.outline.sections.find(item => item.parent_id === sectionId)!
  childScript.push(answer(JSON.stringify([{ type: 'update_section', section_id: target.id, title: '实施准备与资源核查' }])))
  await send('实施准备这一节重新规划一下', [call('bid_outline_regenerate_scope', { ...await identity(), section_ids: [target.id], feedback: '明确资源核查' }), answer('已更新，请重新确认。')])
  if (await readFile(outlinePath, 'utf8') !== original) throw new Error('连续编辑覆盖了已完成研究的目录')
  const priorMap = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
  childScript.push(answer(JSON.stringify({ task_id: `MAP-REMAP-${sectionId}`, section_mappings: [{
    section_id: target.id, local_materials: [], web_materials: [], missing_topics: ['缺少当前章节专用资料'], writing_dimensions: ['资源核查'],
    writing_brief: { purpose: '明确访问控制实施前的资源及权限配置核查', must_answer: ['实施前如何核对资源与访问权限配置'],
      writing_notes: ['列明核查责任人、资源清单和问题处理方式'], suggested_tables: ['资源与权限核查清单'], suggested_figures: [],
      requirement_ids: target.requirement_ids,
      scoring_ids: target.scoring_ids,
      scoring_response_point_ids: target.scoring_response_point_ids ?? [],
    },
  }], refinement_suggestions: [] })))
  await send('这一节资料不对，重新找', [call('bid_evidence_remap', { ...await identity(), section_ids: [target.id], mode: 'replace', reason: '资料不对' }), answer('已更新，请重新确认。')])
  const finalDraft = await getOrCreateOutlineDraft(workspace)
  if (await readFile(outlinePath, 'utf8') !== original) throw new Error('局部资料研究覆盖了其他章节的研究基线')
  const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
  if (checkRejections) {
    const paths = [
      'outline/draft.json', 'outline/outline.json', 'outline/quality-report.json', 'analysis/evidence-map.json',
      'analysis/web-evidence-sources.json', 'analysis/evidence-mapping-plan.json', 'analysis/evidence-mapping-log.json',
    ]
    const baseline = await Promise.all(paths.map(path => readFile(join(workspace.projectRoot, path), 'utf8')))
    childScript.push(answer(JSON.stringify([{ type: 'update_section', section_id: split.outline.sections.find(item => item.id !== target.id && item.writable)!.id, title: '范围外修改' }])))
    await send('只改实施准备', [call('bid_outline_regenerate_scope', { ...await identity(), section_ids: [target.id], feedback: '完善实施准备' }), answer('修改被拒绝。')])
    await send('重映射不存在的章节', [call('bid_evidence_remap', { ...await identity(), section_ids: ['SEC-UNKNOWN'] }), answer('请明确目标章节。')])
    const after = await Promise.all(paths.map(path => readFile(join(workspace.projectRoot, path), 'utf8')))
    if (JSON.stringify(after) !== JSON.stringify(baseline)) throw new Error('失败后未恢复阶段产物')
  }
  const untouchedEvidencePreserved = map.section_mappings.filter(item => item.section_id !== target.id)
    .every((item) => {
      const previous = priorMap.section_mappings.find(mapping => mapping.section_id === item.section_id)
      return JSON.stringify(item) === JSON.stringify(previous)
    })
  const calls = agent.session.events.slice(before).filter(event => event.type === 'tool/call').map(event => event.data.name)
  const failures = agent.session.events.slice(before).filter(event => event.type === 'tool/result').filter(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError))
  const state = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
  const visibleTools = ctx.tools.schemas(agent).map(tool => tool.name)
  const confirmations = agent.session.events.slice(before).filter(event => event.type === 'bid.user_confirmation.received' || event.type === 'bid.stage.completed').length
  await ctx.sessions.flush(agent.session)
  releaseObserver()
  await hostFiber?.dispose()
  return { turns, calls, failures: failures.length, rawWriteBlocked, untouchedEvidencePreserved, confirmations, state,
    revision: finalDraft.revision, titles: finalDraft.outline.sections.map(section => section.title),
    target: map.section_mappings.find(item => item.section_id === target.id),
    visibleTools, concurrent: await Promise.all(concurrent), disposed: hostFiber === undefined ? null : !ctx.tools.schemas(agent).some(tool => tool.name.startsWith('bid_')) }
}
