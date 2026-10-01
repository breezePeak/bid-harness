/** 源码 Loader 中遗漏导出后的 Main 重规划；模型回复由测试脚本确定。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { BidHostRuntime, checkpointBidProjectState, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { runEvidenceMappingLoop } from './evidence-mapping-loop.ts'
import { seedCapabilityProject } from '../capability-fixture.ts'
import { capabilityTaskCheckpointSchema } from '../../src/bid-capability-task.ts'
import { readCapabilityPublicationRecord } from '../../src/bid-capability-changes.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function answer(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

/**
 * 用一次真实用户消息拒绝遗漏导出的计划，再在原 Work 补尾步骤并生成 Word。
 * @param ctx 源码 Loader 装配。
 * @param root 临时项目。
 * @returns 实际工具调用、有效计划和文件凭据。
 */
export async function runTaskExportLoop(ctx: Context, root: string) {
  const { workspace, agent, parentScript } = await runEvidenceMappingLoop(ctx, root, false, true)
  await seedCapabilityProject(workspace, 'complete')
  const metadataPath = join(workspace.projectRoot, 'chapters/meta/0001.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as object
  await writeFile(metadataPath, JSON.stringify({ ...metadata, flowcharts: [] }))
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 章节1\n\n实施范围与交付步骤。\n')
  const state = { stage: 'chapter_writing' as const, status: 'completed' as const, run: null }
  await checkpointBidProjectState(workspace, state)
  agent.session.append('bid.task.changed', { state })
  if (ctx.get('bid') === undefined) await ctx.plugin(BidHostRuntime)
  const before = agent.session.events.length
  const completed = Promise.withResolvers<undefined>()
  const release = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'bid.run.notice' && event.data.kind === 'completed') completed.resolve(undefined)
  }, { global: true })
  parentScript.push(
    call('bid_project_inspect', { query: { object: 'tender', part: 'requirements' } }),
    call('bid_run_task', { task: { goal: '更正要求并导出 Word', scope: { kind: 'project' }, steps: [{
      description: '更正第一条要求', scope: { source: 'task' }, call: { capability: 'tender.update', input: { operations: [{
        type: 'update_requirement', requirement_position: 0, fields: { normalized_requirement: '交付范围包含测试' },
      }] } },
    }] } }), answer('任务已接纳。'),
    call('bid_stage_inspect', { view: 'recovery' }),
    call('bid_project_inspect', { query: { object: 'task', source: 'candidate' } }),
    call('bid_plan_task', { edit: 'append', steps: [{ description: '导出 Word', scope: { source: 'task' },
      call: { capability: 'docx.export', input: { template_position: null } } }] }),
    call('bid_recover_task', { target: 'run', instruction: '原 Work 补齐导出尾步骤，内容发布后完成导出。' }),
    answer('已继续原任务。'),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '更正要求并导出 Word。' }] }))
    await Promise.race([completed.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('原 Work 补齐导出未产生完成通知：' + JSON.stringify({
        calls: agent.session.events.slice(before).filter(event => event.type === 'tool/call').map(event => event.data.name),
        failures: agent.session.events.slice(before).filter(event => event.type === 'bid.run.suspended'
          || event.type === 'bid.docx_export.changed' || event.type === 'bid.run.notice').map(event => ({ type: event.type, data: event.data })),
        last: agent.session.deriveMessages().at(-1),
      }))) }, 35_000)
    })])
    const host = ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }
    while (host.inFlight.size > 0) await Promise.all([...host.inFlight.values()].map(operation => operation.done))
    await agent.whenIdle()
    const events = agent.session.events.slice(before)
    const runs = events.flatMap(event => event.type === 'bid.run.started' && event.data.run.work.kind === 'capability_task'
      ? [event.data.run] : [])
    const work = runs[0]?.work
    if (work === undefined) throw new Error('缺少能力 Work')
    const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(join(workspace.projectRoot,
      'runs/' + work.workId + '/task-checkpoint.json'), 'utf8')))
    const receipt = await readCapabilityPublicationRecord(workspace, work.workId, work.requestSha256)
    const bytes = receipt?.export_receipt === undefined ? undefined
      : await readFile(join(workspace.projectRoot, receipt.export_receipt.path))
    const plan = await ctx.bid.getCapabilityTaskPlan(agent.session)
    await ctx.sessions.flush(agent.session)
    return { state: (await readBidProjectState(workspace))?.status,
      sameWork: new Set(runs.map(run => run.work.workId)).size === 1,
      userMessages: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length,
      planRejected: checkpoint.verifications?.some(record => record.phase === 'plan' && record.unmet.some(item => item.includes('docx.export'))) === true,
      steps: checkpoint.steps.map(record => ({ capability: record.step.call.capability, status: record.status })),
      displayedSteps: plan?.steps.map(step => ({ capability: step.capability, status: step.status })),
      goalMet: receipt?.goal_met, wordFile: bytes?.readUInt32LE(0) === 0x04034b50,
      calls: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      completedNotices: events.filter(event => event.type === 'bid.run.notice' && event.data.kind === 'completed').length }
  } finally { clearTimeout(timer); release() }
}
