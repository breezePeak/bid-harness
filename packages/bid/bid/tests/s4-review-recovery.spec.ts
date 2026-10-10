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
import { registerIntegrationTools, runEvidenceMappingLoop } from './fixtures/evidence-mapping-loop.ts'

const call = (name: string, args: object): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

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
      expect(calls[0]?.tools?.map(tool => tool.name)).toEqual(['bid_project_inspect', 'bid_recover_task', 'bid_stage_inspect'])
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
          .toEqual(['bid_project_inspect', 'bid_recover_task', 'bid_stage_inspect'])
        const reviews = result.requests.slice(retryBefore).filter(request => request.system?.includes('技术标目录轻量复核'))
        expect(reviews.length).toBeGreaterThan(0)
        expect(reviews.every(request => request.maxTokens === 8_192)).toBe(true)
        expect(agent.session.events.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(2)
        state = await readBidProjectState(new BidWorkspace(root))
      }
      if (fault === 'valid' || fault === 'output_limit') {
        expect(state).toMatchObject({ stage: 'evidence_mapping', status: 'waiting_user' })
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
