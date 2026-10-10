import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webTools from '@deepseek-ai/dsh-tool-web'
import { describe, expect, it, vi } from 'vitest'
import { buildBidStageTask, readEvidenceMappingProgress, parseOutlineArtifact, parseWebEvidenceSourcesArtifact, parseEvidenceMapArtifact, webEvidenceContentSha256 } from '@deepseek-ai/dsh-bid'
import IntegrationFileSystem, { runEvidenceMappingLoop } from './fixtures/evidence-mapping-loop.ts'
import { runFullOutlineRegenerationLoop, runStageInteractionLoop } from './fixtures/stage-interaction-loop.ts'

describe('S4 Web evidence through a real Agent Tool loop', () => {
  it.each(['zero', 'local', 'external_unbound'] as const)('真实章节研究按证据需求结算 %s 并发布诊断', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-research-demand-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(webTools)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    try {
      const { workspace, outcome } = await runEvidenceMappingLoop(ctx, root, false, false,
        { code: 'WEB_PROVIDER_RATE_LIMITED', failures: 0, production: true }, mode)
      if (mode === 'external_unbound') {
        expect(outcome).toMatchObject({ status: 'failed', failure: { issues: [expect.objectContaining({ code: 'EVIDENCE_MAPPING_REQUIRED_EVIDENCE_UNBOUND' })] } })
        const progress = await readEvidenceMappingProgress(workspace)
        expect(progress?.tasks[0]?.research_diagnostics).toMatchObject({ requirement: { kind: 'external_required' }, fetched: 2, read: 3 })
      } else {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'waiting_user' })
        const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
        expect(evidence.section_mappings[0]?.web_materials).toEqual([])
        expect(evidence.section_mappings[0]?.local_materials).toHaveLength(mode === 'zero' ? 0 : 1)
        const progress = await readEvidenceMappingProgress(workspace)
        expect(progress?.tasks[0]?.research_diagnostics).toMatchObject({
          status: mode === 'zero' ? 'read_excluded' : 'bound', requirement: { kind: mode === 'zero' ? 'not_required' : 'local_sufficient' },
          searches: 0, fetched: 0, bound: mode === 'zero' ? 0 : 1, displayed: mode === 'zero' ? 0 : 1,
        })
      }
    } finally { await ctx.fiber.dispose() }
  }, 20_000)
  it('生产 Web Tool 和 Pool 在真实会话重启后继承同 Work 抓取预算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-fetch-restart-'))
    const createContext = async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: 'test' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(WebRuntime)
      await ctx.plugin(webTools)
      await ctx.plugin(IntegrationFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      return ctx
    }
    const first = await createContext()
    const controller = new AbortController()
    const firstExecution = runEvidenceMappingLoop(first, root, false, false, { code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429,
      failures: 1, tool: 'web_fetch', maxRetries: 1, retryAfter: '60', signal: controller.signal, production: true })
    const path = join(root, '.bid-harness/analysis/evidence-mapping-log.json')
    await vi.waitFor(async () => {
      const log = JSON.parse(await readFile(path, 'utf8')) as { tasks: Array<{ status: string; attempts: unknown[] }> }
      expect(log.tasks[0]).toMatchObject({ status: 'pending', attempts: [expect.anything()] })
    }, { timeout: 10_000 })
    controller.abort(new Error('测试用户停止并重新挂载'))
    const initial = await firstExecution
    expect(initial.outcome.status).toBe('failed')
    await first.sessions.flush(initial.agent.session)
    await first.fiber.dispose()
    const restarted = await createContext()
    try {
      const resumed = await runEvidenceMappingLoop(restarted, root, false, false, { code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429,
        failures: 1, tool: 'web_fetch', maxRetries: 5, resume: true, production: true })
      expect(resumed.outcome).toMatchObject({ status: 'failed', failure: { cause: { code: 'WEB_PROVIDER_RATE_LIMITED', retryable: true } } })
      const log = JSON.parse(await readFile(path, 'utf8')) as { max_infrastructure_retry_attempts: number
        tasks: Array<{ attempts: Array<{ infrastructure_provider: string; issues: Array<{ code: string }> }> }> }
      expect(log.max_infrastructure_retry_attempts).toBe(1)
      expect(log.tasks[0]?.attempts).toHaveLength(2)
      expect(log.tasks[0]?.attempts.every(attempt => attempt.infrastructure_provider === 'web_fetch' && attempt.issues[0]?.code === 'WEB_PROVIDER_RATE_LIMITED')).toBe(true)
      expect(resumed.agent.session.events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
      const started = resumed.agent.session.events.filter(event => event.type === 'bid.run.started')
      expect(started[1]?.data.run.work.workId).toBe(started[0]?.data.run.work.workId)
      expect(resumed.requests.filter(request => request.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('Mapping Task：'))))).toHaveLength(1)
    } finally { await restarted.fiber.dispose() }
  }, 30_000)
  it.each(['exhausted', 'server_exhausted', 'user', 'race', 'overflow'] as const)('真实 Agent 取消与网络恢复边界：%s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s4-stop-loop-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    const controller = new AbortController()
    const endings: unknown[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') endings.push(event.data.reason)
    }, { global: true })
    if (scenario === 'user') ctx.on('tools/result', (exec) => {
      if (exec.name === 'web_search') {
        exec.agent?.cancel({ kind: 'user' })
        controller.abort(new Error('用户明确停止'))
      }
    }, { global: true })
    if (scenario === 'race') ctx.on('agent/cancel-requested', ({ agent: child, cause }) => {
      if (cause.kind === 'hook' && cause.reason === 'evidence-mapping-web-provider-backoff') {
        child.cancel({ kind: 'user' })
        controller.abort(new Error('退避同时用户明确停止'))
      }
    }, { global: true })
    try {
      const { workspace, outcome, requests } = await runEvidenceMappingLoop(ctx, root, false, false, {
        code: scenario === 'server_exhausted' ? 'WEB_PROVIDER_ERROR' : 'WEB_PROVIDER_RATE_LIMITED',
        statusCode: scenario === 'server_exhausted' ? 503 : 429, failures: scenario === 'overflow' ? 0 : 2,
        maxRetries: 1, signal: controller.signal, reviewOverflow: scenario === 'overflow',
      })
      expect(outcome.status).toBe('failed')
      const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; issues: Array<{ code: string }> }> }>
      }
      if (scenario === 'exhausted' || scenario === 'server_exhausted') {
        expect(log.tasks[0]?.attempts).toHaveLength(2)
        const code = scenario === 'server_exhausted' ? 'WEB_PROVIDER_ERROR' : 'WEB_PROVIDER_RATE_LIMITED'
        expect(log.tasks[0]?.attempts.every(attempt => attempt.issues[0]?.code === code)).toBe(true)
        expect(outcome).toMatchObject({ failure: { cause: { code, retryable: true,
          status: scenario === 'server_exhausted' ? 503 : 429 }, recovery: { kind: 'retry' } } })
      } else if (scenario === 'overflow') {
        expect(endings).toContainEqual({ kind: 'error', error: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: '注入的 provider context overflow' } })
        expect(JSON.stringify(outcome)).toContain(CONTEXT_WINDOW_EXCEEDED_CODE)
        expect(requests.filter(request => request.system?.includes('技术标目录轻量复核 Subagent'))).toHaveLength(1)
      } else {
        expect(controller.signal.aborted).toBe(true)
        expect(requests.filter(request => request.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('Mapping Task：'))))).toHaveLength(1)
        expect(log.tasks[0]?.attempts).toHaveLength(1)
      }
    } finally { await ctx.fiber.dispose() }
  }, 20_000)
  it.each([
    ['WEB_PROVIDER_RATE_LIMITED', 429], ['WEB_PROVIDER_ERROR', 503], ['WEB_SEARCH_TIMEOUT', undefined],
  ] as const)('真实 Child aborted 保留 %s 根因并有界恢复', async (code, statusCode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s4-backoff-loop-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    const endings: unknown[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') endings.push(event.data.reason)
    }, { global: true })
    try {
      const { workspace, outcome } = await runEvidenceMappingLoop(ctx, root, false, false, { code, statusCode, failures: 1 })
      expect(endings).toContainEqual({ kind: 'aborted', reason: { kind: 'hook', reason: 'evidence-mapping-web-provider-backoff' } })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'waiting_user' })
      const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; issues: Array<{ code: string; message: string }> }> }>
      }
      expect(log.tasks[0]?.attempts).toMatchObject([
        { accepted: false, issues: [{ code }] }, { accepted: true },
      ])
      expect(log.tasks[0]?.attempts[0]?.issues[0]?.message).toContain('注入的联网故障')
    } finally { await ctx.fiber.dispose() }
  }, 20_000)
  it.each([
    ['WEB_PROVIDER_RATE_LIMITED', 429, true], ['WEB_PROVIDER_ERROR', 503, true], ['WEB_FETCH_TIMEOUT', undefined, true],
    ['WEB_PROVIDER_AUTHENTICATION_FAILED', 401, false], ['WEB_PROVIDER_QUOTA_EXCEEDED', 429, false],
    ['WEB_FETCH_FAILED', undefined, null],
  ] as const)('父级 raw fetch 和 Child Pool 封装统一恢复 %s', async (code, statusCode, retryable) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s4-fetch-loop-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(webTools)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    const failures: Array<{ parent: boolean; info: unknown }> = []
    ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'web_fetch' && result.isError) failures.push({ parent: exec.agent?.session.header.origin !== 'subagent', info: result.error.info })
    }, { global: true })
    try {
      const { workspace, outcome } = await runEvidenceMappingLoop(ctx, root, false, false, { code, statusCode, failures: 1, tool: 'web_fetch', maxRetries: 1, production: true })
      expect(failures.filter(failure => (failure.info as { code?: string } | undefined)?.code === code)).toMatchObject([
        { parent: true, info: { code, retryAfter: '0' } }, { parent: false, info: { code, retryAfter: '0' } },
      ])
      const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; infrastructure_provider?: string; issues: Array<{ code: string }> }> }>
      }
      if (retryable === null) {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'waiting_user' })
        expect(log.tasks[0]?.attempts).toMatchObject([{ accepted: true }])
        expect(log.tasks[0]?.attempts).toHaveLength(1)
        const progress = await readEvidenceMappingProgress(workspace)
        expect(progress?.tasks[0]?.research_diagnostics?.failure_reasons).toContain('Web 获取失败：注入的联网故障')
      } else if (retryable) {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'waiting_user' })
        expect(log.tasks[0]?.attempts).toMatchObject([
          { accepted: false, infrastructure_provider: 'web_fetch', issues: [{ code }] }, { accepted: true },
        ])
      } else {
        expect(outcome).toMatchObject({ status: 'failed', failure: { cause: { code, retryable: false } } })
        expect(log.tasks[0]?.attempts).toHaveLength(1)
      }
    } finally { await ctx.fiber.dispose() }
  }, 20_000)
  it('整本重生成由无文件工具 Child 选择位置，Host 保留身份并保存 Draft 后等待确认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-full-regeneration-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    try {
      const outcome = await runFullOutlineRegenerationLoop(ctx, root)
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ result: { ok: true }, draft: { revision: 2 },
        canonicalPreserved: true, state: { stage: 'evidence_mapping', status: 'waiting_user' } })
      expect(outcome.draft.outline.sections.find(section => section.id === 'SEC-SECURITY')?.title)
        .toBe('访问控制与安全审计方案')
      expect(outcome.transitions).toContain('bid.run.started')
      expect(outcome.transitions).toContain('bid.run.completed')
    } finally { await ctx.fiber.dispose() }
  }, 30_000)
  it('Main Agent 在等待态创建独立文件、咨询、拆分和局部重生成，保持正式确认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-interaction-loop-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    try {
      expect(await runStageInteractionLoop(ctx, root, true)).toMatchObject({
        state: { stage: 'evidence_mapping', status: 'waiting_user' },
        confirmations: 0, generalFileCreated: true, canonicalPreserved: true, untouchedEvidencePreserved: true, revision: 3, disposed: true,
        titles: ['访问控制与安全审计', '实施准备与资源核查', '实施过程', '验收移交'],
        visibleTools: ['read', 'grep', 'write', 'web_search', 'web_fetch', 'bid_stage_inspect', 'bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap',
          'bid_project_inspect', 'bid_run_task', 'bid_plan_task', 'bid_confirm_writing_plan'],
        concurrent: Array(3).fill('BID_OPERATION_IN_PROGRESS'), failures: 1, incompletePlanRejected: true,
        readOnlyNoWork: true, planOnlyNoWork: true, capabilityUpdates: 1, updatedRequirement: '明确实施边界',
      })
    } finally { await ctx.fiber.dispose() }
  }, 30_000)
  it.each([false, true])('完成章节研究与复用候选资料的 Final Check（repair: %s）', async (repair) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s4-loop-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
    await ctx.plugin(SystemPrompt, { persona: 'test' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IntegrationFileSystem)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    try {
      const { agent, workspace, sourceUrl, outcome, requests } = await runEvidenceMappingLoop(ctx, root, repair)
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ stage: 'evidence_mapping', status: 'waiting_user' })
      const reviewTool = requests.flatMap(request => request.tools ?? []).find(tool => tool.name === 'review_items')
      expect(reviewTool?.parameters).toMatchObject({
        type: 'object',
        properties: { items: { type: 'array', items: { oneOf: [{
          type: 'object',
          properties: {
            review_position: { type: 'integer' }, decision: { type: 'string', enum: ['keep', 'remove', 'block'] }, reason: { type: 'string' },
          },
          required: ['review_position', 'decision', 'reason'], additionalProperties: false,
        }, {
          type: 'object',
          properties: {
            review_position: { type: 'integer' }, decision: { type: 'string', const: 'correct' }, reason: { type: 'string' },
            correction: { type: 'object' },
          },
          required: ['review_position', 'decision', 'reason', 'correction'], additionalProperties: false,
        }] } } },
        required: ['items'], additionalProperties: false,
      })
      const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
      expect(ledger.sources).toHaveLength(1)
      expect(ledger.sources[0]?.requested_url).toBe(sourceUrl)
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      expect(map.section_mappings[0]?.web_materials).toEqual([{
        source_id: ledger.sources[0]!.source_id,
        snapshot_path: ledger.sources[0]!.snapshot_path,
        chunk_refs: [`W:${ledger.sources[0]!.source_id}:C0001`],
        usage: 'reference',
        summary: '要求访问控制与审计。',
        supports: '支持安全方案。',
      }])
      expect(map.section_mappings[0]?.local_materials).toMatchObject([{ usage: 'reference', summary: '支持本章实施组织任务，仅参考流程组织思路，不据此新增具体技术步骤或项目承诺。' }])
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      expect(outline.sections[0]).toMatchObject({
        purpose: '为访问控制项目说明权限控制与安全审计措施，响应安全技术评分。',
        writing_notes: ['分别说明身份鉴别、权限授予和审计记录的执行方法。'],
        suggested_tables: ['角色权限与审计记录对照表'],
      })
      expect(await readFile(join(workspace.projectRoot, ledger.sources[0]!.snapshot_path), 'utf8')).toContain('官方标准要求访问控制与安全审计')
      expect(agent.session.events.some(event => event.type === 'bid.user_confirmation.required' && event.data.stage === 'evidence_mapping')).toBe(true)
      expect(agent.session.events.filter(event => event.type === 'tool/call')).toEqual([])
      expect(JSON.stringify(agent.session.events)).not.toContain('OUTLINE_REFINEMENT_SCHEMA_INVALID')
      expect(buildBidStageTask('evidence_mapping').requiredArtifacts).toEqual(['analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/outline.json', 'outline/quality-report.json'])
      const source = ledger.sources[0]!
      expect(source.content_sha256).toBe(webEvidenceContentSha256(await readFile(join(workspace.projectRoot, source.snapshot_path), 'utf8')))
      const log = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{
          task_id: string
          phase: string
          attempts: Array<{ accepted: boolean; child_session_id: string; issues: Array<{ code: string }> }>
        }>
      }
      const attempts = log.tasks[0]!.attempts
      expect(attempts.map(attempt => attempt.accepted)).toEqual([true])
      expect(new Set(attempts.map(attempt => attempt.child_session_id)).size).toBe(1)
      expect(log.tasks[1]).toMatchObject({ task_id: 'MAP-FINAL-CHECK', phase: 'final_check', attempts: [{ accepted: true }] })
      expect((await readEvidenceMappingProgress(workspace, { outline, evidence: map }))?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'bound', adopted: 2, bound: 2, displayed: 2 })
      const hidden = await readEvidenceMappingProgress(workspace, { outline: { ...outline, sections: [] }, evidence: map })
      expect(hidden?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'display_omitted', bound: 2, displayed: 0 })
      expect((await readEvidenceMappingProgress(workspace, { outline, evidence: null }))?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'display_omitted', bound: 2, displayed: 0 })
      await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), JSON.stringify({ ...map,
        section_mappings: map.section_mappings.map(mapping => ({ ...mapping, local_materials: [], web_materials: [] })),
      }), 'utf8')
      expect((await readEvidenceMappingProgress(workspace, { outline, evidence: map }))?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'saved_unbound', adopted: 2, bound: 0, displayed: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)
})
