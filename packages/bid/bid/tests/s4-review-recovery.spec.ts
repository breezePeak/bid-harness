/** 旧 blocked 会话重启后的真实工具、原 Work 检查点与正式确认回归。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { BidHostRuntime, BidWorkspace, parseOutlineArtifact, parseEvidenceMapArtifact } from '../src/index.ts'
import { bidRecoverableRun, bidRunRecoveryEligibility } from '../src/bid-recovery.ts'
import { checkpointBidProjectState, readBidProjectState } from '../src/project-state.ts'
import { registerIntegrationTools, runEvidenceMappingLoop, runEvidenceMappingRecoveryLoop } from './fixtures/evidence-mapping-loop.ts'
import { recordBidUserAnswer } from '../src/bid-user-input.ts'
import type { ModelStageExecutionOptions } from '../src/model-stage-repair.ts'

const call = (name: string, args: object): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

it.each(['automatic', 'user_continue', 'accepted_stopped', 'long_history', 'wrong_work', 'wrong_request', 'wrong_instruction'] as const)(
  '真实 S4 结构补修校验授权并消费最新业务回答：%s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-s4-structure-consumer-'))
    const base = fileURLToPath(new URL('../../../../examples/headless-agent/bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
    const config = (await readFile(base, 'utf8')).replace("root: './.session-store'", `root: '${join(root, '.session-store').replaceAll('\\', '/')}'`)
      .replace("- name: '../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'\n", '')
      .replace("- name: '@deepseek-ai/dsh-bid'\n", '')
    const path = join(root, 'cordis.yml')
    await writeFile(path, config)
    const ctx = await boot('s4-structure-consumer', path, undefined, undefined,
      new URL('../../../../examples/headless-agent/', import.meta.url).href)
    try {
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(BidHostRuntime)
      if (scenario === 'accepted_stopped') ctx.effect(() => ctx.userQuestions.registerProvider({
        ask: ({ signal }) => new Promise<never>((_resolve, reject) => {
          if (signal === undefined) throw new Error('恢复问题缺少取消信号')
          signal.throwIfAborted()
          signal.addEventListener('abort', () => { reject(new Error('恢复问题已取消', { cause: signal.reason })) }, { once: true })
        }),
      }))
      if (scenario.startsWith('wrong_')) {
        const resume = ctx.bid.resumeCurrentRun.bind(ctx.bid)
        vi.spyOn(ctx.bid, 'resumeCurrentRun').mockImplementation((session, id, revision, onAccepted, recovery) =>
          resume(session, id, revision, (run) => {
            const operations = (ctx.bid as unknown as { inFlight: Map<string, { recovery?: ModelStageExecutionOptions['recovery'] }> }).inFlight
            const operation = [...operations.values()][0]!
            const accepted = operation.recovery!
            operation.recovery = { ...accepted,
              ...scenario === 'wrong_work' ? { authorizationWorkId: 'another-work' }
                : scenario === 'wrong_request' ? { requestSeq: accepted.requestSeq! + 1 }
                  : { instruction: '被篡改的指令' },
            }
            onAccepted?.(run)
          }, recovery))
        await expect(runEvidenceMappingRecoveryLoop(ctx, root)).rejects.toThrow('BID_RECOVERY_AUTHORIZATION_MISSING')
        return
      }
      const result = await runEvidenceMappingRecoveryLoop(ctx, root, 'structure',
        scenario === 'user_continue' || scenario === 'accepted_stopped' ? async (failed) => {
          const run = bidRecoverableRun(failed.agent.session, failed.outcome)!
          const instruction = '保留已研究资料，明确授权岗位核验与审计岗位追溯责任，只补修失败章节后重新复核。'
          if (scenario === 'user_continue') {
            failed.agent.session.append('bid.run.notice', { noticeId: `run:${run.runId}:failed`, supersedesTurn: null,
              runId: run.runId, stage: (run.work.kind === 'capability_task' ? null : run.work.stage), kind: 'interrupted', severity: 'error', message: run.error!.message })
          } else {
            const saved = (await readBidProjectState(failed.workspace))!
            let stopped: Promise<{ accepted: true }> | undefined
            const outcome = await ctx.bid.resumeCurrentRun(failed.agent.session, run.runId, saved.revision, () => {
              stopped = ctx.bid.stopRun(failed.agent.session)
            }, { instruction })
            await stopped
            expect(outcome).toMatchObject({ status: 'suspended', run: { cause: 'user_stop' } })
            expect(failed.agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(1)
          }
          return instruction
        } : scenario === 'long_history' ? (failed) => {
          const run = bidRecoverableRun(failed.agent.session, failed.outcome)!
          for (let index = 0; index < 6; index++) recordBidUserAnswer(failed.agent.session,
            [{ id: `old-${index}`, question: '前期研究资料？' }],
            { answers: [{ id: `old-${index}`, selected: [], custom: '旧的研究参考说明。'.repeat(400) }] },
            { questionKey: `old-${index}`, work: run.work })
          recordBidUserAnswer(failed.agent.session, [{ id: 'responsibility', question: '由谁负责核验及追溯？' }],
            { answers: [{ id: 'responsibility', selected: [], custom: '由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。' }] },
            { questionKey: 'current-responsibility', work: run.work })
          recordBidUserAnswer(failed.agent.session, [{ id: 'other-file', question: '独立文件要如何处理？' }],
            { answers: [{ id: 'other-file', selected: [], custom: '无关文件全部改成鲜红色。' }] },
            { questionKey: 'independent-question', work: null })
          const index = failed.childScript.findIndex(step => Array.isArray(step) && step.some(chunk => chunk.type === 'block-end'
        && chunk.block.type === 'tool-call' && chunk.block.id === 'repair-2-task'))
          const original = failed.childScript[index]!
          failed.childScript[index] = (request) => {
            const input = JSON.stringify(request.messages)
            expect(input).toContain('由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。')
            expect(input).not.toContain('无关文件全部改成鲜红色')
            return typeof original === 'function' ? original(request) : original
          }
          return '继续'
        } : undefined, scenario === 'user_continue' || scenario === 'accepted_stopped' ? 'resume' : 'repair')
      expect(result.outcome).toMatchObject({ workflow: { kind: 'full_bid' as const, stage: 'evidence_mapping' }, status: 'waiting_user' })
      const accepted = result.agent.session.events.findLast(event => event.type === 'bid.recovery.requested')
      expect(accepted?.data).toMatchObject({ instruction: result.instruction })
      expect(result.agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(1)
      const repairs = result.requests.filter(request => JSON.stringify(request.messages).includes('MAP-REPAIR-2-'))
      expect(repairs.length).toBeGreaterThan(0)
      expect(JSON.stringify(repairs)).toContain('本次继续要求')
      expect(JSON.stringify(repairs)).toContain(result.instruction)
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(result.workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      expect(JSON.stringify(outline)).toContain('由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。')
    } finally {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

it.each(['valid', 'output_limit', 'missing', 'fingerprint', 'input', 'checkpoint_missing', 'candidate_missing'] as const)(
  '旧预算 blocked 重启后从真实 Host 恢复原候选：%s', async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-s4-legacy-review-'))
    const base = fileURLToPath(new URL('../../../../examples/headless-agent/bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
    const config = (await readFile(base, 'utf8')).replace("root: './.session-store'", `root: '${join(root, '.session-store').replaceAll('\\', '/')}'`)
      .replace("- name: '../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'\n", '')
      .replace("- name: '@deepseek-ai/dsh-bid'\n", '')
    const path = join(root, 'cordis.yml')
    await writeFile(path, config)
    const configRoot = new URL('../../../../examples/headless-agent/', import.meta.url).href
    const first = await boot('s4-legacy-review', path, undefined, undefined, configRoot)
    await first.plugin(LocalFileSystem)
    const result = await runEvidenceMappingLoop(first, root, false, true, undefined, 'local', false, 'legacy')
    expect(result.outcome.status).toBe('failed')
    const run = bidRecoverableRun(result.agent.session, result.outcome)!
    expect(run.error).toMatchObject({ recovery: { kind: 'blocked' }, issues: [{ code: 'CONTEXT_WINDOW_EXCEEDED' }] })
    result.agent.session.append('bid.recovery.round', { ownerSessionId: String(result.agent.id),
      target: { kind: 'run', runId: run.runId, workId: run.work.workId }, fingerprint: 'legacy', round: 0, budget: 3,
      state: 'blocked', reason: run.error!.recovery!.reason })
    const saved = await checkpointBidProjectState(result.workspace, result.outcome)
    result.agent.session.append('bid.project.resumed', { state: result.outcome, revision: saved.revision })
    const checkpointPath = join(result.workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json')
    const checkpoint = await readFile(checkpointPath, 'utf8')
    if (fault === 'missing') await writeFile(checkpointPath, JSON.stringify({ tasks: [] }))
    if (fault === 'checkpoint_missing') await rm(checkpointPath)
    if (fault === 'candidate_missing') await rm(join(result.workspace.projectRoot, 'outline/refined-outline.candidate.json'))
    if (fault === 'fingerprint') {
      const candidatePath = join(result.workspace.projectRoot, 'outline/refined-outline.candidate.json')
      const candidate = parseOutlineArtifact(JSON.parse(await readFile(candidatePath, 'utf8')))
      candidate.sections[0]!.purpose = '与原研究不匹配的职责'
      await writeFile(candidatePath, JSON.stringify(candidate))
    }
    if (fault === 'input') {
      const projectPath = join(result.workspace.projectRoot, 'analysis/project.json')
      const project = JSON.parse(await readFile(projectPath, 'utf8')) as { project_name: string }
      project.project_name = '已变更的项目'
      await writeFile(projectPath, JSON.stringify(project))
    }
    await first.sessions.flush(result.agent.session)
    await first.fiber.dispose()

    let restored = await boot('s4-legacy-review-restored', path, undefined, undefined, configRoot)
    try {
      await restored.plugin(LocalFileSystem)
      registerIntegrationTools(restored, root, result.sourceUrl)
      restored.llm.registerAdapter(['mock'], result.adapter)
      let { agent } = await restored.agentLoop.resume(restored, { resumeSessionId: result.agent.id,
        agentOptions: { provider: 'mock', model: 'mock' } })
      await restored.plugin(BidHostRuntime)
      let operations = (restored.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
      await vi.waitFor(() => { expect(operations.size).toBe(0) })
      expect(bidRunRecoveryEligibility(agent.session)).toMatchObject({ eligible: true, attempts: 0 })
      if (fault === 'valid') {
        const outlinePath = join(result.workspace.projectRoot, 'outline/outline.json')
        const original = await readFile(join(result.workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8')
        const outline = parseOutlineArtifact(JSON.parse(original))
        outline.sections = Array.from({ length: 250 }, (_, index) => ({ ...outline.sections[0]!,
          id: `SEC-${index}`, order: index + 1, must_answer: ['详细任务。'.repeat(300)] }))
        await writeFile(outlinePath, JSON.stringify(outline))
        for (const view of ['summary', 'recovery']) {
          const inspected = await restored.tools.execute({ agent, name: 'bid_stage_inspect', arguments: { view },
            callId: CallId('large-' + view), signal: new AbortController().signal })
          expect(inspected, JSON.stringify(inspected)).toMatchObject({ isError: false })
          expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThan(50_000)
          expect(inspected.value).not.toHaveProperty('objects')
          expect(inspected.value).not.toHaveProperty('sections')
          expect(inspected.value).toMatchObject({ mapping_progress: { research_completed: 1, final_check_completed: 0 } })
        }
        for (const page of [0, 1]) {
          const inspected = await restored.tools.execute({ agent, name: 'bid_project_inspect', arguments: {
            query: { object: 'outline', page, page_size: 1 } }, callId: CallId('large-page-' + String(page)),
          signal: new AbortController().signal })
          expect(inspected, JSON.stringify(inspected)).toMatchObject({ isError: false,
            value: { total: 250, has_more: true, data: [{ id: `SEC-${page}` }] } })
        }
        await rm(outlinePath)
      }
      const before = result.requests.length
      if (fault === 'output_limit') result.adapter.reviewMaxTokens = true
      result.parentScript.push(call('bid_stage_inspect', { view: 'summary' }),
        call('bid_stage_inspect', { view: 'recovery' }), call('bid_recover_task', { target: 'run',
          instruction: '按当前模型实际预算重新组织目录审核，保留原研究和确认流程。' }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续原 S4，修复目录审查输入问题。' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await Promise.all([...operations.values()].map(operation => operation.done))
      const calls = result.requests.slice(before).filter(request => request.sessionId === agent.id)
      expect(calls[0]?.tools?.map(tool => tool.name)).toEqual([
        'bid_project_inspect', 'bid_recover_task', 'bid_stage_inspect', 'bid_start_workflow', 'grep', 'read', 'web_fetch', 'web_search', 'write',
      ])
      expect(JSON.stringify(calls[0]?.messages)).toContain('同一目标的继续或修复使用 bid_recover_task')
      expect(JSON.stringify(calls[0]?.messages)).not.toContain('已终止的能力任务不能沿用原授权重试')
      const inspections = agent.session.events.filter(event => event.type === 'tool/result'
      && event.data.message.source.callId === 'bid_stage_inspect')
      expect(inspections).toHaveLength(2)
      for (const inspection of inspections) {
        if (inspection.type !== 'tool/result') throw new Error('缺少状态工具结果')
        const text = inspection.data.message.content.flatMap(block => block.type === 'tool-result' ? block.content : [])
          .find(block => block.type === 'text')!
        if (text.type !== 'text') throw new Error('缺少状态 JSON')
        expect(Buffer.byteLength(text.text)).toBeLessThan(50_000)
        expect(JSON.parse(text.text)).not.toHaveProperty('objects')
      }
      let state = await readBidProjectState(new BidWorkspace(root))
      let previousRunId = run.runId
      if (fault === 'output_limit') {
        expect(state).toMatchObject({ status: 'failed', failure: { issues: [{ code: 'OUTLINE_REVIEW_OUTPUT_BUDGET_EXCEEDED' }] } })
        expect(bidRunRecoveryEligibility(agent.session)).toMatchObject({ eligible: true, attempts: 1 })
        expect(result.requests.slice(before).filter(request => request.system?.includes('技术标目录轻量复核'))).toHaveLength(1)
        previousRunId = agent.session.events.findLast(event => event.type === 'bid.run.started')!.data.run.runId
        await restored.sessions.flush(agent.session)
        await restored.fiber.dispose()
        restored = await boot('s4-output-limit-restored', path, undefined, undefined, configRoot)
        await restored.plugin(LocalFileSystem)
        registerIntegrationTools(restored, root, result.sourceUrl)
        restored.llm.registerAdapter(['mock'], result.adapter)
        agent = (await restored.agentLoop.resume(restored, { resumeSessionId: result.agent.id,
          agentOptions: { provider: 'mock', model: 'mock' } })).agent
        await restored.plugin(BidHostRuntime)
        operations = (restored.bid as unknown as { inFlight: Map<string, { done: Promise<void> }> }).inFlight
        await vi.waitFor(() => { expect(operations.size).toBe(0) })
        expect(bidRunRecoveryEligibility(agent.session)).toMatchObject({ eligible: true, attempts: 1 })
        result.adapter.outlineReview!.defaultMaxTokens = 8_192
        const retryBefore = result.requests.length
        result.parentScript.push(call('bid_stage_inspect', { view: 'recovery' }), call('bid_recover_task', {
          target: 'run', instruction: '使用所选模型的完整输出预算，保留已完成研究后重新复核。' }))
        agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续修复原 S4 的输出超限。' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        await Promise.all([...operations.values()].map(operation => operation.done))
        expect(result.requests[retryBefore]?.tools?.map(tool => tool.name))
          .toEqual(['bid_project_inspect', 'bid_recover_task', 'bid_resume_current_run', 'bid_run_task', 'bid_stage_inspect',
            'bid_start_workflow', 'grep', 'read', 'web_fetch', 'web_search', 'write'])
        const reviews = result.requests.slice(retryBefore).filter(request => request.system?.includes('技术标目录轻量复核'))
        expect(reviews.length).toBeGreaterThan(0)
        expect(reviews.every(request => request.maxTokens === 8_192)).toBe(true)
        expect(agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(2)
        state = await readBidProjectState(new BidWorkspace(root))
      }
      if (fault === 'valid' || fault === 'output_limit') {
        expect(state).toMatchObject({ workflow: { kind: 'full_bid' as const, stage: 'evidence_mapping' }, status: 'waiting_user' })
        const restarted = agent.session.events.findLast(event => event.type === 'bid.run.started')!
        expect(restarted.data.run).toMatchObject({ work: run.work, resumeOf: { runId: previousRunId } })
        const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(result.workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
        expect(map.section_mappings).toHaveLength(1)
        expect(result.requests.slice(before).some(request => JSON.stringify(request.messages).includes('Mapping Task：{\\"task_id\\":\\"MAP-INIT-'))).toBe(false)
        const final = JSON.parse(await readFile(join(result.workspace.projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
          tasks: Array<{ task_id: string; completed: boolean }>
        }
        expect(final.tasks.filter(task => task.task_id.startsWith('MAP-INIT-') && task.completed)).toHaveLength(1)
        expect(final.tasks.some(task => task.task_id.startsWith('MAP-FINAL-') && task.completed)).toBe(true)
        expect(agent.session.events.some(event => event.type === 'bid.user_confirmation.required')).toBe(true)
      } else {
        expect(state?.status).toBe('failed')
        expect(result.requests.slice(before).some(request => request.sessionId !== agent.id)).toBe(false)
        expect(JSON.stringify(agent.session.events.filter(event => event.type === 'tool/result' || event.type === 'bid.task.changed')))
          .toContain(fault === 'input' ? 'BID_WORK_INPUT_FINGERPRINT_MISMATCH'
            : fault.endsWith('_missing') ? 'FILE_MISSING' : 'FINGERPRINT_MISMATCH')
      }
      if (fault === 'valid' || fault === 'output_limit') expect(await readFile(checkpointPath, 'utf8')).toContain('MAP-INIT-SEC-SECURITY')
      else if (fault !== 'missing' && fault !== 'checkpoint_missing') expect(await readFile(checkpointPath, 'utf8')).toBe(checkpoint)
    } finally { await restored.fiber.dispose() }
  }, 60_000)
