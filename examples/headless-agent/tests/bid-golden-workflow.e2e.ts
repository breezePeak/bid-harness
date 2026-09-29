/** 真实模型从原始招标文件生成技术标并请求 Word 导出，保留阶段产物供验收。 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  BidWorkspace, buildBidStageTask, createTestBidRunContext,
  executeChapterWriting, executeDocxExport, executeEvidenceMapping, executeOutlineGeneration, executeTenderAnalysis,
  outlineArtifactSha256, parseChapterWritingManifest, parseOutlineArtifact,
  parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact,
  validateChapterWriting, validateDocxExport, validateEvidenceMapping, validateOutlineGeneration, validateTenderAnalysis,
} from '@deepseek-ai/dsh-bid'
import { registerIntegrationTools } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { createConfirmedTenderScoring, parseTenderScoringSelection } from '../../../packages/bid/bid/src/tender-analysis-confirmation.ts'

const savedHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'
const model = process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash'
const tenderText = [
  '# 访问控制系统建设项目',
  '本项目采购访问控制技术方案，工作范围为角色权限、最小权限审批和操作审计。技术要求：建立角色权限、最小权限审批和操作审计机制，并提交权限矩阵与审计记录；技术标说明实施方法、职责分工和成果核验。',
  '技术评分：访问控制实施方案完整、职责清晰、成果可核验，得 10 分。',
  '投标资格材料：投标人须另行提供信息安全管理体系认证证书复印件；该材料只用于资格核验。',
].join('\n\n')
const referenceText = [
  '# 访问控制实施参考',
  '权限管理员依据岗位职责形成角色和权限矩阵。申请人提交权限用途与期限，审批人核对最小权限，管理员据批准结果配置、变更或撤销权限。审计人员定期核对操作记录与异常事件，并将权限矩阵和审计记录作为交付成果。',
].join('\n\n')

describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.DSH_BID_EVAL_PROVIDER)('真实模型技术标黄金链路', () => {
  it('从文件导入经 S2–S5 生成正文并按请求导出 DOCX', { timeout: 1_800_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-golden-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const signal = AbortSignal.timeout(1_740_000)
    const report: Record<string, unknown> = { provider, model, input: { tender: tenderText, reference: referenceText },
      status: 'running', phase: 'setup', confirmation: '测试代行 S2 评分选择、S3/S4 目录确认及 S5 写作计划确认' }
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
      await ctx.plugin(SystemPrompt, { persona: '根据当前招标文件和本地资料编写可提交的技术标；不虚构企业资质和项目事实。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      registerIntegrationTools(ctx, root, [])

      const workspace = new BidWorkspace(root)
      report.phase = 'file_intake'
      const imported = await workspace.import([
        { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode(tenderText) },
        { name: 'reference.md', role: 'reference_bid', bytes: new TextEncoder().encode(referenceText) },
      ])
      expect(imported).toHaveLength(2)
      report.imported = imported.map(file => ({ id: file.id, role: file.role, parseStatus: file.parseStatus }))
      const agent = (id: string) => ctx.agentLoop.create(SessionId(id), { provider, model }, { cwd: root })
      const run = () => createTestBidRunContext({ signal })

      report.phase = 'tender_analysis'
      const s2 = await executeTenderAnalysis(agent('golden-s2'), workspace, buildBidStageTask('tender_analysis'),
        { maxRepairAttempts: 2, run: run() })
      await expect(validateTenderAnalysis(workspace, 'tender_analysis', s2)).resolves.toEqual({ ok: true })
      const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as { requirements: unknown[] }
      const readAnalysis = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(workspace.projectRoot, `analysis/${name}.json`), 'utf8'))
      const scoring = parseTenderScoringArtifact(await readAnalysis('scoring-origin'))
      const selected = parseTenderScoringSelection(await readAnalysis('tender-analysis-selection'), scoring)
      const confirmedScoring = createConfirmedTenderScoring({
        project: parseTenderProjectArtifact(await readAnalysis('project')),
        requirements: parseTenderRequirementsArtifact(await readAnalysis('requirements')),
        scoring, compliance: parseTenderComplianceArtifact(await readAnalysis('compliance')),
        selected_scoring_ids: selected.selected_scoring_ids,
      })
      await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), `${JSON.stringify(confirmedScoring)}\n`)
      report.s2 = { artifacts: s2.map(item => item.path), requirements: requirements.requirements.length,
        selected_scoring_ids: selected.selected_scoring_ids }

      report.phase = 'outline_generation'
      const s3 = await executeOutlineGeneration(agent('golden-s3'), workspace, buildBidStageTask('outline_generation'),
        { maxRepairAttempts: 2, run: run() })
      await expect(validateOutlineGeneration(workspace, 'outline_generation', s3)).resolves.toEqual({ ok: true })
      const initial = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      expect(initial.sections.some(section => /资格证明|证书复印件/u.test(section.title))).toBe(false)
      await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), `${JSON.stringify(initial)}\n`)
      report.s3 = { artifacts: s3.map(item => item.path), sections: initial.sections.map(section => section.title) }

      report.phase = 'evidence_mapping'
      const s4 = await executeEvidenceMapping(agent('golden-s4'), workspace, buildBidStageTask('evidence_mapping'),
        { maxRepairAttempts: 2, maxConcurrency: 2, run: run() })
      await expect(validateEvidenceMapping(workspace, 'evidence_mapping', s4)).resolves.toEqual({ ok: true })
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      for (const section of outline.sections) {
        if (!section.writable && section.summary === undefined) section.summary = '本章概述我方访问控制实施思路和交付安排。'
      }
      const outlineHash = outlineArtifactSha256(outline)
      await Promise.all([
        writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`),
        writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), `${JSON.stringify({
          schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
          confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
        })}\n`),
      ])
      report.s4 = { artifacts: s4.map(item => item.path), sections: outline.sections.map(section => section.title) }

      report.phase = 'chapter_writing'
      const s5Agent = agent('golden-s5')
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
        text: '请直接编写可交付采购方的技术标正文，资格证明材料不写成技术方案章节。' }] })
      const event = s5Agent.session.append('user/message', message, { surfaceOp: 'append' })
      await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), `${JSON.stringify({
        schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
        confirmed_outline_sha256: outlineHash,
        user_message_refs: [{ session_id: String(s5Agent.id), message_id: String(message.id), seq: event.seq }],
        user_requirements: ['请直接编写可交付采购方的技术标正文，资格证明材料不写成技术方案章节。'],
        global_instructions: ['按我方方案、措施、责任和交付成果直接作答，不虚构已具备的资质。'],
        document_acceptance: [],
        sections: outline.sections.filter(section => section.writable).map(section => ({
          section_id: section.id, task: `完成“${section.title}”技术响应。`, user_message_refs: [],
          user_requirements: [], writing_instructions: ['不复述采购要求，不显示系统内部编号。'], acceptance_criteria: [],
        })), revision: null,
      })}\n`)
      const s5 = await executeChapterWriting(s5Agent, workspace, buildBidStageTask('chapter_writing'),
        { maxRepairAttempts: 2, maxCompletionRepairRounds: 1, maxConcurrency: 1, run: run() })
      await expect(validateChapterWriting(workspace, 'chapter_writing', s5)).resolves.toEqual({ ok: true })
      const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8')))
      report.s5 = { artifacts: s5.map(item => item.path), chapters: manifest.chapters.map(item => ({
        section_id: item.section_id, content_path: item.content_path,
      })) }

      report.phase = 'docx_export'
      const exportArtifacts = await executeDocxExport(workspace, run())
      await expect(validateDocxExport(workspace, 'docx_export', exportArtifacts)).resolves.toEqual({ ok: true })
      const docx = join(workspace.projectRoot, exportArtifacts[0]!.path)
      report.export = { path: exportArtifacts[0]!.path, bytes: (await stat(docx)).size }
      expect((report.export as { bytes: number }).bytes).toBeGreaterThan(0)
      report.status = 'passed'
    } catch (error) {
      report.status = 'failed'
      report.failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      await writeFile(join(root, 'golden-report.json'), `${JSON.stringify(report, null, 2)}\n`)
      console.info(`技术标黄金链路验收记录：${join(root, 'golden-report.json')}`)
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
    }
  })
})
