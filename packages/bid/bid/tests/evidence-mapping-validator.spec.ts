import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  parseEvidenceMapArtifact,
  parseTenderScoringArtifact,
  scoringArtifactSha256,
  validateEvidenceMapping,
  webEvidenceContentSha256,
  type EvidenceMapArtifact,
  type StageArtifact,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
  { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
]

function v4Map(value: object): EvidenceMapArtifact {
  return {
    schema_version: 5,
    source_strategy: { mode: 'generated_from_scratch', framework_file_id: null, reference_bid_files: [] },
    framework_mappings: [],
    reference_bid_mappings: [],
    research_topics: [],
    requirement_mappings: [],
    scoring_mappings: [],
    response_point_mappings: [{ response_point_id: 'RP-000001', scoring_id: 'S-1', response_point: '说明总体技术架构', materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['总体技术架构'] }],
    ...value,
  }
}

async function writeWebSource(workspace: BidWorkspace, content = 'Fetched https://example.com/standard (HTTP 200)\n\n标准正文。'): Promise<void> {
  const sourceId = 'WEB-0123456789abcdef'
  const snapshotPath = `analysis/web-sources/${sourceId}.md`
  await mkdir(join(workspace.sessionRoot, 'analysis/web-sources'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, snapshotPath), content)
  await writeFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({
    schema_version: 1,
    stage: 'evidence_mapping',
    sources: [{
      source_id: sourceId,
      search_call_id: 'search-1',
      fetch_call_id: 'fetch-1',
      search_result_seq: 10,
      fetch_call_seq: 11,
      fetch_result_seq: 12,
      queries: ['访问控制官方标准'],
      discovered_url: 'https://example.com/standard#search',
      requested_url: 'https://example.com/standard',
      final_url: 'https://example.com/standard',
      status_code: 200,
      truncated: false,
      fetched_at: '2026-08-31T00:00:00.000Z',
      content_sha256: webEvidenceContentSha256(content),
      snapshot_path: snapshotPath,
    }],
  }))
}

async function fixture() {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-map-')), 'session')
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('提供项目实施方案。技术架构合理得 5 分。') },
    { name: 'history.md', role: 'reference', bytes: new TextEncoder().encode('项目实施包括准备、部署、联调测试和验收。') },
  ])
  if (tender === undefined || reference === undefined || reference.chunksPath === null || reference.absoluteChunkIndexPath === null) throw new Error('fixture corpus missing')
  const index = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const chunk = `${reference.chunksPath}/${index.chunks[0]!.path}`
  const lines = (await readFile(join(workspace.sessionRoot, chunk), 'utf8')).split('\n').length
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.sessionRoot, 'analysis/web-sources'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({ schema_version: 1, stage: 'evidence_mapping', sources: [] }))
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [{ id: 'R-1', category: '技术', raw_text: '提供项目实施方案', normalized_requirement: '提供项目实施方案', mandatory: true, source_refs: [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }] }] }))
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify({ schema_version: 1, scoring_items: [{ id: 'S-1', parent: null, group: '技术', title: '架构', raw_text: '技术架构合理得 5 分', criterion: '架构合理', score: 5, score_range: null, must_answer: true, response_points: ['说明总体技术架构'], source_refs: [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }] }] }))
  const scoring = parseTenderScoringArtifact(
    JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/scoring.json'), 'utf8')),
  )
  const scoringSha256 = scoringArtifactSha256(scoring)
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringSha256, next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'S-1', order: 1, text: '说明总体技术架构' }] }))
  return { workspace, reference, chunk, lines }
}

