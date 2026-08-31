import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  parseEvidenceMapArtifact,
  validateEvidenceMapping,
  webEvidenceContentSha256,
  type StageArtifact,
} from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [
  { stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' },
  { stage: 'evidence_mapping', type: 'web_evidence_sources', path: 'analysis/web-evidence-sources.json' },
]

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
  return { workspace, reference, chunk, lines }
}

describe('evidence-map Artifact schema', () => {
  it('rejects invalid material usage and missing mapping identifiers', () => {
    expect(() => parseEvidenceMapArtifact({
      schema_version: 2,
      requirement_mappings: [{ requirement_id: 'R', materials: [], missing_topics: ['缺少资料。'] }],
      scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 2, requirement_mappings: [{ materials: [], external_materials: [], missing_topics: [] }], scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 2,
      requirement_mappings: [{ requirement_id: 'R', materials: [], external_materials: [], missing_topics: [] }],
      scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 2,
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
      schema_version: 2,
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
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 2, requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: value.reference.id, chunk: value.chunk, line_start: 1, line_end: value.lines, usage: 'adapt', summary: '历史项目实施流程。' }], external_materials: [], missing_topics: [] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }] }))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('accepts a complete mapping supported only by public external material', async () => {
    const value = await fixture()
    await writeWebSource(value.workspace)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
      schema_version: 2,
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
        missing_topics: [],
      }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }],
    }))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('rejects a plausible external material without a current-attempt verified source', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
      schema_version: 2,
      requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [{
        title: '国家网络安全标准', url: 'https://example.com/standard', publisher: '国家标准机构',
        retrieved_at: '2026-08-31T00:00:00+08:00', retrieval_method: 'web_search', usage: 'reference',
        summary: '说明安全控制措施。', supports: '支持安全控制措施的设计。',
      }], missing_topics: [] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少本项目架构设计。'] }],
    }))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_UNVERIFIED')
  })

  it('rejects a missing ledger and a modified snapshot', async () => {
    const missing = await fixture()
    await writeFile(join(missing.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 2, requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] }))
    await rm(join(missing.workspace.sessionRoot, 'analysis/web-evidence-sources.json'))
    const missingResult = await validateEvidenceMapping(missing.workspace, 'evidence_mapping', artifacts)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_ARTIFACT_INVALID')

    const modified = await fixture()
    await writeWebSource(modified.workspace)
    await writeFile(join(modified.workspace.sessionRoot, 'analysis/web-sources/WEB-0123456789abcdef.md'), 'tampered')
    await writeFile(join(modified.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 2, requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] }))
    const modifiedResult = await validateEvidenceMapping(modified.workspace, 'evidence_mapping', artifacts)
    expect(modifiedResult.ok).toBe(false)
    if (!modifiedResult.ok) expect(modifiedResult.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_WEB_SOURCE_HASH_MISMATCH')
  })

  it('rejects a missing or linked Host snapshot', async () => {
    const value = await fixture()
    await writeWebSource(value.workspace)
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 2, requirement_mappings: [{ requirement_id: 'R-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少资料。'] }] }))
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
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
      schema_version: 2,
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
    }))

    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_ARTIFACT_INVALID')
  })

  it('rejects omitted ids, unknown files, and line ranges outside a chunk', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 2, requirement_mappings: [{ requirement_id: 'unknown', materials: [{ file_id: 'missing', chunk: value.chunk, line_start: 1, line_end: value.lines + 1, usage: 'adapt', summary: 'x' }], external_materials: [], missing_topics: [] }], scoring_mappings: [] }))
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
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
      schema_version: 2,
      requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: tender.id, chunk, line_start: 1, line_end: 1, usage: 'reference', summary: '招标原文。' }], external_materials: [], missing_topics: [] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], external_materials: [], missing_topics: ['缺少技术资料。'] }],
    }))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SOURCE_FILE_NOT_REFERENCE')
  })
})
