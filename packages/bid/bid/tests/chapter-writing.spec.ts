import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  buildBidStageTask,
  executeChapterWriting,
  getBidStagePolicy,
  outlineArtifactSha256,
  parseChapterWritingManifest,
  validateChapterWriting,
} from '@deepseek-ai/dsh-bid'

const source = [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }]

async function writeInputs(workspace: BidWorkspace): Promise<void> {
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/project.json'), `${JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['交付'], technical_scope: ['技术'], delivery_scope: ['实施'], implementation_constraints: ['周期'], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: ['tender'] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), `${JSON.stringify({ schema_version: 1, requirements: [1, 2, 3].map(index => ({ id: `REQ-${index}`, category: '技术', raw_text: `要求${index}`, normalized_requirement: `响应要求${index}`, mandatory: true, source_refs: source })) })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), `${JSON.stringify({ schema_version: 1, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, response_points: [`回答评分${index}`], source_refs: source })) })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), `${JSON.stringify({ schema_version: 1, compliance_items: [] })}\n`)
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), `${JSON.stringify({ schema_version: 3, research_topics: [{ topic_id: 'RT-1', topic: '第一章技术路线', relevance: '细化第一章。', related_requirement_ids: ['REQ-1'], related_scoring_points: [{ scoring_id: 'SCORE-1', response_point: '回答评分1' }], materials: [], external_materials: [], findings: ['需要按分层架构组织。'], writing_dimensions: ['分层架构'], missing_topics: [] }], requirement_mappings: [1, 2, 3].map(index => ({ requirement_id: `REQ-${index}`, materials: [], external_materials: [{ title: `官方资料${index}`, url: `https://official.example/${index}`, publisher: '官方机构', retrieved_at: '2026-08-31T00:00:00.000Z', retrieval_method: 'web_search', usage: 'reference', summary: `资料${index}`, supports: `要求${index}` }], missing_topics: ['无历史材料'] })), scoring_mappings: [1, 2, 3].map(index => ({ scoring_id: `SCORE-${index}`, materials: [], external_materials: [], missing_topics: ['无历史材料'] })) })}\n`)
  const outline = { schema_version: 1 as const, scope: 'technical_bid' as const, document_title: '技术标', global_compliance_ids: [], sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '目录', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...[1, 2, 3].map(index => ({ id: `SEC-${index}`, parent_id: 'STRUCT', order: index, level: 2, title: `章节${index}`, purpose: `回答主题${index}`, writable: true, must_answer: [`回答${index}`], requirement_ids: [`REQ-${index}`], scoring_ids: [`SCORE-${index}`], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ] }
  await writeFile(join(workspace.sessionRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`)
  await writeFile(join(workspace.sessionRoot, 'outline/confirmation.json'), `${JSON.stringify({ schema_version: 1, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineArtifactSha256(outline), confirmed_outline_sha256: outlineArtifactSha256(outline) })}\n`)
}

describe('chapter-writing executor and validator', () => {
  it('allows only the local tools and the Web search-fetch pair', () => {
    const policy = getBidStagePolicy('chapter_writing')
    expect(policy.allowedTools).toEqual(['grep', 'read', 'write', 'web_search', 'web_fetch'])
    expect(policy.forbiddenTools).toEqual(['bash'])
  })

  it('drives one task per writable section and publishes an ordered manifest', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-')), 'session')
    await writeInputs(workspace)
    const followup = vi.fn()
    let call = 0
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 1) return
      call++
      const serial = String(call).padStart(4, '0')
      await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
      await mkdir(join(workspace.sessionRoot, 'chapters/meta'), { recursive: true })
      await writeFile(join(workspace.sessionRoot, `chapters/sections/${serial}.md`), `章节 ${call} 正文\n`)
      const metadata = {
        section_id: `SEC-${call}`, covered_must_answer: [`回答${call}`], evidence_used: [],
        additional_materials: [], external_evidence_used: [], additional_external_materials: [], unresolved_topics: [],
      }
      await writeFile(join(workspace.sessionRoot, `chapters/meta/${serial}.json`), `${JSON.stringify(metadata)}\n`)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: {
        schemas: vi.fn(() => ['grep', 'read', 'write', 'web_search', 'web_fetch'].map(name => ({ name }))),
        restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}),
      },
    }
    const agent = {
      id: 'session',
      session: { header: { cwd: workspace.root }, events: [] },
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => () => {}) },
      followup,
      whenIdle,
    } as unknown as Agent

    await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing')))
      .resolves.toEqual([{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }])
    expect(followup).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('https://official.example/1')
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).not.toContain('https://official.example/2')
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('需要按分层架构组织。')
    expect(JSON.stringify(followup.mock.calls[1]?.[0])).not.toContain('第一章技术路线')
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters.map(chapter => [chapter.section_id, chapter.content_path])).toEqual([
      ['SEC-1', 'chapters/sections/0001.md'], ['SEC-2', 'chapters/sections/0002.md'], ['SEC-3', 'chapters/sections/0003.md'],
    ])
    await expect(validateChapterWriting(workspace, 'chapter_writing', [{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }]))
      .resolves.toEqual({ ok: true })

    const unrelated = {
      title: '官方资料2', url: 'https://official.example/2', publisher: '官方机构',
      retrieved_at: '2026-08-31T00:00:00.000Z', retrieval_method: 'web_search' as const,
      usage: 'reference' as const, summary: '资料2', supports: '要求2',
    }
    const invalidManifest = structuredClone(manifest)
    const firstChapter = invalidManifest.chapters[0]
    if (firstChapter === undefined) throw new Error('expected first chapter')
    firstChapter.external_evidence_used = [unrelated]
    await writeFile(join(workspace.sessionRoot, 'chapters/manifest.json'), `${JSON.stringify(invalidManifest)}\n`)
    await writeFile(join(workspace.sessionRoot, 'chapters/meta/0001.json'), `${JSON.stringify({
      section_id: 'SEC-1', covered_must_answer: ['回答1'], evidence_used: [], additional_materials: [],
      external_evidence_used: [unrelated], additional_external_materials: [], unresolved_topics: [],
    })}\n`)
    const invalid = await validateChapterWriting(workspace, 'chapter_writing', [{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }])
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('expected invalid chapter evidence')
    expect(invalid.issues.map(issue => issue.code)).toContain('CHAPTER_WRITING_EXTERNAL_EVIDENCE_NOT_MAPPED')
  })

  it('fails before dispatch when the Bid composition omits web_fetch', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-tools-')), 'session')
    await writeInputs(workspace)
    const followup = vi.fn()
    const services = {
      fs: { resolve: vi.fn() },
      tools: {
        schemas: vi.fn(() => ['grep', 'read', 'write', 'web_search'].map(name => ({ name }))),
        restrict: vi.fn(), guard: vi.fn(),
      },
    }
    const agent = {
      id: 'session', session: { header: { cwd: workspace.root }, events: [] },
      ctx: { get: (name: keyof typeof services) => services[name] }, followup, whenIdle: vi.fn(),
    } as unknown as Agent

    await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing')))
      .rejects.toThrow('Bid chapter writing requires registered tools: web_fetch')
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects an additional external source without a current search-to-fetch result', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-fetch-')), 'session')
    await writeInputs(workspace)
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 1) return
      await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
      await mkdir(join(workspace.sessionRoot, 'chapters/meta'), { recursive: true })
      await writeFile(join(workspace.sessionRoot, 'chapters/sections/0001.md'), '未经来源支持的正文\n')
      await writeFile(join(workspace.sessionRoot, 'chapters/meta/0001.json'), `${JSON.stringify({
        section_id: 'SEC-1', covered_must_answer: ['回答1'], evidence_used: [], additional_materials: [],
        external_evidence_used: [], additional_external_materials: [{
          title: '搜索摘要', url: 'https://unfetched.example/source', publisher: '未知来源',
          retrieved_at: '2026-08-31T00:00:00.000Z', retrieval_method: 'web_search', usage: 'reference',
          summary: '未读取原文。', supports: '声称支持当前章节。',
        }], unresolved_topics: [],
      })}\n`)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: {
        schemas: vi.fn(() => ['grep', 'read', 'write', 'web_search', 'web_fetch'].map(name => ({ name }))),
        restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}),
      },
    }
    const agent = {
      id: 'session', session: { header: { cwd: workspace.root }, events: [] },
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => () => {}) },
      followup: vi.fn(), whenIdle,
    } as unknown as Agent

    await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing')))
      .rejects.toThrow('additional external material lacks a current search-to-fetch result')
  })

  it('accepts a current-section source only after its ordered search and fetch results', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-chapter-writing-web-')), 'session')
    await writeInputs(workspace)
    const url = 'https://official.example/current-section'
    const fetchTime = 1_788_134_400_000
    let resultListener: ((exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) | undefined
    let chapter = 0
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 1) return
      chapter++
      const serial = String(chapter).padStart(4, '0')
      await mkdir(join(workspace.sessionRoot, 'chapters/sections'), { recursive: true })
      await mkdir(join(workspace.sessionRoot, 'chapters/meta'), { recursive: true })
      await writeFile(join(workspace.sessionRoot, `chapters/sections/${serial}.md`), `章节 ${chapter} 正文\n`)
      let additionalExternalMaterials: unknown[] = []
      if (chapter === 1) {
        const search = {
          agent, callId: 'search-1', name: 'web_search', arguments: { queries: ['SEC-1 架构公开标准'] },
        } as Readonly<ToolExecution>
        const searchResult = {
          isError: false, value: { sources: [{ url }] },
          content: [{ type: 'text', text: 'search result' }],
        } as Readonly<ToolExecutionResult>
        const fetch = { agent, callId: 'fetch-1', name: 'web_fetch', arguments: { url } } as Readonly<ToolExecution>
        const fetchResult = {
          isError: false,
          value: { url, statusCode: 200, truncated: false, body: { kind: 'text', content: '官方技术原文。' } },
          content: [{ type: 'text', text: '官方技术原文。' }],
        } as Readonly<ToolExecutionResult>
        resultListener?.(search, searchResult)
        resultListener?.(fetch, fetchResult)
        const events = agent.session.events as unknown as Array<Record<string, unknown>>
        events.push(
          { type: 'tool/call', seq: 1, time: fetchTime - 3, data: { callId: 'search-1', name: 'web_search' } },
          { type: 'tool/result', seq: 2, time: fetchTime - 2, data: { message: { source: { callId: 'search-1' }, content: [{ isError: false }] } } },
          { type: 'tool/call', seq: 3, time: fetchTime - 1, data: { callId: 'fetch-1', name: 'web_fetch' } },
          { type: 'tool/result', seq: 4, time: fetchTime, data: { message: { source: { callId: 'fetch-1' }, content: [{ isError: false }] } } },
        )
        additionalExternalMaterials = [{
          title: '当前章节官方资料', url, publisher: '官方机构',
          retrieved_at: new Date(fetchTime).toISOString(), retrieval_method: 'web_search', usage: 'reference',
          summary: '官方技术原文摘要。', supports: '支持 SEC-1 的架构设计。',
        }]
      }
      await writeFile(join(workspace.sessionRoot, `chapters/meta/${serial}.json`), `${JSON.stringify({
        section_id: `SEC-${chapter}`, covered_must_answer: [`回答${chapter}`], evidence_used: [], additional_materials: [],
        external_evidence_used: [], additional_external_materials: additionalExternalMaterials, unresolved_topics: [],
      })}\n`)
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: {
        schemas: vi.fn(() => ['grep', 'read', 'write', 'web_search', 'web_fetch'].map(name => ({ name }))),
        restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}),
      },
    }
    const agent = {
      id: 'session', session: { header: { cwd: workspace.root }, events: [] },
      ctx: {
        get: (name: keyof typeof services) => services[name], emit: vi.fn(),
        on: vi.fn((_event: string, listener: typeof resultListener) => { resultListener = listener; return () => {} }),
      },
      followup: vi.fn(), whenIdle,
    } as unknown as Agent

    await expect(executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing')))
      .resolves.toEqual([{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }])
    const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(workspace.sessionRoot, 'chapters/manifest.json'), 'utf8')))
    expect(manifest.chapters[0]?.additional_external_materials).toHaveLength(1)
    expect(manifest.chapters[1]?.additional_external_materials).toEqual([])
  })
})