describe('evidence-map Artifact schema', () => {
  it('rejects invalid material usage and missing mapping identifiers', () => {
    expect(() => parseEvidenceMapArtifact({
      schema_version: 3, research_topics: [],
      requirement_mappings: [{ requirement_id: 'R', materials: [], missing_topics: ['缺少资料。'] }],
      scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 3,
      research_topics: [],
      requirement_mappings: [{ materials: [], external_materials: [], missing_topics: [] }],
      scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact(v4Map({
      research_topics: [],
      requirement_mappings: [{ requirement_id: 'R', materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['技术方案'] }],
      scoring_mappings: [],
      response_point_mappings: [],
    }))).not.toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 3, research_topics: [],
      requirement_mappings: [],
      scoring_mappings: [{
        scoring_id: 'S',
        materials: [{ file_id: 'f', chunk: 'c', line_start: 1, line_end: 1, usage: 'score', summary: 'x' }],
        external_materials: [],
        missing_topics: [],
      }],
    })).toThrow()
  })

  it('requires traceable public external material', () => {
    const external = {
      title: '国家网络安全标准',
      url: 'https://example.com/standard',
      publisher: '国家标准机构',
      retrieved_at: '2026-08-31T00:00:00+08:00',
      retrieval_method: 'web_search',
      usage: 'reference',
      summary: '说明安全控制措施。',
      supports: '支持安全控制措施的设计。',
    }
    const mapping = (material: unknown) => ({
      schema_version: 3, research_topics: [],
      requirement_mappings: [{ requirement_id: 'R', materials: [], external_materials: [material], missing_topics: [] }],
      scoring_mappings: [],
    })

    expect(() => parseEvidenceMapArtifact(mapping({ ...external, url: 'file:///local-standard' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, title: '' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, publisher: '' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, retrieved_at: 'not-a-timestamp' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, retrieval_method: 'search_snippet' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, usage: 'reuse' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, summary: '' }))).toThrow()
    expect(() => parseEvidenceMapArtifact(mapping({ ...external, supports: '' }))).toThrow()
  })
})

