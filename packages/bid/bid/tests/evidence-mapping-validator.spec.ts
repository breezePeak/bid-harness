import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  parseEvidenceMapArtifact,
  parseEvidenceMappingPartialResult,
  parseTenderScoringArtifact,
  scoringArtifactSha256,
  validateEvidenceMapping,
  webEvidenceContentSha256,
  type EvidenceMapArtifact,
  type LocalEvidenceMaterial,
  type StageArtifact,
  type WebEvidenceMaterial,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
  { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
  { stage: 'evidence_mapping', type: 'outline', path: 'outline/outline.json' },
  { stage: 'evidence_mapping', type: 'outline_quality_report', path: 'outline/quality-report.json' },
]

function evidenceMap(value: Partial<EvidenceMapArtifact> = {}): EvidenceMapArtifact {
  return {
    schema_version: 8,
    section_mappings: [{ section_id: 'SEC-1', local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['总体技术架构'] }],
    ...value,
  }
}

async function fixture(options: { onlyTender?: boolean } = {}) {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-map-')), 'session')
  const imported = await workspace.import([
    { name: 'tender.md', role: 'tender' as const, bytes: new TextEncoder().encode('提供项目实施方案。技术架构合理得 5 分。') },
    ...(options.onlyTender === true ? [] : [
      { name: 'reference.md', role: 'reference' as const, bytes: new TextEncoder().encode('项目实施包括准备、部署、联调测试和验收。') },
      { name: 'reference-bid.md', role: 'reference_bid' as const, bytes: new TextEncoder().encode('旧项目采用成熟的分层架构方案。') },
    ]),
  ])
  const tender = imported[0]
  if (tender === undefined) throw new Error('fixture tender missing')
  const [reference, referenceBid] = options.onlyTender === true ? [] : imported.slice(1)
  const chunk = async (file: typeof tender | undefined): Promise<string | undefined> => {
    if (file?.absoluteChunkIndexPath === null || file?.absoluteChunkIndexPath === undefined) return undefined
    const index = JSON.parse(await readFile(file.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ id: string }> }
    return index.chunks[0]?.id
  }
  const source = [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }]
  const scoringRaw = { schema_version: 1 as const, scoring_items: [{ id: 'S-1', parent: null, group: '技术', title: '架构', raw_text: '技术架构合理得 5 分', criterion: '架构合理', score: 5, score_range: null, must_answer: true, source_refs: source }] }
  const scoring = parseTenderScoringArtifact(scoringRaw)
  await mkdir(join(workspace.sessionRoot, 'analysis/web-sources'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'outline'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({
      schema_version: 1,
      requirements: [{ id: 'R-1', category: '技术', raw_text: '提供项目实施方案', normalized_requirement: '提供项目实施方案', mandatory: true, source_refs: source }],
    })),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify(scoringRaw)),
    writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] })),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify({
      schema_version: 1,
      scope: 'technical_bid',
      scoring_sha256: scoringArtifactSha256(scoring),
      next_sequence: 2,
      points: [{ id: 'RP-000001', scoring_id: 'S-1', order: 1, text: '说明总体技术架构' }],
    })),
    writeFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({
      schema_version: 1,
      stage: 'evidence_mapping',
      sources: [],
    })),
    writeFile(join(workspace.sessionRoot, 'outline/outline.json'), JSON.stringify({
      schema_version: 3,
      scope: 'technical_bid',
      document_title: '技术标',
      global_compliance_ids: [],
      sections: [{
        id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '总体技术架构', purpose: '响应项目实施。', writable: true,
        must_answer: ['说明总体技术架构。'], requirement_ids: ['R-1'], scoring_ids: ['S-1'], compliance_ids: [], origin: 'generated',
        scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'S-1', response_point: '说明总体技术架构' }],
        suggested_tables: [], suggested_figures: [], writing_notes: [],
      }],
    })),
    writeFile(join(workspace.sessionRoot, 'outline/quality-report.json'), JSON.stringify({
      schema_version: 3,
      scope: 'technical_bid',
      checked_requirement_ids: ['R-1'],
      checked_scoring_ids: ['S-1'],
      checked_scoring_response_point_ids: ['RP-000001'],
      reviewed_section_ids: ['SEC-1'],
      issues: [],
    })),
  ])
  return {
    workspace,
    tender: { file: tender, chunk: await chunk(tender) },
    reference: { file: reference, chunk: await chunk(reference) },
    referenceBid: { file: referenceBid, chunk: await chunk(referenceBid) },
  }
}

function local(source_kind: LocalEvidenceMaterial['source_kind'], file_id: string, chunk: string, usage: LocalEvidenceMaterial['usage'] = 'reference'): LocalEvidenceMaterial {
  return { source_kind, file_id, chunk, usage, summary: '可用技术资料。' }
}

async function writeMap(workspace: BidWorkspace, map: EvidenceMapArtifact): Promise<void> {
  await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(map))
}

