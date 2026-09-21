import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  attachTenderAnalysisSubmissionRuntime,
  BidWorkspace,
  DEFAULT_BID_CONFIG,
  createTestBidRunContext,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  resolveTenderSourceAnchor,
  validateTenderAnalysis,
} from '@deepseek-ai/dsh-bid'

const PROJECT_QUOTE = '项目名称：智慧审计平台。'
const REQUIREMENT_QUOTE = '系统功能要求：应支持统一身份认证和审计日志。'
const SCORING_QUOTE = '技术评分标准：总体技术方案完整合理得 10 分。'
const COMPLIANCE_QUOTE = '投标技术方案必须提供数据安全措施。'

async function fixture() {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-submit-')), {
    ...DEFAULT_BID_CONFIG,
    documentChunk: { minChars: 200, targetChars: 400, maxChars: 500 },
  })
  const second = Array.from({ length: 50 }, (_, index) => (
    `第二份招标技术要求第${String(index + 1).padStart(2, '0')}段：系统应保持稳定运行并提交验收记录。`
  )).join('\n\n')
  await workspace.import([
    {
      name: 'main-tender.md',
      role: 'tender',
      bytes: new TextEncoder().encode([
        '# 项目概况', PROJECT_QUOTE,
        '# 技术要求', REQUIREMENT_QUOTE, COMPLIANCE_QUOTE,
        '# 技术评分', SCORING_QUOTE,
        '重复短语。', '重复短语。',
      ].join('\n\n')),
    },
    { name: 'second-tender.md', role: 'tender', bytes: new TextEncoder().encode(second) },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('旧项目技术要求仅供参考。') },
  ])
  const definitions = new Map<string, ToolDefinition>()
  const services = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      },
    },
  }
  const agent = { id: 'session', ctx: { get: (name: keyof typeof services) => services[name] } } as unknown as Agent
  const runtime = await attachTenderAnalysisSubmissionRuntime(
    agent, workspace, await workspace.readManifest(), createTestBidRunContext(),
  )
  const concludeTurn = vi.fn()
  const call = async (args: unknown): Promise<unknown> => {
    const definition = definitions.get('submit_tender_analysis')
    if (definition === undefined) throw new Error('missing submit_tender_analysis')
    return definition.execute(args, {
      agent, signal: new AbortController().signal, concludeTurn,
    } as unknown as ToolRunContext)
  }
  return { workspace, agent, definitions, runtime, concludeTurn, call }
}

function source(anchor_text: string, chunk?: string, file_ref = 'T1') {
  const resolvedChunk = chunk ?? (anchor_text === PROJECT_QUOTE ? 'chunk_0001'
    : anchor_text === REQUIREMENT_QUOTE || anchor_text === COMPLIANCE_QUOTE ? 'chunk_0002' : 'chunk_0003')
  return { file_ref, chunk: resolvedChunk, anchor_text }
}

function completeSubmission() {
  return {
    project_facts: [{ field: 'project_name', value: '智慧审计平台', sources: [source(PROJECT_QUOTE)] }],
    requirements: [{
      category: '功能要求', normalized_requirement: '系统应支持统一身份认证和审计日志。',
      mandatory: true, sources: [source(REQUIREMENT_QUOTE)],
    }],
    scoring_items: [{
      group: '技术方案', title: '总体技术方案',
      criterion: '根据总体技术方案的完整性与合理性评分。', score: 10, score_range: null,
      must_answer: true, sources: [source(SCORING_QUOTE)],
    }],
    compliance_items: [{
      type: '强制要求', normalized_rule: '技术方案必须提供数据安全措施。',
      severity: 'mandatory', sources: [source(COMPLIANCE_QUOTE)],
    }],
  }
}

