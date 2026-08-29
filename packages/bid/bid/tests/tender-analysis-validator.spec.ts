import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  parseTenderComplianceArtifact,
  parseTenderProjectArtifact,
  parseTenderRequirementsArtifact,
  parseTenderScoringArtifact,
  validateTenderAnalysis,
  type StageArtifact,
  type TenderSourceRef,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'tender_analysis', type: 'tender_project', path: 'analysis/project.json' },
  { stage: 'tender_analysis', type: 'tender_requirements', path: 'analysis/requirements.json' },
  { stage: 'tender_analysis', type: 'tender_scoring', path: 'analysis/scoring.json' },
  { stage: 'tender_analysis', type: 'tender_compliance', path: 'analysis/compliance.json' },
]

async function fixture(): Promise<{
  workspace: BidWorkspace
  tenderId: string
  referenceId: string
  source: TenderSourceRef
  referenceSource: TenderSourceRef
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tender-analysis-'))
  const workspace = new BidWorkspace(root, 'session')
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('# 项目\n\n必须按期交付，技术方案得 10 分。') },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('# 历史材料\n\n旧项目要求。') },
  ])
  if (tender === undefined || reference === undefined
    || tender.chunksPath === null || tender.absoluteChunkIndexPath === null
    || reference.chunksPath === null || reference.absoluteChunkIndexPath === null) {
    throw new Error('test corpus was not chunked')
  }
  const tenderIndex = JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const referenceIndex = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  return {
    workspace,
    tenderId: tender.id,
    referenceId: reference.id,
    source: { file_id: tender.id, chunk: `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`, line_start: 1, line_end: 1 },
    referenceSource: { file_id: reference.id, chunk: `${reference.chunksPath}/${referenceIndex.chunks[0]!.path}`, line_start: 1, line_end: 1 },
  }
}

function documents(tenderId: string, source: TenderSourceRef): Record<string, unknown> {
  return {
    'project.json': {
      schema_version: 1,
      project_name: '交付项目',
      tender_name: null,
      purchaser: null,
      owner: null,
      project_scope: ['技术方案'],
      technical_scope: ['方案设计'],
      delivery_scope: ['按期交付'],
      source_refs: [source],
      analyzed_tender_files: [tenderId],
    },
    'requirements.json': {
      schema_version: 1,
      requirements: [{
        id: 'REQ-1', category: '交付', raw_text: '必须按期交付', normalized_requirement: '按期交付',
        mandatory: true, source_refs: [source],
      }],
    },
    'scoring.json': {
      schema_version: 1,
      scoring_items: [{
        id: 'SCORE-1', parent: null, group: '技术', title: '技术方案', raw_text: '技术方案得 10 分',
        criterion: '提供技术方案', score: 10, score_range: null, must_answer: true, source_refs: [source],
      }],
    },
    'compliance.json': {
      schema_version: 1,
      compliance_items: [{
        id: 'COMP-1', type: 'mandatory_response', raw_text: '必须按期交付', normalized_rule: '必须响应交付期限',
        severity: 'mandatory', source_refs: [source],
      }],
    },
  }
}

async function publish(workspace: BidWorkspace, docs: Record<string, unknown>): Promise<void> {
  const root = join(workspace.sessionRoot, 'analysis')
  await mkdir(root, { recursive: true })
  await Promise.all(Object.entries(docs).map(([name, value]) => (
    writeFile(join(root, name), `${JSON.stringify(value)}\n`)
  )))
}

const codes = (result: Awaited<ReturnType<typeof validateTenderAnalysis>>): string[] => (
  result.ok ? [] : result.issues.map(issue => issue.code)
)

describe('tender-analysis Artifact schemas', () => {
  it('accepts the four current schema documents', () => {
    const source = { file_id: 'file', chunk: 'corpus/file/chunks/chunk_0001.md', line_start: 1, line_end: 1 }
    const docs = documents('file', source)
    expect(parseTenderProjectArtifact(docs['project.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderRequirementsArtifact(docs['requirements.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderScoringArtifact(docs['scoring.json'])).toMatchObject({ schema_version: 1 })
    expect(parseTenderComplianceArtifact(docs['compliance.json'])).toMatchObject({ schema_version: 1 })
  })
})

describe('tender-analysis validator', () => {
  it('accepts complete Artifacts whose source refs cover the tender corpus', async () => {
    const value = await fixture()
    await publish(value.workspace, documents(value.tenderId, value.source))
    await expect(validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)).resolves.toEqual({ ok: true })
  })

  it('rejects missing files and invalid JSON', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    await publish(value.workspace, docs)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/scoring.json'), '{')
    await writeFile(join(value.workspace.sessionRoot, 'analysis/compliance.json'), '')
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts.slice(0, 3))
    expect(codes(result)).toContain('TENDER_ANALYSIS_ARTIFACT_SET_INVALID')
    expect(codes(result)).toContain('TENDER_ANALYSIS_ARTIFACT_INVALID')
  })

  it('rejects duplicate item ids', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    const requirements = docs['requirements.json'] as { requirements: unknown[] }
    requirements.requirements.push(structuredClone(requirements.requirements[0]))
    await publish(value.workspace, docs)
    const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
    expect(codes(result)).toContain('TENDER_ANALYSIS_DUPLICATE_ID')
  })

  it('rejects reference authority, dangling chunks, traversal, and invalid lines', async () => {
    for (const mutate of [
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => value.referenceSource,
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, chunk: 'corpus/missing/chunk.md' }),
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, chunk: '../outside.md' }),
      (value: Awaited<ReturnType<typeof fixture>>): TenderSourceRef => ({ ...value.source, line_start: 999, line_end: 999 }),
    ]) {
      const value = await fixture()
      await publish(value.workspace, documents(value.tenderId, mutate(value)))
      const result = await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)
      expect(result.ok).toBe(false)
    }
  })

  it('requires exact coverage of every successfully parsed tender file', async () => {
    const value = await fixture()
    const docs = documents(value.tenderId, value.source)
    ;(docs['project.json'] as { analyzed_tender_files: string[] }).analyzed_tender_files = []
    await publish(value.workspace, docs)
    expect(codes(await validateTenderAnalysis(value.workspace, 'tender_analysis', artifacts)))
      .toContain('TENDER_ANALYSIS_COVERAGE_INCOMPLETE')
  })
})
