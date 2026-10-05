/** 真实 S3 模型只选择业务位置，程序生成目录和响应点身份并保存完整复核。 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  BidWorkspace, buildBidStageTask, createTestBidRunContext, executeOutlineGeneration, executeTenderAnalysis,
  parseOutlineArtifact, parseOutlineQualityReport, parseScoringResponsePointCatalog,
  parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact,
  parseTenderScoringArtifact, validateOutlineGeneration, validateTenderAnalysis,
} from '@deepseek-ai/dsh-bid'
import { TECHNICAL_DEVIATION_SECTION_ID } from '../../../packages/bid/bid/src/outline-generation-artifacts.ts'
import { registerIntegrationTools } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const savedHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'
const model = process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash'
const requirementId = 'local-requirement-access'
const scoringId = 'local-score-access'
const complianceId = 'local-compliance-delivery'
const tender = [
  '# 访问控制建设技术要求',
  '建立角色权限、最小权限审批和操作审计机制，交付权限矩阵与审计记录。',
  '技术评分：访问控制实施方案完整、职责清晰、成果可核验，得 10 分。',
  '交付要求：提交可核验的权限矩阵与审计记录。',
].join('\n\n')

function canonicalFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(canonicalFields)
  if (value === null || typeof value !== 'object') return []
  const forbidden = new Set(['id', 'parent_id', 'section_id', 'section_ids', 'requirement_ids',
    'scoring_id', 'scoring_ids', 'compliance_ids', 'scoring_response_point_ids', 'response_point_id',
    'global_compliance_ids', 'file_id', 'schema_version', 'scope', 'code', 'order', 'level',
    'next_sequence', 'scoring_response_points', 'writable'])
  return Object.entries(value).flatMap(([field, child]) => [
    ...forbidden.has(field) ? [field] : [], ...canonicalFields(child),
  ])
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.DSH_BID_EVAL_PROVIDER)('真实程序身份绑定', () => {
  it('S2 只选择文件与分块位置，程序生成业务身份及正式来源引用', { timeout: 200_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-s2-positions-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const submissions: string[] = []
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettingsProvider, { dshHome: savedHome, watch: false })
      await ctx.plugin(LocalCredentialProvider, { dshHome: savedHome, watch: false })
      await ctx.plugin(LocalAttachmentStore, { dshHome: root })
      if (provider === 'deepseek-official') {
        await ctx.plugin(DeepSeek, { ...(process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL }) })
      } else await ctx.plugin(PiAi, {})
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: '仅提取当前招标文件的技术标事实与完整评分大项。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      registerIntegrationTools(ctx, root, [])
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call' && event.data.name === 'submit_tender_analysis') submissions.push(event.data.arguments)
      }, { global: true })
      const workspace = new BidWorkspace(root)
      const [file] = await workspace.import([{ name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tender) }])
      if (file?.parseStatus !== 'success') throw new Error('测试招标文件未生成真实语料')
      const agent = ctx.agentLoop.create(SessionId('host-position-s2'), { provider, model }, { cwd: root })
      const artifacts = await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'),
        { maxRepairAttempts: 1, run: createTestBidRunContext({ signal: AbortSignal.timeout(170_000) }) })
      await expect(validateTenderAnalysis(workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })
      const candidate = JSON.parse(submissions[0]!) as { scoring_items: Array<{ sources: unknown[] }> }
      expect(candidate.scoring_items.length).toBeGreaterThan(0)
      for (const source of candidate.scoring_items.flatMap(item => item.sources)) {
        expect(source).toMatchObject({ file_position: 0, chunk_position: 0 })
        expect(Object.keys(source as object).sort()).toEqual(['anchor_text', 'chunk_position', 'file_position'])
      }
      const scoring = parseTenderScoringArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8')))
      expect(scoring.scoring_items.every(item => item.source_refs.every(source => source.file_id === file.id))).toBe(true)
      expect(scoring.scoring_items.every(item => /^SC-\d{3}$/u.test(item.id))).toBe(true)
    } finally {
      await writeFile(join(root, 'model-submissions.json'), `${JSON.stringify(submissions.map(value => JSON.parse(value) as unknown), null, 2)}\n`)
      console.info(`S2 来源位置验收记录：${root}`)
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
    }
  })

  it('非格式评分 ID 经评分拆解、语义复核、目录生成及质量复核形成闭合身份', { timeout: 270_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-host-ids-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const signal = AbortSignal.timeout(230_000)
    const submissions: string[] = []
    const report: Record<string, unknown> = { provider, model, status: 'running' }
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettingsProvider, { dshHome: savedHome, watch: false })
      await ctx.plugin(LocalCredentialProvider, { dshHome: savedHome, watch: false })
      await ctx.plugin(LocalAttachmentStore, { dshHome: root })
      if (provider === 'deepseek-official') {
        await ctx.plugin(DeepSeek, { ...(process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL }) })
      } else await ctx.plugin(PiAi, {})
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: '仅根据当前招标事实设计技术方案目录，不虚构企业能力。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call' && event.data.name === 'structured_output') submissions.push(event.data.arguments)
      }, { global: true })

      const workspace = new BidWorkspace(root)
      const [file] = await workspace.import([{ name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tender) }])
      if (file?.parseStatus !== 'success' || file.absoluteChunksPath === null || file.chunksPath === null) throw new Error('测试招标文件未生成真实分块')
      const chunk = (await readdir(file.absoluteChunksPath)).find(name => name.endsWith('.md'))
      if (chunk === undefined) throw new Error('测试招标文件缺少正文分块')
      const text = await readFile(join(file.absoluteChunksPath, chunk), 'utf8')
      const source = { file_id: String(file.id), chunk: `${file.chunksPath}/${chunk}`, line_start: 1, line_end: text.trimEnd().split('\n').length }
      const project = parseTenderProjectArtifact({ schema_version: 1, project_name: '访问控制建设',
        tender_name: null, purchaser: null, owner: null, project_background: ['建立访问控制机制'],
        project_objectives: ['形成可核验访问控制方案'], project_scope: ['访问控制技术方案'],
        technical_scope: ['角色权限、最小权限审批与操作审计'], delivery_scope: ['权限矩阵与审计记录'],
        implementation_constraints: [], key_technical_points: ['权限边界与审计闭环'],
        source_refs: [source], analyzed_tender_files: [String(file.id)] })
      const requirements = parseTenderRequirementsArtifact({ schema_version: 1, requirements: [{
        id: requirementId, category: 'technical', raw_text: '建立角色权限、最小权限审批和操作审计机制，交付权限矩阵与审计记录。',
        normalized_requirement: '说明角色权限、最小权限审批与操作审计的实施机制及成果核验。', mandatory: true, source_refs: [source],
      }] })
      const scoring = parseTenderScoringArtifact({ schema_version: 1, scoring_items: [{ id: scoringId,
        parent: null, group: '技术', title: '访问控制实施方案', raw_text: '访问控制实施方案完整、职责清晰、成果可核验，得 10 分。',
        criterion: '访问控制实施方案完整、职责清晰、成果可核验。', score: 10, score_range: null,
        must_answer: true, source_refs: [source],
      }] })
      const compliance = parseTenderComplianceArtifact({ schema_version: 1, compliance_items: [{
        id: complianceId, type: 'mandatory_response', raw_text: '提交可核验的权限矩阵与审计记录。',
        normalized_rule: '交付权限矩阵与审计记录并说明核验方法。', severity: 'mandatory', source_refs: [source],
      }] })
      await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
      await Promise.all(Object.entries({ project, requirements, scoring, compliance }).map(([name, value]) =>
        writeFile(join(workspace.projectRoot, `analysis/${name}.json`), `${JSON.stringify(value)}\n`)))
      const agent = ctx.agentLoop.create(SessionId('host-id-s3'), { provider, model }, { cwd: root })
      const artifacts = await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'),
        { maxRepairAttempts: 1, run: createTestBidRunContext({ signal }) })
      await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
      const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8'))
      const outline = parseOutlineArtifact(await read('outline/outline.json'))
      const catalog = parseScoringResponsePointCatalog(await read('analysis/scoring-response-points.json'))
      const quality = parseOutlineQualityReport(await read('outline/quality-report.json'))
      expect(catalog.points.length).toBeGreaterThan(0)
      expect(catalog.points.every(point => point.scoring_id === scoringId && /^RP-\d{6}$/u.test(point.id))).toBe(true)
      expect(catalog.points.map(point => point.id)).toEqual(catalog.points.map((_, index) => `RP-${String(index + 1).padStart(6, '0')}`))
      expect(catalog.points.map(point => point.order)).toEqual(catalog.points.map((_, index) => index + 1))
      expect(catalog.next_sequence).toBe(catalog.points.length + 1)
      expect(await read('analysis/scoring.json')).toEqual(scoring)
      expect(outline.sections.every(section => section.id === TECHNICAL_DEVIATION_SECTION_ID || /^SEC-\d{3}$/u.test(section.id))).toBe(true)
      const sectionIds = new Set(outline.sections.map(section => section.id))
      expect(sectionIds.size).toBe(outline.sections.length)
      const points = new Map(catalog.points.map(point => [point.id, point]))
      for (const section of outline.sections) {
        expect(section.parent_id === null || sectionIds.has(section.parent_id)).toBe(true)
        expect(section.requirement_ids.every(id => id === requirementId)).toBe(true)
        expect(section.scoring_ids.every(id => id === scoringId)).toBe(true)
        expect(section.compliance_ids.every(id => id === complianceId)).toBe(true)
        for (const id of section.scoring_response_point_ids ?? []) {
          expect(points.has(id)).toBe(true)
          expect(section.scoring_ids).toContain(points.get(id)!.scoring_id)
        }
      }
      expect(quality.checked_requirement_ids).toEqual([requirementId])
      expect(quality.checked_scoring_ids).toEqual([scoringId])
      expect(quality.checked_scoring_response_point_ids).toEqual(catalog.points.map(point => point.id))
      expect(quality.reviewed_section_ids).toEqual(outline.sections.map(section => section.id))
      const modelValues = submissions.map(value => JSON.parse(value) as Record<string, unknown>)
      expect(modelValues.filter(value => Object.hasOwn(value, 'points'))).toHaveLength(2)
      expect(modelValues.some(value => Object.hasOwn(value, 'sections'))).toBe(true)
      expect(modelValues.some(value => Object.hasOwn(value, 'operations'))).toBe(true)
      expect(modelValues.flatMap(canonicalFields)).toEqual([])
      report.status = 'passed'
      report.catalog = catalog
      report.outline = outline
      report.quality = quality
    } catch (error) {
      report.status = 'failed'
      report.failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      report.model_submissions = submissions
      await writeFile(join(root, 'host-id-report.json'), `${JSON.stringify(report, null, 2)}\n`)
      console.info(`S3 身份绑定验收记录：${join(root, 'host-id-report.json')}`)
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
    }
  })
})
