import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { buildBidStageTask, parseWebEvidenceSourcesArtifact, parseEvidenceMapArtifact, webEvidenceContentSha256 } from '@deepseek-ai/dsh-bid'
import IntegrationFileSystem, { runEvidenceMappingLoop } from './fixtures/evidence-mapping-loop.ts'

describe('S4 Web evidence through a real Agent Tool loop', () => {
  it.each([false, true])('completes evidence mapping through one Child (repair: %s)', async (repair) => {
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
      const { agent, workspace, sourceUrl, outcome } = await runEvidenceMappingLoop(ctx, root, repair)
      expect(outcome).toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
      const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
      expect(ledger.sources).toHaveLength(1)
      expect(ledger.sources[0]?.requested_url).toBe(sourceUrl)
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
      expect(map.section_mappings[0]?.web_materials).toEqual([{
        source_id: ledger.sources[0]!.source_id,
        snapshot_path: ledger.sources[0]!.snapshot_path,
        usage: 'reference',
        summary: '要求访问控制与审计。',
        supports: '支持安全方案。',
      }])
      expect(map.section_mappings[0]?.local_materials).toEqual([])
      expect(await readFile(join(workspace.sessionRoot, ledger.sources[0]!.snapshot_path), 'utf8')).toContain('官方标准要求访问控制与安全审计')
      expect(agent.session.events.some(event => event.type === 'bid.user_confirmation.required' && event.data.stage === 'evidence_mapping')).toBe(true)
      expect(agent.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
        'read', 'read', 'write', 'read', 'read', 'write',
      ])
      expect(buildBidStageTask('evidence_mapping').requiredArtifacts).toEqual(['analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/outline.json', 'outline/quality-report.json'])
      const source = ledger.sources[0]!
      expect(source.search_result_seq).toBeLessThan(source.fetch_call_seq)
      expect(source.fetch_call_seq).toBeLessThan(source.fetch_result_seq)
      expect(source.content_sha256).toBe(webEvidenceContentSha256(await readFile(join(workspace.sessionRoot, source.snapshot_path), 'utf8')))
      const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; child_session_id: string; issues: Array<{ code: string }> }> }>
      }
      const attempts = log.tasks[0]!.attempts
      expect(attempts.map(attempt => attempt.accepted)).toEqual(repair ? [false, true] : [true])
      expect(new Set(attempts.map(attempt => attempt.child_session_id)).size).toBe(1)
      if (repair) expect(attempts[0]!.issues[0]!.code).toBe('EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)
})