describe('evidence-mapping validator', () => {
  it('accepts complete mappings, including a missing technical topic', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({ research_topics: [], requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: value.reference.id, chunk: value.chunk, line_start: 1, line_end: value.lines, usage: 'adapt', summary: '历史项目实施流程。' }], external_materials: [], missing_topics: [], writing_dimensions: ['实施流程'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }] })))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('accepts independent project research and reports an exact invalid response-point path', async () => {
    const value = await fixture()
    const map: EvidenceMapArtifact = v4Map({
      research_topics: [{
        topic_id: 'RT-1', topic: '项目背景', relevance: '影响目录的总体技术路线。',
        related_requirement_ids: [], related_scoring_points: [], materials: [], external_materials: [],
        findings: ['需要以分层架构组织技术方案。'], writing_dimensions: ['总体技术路线'], missing_topics: [],
      }],
      requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['总体技术路线'] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: [] }],
    })
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(map))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })

    map.research_topics[0]!.related_scoring_points = [{ response_point_id: 'RP-000001', scoring_id: 'S-1', response_point: '拼错的响应点' }]
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(map))
    const invalid = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(invalid).toMatchObject({ ok: false })
    if (!invalid.ok) expect(invalid.issues).toContainEqual(expect.objectContaining({
      code: 'EVIDENCE_MAPPING_RESEARCH_RESPONSE_POINT_MISMATCH',
      path: 'research_topics[0].related_scoring_points[0]',
    }))

    const unverifiedMap = structuredClone(map)
    unverifiedMap.research_topics[0]!.related_scoring_points = []
    unverifiedMap.research_topics[0]!.external_materials = [{
      title: '外部资料', url: 'https://unverified.example/research', publisher: '发布者',
      retrieved_at: '2026-08-31T00:00:00.000Z', retrieval_method: 'web_search', usage: 'reference',
      summary: '资料正文。', supports: '支持项目背景研究。',
    }]
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(unverifiedMap))
    const unverified = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(unverified).toMatchObject({ ok: false })
    if (!unverified.ok) expect(unverified.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_UNVERIFIED')
  })

  it('accepts a complete mapping supported only by public external material', async () => {
    const value = await fixture()
    await writeWebSource(value.workspace)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({
      research_topics: [],
      requirement_mappings: [{
        requirement_id: 'R-1',
        materials: [],
        external_materials: [{
          title: '国家网络安全标准',
          url: 'https://example.com/standard',
          publisher: '国家标准机构',
          retrieved_at: '2026-08-31T00:00:00+08:00',
          retrieval_method: 'web_search',
          usage: 'reference',
          summary: '说明安全控制措施。',
          supports: '支持安全控制措施的设计。',
        }],
        missing_topics: [], writing_dimensions: ['安全控制措施'],
      }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }],
    })))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('rejects a plausible external material without a current-attempt verified source', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({
      research_topics: [],
      requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [{
        title: '国家网络安全标准', url: 'https://example.com/standard', publisher: '国家标准机构',
        retrieved_at: '2026-08-31T00:00:00+08:00', retrieval_method: 'web_search', usage: 'reference',
        summary: '说明安全控制措施。', supports: '支持安全控制措施的设计。',
      }], missing_topics: [], writing_dimensions: ['安全控制措施'] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }],
    })))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_UNVERIFIED')
  })

  it('rejects a missing ledger and a modified snapshot', async () => {
    const missing = await fixture()
    await writeFile(join(missing.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({ research_topics: [], requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'], writing_dimensions: ['实施流程'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] })))
    await rm(join(missing.workspace.sessionRoot, 'analysis/web-evidence-sources.json'))
    const missingResult = await validateEvidenceMapping(missing.workspace, 'evidence_mapping', artifacts)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_ARTIFACT_INVALID')

    const modified = await fixture()
    await writeWebSource(modified.workspace)
    await writeFile(join(modified.workspace.sessionRoot, 'analysis/web-sources/WEB-0123456789abcdef.md'), 'tampered')
    await writeFile(join(modified.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({ research_topics: [], requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'], writing_dimensions: ['实施流程'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] })))
    const modifiedResult = await validateEvidenceMapping(modified.workspace, 'evidence_mapping', artifacts)
    expect(modifiedResult.ok).toBe(false)
    if (!modifiedResult.ok) expect(modifiedResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_HASH_MISMATCH')
  })

  it('rejects a missing or linked Host snapshot', async () => {
    const value = await fixture()
    await writeWebSource(value.workspace)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({ research_topics: [], requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'], writing_dimensions: ['实施流程'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] })))
    const snapshot = join(value.workspace.sessionRoot, 'analysis/web-sources/WEB-0123456789abcdef.md')
    await rm(snapshot)
    const missingResult = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_SNAPSHOT_INVALID')

    const linkedTarget = join(value.workspace.root, 'linked-web-source')
    await mkdir(linkedTarget)
    await symlink(linkedTarget, snapshot, 'junction')
    const linkedResult = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(linkedResult.ok).toBe(false)
    if (!linkedResult.ok) expect(linkedResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_SNAPSHOT_INVALID')
  })

  it('rejects malformed external material during stage validation', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({
      research_topics: [],
      requirement_mappings: [{
        requirement_id: 'R-1',
        materials: [],
        external_materials: [{
          title: '',
          url: 'file:///untrusted',
          publisher: 'unknown',
          retrieved_at: 'not-a-timestamp',
          retrieval_method: 'search_snippet',
          usage: 'reuse',
          summary: '',
          supports: '',
        }],
        missing_topics: [],
      }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少技术资料。'] }],
    })))

    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_ARTIFACT_INVALID')
  })

  it('rejects omitted ids, unknown files, and line ranges outside a chunk', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({ research_topics: [], requirement_mappings: [{ requirement_id: 'unknown', materials: [{ file_id: 'missing', chunk: value.chunk, line_start: 1, line_end: value.lines + 1, usage: 'adapt', summary: 'x' }], external_materials: [], missing_topics: [], writing_dimensions: ['实施流程'] }], scoring_mappings: [], response_point_mappings: [] })))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['EVIDENCE_MAPPING_REQUIREMENT_UNKNOWN', 'EVIDENCE_MAPPING_REQUIREMENT_MISSING', 'EVIDENCE_MAPPING_SCORING_MISSING', 'EVIDENCE_MAPPING_SOURCE_FILE_UNKNOWN']))
  })

  it('rejects material from a tender file', async () => {
    const value = await fixture()
    const manifest = await value.workspace.readManifest()
    const tender = manifest.files.find(file => file.role === 'tender')
    if (tender === undefined || tender.chunksPath === null || tender.chunkIndexPath === null) throw new Error('fixture tender missing')
    const index = JSON.parse(await readFile(join(value.workspace.sessionRoot, tender.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
    const chunk = `${tender.chunksPath}/${index.chunks[0]!.path}`
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({
      research_topics: [],
      requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: tender.id, chunk, line_start: 1, line_end: 1, usage: 'reference', summary: '招标原文。' }], external_materials: [], missing_topics: [], writing_dimensions: ['总体技术架构'] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少技术资料。'] }],
    })))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SOURCE_FILE_NOT_REFERENCE')
  })

  it('accepts mapped material from a framework or reference bid', async () => {
    for (const role of ['outline_framework', 'reference_bid'] as const) {
      const value = await fixture()
      const [special] = await value.workspace.import([
        { name: `${role}.md`, role, bytes: new TextEncoder().encode('# 实施方案\n\n可继承的实施章节正文。') },
      ])
      if (special === undefined || special.chunksPath === null || special.absoluteChunkIndexPath === null) throw new Error('special material corpus missing')
      const index = JSON.parse(await readFile(special.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string; heading_path: string[] }> }
      const headingPath = index.chunks[0]?.heading_path ?? []
      const section = { id: 'derived_001', order: 1, level: 1, title: headingPath[0] ?? '', heading_path: headingPath.slice(0, 1) }
      const chunk = `${special.chunksPath}/${index.chunks[0]!.path}`
      const sourceMapping = { mapping_id: 'MAP-1', file_id: special.id, source_section_id: section.id, source_order: section.order, level: section.level, title: section.title, heading_path: section.heading_path, related_requirement_ids: ['R-1'], related_scoring_points: [], content_materials: [{ file_id: special.id, chunk, line_start: 1, line_end: 3, usage: 'adapt' as const, summary: '可继承的实施章节。' }], writing_dimensions: ['实施流程'], missing_topics: [] }
      await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(v4Map({
        source_strategy: role === 'outline_framework'
          ? { mode: 'framework_only', framework_file_id: special.id, reference_bid_files: [] }
          : { mode: 'reference_bid_only', framework_file_id: null, reference_bid_files: [{ file_id: special.id, applicability: 'high', summary: '相似项目。', global_adaptation_notes: ['按当前项目改写。'] }] },
        framework_mappings: role === 'outline_framework' ? [{ ...sourceMapping, action: 'preserve', reason: '保留实施章节。' }] : [],
        reference_bid_mappings: role === 'reference_bid' ? [{ ...sourceMapping, action: 'adapt', summary: '复用实施方法。', adaptation_notes: ['按当前项目改写。'], risk_notes: [] }] : [],
        research_topics: [],
        requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: special.id, chunk, line_start: 1, line_end: 1, usage: 'adapt', summary: '可继承的实施章节。' }], external_materials: [], missing_topics: [], writing_dimensions: ['实施流程'] }],
        scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }],
      })))
      await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
    }
  })

  it('rejects every forged special-asset mapping surface against real parsed structures', async () => {
    const value = await fixture()
    const [framework, referenceBid] = await value.workspace.import([
      { name: 'framework.md', role: 'outline_framework', bytes: new TextEncoder().encode('# 实施框架\n\n框架正文。') },
      { name: 'reference-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode('# 历史实施\n\n历史正文。') },
    ])
    if (framework === undefined || referenceBid === undefined) throw new Error('special fixtures missing')

    const source = async (file: typeof framework, mappingId: string) => {
      if (file.absoluteChunkIndexPath === null || file.chunksPath === null) throw new Error('special fixture corpus missing')
      const index = JSON.parse(await readFile(file.absoluteChunkIndexPath, 'utf8')) as {
        chunks: Array<{ path: string; heading_path: string[] }>
      }
      const headingPath = index.chunks[0]?.heading_path ?? []
      return {
        mapping_id: mappingId,
        file_id: file.id,
        source_section_id: 'derived_001',
        source_order: 1,
        level: 1,
        title: headingPath[0] ?? '',
        heading_path: headingPath.slice(0, 1),
        related_requirement_ids: ['R-1'],
        related_scoring_points: [{ response_point_id: 'RP-000001', scoring_id: 'S-1', response_point: '说明总体技术架构' }],
        content_materials: [{
          file_id: file.id,
          chunk: `${file.chunksPath}/${index.chunks[0]!.path}`,
          line_start: 1,
          line_end: 3,
          usage: 'adapt' as const,
          summary: '可复用章节。',
        }],
        writing_dimensions: ['实施流程'],
        missing_topics: [],
      }
    }
    const frameworkMapping = { ...await source(framework, 'MAP-F'), action: 'preserve' as const, reason: '保留框架。' }
    const referenceMapping = {
      ...await source(referenceBid, 'MAP-R'),
      action: 'adapt' as const,
      summary: '适配历史方案。',
      adaptation_notes: ['按当前项目改写。'],
      risk_notes: [],
    }
    const valid = v4Map({
      source_strategy: {
        mode: 'framework_and_reference_bid',
        framework_file_id: framework.id,
        reference_bid_files: [{
          file_id: referenceBid.id,
          applicability: 'high',
          summary: '项目相似。',
          global_adaptation_notes: ['按当前项目改写。'],
        }],
      },
      framework_mappings: [frameworkMapping],
      reference_bid_mappings: [referenceMapping],
      requirement_mappings: [{
        requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: [], writing_dimensions: ['实施流程'],
      }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: [] }],
    })
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(valid))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })

    const manifest = await value.workspace.readManifest()
    const tender = manifest.files.find(file => file.role === 'tender')
    if (tender === undefined || tender.chunksPath === null || tender.chunkIndexPath === null) throw new Error('tender corpus missing')
    const tenderIndex = JSON.parse(
      await readFile(join(value.workspace.sessionRoot, tender.chunkIndexPath), 'utf8'),
    ) as { chunks: Array<{ path: string }> }
    const tenderMaterial = {
      ...referenceMapping.content_materials[0]!,
      file_id: tender.id,
      chunk: `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`,
    }

    const cases: Array<{ name: string; code: string; mutate(map: EvidenceMapArtifact): void }> = [
      { name: 'title', code: 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', mutate: (map) => { map.framework_mappings[0]!.title = '伪造标题' } },
      { name: 'heading_path', code: 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', mutate: (map) => { map.framework_mappings[0]!.heading_path = ['伪造路径'] } },
      { name: 'level', code: 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', mutate: (map) => { map.framework_mappings[0]!.level = 2 } },
      { name: 'source_order', code: 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', mutate: (map) => { map.framework_mappings[0]!.source_order = 2 } },
      { name: 'source_section_id', code: 'EVIDENCE_MAPPING_SOURCE_SECTION_INVALID', mutate: (map) => { map.framework_mappings[0]!.source_section_id = 'forged' } },
      { name: 'missing framework heading', code: 'EVIDENCE_MAPPING_FRAMEWORK_SECTION_MISSING', mutate: (map) => { map.framework_mappings = [] } },
      { name: 'duplicate framework heading', code: 'EVIDENCE_MAPPING_FRAMEWORK_SECTION_DUPLICATE', mutate: (map) => { map.framework_mappings.push({ ...map.framework_mappings[0]!, mapping_id: 'MAP-F-2' }) } },
      { name: 'high reference without mapping', code: 'EVIDENCE_MAPPING_REFERENCE_BID_MAPPING_MISSING', mutate: (map) => { map.reference_bid_mappings = [] } },
      { name: 'unknown requirement', code: 'EVIDENCE_MAPPING_SOURCE_MAPPING_REQUIREMENT_INVALID', mutate: (map) => { map.framework_mappings[0]!.related_requirement_ids = ['unknown'] } },
      { name: 'unknown response point', code: 'EVIDENCE_MAPPING_SOURCE_MAPPING_RESPONSE_POINT_INVALID', mutate: (map) => { map.framework_mappings[0]!.related_scoring_points[0]!.response_point_id = 'RP-999999' } },
      { name: 'framework material from another file', code: 'EVIDENCE_MAPPING_SOURCE_MAPPING_MATERIAL_INVALID', mutate: (map) => { map.framework_mappings[0]!.content_materials[0]!.file_id = value.reference.id } },
      { name: 'reference material from tender', code: 'EVIDENCE_MAPPING_SOURCE_MAPPING_MATERIAL_INVALID', mutate: (map) => { map.reference_bid_mappings[0]!.content_materials = [tenderMaterial] } },
      { name: 'missing response-point chunk', code: 'EVIDENCE_MAPPING_SOURCE_CHUNK_INVALID', mutate: (map) => { map.response_point_mappings[0]!.materials = [{ ...map.framework_mappings[0]!.content_materials[0]!, chunk: 'corpus/missing.md' }] } },
      { name: 'content line end', code: 'EVIDENCE_MAPPING_SOURCE_LINE_INVALID', mutate: (map) => { map.framework_mappings[0]!.content_materials[0]!.line_end = 999 } },
      { name: 'global mapping id', code: 'EVIDENCE_MAPPING_SOURCE_MAPPING_DUPLICATE', mutate: (map) => { map.reference_bid_mappings[0]!.mapping_id = 'MAP-F' } },
    ]
    for (const testCase of cases) {
      const candidate = structuredClone(valid)
      testCase.mutate(candidate)
      await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify(candidate))
      const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
      expect(result.ok, testCase.name).toBe(false)
      if (result.ok) throw new Error(`Expected ${testCase.name} failure`)
      expect(result.issues.map(issue => issue.code), testCase.name).toContain(testCase.code)
    }
  })
})
