import { mkdtemp, readFile } from 'node:fs/promises'
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
import { describe, expect, it } from 'vitest'
import { buildBidStageTask, parseOutlineArtifact, parseWebEvidenceSourcesArtifact, parseEvidenceMapArtifact, webEvidenceContentSha256 } from '@deepseek-ai/dsh-bid'
import IntegrationFileSystem, { runEvidenceMappingLoop } from './fixtures/evidence-mapping-loop.ts'
import { runFullOutlineRegenerationLoop, runStageInteractionLoop } from './fixtures/stage-interaction-loop.ts'

describe('S4 Web evidence through a real Agent Tool loop', () => {
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
  it('Main Agent 在等待态咨询、拆分和局部重生成，且不能裸写或隐式确认', async () => {
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
        confirmations: 0, rawWriteBlocked: true, untouchedEvidencePreserved: true, revision: 3, disposed: true,
        titles: ['访问控制与安全审计', '实施准备与资源核查', '实施过程', '验收移交'],
        visibleTools: ['bid_stage_inspect', 'bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap',
          'bid_project_inspect', 'bid_run_task', 'bid_confirm_writing_plan'],
        concurrent: Array(3).fill('BID_OPERATION_IN_PROGRESS'), failures: 2, incompletePlanRejected: true,
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
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)
})