describe('tender-analysis complete submission runtime', () => {
  it('renders one located PDF page as an image block and rejects routes without image input', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-pdf-page-')))
    const pdf = await readFile(join(import.meta.dirname, 'fixtures/bid-document.pdf'))
    await workspace.import([
      { name: 'tender.pdf', role: 'tender', bytes: new Uint8Array(pdf) },
      { name: 'appendix.md', role: 'tender', bytes: new TextEncoder().encode('补充技术要求。') },
    ])
    const definitions = new Map<string, ToolDefinition>()
    let savedPng: Uint8Array | undefined
    const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      savedPng = input.data
      return {
        attachmentId: 'att-pdf-page', mediaType: input.mediaType, bytes: input.data.byteLength,
        width: 1191, height: 1684, name: input.name,
      }
    })
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
    const services = {
      tools: {
        register(definition: ToolDefinition) {
          definitions.set(definition.name, definition)
          return () => { definitions.delete(definition.name) }
        },
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 8_000_000, maxImagesPerMessage: 4, maxMessageImageBytes: 16_000_000,
          maxImagePixels: 4_000_000, maxImageDimension: 2_048, mediaTypes: ['image/png'],
        },
        saveImage,
      },
      llm: { resolveModelInfo },
    }
    const agent = {
      id: 'session', options: { provider: 'test', model: 'vision' },
      session: { requestHeader: () => undefined },
      ctx: { get: (name: keyof typeof services) => services[name] },
    } as unknown as Agent
    const runtime = await attachTenderAnalysisSubmissionRuntime(
      agent, workspace, await workspace.readManifest(), createTestBidRunContext(),
    )
    const tool = definitions.get('view_pdf_page')
    const exec = { agent, signal: new AbortController().signal, concludeTurn: vi.fn() } as unknown as ToolRunContext
    const result = await tool?.execute({ file_ref: 'T1', page: 1 }, exec) as {
      page_count: number
      image: { attachmentId: string }
    }
    expect(result).toMatchObject({ page_count: 2, image: { attachmentId: 'att-pdf-page' } })
    expect(Array.from(savedPng!.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(tool!.output.render({ file_ref: 'T1', page: 1 }, result)[1])
      .toMatchObject({ type: 'image', attachment: { attachmentId: 'att-pdf-page' } })

    resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
    await expect(tool?.execute({ file_ref: 'T1', page: 1 }, exec)).rejects.toThrow('请切换到支持图片输入的模型')
    await expect(tool?.execute({ file_ref: 'T9', page: 1 }, exec)).rejects.toThrow('未知 tender 引用 T9')
    resolveModelInfo.mockResolvedValue({ inputModalities: ['text', 'image'] })
    await expect(tool?.execute({ file_ref: 'T1', page: 3 }, exec)).rejects.toThrow('该文件共 2 页')
    await expect(tool?.execute({ file_ref: 'T2', page: 1 }, exec)).rejects.toThrow('T2 不是 PDF')
    runtime.dispose()
  })

  it('builds tender locators and normalizes only NFKC and whitespace for anchors', async () => {
    const value = await fixture()
    expect(value.runtime.locators.map(locator => [locator.file_ref, locator.name])).toEqual([
      ['T1', 'main-tender.md'], ['T2', 'second-tender.md'],
    ])
    const locator = value.runtime.locators[0]!
    const chunk = locator.chunks.get('chunk_0001')!
    await writeFile(chunk.absolutePath, '第一行：全角ＡＢＣ。\n第二行\t连续 空白。')
    await expect(resolveTenderSourceAnchor(value.workspace, value.runtime.locators, {
      file_ref: 'T1', chunk: 'chunk_0001', anchor_text: '全角ABC。 第二行 连续 空白。',
    })).resolves.toEqual({
      quote: '全角ＡＢＣ。\n第二行\t连续 空白。',
      source_ref: { file_id: locator.file_id, chunk: chunk.artifactPath, line_start: 1, line_end: 2 },
    })
    value.runtime.dispose()
  })

  it('persists the complete candidate and exposes only the current invalid item for repair', async () => {
    const value = await fixture()
    const input = completeSubmission()
    input.requirements[0]!.sources = [source('不存在的要求', 'chunk_0002')]
    input.scoring_items[0]!.sources = [source('不存在的评分', 'chunk_0003')]

    await expect(value.call(input)).resolves.toMatchObject({
      completed: false,
      issues: [expect.objectContaining({
        code: 'TENDER_ANALYSIS_ANCHOR_NOT_FOUND', path: 'requirements.0.sources.0.anchor_text',
      })],
    })
    expect(value.concludeTurn).toHaveBeenCalledOnce()
    expect(value.runtime.completed).toBe(false)
    expect(JSON.parse(await readFile(join(value.workspace.projectRoot, 'analysis/tender-analysis-candidate.json'), 'utf8')))
      .toEqual(input)
    expect(value.runtime.repairContext()).toMatchObject({
      repair_key: 'requirement',
      item: input.requirements[0],
      related_chunks: [expect.objectContaining({ file_ref: 'T1', chunk: 'chunk_0002', text: expect.stringContaining(REQUIREMENT_QUOTE) })],
    })
    await expect(value.call({
      repair: { requirement: completeSubmission().requirements[0] },
    })).resolves.toMatchObject({
      completed: false,
      issues: [expect.objectContaining({ path: 'scoring_items.0.sources.0.anchor_text' })],
    })
    await expect(readFile(join(value.workspace.projectRoot, 'analysis/project.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    value.runtime.dispose()
  })

  it('rejects model-owned IDs and accepts a local repair without resubmitting complete state', async () => {
    const value = await fixture()
    await expect(value.call({
      ...completeSubmission(),
      requirements: [{ ...completeSubmission().requirements[0], id: 'REQ-MODEL' }],
    })).rejects.toThrow()
    const missingScoring = completeSubmission()
    missingScoring.scoring_items = []
    await expect(value.call(missingScoring)).resolves.toMatchObject({
      completed: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'TENDER_ANALYSIS_SCORING_SUSPICIOUSLY_EMPTY' })]),
    })
    await expect(value.call(completeSubmission())).rejects.toThrow('不得重新提交完整结果')
    await expect(value.call({ repair: { scoring_item: completeSubmission().scoring_items[0] } }))
      .resolves.toMatchObject({ completed: true, summary: { scoring_items: 1 } })
    expect(value.runtime.completed).toBe(true)
    value.runtime.dispose()
  })

  it('generates sequential IDs, deduplicates scoring, and writes S3-readable Artifacts', async () => {
    const value = await fixture()
    const input = completeSubmission()
    input.project_facts.push({ field: 'project_background', value: '建设统一审计平台', sources: [source(PROJECT_QUOTE)] })
    input.scoring_items.push({ ...input.scoring_items[0]! })
    await expect(value.call(input)).resolves.toEqual({
      completed: true,
      summary: { tender_files: 2, requirements: 1, scoring_items: 1, compliance_items: 1 },
    })

    const [project, requirements, scoring, compliance] = await Promise.all([
      readFile(join(value.workspace.projectRoot, 'analysis/project.json'), 'utf8').then(JSON.parse).then(parseTenderProjectArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/requirements.json'), 'utf8').then(JSON.parse).then(parseTenderRequirementsArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/scoring-origin.json'), 'utf8').then(JSON.parse).then(parseTenderScoringArtifact),
      readFile(join(value.workspace.projectRoot, 'analysis/compliance.json'), 'utf8').then(JSON.parse).then(parseTenderComplianceArtifact),
    ])
    expect(project).toMatchObject({
      project_name: '智慧审计平台', project_background: ['建设统一审计平台'],
      project_objectives: [], analyzed_tender_files: value.runtime.locators.map(locator => locator.file_id),
    })
    expect(requirements.requirements).toEqual([expect.objectContaining({ id: 'REQ-001', raw_text: REQUIREMENT_QUOTE })])
    expect(scoring.scoring_items).toEqual([expect.objectContaining({ id: 'SC-001', parent: null, raw_text: SCORING_QUOTE })])
    expect(compliance.compliance_items).toEqual([expect.objectContaining({ id: 'COM-001', raw_text: COMPLIANCE_QUOTE })])
    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', [
      { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
      { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
      { stage: 'tender_analysis', type: 'tender_scoring_origin', path: 'analysis/scoring-origin.json' },
      { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
    ])).resolves.toEqual({ ok: true })
    await expect(readFile(join(value.workspace.projectRoot, 'analysis/tender-analysis-checkpoint.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    value.runtime.dispose()
  })
})
