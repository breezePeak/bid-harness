import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  BidHostRuntime, BidOrchestrator, BidWorkspace, checkpointBidProjectState, createScoringResponsePointCatalog,
  EVIDENCE_MAPPING_SCHEMA_VERSION, WEB_EVIDENCE_SOURCES_SCHEMA_VERSION,
  getOrCreateOutlineDraft, parseEvidenceMapArtifact, parseOutlineArtifact, validateEvidenceMapping,
  type Config, type OutlineArtifact, type OutlineDraftView,
} from '@deepseek-ai/dsh-bid'
import { executeEvidenceMappingFinalCheck } from '../src/evidence-mapping-executor.ts'

vi.mock('../src/evidence-mapping-executor.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/evidence-mapping-executor.ts')>(),
  executeEvidenceMappingFinalCheck: vi.fn(),
}))

const identity = (draft: OutlineDraftView) => ({ expected_revision: draft.revision, expected_draft_sha256: draft.draft_outline_sha256 })

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const root = await mkdtemp(join(tmpdir(), 'dsh-outline-confirm-'))
  const session = ctx.sessions.create(SessionId('confirmation'), { meta: { cwd: root, agentPreset: 'bid' } })
  const workspace = new BidWorkspace(root)
  const outline: OutlineArtifact = {
    schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [],
    sections: [1, 2].map(index => ({
      id: `SEC-${index}`, parent_id: null, order: index, level: 1, title: `方案${index}`,
      purpose: `说明项目阶段${index}的交付安排`, must_answer: [`阶段${index}如何交付`], writable: true,
      requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [],
      compliance_ids: [], origin: 'generated', suggested_tables: [], suggested_figures: [], writing_notes: ['明确责任人及完成标准'],
    })),
  }
  const scoring = { schema_version: 1 as const, scoring_items: [] }
  const artifacts: Record<string, unknown> = {
    'analysis/requirements.json': { schema_version: 1, requirements: [] },
    'analysis/scoring.json': scoring,
    'analysis/scoring-response-points.json': createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [] }),
    'analysis/compliance.json': { schema_version: 1, compliance_items: [] },
    'analysis/evidence-map.json': { schema_version: EVIDENCE_MAPPING_SCHEMA_VERSION, section_mappings: outline.sections.map(section => ({
      section_id: section.id, local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['交付安排'],
    })) },
    'analysis/web-evidence-sources.json': { schema_version: WEB_EVIDENCE_SOURCES_SCHEMA_VERSION, stage: 'evidence_mapping', sources: [] },
    'outline/outline.json': outline,
    'outline/quality-report.json': { schema_version: 3, scope: 'technical_bid', checked_requirement_ids: [], checked_scoring_ids: [],
      checked_scoring_response_point_ids: [], reviewed_section_ids: outline.sections.map(section => section.id), issues: [] },
  }
  await Promise.all(['analysis', 'outline'].map(path => mkdir(join(workspace.projectRoot, path), { recursive: true })))
  await Promise.all(Object.entries(artifacts).map(([path, value]) => writeFile(join(workspace.projectRoot, path), `${JSON.stringify(value, null, 2)}\n`)))
  for (const stage of ['file_intake', 'tender_analysis', 'outline_generation'] as const) {
    session.append('bid.stage.started', { stage, status: 'running' })
    session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
  }
  session.append('bid.stage.started', { stage: 'evidence_mapping', status: 'running' })
  session.append('bid.user_confirmation.required', { stage: 'evidence_mapping', status: 'waiting_user' })
  await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
  const agent = { id: session.id, session } as Agent
  const host = Object.assign(Object.create(BidHostRuntime.prototype) as object, {
    ctx: { agents: { get: () => agent, list: () => [agent] }, sessions: { flush: async () => {}, list: () => [session] } },
    config: { allowedExtensions: ['.md'], maxFiles: 20, maxFileBytes: 1024, maxTotalBytes: 4096,
      modelStageRepairAttempts: 0, evidenceMappingMaxConcurrency: 2, chapterWritingMaxConcurrency: 1, trustedHosts: [] } satisfies Config,
    inFlight: new Map(),
    automaticOrchestrator: () => new BidOrchestrator(session, { canExecute: () => false, execute: async () => [] },
      { validate: (stage, refs) => validateEvidenceMapping(workspace, stage, refs) }),
  }) as unknown as BidHostRuntime
  return { ctx, host, session, workspace, outline, read: (path: string) => readFile(join(workspace.projectRoot, path), 'utf8') }
}

afterEach(() => { vi.clearAllMocks() })

