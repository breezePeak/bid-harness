/** 真实 Host 工具以新的直接用户授权接管耗尽预算的 S4 失败候选。 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { bidRecoverableRun, bidRunRecoveryEligibility } from '../src/bid-recovery.ts'
import { checkpointBidProjectState, readBidProjectState } from '../src/project-state.ts'
import { prepareBidWorkingTree, readExistingBidWorkingTree } from '../src/working-tree.ts'
import { readBidWorkRequest } from '../src/work-descriptor.ts'
import { BidHostRuntime } from '../src/index.ts'
import { readEvidenceMappingLog } from '../src/evidence-mapping-executor.ts'
import { withBidNativeTaskAuthorization } from '../src/bid-tool-authorization.ts'
import { runEvidenceMappingLoop } from './fixtures/evidence-mapping-loop.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

async function failedCandidate() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s4-new-authorization-'))
  const baseConfig = fileURLToPath(new URL('../../../../examples/headless-agent/bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const config = (await readFile(baseConfig, 'utf8')).replace("root: './.session-store'",
    `root: '${join(root, '.session-store').replaceAll('\\', '/')}'`)
    .replace("- name: '../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'\n", '')
    .replace("- name: '@deepseek-ai/dsh-bid'\n", '')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, config)
  const ctx = await boot('bid-s4-new-authorization', configPath, undefined, undefined, new URL('../../../../examples/headless-agent/', import.meta.url).href)
  try {
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(BidHostRuntime)
    ctx.userQuestions.registerProvider({ ask: ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('取消待答问题')) }, { once: true })
    }) })
    const result = await runEvidenceMappingLoop(ctx, root, false, true, undefined, 'local', true)
    if (result.outcome.status !== 'failed') throw new Error(JSON.stringify(result.outcome))
    const saved = await checkpointBidProjectState(result.workspace, result.outcome)
    result.agent.session.append('bid.project.resumed', { state: result.outcome, revision: saved.revision })
    const run = bidRecoverableRun(result.agent.session, result.outcome)
    const eligible = bidRunRecoveryEligibility(result.agent.session, 3)
    if (run === undefined || !eligible.eligible || eligible.target === undefined || eligible.fingerprint === undefined) {
      throw new Error('未找到结构失败 Work')
    }
    for (let attempt = 0; attempt < 3; attempt++) result.agent.session.append('bid.recovery.requested', {
      ownerSessionId: String(result.agent.session.id), target: eligible.target, unit: run.error?.recovery?.unit ?? run.work.workId,
      instruction: `已耗尽的原授权补修 ${String(attempt + 1)}`, progressFingerprint: eligible.fingerprint,
    })
    expect(bidRunRecoveryEligibility(result.agent.session, 3).eligible).toBe(false)
    await result.agent.whenIdle()
    return { ...result, ctx, run }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

const instruction = '保留已研究资料，明确授权岗位核验与审计岗位追溯责任，只补修失败章节后重新复核。'
const structureStep = { description: '补修核验和追溯责任', scope: { source: 'task' },
  call: { capability: 'outline.refine', input: { feedback: instruction } } }

describe('S4 新明确授权接管', () => {
  it.each([false, true])('预算耗尽后真实工具另建 Work，取消后续跑=%s，只运行定向 Child', async (cancel) => {
    const result = await failedCandidate()
    const { ctx, agent, workspace, run } = result
    try {
      const before = await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')
      const originalLog = await readEvidenceMappingLog(workspace)
      const initialRequests = result.requests.length
      const task = { goal: instruction, scope: { kind: 'project' }, steps: [structureStep] }
      let stopped: Promise<{ accepted: true }> | undefined
      const off = ctx.on('session/event', (session, event) => {
        if (cancel && session === agent.session && event.type === 'bid.recovery.requested'
          && event.data.target.kind === 'run' && event.data.target.workId !== run.work.workId) stopped = ctx.bid.stopRun(session)
      }, { global: true })
      result.parentScript.push(call('bid_project_inspect', { query: { object: 'outline' } }),
        call('bid_run_task', { task, supersede: true }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
      if (cancel) {
        await vi.waitFor(() => { expect(stopped).toBeDefined() }, { timeout: 10_000 })
        await stopped
        off()
        const operations = (ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
        await Promise.all([...operations.values()].map(operation => operation.done))
        await agent.whenIdle()
        const saved = await readBidProjectState(workspace)
        if (saved?.status !== 'suspended') throw new Error('新 Work 未保存取消：' + JSON.stringify(saved))
        expect(saved.run.cause).toBe('user_stop')
        const other = (await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('s4-other-owner'),
          agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: workspace.root, agentPreset: 'bid' } })).agent
        await vi.waitFor(() => {
          expect(other.session.events.some(event => event.type === 'bid.project.resumed')).toBe(true)
          expect(operations.size).toBe(0)
        })
        const latest = await readBidProjectState(workspace)
        if (latest === undefined) throw new Error('项目状态丢失')
        await expect(ctx.bid.resumeCurrentRun(other.session, saved.run.runId, latest.revision))
          .rejects.toMatchObject({ code: 'BID_RESUME_OWNER_SESSION_REQUIRED' })
        await vi.waitFor(() => { expect(operations.size).toBe(0) })
        result.parentScript.push(call('bid_stage_inspect', { view: 'recovery' }), call('bid_resume_current_run', {}))
        agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续刚才的新授权目录补修，保留已保存目标和候选。' }], source: { kind: 'user' } }))
      } else off()
      await vi.waitFor(() => {
        const completed = agent.session.events.findLast(event => event.type === 'bid.run.completed')
        if (completed?.type !== 'bid.run.completed') throw new Error(JSON.stringify(agent.session.events
          .filter(event => event.type === 'tool/result' || event.type === 'bid.task.changed').slice(-4)))
        expect(completed.data.run.work.workId).not.toBe(run.work.workId)
      }, { timeout: 45_000 })
      const operations = (ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
      await Promise.all([...operations.values()].map(operation => operation.done))
      await agent.whenIdle()
      expect(await readBidProjectState(workspace)).toMatchObject({ stage: 'evidence_mapping', status: 'waiting_user' })
      const started = agent.session.events.filter(event => event.type === 'bid.run.started')
      expect(started).toHaveLength(cancel ? 3 : 2)
      const next = started.at(-1)?.data.run
      if (next === undefined) throw new Error('新 Work 未启动')
      expect(next.work.kind).toBe('stage_execution')
      if (cancel) expect(next.resumeOf?.runId).toBe(started[1]?.data.run.runId)
      else expect(next.resumeOf).toBeUndefined()
      expect(await readBidWorkRequest(workspace, next.work)).toMatchObject({ kind: 'evidence_mapping_takeover', task,
        source_work: run.work, authorization: { session_id: String(agent.session.id) } })
      const original = await readExistingBidWorkingTree(workspace, run.work)
      if (original === null) throw new Error('原失败候选未保留')
      expect(await readFile(join(original.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')).toBe(before)
      const recoveries = agent.session.events.filter(event => event.type === 'bid.recovery.requested')
      expect(recoveries.filter(event => event.data.target.kind === 'run' && event.data.target.workId === run.work.workId)).toHaveLength(3)
      expect(recoveries.filter(event => event.data.target.kind === 'run' && event.data.target.workId === next.work.workId)).toHaveLength(1)
      const prompts = result.requests.slice(initialRequests).map(request => request.messages.flatMap(message => message.content)
        .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      const completedLog = await readEvidenceMappingLog(workspace)
      expect(completedLog?.tasks.find(task => task.task_id === 'MAP-REPAIR-2-SEC-SECURITY')?.status).toBe('completed')
      for (const task of originalLog?.tasks ?? []) {
        expect(completedLog?.tasks.find(item => item.task_id === task.task_id)?.attempts).toEqual(task.attempts)
        expect(result.requests.slice(initialRequests).some(request => request.sessionId === task.final_child_session_id)).toBe(false)
      }
      expect(prompts.some(prompt => prompt.includes('已接纳任务目标：' + instruction))).toBe(true)
      expect(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')).toContain('由授权岗位核验权限生效')
    } finally { await ctx.fiber.dispose() }
  }, 60_000)

  it('真实工具拒绝含后续写作的多步计划，保留原失败状态和预算', async () => {
    const result = await failedCandidate()
    try {
      result.parentScript.push(call('bid_project_inspect', { query: { object: 'outline' } }), call('bid_run_task', {
        supersede: true, task: { goal: instruction, scope: { kind: 'project' }, steps: [structureStep,
          { description: '按修复目录写作', scope: { source: 'task' }, call: { capability: 'chapter.write', input: { instruction } } }] },
      }))
      result.agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
      await result.agent.whenIdle()
      const output = result.agent.session.events.filter(event => event.type === 'tool/result').at(-1)
      expect(JSON.stringify(output)).toContain('BID_S4_SUPERSEDE_SINGLE_STRUCTURE_PLAN_REQUIRED')
      expect(result.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
      expect(await readBidProjectState(result.workspace)).toMatchObject({ status: 'failed' })
      expect(bidRunRecoveryEligibility(result.agent.session, 3).eligible).toBe(false)
    } finally { await result.ctx.fiber.dispose() }
  }, 60_000)

  it('缺少新的直接用户消息时，真实工具不能自动重置耗尽预算', async () => {
    const result = await failedCandidate()
    try {
      const historic = createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } })
      result.agent.session.append('user/message', historic, { surfaceOp: 'append' })
      const failure = result.agent.session.events.findLast(event => event.type === 'bid.run.notice'
        && event.data.noticeId === `run:${result.run.runId}:failed`)
      if (failure?.type !== 'bid.run.notice') throw new Error('缺少失败通知')
      result.agent.session.append('bid.run.notice', { ...failure.data })
      const inspected = await result.ctx.tools.execute({ agent: result.agent, name: 'bid_project_inspect',
        arguments: { query: { object: 'outline' } }, callId: CallId('historic-inspect'), signal: new AbortController().signal })
      expect(inspected.isError).not.toBe(true)
      const output = await withBidNativeTaskAuthorization(result.agent.session, historic, () => result.ctx.tools.execute({
        agent: result.agent, name: 'bid_run_task', arguments: { supersede: true,
          task: { goal: instruction, scope: { kind: 'project' }, steps: [structureStep] } },
        callId: CallId('historic-authorization'), signal: new AbortController().signal,
      }))
      expect(JSON.stringify(output)).toContain('BID_CAPABILITY_USER_MESSAGE_REQUIRED')
      expect(result.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
      expect(bidRunRecoveryEligibility(result.agent.session, 3).eligible).toBe(false)
    } finally { await result.ctx.fiber.dispose() }
  }, 60_000)

  it.each(['identity', 'checkpoint'] as const)('真实入口拒绝未经核对的原候选 %s', async (fault) => {
    const result = await failedCandidate()
    try {
      if (fault === 'identity') {
        const tree = await prepareBidWorkingTree(result.workspace, result.run.work)
        await writeFile(join(tree.root, 'work-identity.json'), JSON.stringify({ ...result.run.work, requestSha256: '0'.repeat(64) }))
      } else await writeFile(join(result.workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), '{"tasks":false}')
      result.parentScript.push(call('bid_project_inspect', { query: { object: 'outline' } }), call('bid_run_task', {
        supersede: true, task: { goal: instruction, scope: { kind: 'project' }, steps: [structureStep] },
      }))
      result.agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
      await result.agent.whenIdle()
      const output = result.agent.session.events.filter(event => event.type === 'tool/result').at(-1)
      expect(JSON.stringify(output)).toContain(fault === 'identity' ? 'BID_WORKING_TREE_IDENTITY_MISMATCH' : 'expected array')
      expect(result.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
      expect(await readBidProjectState(result.workspace)).toMatchObject({ status: 'failed' })
    } finally { await result.ctx.fiber.dispose() }
  }, 60_000)

  it('已完成检查点指纹损坏时新 Work 明确失败，不退回整本初始研究', async () => {
    const result = await failedCandidate()
    try {
      const path = join(result.workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json')
      const checkpoint = JSON.parse(await readFile(path, 'utf8')) as { tasks: Array<{ input_fingerprint: string }> }
      const completed = checkpoint.tasks[0]
      if (completed === undefined) throw new Error('缺少已完成研究检查点')
      completed.input_fingerprint = '0'.repeat(64)
      await writeFile(path, JSON.stringify(checkpoint))
      const initialRequests = result.requests.length
      result.parentScript.push(call('bid_project_inspect', { query: { object: 'outline' } }), call('bid_run_task', {
        supersede: true, task: { goal: instruction, scope: { kind: 'project' }, steps: [structureStep] },
      }))
      result.agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
      await vi.waitFor(() => {
        const failed = result.agent.session.events.findLast(event => event.type === 'bid.task.changed' && event.data.state.status === 'failed')
        expect(JSON.stringify(failed)).toContain('BID_S4_SUPERSEDE_CANDIDATE_FINGERPRINT_MISMATCH')
      }, { timeout: 10_000 })
      const operations = (result.ctx.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
      await Promise.all([...operations.values()].map(operation => operation.done))
      expect(result.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
      expect(result.requests.slice(initialRequests).filter(request => request.system?.includes('技术标章节研究 Subagent'))).toEqual([])
      expect(await readBidProjectState(result.workspace)).toMatchObject({ status: 'failed' })
      expect(result.agent.session.events.filter(event => event.type === 'bid.recovery.requested'
        && event.data.target.kind === 'run' && event.data.target.workId === result.run.work.workId)).toHaveLength(3)
    } finally { await result.ctx.fiber.dispose() }
  }, 60_000)
})
