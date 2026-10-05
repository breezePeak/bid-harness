/** 真实模型生成含纯资格事项的最小技术标，并核对客户可见正文边界。 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  BidWorkspace, buildBidStageTask,
  executeChapterWriting, executeOutlineGeneration, outlineArtifactSha256, parseChapterReviewArtifact,
  parseChapterWritingManifest, parseOutlineArtifact, validateChapterWriting, validateOutlineGeneration,
  createTestBidRunContext,
} from '@deepseek-ai/dsh-bid'
import { collectDocxMarkdown } from '../../../packages/bid/bid/src/docx-export.ts'
import { registerIntegrationTools } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { createScoringResponsePointCatalog } from '../../../packages/bid/bid/src/scoring-response-point-artifacts.ts'
import { TECHNICAL_DEVIATION_SECTION_ID } from '../../../packages/bid/bid/src/outline-generation-artifacts.ts'

const savedHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'

describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.DSH_BID_EVAL_PROVIDER)('真实模型客户可见标书边界', () => {
  async function runSynthetic(focused = false) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-customer-prose-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    const signal = AbortSignal.timeout(focused ? 350_000 : 1_140_000)
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
      await ctx.plugin(SystemPrompt, { persona: '按当前项目制品和工具契约编写可直接提交采购方的技术投标文件，不虚构企业事实。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      registerIntegrationTools(ctx, root, [])
      const observedS5Roles = new Set<string>()
      ctx.on('llm/stream', (options, next) => {
        const tools = options.tools ?? []
        const writer = tools.find(tool => tool.name === 'submit_chapter')
        const reviewer = tools.find(tool => tool.name === 'review_coverage_items')
        const globalReviewer = tools.find(tool => tool.name === 'review_global_compliance')
        const completionReviewer = tools.find(tool => tool.name === 'submit_chapter_writing_completion_review')
        if (writer !== undefined || reviewer !== undefined || globalReviewer !== undefined || completionReviewer !== undefined) {
          if (writer !== undefined) observedS5Roles.add('writer')
          if (reviewer !== undefined) observedS5Roles.add('reviewer')
          if (globalReviewer !== undefined) observedS5Roles.add('global')
          if (completionReviewer !== undefined) observedS5Roles.add('completion')
          const schema = JSON.stringify(tools)
          for (const field of ['material_ref', 'file_ref', 'chunk', 'web_ref', 'item_ref', 'evidence_quote_refs',
            'claim_quote_ref', 'source_reference', 'evidence_refs', 'section_id', 'criterion_id', 'compliance_id', 'key', 'direction']) {
            expect(schema).not.toContain('"' + field + '"')
          }
          for (const name of ['write', 'exec', 'terminal', 'run_code']) {
            expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([name]))
          }
        }
        return next()
      }, { global: true })

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

      let outline: ReturnType<typeof parseOutlineArtifact>
      if (focused) {
        const response = '说明访问控制的职责、审批、审计和交付成果。'
        const catalog = createScoringResponsePointCatalog(scoring, { schema_version: 1,
          points: [{ scoring_id: 'SC-001', order: 1, text: response }] })
        outline = parseOutlineArtifact({ schema_version: 3, scope: 'technical_bid', document_title: '技术标',
          global_compliance_ids: ['COM-001'], sections: [
            { id: TECHNICAL_DEVIATION_SECTION_ID, parent_id: null, order: 1, level: 1, title: '技术偏离表',
              purpose: '逐条形成技术响应索引及偏离声明。', writable: true, must_answer: ['逐条形成技术偏离表。'],
              requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated',
              scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
            { id: 'SEC-001', parent_id: null, order: 2, level: 1, title: '访问控制实施方案',
              purpose: '说明本方案访问控制措施及核验成果。', writable: true, must_answer: [response],
              requirement_ids: ['REQ-001'], scoring_ids: ['SC-001'], compliance_ids: [], origin: 'generated',
              scoring_response_point_ids: [catalog.points[0]!.id], scoring_response_points: [{ scoring_id: 'SC-001', response_point: response }],
              suggested_tables: [], suggested_figures: [], writing_notes: ['本合成样例只写正文，不新增任何流程图或图片。'] },
          ] })
        await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
        await writeFile(join(workspace.projectRoot, 'outline/outline.json'), `${JSON.stringify(outline)}\n`)
        await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), `${JSON.stringify({
          schema_version: 4, scope: 'technical_bid', checked_requirement_ids: ['REQ-001'], checked_scoring_ids: ['SC-001'],
          checked_scoring_response_point_ids: catalog.points.map(point => point.id),
          reviewed_section_ids: outline.sections.map(section => section.id),
          issues: [],
        })}\n`)
        await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), `${JSON.stringify(catalog)}\n`)
      } else {
        const s3Agent = ctx.agentLoop.create(SessionId('customer-prose-s3'), {
          provider, model: process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash',
        }, { cwd: root })
        const s3Artifacts = await executeOutlineGeneration(s3Agent, workspace, buildBidStageTask('outline_generation'), {
          maxRepairAttempts: 2, run: createTestBidRunContext({ signal }),
        })
        await expect(validateOutlineGeneration(workspace, 'outline_generation', s3Artifacts)).resolves.toEqual({ ok: true })
        outline = parseOutlineArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')))
      }
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
          section_mappings: outline.sections.filter(section => section.writable).map(section => ({
            section_id: section.id, local_materials: [], web_materials: [], missing_topics: [],
            writing_dimensions: ['实施方法', '职责分工', '质量控制', '交付成果'],
            ...(focused ? { answer_plan: [{
              targets: [
                ...section.must_answer.map((text, position) => ({ kind: 'must_answer', position, text })),
                ...(section.id === TECHNICAL_DEVIATION_SECTION_ID ? ['REQ-001'] : section.requirement_ids)
                  .map(id => ({ kind: 'requirement', id })),
                ...(section.scoring_response_point_ids ?? []).map(id => ({ kind: 'response_point', id })),
              ], mode: 'proposal', content: '我方拟按角色权限、最小权限审批、操作审计和交付核验组织本次方案。',
              basis: [{ kind: 'section_responsibility', section_id: section.id }],
              boundary: '本次拟采用的方案不证明企业已有资质、产品或既有能力。',
            }] } : {}),
          })),
        })}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({
          stage: 'evidence_mapping', sources: [],
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
        global_instructions: ['以我方方案、措施、责任和交付成果直接作答。',
          ...(focused ? ['本合成样例只写正文，不新增任何流程图或图片。'] : [])], document_acceptance: [],
        sections: outline.sections.filter(section => section.writable).map(section => ({
          section_id: section.id, task: `完成“${section.title}”技术响应。`, user_message_refs: [],
          user_requirements: [], writing_instructions: ['不复述采购要求，不显示系统内部编号。'], acceptance_criteria: [],
        })),
        revision: null,
      })}\n`)

      const s5Artifacts = await executeChapterWriting(s5Agent, workspace, buildBidStageTask('chapter_writing'), {
        maxRepairAttempts: 2, maxCompletionRepairRounds: 1, maxConcurrency: 1,
        run: createTestBidRunContext({ signal }),
      })
      expect([...observedS5Roles].sort()).toEqual(['completion', 'global', 'reviewer', 'writer'])
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
  }

  it('纯资格事项不生成正文页，技术章节以投标人立场作答且不显示内部编号', { timeout: 1_200_000, retry: 0 }, () => runSynthetic())
  it('S5 最小合成样例全程采用位置协议并由程序落盘', { timeout: 400_000, retry: 0 }, () => runSynthetic(true))
})
