/** 真实模型生成含纯资格事项的最小技术标，并核对客户可见正文边界。 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
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
  BidWorkspace, EVIDENCE_MAPPING_SCHEMA_VERSION, buildBidStageTask,
  executeChapterWriting, executeOutlineGeneration, outlineArtifactSha256, parseChapterReviewArtifact,
  parseChapterWritingManifest, parseOutlineArtifact, validateChapterWriting, validateOutlineGeneration,
} from '@deepseek-ai/dsh-bid'
import { collectDocxMarkdown } from '../../../packages/bid/bid/src/docx-export.ts'
import { registerIntegrationTools } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const savedHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'

describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.DSH_BID_EVAL_PROVIDER)('真实模型客户可见标书边界', () => {
  it('纯资格事项不生成正文页，技术章节以投标人立场作答且不显示内部编号', { timeout: 1_200_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-customer-prose-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const signal = AbortSignal.timeout(1_140_000)
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettingsProvider, { dshHome: savedHome, watch: false })
      await ctx.plugin(LocalCredentialProvider, { dshHome: savedHome, watch: false })
      if (provider === 'deepseek-official') {
        await ctx.plugin(DeepSeek, { ...(process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL }) })
      } else await ctx.plugin(PiAi, {})
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: '按当前项目制品和工具契约编写可直接提交采购方的技术投标文件，不虚构企业事实。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      registerIntegrationTools(ctx, root, [])

      const workspace = new BidWorkspace(root)
      const [tender] = await workspace.import([{
        name: 'minimal-tender.md', role: 'tender', bytes: new TextEncoder().encode([
          '# 访问控制系统建设项目',
          '资格要求：投标人须提供信息安全管理体系认证证书复印件。',
          '技术要求：建立角色权限、最小权限审批和操作审计机制，并提交权限矩阵与审计记录。',
          '技术评分：访问控制实施方案完整、职责清晰、成果可核验，得 10 分。',
        ].join('\n\n')),
      }])
      if (tender?.chunkIndexPath == null) throw new Error('最小招标样例缺少分块索引')
      const index = JSON.parse(await readFile(join(workspace.projectRoot, tender.chunkIndexPath), 'utf8')) as {
        chunks: Array<{ id: string; source_line_start: number; source_line_end: number }>
      }
      const chunk = index.chunks[0]!
      const source_refs = [{
        file_id: tender.id, chunk: chunk.id,
        line_start: chunk.source_line_start, line_end: chunk.source_line_end,
      }]
      const scoring = {
        schema_version: 1 as const,
        scoring_items: [{
          id: 'SC-001', parent: null, group: '技术', title: '访问控制实施方案',
          raw_text: '访问控制实施方案完整、职责清晰、成果可核验，得 10 分。',
          criterion: '说明角色权限、审批、审计和交付成果。', score: 10, score_range: null,
          must_answer: true, source_refs,
        }],
      }
      const artifacts: Record<string, unknown> = {
        'analysis/project.json': {
          schema_version: 1, project_name: '访问控制系统建设项目', tender_name: null, purchaser: null, owner: null,
          project_background: [], project_objectives: ['建立可核验的访问控制机制'], project_scope: ['访问控制实施方案'],
          technical_scope: ['角色权限、最小权限审批和操作审计'], delivery_scope: ['权限矩阵与审计记录'],
          implementation_constraints: [], key_technical_points: ['最小权限与操作审计'], source_refs,
          analyzed_tender_files: [tender.id],
        },
        'analysis/requirements.json': {
          schema_version: 1,
          requirements: [{
            id: 'REQ-001', category: '技术',
            raw_text: '建立角色权限、最小权限审批和操作审计机制，并提交权限矩阵与审计记录。',
            normalized_requirement: '建立访问控制并交付权限矩阵与审计记录。', mandatory: true, source_refs,
          }],
        },
        'analysis/scoring-origin.json': scoring,
        'analysis/scoring.json': scoring,
        'analysis/compliance.json': {
          schema_version: 1,
          compliance_items: [{
            id: 'COM-001', type: '投标资格', raw_text: '投标人须提供信息安全管理体系认证证书复印件。',
            normalized_rule: '提交信息安全管理体系认证证书复印件。', severity: 'fatal', source_refs,
          }],
        },
      }
      for (const [path, value] of Object.entries(artifacts)) {
        await mkdir(join(workspace.projectRoot, path, '..'), { recursive: true })
        await writeFile(join(workspace.projectRoot, path), `${JSON.stringify(value)}\n`)
      }

      const s3Agent = ctx.agentLoop.create(SessionId('customer-prose-s3'), {
        provider, model: process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash',
      }, { cwd: root })
      const s3Artifacts = await executeOutlineGeneration(s3Agent, workspace, buildBidStageTask('outline_generation'), {
        maxRepairAttempts: 2, signal,
      })
      await expect(validateOutlineGeneration(workspace, 'outline_generation', s3Artifacts)).resolves.toEqual({ ok: true })
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      expect(outline.global_compliance_ids).toContain('COM-001')
      expect(outline.sections.some(section => /资格|资质|证书|行政递交/u.test(section.title))).toBe(false)
      for (const section of outline.sections) {
        if (!section.writable && section.summary === undefined) section.summary = '本章说明我方访问控制实施思路、责任安排和交付成果。'
      }

      const outlineHash = outlineArtifactSha256(outline)
      await Promise.all([
        writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`),
        writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), `${JSON.stringify({
          schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineHash,
          confirmed_outline_sha256: outlineHash, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineHash,
        })}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), `${JSON.stringify({
          schema_version: EVIDENCE_MAPPING_SCHEMA_VERSION,
          section_mappings: outline.sections.filter(section => section.writable).map(section => ({
            section_id: section.id, local_materials: [], web_materials: [], missing_topics: [],
            writing_dimensions: ['实施方法', '职责分工', '质量控制', '交付成果'],
          })),
        })}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
          schema_version: 2, stage: 'evidence_mapping', sources: [],
        })}\n`),
      ])

      const s5Agent = ctx.agentLoop.create(SessionId('customer-prose-s5'), {
        provider, model: process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash',
      }, { cwd: root })
      const message = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请直接编写可交付采购方的技术标正文，不写资质要求解读。' }],
      })
      const event = s5Agent.session.append('user/message', message, { surfaceOp: 'append' })
      await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), `${JSON.stringify({
        schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
        confirmed_outline_sha256: outlineHash,
        user_message_refs: [{ session_id: String(s5Agent.id), message_id: String(message.id), seq: event.seq }],
        user_requirements: ['直接编写可交付采购方的技术标正文，不写资质要求解读。'],
        global_instructions: ['以我方方案、措施、责任和交付成果直接作答。'], document_acceptance: [],
        sections: outline.sections.filter(section => section.writable).map(section => ({
          section_id: section.id, task: `完成“${section.title}”技术响应。`, user_message_refs: [],
          user_requirements: [], writing_instructions: ['不复述采购要求，不显示系统内部编号。'], acceptance_criteria: [],
        })),
        revision: null,
      })}\n`)

      const s5Artifacts = await executeChapterWriting(s5Agent, workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: 2, maxCompletionRepairRounds: 1, maxConcurrency: 1, signal,
      })
      await expect(validateChapterWriting(workspace, 'chapter_writing', s5Artifacts)).resolves.toEqual({ ok: true })
      const manifest = parseChapterWritingManifest(JSON.parse(
        await readFile(join(workspace.projectRoot, 'chapters/manifest.json'), 'utf8'),
      ))
      const reviews = await Promise.all(manifest.chapters.map(async chapter => parseChapterReviewArtifact(JSON.parse(
        await readFile(join(workspace.projectRoot, chapter.review_path), 'utf8'),
      ))))
      expect(reviews.every(review => review.quality_checks.bidder_response_voice)).toBe(true)
      const markdown = await collectDocxMarkdown(workspace, signal)
      expect(markdown).toMatch(/我方|本方案|拟采用/u)
      expect(markdown).not.toMatch(/(?:REQ|SC|COM|RP|SEC|AC)-[A-Za-z0-9_-]+/u)
      expect(markdown).not.toContain('信息安全管理体系认证证书复印件')
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
    }
  })
})