describe('S4 Draft 最终确认', () => {
  it('连续编辑保留研究基线与 CAS，确认时只复核语义变化的叶子并发布更新后的 Brief', async () => {
    const f = await fixture()
    try {
      const original = await f.read('outline/outline.json')
      const initial = await getOrCreateOutlineDraft(f.workspace)
      const first = await f.host.applyOutlineDraftOperations(f.session, { ...identity(initial),
        operations: [{ type: 'update_section', section_id: 'SEC-1', purpose: '明确验收前的交付核查安排' }] })
      if (!first.ok) throw new Error(first.error.message)
      const second = await f.host.applyOutlineDraftOperations(f.session, { ...identity(first.value), operations: [
        { type: 'update_section', section_id: 'SEC-1', must_answer: ['验收前由谁核对交付清单'] },
        { type: 'move_section', section_id: 'SEC-2', parent_id: null, order: 1 },
      ] })
      if (!second.ok) throw new Error(second.error.message)
      expect(executeEvidenceMappingFinalCheck).not.toHaveBeenCalled()
      expect(await f.read('outline/outline.json')).toBe(original)
      await expect(f.host.confirmOutline(f.session, identity(initial))).resolves.toMatchObject({ ok: false, error: { code: 'BID_OUTLINE_DRAFT_CONFLICT' } })
      vi.mocked(executeEvidenceMappingFinalCheck).mockImplementation(async (_agent, _workspace, candidate) => ({
        outline: { ...candidate, sections: candidate.sections.map(section => section.id === 'SEC-1'
          ? { ...section, writing_notes: ['由验收负责人逐项核对并记录差异'] } : section) },
        evidence: parseEvidenceMapArtifact(JSON.parse(await f.read('analysis/evidence-map.json'))),
      }))
      await expect(f.host.confirmOutline(f.session, identity(second.value))).resolves.toMatchObject({ ok: true })
      expect(executeEvidenceMappingFinalCheck).toHaveBeenCalledOnce()
      expect(vi.mocked(executeEvidenceMappingFinalCheck).mock.calls[0]?.[3]).toEqual(['SEC-1'])
      const confirmed = parseOutlineArtifact(JSON.parse(await f.read('outline/confirmed-outline.json')))
      expect(confirmed.sections.find(section => section.id === 'SEC-1')).toMatchObject({ writing_notes: ['由验收负责人逐项核对并记录差异'] })
      expect(confirmed.sections.find(section => section.id === 'SEC-2')?.writing_notes).toEqual(f.outline.sections[1]?.writing_notes)
      expect(JSON.parse(await f.read('outline/confirmation.json'))).toMatchObject({ confirmed_draft_revision: second.value.revision,
        confirmed_draft_sha256: second.value.draft_outline_sha256 })
    } finally { await f.ctx.fiber.dispose() }
  })

  it('仅调整排序时直接确认，不启动模型复核', async () => {
    const f = await fixture()
    try {
      const draft = await getOrCreateOutlineDraft(f.workspace)
      const edited = await f.host.applyOutlineDraftOperations(f.session, { ...identity(draft), operations: [
        { type: 'move_section', section_id: 'SEC-2', parent_id: null, order: 1 },
      ] })
      if (!edited.ok) throw new Error(edited.error.message)
      await expect(f.host.confirmOutline(f.session, identity(edited.value))).resolves.toMatchObject({ ok: true })
      expect(executeEvidenceMappingFinalCheck).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('复核结果校验失败恢复正式产物，保留 Draft 供相同 CAS 重试', async () => {
    const f = await fixture()
    try {
      const draft = await getOrCreateOutlineDraft(f.workspace)
      const edited = await f.host.applyOutlineDraftOperations(f.session, { ...identity(draft), operations: [
        { type: 'update_section', section_id: 'SEC-1', purpose: '明确交付清单的核查过程' },
      ] })
      if (!edited.ok) throw new Error(edited.error.message)
      const paths = ['outline/outline.json', 'outline/quality-report.json', 'analysis/evidence-map.json', 'analysis/web-evidence-sources.json']
      const original = await Promise.all(paths.map(f.read))
      vi.mocked(executeEvidenceMappingFinalCheck).mockImplementation(async (_agent, _workspace, candidate) => ({
        outline: { ...candidate, sections: candidate.sections.map(section => ({ ...section, must_answer: [] })) },
        evidence: parseEvidenceMapArtifact(JSON.parse(await f.read('analysis/evidence-map.json'))),
      }))
      await expect(f.host.confirmOutline(f.session, identity(edited.value))).resolves.toMatchObject({ ok: false, error: { code: 'BID_CONFIRM_FAILED' } })
      expect(await Promise.all(paths.map(f.read))).toEqual(original)
      expect(await getOrCreateOutlineDraft(f.workspace)).toEqual(edited.value)
      expect(f.session.events.some(event => event.type === 'bid.user_confirmation.received')).toBe(false)
      await expect(f.read('outline/confirmed-outline.json')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.ctx.fiber.dispose() }
  })
})