async function writeWebSource(workspace: BidWorkspace, content = 'Fetched https://example.com/standard (HTTP 200)\n\n标准正文。'): Promise<WebEvidenceMaterial> {
  const source_id = 'WEB-0123456789abcdef'
  const snapshot_path = `analysis/web-sources/${source_id}.md`
  await writeFile(join(workspace.sessionRoot, snapshot_path), content)
  await writeFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ schema_version: 1, stage: 'evidence_mapping', sources: [{ source_id, search_call_id: 'search-1', fetch_call_id: 'fetch-1', search_result_seq: 10, fetch_call_seq: 11, fetch_result_seq: 12, queries: ['访问控制官方标准'], discovered_url: 'https://example.com/standard#search', requested_url: 'https://example.com/standard', final_url: 'https://example.com/standard', status_code: 200, truncated: false, fetched_at: '2026-08-31T00:00:00.000Z', content_sha256: webEvidenceContentSha256(content), snapshot_path }] }))
  return { source_id, snapshot_path, usage: 'reference', summary: '说明安全控制措施。', supports: '支持安全控制措施的设计。' }
}

describe('evidence-map v8 schema', () => {
  it('rejects the previous schema version and preserves local-material permissions', () => {
    expect(() => parseEvidenceMapArtifact({ ...evidenceMap(), schema_version: 7 })).toThrow()
    expect(() => parseEvidenceMapArtifact({ ...evidenceMap(), section_mappings: [{ ...evidenceMap().section_mappings[0]!, local_materials: [{ source_kind: 'reference', file_id: 'file', chunk: 'chunk_0001', usage: 'adapt', summary: '资料。' }] }] })).toThrow()
    expect(() => parseEvidenceMapArtifact({ ...evidenceMap(), section_mappings: [{ ...evidenceMap().section_mappings[0]!, local_materials: [{ source_kind: 'reference_bid', file_id: 'file', chunk: 'chunk_0001', usage: 'adapt', summary: '资料。' }] }] })).not.toThrow()
  })

  it('keeps Child URL results separate from durable Host references', () => {
    expect(() => parseEvidenceMappingPartialResult({ task_id: 'TASK-1', section_mappings: [{ section_id: 'SEC-1', local_materials: [], web_materials: [{ url: 'https://example.com/standard', usage: 'reference', summary: '标准。', supports: '支持方案。' }], missing_topics: [], writing_dimensions: ['安全'] }], refinement_suggestions: [] })).not.toThrow()
    expect(() => parseEvidenceMapArtifact({ ...evidenceMap(), section_mappings: [{ ...evidenceMap().section_mappings[0]!, web_materials: [{ source_id: 'WEB-0123456789abcdef', snapshot_path: 'analysis/web-sources/WEB-fedcba9876543210.md', usage: 'reference', summary: '标准。', supports: '支持方案。' }] }] })).toThrow()
  })
})

describe('evidence-mapping validator', () => {
  it('accepts permitted local materials and tender-only missing topics', async () => {
    const value = await fixture()
    if (value.reference.file === undefined || value.reference.chunk === undefined || value.referenceBid.file === undefined || value.referenceBid.chunk === undefined) throw new Error('local fixtures missing')
    await writeMap(value.workspace, evidenceMap({ section_mappings: [{ ...evidenceMap().section_mappings[0]!, local_materials: [local('reference', String(value.reference.file.id), value.reference.chunk), local('reference_bid', String(value.referenceBid.file.id), value.referenceBid.chunk, 'adapt')] }] }))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
    const tenderOnly = await fixture({ onlyTender: true })
    await writeMap(tenderOnly.workspace, evidenceMap({ section_mappings: [{ ...evidenceMap().section_mappings[0]!, missing_topics: ['缺少项目资料。'] }] }))
    await expect(validateEvidenceMapping(tenderOnly.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('rejects local evidence with an invalid role or chunk', async () => {
    const value = await fixture()
    await writeMap(value.workspace, evidenceMap({ section_mappings: [{ ...evidenceMap().section_mappings[0]!, local_materials: [local('reference', String(value.tender.file.id), 'chunk_9999')] }] }))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SOURCE_INVALID')
  })

  it('validates durable Web snapshots without networking', async () => {
    const value = await fixture()
    const web = await writeWebSource(value.workspace)
    await writeMap(value.workspace, evidenceMap({ section_mappings: [{ ...evidenceMap().section_mappings[0]!, web_materials: [web] }] }))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
    await writeFile(join(value.workspace.sessionRoot, web.snapshot_path), 'tampered')
    const modified = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(modified.ok).toBe(false)
    if (!modified.ok) expect(modified.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_INVALID')
    await rm(join(value.workspace.sessionRoot, web.snapshot_path), { force: true })
    await symlink(join(value.workspace.root, 'linked-web-source'), join(value.workspace.sessionRoot, web.snapshot_path), 'junction')
    const linked = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(linked.ok).toBe(false)
    if (!linked.ok) expect(linked.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_INVALID')
  })
})
